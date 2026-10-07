// The conversation panel's logic (phase 12, D7 / package P6): which verbs are offered, what each one sends, the
// listening line that names the place, and what follows an answer that carries `mm`. The file is a browser script;
// its logic block is pure and is read here from the same file the editor and the home serve, with no document.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const src=readFileSync(fileURLToPath(new URL('../chat-panel.client.js',import.meta.url)),'utf8');
function load(){
 const ctx={document:{getElementById:()=>null,querySelector:()=>null},location:{pathname:'/',origin:'http://127.0.0.1:1'},console,URL};
 ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(src,ctx);
 return ctx.__lavishChatLogic;
}
const L=load();
const plain=v=>JSON.parse(JSON.stringify(v));
const SID='11111111-2222-3333-4444-555555555555';
const chat=(over={})=>({id:'claude:'+SID,title:'Chat 1',agent:{provider:'claude',id:SID},model:'claude-fable-5-1',modelName:'Fable 5.1',place:{state:'ended',where:'a terminal',endedAt:'2026-10-03T10:42:00.000Z'},messages:[],...over});
const MM={workspace:{id:'w-0a1b2c3d',title:'Crews'},flow:'draft',session:{provider:'claude',sessionId:SID},terminal:{tmuxName:'mm-claude-11111111',alive:true},pane:2,panes:{'mm-shell-aaaaaaaa':1,'mm-claude-11111111':2}};
const data=(over={})=>({activeChatId:'claude:'+SID,connection:'disconnected',launch:null,resumePending:false,mm:null,where:'',chats:[chat()],models:{claude:{models:[{id:'fable',name:'Fable 5.1'}],efforts:[{id:'high',name:'High'}]},codex:{models:[],efforts:[]}},cwd:'/p',...over});
const NOW=new Date('2026-10-03T12:00:00.000Z');
const hm=iso=>{const d=new Date(iso);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};

test('the logic block loads without a document and the panel does not start',()=>{
 assert.equal(typeof L.verbs,'function');assert.equal(typeof L.line,'function');assert.equal(typeof L.request,'function');assert.equal(typeof L.after,'function');
});

test('the listening line names the place: a workspace pane, another app, or where and when it ended',()=>{
 assert.equal(L.line(data({connection:'listening',mm:MM}),NOW),'listening · in Crews · pane 2');
 assert.equal(L.line(data({connection:'disconnected',mm:MM}),NOW),'running in Crews · pane 2 · not listening');
 assert.equal(L.line(data({connection:'disconnected',chats:[chat({place:{state:'active',where:'VS Code',endedAt:''}})]}),NOW),'running in VS Code · not listening');
 assert.equal(L.line(data({connection:'listening',chats:[chat({place:{state:'active',where:'VS Code',endedAt:''}})]}),NOW),'listening · in VS Code');
 assert.equal(L.line(data({chats:[chat({place:{state:'ended',where:'Terminal.app',endedAt:'2026-10-03T10:42:00.000Z'}})]}),NOW),`ended ${hm('2026-10-03T10:42:00.000Z')} · in Terminal.app`);
 // another day carries the date; an unknown time is left out, never invented
 assert.match(L.line(data({chats:[chat({place:{state:'ended',where:'VS Code',endedAt:'2026-09-28T10:42:00.000Z'}})]}),NOW),/^ended 28 Sep \d\d:\d\d · in VS Code$/);
 assert.equal(L.line(data({chats:[chat({place:{state:'ended',where:'VS Code',endedAt:''}})]}),NOW),'ended · in VS Code');
 // the plan's pane in the workspace has ended: the daemon's word, with the workspace as the place
 assert.equal(L.line(data({mm:{...MM,terminal:{tmuxName:'mm-claude-11111111',alive:false}}}),NOW),`ended ${hm('2026-10-03T10:42:00.000Z')} · in Crews · pane 2`);
 // a chat the workspace started (its terminal is in the workspace's list) is placed there even when the plan's session is another
 assert.equal(L.line(data({connection:'listening',mm:{...MM,session:{provider:'claude',sessionId:'other'},terminal:null,pane:null},chats:[chat({tmuxName:'mm-shell-aaaaaaaa',place:{state:'active',where:'a terminal',endedAt:''}})]}),NOW),'listening · in Crews · pane 1');
 assert.equal(L.line(data({activeChatId:'',chats:[]}),NOW),'not connected');
 assert.equal(L.line(data({launch:{id:'x',state:'starting',mm:false}}),NOW),'starting…');
 assert.equal(L.line(data({launch:{id:'x',state:'waiting',mm:true},mm:MM}),NOW),'waiting for agent · in Crews');
});

