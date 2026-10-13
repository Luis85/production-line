# Docker Desktop / Docker Compose required. No host Node.js dependency.
$ErrorActionPreference = 'Stop'
$releaseDir = $PSScriptRoot
if ($args.Count -and $args[0] -eq 'system') { $systemArgs=@($args | Select-Object -Skip 1); & (Join-Path $releaseDir 'scripts/docker/system.ps1') @systemArgs; exit $LASTEXITCODE }
$commandName = if ($args.Count) { [string]$args[0] } else { 'help' }
$stateDir = Join-Path $releaseDir '.werk'
$noOpen = $false
$json = $false
$forward = @()
for ($i = 1; $i -lt $args.Count; $i++) {
    switch ([string]$args[$i]) {
        '--state-dir' { if ($i + 1 -ge $args.Count) { throw '--state-dir requires a path' }; $stateDir = [string]$args[++$i] }
        '--no-open' { $noOpen = $true }
        '--json' { $json = $true }
        default { $forward += [string]$args[$i] }
    }
}
function Invoke-Docker([string[]]$DockerArgs) {
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Docker command failed; see diagnostics above.' }
}
try {
    if ($commandName -in @('help', '--help')) {
        Write-Output 'Werk Docker release (mock): setup | start [--no-open] | status | logs | stop | credentials | cli <orchestrator arguments>'
        Write-Output 'Options: --state-dir PATH, --json. Setup accepts --project ID --port N --worker-port N --workers 1.'
        exit 0
    }
    if ($commandName -notin @('setup', 'start', 'status', 'logs', 'stop', 'cli', 'credentials')) { throw 'Unknown command; use help' }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker with Compose is required; host Node.js is not required.' }
    Invoke-Docker @('compose', 'version') | Out-Null
    if ($commandName -eq 'setup' -and -not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
    $item = Get-Item -LiteralPath $stateDir
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'State directory must be a real private directory, not a link.' }
    $stateDir = $item.FullName
    if ($stateDir -match '[,\r\n]') { throw 'State directory must not contain commas or line breaks.' }
    $env:WERK_DOCKER_STATE_DIR = $stateDir
    $windowsVolume = $env:OS -eq 'Windows_NT'
    $volumeName = $null
    $installation = $null
    if ($windowsVolume) {
        if (Test-Path -LiteralPath (Join-Path $stateDir 'config.json')) { throw 'This directory contains host runtime configuration. Use its original launcher or choose a separate Docker state directory.' }
        $pointer = Join-Path $stateDir 'docker-volume.json'
        $pointerExisted=Test-Path -LiteralPath $pointer
        if ($pointerExisted) {
            if ((Get-Item -LiteralPath $pointer).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Docker state pointer must not be a link.' }
            $metadata = Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json
            $volumeName = [string]$metadata.volume
            $installation = [string]$metadata.installation
            if ($metadata.schemaVersion -ne 1 -or $installation -notmatch '^[a-f0-9]{32}$' -or $volumeName -ne ('werk-' + $installation.Substring(0,12) + '-state')) { throw 'Invalid Docker state volume pointer.' }
        } elseif ($commandName -eq 'setup') {
            $installation = [Guid]::NewGuid().ToString('N')
            $volumeName = 'werk-' + $installation.Substring(0,12) + '-state'
            @{ schemaVersion=1; volume=$volumeName; installation=$installation } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pointer -Encoding UTF8
        } else { throw 'Docker volume configuration is missing; run setup first.' }
        $env:WERK_DOCKER_VOLUME = $volumeName
    }
    $env:WERK_DOCKER_UID = '1000'; $env:WERK_DOCKER_GID = '1000'
    if ($env:OS -ne 'Windows_NT' -and (Get-Command id -ErrorAction SilentlyContinue)) {
        $env:WERK_DOCKER_UID = (& id -u).Trim(); $env:WERK_DOCKER_GID = (& id -g).Trim()
    }
    if (-not $env:WERK_DOCKER_IMAGE) { $env:WERK_DOCKER_IMAGE = 'werk-release:local' }
    if ($windowsVolume) {
        $existingVolumes = @(Invoke-Docker @('volume','ls','--filter',"name=^$volumeName`$",'--format','{{.Name}}'))
        if ($volumeName -notin $existingVolumes) {
            if ($pointerExisted -or $commandName -ne 'setup') { throw 'The existing Docker state volume is missing. Restore its backup or deliberately choose a new state directory; existing installation state will not be recreated.' }
            Invoke-Docker @('volume','create','--label',"dev.werk.installation=$installation",$volumeName) | Out-Null
        }
        $actualInstallation = (Invoke-Docker @('volume','inspect','--format','{{index .Labels "dev.werk.installation"}}',$volumeName)).Trim()
        if ($actualInstallation -ne $installation) { throw 'Docker volume ownership label does not match this installation.' }
    }
    if ($commandName -in @('setup', 'start')) {
        Invoke-Docker @('build', '--file', (Join-Path $releaseDir 'Dockerfile.release'), '--tag', $env:WERK_DOCKER_IMAGE, $releaseDir) | ForEach-Object { [Console]::Error.WriteLine($_) }
    }
    $mount = if ($windowsVolume) { "type=volume,source=$volumeName,target=/state" } else { "type=bind,source=$stateDir,target=/state" }
    $operatorArgs = @('run', '--rm', '--user', "$($env:WERK_DOCKER_UID):$($env:WERK_DOCKER_GID)", '--mount', $mount, $env:WERK_DOCKER_IMAGE)
    if ($commandName -eq 'setup') {
        Invoke-Docker ($operatorArgs + @('setup', '--host-state', $stateDir) + $forward)
        if ($windowsVolume) {
            $metadataPath = Join-Path $stateDir 'docker.env'
            if ((Test-Path -LiteralPath $metadataPath) -and ((Get-Item -LiteralPath $metadataPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Docker metadata must not be a link.' }
            $copyContainer = (Invoke-Docker @('create','--mount',$mount,$env:WERK_DOCKER_IMAGE)).Trim()
            try { Invoke-Docker @('cp',"${copyContainer}:/state/docker.env",(Join-Path $stateDir 'docker.env')) | Out-Null } finally { Invoke-Docker @('rm',$copyContainer) | Out-Null }
            @{ schemaVersion=1; volume=$volumeName; installation=$installation } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $stateDir 'docker-volume.json') -Encoding UTF8
        }
        exit 0
    }
    if ($commandName -eq 'credentials') {
        if ($forward.Count -ne 0) { throw 'credentials accepts only --state-dir and --json' }
        if ($windowsVolume) {
            $exportDir = Join-Path $stateDir 'credential-export'
            if (Test-Path -LiteralPath $exportDir) { throw 'Credential export already exists. Keep it private or remove it deliberately before exporting again.' }
            New-Item -ItemType Directory -Path $exportDir | Out-Null
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            $acl = New-Object Security.AccessControl.DirectorySecurity
            $acl.SetAccessRuleProtection($true,$false)
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
            $acl.AddAccessRule($rule); Set-Acl -LiteralPath $exportDir -AclObject $acl
            $copyContainer = (Invoke-Docker @('create','--mount',$mount,$env:WERK_DOCKER_IMAGE)).Trim()
            try { Invoke-Docker @('cp',"${copyContainer}:/state/credentials.json",(Join-Path $exportDir 'credentials.json')) | Out-Null } finally { Invoke-Docker @('rm',$copyContainer) | Out-Null }
            @{ credentialsFile=(Join-Path $exportDir 'credentials.json'); credentialsPrinted=$false } | ConvertTo-Json -Compress
        } else { @{ credentialsFile=(Join-Path $stateDir 'credentials.json'); credentialsPrinted=$false } | ConvertTo-Json -Compress }
        exit 0
    }
    $envFile = Join-Path $stateDir 'docker.env'
    if (-not (Test-Path -LiteralPath $envFile) -or ((Get-Item -LiteralPath $envFile).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Docker setup metadata is missing or linked; run setup first.' }
    $projectMatch = [regex]::Match((Get-Content -LiteralPath $envFile -Raw), '(?m)^WERK_DOCKER_PROJECT=(werk-[a-f0-9]{12})\r?$')
    if (-not $projectMatch.Success) { throw 'Invalid Docker project metadata; run setup again.' }
    $composeArgs = @('compose', '--project-directory', $releaseDir, '--env-file', $envFile, '--file', (Join-Path $releaseDir 'compose.release.yaml'), '--project-name', $projectMatch.Groups[1].Value)
    if ($windowsVolume) { $composeArgs += @('--file', (Join-Path $releaseDir 'compose.windows.yaml')) }
    if ($commandName -ne 'cli' -and $forward.Count -ne 0) { throw 'Unknown options for Docker command' }
    switch ($commandName) {
        'start' {
            Invoke-Docker ($composeArgs + @('up', '--detach', '--wait', '--wait-timeout', '90', 'orchestrator', 'worker')) | ForEach-Object { [Console]::Error.WriteLine($_) }
            Invoke-Docker ($composeArgs + @('exec', '-T', 'orchestrator', 'node', '/app/scripts/docker/operator.mjs', 'status'))
            if (-not $noOpen -and -not $json) {
                $url = (Invoke-Docker ($operatorArgs + @('url'))).Trim()
                try { Start-Process -FilePath $url | Out-Null } catch { [Console]::Error.WriteLine("Open $url") }
            }
        }
        'status' { Invoke-Docker ($composeArgs + @('exec', '-T', 'orchestrator', 'node', '/app/scripts/docker/operator.mjs', 'status')) }
        'stop' { Invoke-Docker ($composeArgs + @('stop', '--timeout', '20', 'orchestrator', 'worker')) | ForEach-Object { [Console]::Error.WriteLine($_) }; Write-Output '{"stopped":true,"statePreserved":true}' }
        'logs' {
            if ($json) {
                $lines = Invoke-Docker ($composeArgs + @('logs', '--no-color', '--tail', '100', 'orchestrator', 'worker'))
                @{ lines = @($lines) } | ConvertTo-Json -Compress
            } else { Invoke-Docker ($composeArgs + @('logs', '--no-color', '--tail', '100', 'orchestrator', 'worker')) }
        }
        'cli' { $input | & docker @composeArgs exec -T orchestrator node /app/scripts/docker/operator.mjs cli @forward; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
    }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
