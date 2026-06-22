#!/bin/bash
# ============================================================
#  Dwatrex - Build the macOS app + installer (.dmg)
#  Double-click this on macOS to produce dist/Dwatrex.dmg
# ============================================================
cd "$(dirname "$0")" || exit 1

echo "Dwatrex - macOS Build"
echo

# Prefer python3; fall back to python
PY=""
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "Python 3 is not installed. Install it from python.org or 'brew install python'."
  read -n 1 -s -r -p "Press any key to close..."; echo; exit 1
fi

echo "Installing build dependencies..."
"$PY" -m pip install --upgrade pip >/dev/null
"$PY" -m pip install -r requirements-build.txt || {
  echo "Failed to install dependencies."; read -n 1 -s -r -p "Press any key to close..."; echo; exit 1; }

echo "Building..."
"$PY" build_mac.py
STATUS=$?

echo
if [ $STATUS -eq 0 ]; then
  echo "Done. Find the installer at: dist/Dwatrex.dmg"
  open dist 2>/dev/null
else
  echo "Build failed (see messages above)."
fi
read -n 1 -s -r -p "Press any key to close..."
echo
