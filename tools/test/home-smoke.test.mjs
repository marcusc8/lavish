// Exercise the server-rendered page, including history and the actual delivered scripts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {Script} from 'node:vm';
test('plan details render with saved session history and valid browser scripts',{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lavish-home-smoke-')),key='0123456789abcdef';
 const plan=join(dir,'plan.html');writeFileSync(plan,'<!doctype html><html><head><title>Smoke plan</title></head><body><h1>Smoke plan</h1></body></html>');
 const agent={provider:'codex',id:'fixture-session',entrypoint:'codex',cwd:dir};
 writeFileSync(join(dir,'state.json'),JSON.stringify({sessions:{[key]:{key,file:plan,status:'open',updated_at:new Date().toISOString(),chat:[],prompts:[]}}}));
 writeFileSync(join(dir,'registry.json'),JSON.stringify({[key]:{file:plan,agent,agents:[agent]}}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../lavish-home.mjs',import.meta.url))],{env:{...process.env,LAVISH_AXI_STATE_DIR:dir,LAVISH_HOME_PORT:String(port),LAVISH_AXI_PORT:String(port+1),CODEX_HOME:join(dir,'codex'),CLAUDE_CONFIG_DIR:join(dir,'claude')},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Home failed to start')),5000);child.stdout.on('data',d=>{if(String(d).includes('lavish-home on')){clearTimeout(timeout);resolve();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Home exited '+code));});});
  const response=await fetch(`http://127.0.0.1:${port}/session/${key}`),html=await response.text();assert.equal(response.status,200,html);
  assert.match(html,/View HTML/);assert.match(html,/data-plan-chats/);
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());assert.ok(scripts.length>=2);for(const source of scripts)new Script(source);
  const view=await (await fetch(`http://127.0.0.1:${port}/view/${key}/`)).text();assert.match(view,/src="\/plan-ui.js"/);
  const chats=await (await fetch(`http://127.0.0.1:${port}/api/chats/${key}`)).json();assert.equal(chats.activeChatId,'codex:fixture-session');
 }finally{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});
