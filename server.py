#!/usr/bin/env python3
"""Loopback-only chat and redaction server. No ChatGPT credentials or cloud client."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import logging
from pathlib import Path
import secrets
import threading
import time
import urllib.error
import urllib.request

from flask import Flask, jsonify, request, session, send_from_directory

CONFIG = Path(__file__).resolve().parent / 'config.json'


def load_config():
    """Optional local overrides, applied before the detector reads them.

    An environment variable still wins, so a launcher can override the file.
    """
    try:
        data = json.loads(CONFIG.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return
    except (OSError, ValueError) as error:
        print(f'Ignoring {CONFIG.name}: {error}', flush=True)
        return
    for key, name in (('local_ai', 'PI_PRIVACY_ENDPOINT'), ('local_model', 'PI_PRIVACY_MODEL'),
                      ('ai_auth_token', 'PI_PRIVACY_AUTH_TOKEN'),
                      ('instructions', 'PRIVATE_CHAT_INSTRUCTIONS'),
                      ('detector_prompt', 'PRIVATE_CHAT_DETECTOR_PROMPT')):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            os.environ.setdefault(name, value.strip())
    if data.get('allow_remote_ai') is True:
        os.environ.setdefault('PI_PRIVACY_ALLOW_REMOTE', '1')


load_config()
import privacy_engine
from privacy_engine import Blocked, detector, mark_value, prepare, restore

# Python modules here are imported once at start, so a pull that changes this
# file only takes effect after a restart. Update Private Chat.cmd does that.
app = Flask(__name__, static_folder='static')
app.secret_key = secrets.token_bytes(32)
logging.getLogger('werkzeug').setLevel(logging.ERROR)
app.config.update(MAX_CONTENT_LENGTH=1024 * 1024, SESSION_COOKIE_HTTPONLY=True,
                  SESSION_COOKIE_SAMESITE='Strict', SESSION_COOKIE_NAME='private_chat_session')
STARTED = time.time()
PORT = 8787
ORIGIN = f'http://127.0.0.1:{PORT}'
lock = threading.RLock()
chats = {}
executor = ThreadPoolExecutor(max_workers=2)


@app.before_request
def local_boundary():
    if request.host != f'127.0.0.1:{PORT}':
        return jsonify(error=f'Open {ORIGIN} to use Privacy Chat.'), 403
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        if request.headers.get('Origin') != ORIGIN or request.headers.get('X-Private-Chat') != '1':
            return jsonify(error='This request must come from the local chat page.'), 403
        if not request.is_json:
            return jsonify(error='Expected JSON.'), 415
    if 'owner' not in session:
        session['owner'] = secrets.token_urlsafe(32)


@app.after_request
def security_headers(response):
    response.headers.update({
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
    return response


def packaged_extension_version():
    """The companion version in this folder, which a browser may not have loaded."""
    try:
        return json.loads((Path(__file__).resolve().parent / 'extension' / 'manifest.json')
                          .read_text(encoding='utf-8')).get('version')
    except (OSError, ValueError, AttributeError):
        return None


@app.get('/api/health')
def health():
    # The address and whether it is authenticated, never the credential itself.
    return jsonify(app='private-chat-web', started=STARTED, local_model=detector.configured_local_model(),
                   local_ai=detector.configured_local_endpoint(),
                   remote=detector.is_remote(), authenticated=bool(detector.auth_header()),
                   extension_version=packaged_extension_version())


def current_settings():
    return {'local_ai': detector.configured_local_endpoint(), 'local_model': detector.configured_local_model(),
            'allow_remote_ai': detector.remote_allowed(), 'remote': detector.is_remote(),
            'authenticated': bool(detector.auth_header()), 'config_path': str(CONFIG),
            'instructions': (os.environ.get('PRIVATE_CHAT_INSTRUCTIONS', '').strip()
                             or privacy_engine.INSTRUCTIONS.strip()),
            'default_instructions': privacy_engine.INSTRUCTIONS.strip(),
            'detector_prompt': (os.environ.get('PRIVATE_CHAT_DETECTOR_PROMPT', '').strip()
                                or detector.DETECTOR_PROMPT),
            'default_detector_prompt': detector.DETECTOR_PROMPT}


def requested(body):
    """Validate a settings change without applying it."""
    endpoint = str(body.get('local_ai') or '').strip().rstrip('/')
    model = str(body.get('local_model') or '').strip()
    allow_remote = bool(body.get('allow_remote_ai'))
    if not endpoint or len(endpoint) > 300:
        raise Blocked('Enter the address of the model service.')
    if not model or len(model) > 120:
        raise Blocked('Enter the model name.')
    was = os.environ.get('PI_PRIVACY_ALLOW_REMOTE', '')
    os.environ['PI_PRIVACY_ALLOW_REMOTE'] = '1' if allow_remote else ''
    try:
        endpoint = detector.approved_endpoint(endpoint)
    finally:
        os.environ['PI_PRIVACY_ALLOW_REMOTE'] = was
    token = body.get('ai_auth_token')
    if body.get('clear_token'):
        token = ''
    elif not isinstance(token, str) or not token.strip():
        token = os.environ.get('PI_PRIVACY_AUTH_TOKEN', '')  # blank means "leave it alone"
    if len(token) > 500:
        raise Blocked('That token is too long.')
    text = body.get('instructions')
    text = text.strip() if isinstance(text, str) else ''
    if len(text) > 2000:
        raise Blocked('Keep the instructions under 2,000 characters.')
    # Storing the default as empty lets a later improvement to it still apply.
    guidance = '' if text == privacy_engine.INSTRUCTIONS.strip() else text
    prompt = body.get('detector_prompt')
    prompt = prompt.strip() if isinstance(prompt, str) else ''
    if len(prompt) > 6000:
        raise Blocked('Keep the detector prompt under 6,000 characters.')
    prompt = '' if prompt == detector.DETECTOR_PROMPT.strip() else prompt
    return endpoint, model, allow_remote, token.strip(), guidance, prompt


# A short-lived cache: the page asks often, and the probe must not become a
# second source of load on the model service. Deliberately outside the chat
# lock, so a slow or dead endpoint cannot stall the rest of the app.
model_state = {'checked': 0.0, 'value': None}


def probe_model(timeout=2.5):
    model = detector.configured_local_model()
    try:
        endpoint = detector.approved_endpoint()
    except Blocked as error:
        return {'endpoint': detector.configured_local_endpoint(), 'model': model,
                'reachable': False, 'installed': None, 'reason': str(error)}
    probe = urllib.request.Request(endpoint + '/api/tags',
                                   headers={'ngrok-skip-browser-warning': 'true', **detector.auth_header()})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(probe, timeout=timeout) as response:
            names = [item.get('name') for item in json.load(response).get('models', [])]
    except Exception:
        return {'endpoint': endpoint, 'model': model, 'reachable': False, 'installed': None,
                'reason': 'The filtering service is not responding.'}
    return {'endpoint': endpoint, 'model': model, 'reachable': True, 'installed': model in names,
            'remote': detector.is_remote(endpoint),
            'reason': None if model in names else 'That model is not installed on the service.'}


@app.get('/api/model')
def model_status():
    now = time.monotonic()
    # One probe a minute at most, however many pages or tabs are asking.
    if model_state['value'] is None or now - model_state['checked'] > 60:
        model_state.update(value=probe_model(), checked=now)
    return jsonify(model_state['value'])


@app.get('/api/settings')
def read_settings():
    return jsonify(current_settings())


@app.post('/api/settings')
def write_settings():
    body = request.get_json(silent=True)
    try:
        endpoint, model, allow_remote, token, guidance, prompt = requested(body if isinstance(body, dict) else {})
    except Blocked as error:
        return jsonify(error=str(error)), 422
    os.environ.update({'PI_PRIVACY_ENDPOINT': endpoint, 'PI_PRIVACY_MODEL': model,
                       'PI_PRIVACY_ALLOW_REMOTE': '1' if allow_remote else '',
                       'PI_PRIVACY_AUTH_TOKEN': token, 'PRIVATE_CHAT_INSTRUCTIONS': guidance,
                       'PRIVATE_CHAT_DETECTOR_PROMPT': prompt})
    try:
        CONFIG.write_text(json.dumps({'local_ai': endpoint, 'local_model': model,
                                      'allow_remote_ai': allow_remote, 'ai_auth_token': token,
                                      'instructions': guidance, 'detector_prompt': prompt},
                                     indent=2) + '\n', encoding='utf-8')
    except OSError:
        return jsonify(error=f'Settings applied, but {CONFIG.name} could not be written.'), 500
    model_state.update(value=None, checked=0.0)
    return jsonify(current_settings())


@app.post('/api/settings/test')
def test_settings():
    body = request.get_json(silent=True)
    try:
        endpoint, model, _allow, token, _guidance, _prompt = requested(body if isinstance(body, dict) else {})
    except Blocked as error:
        return jsonify(error=str(error)), 422
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    probe = urllib.request.Request(endpoint + '/api/tags',
                                   headers={'ngrok-skip-browser-warning': 'true', **detector.auth_header(token)})
    try:
        with opener.open(probe, timeout=10) as response:
            names = [item.get('name') for item in json.load(response).get('models', [])]
    except urllib.error.HTTPError as error:
        return jsonify(error=f'The model service answered {error.code}.'), 502
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return jsonify(error='Could not reach that address.'), 502
    return jsonify(ok=True, models=len(names), has_model=model in names,
                   sample=[name for name in names if isinstance(name, str)][:8])


@app.get('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


def owned(chat_id):
    chat = chats.get(chat_id)
    if not chat or chat['owner'] != session['owner']:
        return None
    chat['touched'] = time.monotonic()
    return chat


def view(chat):
    return {key: chat[key] for key in ('id', 'state', 'progress', 'messages', 'pending', 'error', 'review')}


@app.post('/api/chats')
def new_chat():
    with lock:
        now = time.monotonic()
        for key in list(chats):
            if now - chats[key]['touched'] > 8 * 3600:
                del chats[key]
        if len(chats) >= 100:
            return jsonify(error='Close an existing chat first.'), 429
        chat_id = secrets.token_urlsafe(24)
        chat = {'id': chat_id, 'owner': session['owner'], 'touched': now,
                'vault': detector.Vault(), 'history': [], 'messages': [], 'pending': None,
                'state': 'idle', 'progress': 'Ready', 'error': None, 'generation': 0, 'review': False}
        chats[chat_id] = chat
        return jsonify(view(chat))


@app.get('/api/chats/<chat_id>')
def get_chat(chat_id):
    with lock:
        chat = owned(chat_id)
        return jsonify(view(chat)) if chat else (jsonify(error='Chat expired. Start a new chat.'), 404)


@app.delete('/api/chats/<chat_id>')
def delete_chat(chat_id):
    with lock:
        if not owned(chat_id):
            return jsonify(error='Chat not found.'), 404
        del chats[chat_id]
    return jsonify(ok=True)


def redact_job(chat_id, generation, original, vault, history, review=False):
    def progress(message):
        with lock:
            chat = chats.get(chat_id)
            if chat and chat['generation'] == generation:
                chat['progress'] = message
    try:
        candidate, cloud_history, redacted, outbound = prepare(original, vault, history, progress)
        with lock:
            chat = chats.get(chat_id)
            if not chat or chat['generation'] != generation:
                return
            turn_id = secrets.token_urlsafe(24)
            chat.update(vault=candidate, state='reviewing' if review else 'prepared',
                        progress='Review before sending' if review else 'Ready for ChatGPT',
                        pending={'id': turn_id, 'original': original, 'redacted': redacted,
                                 'outbound': outbound, 'references': len(candidate.values)},
                        staged_history=cloud_history)
    except Exception as error:
        reason = str(error) if isinstance(error, Blocked) else 'Local filtering failed.'
        # Detection failing is not a reason to lose the message. Fall back to
        # the deterministic rules, which still hide emails, URLs, paths,
        # labelled secrets and anything already known, then hand it to review
        # so nothing is sent until a person has checked it.
        try:
            candidate, cloud_history, redacted, outbound = prepare(
                original, vault, history, progress, local_call=lambda *_a, **_k: {'entities': []})
        except Exception:
            with lock:
                chat = chats.get(chat_id)
                if chat and chat['generation'] == generation:
                    chat.update(state='error', progress='Message was not sent', error=reason)
            return
        with lock:
            chat = chats.get(chat_id)
            if not chat or chat['generation'] != generation:
                return
            turn_id = secrets.token_urlsafe(24)
            chat.update(vault=candidate, state='reviewing', review=True,
                        progress='The local model could not check this — review it before sending',
                        pending={'id': turn_id, 'original': original, 'redacted': redacted,
                                 'outbound': outbound, 'references': len(candidate.values),
                                 'degraded': reason},
                        staged_history=cloud_history)


@app.post('/api/chats/<chat_id>/prepare')
def prepare_chat(chat_id):
    body = request.get_json(silent=True)
    original = body.get('text') if isinstance(body, dict) else None
    if not isinstance(original, str) or not original.strip() or len(original) > 12000:
        return jsonify(error='Enter between 1 and 12,000 characters.'), 400
    with lock:
        chat = owned(chat_id)
        if not chat:
            return jsonify(error='Chat expired.'), 404
        if chat['state'] not in ('idle', 'error'):
            return jsonify(error='Finish or cancel the current message first.'), 409
        review = bool(body.get('review'))
        chat['generation'] += 1
        chat.update(state='filtering', progress='Checking your message locally…', error=None, pending=None, review=review)
        executor.submit(redact_job, chat_id, chat['generation'], original, chat['vault'], chat['history'], review)
        return jsonify(view(chat)), 202


@app.post('/api/chats/<chat_id>/mark')
def mark(chat_id):
    with lock:
        chat = owned(chat_id)
        body = request.get_json(silent=True)
        body = body if isinstance(body, dict) else {}
        if not chat or not chat['pending'] or chat['pending']['id'] != body.get('turn') or chat['state'] != 'reviewing':
            return jsonify(error='This message is no longer under review.'), 409
        try:
            candidate, cloud_history, redacted, outbound = mark_value(
                chat['pending']['redacted'], chat['history'], chat['vault'],
                body.get('text'), body.get('kind'))
        except Blocked as error:
            return jsonify(error=str(error)), 422
        chat['pending'].update(redacted=redacted, outbound=outbound, references=len(candidate.values))
        chat.update(vault=candidate, staged_history=cloud_history,
                    progress='Review before sending')
        return jsonify(view(chat))


@app.post('/api/chats/<chat_id>/approve')
def approve(chat_id):
    with lock:
        chat = owned(chat_id)
        body = request.get_json(silent=True)
        body = body if isinstance(body, dict) else {}
        if not chat or not chat['pending'] or chat['pending']['id'] != body.get('turn') or chat['state'] != 'reviewing':
            return jsonify(error='This message is no longer under review.'), 409
        chat.update(state='prepared', progress='Ready for ChatGPT')
        return jsonify(view(chat))


@app.post('/api/chats/<chat_id>/sending')
def sending(chat_id):
    with lock:
        chat = owned(chat_id)
        body = request.get_json(silent=True)
        body = body if isinstance(body, dict) else {}
        if not chat or not chat['pending'] or chat['pending']['id'] != body.get('turn') or chat['state'] != 'prepared':
            return jsonify(error='This message is no longer ready to send.'), 409
        chat.update(state='sending', progress='Waiting for ChatGPT…')
        return jsonify(ok=True)


@app.post('/api/chats/<chat_id>/reply')
def reply(chat_id):
    with lock:
        chat = owned(chat_id)
        body = request.get_json(silent=True)
        body = body if isinstance(body, dict) else {}
        if not chat or not chat['pending'] or chat['pending']['id'] != body.get('turn') or chat['state'] not in ('prepared', 'sending'):
            return jsonify(error='This reply belongs to an expired message.'), 409
        raw = body.get('text')
        try:
            if not isinstance(raw, str) or not raw.strip():
                raise Blocked('ChatGPT returned an empty reply.')
            display = restore(raw, chat['vault'])
        except Blocked as error:
            return jsonify(error=str(error)), 422
        pending = chat['pending']
        chat['messages'].extend([
            {'role': 'user', 'text': pending['original'], 'redacted': pending['redacted'], 'outbound': pending['outbound']},
            {'role': 'assistant', 'text': display}])
        chat['history'] = chat.pop('staged_history') + [{'role': 'assistant', 'content': raw}]
        chat.update(state='idle', progress='Done — private details restored in the reply', pending=None, error=None)
        return jsonify(view(chat))


@app.post('/api/chats/<chat_id>/cancel')
def cancel(chat_id):
    with lock:
        chat = owned(chat_id)
        if not chat:
            return jsonify(error='Chat expired.'), 404
        chat['generation'] += 1
        chat.update(state='idle', progress='Ready', pending=None, error=None)
        chat.pop('staged_history', None)
        return jsonify(view(chat))


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error='Request is too large.'), 413


if __name__ == '__main__':
    # Fail here rather than on the first message if the endpoint is unusable.
    endpoint = detector.approved_endpoint()
    remote = detector.is_remote(endpoint)
    print(f'Privacy Chat: {ORIGIN}', flush=True)
    print(f'{"Remote" if remote else "Local"} AI: {endpoint} ({detector.configured_local_model()})', flush=True)
    if remote:
        print('Unredacted text is sent to this host over the internet.', flush=True)
        if not detector.auth_header():
            print('WARNING: no ai_auth_token set; anyone who finds that URL can use the model.', flush=True)
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)
