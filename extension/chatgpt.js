// Uses only ChatGPT's visible website UI. It never reads cookies or auth tokens.
(() => {
  if (globalThis.__privateChatCompanion) return;
  globalThis.__privateChatCompanion = true;

  let running = null;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const comparable = text => String(text ?? '').replace(/\u00a0/g, ' ').replace(/\s+/gu, ' ').trim();
  const publish = message => chrome.runtime.sendMessage(message).catch(() => {});
  // Layout-free: a hidden background tab may skip layout entirely, and
  // measuring boxes there reports the composer and its buttons as missing.
  const visible = element => Boolean(element) && rendered(element);
  const editorElement = () => document.querySelector('#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"]');
  const editorText = editor => editor instanceof HTMLTextAreaElement ? editor.value : editor?.innerText;
  const stopButton = () => [...document.querySelectorAll('[data-testid="stop-button"],button[aria-label^="Stop" i]')].find(visible);
  // Streaming is signalled by the stop control or by the turn's own state flag;
  // either one means the answer is not finished.
  const generating = () => Boolean(stopButton()) || Boolean(document.querySelector('[data-is-streaming="true"],.result-streaming'));
  const assistantMessages = () => [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  // A turn only grows its action bar once the answer is complete. The bar must
  // be this message's own: a user turn carries the same buttons, and matching
  // those would treat a status placeholder as a finished answer.
  const COMPLETED = '[data-testid$="turn-action-button"],button[aria-label="Copy response"],button[aria-label="Copy"],button[aria-label="Read aloud"],button[aria-label="Good response"]';
  function completedTurn(message) {
    const turn = message.closest('[data-testid^="conversation-turn-"]') || message.closest('article') || message.parentElement?.parentElement;
    return [...(turn?.querySelectorAll(COMPLETED) || [])].some(button =>
      !button.closest('[data-message-author-role="user"]') &&
      (message.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
  // ChatGPT marks a copyable document or code sample with its own copy control.
  const COPY_CONTROL = 'button[aria-label*="copy" i],button[data-testid*="copy" i],[role="button"][aria-label*="copy" i]';
  const FENCE = '```';
  const SKIPPED = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION', 'VIDEO', 'AUDIO', 'CANVAS']);
  const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
    'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
    'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
  const SPACED = new Set(['BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'OL', 'P', 'PRE', 'TABLE', 'UL']);

  // Screen-reader duplicates are clipped to about a pixel rather than hidden,
  // and ChatGPT ships them for headings and for its follow-up chips. This has
  // to judge them from style alone: a background tab may skip layout entirely,
  // and measuring boxes there reports every element as empty.
  function rendered(element) {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (/rect\(0px(,\s*0px){3}\)/.test(style.clip) || style.clipPath === 'inset(50%)') return false;
    const width = Number.parseFloat(style.width);
    const height = Number.parseFloat(style.height);
    return !(width <= 1 && height <= 1 && style.position === 'absolute');
  }

  // ChatGPT's progress labels, which share the turn with the eventual answer.
  const STATUS_TEXT = /^(writing|thinking|searching|reasoning|analysing|analyzing|working|generating|typing|responding|reading)[\s.…]*$/i;

  // A structural summary of what the extractor saw, for diagnosing a capture
  // that went wrong. It carries the redacted text ChatGPT already holds, never
  // anything private, and only ever reaches the local page.
  function snapshot(reason) {
    const describe = message => {
      const body = message.querySelector('.markdown');
      const text = responseText(body || message);
      return {tag: message.tagName.toLowerCase(), testid: message.dataset?.testid || null,
        classes: String(message.className || '').split(/\s+/).filter(Boolean).slice(0, 3),
        markdown: Boolean(body), completed: completedTurn(message), rendered: rendered(message),
        length: text.length, head: text.slice(0, 80)};
    };
    // How the answer's own blocks are laid out, which is what decides spacing.
    const answer = [...assistantMessages()].reverse().find(message => message.querySelector('.markdown'));
    const outline = [...(answer?.querySelector('.markdown')?.children || [])].slice(0, 24).map(child => ({
      tag: child.tagName.toLowerCase(),
      kids: [...child.children].slice(0, 4).map(inner => inner.tagName.toLowerCase()),
      text: responseText(child).slice(0, 40)}));
    const state = {reason, version: chrome.runtime.getManifest().version, url: location.pathname,
      stopButton: Boolean(stopButton()), streamingFlag: Boolean(document.querySelector('[data-is-streaming="true"],.result-streaming')),
      assistants: assistantMessages().slice(-3).map(describe), outline};
    return JSON.stringify(state).slice(0, 7500);
  }

  function listMarker(item) {
    const list = item.parentElement;
    if (list?.tagName !== 'OL') return '• ';
    const start = Number.parseInt(list.getAttribute('start') || '1', 10);
    const value = Number.parseInt(item.getAttribute('value') || '', 10);
    const index = [...list.children].filter(child => child.tagName === 'LI').indexOf(item);
    return (Number.isFinite(value) ? value : (Number.isFinite(start) ? start : 1) + index) + '. ';
  }

  // innerText needs layout and collapses to textContent on a detached clone, so
  // walk the live nodes and rebuild the block structure explicitly.
  function collect(node, out, options) {
    if (node.nodeType === Node.TEXT_NODE) { out.parts.push({text: node.textContent, pre: options.pre}); out.afterMarker = false; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (SKIPPED.has(tag) || node.getAttribute('role') === 'button') return;
    // A line break generates no box of its own, so it has to be read before the
    // visibility filter, which would otherwise drop every single-line break.
    if (tag === 'BR') { out.parts.push({gap: 1}); return; }
    if (!rendered(node)) return;
    // ChatGPT frames a returned document or code sample in a container with its
    // own copy control. Fence it so the local page can present it as a block
    // beside the prose, the way ChatGPT does.
    // Never the message itself: ChatGPT's turn controls live inside the body,
    // so a wrapper holding the whole reply would otherwise become one block and
    // swallow its own commentary.
    const length = node.textContent.trim().length;
    const fenced = options.fence && !options.inBlock && !options.root &&
      (tag === 'PRE' || (node.querySelector(COPY_CONTROL) && length > 40 && length < options.whole * 0.95));
    if (fenced) out.parts.push({gap: 2}, {text: tag === 'PRE' ? FENCE + 'code' : FENCE}, {gap: 1});
    // ChatGPT lays parts of a reply out with CSS rather than block tags, so the
    // computed display decides what starts a new line. A preformatted
    // white-space rule means the element's own newlines are content.
    const style = window.getComputedStyle(node);
    const pre = options.pre || tag === 'PRE' || /^(pre|pre-wrap|pre-line|break-spaces)$/.test(style.whiteSpace);
    const blockish = !/^(inline|contents|ruby)/.test(style.display);
    const item = options.item || tag === 'LI';
    // ChatGPT wraps list item text in its own paragraph. Keeping paragraph
    // spacing there would put a blank line between every number and its step,
    // so blocks inside an item stay tight and the first one joins the marker.
    let gap = SPACED.has(tag) ? 2 : (BLOCKS.has(tag) || blockish) ? 1 : 0;
    if (item && gap) gap = 1;
    if (gap) { if (out.afterMarker) out.afterMarker = false; else out.parts.push({gap}); }
    if (tag === 'LI') { out.parts.push({text: listMarker(node)}); out.afterMarker = true; }
    if ((tag === 'TD' || tag === 'TH') && node.previousElementSibling) out.parts.push({text: ' | '});
    for (const child of node.childNodes) collect(child, out,
      {pre, item, fence: options.fence, inBlock: options.inBlock || fenced, root: false, whole: options.whole});
    if (gap) out.parts.push({gap});
    if (fenced) out.parts.push({gap: 1}, {text: FENCE}, {gap: 2});
  }

  function responseText(source, fence) {
    if (!source) return '';
    const out = {parts: [], afterMarker: false};
    collect(source, out, {pre: false, item: false, fence: Boolean(fence), inBlock: false,
      root: true, whole: source.textContent.trim().length});
    let text = '';
    let gap = 0;
    for (const part of out.parts) {
      if (part.gap) { gap = Math.max(gap, part.gap); continue; }
      const chunk = part.pre ? part.text : part.text.replace(/\s+/g, ' ');
      if (!chunk || (!part.pre && !chunk.trim() && !text)) continue;
      if (!text) { text = chunk.replace(/^\s+/, ''); }
      else if (gap) { text = text.replace(/[ \t]+$/, '') + '\n'.repeat(gap) + (part.pre ? chunk : chunk.replace(/^ +/, '')); }
      else if (text.endsWith(' ') && chunk.startsWith(' ')) { text += chunk.slice(1); }
      else { text += chunk; }
      gap = 0;
    }
    // ChatGPT renders some lists with the bullet in a block of its own, so the
    // marker and its text are siblings rather than one item. Join a line that
    // holds nothing but a marker to the text underneath it, whatever produced it.
    return text.replace(/[ \t]+\n/g, '\n')
      .replace(/^[ \t]*((?:[•▪◦‣∙·•]|\d{1,3}[.)]))[ \t]*\n+[ \t]*(?=\S)/gm, '$1 ')
      // Consecutive items belong together rather than drifting apart.
      .replace(/^((?:[•▪◦‣∙·•]|\d{1,3}[.)])[ \t].*)\n{2,}(?=(?:[•▪◦‣∙·•]|\d{1,3}[.)])[ \t])/gm, '$1\n')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  function sendButton(editor) {
    const scope = editor?.closest('form') || editor?.parentElement?.parentElement || document;
    return [...scope.querySelectorAll('#composer-submit-button,[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label^="Send"],button[type="submit"]')]
      .find(button => visible(button) && !button.matches('[data-testid="stop-button"]'));
  }

  function submissionStarted(editor, beforeUsers) {
    return document.querySelectorAll('[data-message-author-role="user"]').length > beforeUsers ||
      Boolean(stopButton()) || !String(editorText(editorElement() || editor) ?? '').trim();
  }

  async function waitForSubmission(editor, beforeUsers, job, attempts = 12) {
    for (let index = 0; index < attempts && running === job; index++) {
      if (submissionStarted(editor, beforeUsers)) return true;
      await delay(250);
    }
    return false;
  }

  function clearEditor(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false);
    editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'deleteContentBackward'}));
  }

  // Rich editors apply a handled paste over several asynchronous updates, so the
  // composer holds a partial payload for a moment. Wait for the exact text and
  // for it to stop changing; anything else is a partial or duplicated insertion.
  async function settled(editor, expected, attempts) {
    let stable = 0;
    for (let index = 0; index < attempts; index++) {
      if (comparable(editorText(editor)) === expected) { if (++stable >= 3) return true; } else stable = 0;
      await delay(60);
    }
    return false;
  }

  async function insertFilteredText(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text);
      editor.dispatchEvent(new Event('input', {bubbles:true}));
      return;
    }
    const expected = comparable(text);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    const handled = !editor.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:transfer}));
    if (handled && await settled(editor, expected, 50)) return;
    // The paste was ignored, arrived incomplete, or was applied twice. Replace
    // whatever the composer holds with one deterministic insertion.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (String(editorText(editor) ?? '').trim()) clearEditor(editor);
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, text)) throw new Error('ChatGPT\'s editor changed. Use the manual copy option.');
      editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
      if (await settled(editor, expected, 25)) return;
    }
  }

  async function run(job) {
    running = job;
    const replyDeadline = Date.now() + 240000;
    const editorDeadline = Date.now() + 20000;
    let editor;
    let asked = false;
    while (Date.now() < editorDeadline && running === job) {
      editor = editorElement();
      if (visible(editor)) break;
      if (!asked && Date.now() > editorDeadline - 16000) { asked = true; await publish({type:'wake', id:job.id}); }
      await delay(500);
    }
    if (running !== job) return;
    if (!visible(editor)) throw new Error('ChatGPT is not ready. Complete sign-in and try again.');
    if (document.querySelector('[data-message-author-role="user"]') || String(editorText(editor) ?? '').trim()) {
      throw new Error('The ChatGPT tab contains a conversation or draft. Start a new message from Private Chat.');
    }

    await publish({type:'progress', id:job.id, message:'Sending your filtered message to ChatGPT…'});
    await insertFilteredText(editor, job.text);
    if (comparable(editorText(editor)) !== comparable(job.text)) {
      throw new Error('Could not verify the filtered text in ChatGPT\'s editor. Nothing was submitted.');
    }
    await publish({type:'progress', id:job.id, message:'Filtered text verified; submitting to ChatGPT…'});

    let button;
    for (let index = 0; index < 8 && running === job; index++) {
      button = sendButton(editor);
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') break;
      await delay(250);
    }
    if (running !== job) return;
    const beforeAssistants = assistantMessages().length;
    const beforeUsers = document.querySelectorAll('[data-message-author-role="user"]').length;
    let submitted = false;

    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
      button.click();
      submitted = await waitForSubmission(editor, beforeUsers, job);
    }
    if (!submitted) {
      const form = editor.closest('form');
      if (form) {
        try { form.requestSubmit(button?.matches('[type="submit"]') ? button : undefined); }
        catch { form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); }
        submitted = await waitForSubmission(editor, beforeUsers, job);
      }
    }
    if (!submitted) {
      await publish({type:'progress', id:job.id, message:'Trying ChatGPT’s keyboard submission path…'});
      for (const type of ['keydown', 'keypress', 'keyup']) {
        editor.dispatchEvent(new KeyboardEvent(type, {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true}));
      }
      submitted = await waitForSubmission(editor, beforeUsers, job, 20);
    }
    if (!submitted) {
      const scope = editor.closest('form') || document;
      const controls = [...scope.querySelectorAll('button')].map(item => ({
        id:item.id || null, label:item.getAttribute('aria-label'), testid:item.dataset.testid || null,
        disabled:item.disabled || item.getAttribute('aria-disabled') === 'true'
      })).slice(-8);
      throw new Error('ChatGPT did not accept the message. Nothing was submitted. Composer controls: ' + JSON.stringify(controls));
    }

    await publish({type:'progress', id:job.id, message:'ChatGPT is writing a reply…'});
    let lastText = '';
    let stableSince = Date.now();
    // A hidden tab can be throttled hard enough that nothing readable appears.
    // Ask once for it to be brought forward briefly rather than time out.
    let woken = false;
    const readingSince = Date.now();
    while (Date.now() < replyDeadline && running === job) {
      await delay(600);
      const messages = assistantMessages();
      if (messages.length <= beforeAssistants) continue;
      // ChatGPT can keep a status element as the last assistant node while the
      // answer sits in an earlier one, so prefer the last turn that has a body.
      const latest = [...messages].reverse().find(message => message.querySelector('.markdown')) || messages[messages.length - 1];
      const completed = completedTurn(latest);
      // ChatGPT renders its own progress inside the turn, body and all, so the
      // candidate is judged by what it says: a status word is never an answer.
      const body = latest.querySelector('.markdown');
      const candidate = body ? responseText(body, true) : responseText(latest);
      const text = STATUS_TEXT.test(candidate) ? '' : candidate;
      if (text !== lastText) { lastText = text; stableSince = Date.now(); }
      if (!text && !woken && Date.now() - readingSince > 20000) {
        woken = true;
        await publish({type:'wake', id:job.id});
      }
      if (!text || generating()) { stableSince = Date.now(); continue; }
      // The turn's own action bar is the only dependable finish signal. Without
      // it, accept only a substantial answer that has stood still far longer
      // than any pause in a stream, so a placeholder can never qualify.
      // A finished answer never changes again, so waiting costs only seconds,
      // while a mid-stream pause that outlasts this is rare. Truncating an
      // answer is far worse than taking longer to accept one.
      const settled = Date.now() - stableSince;
      if (completed ? settled > 6000 : text.length >= 200 && settled > 20000) {
        await publish({type:'reply', id:job.id, text, debug: snapshot('captured')});
        running = null;
        return;
      }
    }
    if (running === job) throw new Error('No complete reply was detected. Check the ChatGPT tab and paste its reply manually.');
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'inspect') {
      const editor = editorElement();
      const text = editorText(editor);
      const noConversation = !document.querySelector('[data-message-author-role="user"]');
      respond({ready:visible(editor), fresh:visible(editor) && noConversation && !String(text ?? '').trim(),
        ownDraft:visible(editor) && noConversation && String(text ?? '').trim().startsWith('Answer the conversation below. Tokens in the form [[PRIVATE_')});
    } else if (message.type === 'clear-own-draft') {
      const editor = editorElement();
      const text = editorText(editor);
      const ownDraft = visible(editor) && !document.querySelector('[data-message-author-role="user"]') &&
        String(text ?? '').trim().startsWith('Answer the conversation below. Tokens in the form [[PRIVATE_');
      if (!ownDraft) { respond({ok:false}); return; }
      editor.focus();
      if (editor instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, '');
        editor.dispatchEvent(new Event('input', {bubbles:true}));
      } else {
        const selection = window.getSelection(); const range = document.createRange();
        range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
        document.execCommand('delete', false);
        editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'deleteContentBackward'}));
      }
      respond({ok:!String(editorText(editor) ?? '').trim()});
    } else if (message.type === 'probe') {
      publish({type:'chat-ready',version:chrome.runtime.getManifest().version}); respond({ok:true});
    } else if (message.type === 'run' && !running) {
      const job = {id:message.id, text:message.text};
      run(job).catch(async error => {
        if (running === job) { running = null; await publish({type:'error', id:job.id, message:error.message, debug:snapshot('failed')}); }
      });
      respond({ok:true});
    } else if (message.type === 'cancel' && running?.id === message.id) {
      running = null; stopButton()?.click(); respond({ok:true});
    }
  });
  publish({type:'chat-ready',version:chrome.runtime.getManifest().version});
})();
