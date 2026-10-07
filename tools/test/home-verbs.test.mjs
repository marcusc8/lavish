// The four verbs' server side (phase 12, D7 / package P6): `where` on resume and new, the remembered chooser, the
// place the chats answer names, Go to session refusing when nothing is alive, and an uncertain launch followed up
// after a restart. A stub daemon here; the home's own path can start nothing (a scratch HOME with no claude).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';

const KEY='0123456789abcdef',SID='11111111-2222-3333-4444-555555555555';
async function freePort(){const p=createServer();await new Promise(r=>p.listen(0,'127.0.0.1',r));const port=p.address().port;await new Promise(r=>p.close(r));return port;}
async function startHome(dir,mmUrl,extraEnv={}){
 const port=await freePort();
 const bin=join(dir,'bin');mkdirSync(bin,{recursive:true});for(const n of ['tmux','claude','codex','osascript','open']){writeFileSync(join(bin,n),`#!/bin/sh\necho "$*" >> "${join(dir,n+'.calls')}"\nexit 1\n`);chmodSync(join(bin,n),0o755);}
 const env={...process.env,HOME:join(dir,'home'),PATH:`${bin}:${process.env.PATH}`,LAVISH_AXI_STATE_DIR:dir,LAVISH_HOME_PORT:String(port),LAVISH_AXI_PORT:String(port+1),CODEX_HOME:join(dir,'codex'),CLAUDE_CONFIG_DIR:join(dir,'claude'),TMUX_TMPDIR:join(dir,'tmux'),LAVISH_MM_URL:mmUrl,LAVISH_OSASCRIPT_BIN:join(bin,'osascript'),LAVISH_MM_FOLLOWUP_MS:'0',...extraEnv};
 delete env.TMUX;delete env.TMUX_PANE;
 const child=spawn(process.execPath,[fileURLToPath(new URL('../lavish-home.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
 let err='';child.stderr.on('data',d=>{err+=d;});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Home failed to start: '+err)),8000);child.stdout.on('data',d=>{if(String(d).includes('lavish-home on')){clearTimeout(timeout);resolve();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Home exited '+code+': '+err));});});
 return {port,child,stop:()=>{child.kill('SIGTERM');return new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}};
}
function fixture({agent={provider:'claude',id:SID,entrypoint:'cli'}}={}){
 const dir=mkdtempSync(join(tmpdir(),'lavish-home-verbs-'));mkdirSync(join(dir,'home'),{recursive:true});mkdirSync(join(dir,'tmux'),{recursive:true});
 const plan=join(dir,'plan.html');writeFileSync(plan,'<!doctype html><html><head><title>Verbs plan</title><meta name="description" content="A plan for the four verbs"></head><body><h1>Verbs plan</h1></body></html>');
 const a=agent?{...agent,cwd:dir}:null;
 writeFileSync(join(dir,'state.json'),JSON.stringify({sessions:{[KEY]:{key:KEY,file:plan,status:'open',updated_at:new Date().toISOString(),chat:[],prompts:[]}}}));
 writeFileSync(join(dir,'registry.json'),JSON.stringify({[KEY]:a?{file:plan,agent:a,agents:[a]}:{file:plan}}));
 return dir;
}
/** A stub Manager Marcus: the holder (or 404), the workspace list, and each POST recorded and answered as `answers[verb]` says. */
async function stubDaemon(holder,answers={},workspaces=null){
 const calls=[];
 const s=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  const parsed=body?JSON.parse(body):null;calls.push({method:req.method,url:req.url,body:parsed});
  const send=(status,value,delayMs=0)=>{const go=()=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};if(delayMs)setTimeout(go,delayMs);else go();};
  if(req.url==='/api/workspaces'){const w=typeof workspaces==='function'?workspaces(calls):workspaces;return w?send(200,w):send(500,{error:'cannot list'});}
  const m=/^\/api\/plans\/([0-9a-f]{16})(?:\/(reconnect|resume|new))?$/.exec(req.url);
  if(!m)return send(404,{error:'no'});
  if(req.method==='GET'){const h=typeof holder==='function'?holder(calls):holder;return h?send(200,h):send(404,{error:'no workspace holds this plan'});}
  let a=answers[m[2]]||{status:500,body:{error:'unexpected'}};if(typeof a==='function')a=a(parsed,calls);
  send(a.status,a.body,a.delayMs||0);});});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${s.address().port}`,calls,posts:()=>calls.filter(c=>c.method==='POST'),close:()=>new Promise(r=>{s.closeAllConnections();s.close(r);})};
}
const post=(port,verb,body={})=>fetch(`http://127.0.0.1:${port}/api/chats/${KEY}/${verb}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}));
const chats=port=>fetch(`http://127.0.0.1:${port}/api/chats/${KEY}`).then(r=>r.json());
const until=async(f,what,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await f();if(v)return v;if(Date.now()>end)throw new Error('timed out waiting for '+what);await new Promise(r=>setTimeout(r,50));}};
const HOLDER={workspace:{id:'w-0a1b2c3d',title:'Crews'},flow:'draft',session:{provider:'claude',sessionId:SID},terminal:{tmuxName:'mm-claude-11111111',alive:true}};
const term=(tmuxName,over={})=>({tmuxName,kind:'claude',workspaceId:'w-0a1b2c3d',role:null,name:null,cwd:'/x',sessionId:null,liveness:'alive',createdAt:1,...over});
const WORKSPACES={projects:[{projectDir:'/x',workspaces:[
 {id:'w-ffffffff',title:'Other',terminals:[term('mm-claude-11111111',{workspaceId:'w-ffffffff'})]},
 {id:'w-0a1b2c3d',title:'Crews',terminals:[term('mm-shell-aaaaaaaa',{kind:'shell'}),term('mm-claude-11111111',{sessionId:SID}),term('mm-claude-22222222',{liveness:'ended'}),term('mm-claude-33333333',{liveness:'unknown'})]}]}],prefs:{}};
