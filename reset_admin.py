#!/usr/bin/env python3
"""
Dwatrex — Offline Password Reset Utility
========================================

A small, self-contained tool for resetting a user's password directly against
the local Dwatrex database. Intended for the operator of the machine (or a
developer helping them) when someone is locked out and there is no other admin
available to reset the password from inside the app.

Because Dwatrex runs fully offline, there is no email/SMS recovery. The database
is a local file on this computer, so anyone who can run the app can run this
tool — the real security boundary is the computer's own login, not the app
password. This utility therefore does not (and cannot) require being signed in.

USAGE
-----
Run it on the same computer where Dwatrex is installed:

    python reset_admin.py                 # interactive: pick a user, type a new password
    python reset_admin.py --list          # just list the accounts
    python reset_admin.py admin           # reset a specific username
    python reset_admin.py admin --password "newSecret123"   # non-interactive

Notes:
  * Passwords must be at least 8 characters (same rule as the app).
  * The account is re-activated if it was inactive, so a disabled admin can get
    back in.
  * It targets the same database the app uses. To point at a specific file, set
    the DWATREX_DB environment variable before running (the app honors it too).
"""
import os
import sys
import argparse
import getpass

# Make sure we can import the app's database layer regardless of where we're run from.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import database as db  # noqa: E402

MIN_PASSWORD_LEN = 8


def list_users():
    """Return all users as a list of dicts (id, name, username, role, status)."""
    return db.query("SELECT id, name, username, role, status FROM users ORDER BY role, username")


def reset_password(username, new_password, activate=True):
    """Reset a user's password. Returns (ok, message).

    Testable core: no prompting, no printing.
    """
    if not username:
        return False, "A username is required."
    if not new_password or len(new_password) < MIN_PASSWORD_LEN:
        return False, f"Password must be at least {MIN_PASSWORD_LEN} characters."

    rows = db.query("SELECT id, status FROM users WHERE username=?", (username,))
    if not rows:
        return False, f"No user found with username '{username}'."

    user_id = rows[0]["id"]
    hashed = db.hash_password(new_password)
    if activate:
        db.execute("UPDATE users SET password=?, status='Active' WHERE id=?", (hashed, user_id))
    else:
        db.execute("UPDATE users SET password=? WHERE id=?", (hashed, user_id))
    return True, f"Password for '{username}' has been reset successfully."


def _print_users():
    users = list_users()
    if not users:
        print("No users exist yet. Has first-run setup been completed?")
        return users
    print("\n  Accounts in this database:")
    print("  " + "-" * 50)
    for u in users:
        flag = "" if u["status"] == "Active" else f"  [{u['status']}]"
        print(f"   • {u['username']:<18} {u['role']:<10}{flag}")
    print("  " + "-" * 50)
    return users


def main():
    parser = argparse.ArgumentParser(description="Reset a Dwatrex user's password (offline).")
    parser.add_argument("username", nargs="?", help="Username to reset (prompted if omitted)")
    parser.add_argument("--password", help="New password (prompted securely if omitted)")
    parser.add_argument("--list", action="store_true", help="List accounts and exit")
    parser.add_argument("--no-activate", action="store_true",
                        help="Do not re-activate the account if it is inactive")
    args = parser.parse_args()

    print("=" * 56)
    print("  DWATREX — Offline Password Reset")
    print("=" * 56)
    print(f"  Database: {db.DB_PATH}")

    if not os.path.exists(db.DB_PATH):
        print("\n  No database found at that location.")
        print("  Launch Dwatrex once (and complete setup) before resetting.")
        sys.exit(1)

    users = _print_users()
    if args.list:
        return
    if not users:
        sys.exit(1)

    # Resolve the target username.
    username = args.username
    if not username:
        try:
            username = input("\n  Username to reset: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n  Cancelled.")
            sys.exit(1)

    # Resolve the new password.
    password = args.password
    if not password:
        try:
            password = getpass.getpass("  New password (min 8 chars): ")
            confirm = getpass.getpass("  Confirm new password:       ")
        except (EOFError, KeyboardInterrupt):
            print("\n  Cancelled.")
            sys.exit(1)
        if password != confirm:
            print("\n  Passwords do not match. Nothing changed.")
            sys.exit(1)

    ok, msg = reset_password(username, password, activate=not args.no_activate)
    print()
    if ok:
        print(f"  ✓ {msg}")
        print("  The user can now sign in with the new password.")
    else:
        print(f"  ✗ {msg}")
        sys.exit(1)


if __name__ == "__main__":
    main()
