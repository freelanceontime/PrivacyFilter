# Private Chat for Chrome

A local chat website that removes detected private details using your LAN AI,
sends the filtered conversation through your normal signed-in ChatGPT browser
session, and restores the details in the reply displayed on the local page.
No Codex, Claude, OpenAI API key, cookie export, or command-execution feature.

## Windows setup

1. Copy/extract this whole folder onto your Windows machine.
2. Install Python 3.10 or later with the Python launcher enabled if needed.
3. Double-click **Start Private Chat.cmd**. On the first run it creates a local
   Python environment and installs Flask/Waitress. It then starts a background
   local server and opens Chrome at **http://127.0.0.1:8787/**.
4. In Chrome open `chrome://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select this folder's **extension** directory.
5. Sign in at **https://chatgpt.com/** in that same Chrome profile.
6. Reload the local webpage. Its status should say **Chrome companion connected**.
7. Paste your text and send. Turn on **Side by side** for the testing comparison.

Keep the folder in place after loading the extension. The background server runs
until Windows signs out/restarts (or its Python process is stopped). Starting the
launcher again opens the existing service. Reloading the webpage starts a new
local session view; it does not recover old chats. Chrome is the intended browser.
The extension only connects to `http://127.0.0.1:8787/`, not `localhost` or a public website.

## Local AI

The included `vendor/privacy.py` comes from your Private Pi bridge. It defaults to
**http://192.168.1.212:11434**, model **gemma4:latest**. Your Windows PC must be on
that LAN or a trusted VPN that can reach it. Original text reaches that LAN model
via HTTP; it is not on-device inference in the Chrome tab.

Change it in **Settings** in the sidebar (address, model, remote access, token,
and light/dark appearance). Saving applies immediately to new messages and writes
`config.json` beside the app, which can also be edited directly:

```json
{"local_ai": "http://192.168.1.212:11434", "local_model": "gemma4:latest"}
```

`PI_PRIVACY_ENDPOINT`, `PI_PRIVACY_MODEL`, `PI_PRIVACY_ALLOW_REMOTE` and
`PI_PRIVACY_AUTH_TOKEN` override the file. `http://` is accepted only for a loopback
or private address (127.x, 10.x, 172.16-31.x, 192.168.x, localhost). Restart the app
after editing. For local development, `PRIVATE_CHAT_BRIDGE` can point to a directory
containing an updated `privacy.py`.

### Sharing the app with someone off your network

Each person runs their own copy of the server and extension; the filtering is local
to whoever is typing. The simplest share is the folder plus their own Ollama at
`http://127.0.0.1:11434`.

To have several people filter through one machine's model instead, expose that model
over https (an ngrok tunnel, for example) and set:

```json
{"local_ai": "https://your-tunnel.ngrok.app", "allow_remote_ai": true, "ai_auth_token": "a-long-random-string"}
```

Remote hosts must be `https`, and the token is sent as `Authorization: Bearer …`
(`user:pass` becomes Basic auth instead). Put that auth in front of the tunnel too,
or anyone who finds the URL can run your GPU. With this on, the sidebar says
**Remote AI** and the Setup dialog says so plainly, because unredacted text now
reaches that host over the internet before it is filtered. What ChatGPT receives is
unchanged: the filtered payload only.

## Copying this to another machine

Copy the whole folder (the `.venv` and `node_modules` folders are not needed and
are rebuilt or ignored), then double-click **Start Private Chat.cmd**. It:

- finds Python 3.10 or later, and offers to install it with winget if there is none
- creates `.venv` in the folder, rebuilding it if the one copied over belongs to
  another machine
- installs Flask and waitress, which needs internet access once
- prints the path to load as the Chrome companion, then starts the app

Run `Start Private Chat.cmd /check` to do the setup and stop, without launching.

Each machine still needs two things of its own: the Chrome extension loaded from
that folder's `extension` directory at `chrome://extensions` with Developer mode
on, and a reachable filtering model in `config.json` (the LAN address works for
any machine on the same network; check it from Settings inside the app).

## Review before sending

Turn on **Review before sending** to hold each filtered message on this page instead
of dispatching it. The redacted text is shown with every hidden value as a token;
select anything the local model missed, choose what kind of value it is, and mark it.
Marking only ever hides more, and the rebuilt payload goes through the same
leak check as a fresh message. Nothing reaches ChatGPT until you choose Send.

## What happens to each message

- The local server detects private details using the bridge's regex and local AI.
- A per-chat, memory-only map replaces findings with stable opaque references.
  The webpage's wire markers use `[[PRIVATE_KIND_id_number]]` so Markdown does
  not consume leading/trailing underscores.
- The companion reuses one empty ChatGPT tab, submits the filtered conversation
  in the background, and returns the completed response to Private Chat. Later
  turns reset that same companion tab to a fresh composer. It uses visible page
  controls, not internal API endpoints. The browser handles authentication.
- Once a complete reply is detected, the local server restores references and
  shows the reply. It buffers replies to avoid showing half-restored tokens.
- In **Side by side**, the left pane is your exact original and the right pane is
  the filtered current message. Expand the full payload to inspect the exact text
  submitted, including instructions and history. Earlier messages are inspectable.

Conversations are text-only. Replies are displayed as plain text to avoid executing
model-produced HTML or fetching remote images. No attachment parsing, tools,
terminal operations, or clipboard reading is included. The copy button writes only
the filtered payload to your clipboard when clicked.

## Boundaries and current limitations

Detection is best-effort; neither the local model nor regex guarantees catching
all private facts. A known-value check blocks residual detected values, and local
filter failures stop sending. No unfiltered fallback is used. Unknown or damaged
reply references stop restoration rather than guessing.

This is a local prototype, not a public multi-user hosting service. The server binds
only to loopback, enforces the page's origin/host, isolates browser sessions, sends
no-store headers, and keeps text/maps in memory. Deleting a conversation clears
its server map; otherwise it can remain until process exit or an eight-hour idle
cleanup on the next new conversation. Python memory deletion is not secure erasure.
ChatGPT can retain the redacted conversations according to the account's settings.
Each turn creates a fresh ChatGPT conversation in the same reusable companion tab
and resends filtered history.
The extension stores only redacted jobs temporarily in Chrome session storage and
removes them on completion/cancel/timeout. Its permissions are storage,
alarms, and access to chatgpt.com plus a local-page content script; no cookies permission.

ChatGPT's page layout can change. If sign-in, a usage limit, changed controls, or a
slow response prevents automation, the page offers filtered copy/paste and local
reply restoration. Inspect the ChatGPT tab in that case. Do not type original
private details into the companion's ChatGPT tab. Cancellation cannot undo text
already submitted to ChatGPT. Keep a companion tab visible if Chrome throttles it.

## Development and verification

Linux: install `requirements.txt` into a virtual environment, then run `./run.sh`.
Both launchers use Waitress bound to loopback.

```sh
python3 -m unittest discover -s tests -v
npm ci
node node_modules/playwright/cli.js install chromium
node tests/browser.mjs
```

Browser tests need Node 20+ and a running local server on port 8787. They exercise
Chrome's actual extension machinery and the real LAN model with synthetic data;
the ChatGPT origin is replaced in a temporary extension copy with a loopback
DOM fixture, and no test prompts are sent to OpenAI. Screenshots go into `artifacts/`. These tests do **not** establish
compatibility with the current live signed-in ChatGPT website. That final test
must run in the user's Chrome profile, preferably on the target Windows machine.
