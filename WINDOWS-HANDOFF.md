# Continue on Windows

Project: Private Chat, a Chrome chat website with local privacy filtering.

## User requirements

- A separate normal chat webpage, using the user's signed-in Chrome ChatGPT account.
- Local AI at **192.168.1.212:11434**, confirmed by the user; model `gemma4:latest`;
  now configurable in `config.json` (private addresses only).
- Filter pasted text before it reaches ChatGPT; restore detected values in replies.
- A Side by side switch to compare the exact original and filtered text, plus the full payload.
- A Review before sending mode: hold the filtered message, mark values the local model missed, then send.
- Settings in the sidebar: model address, model name, remote access, auth token, and light/dark theme.
- No Codex/Claude API, cookie extraction, Frida, or terminal-command execution in the product.

## Start

Extract the ZIP to a permanent folder, then follow README.md. Run
**Start Private Chat.cmd**, load the **extension** folder through
`chrome://extensions` → Developer mode → Load unpacked, sign in to ChatGPT,
and reload **http://127.0.0.1:8787/** in that same Chrome profile.
The local Python service and Windows launcher are included; Python 3.10+ is needed.

## Already verified on Linux

- 13 privacy/server tests pass using the packaged dependencies.
- The actual LAN model detects synthetic person, email, project, and password values.
- Chrome-for-Testing loads the extension and performs a roundtrip with a local
  ChatGPT DOM fixture, including exact outgoing payload verification and restoration.
- Desktop/mobile layouts checked; screenshots are in `artifacts`.
- Original Private Pi source remains unchanged. The bundled detector is copied from it.

## Still needs the Windows session

1. Verify the Windows PC can reach the confirmed Ollama endpoint.
2. Run the launcher and load the extension into the real signed-in Chrome profile.
3. Use a synthetic prompt first: a made-up name, an `example.test` email, and a demo password.
4. Confirm a fresh ChatGPT tab receives only opaque `[[PRIVATE_...]]` references.
5. Confirm the local webpage receives and restores the reply, and Side by side matches.
6. Try a follow-up, cancellation, and signing out to verify understandable recovery.

The live ChatGPT layout, sign-in flow, account limits, and Windows launcher execution
have not been verified here. If a selector changes, update `extension/chatgpt.js`
using the visible page controls only; do not extract cookies/tokens or bypass browser checks.
The app provides manual filtered copy/paste and reply restoration as a fallback.

Detection remains best-effort. A known-value leak check and local-filter failures
stop sending, but cannot guarantee detection of every private fact.
