@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  PoE2 currency dashboard - one-click launcher (thin shim)
rem  The real logic lives in the Authenticode-signed start.ps1.
rem  Windows has no batch-file SIP, so a .bat cannot carry a
rem  signature on this OS; this shim instead verifies the
rem  signature of start.ps1 and refuses tampered launchers.
rem  Keep this file ASCII-only: non-ASCII bytes in a .bat break
rem  parsing under some console code pages. Chinese messages are
rem  printed by launcher.py instead.
rem
rem  Usage: start.bat [offline] [no-browser] [reload] [--port 8000]
rem         offline    do not sync repo (GitHub Actions) data on startup
rem         no-browser do not open the browser
rem         reload     enable auto reload (development)
rem ============================================================

title PoE2 Currency Dashboard

set "PS="
where powershell >nul 2>nul && set "PS=powershell"
if not defined PS (where pwsh >nul 2>nul && set "PS=pwsh")
if not defined PS goto :no_ps

rem --- signature gate: only accept Valid (or a knowingly
rem     unsigned working copy) before anything is executed.
rem     Result travels via ERRORLEVEL: 0=Valid 9=NotSigned 2=bad
"%PS%" -NoProfile -Command "$s=(Get-AuthenticodeSignature '%~dp0start.ps1').Status; if ($s -eq 'Valid') {exit 0} elseif ($s -eq 'NotSigned') {exit 9} else {exit 2}"
set "SIGRC=%ERRORLEVEL%"
if "%SIGRC%"=="0" goto :run
if "%SIGRC%"=="9" goto :unsigned
goto :bad_sig

:run
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

:unsigned
echo [WARN] start.ps1 is NOT signed - running an unverified copy.
echo        Sign it once: powershell -ExecutionPolicy Bypass -File scripts\sign-start.ps1
timeout /t 3
goto :run

:bad_sig
echo [FAIL] start.ps1 signature check failed \(errorlevel %SIGRC%^\)
echo        Refusing to run. Re-sign it with:
echo        powershell -ExecutionPolicy Bypass -File scripts\sign-start.ps1
pause
exit /b 2

:no_ps
echo [ERROR] Windows PowerShell not found (powershell.exe missing from PATH).
pause
exit /b 1
