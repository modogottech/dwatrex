# DWATREX — Retail Operations Platform

A lightweight desktop application built with Python + pywebview + SQLite.
Uses the OS native web engine (like Tauri) for a small footprint that runs smoothly on older hardware.

Design System: **The Kinetic Monolith** — Industrial. Authoritative. Precise.

---

## Installation Options

### Option A — One-Click Installer (Recommended for Windows)

If someone has already built the installer for you, just double-click **DwatrexSetup.exe** and follow the wizard. That's it — desktop shortcut, Start Menu entry, and uninstaller are all set up automatically.

### Option B — Run from Source (Developer)

```bash
pip install pywebview
python main.py
```

The app opens a native window. On first launch it creates `dwatrex.db` with sample data.

---

## Building the Installer (One-Time Setup)

You only need to do this once. After that, share `DwatrexSetup.exe` with anyone.

### Prerequisites

1. **Python 3.8+** — [python.org/downloads](https://www.python.org/downloads/)
2. **Inno Setup 6** — [jrsoftware.org/isdl.php](https://jrsoftware.org/isdl.php) (free)

### Quick Build (One Command)

Double-click **`build_installer.bat`** — it does everything automatically:

1. Installs Python dependencies (pywebview, pyinstaller)
2. Generates the app icon (`dwatrex.ico`)
3. Builds the standalone `.exe` with PyInstaller
4. Creates the Windows installer with Inno Setup

Output: `installer_output/DwatrexSetup.exe` (~51 MB)

### Manual Build (Step by Step)

```bash
# 1. Install dependencies
pip install pywebview pyinstaller

# 2. Generate icon
python create_icon.py

# 3. Build executable
python build.py

# 4. Compile installer (requires Inno Setup)
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
```

---

## What the Installer Creates

When a user runs DwatrexSetup.exe, they get:

- **Setup wizard** — license agreement, install location, options
- **Desktop shortcut** — optional, checked by default
- **Start Menu entry** — optional, checked by default
- **Uninstaller** — appears in Windows Settings > Apps
- **Launch on finish** — checkbox to open the app right away
- **Per-user install** — no admin rights needed by default

---

## Project Structure

```
main.py              → App entry point, creates native window
api.py               → JS↔Python API bridge (all business logic)
database.py          → SQLite schema, seed data, query helpers
frontend/            → HTML + CSS + JS user interface
  index.html
  styles.css
  app.js
create_icon.py       → Generates dwatrex.ico (no dependencies)
build.py             → PyInstaller build script (icon + version info)
installer.iss        → Inno Setup installer script
build_installer.bat  → One-click: build exe + create installer
LICENSE.txt          → License shown during install
dwatrex.ico          → App icon (multi-size: 16px to 256px)
dwatrex.db           → Created on first run (auto-seeded with demo data)
```

## Features

- 13 modules: Dashboard, Products, Categories, Suppliers, POS Command, Purchases, Inventory Intelligence, Returns, Capital Analytics, Intelligence Center, Users, Settings
- SQLite database — all data persists offline, fully private
- Role-based UI (Admin, Manager, Cashier, Inventory Officer)
- "Kinetic Monolith" dark industrial design
- Charts via Chart.js
- ~51 MB installer (vs 150-200 MB for Electron)
- No admin rights required to install

## System Requirements

- **Windows 10+** (uses WebView2 — pre-installed on Windows 10/11)
- **macOS 11+** (uses WebKit — built-in)
- **Linux** (needs `libwebkit2gtk-4.0` — install via package manager)
