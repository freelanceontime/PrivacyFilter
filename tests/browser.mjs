// Chrome extension + real local HTTP/Ollama roundtrip against a controlled ChatGPT DOM fixture.
// The temporary extension uses a local fixture origin. This does not claim live ChatGPT compatibility.
import {chromium} from 'playwright';
import {mkdtemp, rm, mkdir, readFile, writeFile, cp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const profile=await mkdtemp(path.join(tmpdir(),'private-chat-chrome-'));
const fixture=`<!doctype html><html><body><form id="composer"><div id="prompt-textarea" contenteditable="true" data-lexical-editor="true" style="white-space:pre-wrap;min-height:40px"></div><button id="composer-submit-button" data-testid="send-button" type="submit" disabled>Send</button></form><section id="turns"></section><script>
const editor=document.querySelector('#prompt-textarea');
const button=document.querySelector('#composer-submit-button');
// Emulate ChatGPT's rich editor: claim the paste, then apply it across two
// asynchronous updates so the composer briefly holds a partial payload.
editor.addEventListener('paste',event=>{
  event.preventDefault();
  const text=event.clipboardData.getData('text/plain');
  const middle=Math.ceil(text.length/2);
  setTimeout(()=>{
    editor.textContent=text.slice(0,middle); editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
    setTimeout(()=>{ editor.textContent=text; editor.dispatchEvent(new InputEvent('input',{bubbles:true})); },80);
  },40);
});
editor.addEventListener('input',()=>{ button.disabled=!editor.innerText.trim(); });
document.querySelector('#composer').addEventListener('submit',event=>{
  event.preventDefault();
  window.received=editor.innerText;
  const thread=document.createElement('article');document.querySelector('#turns').append(thread);
  const user=document.createElement('div'); user.dataset.messageAuthorRole='user'; user.textContent=window.received; thread.append(user);
  // The user's own turn carries the same action buttons as a finished answer.
  const edit=document.createElement('button');edit.dataset.testid='copy-turn-action-button';edit.textContent='Copy';thread.append(edit);
  editor.textContent=''; button.disabled=true;
  const refs=window.received.match(/\\[\\[PRIVATE_[A-Z]+_[a-f0-9]+_\\d+\\]\\]/g)||[];
  const turn=thread;
  const assistant=document.createElement('div');assistant.dataset.messageAuthorRole='assistant';
  const markdown=document.createElement('div');markdown.className='markdown';assistant.append(markdown);
  // ChatGPT renders its progress label inside the turn's own body, and it can
  // sit there far longer than a settled answer would.
  markdown.textContent='Writing';
  turn.append(assistant);
  // Then stream the answer one item at a time, with a pause part way through,
  // and only add the turn's action bar once it is genuinely finished.
  setTimeout(()=>{
    markdown.textContent='';
    // A visible heading, the screen-reader copy ChatGPT renders beside it, a
    // paragraph, then the list the answer streams into.
    const heading=document.createElement('h1');heading.textContent='Corrected ticket';markdown.append(heading);
    const shadow=document.createElement('h1');shadow.textContent='Corrected ticket';
    shadow.setAttribute('style','position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)');markdown.append(shadow);
    const intro=document.createElement('p');intro.textContent='Severity: High';markdown.append(intro);
    const list=document.createElement('ol');markdown.append(list);
    const items=[...new Set(refs)];
    let index=0;
    const step=()=>{
      const item=document.createElement('li');item.textContent=items[index];list.append(item);
      index++;
      if(index<items.length) setTimeout(step,index===1?2600:700);
      else setTimeout(()=>{
        // Follow-up chips render inside the answer body once it is finished.
        const chips=document.createElement('div');chips.className='suggestions';
        for(const label of ['Clarify the vulnerable data flows','State the security impact more explicitly']) {
          const chip=document.createElement('button');chip.textContent=label;chips.append(chip);
        }
        markdown.append(chips);
        const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='Copy';turn.append(copy);
      },700);
    };
    step();
  },2500);
});
</script></body></html>`;
const fixtureServer=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end(fixture);});
await new Promise(resolve=>fixtureServer.listen(8789,'127.0.0.1',resolve));
const testExtension=path.join(profile,'fixture-extension');
await cp(path.join(root,'extension'),testExtension,{recursive:true});
// Substitute only the remote origin in a temporary copy so Chrome's extension-created
// first navigation cannot bypass Playwright routing. Production files are untouched.
for(const file of ['manifest.json','background.js']) {
  const source=await readFile(path.join(testExtension,file),'utf8');
  await writeFile(path.join(testExtension,file),source.replaceAll('https://chatgpt.com/','http://127.0.0.1:8789/'));
}
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${testExtension}`,`--load-extension=${testExtension}`]});
  const existingChat=await context.newPage();
  await existingChat.goto('http://127.0.0.1:8789/');
  await existingChat.locator('#prompt-textarea').waitFor();
  const page=await context.newPage(); const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:8787/');
  await page.getByText(/Chrome companion connected/).waitFor({timeout:15000});
  await mkdir(path.join(root,'artifacts'),{recursive:true});
  await page.screenshot({path:path.join(root,'artifacts/desktop.png'),fullPage:true});
  await page.locator('#compare-toggle').check();
  const original='Please draft an email to Alice Morgan at alice@example.test about Project Blue Finch. password="DemoSecret-12345"';
  await page.locator('#prompt').fill(original); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.message.assistant') || !document.querySelector('#manual').hidden || !document.querySelector('#error').hidden, null, {timeout:45000}).catch(()=>{});
  if (!await page.locator('.message.assistant').count()) {
    const worker=context.serviceWorkers()[0];
    console.log('DEBUG extension jobs', worker ? await worker.evaluate(async()=>Object.values(await chrome.storage.session.get(null)).map(j=>({id:j.id,launched:j.launched,chatTab:j.chatTab}))) : 'no worker');
    console.log('DEBUG pages',context.pages().map(p=>p.url()));
    for(const p of context.pages().filter(p=>p.url().startsWith('http://127.0.0.1:8789/'))) console.log('DEBUG fixture',{editor:await p.locator('#prompt-textarea').innerText(),users:await p.locator('[data-message-author-role="user"]').count(),article:await p.evaluate(()=>document.querySelector('article')?.outerHTML??null)});
    console.log('DEBUG page',await page.evaluate(()=>({status:document.querySelector('#status-text').textContent,manualHidden:document.querySelector('#manual').hidden,connected:document.querySelector('#connection').className})));
    throw new Error('No reply: '+await page.locator('#manual-reason').textContent()+' / '+await page.locator('#error').textContent());
  }
  assert.equal(await page.locator('#original-text').textContent(),original);
  const redacted=await page.locator('#redacted-text').textContent();
  const outbound=await page.locator('#outbound-text').textContent();
  const reply=await page.locator('.message.assistant .message-text').textContent();
  assert.notEqual(reply.trim(),'Writing','A status placeholder must never be captured as the reply');
  for(const value of ['Alice Morgan','alice@example.test','Blue Finch','DemoSecret-12345']) {
    assert.ok(!redacted.includes(value),'Value leaked in redacted message: '+value);
    assert.ok(!outbound.includes(value),'Value leaked in full outbound: '+value);
    assert.ok(reply.includes(value),'Reply did not restore: '+value);
  }
  assert.match(reply,/1\. Alice Morgan/,'Ordered-list numbers should survive response extraction');
  assert.ok(reply.includes('Corrected ticket'),'The heading should be part of the reply');
  assert.equal(reply.split('Corrected ticket').length-1,1,'A screen-reader copy of the heading must not be duplicated');
  assert.ok(!reply.includes('Clarify the vulnerable data flows'),'Follow-up chips are controls, not reply text');
  assert.equal(await page.locator('#status-text').textContent(),'Done — private details restored in the reply','The status should confirm restoration');
  assert.match(reply,/Corrected ticket\n\nSeverity: High/,'Block structure and blank lines must survive extraction');
  const tab=context.pages().find(p=>p.url().startsWith('http://127.0.0.1:8789/'));
  assert.ok(tab,'The existing ChatGPT tab should be reused');
  assert.equal(context.pages().filter(p=>p.url().startsWith('http://127.0.0.1:8789/')).length,1,
    'A second ChatGPT tab should not be created when an empty one exists');
  assert.equal(await tab.evaluate(()=>window.received),outbound,'Displayed full payload must match submitted text');
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const storage=await worker.evaluate(()=>chrome.storage.session.get(null));
  assert.deepEqual(Object.keys(storage),['companion-tab'],
    'Extension should forget the completed job and retain only its reusable tab ID');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(root,'artifacts/side-by-side.png'),fullPage:true});
  console.log('PASS: Chrome companion, real local redaction, exact wire comparison, automatic reply restoration, extension cleanup, no page exceptions.');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#compare-toggle').uncheck();
  await page.screenshot({path:path.join(root,'artifacts/mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile page overflows');
  console.log('PASS: mobile layout fits viewport.');
  // Review mode: the message waits for approval and marking hides more of it.
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#new-chat').evaluate(button=>button.click());
  await page.waitForFunction(()=>document.querySelector('#prompt')?.disabled===false);
  await page.locator('#review-toggle').check();
  const chatTab=context.pages().find(p=>p.url().startsWith('http://127.0.0.1:8789/'));
  await chatTab.evaluate(()=>{window.received=null;});
  await page.locator('#prompt').fill('Email Alice Morgan about the Kestrel audit.');
  await page.locator('#send').click();
  await page.locator('#review').waitFor({state:'visible',timeout:45000});
  const reviewed=await page.locator('#review-text').innerText();
  assert.ok(!reviewed.includes('Alice Morgan'),'Detected values must already be hidden in review');
  assert.equal(await chatTab.evaluate(()=>window.received??null),null,'Nothing may be submitted while a message is under review');
  // Whatever the local model left in plain text is what a reviewer can mark;
  // which words those are depends on the model, so take the first one.
  const missed=await page.evaluate(()=>{
    for(const child of document.querySelector('#review-text').childNodes) {
      if(child.nodeType!==Node.TEXT_NODE) continue;
      const word=child.textContent.match(/[A-Za-z]{5,}/);
      if(word) return word[0];
    }
    return null;
  });
  assert.ok(missed,'Review should expose remaining plain text to mark');
  await page.locator('#review-kind').selectOption('VALUE');
  await page.evaluate(word=>{
    const target=document.querySelector('#review-text');
    const node=[...target.childNodes].find(child=>child.nodeType===Node.TEXT_NODE&&child.textContent.includes(word));
    const start=node.textContent.indexOf(word);
    const range=document.createRange(); range.setStart(node,start); range.setEnd(node,start+word.length);
    const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  },missed);
  await page.locator('#mark-selection').click();
  await page.waitForFunction(word=>!document.querySelector('#review-text').innerText.includes(word),missed,{timeout:10000});
  await page.screenshot({path:path.join(root,'artifacts/review.png'),fullPage:true});
  await page.locator('#approve').click();
  await page.waitForFunction(()=>document.querySelectorAll('.message.assistant').length>0,null,{timeout:45000});
  const second=context.pages().find(p=>p.url().startsWith('http://127.0.0.1:8789/'));
  const submitted=await second.evaluate(()=>window.received);
  for(const value of ['Alice Morgan',missed]) assert.ok(!submitted.includes(value),'Review mode leaked: '+value);
  assert.ok((await page.locator('.message.assistant .message-text').last().textContent()).includes(missed),'Marked value should restore locally');
  console.log('PASS: review mode holds the message, marks a missed value, and restores it after sending.');
  await page.locator('#review-toggle').uncheck();
  await page.locator('#new-chat').evaluate(button=>button.click());
  await page.waitForFunction(()=>document.querySelector('#prompt')?.disabled===false);
  await page.locator('#setup-button').click();
  assert.ok(await page.locator('#setup').isVisible());
  await page.locator('#close-setup').click();
} finally { if(context) await context.close(); await rm(profile,{recursive:true,force:true}); await new Promise(resolve=>fixtureServer.close(resolve)); }
