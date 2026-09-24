"""Double-click launcher: start the local server without a console, then open Chrome."""
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
URL = 'http://127.0.0.1:8787/'


def open_browser():
    for base in (os.environ.get('PROGRAMFILES', ''), os.environ.get('PROGRAMFILES(X86)', ''), os.environ.get('LOCALAPPDATA', '')):
        chrome = Path(base) / 'Google/Chrome/Application/chrome.exe'
        if chrome.is_file():
            subprocess.Popen([str(chrome), URL])
            return
    webbrowser.open(URL)


def update():
    """Pull the latest version when this copy is a git clone. Never fatal: an
    offline machine, a dirty tree or no git at all just starts what is here."""
    if not (ROOT / '.git').is_dir():
        return
    try:
        subprocess.run(['git', 'pull', '--ff-only'], cwd=str(ROOT), timeout=30,
                       capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except Exception:
        pass


def is_running():
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(URL + 'api/health', timeout=2) as response:
            import json
            return json.load(response).get('app') == 'private-chat-web'
    except Exception:
        return False


def open_when_ready():
    for _ in range(50):
        if is_running():
            open_browser()
            return
        time.sleep(.2)


if __name__ == '__main__':
    if is_running():
        open_browser()
    else:
        import sys
        # pythonw has no console streams; framework startup must not write to None.
        if sys.stdout is None:
            sys.stdout = open(os.devnull, 'w')
        if sys.stderr is None:
            sys.stderr = open(os.devnull, 'w')
        os.chdir(ROOT)
        update()
        from server import app
        from waitress import serve
        threading.Thread(target=open_when_ready, daemon=True).start()
        serve(app, host='127.0.0.1', port=8787, threads=6)
