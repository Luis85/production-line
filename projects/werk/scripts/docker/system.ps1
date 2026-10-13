# Docker system launcher; no host Node.js. Windows state lives in a private Linux volume.
$ErrorActionPreference = 'Stop'
$releaseDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$action = if ($args.Count) { [string]$args[0] } else { 'help' }
$startAttempted=$false
$stateDir = ''; $definitionFile = ''; $environment = ''; $noOpen = $false; $json = $false
for ($i=1; $i -lt $args.Count; $i++) {
    switch ([string]$args[$i]) {
        '--file' { if (++$i -ge $args.Count) { throw '--file requires a value' }; $definitionFile=[string]$args[$i] }
        '--state-dir' { if (++$i -ge $args.Count) { throw '--state-dir requires a value' }; $stateDir=[string]$args[$i] }
        '--environment' { if (++$i -ge $args.Count) { throw '--environment requires a value' }; $environment=[string]$args[$i] }
        '--json' { $json=$true }
        '--no-open' { $noOpen=$true }
        default { throw 'Unknown Docker system option' }
    }
}
function Invoke-Docker([string[]]$DockerArgs) { & docker @DockerArgs; if ($LASTEXITCODE -ne 0) { throw 'Docker command failed; see diagnostics above.' } }
function Assert-RealPath([string]$Path) { $item=Get-Item -LiteralPath $Path; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked paths are not supported' }; if ($item.FullName -match '[,\r\n]') { throw 'Paths cannot contain commas or line breaks' }; return $item.FullName }
try {
    if ($action -in @('help','--help')) { Write-Output 'Werk Docker system (mock): plan | setup | up | start | status | doctor | stop | credentials --file YAML [--state-dir PATH] [--environment docker] [--json] [--no-open]'; exit 0 }
    if ($action -notin @('plan','setup','up','start','status','doctor','stop','credentials')) { throw 'Unknown system command' }
    if ($environment -and $environment -ne 'docker') { throw 'Docker launcher requires --environment docker' }
    Invoke-Docker @('compose','version') | Out-Null
    $releaseDir=Assert-RealPath $releaseDir
    $windowsVolume=$env:OS -eq 'Windows_NT'
    $uid='1000'; $gid='1000'
    if (-not $windowsVolume) { $uid=(& id -u).Trim(); $gid=(& id -g).Trim() }
    $baseImage=if ($env:WERK_DOCKER_BASE_IMAGE) { $env:WERK_DOCKER_BASE_IMAGE } else { 'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df' }
    $helper=@('run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user',"${uid}:${gid}",'--mount',"type=bind,source=$releaseDir,target=/release,readonly")
    $helperOptions=@()
    if ($definitionFile) {
        $definitionFile=Assert-RealPath $definitionFile
        if ((Get-Item -LiteralPath $definitionFile).PSIsContainer) { throw 'Definition must be a YAML file' }
        $helper+=@('--mount',"type=bind,source=$definitionFile,target=/definition.yaml,readonly")
        $helperOptions+=@('--file','/definition.yaml')
        if ($environment) { $helperOptions+=@('--environment',$environment) }
    }
    if ($action -eq 'plan') {
        if (-not $definitionFile) { throw 'system plan requires --file' }
        Invoke-Docker ($helper+@('--entrypoint','node',$baseImage,'/release/scripts/docker/system.mjs','plan')+$helperOptions)
        exit 0
    }
    $systemId=$null
    if ($definitionFile) { $systemId=(Invoke-Docker ($helper+@('--entrypoint','node',$baseImage,'/release/scripts/docker/system.mjs','id')+$helperOptions)).Trim() }
    if (-not $stateDir) {
        if (-not $systemId -or $systemId -notmatch '^[a-z][a-z0-9-]{0,62}$') { throw 'Specify --file or --state-dir' }
        $stateDir=Join-Path $releaseDir ".werk-system/$systemId"
    }
    $setup=$action -in @('setup','up')
    if ($setup -and -not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
    $stateDir=Assert-RealPath $stateDir
    if (-not (Get-Item -LiteralPath $stateDir).PSIsContainer) { throw 'State must be a directory' }
    $volume=$null; $installation=$null
    if ($windowsVolume) {
        if (Test-Path -LiteralPath (Join-Path $stateDir 'system.json')) { throw 'This directory contains host system state; use its original launcher or choose a separate directory' }
        $pointer=Join-Path $stateDir 'docker-volume.json'
        $pointerExisted=Test-Path -LiteralPath $pointer
        if ($pointerExisted) {
            $null=Assert-RealPath $pointer
            try { $metadata=Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json } catch { throw 'Invalid Docker system volume pointer' }
            $installation=[string]$metadata.installation; $volume=[string]$metadata.volume
            if ($metadata.schemaVersion -ne 1 -or $installation -notmatch '^[a-f0-9]{32}$' -or $volume -ne "werk-system-$installation-state") { throw 'Invalid Docker system volume pointer' }
        } elseif ($setup) {
            $installation=[Guid]::NewGuid().ToString('N'); $volume="werk-system-$installation-state"
            @{schemaVersion=1;installation=$installation;volume=$volume} | ConvertTo-Json -Compress | Set-Content -LiteralPath $pointer -Encoding UTF8
        } else { throw 'Docker system volume pointer missing; run setup' }
        $volumes=@(Invoke-Docker @('volume','ls','--filter',"name=^$volume`$",'--format','{{.Name}}'))
        if ($volume -notin $volumes) {
            if ($pointerExisted -or -not $setup) { throw 'The existing system volume is missing. Restore its backup or deliberately choose a new state directory; existing installation state will not be recreated.' }
            Invoke-Docker @('volume','create','--label',"dev.werk.installation=$installation",$volume) | Out-Null
        }
        $owner=(Invoke-Docker @('volume','inspect','--format','{{index .Labels "dev.werk.installation"}}',$volume)).Trim()
        if ($owner -ne $installation) { throw 'Docker volume ownership mismatch' }
    }
    $mount=if ($volume) { "type=volume,source=$volume,target=/state" } else { "type=bind,source=$stateDir,target=/state" }
    $image=if ($env:WERK_DOCKER_IMAGE) { $env:WERK_DOCKER_IMAGE } elseif ($volume) { "werk-release:system-$installation" } else { $null }
    if (-not $setup -and $volume) { $null=Assert-RealPath (Join-Path $stateDir 'docker-image'); $image=(Get-Content -LiteralPath (Join-Path $stateDir 'docker-image') -Raw).Trim() }
    if ($setup -and $volume) { Invoke-Docker @('build','--file',(Join-Path $releaseDir 'Dockerfile.release'),'--tag',$image,$releaseDir) | ForEach-Object { [Console]::Error.WriteLine($_) } }
    $helper+=@('--mount',$mount,'--entrypoint','node')
    if ($volume) {
        if (-not $image) { $image=(Get-Content -LiteralPath (Join-Path $stateDir 'docker-image') -Raw).Trim() }
        $helper+=@($image,'/app/scripts/docker/system.mjs')
    } else { $helper+=@($baseImage,'/release/scripts/docker/system.mjs') }
    if ($setup) {
        $setupOptions=@('--host-state',$stateDir,'--uid',$uid,'--gid',$gid)
        if ($image) { $setupOptions+=@('--image',$image) }
        if ($volume) { $setupOptions+=@('--volume',$volume) }
        $setupResult=Invoke-Docker ($helper+@('setup')+$helperOptions+$setupOptions)
        if ($volume) {
            $copy=(Invoke-Docker @('create','--mount',$mount,$image)).Trim()
            try { foreach ($name in @('docker-compose.json','docker-project','docker-image')) {
                $target=Join-Path $stateDir $name; if (Test-Path -LiteralPath $target) { $null=Assert-RealPath $target }
                Invoke-Docker @('cp',"${copy}:/state/$name",$target) | Out-Null
            } } finally { Invoke-Docker @('rm',$copy) | Out-Null }
        } else {
            $image=(Get-Content -LiteralPath (Join-Path $stateDir 'docker-image') -Raw).Trim()
            Invoke-Docker @('build','--file',(Join-Path $releaseDir 'Dockerfile.release'),'--tag',$image,$releaseDir) | ForEach-Object { [Console]::Error.WriteLine($_) }
        }
        if ($action -eq 'setup') { Write-Output $setupResult; exit 0 }
    }
    foreach ($name in @('docker-compose.json','docker-project','docker-image')) { $null=Assert-RealPath (Join-Path $stateDir $name) }
    $project=(Get-Content -LiteralPath (Join-Path $stateDir 'docker-project') -Raw).Trim()
    if ($project -notmatch '^werk-system-[a-f0-9]{16}$') { throw 'Invalid Docker system project' }
    $compose=@('compose','--project-directory',$releaseDir,'--file',(Join-Path $stateDir 'docker-compose.json'),'--project-name',$project)
    if ($action -eq 'start' -or ($definitionFile -and -not $setup)) { Invoke-Docker ($helper+@('verify')+$helperOptions) | Out-Null }
    if ($action -eq 'start') {
        $image=(Get-Content -LiteralPath (Join-Path $stateDir 'docker-image') -Raw).Trim()
        Invoke-Docker @('build','--file',(Join-Path $releaseDir 'Dockerfile.release'),'--tag',$image,$releaseDir) | ForEach-Object { [Console]::Error.WriteLine($_) }
    }
    switch ($action) {
        { $_ -in @('up','start') } {
            $startAttempted=$true
            Invoke-Docker ($compose+@('up','--detach','--wait','--wait-timeout','120')) | ForEach-Object { [Console]::Error.WriteLine($_) }
            Invoke-Docker ($compose+@('exec','-T','factory','node','/app/scripts/docker/system.mjs','bootstrap'))
            if (-not $noOpen -and -not $json) {
                $url=(Invoke-Docker ($compose+@('exec','-T','factory','node','/app/scripts/docker/system.mjs','url'))).Trim()
                try { Start-Process -FilePath $url | Out-Null } catch { [Console]::Error.WriteLine("Open $url") }
            }
        }
        { $_ -in @('status','doctor') } {
            $running=@(Invoke-Docker ($compose+@('ps','--status','running','--services')))
            if ('factory' -in $running) { Invoke-Docker ($compose+@('exec','-T','factory','node','/app/scripts/docker/system.mjs',$action)) }
            else { Invoke-Docker ($helper+@($action)) }
        }
        'stop' {
            $services=@(Invoke-Docker ($helper+@('services')))
            foreach ($service in $services) { Invoke-Docker ($compose+@('stop','--timeout','20',$service)) | ForEach-Object { [Console]::Error.WriteLine($_) } }
            Write-Output '{"stopped":true,"statePreserved":true}'
        }
        'credentials' {
            if (-not $volume) { @{credentialsDirectory=$stateDir;credentialsPrinted=$false} | ConvertTo-Json -Compress; break }
            $export=Join-Path $stateDir 'credential-export'
            if (Test-Path -LiteralPath $export) { throw 'Credential export already exists; keep it private or remove it deliberately before exporting again' }
            New-Item -ItemType Directory -Path $export | Out-Null
            $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
            $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false)
            $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
            $acl.AddAccessRule($rule); Set-Acl -LiteralPath $export -AclObject $acl
            $paths=@(Invoke-Docker ($helper+@('credential-paths')))
            $copy=(Invoke-Docker @('create','--mount',$mount,$image)).Trim()
            try { foreach ($path in $paths) {
                if ($path -notmatch '^(factory|lines/[a-z][a-z0-9-]{0,62})/credentials.json$') { throw 'Invalid credential export path' }
                $target=Join-Path $export $path; New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                Invoke-Docker @('cp',"${copy}:/state/$path",$target) | Out-Null
            } } finally { Invoke-Docker @('rm',$copy) | Out-Null }
            @{credentialsDirectory=$export;credentialsPrinted=$false} | ConvertTo-Json -Compress
        }
    }
} catch { [Console]::Error.WriteLine($_.Exception.Message); if ($startAttempted) { [Console]::Error.WriteLine('System start incomplete; running services and state were preserved. Inspect system status or run system stop with the same --state-dir.') }; exit 1 }
