
import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (existsSync(join(process.cwd(), '.env'))) throw new Error('Run integration in an isolated worktree without .env');
const root=process.cwd(), port=3101, base='http://127.0.0.1:'+port;
const bearer=randomBytes(32).toString('hex');
const child=spawn(process.execPath,['index.js','--http'],{cwd:root,env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',BASE_URL:base,MCP_TOKEN:bearer,APPROVE_PASSWORD:randomBytes(32).toString('hex'),BROWSER_SMOKE_LOCAL_PORTS:'3100,3101'},stdio:['ignore','ignore','pipe']});
let diagnostics='';child.stderr.on('data',d=>{diagnostics=(diagnostics+d).slice(-8000)});
const client=new Client({name:'attauhid-parity-smoke',version:'1.0.0'});
const id='parity-'+Date.now(), temp=mkdtempSync(join(tmpdir(),'mcp-parity-')), upload='/home/attauhid/private/mcp-uploads/'+id+'.png';
const cleanupPaths=[temp,upload];
let count=0;
const pass=name=>{count++;console.log('PASS '+name)};
const raw=async(name,args={})=>client.callTool({name,arguments:args});
const call=async(name,args={})=>{
  const r=await raw(name,args); const t=r.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';
  if(r.isError||/^[^\n]*Error:/.test(t)) throw new Error(name+' failed: '+t.slice(0,200));
  try{return JSON.parse(t)}catch{return t}
};
try {
  let ready=false;for(let n=0;n<60;n++){try{const r=await fetch(base+'/health');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,150))}
  assert(ready,'sidecar failed to start');
  await client.connect(new StreamableHTTPClientTransport(new URL(base),{requestInit:{headers:{Authorization:'Bearer '+bearer}}}));
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,40);assert.equal(new Set(tools.map(t=>t.name)).size,40);
  for(const n of ['ssh_checkpoint','ssh_repo_snapshot','ssh_repo_verify','ssh_repo_worktree','ssh_repo_review','ssh_repo_commit_push','ssh_project','ssh_workspace','ssh_agent_board','ssh_create_upload_slot','ssh_read_image','browser_smoke','adb_screenshot_visual','browser_view'])assert(tools.some(t=>t.name===n),n);
  pass('40 tools and preserved browser schemas');
  const resources=await client.listResources();assert(resources.resources.some(r=>r.uri.includes('browser-card')));
  const resource=await client.readResource({uri:resources.resources[0].uri});assert(resource.contents[0].text.includes('<'));
  await call('browser_tabs',{action:'list'});pass('browser connection and MCP App resource');
  await call('ssh_connect',{connectionId:id,host:'103.67.78.41',port:2222,username:'attauhid',privateKey:readFileSync('/home/attauhid/.ssh/id_ed25519','utf8')});pass('SSH connection');
  const snapshot=await call('ssh_repo_snapshot',{connectionId:id,repoPath:root});assert(snapshot.commit);pass('repository snapshot');
  execFileSync('git',['init','-q',temp]);
  execFileSync('git',['-C',temp,'config','user.email','smoke@localhost']);
  execFileSync('git',['-C',temp,'config','user.name','MCP Smoke']);
  writeFileSync(join(temp,'fixture.txt'),'test fixture\n');
  execFileSync('git',['-C',temp,'add','fixture.txt']);execFileSync('git',['-C',temp,'commit','-qm','test fixture']);
  await call('ssh_repo_verify',{connectionId:id,repoPath:temp});
  await call('ssh_repo_review',{connectionId:id,repoPath:temp});pass('repository verify and review');
  const cp=await call('ssh_checkpoint',{connectionId:id,action:'save',checkpointId:id,data:{objective:'Parity smoke fixture',repoPath:temp,phase:'verify',completed:['test fixture'],next:[]}});
  assert.equal(cp.checkpointId,id);
  const cpLoad=await call('ssh_checkpoint',{connectionId:id,action:'load',checkpointId:id});assert.equal(cpLoad.objective,'Parity smoke fixture');
  cleanupPaths.push('/home/attauhid/.mcp-workflow/checkpoints/'+id+'.json');pass('checkpoint save and load');
  await call('ssh_project',{connectionId:id,action:'create',profile:{projectId:id,repoPath:temp,displayName:'Parity test',uploadRoots:['/home/attauhid/private/mcp-uploads'],imageRoots:['/home/attauhid/private/mcp-uploads']}});
  cleanupPaths.push('/home/attauhid/.mcp-workflow/projects/'+id+'.json');
  await call('ssh_project',{connectionId:id,action:'status',projectId:id,fetch:false});pass('project registry and status');
  await call('ssh_workspace',{connectionId:id,action:'create',workspaceId:id,projectId:id,tasks:[{name:'verify',branch:id}],fetch:false});
  await call('ssh_workspace',{connectionId:id,action:'status',workspaceId:id});
  await call('ssh_agent_board',{connectionId:id,action:'create',boardId:id,workspaceId:id,tasks:[{name:'verify',objective:'Smoke test coordination'}]});
  await call('ssh_agent_board',{connectionId:id,action:'claim',boardId:id,agentId:id,taskName:'verify'});
  await call('ssh_agent_board',{connectionId:id,action:'heartbeat',boardId:id,agentId:id,taskName:'verify'});
  await call('ssh_agent_board',{connectionId:id,action:'submit',boardId:id,agentId:id,taskName:'verify',summary:'Smoke complete'});
  await call('ssh_agent_board',{connectionId:id,action:'remove',boardId:id});
  await call('ssh_workspace',{connectionId:id,action:'remove',workspaceId:id});pass('workspace and agent board lifecycle');
  const image=await raw('browser_smoke',{url:base+'/health',expectedText:'3.10.0',screenshot:true});
  const png=image.content.find(c=>c.type==='image');assert(png);
  const report=JSON.parse(image.content.find(c=>c.type==='text').text);assert(report.ok);
  pass('sandboxed Chromium smoke and screenshot');
  const slot=await call('ssh_create_upload_slot',{connectionId:id,projectId:id,remotePath:upload});
  const token=new URLSearchParams(new URL(slot.uploadUrl).hash.slice(1)).get('token');
  const send=()=>fetch(base+'/upload-file',{method:'POST',headers:{Authorization:'Upload '+token,'Content-Type':'application/octet-stream'},body:Buffer.from(png.data,'base64')});
  const statuses=await Promise.all([send(),send()]).then(rs=>rs.map(r=>r.status).sort());
  assert.deepEqual(statuses,[200,401]);pass('binary upload and concurrent replay rejection');
  const read=await raw('ssh_read_image',{connectionId:id,projectId:id,remotePath:upload});assert(read.content.some(c=>c.type==='image'));pass('remote image reading');
  const rejected=await raw('ssh_create_upload_slot',{connectionId:id,remotePath:'/etc/test.png'});assert(rejected.content[0].text.includes('Error'));pass('upload path boundary rejection');
  const unauth=await fetch(base+'/',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauth.status,401);pass('MCP still requires authentication');
  await call('ssh_disconnect',{connectionId:id});
  console.log('RESULT '+count+' integration checks passed');
} finally {
  await client.close().catch(()=>{});
  child.kill('SIGTERM');
  for(const p of cleanupPaths)rmSync(p,{recursive:true,force:true});
}
