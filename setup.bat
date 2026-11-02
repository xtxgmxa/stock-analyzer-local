@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo 請先安裝 Python 3.12 並加入 PATH & pause & exit /b 1)
if not exist .venv\Scripts\python.exe python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
if errorlevel 1 (pause & exit /b 1)
echo 安裝完成，請執行 start.bat
pause
