import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'lavish-chats-'));
process.env.LAVISH_AXI_STATE_DIR = dir;
const c = await import('../lavish-chats.mjs');
const key='0123456789abcdef';
const a={provider:'codex',id:'session-a',name:'First',model:'model-a'};
const b={provider:'claude',id:'session-b',name:'Second',model:'model-b'};
test('saved chats retain their session and old messages after another chat becomes active',()=>{
 c.ensureChats(key,{agent:a,agents:[a]},[{role:'agent',text:'older',at:'2026-01-01',agent:a}]);
 const first=c.claimChat(key,a);
 c.selectChat(key,b);
 const second=c.claimChat(key,b);
 assert.notEqual(first.chatId,second.chatId);
 assert.equal(c.mayDeliver(key,first),false);
 assert.equal(c.mayDeliver(key,second),true);
 assert.equal(c.readChats(key).chats[first.chatId].agent.model,'model-a');
 assert.equal(c.groupMessages(c.readChats(key),[{role:'agent',text:'older',at:'2026-01-01',agent:a}])[first.chatId][0].text,'older');
 assert.throws(()=>c.claimChat(key,a),/another chat/i);
});
test('resuming an older chat selects its original identity without duplicating chat records',()=>{
 c.selectChat(key,a); const owner=c.claimChat(key,a);
 assert.equal(Object.keys(c.readChats(key).chats).length,2);
 assert.equal(c.readChats(key).chats[owner.chatId].agent.id,a.id);
});
test('launch reservation blocks another launch and old delivery, rollback restores previous owner',()=>{
 const owner=c.claimChat(key,a);
 const launch=c.reserveLaunch(key,{provider:'codex',model:'next'});
 assert.equal(c.mayDeliver(key,owner),false);
 assert.throws(()=>c.reserveLaunch(key,{provider:'codex'}),/already starting/i);
 c.failLaunch(key,launch.id,'Could not start');
 assert.equal(c.mayDeliver(key,owner),true);
});
test('explicit chat token connects the actual provider session and preserves requested model',()=>{
 const launch=c.reserveLaunch(key,{provider:'codex',model:'chosen'});
 c.markLaunched(key,launch.id,{tmuxName:'test',provider:'codex'});
 const owner=c.claimChat(key,{provider:'codex',id:'real-id'},launch.id);
 const chat=c.readChats(key).chats[owner.chatId];
 assert.equal(chat.agent.id,'real-id'); assert.equal(chat.agent.model,'chosen');
 assert.equal(c.mayDeliver(key,owner),true);
 assert.throws(()=>c.claimChat(key,{provider:'claude',id:'wrong'},launch.id),/match/i);
});
test('unattributed legacy messages stay in a legacy chat instead of being assigned to the newest agent',()=>{
 const groups=c.groupMessages(c.readChats(key),[{role:'user',text:'legacy',at:'2025-01-01'}]);
 assert.equal(groups.legacy[0].text,'legacy');
});
test('references keep repository identity, remove duplicates, and reject unrelated domains',()=>{
 const links=c.extractLinks(['https://github.com/acme/one/pull/2 and https://github.com/acme/two/pull/2; https://one.vercel.app/test.','https://vercel.com/acme/one/deploy-1 https://github.com.evil.test/acme/one/pull/2','https://github.com/acme/one/pull/2']);
 assert.equal(links.length,4); assert.equal(links.filter(l=>l.kind==='pr').length,2);
 assert.ok(links.some(l=>l.url==='https://one.vercel.app/test'));
});
test('a deployment link is tied to the PR whose own links carry it; the first PR given wins a shared one; a plan-only link and a PR link stay untied',()=>{
 const pr1={n:1,url:'https://github.com/acme/app/pull/1',links:c.extractLinks(['https://github.com/acme/app/pull/1 https://one.vercel.app/ https://vercel.com/github'])};
 const pr2={n:2,url:'https://github.com/acme/app/pull/2',links:c.extractLinks(['https://github.com/acme/app/pull/2 https://two.vercel.app/ https://vercel.com/github'])};
 const all=c.extractLinks(['https://vercel.com/plan-only https://two.vercel.app/',...pr1.links.map(l=>l.url),...pr2.links.map(l=>l.url)]);
 const tied=Object.fromEntries(c.ownLinks(all,[pr1,pr2]).map(l=>[l.url,l.pr]));
 assert.deepEqual(tied,{'https://vercel.com/plan-only':undefined,'https://two.vercel.app/':pr2.url,'https://github.com/acme/app/pull/1':undefined,'https://one.vercel.app/':pr1.url,'https://vercel.com/github':pr1.url,'https://github.com/acme/app/pull/2':undefined});
 // a PR the home has not fetched (no url, no links) ties nothing
 assert.deepEqual(c.ownLinks(all,[{n:3}]).map(l=>l.pr),all.map(()=>undefined));
});
process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
test('an in-flight feedback transaction prevents a simultaneous chat switch',async()=>{
 let release;const ready=new Promise(r=>release=r);
 const transaction=c.withChatLock(key,()=>ready);
 assert.throws(()=>c.selectChat(key,a),/being updated/i);
 release();await transaction;
 c.selectChat(key,a);
 assert.equal(c.currentOwner(key).chatId,'codex:session-a');
});
test('a fast agent callback can claim before the launch response returns',()=>{
 const chat=c.reserveLaunch(key,{provider:'codex',model:'chosen-model'});
 c.claimChat(key,{provider:'codex',id:'fast-session'},chat.id);
 c.markLaunched(key,chat.id,{tmuxName:'fast-terminal'});
 assert.equal(c.readChats(key).launch,null);
 assert.equal(c.readChats(key).chats[chat.id].agent.id,'fast-session');
});
