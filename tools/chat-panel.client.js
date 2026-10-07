/* Shared saved-chat controls for the home page and the editor conversation. */
/* The logic, pure (no document): which verbs are offered, what each one sends, the line that names the place, what
   follows an answer. test/chat-panel.test.mjs reads this block from this same file. Every refusal a press can get is
   the home's or Manager Marcus's own sentence, shown as it came; nothing here decides whether a session runs. */
const LavishChatLogic=(function(){
 const STILL='Manager Marcus is still starting it…';
 const UNKNOWN='cannot tell whether it is running (Manager Marcus could not list its terminals)';
 const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 const PANE=/^mm-(claude|codex|shell)-[0-9a-f]{8}$/;
 const LOOPBACK_PAGE=/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
 const two=n=>String(n).padStart(2,'0');
 /** "10:42" for today, "28 Sep 10:42" for another day, "" when nothing recorded it. */
 function timeWords(iso,now){
  const t=Date.parse(iso||'');if(!Number.isFinite(t))return '';
  const d=new Date(t),hm=two(d.getHours())+':'+two(d.getMinutes());
  return d.toDateString()===(now||new Date()).toDateString()?hm:d.getDate()+' '+MONTHS[d.getMonth()]+' '+hm;
 }
 const chatOf=(data,id)=>(data&&data.chats||[]).find(c=>c.id===id)||null;
 const uncertain=data=>Boolean(data&&((data.launch&&data.launch.state==='uncertain')||data.resumePending));
 /**
  * Where a chat's session is or was: its pane in the plan's workspace when Manager Marcus runs it there, else what the
  * home knows. Whether a workspace pane runs is Manager Marcus's to say, in three states: `alive` true or false is its
  * word; `unknown` is its saying it cannot tell (its own listing failed, or the workspace's terminals could not be
  * read): then nothing is assumed, least of all an end. With no word at all (an older home's answer) the home's own
  * knowledge of the chat stands.
  */
 function placeOf(data,chat){
  const mm=data&&data.mm;
  if(mm&&chat){
   const panes=mm.panes||{},alive=mm.alive||{};
   const plans=Boolean(mm.terminal&&mm.session&&chat.agent&&mm.session.sessionId===chat.agent.id);
   const own=Boolean(chat.tmuxName&&(panes[chat.tmuxName]||chat.mmWorkspace===mm.workspace.id));
   const name=own?chat.tmuxName:plans?mm.terminal.tmuxName:'';
   if(name){
    const n=panes[name]||null;
    let state; // true, false, null (the daemon cannot tell), undefined (it said nothing)
    if(mm.terminal&&mm.terminal.tmuxName===name)state=mm.terminal.alive===true?true:mm.terminal.alive===false?false:null;
    else if(Object.prototype.hasOwnProperty.call(alive,name))state=alive[name]===true?true:alive[name]===false?false:null;
    else if(mm.listed===false)state=null;
    else if(mm.listed===true)state=false; // a chat of this workspace whose terminal the workspace no longer lists
    return {workspace:true,tmuxName:name,pane:n,alive:state===undefined?null:state,unknown:state===null,text:'in '+mm.workspace.title+(n?' · pane '+n:'')};
   }
  }
  const where=chat&&chat.place&&chat.place.where||'';
  return {workspace:false,tmuxName:'',pane:null,alive:null,unknown:false,text:where?'in '+where:''};
 }
 const listening=(data,chat)=>Boolean(chat&&chat.id===data.activeChatId&&data.connection==='listening'); // a session that listens to the plan runs
 function aliveOf(data,chat){
  if(!chat)return false;
  if(listening(data,chat))return true;
  const p=placeOf(data,chat);
  if(p.unknown)return false;
  return p.workspace&&p.alive!==null?p.alive===true:Boolean(chat.place&&chat.place.state==='active');
 }
 /** Manager Marcus runs this chat's pane and cannot say whether it runs: neither running nor ended. */
 const unknownOf=(data,chat)=>Boolean(chat)&&!listening(data,chat)&&placeOf(data,chat).unknown;
 /** The listening line, for the active chat: "listening · in <workspace> · pane <n>", "running in VS Code · not listening", "ended 10:42 · in Terminal.app". */
 function line(data,now){
  if(!data)return '';
  if(uncertain(data))return STILL;
  if(data.launch)return data.launch.state==='starting'?'starting…':'waiting for agent'+(data.launch.mm&&data.mm?' · in '+data.mm.workspace.title:'');
  const chat=chatOf(data,data.activeChatId);
  if(!chat)return 'not connected';
  const p=placeOf(data,chat);
  if(data.connection==='listening')return 'listening'+(p.text?' · '+p.text:'');
  if(unknownOf(data,chat))return UNKNOWN;
  if(aliveOf(data,chat))return 'running'+(p.text?' '+p.text:'')+' · not listening';
  if((chat.place&&chat.place.state==='ended')||(p.workspace&&p.alive===false)){const t=timeWords(chat.place&&chat.place.endedAt,now);return 'ended'+(t?' '+t:'')+(p.text?' · '+p.text:'');}
  return 'not connected';
 }
 /** The four verbs for the chosen chat: shown or not, pressable or not (with the reason), and the one that fits what is known. */
 function verbs(data,chatId){
  const chat=chatOf(data,chatId),held=Boolean(data&&data.mm),wait=uncertain(data),alive=aliveOf(data,chat);
  // While Manager Marcus cannot say whether the chat's pane runs, neither Go nor a Resume is offered: a resume could be a second writer on a live session, a Go could land nowhere. The next answer settles it.
  const blind=unknownOf(data,chat)&&UNKNOWN;
  const off=(...reasons)=>{const r=reasons.find(Boolean)||'';return {disabled:Boolean(r),reason:r};};
  const noChat=chat?'':'Choose a saved chat first.';
  return [
   {id:'goto',label:'Go to session',show:true,primary:alive,...off(wait&&STILL,noChat,blind)},
   {id:'resumeHere',label:'Resume here',show:held,primary:Boolean(chat)&&!alive&&held&&!blind,...off(wait&&STILL,noChat,blind)},
   {id:'resumeTerminal',label:'Resume in Terminal.app',show:true,primary:Boolean(chat)&&!alive&&!held&&!blind,...off(noChat,blind)},
   {id:'new',label:'New chat…',show:true,primary:false,...off(wait&&STILL,data&&data.launch&&'A chat is already starting.')},
  ];
 }
 /** Where the chooser stands: the last choice the home remembers for this plan when it can be honoured, else the workspace when one holds the plan, else Terminal.app. */
 function chooserWhere(data){
  if(!data||!data.mm)return 'terminal';
  return data.where==='terminal'?'terminal':'here';
 }
 /** What a verb sends to the home: one of its three chat actions, and where. */
 function request(verb,chatId,form){
  if(verb==='goto')return {action:'reconnect',body:{chatId}};
  if(verb==='resumeHere')return {action:'resume',body:{chatId,where:'here'}};
  if(verb==='resumeTerminal')return {action:'resume',body:{chatId,where:'terminal'}};
  if(verb==='new')return {action:'new',body:{chatId,where:form.where==='here'?'here':'terminal',provider:form.provider,model:form.model,effort:form.effort,cwd:form.cwd}};
  return null;
 }
 /** The page a framed panel may post to: the frame's parent, only when it is a local page (Manager Marcus's), else none. */
 function pageOrigin(ancestors,referrer){
  let o='';
  if(ancestors&&ancestors.length)o=String(ancestors[0]);
  else{try{o=new URL(String(referrer||'')).origin;}catch(e){o='';}}
  return LOOPBACK_PAGE.test(o)?o:'';
 }
 /** After an answer that names a Manager Marcus pane: focus it by message when framed in that page, a link in a tab, a notice naming the pane when there is no link. */
 function after(result,ctx){
  const mm=result&&result.mm;
  if(!mm||!PANE.test(String(mm.tmuxName||'')))return {kind:'none'};
  if(ctx&&ctx.framed&&ctx.pageOrigin)return {kind:'focus',message:{type:'lavish:focus',tmuxName:mm.tmuxName},target:ctx.pageOrigin};
  if(typeof mm.url==='string'&&/^https?:\/\//.test(mm.url))return {kind:'link',url:mm.url};
  return {kind:'notice',text:'It is in the pane '+mm.tmuxName+' of its Manager Marcus workspace.'};
 }
 /** A saved chat on one line. */
 function chatLine(chat,data){
  const provider=chat.agent&&chat.agent.provider||'';
  return {title:chat.title||'Chat',meta:provider?provider+(chat.modelName||chat.model?' · '+(chat.modelName||chat.model):''):'unattributed',state:chat.id===data.activeChatId?'active':'saved'};
 }
 const modelOptions=(data,provider)=>[{value:'',name:'Provider default',small:''}].concat(((data.models&&data.models[provider]&&data.models[provider].models)||[]).map(m=>({value:m.id||m,name:m.name||m.id||m,small:m.id||m})));
 const effortOptions=(data,provider)=>[{value:'',name:'Default',small:''}].concat(((data.models&&data.models[provider]&&data.models[provider].efforts)||[]).filter(e=>(e.id||e)!=='default').map(e=>({value:e.id||e,name:e.name||e.id||e,small:e.id||e})));
 /**
  * The plan's links, grouped: each PR link with the Vercel links the home says belong to it (`pr`, the PR's link url),
  * in the order they came; a Vercel link with no PR among these goes to `other`. The header counts both.
  */
 function linkGroups(links){
  const prs=[],byUrl=new Map(),other=[];let deployments=0;
  for(const l of links||[])if(l.kind==='pr'&&!byUrl.has(l.url)){const g={pr:l,deployments:[]};prs.push(g);byUrl.set(l.url,g);}
  for(const l of links||[])if(l.kind!=='pr'){deployments++;const g=l.pr&&byUrl.get(l.pr);(g?g.deployments:other).push(l);}
  const header=(prs.length?'Pull requests · '+prs.length:'Links')+(deployments?' · '+deployments+' Vercel link'+(deployments===1?'':'s'):'');
  return {prs,other,header};
 }
 const escHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 /** The links block: nothing without links; else the header and one toggle, and, when `open`, each PR link with its Vercel links indented under it. Every link keeps its text, href and target. */
 function linksBlock(links,open){
  const g=linkGroups(links);
  if(!g.prs.length&&!g.other.length)return '';
  const a=l=>`<a href="${escHtml(l.url)}" target="_blank" rel="noopener">${escHtml(l.kind==='pr'?'PR · '+l.label:'Vercel · '+l.label)}</a>`;
  const sub=ls=>ls.length?`<div class="lc-link-sub">${ls.map(a).join('')}</div>`:'';
  return `<div class="lc-links-head"><span>${escHtml(g.header)}</span><button type="button" data-links-toggle aria-expanded="${Boolean(open)}">${open?'Collapse all':'Expand all'}</button></div>`
   +(open?`<div class="lc-links-body">${g.prs.map(x=>`<div class="lc-link-group">${a(x.pr)}${sub(x.deployments)}</div>`).join('')}${g.other.length?`<div class="lc-link-group">${g.other.map(a).join('')}</div>`:''}</div>`:'');
 }
 return {STILL,UNKNOWN,unknownOf,timeWords,placeOf,aliveOf,line,verbs,chooserWhere,request,pageOrigin,after,chatLine,modelOptions,effortOptions,linkGroups,linksBlock};
})();
if(typeof globalThis!=='undefined')globalThis.__lavishChatLogic=LavishChatLogic;
(function(){
 const L=LavishChatLogic;
 const editor=document.getElementById('artifact')&&document.getElementById('panelHead');
 const host=document.querySelector('[data-plan-chats]');
 if(!editor&&!host)return;
 const planKey=host?.dataset.planChats||(/\/session\/([a-f0-9]{16})/.exec(location.pathname)||[])[1];
 if(!planKey)return;
 const home=editor?((typeof sessionData!=='undefined'&&sessionData.homeUrl)||'http://127.0.0.1:4388'):location.origin;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 // Framed inside the Manager Marcus page (its Review view), an answer that names a pane focuses it there; the target is the parent's own origin, and only a local page's.
 const framed=(()=>{try{return window.parent!==window;}catch(e){return true;}})();
 const pageOrigin=framed?L.pageOrigin(location.ancestorOrigins?Array.from(location.ancestorOrigins):null,document.referrer):'';
 const style=document.createElement('style');style.textContent=`
 .saved-chats{position:relative;padding:10px 12px;font:12px/1.45 system-ui,sans-serif;border-bottom:1px solid var(--border,#ddd);color:var(--fg,var(--ink,#222))}.saved-chats .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.saved-chats button{font:inherit;padding:5px 8px;background:var(--bg-panel,var(--surface,#fff));color:inherit;border:1px solid #a8b0bb;border-radius:5px;cursor:pointer}.saved-chats button:disabled{opacity:.5;cursor:default}.saved-chat-info{overflow-wrap:anywhere;margin:6px 0}.saved-chat-notice{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:7px}.saved-chat-notice a{color:#1d4f91;margin-left:6px}.saved-chat-links{margin-top:8px}.saved-chat-links a{display:block;color:#1d4f91;overflow-wrap:anywhere}.lc-links-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--fg-dim,var(--ink2,#555))}.saved-chats .lc-links-head button{flex:0 0 auto;padding:3px 7px;font-size:11px}.lc-links-body{margin-top:7px;display:grid;gap:7px}.lc-link-group{display:grid;gap:3px}.lc-link-sub{display:grid;gap:3px;margin-left:5px;padding-left:9px;border-left:2px solid var(--border,var(--rule,#ddd))}.saved-chat-log{padding:12px;display:flex;flex-direction:column;gap:10px}.saved-chat-message{background:var(--bg-elevated,var(--tint,#f3f4f6));border-radius:9px;padding:9px 11px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 system-ui,sans-serif}.saved-chat-message.agent{background:var(--accSoft,#e8eef7);color:var(--ink,#1a1d21)}.saved-chat-message small{display:block;opacity:.75;margin-bottom:4px;font-size:10px}.saved-chat-empty{padding:12px;color:inherit}#chatLog[data-saved-chat-hidden]{display:none!important}.saved-chat-viewing-old #chatComposer{display:none!important}.panel-scroll,.lavish-rail-list{scrollbar-width:none}.panel-scroll::-webkit-scrollbar,.lavish-rail-list::-webkit-scrollbar{display:none}
 .lc-line{display:flex;align-items:baseline;gap:7px;font-weight:600;overflow-wrap:anywhere;margin-bottom:8px}.lc-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#9aa1ab;position:relative;top:-1px}.lc-line[data-state="listening"] .lc-dot{background:#2f7d4f}.lc-line[data-state="running"] .lc-dot,.lc-line[data-state="starting"] .lc-dot{background:#b98a1d}
 .saved-chats .lc-trigger{display:flex;align-items:baseline;gap:6px;width:100%;text-align:left;min-width:0}.lc-trigger .lc-grow{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lc-trigger small,.lc-opt small,.lc-chat-head small{font-size:10.5px;opacity:.7;font-weight:400}.lc-caret{flex:0 0 auto;align-self:center;width:0;height:0;border:4px solid transparent;border-top-color:currentColor;border-bottom-width:0;opacity:.6}
 .lc-chats{margin:6px 0 8px;max-height:190px;overflow-y:auto;border:1px solid var(--border,#ddd);border-radius:6px}.lc-chats:empty{display:none}.lc-chat+.lc-chat{border-top:1px solid var(--border,#ddd)}.saved-chats .lc-chat-head{display:flex;align-items:baseline;gap:6px;width:100%;border:0;border-radius:0;background:none;text-align:left;padding:5px 8px;min-width:0}.lc-chat-head .lc-t{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.lc-chat-head small{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lc-chat-head .lc-s{flex:0 0 auto;font-size:10.5px;opacity:.8}.lc-chev{flex:0 0 auto;align-self:center;width:0;height:0;border:4px solid transparent;border-left-color:currentColor;border-right-width:0;margin:0 2px;opacity:.6;transition:transform .12s}.lc-chat[data-open] .lc-chev{transform:rotate(90deg)}.lc-chat-body{padding:2px 8px 8px 23px;overflow-wrap:anywhere}
 .lc-verbs{display:flex;flex-wrap:wrap;gap:6px}.saved-chats .lc-verbs button.is-primary,.saved-chats button[data-start]{border-color:#1d4f91;box-shadow:inset 0 0 0 1px #1d4f91;font-weight:600}.lc-reason{margin-top:6px;opacity:.85}.lc-reason:empty{display:none}
 .lc-new{margin-top:9px;padding-top:9px;border-top:1px solid var(--border,#ddd);display:grid;gap:7px}.lc-new[hidden]{display:none}.lc-field{display:grid;gap:3px}.lc-label{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}.lc-seg{display:flex;gap:0}.saved-chats .lc-seg button{flex:1 1 0;min-width:0;border-radius:0;text-align:left}.saved-chats .lc-seg button:first-child{border-radius:5px 0 0 5px}.saved-chats .lc-seg button:last-child{border-radius:0 5px 5px 0;border-left:0}.saved-chats .lc-seg button[aria-pressed="true"]{background:#1d4f91;border-color:#1d4f91;color:#fff}.lc-seg small{display:block;font-size:10.5px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .lc-pop{position:absolute;left:8px;right:8px;z-index:60;max-height:min(330px,60vh);overflow-y:auto;background:#fff;color:#1c1b1a;border:1px solid #c9ced6;border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.18);padding:4px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;outline:none}.lc-opt{display:flex;flex-direction:column;gap:1px;padding:6px 9px;border-radius:5px;cursor:pointer;overflow-wrap:anywhere}.lc-opt small{color:#5d636c;opacity:1;font-size:11px}.lc-opt.is-active{background:#e8eef7}.lc-opt[aria-selected="true"] .lc-opt-name{font-weight:600}.lc-opt[aria-selected="true"] .lc-opt-name::after{content:" ✓";color:#1d4f91}.lc-pop-input{display:block;margin:4px 0 2px;padding:6px 9px 4px;border-top:1px solid #e3e6ea;font-size:11px;color:#5d636c}.lc-pop-input input{display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:5px 7px;font:13px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1b1a;background:#fff;border:1px solid #a8b0bb;border-radius:5px}`;
 document.head.appendChild(style);
 const controls=host||document.createElement('div');controls.classList.add('saved-chats');
 controls.innerHTML='<div class="lc-line" role="status" aria-live="polite"><span class="lc-dot" aria-hidden="true"></span><span data-line></span></div>'
  +'<button type="button" class="lc-trigger" data-chat-picker aria-haspopup="listbox" aria-expanded="false"><span class="lc-grow">Saved chats <small data-count></small></span><span class="lc-caret" aria-hidden="true"></span></button>'
  +'<div class="lc-chats" data-chats></div>'
  +'<div class="lc-verbs"><button type="button" data-verb="goto">Go to session</button><button type="button" data-verb="resumeHere">Resume here</button><button type="button" data-verb="resumeTerminal">Resume in Terminal.app</button><button type="button" data-verb="new" aria-expanded="false">New chat…</button></div>'
  +'<div class="lc-reason" data-reason></div>'
  +'<div class="lc-new" data-new-form hidden>'
  +'<div class="lc-field"><span class="lc-label">Where</span><div class="lc-seg" role="group" aria-label="Where the new chat starts"><button type="button" data-where="here" aria-pressed="false">Here<small data-here-note></small></button><button type="button" data-where="terminal" aria-pressed="false">Outside<small>Terminal.app</small></button></div></div>'
  +'<div class="lc-field"><span class="lc-label">Provider</span><div class="lc-seg" role="group" aria-label="Provider"><button type="button" data-provider="claude" aria-pressed="false">Claude</button><button type="button" data-provider="codex" aria-pressed="false">Codex</button></div></div>'
  +'<div class="lc-field"><span class="lc-label">Model</span><button type="button" class="lc-trigger" data-pick="model" aria-haspopup="listbox" aria-expanded="false"></button></div>'
  +'<div class="lc-field"><span class="lc-label">Effort</span><button type="button" class="lc-trigger" data-pick="effort" aria-haspopup="listbox" aria-expanded="false"></button></div>'
  +'<div class="lc-field"><span class="lc-label">Working folder</span><button type="button" class="lc-trigger" data-pick="cwd" aria-haspopup="listbox" aria-expanded="false"></button></div>'
  +'<div class="row"><button type="button" data-start>Start new chat</button><button type="button" data-cancel>Cancel</button></div></div>'
  +'<div class="saved-chat-notice" role="status"></div><div class="saved-chat-links" aria-label="Linked PRs and deployments"></div>';
 if(editor){document.getElementById('panelHead').after(controls);controls.addEventListener('pointerdown',e=>e.stopPropagation());}
 const $=q=>controls.querySelector(q);
 const lineEl=$('.lc-line'),picker=$('[data-chat-picker]'),list=$('[data-chats]'),reasonEl=$('[data-reason]'),newForm=$('[data-new-form]'),notice=$('.saved-chat-notice'),links=$('.saved-chat-links');
 const log=document.createElement('div');log.className='saved-chat-log';
 if(editor){document.getElementById('chatLog').hidden=false;document.getElementById('chatLog').after(log);}else controls.after(log);
 let data=null,selected='',folded=false,busy=false,inFlight=false,signature='',listSig='';
 // The new chat's settings; `where` stays unset until a choice is pressed, so the chooser follows what the home remembers for this plan.
 const form={provider:'',model:'',effort:'',cwd:'',where:''};
 try{selected=sessionStorage.getItem('lavish-chat:'+planKey)||'';}catch{}
 // The links block's fold, remembered per plan in this browser; folded unless this plan was last left open.
 const linksKey='lavish-links-open:'+planKey;let linksOpen=false,linksSig='';
 try{linksOpen=localStorage.getItem(linksKey)==='1';}catch{}
 links.addEventListener('click',e=>{if(!e.target.closest('[data-links-toggle]'))return;linksOpen=!linksOpen;try{if(linksOpen)localStorage.setItem(linksKey,'1');else localStorage.removeItem(linksKey);}catch{}paint();links.querySelector('[data-links-toggle]')?.focus();});
 function choose(id){folded=id===selected&&!folded;selected=id;try{sessionStorage.setItem('lavish-chat:'+planKey,id);}catch{}paint();}
 function say(text,next){
  notice.textContent=text||'';
  if(next&&next.kind==='link'){const a=document.createElement('a');a.className='lc-mm-link';a.href=next.url;a.target='_blank';a.rel='noopener';a.textContent='Open its pane in Manager Marcus';notice.appendChild(a);}
  if(next&&next.kind==='notice')notice.appendChild(document.createTextNode(' '+next.text));
 }
 /* ── the panel's own popover: a listbox as wide as the panel; arrows, Home and End move, Enter picks, Escape closes ── */
 let pop=null;
 function closePop(refocus){
  if(!pop)return;const p=pop;pop=null;
  p.el.remove();p.trigger.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',p.outside,true);
  if(refocus)p.trigger.focus();
 }
 function openPop(trigger,o){
  if(pop&&pop.trigger===trigger){closePop(true);return;}
  closePop(false);
  const el=document.createElement('div');el.className='lc-pop';el.setAttribute('role','listbox');el.setAttribute('aria-label',o.label);el.tabIndex=-1;
  el.innerHTML=o.options.map((x,i)=>`<div class="lc-opt" role="option" id="lc-opt-${i}" data-i="${i}" aria-selected="${x.value===o.value}"><span class="lc-opt-name">${esc(x.name)}</span>${x.small?`<small>${esc(x.small)}</small>`:''}</div>`).join('')+(o.input?`<label class="lc-pop-input">${esc(o.input.label)}<input type="text" autocomplete="off" spellcheck="false" placeholder="${esc(o.input.placeholder||'')}"></label>`:'');
  el.style.top=(trigger.getBoundingClientRect().bottom-controls.getBoundingClientRect().top+4)+'px';
  controls.appendChild(el);
  const opts=[...el.querySelectorAll('.lc-opt')],input=el.querySelector('input');
  let active=Math.max(0,o.options.findIndex(x=>x.value===o.value));
  const mark=()=>{opts.forEach((x,i)=>x.classList.toggle('is-active',i===active));if(opts[active]){el.setAttribute('aria-activedescendant',opts[active].id);opts[active].scrollIntoView({block:'nearest'});}};
  const pick=value=>{closePop(true);o.onPick(value);};
  el.addEventListener('keydown',e=>{
   const k=e.key;let handled=true;
   if(e.target===input){
    if(k==='Enter'){const v=input.value.trim();if(v)pick(v);}
    else if(k==='Escape')closePop(true);
    else if(k==='ArrowUp'){active=opts.length-1;el.focus();mark();}
    else handled=false;
   }else if(k==='ArrowDown'){if(active===opts.length-1&&input)input.focus();else{active=Math.min(opts.length-1,active+1);mark();}}
   else if(k==='ArrowUp'){active=Math.max(0,active-1);mark();}
   else if(k==='Home'){active=0;mark();}
   else if(k==='End'){active=opts.length-1;mark();}
   else if(k==='Enter'||k===' '){if(o.options[active])pick(o.options[active].value);}
   else if(k==='Escape')closePop(true);
   else if(k==='Tab'){closePop(false);handled=false;}
   else handled=false;
   if(handled){e.preventDefault();e.stopPropagation();}
  });
  el.addEventListener('click',e=>{const x=e.target.closest('.lc-opt');if(x)pick(o.options[Number(x.dataset.i)].value);});
  el.addEventListener('pointermove',e=>{const x=e.target.closest('.lc-opt');if(x&&Number(x.dataset.i)!==active){active=Number(x.dataset.i);opts.forEach((y,i)=>y.classList.toggle('is-active',i===active));}});
  const outside=e=>{if(!el.contains(e.target)&&!trigger.contains(e.target))closePop(false);};
  document.addEventListener('pointerdown',outside,true);
  trigger.setAttribute('aria-expanded','true');pop={el,trigger,outside};
  el.focus();mark();
 }
 const triggerKey=open=>e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();open();}};
 function bind(trigger,open){trigger.addEventListener('click',open);trigger.addEventListener('keydown',triggerKey(open));}
 /** The listed options, plus the value in use when it was typed by hand. */
 function withCurrent(options,value){return value&&!options.some(x=>x.value===value)?options.concat([{value,name:value,small:'typed'}]):options;}
 function label(trigger,options,value){const x=options.find(y=>y.value===value)||{name:value,small:''};const html=`<span class="lc-grow">${esc(x.name)}${x.small&&x.small!==x.name?` <small>${esc(x.small)}</small>`:''}</span><span class="lc-caret" aria-hidden="true"></span>`;if(trigger.innerHTML!==html)trigger.innerHTML=html;}
 bind(picker,()=>{if(data)openPop(picker,{label:'Saved chats',value:selected,options:data.chats.map(c=>{const l=L.chatLine(c,data);return {value:c.id,name:l.title,small:l.meta+' · '+l.state};}),onPick:id=>{folded=false;selected='';choose(id);}});});
 const modelTrigger=$('[data-pick="model"]'),effortTrigger=$('[data-pick="effort"]'),cwdTrigger=$('[data-pick="cwd"]');
 bind(modelTrigger,()=>{if(data)openPop(modelTrigger,{label:'Model',value:form.model,options:withCurrent(L.modelOptions(data,form.provider),form.model),input:{label:'Another model id',placeholder:'a full model id'},onPick:v=>{form.model=v;paint();}});});
 bind(effortTrigger,()=>{if(data)openPop(effortTrigger,{label:'Effort',value:form.effort,options:L.effortOptions(data,form.provider),onPick:v=>{form.effort=v;paint();}});});
 bind(cwdTrigger,()=>{if(data)openPop(cwdTrigger,{label:'Working folder',value:form.cwd,options:withCurrent([{value:data.cwd||'',name:'The plan’s project folder',small:data.cwd||''}],form.cwd),input:{label:'Another folder',placeholder:'/full/path/to/folder'},onPick:v=>{form.cwd=v;paint();}});});
 controls.querySelectorAll('[data-where]').forEach(b=>b.onclick=()=>{form.where=b.dataset.where;paint();});
 controls.querySelectorAll('[data-provider]').forEach(b=>b.onclick=()=>{if(form.provider!==b.dataset.provider){form.provider=b.dataset.provider;form.model='';form.effort='';}paint();});
 list.addEventListener('click',e=>{const h=e.target.closest('.lc-chat-head');if(h)choose(h.parentElement.dataset.chat);});
 function openNew(open){newForm.hidden=!open;$('[data-verb="new"]').setAttribute('aria-expanded',String(open));if(!open)closePop(false);}
 $('[data-cancel]').onclick=()=>{openNew(false);$('[data-verb="new"]').focus();};
 /** Where a new chat would start now: the choice pressed in this panel when it can be honoured, else what the home remembers for the plan. */
 const whereNow=()=>form.where&&(data.mm||form.where==='terminal')?form.where:L.chooserWhere(data);
 function paint(){
  if(!data)return;
  if(!data.chats.some(c=>c.id===selected))selected=data.activeChatId||data.chats[0]?.id||'';
  const chat=data.chats.find(c=>c.id===selected);
  if(!form.provider)form.provider=data.chats.find(c=>c.id===data.activeChatId)?.agent?.provider==='claude'?'claude':'codex';
  if(!form.cwd)form.cwd=data.cwd||'';
  const text=L.line(data,new Date());
  $('[data-line]').textContent=text;lineEl.dataset.state=text.split(/[ ·…]/)[0];
  $('[data-count]').textContent=data.chats.length?'· '+data.chats.length:'';
  const active=selected===data.activeChatId;
  // Saved chats fold: one line per chat, the chosen one open (the active one until another is chosen); its own line folds it again.
  const rows=data.chats.map(c=>{const l=L.chatLine(c,data),open=c.id===selected&&!folded;
   const body=open?`<div class="lc-chat-body saved-chat-info">Session: ${esc(c.agent?.id||'Waiting for session identity')}<br>Model: ${esc(c.modelName||c.model||'Not reported')}${c.model&&c.modelName&&c.modelName!==c.model?` <small>${esc(c.model)}</small>`:''}${c.model&&!c.modelObserved?' (requested)':''}${c.agentState==='active'?'<br>agent running':''}${c.error?'<br>'+esc(c.error):''}</div>`:'';
   return `<div class="lc-chat"${open?' data-open':''} data-chat="${esc(c.id)}"><button type="button" class="lc-chat-head" aria-expanded="${open}"><span class="lc-chev" aria-hidden="true"></span><span class="lc-t">${esc(l.title)}</span><small>${esc(l.meta)}</small><span class="lc-s">${esc(l.state)}</span></button>${body}</div>`;}).join('');
  if(rows!==listSig){const had=list.contains(document.activeElement)?document.activeElement.parentElement?.dataset.chat:'';list.innerHTML=rows;listSig=rows;if(had)[...list.querySelectorAll('.lc-chat')].find(x=>x.dataset.chat===had)?.querySelector('button').focus();}
  if(!data.chats.length&&!notice.textContent)say('No saved chat yet. Start a new chat to connect an agent.');
  const verbs=L.verbs(data,selected);let reason='';
  for(const v of verbs){const b=$(`[data-verb="${v.id}"]`);b.hidden=!v.show;b.disabled=busy||v.disabled;b.title=v.reason||'';b.classList.toggle('is-primary',v.primary);if(v.show&&v.disabled&&v.reason===L.STILL)reason=v.reason;}
  if(!reason&&L.unknownOf(data,chat))reason='It is asked again every few seconds; the buttons come back once Manager Marcus can say.';
  reasonEl.textContent=reason;
  if(verbs.find(v=>v.id==='new').disabled&&!newForm.hidden&&!busy)openNew(false);
  const where=whereNow();
  controls.querySelectorAll('[data-where]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.where===where));if(b.dataset.where==='here'){b.disabled=!data.mm;b.title=data.mm?'':'No Manager Marcus workspace holds this plan.';}});
  $('[data-here-note]').textContent=data.mm?'in '+data.mm.workspace.title:'no workspace holds this plan';
  controls.querySelectorAll('[data-provider]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.provider===form.provider)));
  label(modelTrigger,withCurrent(L.modelOptions(data,form.provider),form.model),form.model);
  label(effortTrigger,L.effortOptions(data,form.provider),form.effort);
  label(cwdTrigger,[{value:form.cwd,name:form.cwd===(data.cwd||'')?'The plan’s project folder':form.cwd,small:form.cwd===(data.cwd||'')?form.cwd:''}],form.cwd);
  $('[data-start]').disabled=busy;
  if(editor)document.body.classList.toggle('saved-chat-viewing-old',Boolean(chat&&!active));
  const messages=chat?.messages||[];
  const nextSig=selected+JSON.stringify(messages);
  if(nextSig!==signature){const nearBottom=log.parentElement.scrollHeight-log.parentElement.scrollTop-log.parentElement.clientHeight<90;log.innerHTML=messages.length?messages.map(m=>`<div class="saved-chat-message ${m.role==='agent'?'agent':''}"><small>${esc(m.role==='user'?'You':m.role==='agent'?'Agent':m.role)} · ${esc(m.at||'')}</small>${esc(m.text)}</div>`).join(''):'<p class="saved-chat-empty">No messages in this chat yet.</p>';signature=nextSig;if(nearBottom&&editor)log.lastElementChild?.scrollIntoView({block:'nearest'});}
  // The PR and Vercel links: one block, folded to its header unless this plan was left open.
  const linksHtml=L.linksBlock(data.links,linksOpen);
  if(linksHtml!==linksSig){links.innerHTML=linksHtml;linksSig=linksHtml;}
 }
 async function refresh(){if(inFlight)return;inFlight=true;try{const r=await fetch(home+'/api/chats/'+planKey,{cache:'no-store'});if(!r.ok)throw new Error('Could not load chats');data=await r.json();if(editor)document.getElementById("chatLog").dataset.savedChatHidden="1";paint();}catch(e){if(editor)delete document.getElementById('chatLog').dataset.savedChatHidden;say('Home page unavailable. Chat connection status cannot be confirmed.');}finally{inFlight=false;}}
 async function press(verb){
  if(busy||!data)return;
  if(editor&&typeof queued!=='undefined'&&(queued.length||document.getElementById('chatInput')?.value.trim())){say('Send or clear the current draft before changing the active connection.');return;}
  const req=L.request(verb,selected,{...form,where:whereNow()});if(!req)return;
  busy=true;closePop(false);paint();say(verb==='new'?'Starting a new chat…':verb==='goto'?'Looking for the session…':'Resuming…');
  try{
   const r=await fetch(home+'/api/chats/'+planKey+'/'+req.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req.body)});
   const result=await r.json();
   // A refusal is shown as it came: the home's or Manager Marcus's own sentence (when and where the last session ended, where it is still open, the start's error).
   if(!r.ok||result.error)throw new Error(result.error||'Connection failed');
   if(result.chatId){selected=result.chatId;folded=false;}
   const next=L.after(result,{framed,pageOrigin});
   say(result.message,next);
   if(next.kind==='focus')window.parent.postMessage(next.message,next.target);
   if(verb==='new')openNew(false);
  }catch(e){say(e.message);}finally{busy=false;await refresh();}
 }
 controls.querySelectorAll('[data-verb]').forEach(b=>b.onclick=()=>{if(b.dataset.verb==='new'){openNew(newForm.hidden);if(!newForm.hidden)controls.querySelector('[data-where][aria-pressed="true"]')?.focus();}else press(b.dataset.verb);});
 $('[data-start]').onclick=()=>press('new');
 refresh();setInterval(()=>{if(document.visibilityState==='visible')refresh();},3000);
})();
