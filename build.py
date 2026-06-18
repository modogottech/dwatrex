#!/usr/bin/env python3
"""
Build script for Dwatrex Desktop.
Step 1: Generates the app icon (if missing)
Step 2: Creates version info for Windows
Step 3: Builds standalone executable via PyInstaller
"""
import subprocess
import sys
import os
import shutil

BASE = os.path.dirname(os.path.abspath(__file__))
ICO_PATH = os.path.join(BASE, 'dwatrex.ico')
VERSION_FILE = os.path.join(BASE, 'version_info.py')

APP_VERSION = '1.0.0'
APP_NAME = 'Dwatrex'
APP_DESC = 'Dwatrex — Retail Operations Platform'
COMPANY = 'Dwatrex'
COPYRIGHT = 'Copyright 2026 Dwatrex'


def ensure_icon():
    """Generate the icon if it doesn't exist."""
    if not os.path.exists(ICO_PATH):
        print("Generating app icon...")
        subprocess.run([sys.executable, os.path.join(BASE, 'create_icon.py')],
                       cwd=BASE, check=True)
    else:
        print(f"Icon found: {ICO_PATH}")


def create_version_info():
    """Create a PyInstaller version info file for Windows exe metadata."""
    major, minor, patch = APP_VERSION.split('.')
    content = f"""# UTF-8
# Version info for Dwatrex Desktop
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({major}, {minor}, {patch}, 0),
    prodvers=({major}, {minor}, {patch}, 0),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable(
        u'040904B0',
        [StringStruct(u'CompanyName', u'{COMPANY}'),
         StringStruct(u'FileDescription', u'{APP_DESC}'),
         StringStruct(u'FileVersion', u'{APP_VERSION}'),
         StringStruct(u'InternalName', u'{APP_NAME}'),
         StringStruct(u'LegalCopyright', u'{COPYRIGHT}'),
         StringStruct(u'OriginalFilename', u'{APP_NAME}.exe'),
         StringStruct(u'ProductName', u'{APP_NAME}'),
         StringStruct(u'ProductVersion', u'{APP_VERSION}')])
    ]),
    VarFileInfo([VarStruct(u'Translation', [1033, 1200])])
  ]
)
"""
    with open(VERSION_FILE, 'w') as f:
        f.write(content)
    print(f"Version info created: {VERSION_FILE}")


def build():
    """Run the full build pipeline."""
    print("=" * 60)
    print(f"  DWATREX BUILD SYSTEM v{APP_VERSION}")
    print("=" * 60)
    print()

    # Step 1: Icon
    ensure_icon()

    # Step 2: Version info
    create_version_info()

    # Step 3: PyInstaller
    print("\nBuilding executable with PyInstaller...")

    # Use os.pathsep for --add-data (';' on Windows, ':' on Unix)
    sep = ';' if sys.platform == 'win32' else ':'

    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--name=Dwatrex',
        '--onedir',
        '--windowed',
        '--noconfirm',
        f'--icon={ICO_PATH}',
        f'--add-data={os.path.join(BASE, "frontend")}{sep}frontend',
        '--hidden-import=webview',
        '--hidden-import=bottle',
        '--hidden-import=clr',
        '--collect-all=webview',
        f'--version-file={VERSION_FILE}',
        os.path.join(BASE, 'main.py'),
    ]

    print(" ".join(cmd))
    print()
    subprocess.run(cmd, cwd=BASE, check=True)

    # Step 4: Reset utility — a small console exe shipped alongside the app so
    # locked-out users can reset a password without needing Python installed.
    build_reset_tool()

    print()
    print("=" * 60)
    print("  BUILD COMPLETE")
    print(f"  Executable: dist/Dwatrex/Dwatrex.exe")
    print(f"  Reset tool: dist/Dwatrex/DwatrexReset.exe + reset_password.bat")
    print(f"  Icon:       {ICO_PATH}")
    print("=" * 60)


def build_reset_tool():
    """Build the password-reset utility into the app folder and stage the wrapper."""
    print("\nBuilding password reset utility (DwatrexReset)...")
    dist_app = os.path.join(BASE, 'dist', 'Dwatrex')
    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--name=DwatrexReset',
        '--onefile',
        '--console',            # needs a console for prompts / hidden password input
        '--noconfirm',
        f'--icon={ICO_PATH}',
        f'--distpath={dist_app}',   # land next to Dwatrex.exe
        os.path.join(BASE, 'reset_admin.py'),
    ]
    print(" ".join(cmd))
    subprocess.run(cmd, cwd=BASE, check=True)

    # Copy the double-clickable wrapper next to the executables.
    wrapper = os.path.join(BASE, 'reset_password.bat')
    if os.path.exists(wrapper) and os.path.isdir(dist_app):
        shutil.copy2(wrapper, dist_app)
        print(f"Copied reset_password.bat into {dist_app}")


if __name__ == '__main__':
    build()
