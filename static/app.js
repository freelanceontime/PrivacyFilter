'use strict';
const $ = id => document.getElementById(id);
const chats = new Map();
const dispatched = new Set();
let current = null;
let connected = false;
let selectedComparison = null;
let polling = false;
let creating = false;

async function api(path, body, method = 'POST') {
  const response = await fetch('/api/' + path, {
    method, headers: {'Content-Type': 'application/json', 'X-Private-Chat': '1'},
    ...(method === 'GET' ? {} : {body: JSON.stringify(body || {})})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The local service could not complete the request.');
  return data;
}
function error(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
function busy(chat) { return chat && ['filtering', 'reviewing', 'prepared', 'sending'].includes(chat.state); }
const TOKEN = /\[\[PRIVATE_[A-Z]+_[a-f0-9]+_\d+\]\]/g;
let selected = '';
let packagedExtension = null;
let modelDown = false;
let extensionVersion = null;
let chatSignedIn = false;
let chatTabs = 0;
let defaultInstructions = '';
let defaultDetector = '';
let modelReason = '';
function node(tag, className, text) {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
// The composer grows with what is in it, up to the height the stylesheet caps,
// after which it scrolls. Every path that changes the value calls this.
function fitComposer() {
  const prompt = $('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = prompt.scrollHeight + 'px';
}
function setPrompt(value) {
  $('prompt').value = value;
  $('character-count').textContent = value.length.toLocaleString();
  fitComposer();
}
function chatIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2.6 3.2h10.8a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H6.4L3.3 13.4v-2.6h-.7a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1z');
  svg.append(path);
  return svg;
}
// Collapsed, the rail keeps only the marks: the diamond, the plus, the cog and
// one icon per conversation.
function applySidebar(collapsed) {
  $('sidebar').classList.toggle('collapsed', collapsed);
  $('collapse').setAttribute('aria-label', collapsed ? 'Expand the sidebar' : 'Collapse the sidebar');
  $('collapse').title = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
}
function updateList() {
  $('chat-list').replaceChildren();
  for (const [id, chat] of chats) {
    const row = node('div', 'chat-item' + (id === current ? ' active' : ''));
    const title = chat.messages.find(m => m.role === 'user')?.text || chat.pending?.original || 'New conversation';
    const button = node('button', 'chat-open');
    button.append(chatIcon(), node('span', 'label', title));
    button.title = title;
    button.onclick = () => { current = id; selectedComparison = null; error(''); render(); };
    const remove = node('button', 'delete', '×'); remove.setAttribute('aria-label', 'Delete conversation');
    remove.onclick = async () => {
      try {
        if (chat.pending) window.postMessage({source: 'private-chat-page', type: 'cancel', id: chat.pending.id}, location.origin);
        await api('chats/' + id, {}, 'DELETE'); chats.delete(id);
        if (current === id) current = chats.keys().next().value || null;
        selectedComparison = null;
        if (!current) await newChat(); else render();
      } catch (e) { error(e.message); }
    };
    row.append(button, remove); $('chat-list').append(row);
  }
}
function step(id, done) { $(id).classList.toggle('done', Boolean(done)); }
function updateSetup() {
  const loaded = connected && (!packagedExtension || extensionVersion === packagedExtension);
  step('step-developer', loaded);
  step('step-load', loaded);
  step('step-signin', chatSignedIn);
  $('step-signin-text').textContent = chatSignedIn ? 'Signed in to ChatGPT in this browser.'
    : chatTabs ? 'A ChatGPT tab is open but not signed in. Sign in to continue.'
    : 'Open ChatGPT in that browser and sign in normally.';
  step('step-ready', loaded && chatSignedIn);
  $('step-ready-text').textContent = loaded && chatSignedIn
    ? 'Ready. The companion reuses one ChatGPT tab and returns completed replies here.'
    : connected && !loaded
    ? `Reload the companion at chrome://extensions: v${extensionVersion} is loaded, v${packagedExtension} is ready.`
    : 'Reload this page once the steps above are done.';
}
function askStatus() { window.postMessage({source:'private-chat-page', type:'status'}, location.origin); }
function showExtraction(chat) {
  // Structural diagnostics from the companion, so a bad capture can be reported
  // with what the extractor actually saw.
  const present = Boolean(chat?.extraction) && $('compare-toggle').checked;
  $('extraction').hidden = !present;
  if (present) $('extraction-text').textContent = chat.extraction;
}
function showComparison(data) {
  $('comparison').hidden = !$('compare-toggle').checked || !data;
  if (!data) return;
  $('original-text').textContent = data.original ?? data.text;
  $('redacted-text').textContent = data.redacted ?? 'Checking locally…';
  $('outbound-text').textContent = data.outbound ?? 'No message has been sent.';
}
// The redacted text is rendered as nodes, never HTML: a private value could
// otherwise carry markup into this page.
function renderReview(chat) {
  const reviewing = chat.state === 'reviewing' && Boolean(chat.pending);
  $('review').hidden = !reviewing;
  if (!reviewing) return;
  const text = chat.pending.redacted;
  const target = $('review-text');
  const degraded = chat.pending.degraded;
  $('review-degraded').hidden = !degraded;
  if (degraded) {
    $('review-degraded').textContent =
      `${degraded} Only emails, URLs, file paths and labelled secrets were hidden automatically. Mark anything else private before sending, or discard the message.`;
  }
  const count = chat.pending.references;
  $('review-count').textContent = count === 1 ? '1 private value hidden' : count + ' private values hidden';
  // Polling re-renders every second; rebuilding unchanged text would drop the
  // selection the reviewer is about to mark.
  if (target.dataset.rendered === text) return;
  target.dataset.rendered = text;
  target.replaceChildren();
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) target.append(document.createTextNode(text.slice(last, match.index)));
    target.append(node('span', 'token', match[0]));
    last = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(last)));
}
// ChatGPT frames a returned document in its own block; the companion fences
// those so they can be shown, and copied, separately from the prose.
function messageParts(text) {
  const parts = [];
  let buffer = [];
  let block = false;
  let code = false;
  for (const line of String(text).split('\n')) {
    if (line.trim().startsWith('```')) {
      parts.push({block, code, text: buffer.join('\n').trim()});
      buffer = [];
      // An opening fence says which kind of block follows.
      if (!block) code = line.trim().slice(3).trim() === 'code';
      block = !block;
      continue;
    }
    buffer.push(line);
  }
  parts.push({block, code, text: buffer.join('\n').trim()});
  return parts.filter(part => part.text);
}
async function copyText(value, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied';
  } catch { button.textContent = 'Copy failed'; }
  setTimeout(() => { button.textContent = label; }, 1600);
}
function copyButton(value, className) {
  const button = node('button', className, 'Copy');
  button.onclick = () => copyText(value, button);
  return button;
}
// No remote HTML, images, scripts, or markdown links: restored content is text.
function renderMessage(article, message) {
  if (message.role !== 'assistant') { article.append(node('div', 'message-text', message.text)); return; }
  const parts = messageParts(message.text);
  for (const part of parts) {
    if (!part.block) { article.append(node('div', 'message-text', part.text)); continue; }
    // A returned document keeps the page's own type; only a code sample is set
    // in monospace, the way ChatGPT distinguishes the two.
    const wrapper = node('div', 'reply-block');
    const bar = node('div', 'block-bar');
    bar.append(copyButton(part.text, 'block-copy'));
    wrapper.append(bar, node('div', part.code ? 'block-code' : 'block-text', part.text));
    article.append(wrapper);
  }
  // One copy control per message: a block carries its own, and copying it must
  // not pick up ChatGPT's commentary around it.
  if (!parts.some(part => part.block)) article.append(copyButton(message.text, 'message-copy'));
}
function render() {
  const chat = chats.get(current); updateList();
  if (!chat) return;
  const active = busy(chat);
  $('welcome').hidden = chat.messages.length > 0 || active;
  $('messages').replaceChildren();
  for (const message of chat.messages) {
    const article = node('article', 'message ' + message.role);
    article.append(node('div', 'message-label', message.role === 'user' ? 'You' : '◈  Private Chat'));
    renderMessage(article, message);
    if (message.role === 'user') {
      const inspect = node('button', 'compare-message', 'Inspect original / redacted');
      inspect.hidden = !$('compare-toggle').checked;
      inspect.onclick = () => { selectedComparison = message; showComparison(message); $('comparison').scrollIntoView({block:'nearest'}); };
      article.append(inspect);
    }
    $('messages').append(article);
  }
  if (active) $('messages').append(node('article', 'message user pending', chat.pending?.original || chat.draft || 'Checking message…'));
  renderReview(chat);
  const latest = [...chat.messages].reverse().find(m => m.role === 'user');
  showComparison(selectedComparison || chat.pending || (chat.state === 'filtering' ? {original: chat.draft} : latest));
  showExtraction(chat);
  $('status-text').textContent = !active && modelDown ? modelReason : (chat.progress || 'Ready');
  $('status').classList.toggle('stalled', !active && modelDown);
  $('status').classList.toggle('busy', active);
  $('cancel').hidden = !active;
  $('prompt').disabled = active;
  $('send').disabled = active || !$('prompt').value.trim();
  $('manual').hidden = !(chat.pending && (chat.manual || (!connected && chat.state === 'prepared')));
  if (chat.manualReason) $('manual-reason').textContent = chat.manualReason;
  if (chat.error) {
    error(chat.error);
    if (chat.draft && !$('prompt').value) { setPrompt(chat.draft); $('send').disabled=false; }
  }
}
async function newChat() {
  if (creating) return;
  creating = true;
  try {
    const chat = await api('chats'); chats.set(chat.id, chat); current = chat.id;
    selectedComparison = null; error(''); setPrompt(''); render(); $('prompt').focus();
  } catch (e) { error(e.message); } finally { creating = false; }
}
async function send() {
  const chat = chats.get(current); const text = $('prompt').value;
  if (!chat || busy(chat) || !text.trim()) return;
  error(''); selectedComparison = null;
  // Mark locally before awaiting to prevent duplicate Enter/click submissions.
  chat.epoch = (chat.epoch || 0) + 1; chat.state = 'filtering'; chat.progress = 'Checking your message locally…'; chat.draft = text; render();
  try {
    const updated = await api(`chats/${chat.id}/prepare`, {text, review: $('review-toggle').checked});
    Object.assign(chat, updated, {draft: text, manual: false, manualReason: null});
    setPrompt(''); render();
  } catch (e) { chat.state = 'idle'; render(); error(e.message); }
}
async function dispatch(chat) {
  if (!connected || !chat.pending || chat.manual || dispatched.has(chat.pending.id)) return;
  const pending = chat.pending;
  dispatched.add(pending.id);
  try {
    await api(`chats/${chat.id}/sending`, {turn: pending.id});
    chat.state = 'sending'; chat.progress = 'Opening ChatGPT…';
    // Only the cloud payload crosses the extension boundary. No original or vault.
    window.postMessage({source: 'private-chat-page', type: 'send', id: pending.id, text: pending.outbound}, location.origin);
    if (chat.id === current) render();
  } catch (e) { chat.manual = true; chat.manualReason = e.message; if (chat.id === current) render(); }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (const chat of chats.values()) {
      if (!busy(chat)) continue;
      try {
        const epoch = chat.epoch;
        const data = await api('chats/' + chat.id, null, 'GET');
        if (!chats.has(chat.id) || chat.epoch !== epoch || !busy(chat)) continue;
        Object.assign(chat, data);
        if (chat.state === 'sending' && chat.browserProgress) chat.progress = chat.browserProgress;
        if (chat.state === 'prepared') await dispatch(chat);
        if (chat.id === current) render();
      } catch (e) { if (chat.id === current) error(e.message); }
    }
  } finally { polling = false; }
}
window.addEventListener('message', async event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'private-chat-companion') return;
  const data = event.data;
  if (data.type === 'stale') {
    connected = false; chatSignedIn = false; updateSetup();
    $('connection').classList.remove('connected');
    $('connection-text').textContent = 'Companion updated — reload this page to reconnect';
    return;
  }
  if (data.type === 'status') {
    chatSignedIn = Boolean(data.signedIn);
    chatTabs = Number(data.tabs) || 0;
    updateSetup();
    return;
  }
  if (data.type === 'ready') {
    connected = true; $('connection').classList.add('connected'); $('connection-text').textContent = 'Chrome companion connected';
    if (data.version) $('connection-text').textContent += ' · v' + data.version;
    // The app updates itself on launch; the browser will not, so say plainly
    // when the loaded companion is older than the one in this folder.
    if (packagedExtension && data.version && data.version !== packagedExtension) {
      $('connection').classList.add('outdated');
      $('connection-text').textContent =
        `Companion v${data.version} is loaded — v${packagedExtension} is ready. Reload it at chrome://extensions`;
    } else {
      $('connection').classList.remove('outdated');
    }
    extensionVersion = data.version || null;
    $('setup-button').textContent = 'Details'; updateSetup(); render(); return;
  }
  const chat = [...chats.values()].find(c => c.pending?.id === data.id);
  if (!chat) return;
  if (data.debug) { chat.extraction = data.debug; if (chat.id === current) showExtraction(chat); }
  if (data.type === 'progress') {
    chat.browserProgress = data.message;
    chat.progress = data.message;
    if (chat.id === current) render();
  } else if (data.type === 'reply') {
    try {
      chat.epoch = (chat.epoch || 0) + 1;
      const updated = await api(`chats/${chat.id}/reply`, {turn: data.id, text: data.text});
      Object.assign(chat, updated, {manual:false}); if (chat.id === current) { render(); $('prompt').focus(); }
    } catch (e) { chat.manual = true; chat.manualReason = e.message; if (chat.id === current) {render(); error(e.message);} }
  } else if (data.type === 'error') {
    chat.manual = true; chat.manualReason = data.message + ' Use the filtered message below to continue manually.';
    if (chat.id === current) render();
  }
});
$('composer').onsubmit = event => { event.preventDefault(); send(); };
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {event.preventDefault(); send();} };
$('prompt').oninput = () => {
  $('character-count').textContent = $('prompt').value.length.toLocaleString();
  $('send').disabled = busy(chats.get(current)) || !$('prompt').value.trim();
  fitComposer();
};
// A paste lands after the event, and rewrapping on resize changes the height.
$('prompt').addEventListener('paste', () => setTimeout(fitComposer, 0));
window.addEventListener('resize', fitComposer);
fitComposer();
$('new-chat').onclick = newChat;
let sidebarCollapsed = false;
try { sidebarCollapsed = localStorage.getItem('sidebar') === 'collapsed'; } catch {}
applySidebar(sidebarCollapsed);
$('collapse').onclick = () => {
  sidebarCollapsed = !sidebarCollapsed;
  applySidebar(sidebarCollapsed);
  try { localStorage.setItem('sidebar', sidebarCollapsed ? 'collapsed' : ''); } catch {}
};
$('compare-toggle').onchange = () => { selectedComparison = null; render(); };
$('setup-button').onclick = () => { updateSetup(); askStatus(); $('setup').showModal(); };
$('close-setup').onclick = () => $('setup').close();
$('cancel').onclick = async () => {
  const chat = chats.get(current); if (!chat) return;
  try {
    if (chat.pending) window.postMessage({source: 'private-chat-page', type: 'cancel', id: chat.pending.id}, location.origin);
    chat.epoch = (chat.epoch || 0) + 1;
    Object.assign(chat, await api(`chats/${chat.id}/cancel`), {manual:false}); render();
  } catch (e) { error(e.message); }
};
$('copy-extraction').onclick = async () => {
  try { await navigator.clipboard.writeText($('extraction-text').textContent); $('status-text').textContent = 'Extraction details copied'; }
  catch { error('Clipboard is unavailable. Select the text above to copy it.'); }
};
$('copy-outbound').onclick = async () => {
  try { await navigator.clipboard.writeText(chats.get(current).pending.outbound); $('status-text').textContent = 'Filtered message copied'; }
  catch { error('Clipboard is unavailable. Copy from the full message in Side by side.'); }
};
$('restore-reply').onclick = async () => {
  const chat = chats.get(current); if (!chat?.pending) return;
  try {
    chat.epoch = (chat.epoch || 0) + 1;
    Object.assign(chat, await api(`chats/${chat.id}/reply`, {turn: chat.pending.id, text: $('manual-reply').value}), {manual:false});
    $('manual-reply').value = ''; error(''); render();
  } catch(e) { error(e.message); }
};
// Review mode: the message waits here until it is approved, and marking can
// only ever hide more of it.
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  const inside = selection.rangeCount && $('review-text').contains(selection.getRangeAt(0).commonAncestorContainer);
  selected = inside ? selection.toString().trim() : '';
  $('mark-selection').disabled = !selected;
  $('review-selection').textContent = selected ? 'Selected: ' + (selected.length > 60 ? selected.slice(0, 60) + '…' : selected) : 'Select text above to mark it.';
});
$('mark-selection').onclick = async () => {
  const chat = chats.get(current); if (!chat?.pending || !selected) return;
  try {
    Object.assign(chat, await api(`chats/${chat.id}/mark`, {turn: chat.pending.id, text: selected, kind: $('review-kind').value}));
    selected = ''; $('mark-selection').disabled = true; $('review-selection').textContent = 'Marked. Select anything else that should stay private.';
    error(''); render();
  } catch (e) { error(e.message); }
};
$('approve').onclick = async () => {
  const chat = chats.get(current); if (!chat?.pending) return;
  try {
    Object.assign(chat, await api(`chats/${chat.id}/approve`, {turn: chat.pending.id}));
    error(''); render(); await dispatch(chat);
  } catch (e) { error(e.message); }
};
$('review-discard').onclick = () => $('cancel').click();
$('review-toggle').onchange = () => { try { localStorage.setItem('review-mode', $('review-toggle').checked ? '1' : ''); } catch {} };
try { $('review-toggle').checked = localStorage.getItem('review-mode') === '1'; } catch {}
// Loopback polling only: this asks the local service for the state of a chat,
// and never touches ChatGPT. Back off while waiting on a reply so an idle page
// is not asking every second for minutes at a time.
function schedulePoll() {
  const waiting = [...chats.values()].some(chat => chat.state === 'sending');
  const idle = ![...chats.values()].some(busy);
  setTimeout(async () => { await poll(); schedulePoll(); }, idle ? 3000 : waiting ? 2500 : 1000);
}
schedulePoll();
// Appearance is per-browser, so it lives in this page rather than the server.
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
}
function storedTheme() { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } }
applyTheme(storedTheme());
$('theme').value = storedTheme();
$('theme').onchange = () => {
  applyTheme($('theme').value);
  try { localStorage.setItem('theme', $('theme').value); } catch {}
};

