#!/usr/bin/env node
// Supplement the pinned upstream bundle. Every anchor must match before any write.
import {readFileSync,writeFileSync,copyFileSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
const target=args[args.indexOf('--target')+1];if(!args.includes('--target'))throw new Error('--target is required');
const path=join(target,'dist/cli.mjs');let src=readFileSync(path,'utf8');
const marker='/* lavish-local-patch:plan-workspaces-v1 */';
if(!src.includes(marker)){
 function edit(anchor,replacement,count=1){if(src.split(anchor).length-1!==count)throw new Error('Workspace patch anchor changed: '+anchor.slice(0,100));src=src.split(anchor).join(replacement);}
 edit('async takeFeedback(key) {\n    return this.runExclusive(async () => {','async takeFeedback(key, owner = {}) {\n    return this.runExclusive(() => lavishWithChatLock(key, async () => {');
 edit('const session = state.sessions[key];\n      if (!session) {\n        return { status: "missing" };','if (!lavishMayDeliver(key, owner)) return { status: "superseded" };\n      const session = state.sessions[key];\n      if (!session) {\n        return { status: "missing" };');
 // Close the extra lock wrapper only in the targeted method.
 let a=src.indexOf('async takeFeedback('),b=src.indexOf('\n  async ',a+10);if(b<0)throw new Error('Missing method boundary');
 let part=src.slice(a,b);const last=part.lastIndexOf('    });');if(last<0)throw new Error('Missing lock close');part=part.slice(0,last)+part.slice(last).replace('    });','    }));');src=src.slice(0,a)+part+src.slice(b);
 edit('await store.takeFeedback(key)','await store.takeFeedback(key, {chatId:String(req.query.chatId||""),generation:String(req.query.generation||"")})',2);
 edit('return this.lock.runExclusive(() => this.#queuePromptsLocked(key, payload, options));','return this.lock.runExclusive(() => lavishWithChatLock(key, () => this.#queuePromptsLocked(key, payload, options)));');
 edit('    const existingPrompts = Array.isArray(session.prompts) ? session.prompts : [];\n    session.prompts = restoring', '    for (const message of userMessages) message.chatId = lavishCurrentOwner(key).chatId;\n    const existingPrompts = Array.isArray(session.prompts) ? session.prompts : [];\n    session.prompts = restoring');
 edit('async addAgentReply(key, text) {\n    return this.runExclusive(async () => {','async addAgentReply(key, text, owner = {}) {\n    return this.runExclusive(() => lavishWithChatLock(key, async () => {\n      if (!lavishMayDeliver(key, owner)) return { superseded: true };');
 edit('{ role: "agent", text: String(text || ""), at: (/* @__PURE__ */ new Date()).toISOString() }','{ role: "agent", chatId: lavishCurrentOwner(key).chatId, text: String(text || ""), at: (/* @__PURE__ */ new Date()).toISOString() }');
 a=src.indexOf('async addAgentReply(');b=src.indexOf('\n  /**',a);part=src.slice(a,b);const close=part.lastIndexOf('    });');part=part.slice(0,close)+part.slice(close).replace('    });','    }));');src=src.slice(0,a)+part+src.slice(b);
 edit('const session = await store.addAgentReply(req.params.key, text);','const session = await store.addAgentReply(req.params.key, text, req.body || {});\n      if (session?.superseded) { res.status(409).json({error:"This chat is no longer the active connection"}); return; }');
 const planUi=readFileSync(join(here,'plan-ui.js'),'utf8');
 edit('maxAttachmentBytes: attachmentConfig.maxBytes\n        })\n      );','maxAttachmentBytes: attachmentConfig.maxBytes\n        }) + "\\n" + '+JSON.stringify(planUi)+'\n      );');
 const pos=src.startsWith('#!')?src.indexOf('\n')+1:0;
 src=src.slice(0,pos)+marker+'\nimport { mayDeliver as lavishMayDeliver, currentOwner as lavishCurrentOwner, withChatLock as lavishWithChatLock } from "./lavish-chats.mjs";\n'+src.slice(pos);
}
if(!src.includes('homeUrl: `http://127.0.0.1:')){
 const anchor='    initialChat: session.chat || [],';if(!src.includes(anchor))throw new Error('Home URL anchor changed');
 src=src.replace(anchor,anchor+'\n    homeUrl: `http://127.0.0.1:${process.env.LAVISH_HOME_PORT || 4388}`,');
}
if(args.includes('--check')){console.log('Workspace patch anchors verified.');process.exit(0);}
const tmp=path+'.workspace-check.mjs';writeFileSync(tmp,src);try{execFileSync(process.execPath,['--check',tmp],{stdio:'inherit'});}finally{unlinkSync(tmp);}
copyFileSync(join(here,'lavish-chats.mjs'),join(target,'dist/lavish-chats.mjs'));
writeFileSync(path,src);
console.log('Plan workspace server and outline patch installed; syntax verified.');
