#!/usr/bin/env bash
cd "$(dirname "$0")"
(sleep 1 && (xdg-open http://127.0.0.1:8123/ 2>/dev/null || open http://127.0.0.1:8123/ 2>/dev/null)) &
python3 -m http.server 8123 --bind 127.0.0.1
