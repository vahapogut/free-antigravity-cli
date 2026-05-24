@echo off
echo.
echo   Free Antigravity CLI - Community Edition
echo   ========================================
echo.
echo   Installing...
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   ERROR: Node.js is required but not found.
    echo   Download from https://nodejs.org
    exit /b 1
)

REM Install globally via npm
call npm install -g free-antigravity-cli

if %ERRORLEVEL% neq 0 (
    echo.
    echo   Direct install failed. Trying without global...
    call npm install -g free-antigravity-cli --force
)

echo.
echo   Installation complete!
echo.
echo   Try it out: antigravity chat
echo.
echo   Or add a model: antigravity models add
echo.
pause
