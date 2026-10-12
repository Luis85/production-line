import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
/** Exercise real local Git and dynamic helpers with all container networking disabled. */
export async function checkDockerGit(image) {
  const program = `
    const fs=require('node:fs'),cp=require('node:child_process');
    fs.mkdirSync('/tmp/repo');
    const git=(...args)=>cp.execFileSync('git',args,{cwd:'/tmp/repo',encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init');git('config','user.name','Release smoke');git('config','user.email','smoke@example.invalid');
    fs.writeFileSync('/tmp/repo/note.md','pinned note\\n');git('add','note.md');git('commit','-m','local smoke');
    const commit=git('rev-parse','HEAD');if(git('show',commit+':note.md')!=='pinned note')throw Error('show');
    git('worktree','add','--detach','/tmp/tree',commit);
    if(fs.readFileSync('/tmp/tree/note.md','utf8')!=='pinned note\\n')throw Error('worktree');
    git('archive','--format=tar','--output=/tmp/source.tar',commit);if(!fs.statSync('/tmp/source.tar').size)throw Error('archive');
    for(const helper of ['git-remote-https','git-upload-pack','git-receive-pack']){
      const path='/usr/lib/git-core/'+helper;
      if(!fs.existsSync(path)||cp.execFileSync('ldd',[path],{encoding:'utf8'}).includes('not found'))throw Error(helper);
    }
    if(!fs.existsSync('/usr/share/doc/git/copyright'))throw Error('license');
    console.log(JSON.stringify({node:process.versions.node,git:git('--version'),localCommit:true,worktree:true,archive:true,httpsHelper:true,licenses:true}));
  `;
  const result = await exec('docker', ['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,size=16777216','--entrypoint','node',image,'-e',program], { timeout: 60000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}
