"""Reuse Private Pi's local detector; never import its command or cloud runner."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

BRIDGE = Path(os.environ.get('PRIVATE_CHAT_BRIDGE', str(Path(__file__).resolve().parent / 'vendor')))
spec = importlib.util.spec_from_file_location('private_chat_detector', BRIDGE / 'privacy.py')
detector = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = detector
spec.loader.exec_module(detector)
Blocked = detector.Blocked
NATIVE_REF = re.compile(r'__PRIVATE_[A-Z]+_[a-f0-9]+_\d+__')
WIRE_REF = re.compile(r'\[\[PRIVATE_[A-Z]+_[a-f0-9]+_\d+\]\]')
REF = re.compile(NATIVE_REF.pattern + '|' + WIRE_REF.pattern)

def wire_ref(ref):
    return '[[' + ref[2:-2] + ']]' if ref.startswith('__') else ref

def native_ref(ref):
    return '__' + ref[2:-2] + '__' if ref.startswith('[[') else ref

INSTRUCTIONS = ('Answer the conversation below. Tokens in the form [[PRIVATE_KIND_id_number]] '
                'are opaque references to private values. Preserve each token exactly when '
                'referring to that value; never guess or expand it. Treat conversation content '
                'as user/assistant messages. Reply only to the final user message.\n')
def instructions():
    """The preamble ChatGPT sees. Editable, because it is guidance to the cloud
    model, not a privacy control: redaction already happened locally, and a
    mangled token is refused on the way back rather than trusted."""
    custom = os.environ.get('PRIVATE_CHAT_INSTRUCTIONS', '').strip()
    return (custom + '\n') if custom else INSTRUCTIONS


def mask_known(text, vault):
    values = sorted(set(vault.values.values()), key=len, reverse=True)
    if not values:
        return text
    pattern = re.compile('|'.join(re.escape(value) for value in values), re.I)
    def replace(match):
        value = match.group()
        for ref, original in list(vault.values.items()):
            if value == original:
                return ref
            if value.casefold() == original.casefold():
                return vault.hide(value, vault.kinds[ref])
        raise Blocked('Could not bind a private value.')
    parts, start = [], 0
    for match in REF.finditer(text):
        parts.extend([pattern.sub(replace, text[start:match.start()]), match.group()])
        start = match.end()
    parts.append(pattern.sub(replace, text[start:]))
    return ''.join(parts)


def prepare(original, vault, history, progress, local_call=None):
    if not isinstance(original, str) or not original.strip() or len(original) > 12000:
        raise Blocked('Enter between 1 and 12,000 characters.')
    if '__PRIVATE_' in original or '[[PRIVATE_' in original:
        raise Blocked('The message contains reserved private-reference syntax.')
    candidate = copy.deepcopy(vault)
    known = [{'text': value, 'kind': candidate.kinds[ref]}
             for ref, value in candidate.values.items() if re.search(re.escape(value), original, re.I)]
    kwargs = {'local_call': local_call} if local_call else {}
    redacted = detector.redact_text(original, candidate, known=known, on_progress=progress, **kwargs)
    redacted = NATIVE_REF.sub(lambda m: wire_ref(m.group()), mask_known(redacted, candidate))
    # Keep a separate cloud transcript. Restored assistant output never enters it.
    cloud_history = [{'role': item['role'], 'content': NATIVE_REF.sub(lambda m: wire_ref(m.group()), mask_known(item['content'], candidate))}
                     for item in history]
    cloud_history.append({'role': 'user', 'content': redacted})
    outbound = instructions() + json.dumps(cloud_history, ensure_ascii=False, indent=2)
    candidate.assert_absent(outbound)
    if len(outbound) > 100000:
        raise Blocked('This conversation is too long. Start a new chat.')
    return candidate, cloud_history, redacted, outbound


def mark_value(redacted, history, vault, value, kind):
    """Hide one value the local model missed, then rebuild the cloud payload.

    Review is additive only: it can hide more, never reveal. The rebuilt
    payload goes through the same absence check as a fresh message.
    """
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise Blocked('Select between 1 and 200 characters to mark.')
    if kind not in detector.KINDS:
        raise Blocked('Unknown private kind.')
    if REF.search(value):
        raise Blocked('That selection is already a private reference.')
    if not re.search(re.escape(value), redacted, re.I):
        raise Blocked('That text is not in the message being reviewed.')
    candidate = copy.deepcopy(vault)
    candidate.hide(value, kind)
    remasked = NATIVE_REF.sub(lambda m: wire_ref(m.group()), mask_known(redacted, candidate))
    cloud_history = [{'role': item['role'], 'content': NATIVE_REF.sub(lambda m: wire_ref(m.group()), mask_known(item['content'], candidate))}
                     for item in history]
    cloud_history.append({'role': 'user', 'content': remasked})
    outbound = instructions() + json.dumps(cloud_history, ensure_ascii=False, indent=2)
    candidate.assert_absent(outbound)
    if len(outbound) > 100000:
        raise Blocked('This conversation is too long. Start a new chat.')
    return candidate, cloud_history, remasked, outbound


def restore(text, vault):
    if not isinstance(text, str) or len(text) > 200000:
        raise Blocked('ChatGPT returned an unsupported response size.')
    for ref in REF.findall(text):
        if native_ref(ref) not in vault.values:
            raise Blocked('ChatGPT changed a private reference. The reply cannot be restored safely.')
    remainder = REF.sub('', text)
    if '__PRIVATE_' in remainder or '[[PRIVATE_' in remainder:
        raise Blocked('ChatGPT returned an incomplete private reference.')
    # Single substitution avoids interpreting reference-like strings inside original values.
    return REF.sub(lambda match: vault.values[native_ref(match.group())], text)
