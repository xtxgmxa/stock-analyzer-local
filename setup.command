#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-lock.txt
echo "安裝完成，執行 bash start.command"
