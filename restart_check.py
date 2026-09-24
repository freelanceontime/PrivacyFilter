#!/usr/bin/env python3
"""Exit 0 when the running service is older than the code on disk.

A pull can bring new Python files without any new commits on a machine that was
several versions behind, so "nothing to pull" does not mean "nothing to
restart". This compares what is running against what is on disk.
"""
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent
SOURCES = list(ROOT.glob('*.py')) + list(ROOT.glob('*.pyw')) + list((ROOT / 'vendor').glob('*.py'))


def main():
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:8787/api/health', timeout=3) as response:
            started = json.load(response).get('started')
    except Exception:
        return 1  # Nothing is running, so there is nothing to restart.
    if not started:
        return 0  # An older build with no timestamp: assume it predates the code.
    newest = max((path.stat().st_mtime for path in SOURCES), default=0)
    return 0 if newest > float(started) else 1


if __name__ == '__main__':
    sys.exit(main())
