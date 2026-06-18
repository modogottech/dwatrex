#!/usr/bin/env python3
"""
Dwatrex — Retail Operations Platform.
Launches a native window with pywebview and exposes the SQLite-backed API.
"""
import os
import sys
import webview
import database
from api import StoreHubAPI

# Resolve paths whether running as script or frozen PyInstaller exe
if getattr(sys, '_MEIPASS', None):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

FRONTEND_DIR = os.path.join(BASE_DIR, 'frontend')


def main():
    # Initialise the database (creates + seeds on first run)
    database.init_db()

    api = StoreHubAPI()

    window = webview.create_window(
        title='DWATREX — Retail Operations Platform',
        url=os.path.join(FRONTEND_DIR, 'index.html'),
        js_api=api,
        width=1280,
        height=800,
        min_size=(900, 600),
        resizable=True,
        text_select=True,
    )

    # Use the OS native web engine (like Tauri does)
    webview.start(debug=False)


if __name__ == '__main__':
    main()
