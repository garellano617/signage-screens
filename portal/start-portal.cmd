@echo off
rem Double-click to start the Signage Portal on this PC, then open http://localhost:3000
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install --no-fund --no-audit
)
start "" http://localhost:3000
node --no-warnings=ExperimentalWarning src\server.js
pause
