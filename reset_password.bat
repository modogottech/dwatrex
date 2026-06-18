@echo off
REM ============================================================
REM  Dwatrex - Password Reset (double-click to run)
REM  Prefers the bundled DwatrexReset.exe (installed app);
REM  falls back to running the Python script (from source).
REM ============================================================
setlocal
cd /d "%~dp0"
title Dwatrex Password Reset

if exist "DwatrexReset.exe" (
    "DwatrexReset.exe"
    goto :done
)

python --version >nul 2>&1
if %errorlevel%==0 (
    python reset_admin.py
    goto :done
)

py --version >nul 2>&1
if %errorlevel%==0 (
    py reset_admin.py
    goto :done
)

echo.
echo Could not find DwatrexReset.exe, and Python is not installed.
echo Please contact whoever set up Dwatrex for help resetting the password.

:done
echo.
pause
