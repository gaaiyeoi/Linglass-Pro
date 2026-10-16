@echo off
REM Linglass-Pro one-click installer (Windows entry point).
REM
REM Keep this file pure ASCII: cmd.exe parses .bat bytes in the active code page,
REM so non-ASCII text here would garble on some systems. All Chinese messages are
REM printed by tools\install.mjs instead (see the chcp line below).
REM
REM This file is deliberately thin: the real work lives in tools\install.mjs,
REM shared with install-macos.command.

setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo Linglass-Pro installer
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

node "tools\install.mjs"
set "STATUS=%ERRORLEVEL%"
goto done

:no_node
echo Node.js is not installed yet.
echo.
echo The installer needs it. The Chrome extension itself does not.
echo The download page will open now: get the LTS version, click through the
echo installer, then double-click this file again.
echo.
start "" "https://nodejs.org/en/download"
set "STATUS=1"

:done
echo.
pause
endlocal & exit /b %STATUS%