test('an uncertain launch or resume reads "Manager Marcus is still starting it…" and keeps Go to session, Resume here and New chat off with that reason',()=>{
 for(const d of [data({mm:MM,launch:{id:'x',state:'uncertain',mm:true}}),data({mm:MM,resumePending:true})]){
  assert.equal(L.line(d,NOW),'Manager Marcus is still starting it…');
  const v=Object.fromEntries(L.verbs(d,d.activeChatId).map(x=>[x.id,x]));
  for(const id of ['goto','resumeHere','new']){assert.equal(v[id].disabled,true,id);assert.equal(v[id].reason,'Manager Marcus is still starting it…',id);}
  assert.equal(v.resumeTerminal.disabled,false);
 }
});

test('the four verbs: Resume here only when a workspace holds the plan; with none the resume button is Resume in Terminal.app alone',()=>{
 const held=L.verbs(data({mm:MM}),'claude:'+SID);
 assert.deepEqual(plain(held.map(v=>[v.id,v.label,v.show,v.disabled])),[['goto','Go to session',true,false],['resumeHere','Resume here',true,false],['resumeTerminal','Resume in Terminal.app',true,false],['new','New chat…',true,false]]);
 const free=L.verbs(data(),'claude:'+SID);
 assert.deepEqual(plain(free.map(v=>[v.id,v.label,v.show])),[['goto','Go to session',true],['resumeHere','Resume here',false],['resumeTerminal','Resume in Terminal.app',true],['new','New chat…',true]]);
 // the verb that fits what is known is the marked one: alive → Go to session; ended and held → Resume here; ended, not held → Resume in Terminal.app
 const primary=d=>L.verbs(d,d.activeChatId).filter(v=>v.primary).map(v=>v.id);
 assert.deepEqual(plain(primary(data({mm:MM}))),['goto']);
 assert.deepEqual(plain(primary(data({mm:{...MM,terminal:{tmuxName:'mm-claude-11111111',alive:false}}}))),['resumeHere']);
 assert.deepEqual(plain(primary(data())),['resumeTerminal']);
 assert.deepEqual(plain(primary(data({chats:[chat({place:{state:'active',where:'VS Code',endedAt:''}})]}))),['goto']);
 // a chat the workspace started is alive when Manager Marcus says its own terminal is, whatever the home can see of it; a session that is listening runs
 const started=over=>data({mm:{...MM,session:{provider:'claude',sessionId:'other'},terminal:{tmuxName:'mm-claude-99999999',alive:true},panes:{'mm-claude-99999999':1,'mm-claude-22222222':2},alive:{'mm-claude-99999999':true,'mm-claude-22222222':true},...over},chats:[chat({tmuxName:'mm-claude-22222222'})]});
 assert.deepEqual(plain(primary(started({}))),['goto']);
 assert.equal(L.line(started({}),NOW),'running in Crews · pane 2 · not listening');
 assert.deepEqual(plain(primary(started({alive:{'mm-claude-99999999':true,'mm-claude-22222222':false}}))),['resumeHere']);
 assert.match(L.line(started({alive:{'mm-claude-99999999':true,'mm-claude-22222222':false}}),NOW),/^ended .* · in Crews · pane 2$/);
 assert.deepEqual(plain(primary({...started({alive:{}}),connection:'listening'})),['goto']);
 // no chat chosen: only New chat can act; a launch under way: no second New chat
 const none=Object.fromEntries(L.verbs(data({activeChatId:'',chats:[]}),'').map(x=>[x.id,x]));
 assert.equal(none.goto.disabled,true);assert.equal(none.goto.reason,'Choose a saved chat first.');assert.equal(none.resumeTerminal.disabled,true);assert.equal(none.new.disabled,false);
 const launching=Object.fromEntries(L.verbs(data({launch:{id:'x',state:'waiting',mm:false}}),'claude:'+SID).map(x=>[x.id,x]));
 assert.equal(launching.new.disabled,true);assert.equal(launching.new.reason,'A chat is already starting.');assert.equal(launching.goto.disabled,false);
});

