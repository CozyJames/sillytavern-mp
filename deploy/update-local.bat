@echo off
setlocal enabledelayedexpansion
rem SillyTavern Multiplayer - Windows local updater.
rem
rem For a local install that was set up manually (this repo cloned somewhere,
rem its "extension" folder copied into SillyTavern's extensions directory).
rem Run this after a `git pull` would normally be needed: it pulls the
rem latest code, reinstalls server dependencies if needed, and re-copies the
rem updated extension files into place.
rem
rem First run asks for the destination extension folder once and remembers
rem it (stored next to this script, never committed to git).

cd /d "%~dp0\.."
set "REPO_ROOT=%cd%"
set "STATE_FILE=%~dp0.update-state.bat"

where git >nul 2>nul
if errorlevel 1 (
    echo [!] git was not found on PATH. Install Git for Windows first:
    echo     https://git-scm.com/download/win
    pause
    exit /b 1
)

if exist "%STATE_FILE%" (
    call "%STATE_FILE%"
) else (
    echo First-time setup: where does your SillyTavern extension currently live?
    echo Example: C:\SillyTavern\data\default-user\extensions\mp-extension
    set /p "EXT_DIR=Path to the extension folder inside SillyTavern: "
    if "!EXT_DIR!"=="" (
        echo [!] No path entered, aborting.
        pause
        exit /b 1
    )
    > "%STATE_FILE%" echo set "EXT_DIR=!EXT_DIR!"
)

echo.
echo ==^> Repo:      %REPO_ROOT%
echo ==^> Extension: %EXT_DIR%
echo.

echo ==^> Pulling latest changes...
git pull --ff-only
if errorlevel 1 (
    echo [!] git pull failed - you may have local changes in this checkout.
    echo     Resolve manually ^(git status / git stash^) and re-run this script.
    pause
    exit /b 1
)

echo.
echo ==^> Installing server dependencies...
pushd "%REPO_ROOT%\server"
call npm install --omit=dev --no-audit --no-fund
popd

echo.
echo ==^> Copying updated extension files into "%EXT_DIR%"...
if not exist "%EXT_DIR%" mkdir "%EXT_DIR%"
robocopy "%REPO_ROOT%\extension" "%EXT_DIR%" /E /NFL /NDL /NJH /NJS
rem robocopy exit codes 0-7 mean success (files copied/skipped), 8+ is a real error
if %errorlevel% geq 8 (
    echo [!] robocopy reported an error while copying the extension folder.
    pause
    exit /b 1
)

echo.
echo Done. Restart SillyTavern to pick up the updated extension, then start the
echo server as usual:
echo   server\start.bat
echo.
pause
