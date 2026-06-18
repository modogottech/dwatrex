@echo off
REM ═══════════════════════════════════════════════════════════════
REM  DWATREX — One-Click Build & Installer
REM
REM  This script:
REM    1. Installs Python dependencies (pywebview, pyinstaller)
REM    2. Generates the app icon
REM    3. Builds the standalone .exe with PyInstaller
REM    4. Creates the Windows installer with Inno Setup
REM
REM  Requirements:
REM    - Python 3.8+ installed and on PATH
REM    - Inno Setup 6 installed (https://jrsoftware.org/isdl.php)
REM ═══════════════════════════════════════════════════════════════

echo.
echo  ====================================================
echo   DWATREX BUILD SYSTEM
echo   Retail Operations Platform
echo  ====================================================
echo.

REM Navigate to script directory
cd /d "%~dp0"

REM ─── Step 1: Install Python dependencies ────────────────
echo [1/4] Installing Python dependencies...
pip install pywebview pyinstaller --quiet
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install Python dependencies.
    echo Make sure Python and pip are installed and on your PATH.
    pause
    exit /b 1
)
echo       Done.
echo.

REM ─── Step 2: Generate icon ──────────────────────────────
echo [2/4] Generating application icon...
if not exist "dwatrex.ico" (
    python create_icon.py
    if %ERRORLEVEL% neq 0 (
        echo ERROR: Failed to generate icon.
        pause
        exit /b 1
    )
) else (
    echo       Icon already exists, skipping.
)
echo.

REM ─── Step 3: Build with PyInstaller ─────────────────────
echo [3/4] Building standalone executable...
python build.py
if %ERRORLEVEL% neq 0 (
    echo ERROR: PyInstaller build failed.
    pause
    exit /b 1
)
echo.

REM ─── Step 4: Create installer with Inno Setup ──────────
echo [4/4] Creating Windows installer...

REM Try common Inno Setup locations
set "ISCC="
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
    set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" (
    set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
)

if "%ISCC%"=="" (
    echo.
    echo  WARNING: Inno Setup not found!
    echo  The .exe was built successfully in dist\Dwatrex\
    echo  but the installer (DwatrexSetup.exe) was NOT created.
    echo.
    echo  To create the installer:
    echo    1. Install Inno Setup from https://jrsoftware.org/isdl.php
    echo    2. Open installer.iss in Inno Setup
    echo    3. Click Build ^> Compile
    echo.
    echo  Or re-run this script after installing Inno Setup.
    echo.
    pause
    exit /b 0
)

"%ISCC%" installer.iss
if %ERRORLEVEL% neq 0 (
    echo ERROR: Inno Setup compilation failed.
    pause
    exit /b 1
)

echo.
echo  ====================================================
echo   BUILD COMPLETE!
echo  ====================================================
echo.
echo   Standalone app:  dist\Dwatrex\Dwatrex.exe
echo   Installer:       installer_output\DwatrexSetup.exe
echo.
echo   The installer includes:
echo     - Setup wizard with license agreement
echo     - Desktop shortcut (optional)
echo     - Start Menu entry (optional)
echo     - Uninstaller via Windows Settings
echo     - Launch on finish option
echo.
echo   Share DwatrexSetup.exe with anyone —
echo   they double-click it and follow the wizard.
echo  ====================================================
echo.
pause
