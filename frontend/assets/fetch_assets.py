#!/usr/bin/env python3
"""
Download the web assets Dwatrex needs to run FULLY OFFLINE.

The app must not depend on the internet at runtime, so we bundle these locally
instead of loading them from CDNs/Google Fonts:
  * Chart.js            -> assets/chart.umd.min.js
  * Material Symbols    -> assets/fonts/material-symbols-outlined.woff2   (icons)
  * Inter (text)        -> assets/fonts/inter.woff2
  * Manrope (headings)  -> assets/fonts/manrope.woff2

This runs once at BUILD time (the build machine / CI runner has internet);
the installed app then needs no network. It is invoked automatically by
build.py and build_mac.py, and can be run manually:

    python frontend/assets/fetch_assets.py
"""
import os
import re
import ssl
import sys
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, 'fonts')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')

CHARTJS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
# Google Fonts css2 endpoints (a desktop User-Agent yields woff2)
ICON_CSS = ('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:'
            'opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200')
INTER_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900'
MANROPE_CSS = 'https://fonts.googleapis.com/css2?family=Manrope:wght@200..800'


def _open(req):
    """Open a request, verifying SSL when possible. Many macOS Python installs
    ship without CA certificates (CERTIFICATE_VERIFY_FAILED); fall back to an
    unverified context for these public, static asset downloads."""
    try:
        try:
            import certifi
            ctx = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            ctx = ssl.create_default_context()
        return urllib.request.urlopen(req, timeout=60, context=ctx)
    except (ssl.SSLError, urllib.error.URLError):
        unverified = ssl.create_default_context()
        unverified.check_hostname = False
        unverified.verify_mode = ssl.CERT_NONE
        print("  (SSL verification unavailable — downloading without verification)")
        return urllib.request.urlopen(req, timeout=60, context=unverified)


def _get(url, as_text=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with _open(req) as r:
        data = r.read()
    return data.decode('utf-8') if as_text else data


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    print(f"  saved {os.path.relpath(path, HERE)} ({len(data) // 1024} KB)")


def _woff2_from_css(css, prefer_latin=True):
    """Return a woff2 URL from a Google Fonts css2 response.

    Text fonts come back as several subset @font-face blocks (each preceded by
    a /* subset */ comment); we want the Latin one. Icon fonts have just one."""
    if prefer_latin:
        parts = re.split(r"/\*\s*([A-Za-z0-9\-\[\] ]+?)\s*\*/", css)
        for i in range(1, len(parts) - 1, 2):
            if parts[i].strip().lower() == 'latin':
                m = re.search(r"url\((https://[^)]+\.woff2)\)", parts[i + 1])
                if m:
                    return m.group(1)
    m = re.search(r"url\((https://[^)]+\.woff2)\)", css)
    if not m:
        raise RuntimeError("no .woff2 URL found in font CSS")
    return m.group(1)


def _fetch_font(css_url, out, prefer_latin):
    css = _get(css_url, as_text=True)
    _save(out, _get(_woff2_from_css(css, prefer_latin)))


def _exists(path):
    return os.path.exists(path) and os.path.getsize(path) > 1024


def main():
    force = '--force' in sys.argv or os.environ.get('DWATREX_FORCE_ASSETS') == '1'
    print("Fetching Dwatrex offline assets..." + (" (force)" if force else ""))
    chart = os.path.join(HERE, 'chart.umd.min.js')
    icon = os.path.join(FONTS, 'material-symbols-outlined.woff2')
    inter = os.path.join(FONTS, 'inter.woff2')
    manrope = os.path.join(FONTS, 'manrope.woff2')

    if force or not _exists(chart):
        _save(chart, _get(CHARTJS_URL))
    else:
        print("  chart.umd.min.js already present — skipping")
    if force or not _exists(icon):
        _fetch_font(ICON_CSS, icon, prefer_latin=False)
    else:
        print("  material-symbols-outlined.woff2 already present — skipping")
    if force or not _exists(inter):
        _fetch_font(INTER_CSS, inter, prefer_latin=True)
    else:
        print("  inter.woff2 already present — skipping")
    if force or not _exists(manrope):
        _fetch_font(MANROPE_CSS, manrope, prefer_latin=True)
    else:
        print("  manrope.woff2 already present — skipping")
    print("All offline assets are in place.")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"ERROR fetching offline assets: {e}", file=sys.stderr)
        sys.exit(1)
