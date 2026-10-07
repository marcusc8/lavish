/* Built-in plan navigation: existing plans gain it without editing their files. */
(function(){
 if(document.getElementById('lavish-plan-navigation-style'))return;
 const style=document.createElement('style');style.id='lavish-plan-navigation-style';style.textContent=`
 html,body,.outline,#outline{scrollbar-width:none}html::-webkit-scrollbar,body::-webkit-scrollbar,.outline::-webkit-scrollbar,#outline::-webkit-scrollbar{display:none}
 body{max-width:100%;overflow-x:auto}main,.page,.outline{min-width:0}pre,table{max-width:100%}pre{overflow-x:auto;scrollbar-width:none}pre::-webkit-scrollbar{display:none}
 details[data-sec]>summary{list-style:none}details[data-sec]>summary::-webkit-details-marker{display:none}details[data-sec]>summary::marker{content:''}details[data-sec]>summary::before{display:none!important}
 .lavish-outline-actions{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.lavish-outline-actions button,.lavish-section-toggle{font:inherit;font-size:11px;color:inherit;border:1px solid var(--hairline,#ddd);background:transparent;border-radius:4px;padding:3px 5px;cursor:pointer}.lavish-section-toggle{border:0;flex:0 0 auto;width:20px;padding:2px}.lavish-section-toggle svg{display:block;width:12px;height:12px;transition:transform .12s}.lavish-section-toggle[aria-expanded=true] svg{transform:rotate(90deg)}
 `;document.head.appendChild(style);
 function setup(){
  const sections=[...document.querySelectorAll('details[data-sec]')];if(!sections.length)return;
  const outline=document.querySelector('#outline,.outline');if(!outline)return;
  if(!outline.querySelector('.lavish-outline-actions')){
   const actions=document.createElement('div');actions.className='lavish-outline-actions';
   for(const [label,open] of [['Expand all',true],['Collapse all',false]]){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>sections.forEach(d=>d.open=open);actions.appendChild(b);}outline.prepend(actions);
  }
  outline.querySelectorAll('li').forEach((row,i)=>{
   if(row.querySelector('.lavish-section-toggle'))return;
   const section=sections.find(d=>d.dataset.sec===row.dataset.sec)||sections[i];if(!section)return;
   const toggle=document.createElement('button');toggle.type='button';toggle.className='lavish-section-toggle';toggle.setAttribute('aria-label','Toggle '+section.dataset.sec);toggle.setAttribute('aria-expanded',String(section.open));toggle.innerHTML='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
   toggle.onclick=e=>{e.stopPropagation();section.open=!section.open;};section.addEventListener('toggle',()=>toggle.setAttribute('aria-expanded',String(section.open)));row.prepend(toggle);
  });
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
 const observer=new MutationObserver(setup);observer.observe(document.body||document.documentElement,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),10000);
})();
