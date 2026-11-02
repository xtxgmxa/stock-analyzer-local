@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo 請先執行 setup.bat & pause & exit /b 1)
where node >nul 2>nul || (echo 請先安裝 Node.js 18 以上： https://nodejs.org & pause & exit /b)
start "" http://localhost:5177
node server.js
pause
