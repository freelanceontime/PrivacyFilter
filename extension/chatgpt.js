// Uses only ChatGPT's visible website UI. It never reads cookies or auth tokens.
(() => {
  if (globalThis.__privateChatCompanion) return;
  globalThis.__privateChatCompanion = true;

  let running = null;
  // Temporary diagnostics: prints to the ChatGPT tab's own console so a failing
  // send can be traced. Safe to remove once the flow is confirmed working.
  const log = (...args) => { try { console.log('[PrivacyChat]', ...args); } catch {} };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const comparable = text => String(text ?? '').replace(/\u00a0/g, ' ').replace(/\s+/gu, ' ').trim();
  async function publish(message) {
    const attempts = (message.type === 'reply' || message.type === 'error') ? 8 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response?.ok && !response.error) return true;
      } catch {}
      if (attempt < attempts - 1) await delay(350);
    }
    return false;
  }
  // Layout-free: a hidden background tab may skip layout entirely, and
  // measuring boxes there reports the composer and its buttons as missing.
  const visible = element => Boolean(element) && rendered(element);
  // ChatGPT's composer is now a ProseMirror editor (it dropped the Lexical
  // attribute); keep the stable id first, then fall back on the editor's role.
  const editorElement = () => document.querySelector('#prompt-textarea,.ProseMirror[contenteditable="true"],[contenteditable="true"][data-lexical-editor="true"],[contenteditable="true"][role="textbox"]');
  const editorText = editor => editor instanceof HTMLTextAreaElement ? editor.value : editor?.innerText;
  const stopButton = () => [...document.querySelectorAll('[data-testid="stop-button"],button[aria-label^="Stop" i]')].find(visible);
  const streamingFlag = message => Boolean(message?.matches?.('[data-is-streaming="true"],.result-streaming') ||
    message?.querySelector?.('[data-is-streaming="true"],.result-streaming'));
  // ChatGPT has used both an inner data-message-author-role node and an outer
  // data-turn article for assistant turns. Canonicalise each match to its turn
  // so a page carrying both attributes is counted once.
  function assistantMessages() {
    const turns = [];
    const seen = new Set();
    const explicit = document.querySelectorAll(
      '[data-message-author-role="assistant"],[data-turn="assistant"],[data-role="assistant"],[data-author="assistant"],[data-testid*="assistant" i]'
    );
    for (const node of explicit) {
      const turn = node.closest('[data-testid^="conversation-turn-"],[data-turn="assistant"],article') || node;
      if (!seen.has(turn)) { seen.add(turn); turns.push(turn); }
    }
    // The current ChatGPT rollout exposes no author, turn, article, markdown,
    // prose, or paragraph marker for an answer. Its completed assistant action
    // bar is still stable. The action wrapper contains both an accessibility
    // copy of "You said" and the real "ChatGPT said" block, so select only the
    // sibling after the latter heading; reading the wrapper would send the
    // outbound prompt back as part of the answer.
    for (const button of document.querySelectorAll('button[aria-label="Read aloud"],button[aria-label="Regenerate response"]')) {
      const controls = button.closest('.turn-action-controls');
      const wrapper = controls?.parentElement;
      const heading = [...(wrapper?.querySelectorAll('h1,h2,h3,h4,h5,h6') || [])]
        .find(node => /^ChatGPT said:?$/i.test(node.innerText.trim()));
      const turn = heading?.nextElementSibling;
      if (turn && !seen.has(turn)) { seen.add(turn); turns.push(turn); }
    }
    // Current ChatGPT builds no longer expose an assistant-role attribute.
    // Answer bodies remain markdown/prose inside the main conversation, so use
    // those as a structural fallback. Baseline text tracking below prevents old
    // page content from being mistaken for the newly generated answer.
    for (const body of document.querySelectorAll('main .markdown,main .prose,main [class*="MarkdownRoot"],[role="main"] .markdown,[role="main"] .prose,[role="main"] [class*="MarkdownRoot"]')) {
      if (body.closest('form,nav,aside,[data-message-author-role="user"],[data-turn="user"],[data-role="user"],[data-author="user"]')) continue;
      const turn = body.closest('[data-testid^="conversation-turn-"],article') || body;
      if (!seen.has(turn)) { seen.add(turn); turns.push(turn); }
    }
    // Some rollouts remove the markdown/prose class as well but retain one
    // article (or numbered conversation-turn container) per message. On the
    // fresh page used by the companion there are no old conversation articles,
    // and the baseline map still guards against unrelated static content.
    for (const turn of document.querySelectorAll('article,[data-testid^="conversation-turn-"]')) {
      if (turn.closest('form,nav,aside') || turn.matches('[data-message-author-role="user"],[data-turn="user"],[data-role="user"],[data-author="user"]')) continue;
      if (!seen.has(turn)) { seen.add(turn); turns.push(turn); }
    }
    return turns;
  }
  // The current document-card rollout replaced the old markdown/prose class
  // with a generated MarkdownRoot-* class on the complete response body.
  const answerBody = message => {
    if (message?.matches?.('.markdown,.prose,[class*="MarkdownRoot"]')) return message;
    return message?.querySelector('[data-message-author-role="assistant"] .markdown,.markdown,[data-message-author-role="assistant"] .prose,.prose,[class*="MarkdownRoot"]');
  };
  const userMessages = () => document.querySelectorAll('[data-message-author-role="user"],[data-turn="user"],[data-role="user"],[data-author="user"]');
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
      const body = answerBody(message);
      const text = responseText(body || message);
      return {tag: message.tagName.toLowerCase(), testid: message.dataset?.testid || null,
        classes: String(message.className || '').split(/\s+/).filter(Boolean).slice(0, 3),
        markdown: Boolean(body), completed: completedTurn(message), rendered: rendered(message),
        length: text.length, head: text.slice(0, 80)};
    };
    // How the answer's own blocks are laid out, which is what decides spacing.
    const answer = [...assistantMessages()].reverse().find(answerBody);
    const outline = [...(answerBody(answer)?.children || [])].slice(0, 24).map(child => ({
      tag: child.tagName.toLowerCase(),
      kids: [...child.children].slice(0, 4).map(inner => inner.tagName.toLowerCase()),
      text: responseText(child).slice(0, 40)}));
    const state = {reason, version: chrome.runtime.getManifest().version, url: location.pathname,
      stopButton: Boolean(stopButton()), streamingFlag: streamingFlag(answer),
      assistants: assistantMessages().slice(-3).map(describe), outline};
    return JSON.stringify(state).slice(0, 7500);
  }

  function structuralOutline() {
    const signature = element => ({tag: element.tagName.toLowerCase(), id: element.id || null,
      testid: element.dataset?.testid || null, turn: element.dataset?.turn || null,
      role: element.getAttribute('role'), classes: String(element.className || '').split(/\s+/).filter(Boolean).slice(0, 4)});
    return [...document.querySelectorAll('p')].slice(-8).map(paragraph => {
      const chain = [];
      for (let node = paragraph, depth = 0; node && depth < 5; node = node.parentElement, depth++) chain.push(signature(node));
      return chain;
    });
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
      (tag === 'PRE' || (node.querySelector(COPY_CONTROL) && length > 40 && options.whole - length >= 16));
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
    return userMessages().length > beforeUsers ||
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
    // A synthetic paste is the gentlest insertion, but a content script runs in
    // an isolated world and ChatGPT's ProseMirror editor reads an empty
    // clipboard from a cross-world DataTransfer, so it inserts nothing. Try it
    // briefly, then drive the editor with execCommand, which routes through the
    // browser's own input pipeline and ProseMirror honours.
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    const handled = !editor.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:transfer}));
    if (handled && await settled(editor, expected, 12)) { log('inserted via paste'); return; }
    log('paste did not populate the editor; using execCommand');
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
      if (await settled(editor, expected, 25)) { log('inserted via execCommand on attempt', attempt); return; }
      log('execCommand attempt', attempt, 'did not settle; editor now:', comparable(editorText(editor)).slice(0, 40));
    }
  }

  async function run(job) {
    running = job;
    log('run() started for job', job.id, 'at', location.pathname);
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
    log('editor found:', editor.id || editor.className || editor.tagName);
    if (userMessages().length || String(editorText(editor) ?? '').trim()) {
      throw new Error('The ChatGPT tab contains a conversation or draft. Start a new message from Privacy Chat.');
    }

    await publish({type:'progress', id:job.id, message:'Sending your filtered message to ChatGPT…'});
    await insertFilteredText(editor, job.text);
    if (comparable(editorText(editor)) !== comparable(job.text)) {
      throw new Error('Could not verify the filtered text in ChatGPT\'s editor. Nothing was submitted.');
    }
    await publish({type:'progress', id:job.id, message:'Filtered text verified; submitting to ChatGPT…'});

    log('text inserted and verified; locating send button');
    let button;
    for (let index = 0; index < 8 && running === job; index++) {
      button = sendButton(editor);
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') break;
      await delay(250);
    }
    if (running !== job) return;
    log('send button:', button ? (button.id || button.getAttribute('aria-label') || button.dataset.testid) : 'NONE',
        'disabled:', button ? (button.disabled || button.getAttribute('aria-disabled') === 'true') : 'n/a');
    // Keep the actual nodes and their text. Counting alone misses a reply when
    // ChatGPT reuses a placeholder turn or replaces one container with another.
    const beforeAssistants = new Map(assistantMessages().map(message =>
      [message, responseText(answerBody(message) || message, true)]));
    const beforeUsers = userMessages().length;
    let submitted = false;

    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
      button.click();
      submitted = await waitForSubmission(editor, beforeUsers, job);
      log('after button.click(), submitted:', submitted);
    }
    if (!submitted) {
      const form = editor.closest('form');
      log('button path failed; form present:', !!form, '- trying requestSubmit');
      if (form) {
        try { form.requestSubmit(button?.matches('[type="submit"]') ? button : undefined); }
        catch { form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); }
        submitted = await waitForSubmission(editor, beforeUsers, job);
        log('after form submit, submitted:', submitted);
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
    log('submitted; watching for the reply. assistant turns before submit:', beforeAssistants.size);
    let lastText = '';
    let lastLog = 0;
    let outlined = false;
    let stableSince = Date.now();
    // How long this answer actually paused between chunks while streaming. The
    // wait for "finished" is measured against that rather than a fixed guess,
    // so a smooth answer lands quickly and a halting one still gets its time.
    let longestGap = 0;
    // A hidden tab can be throttled hard enough that nothing readable appears.
    // Ask once for it to be brought forward briefly rather than time out.
    let woken = false;
    const readingSince = Date.now();
    while (Date.now() < replyDeadline && running === job) {
      await delay(300);
      const messages = assistantMessages();
      const changed = messages.filter(message => {
        const body = answerBody(message);
        const text = responseText(body || message, true);
        return !beforeAssistants.has(message) || beforeAssistants.get(message) !== text;
      });
      if (!changed.length) {
        if (Date.now() - lastLog > 3000) {
          lastLog = Date.now();
          log('no new assistant turn yet. current count:', messages.length);
          if (!outlined) { outlined = true; log('current paragraph structure:', structuralOutline()); }
        }
        continue;
      }
      // ChatGPT can keep a status element as the last assistant node while the
      // answer sits in an earlier one, so prefer the last turn that has a body.
      const latest = [...changed].reverse().find(answerBody) || changed[changed.length - 1];
      const completed = completedTurn(latest);
      // ChatGPT renders its own progress inside the turn, body and all, so the
      // candidate is judged by what it says: a status word is never an answer.
      const body = answerBody(latest);
      const candidate = responseText(body || latest, true);
      const text = STATUS_TEXT.test(candidate) ? '' : candidate;
      if (text !== lastText) {
        if (lastText) longestGap = Math.max(longestGap, Date.now() - stableSince);
        lastText = text;
        stableSince = Date.now();
      }
      if (!text && !woken && Date.now() - readingSince > 20000) {
        woken = true;
        await publish({type:'wake', id:job.id});
      }
      if (!text) continue;
      // The visible Stop button is tied to active generation. ChatGPT sometimes
      // leaves data-is-streaming on a completed turn, so that attribute is only
      // diagnostic and must not block a finished answer forever.
      if (stopButton()) continue;
      // We only reach here with a non-empty answer while ChatGPT is NOT
      // generating (no stop control, no streaming flag), so the answer has
      // stopped growing. The turn's action bar is the fastest finish signal;
      // when it hasn't rendered yet — which the current UI often delays, and
      // which used to strand short replies — fall back on the answer simply
      // holding still for a few seconds. The length no longer gates this, so a
      // one-word reply returns too.
      const settled = Date.now() - stableSince;
      const quiet = Math.min(Math.max(1200, longestGap * 3), 8000);
      const fallbackQuiet = Math.max(quiet, 6000);
      if (Date.now() - lastLog > 3000) {
        lastLog = Date.now();
        log('reply progress — completed:', completed, 'streamingFlag:', streamingFlag(latest), 'chars:', text.length, 'stableFor:', settled, 'need:', completed ? quiet : fallbackQuiet);
      }
      if (completed ? settled > quiet : settled > fallbackQuiet) {
        log('reply captured, length', text.length, '— sending back to Privacy Chat');
        if (await publish({type:'reply', id:job.id, text, debug: snapshot('captured')})) {
          running = null;
          return;
        }
        log('reply delivery was not acknowledged; retaining it and retrying');
      }
    }
    if (running === job) throw new Error('No complete reply was detected. Check the ChatGPT tab and paste its reply manually.');
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    log('message received:', message.type);
    if (message.type === 'inspect') {
      const editor = editorElement();
      const text = editorText(editor);
      const noConversation = !userMessages().length;
      respond({ready:visible(editor), fresh:visible(editor) && noConversation && !String(text ?? '').trim(),
        ownDraft:visible(editor) && noConversation && String(text ?? '').includes('[[PRIVATE_')});
    } else if (message.type === 'clear-own-draft') {
      const editor = editorElement();
      const text = editorText(editor);
      const ownDraft = visible(editor) && !userMessages().length &&
        String(text ?? '').includes('[[PRIVATE_');
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
        log('run() failed:', error.message);
        if (running === job) { running = null; await publish({type:'error', id:job.id, message:error.message, debug:snapshot('failed')}); }
      });
      respond({ok:true});
    } else if (message.type === 'cancel' && running?.id === message.id) {
      running = null; stopButton()?.click(); respond({ok:true});
    }
  });
  log('content script loaded on', location.pathname, 'version', chrome.runtime.getManifest().version);
  publish({type:'chat-ready',version:chrome.runtime.getManifest().version});
})();
