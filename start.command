#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "請先安裝 Node.js 18 以上： https://nodejs.org"; exit 1; }
(sleep 1; (open http://localhost:5177 2>/dev/null || xdg-open http://localhost:5177 2>/dev/null)) &
node server.js
