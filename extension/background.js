'use strict';
const LOCAL = 'http://127.0.0.1:8787';
const PREFIX = 'job:';
const COMPANION_TAB = 'companion-tab';
const launching = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sendLocal = (tabId, message) => chrome.tabs.sendMessage(tabId, message).catch(() => {});
const jobKey = id => PREFIX + id;
async function selectChatGPTTab() {
  const saved = (await chrome.storage.session.get(COMPANION_TAB))[COMPANION_TAB];
  if (Number.isInteger(saved)) {
    const tab = await chrome.tabs.get(saved).catch(() => null);
    if (tab?.url?.startsWith('https://chatgpt.com/')) {
      const state = await chrome.tabs.sendMessage(tab.id,{type:'inspect'}).catch(() => null);
      if (!state?.fresh) {
        await chrome.tabs.update(tab.id,{url:'https://chatgpt.com/',active:false});
        return {tab,probe:false};
      }
      return {tab,probe:true};
    }
  }
  const tabs = await chrome.tabs.query({url:'https://chatgpt.com/*'});
  for (const tab of tabs.sort((a,b) => Number(a.active) - Number(b.active))) {
    const state = await chrome.tabs.sendMessage(tab.id,{type:'inspect'}).catch(() => null);
    if (state?.ready && state.fresh) {
      await chrome.storage.session.set({[COMPANION_TAB]:tab.id});
      return {tab,probe:true};
    }
    // Recover a filtered payload left in an otherwise empty composer by an
    // older companion version. Never clear an arbitrary user draft.
    if (state?.ready && state.ownDraft) {
      const cleared = await chrome.tabs.sendMessage(tab.id,{type:'clear-own-draft'}).catch(() => null);
      if (cleared?.ok) {
        await chrome.storage.session.set({[COMPANION_TAB]:tab.id});
        return {tab,probe:true};
      }
    }
  }
  // If every open ChatGPT tab contains a conversation, reuse one by
  // navigating it to a fresh composer instead of adding another tab.
  if (tabs.length) {
    const tab = tabs.sort((a,b) => Number(a.active) - Number(b.active))[0];
    await chrome.storage.session.set({[COMPANION_TAB]:tab.id});
    await chrome.tabs.update(tab.id,{url:'https://chatgpt.com/',active:false});
    return {tab,probe:false};
  }
  const tab = await chrome.tabs.create({url:'https://chatgpt.com/',active:false});
  await chrome.storage.session.set({[COMPANION_TAB]:tab.id});
  return {tab,probe:false};
}
async function finish(id, message) {
  const key = jobKey(id); const job = (await chrome.storage.session.get(key))[key];
  if (!job) return;
  await chrome.storage.session.remove(key);
  await chrome.alarms.clear(key);
  await restoreTab(job);
  await sendLocal(job.localTab, {...message,id});
  // Leave the ChatGPT tab available for inspection; never close a user's tab.
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (sender.url?.startsWith(LOCAL + '/') && sender.frameId === 0) {
      if (typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{20,80}$/.test(message.id)) throw new Error('Invalid message identifier.');
      if (message.type === 'cancel') {
        const key = jobKey(message.id); const job = (await chrome.storage.session.get(key))[key];
        if (job?.localTab === sender.tab.id) {
          await chrome.tabs.sendMessage(job.chatTab, {type:'cancel',id:message.id}).catch(() => {});
          await finish(message.id,{type:'error',message:'Message cancelled. Anything already submitted remains in ChatGPT.'});
        }
        return;
      }
      if (message.type !== 'send' || typeof message.text !== 'string' || message.text.length > 100000) throw new Error('Invalid filtered message.');
      const key = jobKey(message.id);
      if ((await chrome.storage.session.get(key))[key]) return;
      // The payload contains its redacted history, so reuse an existing empty
      // ChatGPT composer whenever one is already open.
      const selected = await selectChatGPTTab();
      const tab = selected.tab;
      await chrome.storage.session.set({[key]:{id:message.id,localTab:sender.tab.id,chatTab:tab.id,text:message.text,started:Date.now(),launched:false}});
      await chrome.alarms.create(key,{when:Date.now()+5*60*1000});
      await sendLocal(sender.tab.id,{type:'progress',id:message.id,message:'Opening a fresh ChatGPT conversation…'});
      if (selected.probe) await chrome.tabs.sendMessage(tab.id,{type:'probe'}).catch(() => {});
      // A reloaded tab announces itself, but that can happen before this job is
      // stored, so keep nudging the tab until the job is actually launched.
      else nudge(tab.id,key);
    } else if (sender.url?.startsWith('https://chatgpt.com/') && sender.frameId === 0) {
      if (message.type === 'chat-ready') { await launch(sender.tab.id); return; }
      if (message.type === 'wake') { await wake(sender.tab.id); return; }
      const job = (await chrome.storage.session.get(jobKey(message.id)))[jobKey(message.id)];
      if (!job || job.chatTab !== sender.tab.id) return;
      // Diagnostics are structural only; keep them small and optional.
      const debug = typeof message.debug === 'string' && message.debug.length <= 8000 ? message.debug : undefined;
      if (message.type === 'reply' && typeof message.text === 'string' && message.text.length <= 200000) await finish(message.id,{type:'reply',text:message.text,debug});
      if (message.type === 'error') await finish(message.id,{type:'error',message:message.message,debug});
      if (message.type === 'progress') await sendLocal(job.localTab,{type:'progress',id:message.id,message:message.message});
    }
  })().then(() => respond({ok:true}), () => respond({error:'Could not connect to the ChatGPT tab. Check your sign-in and extension permissions.'}));
  return true;
});
async function nudge(tabId, key) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const job = (await chrome.storage.session.get(key))[key];
    if (!job || job.launched) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    // Only probe a settled document; the previous page can still answer while
    // its replacement is loading, and it still holds the old conversation.
    if (tab.status === 'complete' && (await chrome.tabs.sendMessage(tabId,{type:'probe'}).catch(() => null))?.ok) return;
    await delay(500);
  }
}
async function wake(tabId) {
  // Chrome can skip layout in a hidden tab. Showing it for a moment forces the
  // page to render, then the tab the user was on is restored immediately.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active) return;
  const [previous] = await chrome.tabs.query({active:true, windowId:tab.windowId});
  await chrome.tabs.update(tabId,{active:true}).catch(() => {});
  await delay(800);
  if (previous && previous.id !== tabId) await chrome.tabs.update(previous.id,{active:true}).catch(() => {});
}
async function launch(tabId) {
  if (launching.has(tabId)) return;
  launching.add(tabId);
  try { await launchOnce(tabId); } finally { launching.delete(tabId); }
}
async function focusChat(key, job) {
  // ChatGPT's own rendering runs on requestAnimationFrame, which Chrome
  // suspends in a hidden tab, so the page cannot submit or stream while it is
  // in the background. Hold it in front for the job and remember where to
  // return the user afterwards.
  const tab = await chrome.tabs.get(job.chatTab).catch(() => null);
  if (!tab || tab.active) return;
  const [previous] = await chrome.tabs.query({active:true, windowId:tab.windowId});
  if (previous && previous.id !== tab.id) {
    const current = (await chrome.storage.session.get(key))[key];
    if (current) await chrome.storage.session.set({[key]:{...current, restoreTab:previous.id}});
  }
  await chrome.tabs.update(tab.id,{active:true}).catch(() => {});
}
async function restoreTab(job) {
  // Only if the user is still looking at the ChatGPT tab we brought forward.
  if (!Number.isInteger(job.restoreTab)) return;
  const chat = await chrome.tabs.get(job.chatTab).catch(() => null);
  if (chat && !chat.active) return;
  await chrome.tabs.update(job.restoreTab,{active:true}).catch(() => {});
}
async function launchOnce(tabId) {
  const jobs = await chrome.storage.session.get(null);
  const entry = Object.entries(jobs).find(([key,job]) => key.startsWith(PREFIX) && job.chatTab === tabId && !job.launched);
  if (!entry) return;
  const [key,job] = entry;
  await chrome.storage.session.set({[key]:{...job,launched:true}});
  await focusChat(key, job);
  try {
    await chrome.tabs.sendMessage(tabId,{type:'run',id:job.id,text:job.text});
    // Don't retain even redacted prompt bodies after delivery to the page.
    const current = (await chrome.storage.session.get(key))[key];
    if (current) { delete current.text; await chrome.storage.session.set({[key]:current}); }
  } catch {
    await finish(job.id,{type:'error',message:'ChatGPT could not be opened. Sign in on chatgpt.com and try again.'});
  }
}
chrome.tabs.onRemoved.addListener(async tabId => {
  const companion = (await chrome.storage.session.get(COMPANION_TAB))[COMPANION_TAB];
  if (companion === tabId) await chrome.storage.session.remove(COMPANION_TAB);
  const jobs = await chrome.storage.session.get(null);
  for (const [key,job] of Object.entries(jobs)) {
    if (!key.startsWith(PREFIX)) continue;
    if (job.chatTab === tabId) await finish(job.id,{type:'error',message:'The ChatGPT tab was closed before its reply arrived.'});
    else if (job.localTab === tabId) {
      await chrome.tabs.sendMessage(job.chatTab,{type:'cancel',id:job.id}).catch(() => {});
      await chrome.storage.session.remove(key); await chrome.alarms.clear(key);
    }
  }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith(PREFIX)) finish(alarm.name.slice(PREFIX.length),{type:'error',message:'ChatGPT took too long. Inspect its tab for a sign-in, limit, or unfinished reply.'});
});
