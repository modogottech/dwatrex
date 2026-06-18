"""
Dwatrex core unit tests.

Run from the project root:
    python -m pytest tests/            (if pytest is installed)
    python -m unittest discover -s tests

A fresh temporary database is created per test run via the DWATREX_DB env var,
so these tests never touch the real user database.
"""
import os
import sys
import json
import tempfile
import unittest

# Point the DB at a throwaway file BEFORE importing the app modules,
# because database.py resolves DB_PATH at import time.
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="dwatrex_test_"), "test.db")
os.environ["DWATREX_DB"] = _TMP_DB
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database as db          # noqa: E402
from api import StoreHubAPI    # noqa: E402


class BaseCase(unittest.TestCase):
    def setUp(self):
        # Rebuild a clean DB for every test.
        if os.path.exists(_TMP_DB):
            os.remove(_TMP_DB)
        for suffix in ("-wal", "-shm"):
            p = _TMP_DB + suffix
            if os.path.exists(p):
                os.remove(p)
        db.init_db()
        self.api = StoreHubAPI()

    def login_as(self, role):
        """Bypass the password flow and set a server-side session for tests."""
        self.api._current_user = {"id": 999, "name": f"Test {role}", "role": role}

    def call(self, method, *args):
        return json.loads(getattr(self.api, method)(*args))

    def first_product(self):
        return self.call("get_all_products")["data"][0]


class PasswordTests(unittest.TestCase):
    def test_hash_roundtrip(self):
        h = db.hash_password("hunter2pass")
        self.assertTrue(h.startswith("pbkdf2_sha256$"))
        self.assertTrue(db.verify_password("hunter2pass", h))
        self.assertFalse(db.verify_password("wrong", h))

    def test_per_user_salt_differs(self):
        self.assertNotEqual(db.hash_password("same"), db.hash_password("same"))

    def test_legacy_sha256_still_verifies(self):
        import hashlib
        legacy = hashlib.sha256(b"dwatrex_salt_2026secret").hexdigest()
        self.assertTrue(db.verify_password("secret", legacy))
        self.assertFalse(db.verify_password("nope", legacy))


class AuthorizationTests(BaseCase):
    def test_unauthenticated_is_blocked(self):
        res = self.call("get_all_products")
        self.assertFalse(res["ok"])

    def test_cashier_cannot_manage_users(self):
        self.login_as("cashier")
        res = self.call("get_users")
        self.assertFalse(res["ok"])
        self.assertIn("Permission", res["msg"])

    def test_cashier_cannot_edit_products(self):
        self.login_as("cashier")
        res = self.call("save_product", None, "X-1", "Test", "Beverages", "", "1", "2", "5", "1", "")
        self.assertFalse(res["ok"])

    def test_admin_can_manage_users(self):
        self.login_as("admin")
        self.assertTrue(self.call("get_users")["ok"])


class SaleTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_sale_math_and_stock_decrement(self):
        p = self.first_product()
        start = p["stock"]
        items = [{"productId": p["id"], "name": p["name"], "qty": 2,
                  "unitPrice": 10.0, "costPrice": 4.0}]
        res = self.call("complete_sale", json.dumps(items), 10, 7.5, "Cash")
        self.assertTrue(res["ok"], res.get("msg"))
        sale = res["data"]
        # subtotal=20, -10% disc = 18, +7.5% tax = 19.35
        self.assertAlmostEqual(sale["subtotal"], 20.0, places=2)
        self.assertAlmostEqual(sale["discount_amt"], 2.0, places=2)
        self.assertAlmostEqual(sale["tax_amt"], 1.35, places=2)
        self.assertAlmostEqual(sale["total"], 19.35, places=2)
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == p["id"])
        self.assertEqual(after["stock"], start - 2)

    def test_oversell_is_rejected_and_rolled_back(self):
        p = self.first_product()
        start = p["stock"]
        items = [{"productId": p["id"], "name": p["name"], "qty": start + 100,
                  "unitPrice": 1.0, "costPrice": 0.5}]
        res = self.call("complete_sale", json.dumps(items), 0, 0, "Cash")
        self.assertFalse(res["ok"])
        self.assertIn("Insufficient", res["msg"])
        # Stock unchanged; no partial sale recorded.
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == p["id"])
        self.assertEqual(after["stock"], start)

    def test_multi_item_rolls_back_if_any_line_fails(self):
        prods = self.call("get_all_products")["data"]
        good, bad = prods[0], prods[1]
        good_start = good["stock"]
        items = [
            {"productId": good["id"], "name": good["name"], "qty": 1, "unitPrice": 1.0, "costPrice": 0.5},
            {"productId": bad["id"], "name": bad["name"], "qty": bad["stock"] + 50, "unitPrice": 1.0, "costPrice": 0.5},
        ]
        res = self.call("complete_sale", json.dumps(items), 0, 0, "Cash")
        self.assertFalse(res["ok"])
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == good["id"])
        self.assertEqual(after["stock"], good_start, "first line must be rolled back")


class ReturnTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def _make_sale(self, qty=3):
        p = self.first_product()
        items = [{"productId": p["id"], "name": p["name"], "qty": qty,
                  "unitPrice": 5.0, "costPrice": 2.0}]
        sale = self.call("complete_sale", json.dumps(items), 0, 0, "Cash")["data"]
        return p, sale

    def test_return_within_quantity_ok(self):
        p, sale = self._make_sale(3)
        res = self.call("save_return", sale["id"], p["id"], p["name"], 2, "Defective", 1, 5.0)
        self.assertTrue(res["ok"], res.get("msg"))

    def test_return_more_than_sold_rejected(self):
        p, sale = self._make_sale(3)
        res = self.call("save_return", sale["id"], p["id"], p["name"], 10, "Defective", 1, 5.0)
        self.assertFalse(res["ok"])
        self.assertIn("remain", res["msg"])

    def test_cumulative_returns_capped(self):
        p, sale = self._make_sale(3)
        self.assertTrue(self.call("save_return", sale["id"], p["id"], p["name"], 2, "Defective", 0, 5.0)["ok"])
        res = self.call("save_return", sale["id"], p["id"], p["name"], 2, "Defective", 0, 5.0)
        self.assertFalse(res["ok"], "second return should exceed the remaining 1 unit")


class ProductValidationTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_duplicate_sku_friendly_error(self):
        self.assertTrue(self.call("save_product", None, "DUP-1", "A", "Beverages", "", "1", "2", "5", "1", "")["ok"])
        res = self.call("save_product", None, "DUP-1", "B", "Beverages", "", "1", "2", "5", "1", "")
        self.assertFalse(res["ok"])
        self.assertIn("already exists", res["msg"])

    def test_negative_values_rejected(self):
        res = self.call("save_product", None, "NEG-1", "A", "Beverages", "", "-1", "2", "5", "1", "")
        self.assertFalse(res["ok"])


class ResetUtilityTests(BaseCase):
    def setUp(self):
        super().setUp()
        import importlib
        self.reset_admin = importlib.import_module("reset_admin")

    def test_reset_then_login_works(self):
        ok, _ = self.reset_admin.reset_password("admin", "brandNewPass1")
        self.assertTrue(ok)
        # The new password must authenticate; the old one must not.
        self.assertIsNotNone(db.authenticate_user("admin", "brandNewPass1"))
        self.assertIsNone(db.authenticate_user("admin", "admin123"))

    def test_reset_reactivates_inactive_user(self):
        db.execute("UPDATE users SET status='Inactive' WHERE username=?", ("sara_c",))
        ok, _ = self.reset_admin.reset_password("sara_c", "anotherPass1")
        self.assertTrue(ok)
        self.assertIsNotNone(db.authenticate_user("sara_c", "anotherPass1"))

    def test_reset_rejects_short_password(self):
        ok, msg = self.reset_admin.reset_password("admin", "short")
        self.assertFalse(ok)
        self.assertIn("8 characters", msg)

    def test_reset_unknown_user(self):
        ok, msg = self.reset_admin.reset_password("ghost", "validPass123")
        self.assertFalse(ok)
        self.assertIn("No user", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
