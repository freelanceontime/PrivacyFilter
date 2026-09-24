// This script has no cookie permission and never reads the local page's DOM.
if (location.origin === 'http://127.0.0.1:8787') {
  const publish = data => window.postMessage({source: 'private-chat-companion', ...data}, location.origin);
  const connected = () => { try { return Boolean(chrome.runtime?.id); } catch { return false; } };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'private-chat-page') return;
    const data = event.data;
    // Reloading the extension orphans this script: every chrome.* call then
    // throws, so a send would disappear without reaching the companion.
    if (!connected()) { publish({type:'stale'}); return; }
    if (data.type === 'ping') { publish({type:'ready',version:chrome.runtime.getManifest().version}); return; }
    if (!['send','cancel'].includes(data.type) || typeof data.id !== 'string' || data.id.length > 80) return;
    if (data.type === 'send' && (typeof data.text !== 'string' || data.text.length > 100000)) return;
    try {
      chrome.runtime.sendMessage({type:data.type,id:data.id,...(data.type === 'send' ? {text:data.text} : {})}, response => {
        if (chrome.runtime.lastError) publish({type:'error',id:data.id,message:'The Chrome companion disconnected. Reload the local page.'});
        else if (response?.error) publish({type:'error',id:data.id,message:response.error});
      });
    } catch {
      publish({type:'stale'});
      publish({type:'error',id:data.id,message:'The companion was updated. Reload this page, then send again.'});
    }
  });
  chrome.runtime.onMessage.addListener(message => {
    if (['reply','error','progress'].includes(message.type)) publish(message);
  });
}