test('what each verb sends: the home\'s three actions, with where said out loud',()=>{
 const form={provider:'claude',model:'fable',effort:'high',cwd:'/p',where:'here'};
 assert.deepEqual(plain(L.request('goto','c1',form)),{action:'reconnect',body:{chatId:'c1'}});
 assert.deepEqual(plain(L.request('resumeHere','c1',form)),{action:'resume',body:{chatId:'c1',where:'here'}});
 assert.deepEqual(plain(L.request('resumeTerminal','c1',form)),{action:'resume',body:{chatId:'c1',where:'terminal'}});
 assert.deepEqual(plain(L.request('new','c1',form)),{action:'new',body:{chatId:'c1',where:'here',provider:'claude',model:'fable',effort:'high',cwd:'/p'}});
 assert.deepEqual(plain(L.request('new','c1',{...form,where:'terminal'})).body.where,'terminal');
 assert.equal(L.request('nonsense','c1',form),null);
});

test('the chooser: the remembered choice when it can be honoured, here when a workspace holds the plan, Terminal.app when none does',()=>{
 assert.equal(L.chooserWhere(data({mm:MM,where:'terminal'})),'terminal');
 assert.equal(L.chooserWhere(data({mm:MM,where:'here'})),'here');
 assert.equal(L.chooserWhere(data({mm:MM,where:''})),'here');
 assert.equal(L.chooserWhere(data({mm:null,where:'here'})),'terminal');
 assert.equal(L.chooserWhere(data({mm:null,where:''})),'terminal');
});

test('after an answer with mm: framed in the Manager Marcus page the pane is focused by message; in a tab the url is a link; with no url a notice names the pane',()=>{
 const mm={workspaceId:'w-0a1b2c3d',tmuxName:'mm-claude-11111111',url:'http://localhost:5173/#/w/w-0a1b2c3d/terminals?pane=mm-claude-11111111'};
 assert.deepEqual(plain(L.after({ok:true,mm},{framed:true,pageOrigin:'http://localhost:5173'})),{kind:'focus',message:{type:'lavish:focus',tmuxName:'mm-claude-11111111'},target:'http://localhost:5173'});
 assert.deepEqual(plain(L.after({ok:true,mm},{framed:false,pageOrigin:''})),{kind:'link',url:mm.url});
 // framed by something that is not a local page: never a message to it
 assert.deepEqual(plain(L.after({ok:true,mm},{framed:true,pageOrigin:''})),{kind:'link',url:mm.url});
 // an adopted launch carries no url (the correction): focus when framed, a notice naming the pane in a tab
 assert.deepEqual(plain(L.after({ok:true,mm:{...mm,url:null}},{framed:true,pageOrigin:'http://localhost:5173'})),{kind:'focus',message:{type:'lavish:focus',tmuxName:'mm-claude-11111111'},target:'http://localhost:5173'});
 assert.deepEqual(plain(L.after({ok:true,mm:{...mm,url:null}},{framed:false,pageOrigin:''})),{kind:'notice',text:'It is in the pane mm-claude-11111111 of its Manager Marcus workspace.'});
 assert.deepEqual(plain(L.after({ok:true,message:'x'},{framed:true,pageOrigin:'http://localhost:5173'})),{kind:'none'});
 // a url that is not an http(s) link, or a pane name that is not one of Manager Marcus's, is never used
 assert.deepEqual(plain(L.after({ok:true,mm:{...mm,url:'javascript:alert(1)'}},{framed:false,pageOrigin:''})),{kind:'notice',text:'It is in the pane mm-claude-11111111 of its Manager Marcus workspace.'});
 assert.deepEqual(plain(L.after({ok:true,mm:{...mm,tmuxName:'x; rm'}},{framed:true,pageOrigin:'http://localhost:5173'})),{kind:'none'});
});

