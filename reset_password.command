#!/bin/bash
# ============================================================
#  Dwatrex - Password Reset (double-click to run on macOS)
#  Prefers the bundled DwatrexReset binary (installed app);
#  falls back to running the Python script (from source).
# ============================================================
cd "$(dirname "$0")" || exit 1
echo "Dwatrex - Password Reset"
echo

if [ -x "./DwatrexReset" ]; then
    ./DwatrexReset
elif command -v python3 >/dev/null 2>&1; then
    python3 reset_admin.py
else
    echo "Could not find DwatrexReset, and python3 is not installed."
    echo "Please contact whoever set up Dwatrex for help resetting the password."
fi

echo
read -n 1 -s -r -p "Press any key to close..."
echo