const NEW_OK={status:201,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url:'http://localhost:5173/#/w/w-0a1b2c3d/terminals?pane=mm-claude-22222222',terminal:{tmuxName:'mm-claude-22222222',kind:'claude',sessionId:'22222222-2222-3333-4444-555555555555',cwd:'/x'}}};

test('where: "terminal" takes the home\'s own path even when a workspace holds the plan: resume and new never reach the daemon',{timeout:30000},async()=>{
 const dir=fixture();const mm=await stubDaemon(HOLDER,{resume:{status:202,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-11111111',url:'u'}},new:NEW_OK});
 const home=await startHome(dir,mm.url);
 try{
  const rs=await post(home.port,'resume',{where:'terminal'});
  assert.equal(rs.status,409,JSON.stringify(rs));
  assert.match(rs.body.error,/^claude not found in .*\/home\/\.local\/bin$/); // the home's own path, which has no claude on this scratch HOME
  assert.equal(rs.body.mm,undefined);
  const nw=await post(home.port,'new',{where:'terminal',provider:'claude'});
  assert.equal(nw.status,409,JSON.stringify(nw));
  assert.match(nw.body.error,/^claude not found in .*\/home\/\.local\/bin$/);
  assert.deepEqual(mm.posts(),[]);
  assert.equal((await chats(home.port)).launch,null);
  // the same verbs without `where` still go to the workspace (P2's rule, which an older chrome relies on)
  const held=await post(home.port,'resume',{});
  assert.equal(held.status,200,JSON.stringify(held));assert.equal(held.body.mm.tmuxName,'mm-claude-11111111');
  assert.deepEqual(mm.posts().map(c=>c.url),[`/api/plans/${KEY}/resume`]);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('where: "here" with no workspace holding the plan is refused with the reason, and nothing is reserved or started',{timeout:30000},async()=>{
 const dir=fixture();const mm=await stubDaemon(null);
 const home=await startHome(dir,mm.url);
 try{
  const expected='No Manager Marcus workspace holds this plan, or Manager Marcus is not answering: nothing was started. Choose Terminal.app instead, or add the plan to a workspace first.';
  assert.deepEqual(await post(home.port,'resume',{where:'here'}),{status:409,body:{error:expected}});
  assert.deepEqual(await post(home.port,'new',{where:'here',provider:'claude'}),{status:409,body:{error:expected}});
  const c=await chats(home.port);assert.equal(c.launch,null);assert.equal(c.chats.length,1);
  assert.deepEqual(mm.posts(),[]);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('the chooser\'s last choice is remembered per plan in the chat record, by the new action alone, across a restart of the home',{timeout:30000},async()=>{
 const dir=fixture();const mm=await stubDaemon(HOLDER,{new:NEW_OK},WORKSPACES);
 let home=await startHome(dir,mm.url);
 try{
  assert.equal((await chats(home.port)).where,'');
  await post(home.port,'resume',{where:'terminal'}); // a resume never writes the chooser
  assert.equal((await chats(home.port)).where,'');
  const failed=await post(home.port,'new',{where:'terminal',provider:'claude'}); // remembered even though the start failed
  assert.equal(failed.status,409);
  assert.equal((await chats(home.port)).where,'terminal');
  assert.equal(JSON.parse(readFileSync(join(dir,'chats',KEY+'.json'),'utf8')).newChatWhere,'terminal');
  const ok=await post(home.port,'new',{where:'here',provider:'claude'});
  assert.equal(ok.status,200,JSON.stringify(ok));assert.equal(ok.body.mm.tmuxName,'mm-claude-22222222');
  assert.equal((await chats(home.port)).where,'here');
  await home.stop();home=await startHome(dir,mm.url);
  assert.equal((await chats(home.port)).where,'here');
  // a value that is neither is not written
  await post(home.port,'new',{where:'elsewhere',provider:'claude'});
  assert.equal((await chats(home.port)).where,'here');
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('the chats answer names the place: the holder workspace, the pane\'s position in its terminal list, and each chat\'s own state and where',{timeout:30000},async()=>{
 const dir=fixture();const mm=await stubDaemon(HOLDER,{},WORKSPACES);
 const home=await startHome(dir,mm.url);
 try{
  const c=await chats(home.port);
  assert.deepEqual(c.mm,{workspace:{id:'w-0a1b2c3d',title:'Crews'},flow:'draft',session:{provider:'claude',sessionId:SID},terminal:{tmuxName:'mm-claude-11111111',alive:true},pane:2,
   panes:{'mm-shell-aaaaaaaa':1,'mm-claude-11111111':2,'mm-claude-22222222':3,'mm-claude-33333333':4},alive:{'mm-shell-aaaaaaaa':true,'mm-claude-11111111':true,'mm-claude-22222222':false,'mm-claude-33333333':null},listed:true});
  const chat=c.chats.find(x=>x.agent?.id===SID);
  assert.deepEqual(chat.place,{state:'ended',where:'a terminal',endedAt:''});
  assert.equal(chat.agentState,'ended');
  assert.deepEqual(c.launch,null);
  // the daemon is asked through the home, never more than once per poll burst: three reads of the chats make one holder lookup
  await chats(home.port);await chats(home.port);
  assert.equal(mm.calls.filter(x=>x.method==='GET'&&x.url===`/api/plans/${KEY}`).length,1);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('not held, or the daemon down or listing nothing: mm is null (or has no pane) and the answer is otherwise the same',{timeout:30000},async()=>{
 const dir=fixture();const none=await stubDaemon(null);let noList=null;
 let home=await startHome(dir,none.url);
 try{
  assert.equal((await chats(home.port)).mm,null);
  await home.stop();home=await startHome(dir,'http://127.0.0.1:1');
  const c=await chats(home.port);assert.equal(c.mm,null);assert.equal(c.chats.length,1);assert.equal(c.connection,'disconnected');
  await home.stop();noList=await stubDaemon(HOLDER,{},null);home=await startHome(dir,noList.url);
  const d=await chats(home.port);assert.equal(d.mm.workspace.title,'Crews');assert.equal(d.mm.pane,null);assert.deepEqual(d.mm.panes,{});assert.deepEqual(d.mm.alive,{});assert.equal(d.mm.listed,false);
 }finally{await home.stop();await none.close();if(noList)await noList.close();rmSync(dir,{recursive:true,force:true});}
});

test('Go to session on the home\'s own path never starts anything: an ended session is refused with when and where, a chat with no session with that',{timeout:30000},async()=>{
 const dir=fixture();const mm=await stubDaemon(null);
 // a transcript, so the home knows when the session last wrote
 const proj=join(dir,'claude','projects','-x');mkdirSync(proj,{recursive:true});
 writeFileSync(join(proj,SID+'.jsonl'),JSON.stringify({type:'user',timestamp:'2026-10-03T08:00:00.000Z',cwd:dir,sessionId:SID,message:{role:'user',content:'hi'}})+'\n'+JSON.stringify({type:'assistant',timestamp:'2026-10-03T10:42:00.000Z',sessionId:SID,message:{role:'assistant',model:'claude-fable-5-1',content:[{type:'text',text:'ok'}]}})+'\n');
 const home=await startHome(dir,mm.url,{TZ:'UTC'});
 try{
  const c=await chats(home.port);const chat=c.chats.find(x=>x.agent?.id===SID);
  assert.equal(chat.place.state,'ended');assert.equal(chat.place.where,'a terminal');assert.match(chat.place.endedAt,/^2026-10-0\dT/);
  const r=await post(home.port,'reconnect',{chatId:chat.id});
  assert.equal(r.status,409);
  assert.match(r.body.error,/^No session to go to; the last one ended \d{1,2} Oct \d\d:\d\d in a terminal\.$/);
  assert.deepEqual(mm.posts(),[]);
  for(const n of ['tmux','claude','osascript','open'])assert.throws(()=>readFileSync(join(dir,n+'.calls')),/ENOENT/,n+' must not have run');
  // resume still resumes (and fails here only because this scratch HOME has no claude)
  assert.match((await post(home.port,'resume',{chatId:chat.id})).body.error,/^claude not found in /);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('an uncertain delegated launch shows in the chats answer, and the home follows it up again after a restart: no press resolves or clears it',{timeout:40000},async()=>{
 const dir=fixture();let finished=false;
 const answer={workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url:null,terminal:NEW_OK.body.terminal};
 const mm=await stubDaemon(HOLDER,{new:(body)=>body.replay?(finished?{status:200,body:{replay:true,requestId:body.requestId,state:'done',answer}}:{status:200,body:{replay:true,requestId:body.requestId,state:'pending'}}):{status:202,body:{pending:true}}},WORKSPACES);
 let home=await startHome(dir,mm.url,{LAVISH_MM_ACTION_TIMEOUT_MS:'400'});
 try{
  const nw=await post(home.port,'new',{where:'here',provider:'claude'});
  assert.equal(nw.status,409);assert.match(nw.body.error,/^Manager Marcus is still starting it;/);
  const c=await chats(home.port);
  assert.equal(c.launch.state,'uncertain');assert.equal(c.launch.mm,true);
  const starts=()=>mm.posts().filter(p=>!p.body.replay).length;
  assert.equal(starts(),1);
  // every verb pressed while it is uncertain (review round 1, Q4): each is answered "still starting", the daemon is only ASKED about the one request id, nothing starts, and the reservation and the chats stay as they were
  const asked=mm.posts().length,launchId=c.launch.id,chatIds=c.chats.map(x=>x.id);
  const presses=[['new',{where:'here',provider:'claude'}],['resume',{where:'here'}],['resume',{}],['reconnect',{}],['resume',{where:'terminal'}],['new',{where:'terminal',provider:'claude'}],['new',{provider:'codex'}]];
  for(const [verb,body] of presses){
   const r=await post(home.port,verb,body);
   assert.equal(r.status,409,verb);assert.match(r.body.error,/^Manager Marcus is still starting it;/,verb+' '+JSON.stringify(body));
  }
  const since=mm.posts().slice(asked);
  assert.deepEqual(since.map(p=>[p.url,p.body.replay,p.body.requestId]),presses.map(()=>[`/api/plans/${KEY}/new`,true,launchId]));
  assert.equal(starts(),1);
  for(const n of ['tmux','claude','codex','osascript','open'])assert.throws(()=>readFileSync(join(dir,n+'.calls')),/ENOENT/,n+' must not have run');
  const still=await chats(home.port);
  assert.deepEqual(still.launch,{id:launchId,state:'uncertain',mm:true});assert.deepEqual(still.chats.map(x=>x.id),chatIds);assert.equal(still.activeChatId,launchId);
  // the home restarts: its follow-up loop died with it; reading the chats (what an open panel does every few seconds) starts it again
  await home.stop();home=await startHome(dir,mm.url,{LAVISH_MM_FOLLOWUP_MS:'150'});
  assert.equal((await chats(home.port)).launch.state,'uncertain');
  await until(()=>mm.posts().filter(p=>p.body.replay).length>=2,'the follow-up asking again');
  assert.equal((await chats(home.port)).launch.state,'uncertain');
  finished=true;
  const done=await until(async()=>{const x=await chats(home.port);return x.launch&&x.launch.state==='waiting'&&x;},'the launch resolved by the follow-up');
  assert.equal(done.chats.find(x=>x.id===done.launch.id).tmuxName,'mm-claude-22222222');
  assert.equal(starts(),1);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('Go to session for a session alive in another app says where it is and starts nothing; the chats answer places it there',{timeout:30000},async()=>{
 const dir=fixture({agent:{provider:'claude',id:SID,entrypoint:'claude-vscode'}});const mm=await stubDaemon(null);
 // Claude's own pid file: this test process stands in for the editor's claude (alive, not in any tmux)
 mkdirSync(join(dir,'claude','sessions'),{recursive:true});
 writeFileSync(join(dir,'claude','sessions',process.pid+'.json'),JSON.stringify({pid:process.pid,sessionId:SID,name:'verbs-vscode',entrypoint:'claude-vscode',cwd:dir}));
 const home=await startHome(dir,mm.url);
 try{
  const c=await chats(home.port);const chat=c.chats.find(x=>x.agent?.id===SID);
  assert.deepEqual(chat.place,{state:'active',where:'VS Code',endedAt:''});
  const r=await post(home.port,'reconnect',{chatId:chat.id});
  assert.equal(r.status,409);
  assert.equal(r.body.error,`Claude session verbs-vscode is running in VS Code: go to it there. To have it listen to this plan, ask it to run lavish-poll ${JSON.stringify(join(dir,'plan.html'))} --chat ${chat.id}.`);
  // Resume refuses too, in the words it always had: the app owns that session
  assert.match((await post(home.port,'resume',{chatId:chat.id,where:'terminal'})).body.error,/^Claude session verbs-vscode is open in its app\./);
  for(const n of ['tmux','claude','osascript','open'])assert.throws(()=>readFileSync(join(dir,n+'.calls')),/ENOENT/,n+' must not have run');
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('Go to session on a chat the workspace started goes to THAT chat\'s pane while Manager Marcus lists it alive; the plan\'s own chat is the daemon\'s to answer',{timeout:30000},async()=>{
 const dir=fixture();let live='alive';
 const ws=()=>({projects:[{projectDir:'/x',workspaces:[{id:'w-0a1b2c3d',title:'Crews',terminals:[term('mm-claude-11111111',{sessionId:SID}),term('mm-claude-22222222',{liveness:live})]}]}],prefs:{}});
 const mm=await stubDaemon(HOLDER,{new:NEW_OK,reconnect:{status:200,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-11111111',url:'http://localhost:5173/#/w/w-0a1b2c3d/terminals?pane=mm-claude-11111111'}}},ws);
 const home=await startHome(dir,mm.url);
 try{
  const nw=await post(home.port,'new',{where:'here',provider:'claude'});
  assert.equal(nw.status,200,JSON.stringify(nw));
  const reconnects=()=>mm.posts().filter(p=>p.url.endsWith('/reconnect')).length;
  const own=await post(home.port,'reconnect',{chatId:nw.body.chatId});
  assert.deepEqual(own,{status:200,body:{ok:true,message:'Session is open in Crews.',mm:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url:null}}});
  assert.equal(reconnects(),0);
  // the plan's own chat still goes through the daemon's reconnect, with its url
  const first=(await chats(home.port)).chats.find(c=>c.agent?.id===SID);
  const plan=await post(home.port,'reconnect',{chatId:first.id});
  assert.equal(plan.body.mm.tmuxName,'mm-claude-11111111');assert.match(plan.body.mm.url,/pane=mm-claude-11111111$/);
  assert.equal(reconnects(),1);
  // that chat's pane has ended: the refusal is that chat's own (review round 1, Q3); the plan's planner pane is never offered in its place
  live='ended';
  const gone=await post(home.port,'reconnect',{chatId:nw.body.chatId});
  assert.equal(gone.status,409);assert.match(gone.body.error,/^No session to go to; the last one ended .* in Crews \(terminal mm-claude-22222222\)\.$/);
  assert.equal(reconnects(),1);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

/** As the session's poll does once it connects: the launch is over and the chat is the active one. */
function connected(dir){const f=join(dir,'chats',KEY+'.json');const d=JSON.parse(readFileSync(f,'utf8'));d.launch=null;writeFileSync(f,JSON.stringify(d,null,2));return d;}

test('review round 1, Q3 · the verbs act on the SELECTED chat: Go to session with that chat\'s pane ended refuses with that chat\'s when and where; Resume here sends that chat\'s session to the daemon',{timeout:30000},async()=>{
 const dir=fixture();let live='alive';
 const ws=()=>({projects:[{projectDir:'/x',workspaces:[{id:'w-0a1b2c3d',title:'Crews',terminals:[term('mm-claude-11111111',{sessionId:SID}),term('mm-claude-22222222',{liveness:live})]}]}],prefs:{}});
 let resumeAnswer={status:202,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url:'http://localhost:5173/#/w/w-0a1b2c3d/terminals?pane=mm-claude-22222222'}};
 const mm=await stubDaemon(HOLDER,{new:NEW_OK,resume:()=>resumeAnswer,reconnect:{status:200,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-11111111',url:'http://localhost:5173/#/w/w-0a1b2c3d/terminals?pane=mm-claude-11111111'}}},ws);
 const home=await startHome(dir,mm.url,{TZ:'UTC'});
 try{
  const nw=await post(home.port,'new',{where:'here',provider:'claude'});
  assert.equal(nw.status,200,JSON.stringify(nw));
  const record=connected(dir);const X=nw.body.chatId;
  assert.equal(record.chats[X].mmWorkspace,'w-0a1b2c3d'); // the chat is marked as living in that workspace when the daemon confirms its terminal
  const first=(await chats(home.port)).chats.find(c=>c.agent?.id===SID);
  const sent=verb=>mm.posts().filter(p=>p.url.endsWith('/'+verb));
  // its pane has ended, while the plan's planner (another pane) is alive: the refusal is about THIS chat, and the daemon's reconnect (which knows only the planner) is never asked
  live='ended';
  const go=await post(home.port,'reconnect',{chatId:X});
  assert.equal(go.status,409);
  assert.match(go.body.error,/^No session to go to; the last one ended (\d\d:\d\d|\d{1,2} \w{3} \d\d:\d\d|at an unknown time) in Crews \(terminal mm-claude-22222222\)\.$/);
  assert.equal(go.body.mm,undefined);assert.equal(sent('reconnect').length,0);
  // Resume here resumes THAT session: the daemon is given the session and the prompt that reconnects it to its chat
  const rs=await post(home.port,'resume',{chatId:X,where:'here'});
  assert.equal(rs.status,200,JSON.stringify(rs));assert.equal(rs.body.mm.tmuxName,'mm-claude-22222222');
  assert.equal(sent('resume').length,1);
  assert.deepEqual(sent('resume')[0].body.session,{provider:'claude',sessionId:'22222222-2222-3333-4444-555555555555'});
  assert.match(sent('resume')[0].body.prompt,new RegExp('lavish-poll .*plan\\.html.* --chat '+X));
  assert.match(sent('resume')[0].body.requestId,/^[0-9a-f-]{36}$/);
  // the plan's own chat: no session is named (the daemon's own resume), and it becomes the active chat so its poll can claim it
  const own=await post(home.port,'resume',{chatId:first.id,where:'here'});
  assert.equal(own.status,200,JSON.stringify(own));
  assert.equal(sent('resume')[1].body.session,undefined);assert.equal(sent('resume')[1].body.prompt,undefined);
  assert.equal((await chats(home.port)).activeChatId,first.id);
  // a refusal by the daemon leaves the active chat where it was, and comes back verbatim
  resumeAnswer={status:409,body:{error:'the session 22222222-2222-3333-4444-555555555555 is live elsewhere: it runs in the terminal mm-claude-22222222 in this workspace. Two writers on one transcript corrupt it, so it was not resumed'}};
  const refused=await post(home.port,'resume',{chatId:X,where:'here'});
  assert.deepEqual(refused,{status:409,body:{error:resumeAnswer.body.error}});
  assert.equal((await chats(home.port)).activeChatId,first.id);
  // unknown (review round 1, Q6): the daemon could not say whether that pane runs; nothing is assumed either way
  live='unknown';
  const unknown=await post(home.port,'reconnect',{chatId:X});
  assert.deepEqual(unknown,{status:409,body:{error:'Cannot tell whether mm-claude-22222222 is running (Manager Marcus could not list its terminals); try again.'}});
  assert.equal(sent('reconnect').length,0);
  // alive: its own pane, as before
  live='alive';
  assert.equal((await post(home.port,'reconnect',{chatId:X})).body.mm.tmuxName,'mm-claude-22222222');
  // the plan's own chat still goes through the daemon's reconnect
  assert.equal((await post(home.port,'reconnect',{chatId:first.id})).body.mm.tmuxName,'mm-claude-11111111');
  assert.equal(sent('reconnect').length,1);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});

test('review round 1, Q3 · a chat of the workspace whose terminals the daemon cannot list is unknown, never ended; one whose terminal the workspace no longer has is ended there',{timeout:30000},async()=>{
 const dir=fixture();let list=true,terminals=[term('mm-claude-11111111',{sessionId:SID}),term('mm-claude-22222222')];
 const ws=()=>list?{projects:[{projectDir:'/x',workspaces:[{id:'w-0a1b2c3d',title:'Crews',terminals}]}],prefs:{}}:null;
 const mm=await stubDaemon(HOLDER,{new:NEW_OK,reconnect:{status:200,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-11111111',url:'u'}}},ws);
 const home=await startHome(dir,mm.url);
 try{
  const nw=await post(home.port,'new',{where:'here',provider:'claude'});connected(dir);
  list=false;
  assert.deepEqual(await post(home.port,'reconnect',{chatId:nw.body.chatId}),{status:409,body:{error:'Cannot tell whether mm-claude-22222222 is running (Manager Marcus could not list its terminals); try again.'}});
  list=true;terminals=[term('mm-claude-11111111',{sessionId:SID})];
  const gone=await post(home.port,'reconnect',{chatId:nw.body.chatId});
  assert.match(gone.body.error,/^No session to go to; the last one ended .* in Crews \(terminal mm-claude-22222222\)\.$/);
  assert.equal(mm.posts().filter(p=>p.url.endsWith('/reconnect')).length,0);
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});


test('review round 2, Q8 · a resume the daemon could not confirm is a resume that happened: the home says so, with the pane, and a second press shows the daemon\'s refusal verbatim',{timeout:30000},async()=>{
 const dir=fixture();
 const ws={projects:[{projectDir:'/x',workspaces:[{id:'w-0a1b2c3d',title:'Crews',terminals:[term('mm-claude-11111111',{sessionId:SID}),term('mm-claude-22222222',{liveness:'ended'})]}]}],prefs:{}};
 const url='http://localhost:5173/#/w/w-0a1b2c3d/terminals?pane=mm-claude-22222222';
 let resume={status:202,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url,confirmed:false,note:'its screen was not recognised within 30 s; look at its pane'}};
 const mm=await stubDaemon(HOLDER,{new:NEW_OK,resume:(body)=>typeof resume==='function'?resume(body):resume},ws);
 const home=await startHome(dir,mm.url);
 try{
  const nw=await post(home.port,'new',{where:'here',provider:'claude'});connected(dir);
  const rs=await post(home.port,'resume',{chatId:nw.body.chatId,where:'here'});
  assert.deepEqual(rs,{status:200,body:{ok:true,confirmed:false,message:'Session resumed in Crews; its screen was not recognised yet, look at its pane.',mm:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url}}});
  // a confirmed one reads as before, with no such field
  resume={status:202,body:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url}};
  assert.deepEqual(await post(home.port,'resume',{chatId:nw.body.chatId,where:'here'}),{status:200,body:{ok:true,message:'Session resumed in Crews. Waiting for it to listen to this plan.',mm:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url}}});
  // the second press on the unconfirmed one: the daemon's live-elsewhere refusal, as it came
  resume={status:409,body:{error:'the session 22222222-2222-3333-4444-555555555555 is live elsewhere: it runs in the terminal mm-claude-22222222 in this workspace. Two writers on one transcript corrupt it, so it was not resumed'}};
  assert.deepEqual(await post(home.port,'resume',{chatId:nw.body.chatId,where:'here'}),{status:409,body:{error:resume.body.error}});
  // a resume whose answer came late (pending, then asked about by its request id) says the same once the daemon answers it unconfirmed
  resume=(body)=>body.replay?{status:200,body:{replay:true,requestId:body.requestId,state:'done',status:202,answer:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url,confirmed:false,note:'its screen was not recognised within 30 s; look at its pane'}}}:{status:202,body:{pending:true,requestId:body.requestId}};
  assert.match((await post(home.port,'resume',{chatId:nw.body.chatId,where:'here'})).body.error,/^Manager Marcus is still starting it;/);
  assert.deepEqual(await post(home.port,'resume',{chatId:nw.body.chatId,where:'here'}),{status:200,body:{ok:true,confirmed:false,message:'Session resumed in its Manager Marcus workspace; its screen was not recognised yet, look at its pane.',mm:{workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-22222222',url}}});
 }finally{await home.stop();await mm.close();rmSync(dir,{recursive:true,force:true});}
});
