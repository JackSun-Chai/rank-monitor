@echo off
echo ============================================
echo   Rank Monitor - 产品排名监控
echo ============================================
echo.

cd /d "%~dp0"

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies
echo [1/2] Installing dependencies...
call npm install --silent
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
)

:: Install Playwright Chromium if needed
echo [2/2] Checking Playwright Chromium...
node -e "require('playwright').chromium.launch().then(b => b.close())" >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Chromium browser for Playwright...
    call npx playwright install chromium
)

:: Start
echo.
echo   Open http://127.0.0.1:5050 in your browser
echo   Press Ctrl+C to stop
echo.
node server.js
pause
