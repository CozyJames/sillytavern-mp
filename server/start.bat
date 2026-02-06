@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    npm install
)

echo Starting SillyTavern MP Server...
node index.js
pause