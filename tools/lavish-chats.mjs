// Per-plan chat identities and active feedback ownership. Shared by the home, poll and editor.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
const root=()=>process.env.LAVISH_AXI_STATE_DIR||join(homedir(),'.lavish-axi');
const pathOf=key=>{if(!/^[a-f0-9]{16}$/.test(key))throw new Error('Invalid plan id');return join(root(),'chats',key+'.json');};
const empty=()=>({version:1,activeChatId:'',generation:'',chats:{},launch:null});
const stamp=()=>new Date().toISOString();
const identity=a=>a?.id?`${a.provider==='codex'?'codex':'claude'}:${a.id}`:'';
function load(path,fallback){try{return JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function readChats(key){return load(pathOf(key),empty());}
function lockPlan(key){
 const path=pathOf(key);mkdirSync(dirname(path),{recursive:true});const lock=path+'.lock';
 try{writeFileSync(lock,String(process.pid),{flag:'wx'});}catch(e){
  if(e.code!=='EEXIST')throw e;
  const pid=Number(readFileSync(lock,'utf8'));let alive=true;
  if(pid>0){try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}}
  if(alive)throw new Error('Chat is being updated. Try again.');
  unlinkSync(lock);writeFileSync(lock,String(process.pid),{flag:'wx'});
 }
 return ()=>unlinkSync(lock);
}
export async function withChatLock(key,fn){const release=lockPlan(key);try{return await fn();}finally{release();}}
function assertNoPending(key){const s=load(join(root(),'state.json'),{}).sessions?.[key];if(s?.prompts?.length)throw new Error('Pending feedback must be received before switching chats.');}
function mutate(key,fn){
 const path=pathOf(key);const release=lockPlan(key);
 try{const data=readChats(key);const result=fn(data);const tmp=path+'.tmp-'+process.pid;writeFileSync(tmp,JSON.stringify(data,null,2));renameSync(tmp,path);return result;}
 finally{release();}
}
function add(data,agent,id=identity(agent)){
 if(!id)return null;
 const prev=data.chats[id]||{id,createdAt:stamp(),title:agent?.name||`Chat ${Object.keys(data.chats).length+1}`,agent:{}};
 prev.agent={...prev.agent,...Object.fromEntries(Object.entries(agent||{}).filter(([,v])=>v!==undefined&&v!==''))};
 data.chats[id]=prev;return prev;
}
export function ensureChats(key,reg={},messages=[]){
 if(existsSync(pathOf(key)))return readChats(key);
 return mutate(key,d=>{
  for(const a of [...(reg.agents||[]),reg.agent,...messages.map(m=>m.agent)].filter(Boolean))add(d,a);
  if(messages.some(m=>!m.agent?.id&&!m.chatId))d.chats.legacy={id:'legacy',title:'Earlier conversation',agent:{},createdAt:messages[0]?.at||stamp()};
  d.activeChatId=identity(reg.agent);d.generation=randomUUID();return d;
 });
}
export function selectChat(key,agentOrId){return mutate(key,d=>{
 if(d.launch)throw new Error('A chat is already starting. Wait for it to connect.');
 const chat=typeof agentOrId==='string'?d.chats[agentOrId]:add(d,agentOrId);
 if(!chat?.agent?.id)throw new Error('This chat has no resumable session');
 if(d.activeChatId!==chat.id){assertNoPending(key);d.activeChatId=chat.id;d.generation=randomUUID();}
 chat.selectedAt=stamp();return {chatId:chat.id,generation:d.generation};
});}
export function claimChat(key,agent,requested=''){
 if(!agent?.id)throw new Error('Could not identify this agent session. Run from the working agent.');
 return mutate(key,d=>{
  let chat=requested?d.chats[requested]:Object.values(d.chats).find(c=>identity(c.agent)===identity(agent));
  if(requested&&(!chat||chat.agent.provider!==agent.provider||(chat.agent.id&&chat.agent.id!==agent.id)))throw new Error('Session does not match the requested chat');
  if(d.launch&&d.launch.id!==requested)throw new Error('Another chat is starting; this session is no longer connected to the plan');
  if(!chat)chat=add(d,agent);
  if(d.activeChatId&&d.activeChatId!==chat.id)throw new Error('Another chat is active. Resume this chat from Lavish to reconnect.');
  if(!d.activeChatId){d.activeChatId=chat.id;d.generation=randomUUID();}
  chat.agent={...chat.agent,...Object.fromEntries(Object.entries(agent).filter(([,v])=>v!==undefined&&v!==''))};
  chat.lastSeenAt=stamp();chat.error='';
  if(d.launch?.id===chat.id)d.launch=null;
  return {chatId:chat.id,generation:d.generation};
 });
}
export function mayDeliver(key,owner={}){
 const d=readChats(key);
 if(!d.activeChatId&&!d.launch)return true; // Unmanaged legacy plans remain compatible.
 return !d.launch&&Boolean(owner.chatId)&&owner.chatId===d.activeChatId&&owner.generation===d.generation;
}
export function currentOwner(key){const d=readChats(key);return {chatId:d.activeChatId||'legacy',generation:d.generation};}
export function reserveLaunch(key,{provider,model,effort}={}){return mutate(key,d=>{
 if(d.launch)throw new Error('A chat is already starting. Reconnect it before starting another.');
 assertNoPending(key);const id=randomUUID();const prev={activeChatId:d.activeChatId,generation:d.generation};
 d.chats[id]={id,title:`Chat ${Object.values(d.chats).filter(c=>c.id!=='legacy').length+1}`,createdAt:stamp(),agent:{provider:provider==='codex'?'codex':'claude',model:model||'',effort:effort||''}};
 d.activeChatId=id;d.generation=randomUUID();d.launch={id,previous:prev,at:stamp(),state:'starting'};return d.chats[id];
});}
export function markLaunched(key,id,result){return mutate(key,d=>{
 const chat=d.chats[id];if(!chat)throw new Error('Unknown chat');
 chat.tmuxName=result.tmuxName||chat.tmuxName||'';
 if(result.agent)chat.agent={...chat.agent,...result.agent};
 if(result.mmWorkspace)chat.mmWorkspace=String(result.mmWorkspace); // the Manager Marcus workspace whose terminal runs this chat (phase 12): where it is looked for from then on
 if(d.launch?.id===id)d.launch.state='waiting';
 return chat;
});}
/** Manager Marcus did not answer a delegated start within the home's bound: the reservation stays, marked uncertain with its request id, until the daemon says (phase 12, fix round 2, contract 3). */
export function markUncertain(key,id,{requestId}={}){return mutate(key,d=>{
 if(d.launch?.id===id){d.launch.mm=true;d.launch.state='uncertain';d.launch.requestId=requestId||id;d.launch.uncertainAt=stamp();}
 return d;
});}
/** A launch delegated to Manager Marcus, marked when it is reserved: the home cannot see its terminal, so no local rule may expire it (phase 12, fix round 3). */
export function markDelegated(key,id,{requestId}={}){return mutate(key,d=>{
 if(d.launch?.id===id){d.launch.mm=true;d.launch.requestId=requestId||id;}
 return d;
});}
/** Where the New chat chooser last started a chat of this plan: "here" (the plan's Manager Marcus workspace) or "terminal" (Terminal.app). One writer, the home's new action, so the choice has one owner (phase 12, D7). */
export function rememberWhere(key,where){
 if(where!=='here'&&where!=='terminal')return;
 return mutate(key,d=>{d.newChatWhere=where;return d;});
}
export function failLaunch(key,id,error){return mutate(key,d=>{
 if(d.chats[id])d.chats[id].error=String(error);
 if(d.launch?.id===id){Object.assign(d,d.launch.previous);d.launch=null;}
 return d;
});}
export function listeningState(d,now=Date.now()){
 const c=d.chats[d.activeChatId];if(d.launch)return d.launch.state==='starting'?'starting':'waiting for agent';
 if(!c)return 'not connected';if(c.error)return 'failed';
 return c.listeningAt&&now-Date.parse(c.listeningAt)<20000?'listening':'disconnected';
}
export function heartbeat(key,owner){return mutate(key,d=>{if(!d.launch&&d.activeChatId===owner.chatId&&d.generation===owner.generation){d.chats[owner.chatId].listeningAt=stamp();return true;}return false;});}
export function stopListening(key,owner){return mutate(key,d=>{if(d.activeChatId===owner.chatId&&d.generation===owner.generation&&d.chats[owner.chatId])d.chats[owner.chatId].listeningAt='';});}
export function groupMessages(d,messages){
 const out=Object.fromEntries(Object.keys(d.chats).map(id=>[id,[]]));
 for(const m of messages){
  let id=m.chatId;
  if(!id&&m.agent?.id)id=Object.values(d.chats).find(c=>identity(c.agent)===identity(m.agent))?.id;
  id=id||'legacy';(out[id]??=[]).push(m);
 }
 return out;
}
export function extractLinks(texts){
 const links=new Map();
 for(const text of texts)for(const match of String(text||'').matchAll(/https:\/\/[^\s<>"'`]+/g)){
  let u;try{u=new URL(match[0].replace(/[),.;\]}]+$/g,''));}catch{continue;}
  if(u.username||u.password)continue;
  const pr=u.hostname==='github.com'&&/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(u.pathname);
  const deploy=u.hostname==='vercel.com'||u.hostname.endsWith('.vercel.app');
  if(!pr&&!deploy)continue;
  u.hash=''; const url=u.href;links.set(url,{kind:pr?'pr':'deployment',url,label:pr?u.pathname.slice(1).replace('/pull/',' #'):u.hostname+u.pathname});
 }
 return [...links.values()];
}
/** Each deployment link tagged `pr` (that PR's link url) when a PR's own links (its body, comments, checks) carry it; the first PR given wins a link several carry. */
export function ownLinks(links,prs){
 const owner=new Map();
 for(const p of prs){const pr=extractLinks([p.url])[0];if(pr&&pr.kind==='pr')for(const l of p.links||[])if(l.kind==='deployment'&&!owner.has(l.url))owner.set(l.url,pr.url);}
 return links.map(l=>l.kind==='deployment'&&owner.has(l.url)?{...l,pr:owner.get(l.url)}:l);
}