// The model's address is configuration, not page state: show what the server is
// actually using, and say which it is — a remote model sees text before it is
// filtered.
function showSettings(data) {
  const address = String(data.local_ai || '').replace(/^https?:\/\//, '');
  if (!address) return;
  $('setup-local-ai').textContent = `${address} · ${data.local_model}`;
  $('remote-note').hidden = !data.remote;
  $('ai-url').value = data.local_ai || '';
  $('ai-model').value = data.local_model || '';
  $('ai-remote').checked = Boolean(data.allow_remote_ai);
  $('instructions').value = data.instructions || '';
  $('detector-prompt').value = data.detector_prompt || '';
  if (data.default_detector_prompt) defaultDetector = data.default_detector_prompt;
  if (data.default_instructions) defaultInstructions = data.default_instructions;
  $('token-state').textContent = data.authenticated ? '· saved' : '· none set';
  if (data.config_path) $('config-path').textContent = data.config_path;
}
function settingsBody(extra) {
  return {local_ai: $('ai-url').value, local_model: $('ai-model').value,
          allow_remote_ai: $('ai-remote').checked, ai_auth_token: $('ai-token').value,
          instructions: $('instructions').value, detector_prompt: $('detector-prompt').value, ...extra};
}
function settingsStatus(message, failed) {
  $('settings-status').textContent = message;
  $('settings-status').classList.toggle('failed', Boolean(failed));
}
api('settings', null, 'GET').then(showSettings).catch(() => {});
api('health', null, 'GET').then(health => { packagedExtension = health.extension_version || null; }).catch(() => {});

// The filtering model is on the network: say what was actually checked, rather
// than showing a healthy light for a service nobody has spoken to.
async function checkModel() {
  try {
    const status = await api('model', null, 'GET');
    const address = String(status.endpoint || '').replace(/^https?:\/\//, '');
    modelDown = !status.reachable || status.installed === false;
    $('local-dot').classList.toggle('down', modelDown);
    $('local-ai').textContent = !status.reachable ? `No answer from ${address}`
      : status.installed === false ? `${status.model} missing on ${address}`
      : `${status.remote ? 'Remote' : 'Local'} AI: ${address} · ChatGPT replies`;
    modelReason = modelDown ? (status.reason || 'The filtering model is unavailable.') : '';
  } catch {
    modelDown = true;
    modelReason = 'The local service is not answering.';
    $('local-dot').classList.add('down');
    $('local-ai').textContent = 'Local service unavailable';
  }
  if (chats.get(current)) render();
}
checkModel();
// Once a minute is enough for a service that either answers or does not. A
// focus check keeps it responsive when you come back from a VPN; that request
// is loopback and normally served from the cache, so it adds no load.
setInterval(checkModel, 60000);
window.addEventListener('focus', checkModel);
$('settings-button').onclick = async () => {
  settingsStatus('');
  try { showSettings(await api('settings', null, 'GET')); } catch (e) { settingsStatus(e.message, true); }
  $('settings').showModal();
};
$('close-settings').onclick = () => $('settings').close();
$('save-settings').onclick = async () => {
  settingsStatus('Saving…');
  try {
    showSettings(await api('settings', settingsBody()));
    await checkModel();
    $('ai-token').value = '';
    settingsStatus('Saved. New messages use these settings.');
  } catch (e) { settingsStatus(e.message, true); }
};
$('test-settings').onclick = async () => {
  settingsStatus('Contacting the model service…');
  try {
    const result = await api('settings/test', settingsBody());
    settingsStatus(result.has_model
      ? `Reached it. ${$('ai-model').value} is installed (${result.models} models available).`
      : `Reached it, but ${$('ai-model').value} is not installed. Available: ${result.sample.join(', ') || 'none'}.`,
      !result.has_model);
  } catch (e) { settingsStatus(e.message, true); }
};
$('reset-detector').onclick = () => {
  $('detector-prompt').value = defaultDetector;
  settingsStatus('Default restored. Save to apply it.');
};
$('reset-instructions').onclick = () => {
  $('instructions').value = defaultInstructions;
  settingsStatus('Default restored. Save to apply it.');
};
$('clear-token').onclick = async () => {
  try {
    showSettings(await api('settings', settingsBody({ai_auth_token: '', clear_token: true})));
    $('ai-token').value = ''; settingsStatus('Token removed.');
  } catch (e) { settingsStatus(e.message, true); }
};
function ping() {
  window.postMessage({source:'private-chat-page',type:'ping'},location.origin);
  askStatus();
}
setInterval(ping, 3000); ping();
setTimeout(() => { if (!connected) $('connection-text').textContent = 'Connect the Chrome companion to use your ChatGPT account'; }, 1600);
newChat();