test('the page origin a framed panel may post to: the frame\'s parent, only when it is a loopback page',()=>{
 assert.equal(L.pageOrigin(['http://localhost:5173'],'http://127.0.0.1:6306/x'),'http://localhost:5173');
 assert.equal(L.pageOrigin([],'http://127.0.0.1:6308/#/w/w-1/review'),'http://127.0.0.1:6308');
 assert.equal(L.pageOrigin(null,'http://localhost:5173/'),'http://localhost:5173');
 assert.equal(L.pageOrigin(['https://evil.example'],'http://localhost:5173/'),'');
 assert.equal(L.pageOrigin([],'https://evil.example/'),'');
 assert.equal(L.pageOrigin([],'http://localhost.evil.example:5173/'),'');
 assert.equal(L.pageOrigin([],'http://127.0.0.1:5173@evil.example/'),'');
 assert.equal(L.pageOrigin([],''),'');
 assert.equal(L.pageOrigin([],'not a url'),'');
});

test('a saved chat on one line, and a model as its display name with its id small',()=>{
 assert.deepEqual(plain(L.chatLine(chat(),data())),{title:'Chat 1',meta:'claude · Fable 5.1',state:'active'});
 assert.deepEqual(plain(L.chatLine(chat({id:'legacy',title:'Earlier conversation',agent:{},model:'',modelName:''}),data())),{title:'Earlier conversation',meta:'unattributed',state:'saved'});
 assert.deepEqual(plain(L.modelOptions(data(),'claude')),[{value:'',name:'Provider default',small:''},{value:'fable',name:'Fable 5.1',small:'fable'}]);
 assert.deepEqual(plain(L.effortOptions(data(),'claude')),[{value:'',name:'Default',small:''},{value:'high',name:'High',small:'high'}]);
 assert.deepEqual(plain(L.modelOptions(data(),'codex')),[{value:'',name:'Provider default',small:''}]);
});

test('review round 1, Q6 · a pane Manager Marcus cannot vouch for is unknown: the line says so, neither Resume nor Go is offered, and it is never called ended',()=>{
 const UNKNOWN='cannot tell whether it is running (Manager Marcus could not list its terminals)';
 const cases={
  'the plan\'s own pane, alive: null':data({mm:{...MM,terminal:{tmuxName:'mm-claude-11111111',alive:null},alive:{'mm-claude-11111111':null},listed:true}}),
  'a workspace chat whose terminal is listed as unknown':data({mm:{...MM,session:{provider:'claude',sessionId:'other'},terminal:{tmuxName:'mm-claude-99999999',alive:true},panes:{'mm-claude-99999999':1,'mm-claude-22222222':2},alive:{'mm-claude-99999999':true,'mm-claude-22222222':null},listed:true},chats:[chat({tmuxName:'mm-claude-22222222',mmWorkspace:'w-0a1b2c3d'})]}),
  'a workspace chat while the daemon could not list its terminals at all':data({mm:{...MM,session:{provider:'claude',sessionId:'other'},terminal:null,pane:null,panes:{},alive:{},listed:false},chats:[chat({tmuxName:'mm-claude-22222222',mmWorkspace:'w-0a1b2c3d'})]}),
 };
 for(const [name,d] of Object.entries(cases)){
  assert.equal(L.line(d,NOW),UNKNOWN,name);
  const v=Object.fromEntries(L.verbs(d,d.activeChatId).map(x=>[x.id,x]));
  for(const id of ['goto','resumeHere','resumeTerminal']){assert.equal(v[id].disabled,true,name+' '+id);assert.equal(v[id].reason,UNKNOWN,name+' '+id);assert.equal(v[id].primary,false,name+' '+id);}
  assert.equal(v.new.disabled,false,name);
  // it resolves on the next answer: listed alive, or listed ended
  const name2=d.chats[0].tmuxName||'mm-claude-11111111';
  const settle=alive=>({...d,mm:{...d.mm,terminal:d.mm.terminal&&d.mm.terminal.tmuxName===name2?{...d.mm.terminal,alive}:d.mm.terminal,panes:{...d.mm.panes,[name2]:d.mm.panes[name2]||2},alive:{...d.mm.alive,[name2]:alive},listed:true}});
  assert.match(L.line(settle(true),NOW),/^running in Crews · pane \d · not listening$/,name);
  assert.match(L.line(settle(false),NOW),/^ended .* · in Crews · pane \d$/,name);
  assert.deepEqual(plain(L.verbs(settle(false),d.activeChatId).filter(x=>x.primary).map(x=>x.id)),['resumeHere'],name);
 }
 // a session that is listening runs, whatever the listing says
 assert.equal(L.line({...cases['the plan\'s own pane, alive: null'],connection:'listening'},NOW),'listening · in Crews · pane 2');
 // a chat of the workspace whose terminal the workspace no longer lists has ended there
 const removed=data({mm:{...MM,session:{provider:'claude',sessionId:'other'},terminal:null,pane:null,panes:{'mm-claude-99999999':1},alive:{'mm-claude-99999999':true},listed:true},chats:[chat({tmuxName:'mm-claude-22222222',mmWorkspace:'w-0a1b2c3d'})]});
 assert.match(L.line(removed,NOW),/^ended .* · in Crews$/);
 // an answer of an older home (no alive map, no listed) reads as before: the home's own knowledge of the chat
 assert.match(L.line(data({mm:{...MM,session:{provider:'claude',sessionId:'other'},terminal:null,pane:null,panes:{'mm-claude-22222222':2}},chats:[chat({tmuxName:'mm-claude-22222222'})]}),NOW),/^ended .* · in Crews · pane 2$/);
});


