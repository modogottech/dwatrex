#!/usr/bin/env python3
"""
Build script for Dwatrex on macOS.

Produces:
  * dist/Dwatrex.app          — the double-clickable application bundle
  * dist/DwatrexReset         — the offline password-reset tool (CLI binary)
  * dist/Dwatrex.dmg          — a drag-to-Applications disk image to distribute

MUST be run on macOS (PyInstaller is not a cross-compiler). On Apple Silicon
this builds an arm64 app; on Intel, an x86_64 app. See the README note about
distributing to the other architecture.

Usage:
    pip install -r requirements-build.txt
    python3 build_mac.py
"""
import os
import sys
import shutil
import subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
APP_NAME = 'Dwatrex'
ICNS = os.path.join(BASE, 'dwatrex.icns')   # optional; used if present
DIST = os.path.join(BASE, 'dist')


def run(cmd):
    print("\n> " + " ".join(cmd))
    subprocess.run(cmd, cwd=BASE, check=True)


def build_app():
    """Build the .app bundle with PyInstaller."""
    cmd = [
        sys.executable, '-m', 'PyInstaller',
        f'--name={APP_NAME}',
        '--windowed',                       # build a .app GUI bundle
        '--noconfirm',
        f'--add-data={os.path.join(BASE, "frontend")}:frontend',
        '--hidden-import=webview',
        '--collect-all=webview',
        os.path.join(BASE, 'main.py'),
    ]
    if os.path.exists(ICNS):
        cmd.insert(5, f'--icon={ICNS}')
    else:
        print("Note: dwatrex.icns not found — building with the default icon.")
    run(cmd)


def build_reset_tool():
    """Build the offline password-reset CLI alongside the app."""
    run([
        sys.executable, '-m', 'PyInstaller',
        '--name=DwatrexReset',
        '--onefile',
        '--console',
        '--noconfirm',
        f'--distpath={DIST}',
        os.path.join(BASE, 'reset_admin.py'),
    ])


def build_dmg():
    """Stage the .app + reset tools and produce a compressed .dmg."""
    app = os.path.join(DIST, f'{APP_NAME}.app')
    if not os.path.isdir(app):
        sys.exit("ERROR: app bundle not found — the PyInstaller build failed.")

    stage = os.path.join(DIST, 'dmg_stage')
    if os.path.exists(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)

    shutil.copytree(app, os.path.join(stage, f'{APP_NAME}.app'), symlinks=True)
    # Drag-to-install target
    os.symlink('/Applications', os.path.join(stage, 'Applications'))
    # Include the password-reset tool + double-click wrapper
    reset_bin = os.path.join(DIST, 'DwatrexReset')
    if os.path.exists(reset_bin):
        shutil.copy2(reset_bin, stage)
    wrapper = os.path.join(BASE, 'reset_password.command')
    if os.path.exists(wrapper):
        shutil.copy2(wrapper, stage)

    dmg = os.path.join(DIST, f'{APP_NAME}.dmg')
    if os.path.exists(dmg):
        os.remove(dmg)
    run(['hdiutil', 'create', '-volname', APP_NAME,
         '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg])
    shutil.rmtree(stage, ignore_errors=True)
    return dmg


def main():
    if sys.platform != 'darwin':
        sys.exit("build_mac.py must be run on macOS.")
    print("=" * 60)
    print(f"  DWATREX macOS BUILD")
    print("=" * 60)
    print("\nFetching offline web assets (fonts + Chart.js)...")
    subprocess.run([sys.executable, os.path.join(BASE, 'frontend', 'assets', 'fetch_assets.py')],
                   cwd=BASE, check=True)
    build_app()
    build_reset_tool()
    dmg = build_dmg()
    print("\n" + "=" * 60)
    print("  BUILD COMPLETE")
    print(f"  App:  dist/{APP_NAME}.app")
    print(f"  DMG:  {dmg}")
    print("=" * 60)
    print("\n  To distribute: share dist/Dwatrex.dmg. The recipient opens it")
    print("  and drags Dwatrex into Applications.")
    print("  Unsigned apps: first launch needs right-click > Open (see README).")


if __name__ == '__main__':
    main()
