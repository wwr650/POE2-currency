@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  PoE2 currency dashboard - one-click launcher
rem  Double-click this file: it creates .venv, installs deps and
rem  starts the web server, then opens the browser.
rem  Keep this file ASCII-only: non-ASCII bytes in a .bat break
rem  parsing under some console code pages. Chinese messages are
rem  printed by launcher.py instead.
rem
rem  Usage: start.bat [offline] [no-browser] [reload] [--port 8000]
rem         offline    do not fetch on startup (local data only)
rem         no-browser do not open the browser
rem         reload     enable auto reload (development)
rem ============================================================

set "BOOT="
where py >nul 2>nul && set "BOOT=py -3"
if not defined BOOT (where python >nul 2>nul && set "BOOT=python")
if not defined BOOT goto :no_python

title PoE2 Currency Dashboard
%BOOT% launcher.py %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

:no_python
echo [ERROR] Python not found. Install Python 3.9+ and tick "Add Python to PATH".
echo         https://www.python.org/downloads/
pause
exit /b 1