test('the links block: folded to a header with one toggle; open, each PR with the Vercel links the home tied to it, whatever order they came in',()=>{
 const PR1='https://github.com/acme/app/pull/1',PR2='https://github.com/acme/app/pull/2';
 const links=[
  {kind:'pr',url:PR1,label:'acme/app #1'},
  {kind:'deployment',url:'https://app-git-two.vercel.app/',label:'app-git-two.vercel.app/',pr:PR2}, // PR 2's preview, listed before PR 2 and after PR 1
  {kind:'deployment',url:'https://vercel.com/acme/app/one',label:'vercel.com/acme/app/one',pr:PR1},
  {kind:'pr',url:PR2,label:'acme/app #2'},
  {kind:'deployment',url:'https://vercel.com/plan-only',label:'vercel.com/plan-only'}, // mentioned in the plan only
 ];
 const g=L.linkGroups(links);
 assert.deepEqual(plain(g.prs.map(x=>[x.pr.url,x.deployments.map(d=>d.label)])),[[PR1,['vercel.com/acme/app/one']],[PR2,['app-git-two.vercel.app/']]]);
 assert.deepEqual(plain(g.other.map(d=>d.label)),['vercel.com/plan-only']);
 assert.equal(g.header,'Pull requests · 2 · 3 Vercel links');
 assert.equal(L.linkGroups([links[0]]).header,'Pull requests · 1');
 assert.equal(L.linkGroups([links[4]]).header,'Links · 1 Vercel link');
 // folded (the default): the header and "Expand all", no link at all
 const folded=L.linksBlock(links,false);
 assert.match(folded,/<span>Pull requests · 2 · 3 Vercel links<\/span><button type="button" data-links-toggle aria-expanded="false">Expand all<\/button>/);
 assert.doesNotMatch(folded,/<a /);
 // open: "Collapse all", each PR link first with its own Vercel links indented under it, the untied one last; text, href and target as before
 const open=L.linksBlock(links,true);
 assert.match(open,/aria-expanded="true">Collapse all</);
 const groups=open.split('<div class="lc-link-group">').slice(1);
 assert.equal(groups.length,3);
 assert.match(groups[0],/^<a href="https:\/\/github\.com\/acme\/app\/pull\/1" target="_blank" rel="noopener">PR · acme\/app #1<\/a><div class="lc-link-sub"><a href="https:\/\/vercel\.com\/acme\/app\/one" target="_blank" rel="noopener">Vercel · vercel\.com\/acme\/app\/one<\/a><\/div>/);
 assert.match(groups[1],/^<a href="https:\/\/github\.com\/acme\/app\/pull\/2"[^>]*>PR · acme\/app #2<\/a><div class="lc-link-sub"><a href="https:\/\/app-git-two\.vercel\.app\/"[^>]*>Vercel · app-git-two\.vercel\.app\/<\/a><\/div>/);
 assert.match(groups[2],/^<a href="https:\/\/vercel\.com\/plan-only"[^>]*>Vercel · vercel\.com\/plan-only<\/a><\/div>/);
 assert.equal(L.linksBlock([],false),'');assert.equal(L.linksBlock(undefined,true),'');
});
