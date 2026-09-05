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
# Tests exercise sample products and demo user accounts, so opt into demo data.
os.environ["DWATREX_DEMO"] = "1"
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


class ExpenseTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.today = __import__("datetime").date.today().isoformat()

    def test_add_and_total(self):
        self.assertTrue(self.call("save_expense", None, self.today, "Rent", "Shop rent", "1,200.00", "Bank")["ok"])
        self.assertTrue(self.call("save_expense", None, self.today, "Utilities", "ECG", "GH₵300", "Cash")["ok"])
        rows = self.call("get_expenses", self.today, self.today)["data"]
        self.assertEqual(len(rows), 2)
        self.assertAlmostEqual(sum(r["amount"] for r in rows), 1500.0, places=2)

    def test_amount_must_be_positive(self):
        res = self.call("save_expense", None, self.today, "Rent", "", "0", "Cash")
        self.assertFalse(res["ok"])

    def test_cashier_blocked(self):
        self.login_as("cashier")
        self.assertFalse(self.call("get_expenses")["ok"])
        self.assertFalse(self.call("save_expense", None, self.today, "Rent", "", "10", "Cash")["ok"])

    def test_profit_loss_math(self):
        # Assert the P&L relationships hold (robust to any seeded sales in range).
        self.call("save_expense", None, self.today, "Rent", "", "30", "Cash")
        pl = self.call("get_profit_loss", self.today, self.today)["data"]
        self.assertAlmostEqual(pl["gross"], pl["revenue"] - pl["cogs"], places=2)
        self.assertGreaterEqual(pl["expensesTotal"], 30.0)         # at least our expense
        self.assertAlmostEqual(pl["net"], pl["gross"] - pl["expensesTotal"], places=2)

    def test_dashboard_net_profit_present(self):
        self.assertIn("netProfit", self.call("get_dashboard_data")["data"])


class ManagerProfitRestrictionTests(BaseCase):
    """Manager role: no profits, no Intelligence, no Expenses; reports/sales still work."""

    def test_manager_blocked_from_profit_loss(self):
        self.login_as("manager")
        res = self.call("get_profit_loss", "2000-01-01", "2100-01-01")
        self.assertFalse(res["ok"])
        self.assertIn("Permission", res["msg"])

    def test_admin_can_run_profit_loss(self):
        self.login_as("admin")
        self.assertTrue(self.call("get_profit_loss", "2000-01-01", "2100-01-01")["ok"])

    def test_manager_dashboard_hides_profit(self):
        self.login_as("manager")
        d = self.call("get_dashboard_data")["data"]
        # Sales figures still present; profit figures nulled out.
        self.assertIsNotNone(d["todaySales"])
        self.assertIsNone(d["profit"])
        self.assertIsNone(d["netProfit"])
        self.assertIsNone(d["expenses"])

    def test_admin_dashboard_shows_profit(self):
        self.login_as("admin")
        d = self.call("get_dashboard_data")["data"]
        self.assertIsNotNone(d["profit"])
        self.assertIsNotNone(d["netProfit"])

    def test_manager_blocked_from_expenses(self):
        self.login_as("manager")
        self.assertFalse(self.call("get_expenses")["ok"])
        today = __import__("datetime").date.today().isoformat()
        self.assertFalse(self.call("save_expense", None, today, "Rent", "", "10", "Cash")["ok"])

    def test_manager_sales_have_no_cost(self):
        # Record a sale as admin, then read it back as manager — costPrice stripped.
        self.login_as("admin")
        p = self.first_product()
        items = [{"productId": p["id"], "name": p["name"], "qty": 1,
                  "unitPrice": 10.0, "costPrice": 4.0}]
        self.call("complete_sale", json.dumps(items), 0, 0, "Cash")
        self.login_as("manager")
        rows = self.call("get_sales_for_period", "2000-01-01", "2100-01-01")["data"]
        self.assertTrue(rows, "manager should still see sales")
        for r in rows:
            for it in r["items"]:
                self.assertNotIn("costPrice", it)

    def test_admin_sales_retain_cost(self):
        self.login_as("admin")
        p = self.first_product()
        items = [{"productId": p["id"], "name": p["name"], "qty": 1,
                  "unitPrice": 10.0, "costPrice": 4.0}]
        self.call("complete_sale", json.dumps(items), 0, 0, "Cash")
        rows = self.call("get_sales_for_period", "2000-01-01", "2100-01-01")["data"]
        self.assertTrue(any("costPrice" in it for r in rows for it in r["items"]))

    def test_manager_can_still_use_reports_and_sales(self):
        self.login_as("manager")
        # A non-profit report path (sales data) and product listing must still work.
        self.assertTrue(self.call("get_sales_for_period", "2000-01-01", "2100-01-01")["ok"])
        self.assertTrue(self.call("get_all_products")["ok"])


class BelowCostPinTests(BaseCase):
    """Admin-set approval PIN gates below-cost sales; enforced server-side."""

    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()   # has a real cost_price from demo seed

    def _below_cost_items(self):
        # Sell one unit at half the product's cost -> a loss.
        below = round(self.p["cost_price"] / 2, 2)
        return json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                            "qty": 1, "unitPrice": below, "costPrice": self.p["cost_price"]}])

    def _set_pin(self, pin):
        self.assertTrue(self.call("save_settings", json.dumps({"below_cost_pin": pin}))["ok"])

    def test_get_settings_never_exposes_pin(self):
        self._set_pin("1357")
        d = self.call("get_settings")["data"]
        self.assertNotIn("below_cost_pin", d)          # neither raw nor hash
        self.assertTrue(d["below_cost_pin_set"])

    def test_below_cost_blocked_without_pin_value(self):
        self._set_pin("1357")
        res = self.call("complete_sale", self._below_cost_items(), 0, 0, "Cash")   # no pin passed
        self.assertFalse(res["ok"])
        self.assertIn("PIN", res["msg"])

    def test_below_cost_blocked_with_wrong_pin(self):
        self._set_pin("1357")
        res = self.call("complete_sale", self._below_cost_items(), 0, 0, "Cash", "9999")
        self.assertFalse(res["ok"])

    def test_below_cost_allowed_with_correct_pin(self):
        self._set_pin("1357")
        res = self.call("complete_sale", self._below_cost_items(), 0, 0, "Cash", "1357")
        self.assertTrue(res["ok"], res.get("msg"))

    def test_below_cost_allowed_when_no_pin_configured(self):
        # No PIN set -> backend does not block (frontend still confirms).
        res = self.call("complete_sale", self._below_cost_items(), 0, 0, "Cash")
        self.assertTrue(res["ok"], res.get("msg"))

    def test_normal_priced_sale_needs_no_pin(self):
        self._set_pin("1357")
        good = json.dumps([{"productId": self.p["id"], "name": self.p["name"], "qty": 1,
                            "unitPrice": self.p["cost_price"] + 5, "costPrice": self.p["cost_price"]}])
        res = self.call("complete_sale", good, 0, 0, "Cash")
        self.assertTrue(res["ok"], res.get("msg"))

    def test_pin_uses_db_cost_not_client_value(self):
        # Client lies that costPrice is tiny, but the DB cost is authoritative.
        self._set_pin("1357")
        spoof = json.dumps([{"productId": self.p["id"], "name": self.p["name"], "qty": 1,
                             "unitPrice": round(self.p["cost_price"] / 2, 2), "costPrice": 0.01}])
        res = self.call("complete_sale", spoof, 0, 0, "Cash")   # still below real cost -> blocked
        self.assertFalse(res["ok"])
        self.assertIn("PIN", res["msg"])

    def test_clear_pin_disables_requirement(self):
        self._set_pin("1357")
        self.assertTrue(self.call("save_settings", json.dumps({"below_cost_pin": "__clear__"}))["ok"])
        self.assertFalse(self.call("get_settings")["data"]["below_cost_pin_set"])
        res = self.call("complete_sale", self._below_cost_items(), 0, 0, "Cash")
        self.assertTrue(res["ok"], res.get("msg"))

    def test_short_pin_rejected(self):
        res = self.call("save_settings", json.dumps({"below_cost_pin": "12"}))
        self.assertFalse(res["ok"])
        self.assertIn("4", res["msg"])


class BackdatedPurchaseTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _items(self, qty=5):
        return json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                            "qty": qty, "unitCost": 3.0}])

    def test_backdated_purchase_uses_given_date(self):
        import datetime as _dt
        past = (_dt.date.today() - _dt.timedelta(days=10)).isoformat()
        self.assertTrue(self.call("save_purchase", "Acme", self._items(), past)["ok"])
        rows = self.call("get_purchases")["data"]
        self.assertTrue(any(r["date"].startswith(past) for r in rows))

    def test_backdated_purchase_still_adds_stock(self):
        import datetime as _dt
        past = (_dt.date.today() - _dt.timedelta(days=3)).isoformat()
        start = self.p["stock"]
        self.assertTrue(self.call("save_purchase", "Acme", self._items(5), past)["ok"])
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start + 5)

    def test_future_date_rejected(self):
        import datetime as _dt
        future = (_dt.date.today() + _dt.timedelta(days=2)).isoformat()
        res = self.call("save_purchase", "Acme", self._items(), future)
        self.assertFalse(res["ok"])
        self.assertIn("future", res["msg"].lower())

    def test_blank_date_defaults_to_now(self):
        import datetime as _dt
        self.assertTrue(self.call("save_purchase", "Acme", self._items(), "")["ok"])
        rows = self.call("get_purchases")["data"]
        self.assertTrue(any(r["date"].startswith(_dt.date.today().isoformat()) for r in rows))

    def test_invalid_date_rejected(self):
        res = self.call("save_purchase", "Acme", self._items(), "not-a-date")
        self.assertFalse(res["ok"])


class CreditSaleTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _sell_on_credit(self, qty=2, unit=10.0, deposit=0):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": qty, "unitPrice": unit, "costPrice": 1.0}])
        return self.call("complete_sale", items, 0, 0, "Credit", "", "Ama Mensah", "0240000000", deposit)

    def test_credit_sale_creates_balance(self):
        res = self._sell_on_credit(qty=2, unit=10.0)          # total 20
        self.assertTrue(res["ok"], res.get("msg"))
        s = res["data"]
        self.assertEqual(s["payment"], "Credit")
        self.assertEqual(s["status"], "Credit")
        self.assertAlmostEqual(s["amount_paid"], 0, places=2)
        self.assertAlmostEqual(s["balance"], 20.0, places=2)
        self.assertEqual(s["customer_name"], "Ama Mensah")

    def test_credit_sale_requires_customer_name(self):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": 1, "unitPrice": 10.0, "costPrice": 1.0}])
        res = self.call("complete_sale", items, 0, 0, "Credit", "", "", "", 0)
        self.assertFalse(res["ok"])
        self.assertIn("name", res["msg"].lower())

    def test_credit_sale_still_deducts_stock(self):
        start = self.p["stock"]
        self._sell_on_credit(qty=2)
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start - 2)

    def test_deposit_reduces_balance(self):
        s = self._sell_on_credit(qty=2, unit=10.0, deposit=5)["data"]   # total 20, paid 5
        self.assertAlmostEqual(s["amount_paid"], 5.0, places=2)
        self.assertAlmostEqual(s["balance"], 15.0, places=2)

    def test_full_deposit_settles_immediately(self):
        s = self._sell_on_credit(qty=2, unit=10.0, deposit=20)["data"]
        self.assertAlmostEqual(s["balance"], 0, places=2)
        self.assertEqual(s["status"], "Completed")

    def test_deposit_cannot_exceed_total(self):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": 1, "unitPrice": 10.0, "costPrice": 1.0}])
        res = self.call("complete_sale", items, 0, 0, "Credit", "", "Ama", "", 50)
        self.assertFalse(res["ok"])

    def test_partial_payments_reduce_balance_then_settle(self):
        sale = self._sell_on_credit(qty=2, unit=10.0)["data"]           # owes 20
        r1 = self.call("record_credit_payment", sale["id"], 8, "Cash", "", "part 1")
        self.assertTrue(r1["ok"], r1.get("msg"))
        self.assertAlmostEqual(r1["data"]["balance"], 12.0, places=2)
        self.assertFalse(r1["data"]["settled"])
        r2 = self.call("record_credit_payment", sale["id"], 12, "Mobile Money", "", "final")
        self.assertTrue(r2["ok"])
        self.assertAlmostEqual(r2["data"]["balance"], 0, places=2)
        self.assertTrue(r2["data"]["settled"])
        # Sale is now settled and drops out of 'outstanding'.
        out = self.call("get_credit_sales", "outstanding")["data"]["sales"]
        self.assertFalse(any(x["id"] == sale["id"] for x in out))

    def test_overpayment_rejected(self):
        sale = self._sell_on_credit(qty=2, unit=10.0)["data"]
        res = self.call("record_credit_payment", sale["id"], 999, "Cash", "", "")
        self.assertFalse(res["ok"])
        self.assertIn("exceeds", res["msg"].lower())

    def test_payment_on_settled_sale_rejected(self):
        sale = self._sell_on_credit(qty=2, unit=10.0, deposit=20)["data"]
        res = self.call("record_credit_payment", sale["id"], 5, "Cash", "", "")
        self.assertFalse(res["ok"])

    def test_zero_or_negative_payment_rejected(self):
        sale = self._sell_on_credit()["data"]
        self.assertFalse(self.call("record_credit_payment", sale["id"], 0, "Cash", "", "")["ok"])
        self.assertFalse(self.call("record_credit_payment", sale["id"], -5, "Cash", "", "")["ok"])

    def test_payment_history_recorded(self):
        sale = self._sell_on_credit(qty=2, unit=10.0)["data"]
        self.call("record_credit_payment", sale["id"], 8, "Cash", "", "part 1")
        hist = self.call("get_credit_payments", sale["id"])["data"]
        self.assertEqual(len(hist), 1)
        self.assertAlmostEqual(hist[0]["amount"], 8.0, places=2)
        self.assertEqual(hist[0]["method"], "Cash")

    def test_outstanding_totals(self):
        self._sell_on_credit(qty=2, unit=10.0)      # 20 owed
        self._sell_on_credit(qty=1, unit=10.0)      # 10 owed
        totals = self.call("get_credit_sales", "outstanding")["data"]["totals"]
        self.assertAlmostEqual(totals["outstanding"], 30.0, places=2)
        self.assertEqual(totals["customers"], 1)    # same customer name

    def test_credit_counts_as_revenue_immediately(self):
        # Accrual: the sale hits revenue on the day goods leave, even if unpaid.
        before = self.call("get_dashboard_data")["data"]["todaySales"]
        self._sell_on_credit(qty=2, unit=10.0)      # total 20, nothing paid
        after = self.call("get_dashboard_data")["data"]["todaySales"]
        self.assertAlmostEqual(after - before, 20.0, places=2)

    def test_cash_sale_has_no_balance(self):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": 1, "unitPrice": 10.0, "costPrice": 1.0}])
        s = self.call("complete_sale", items, 0, 0, "Cash")["data"]
        self.assertAlmostEqual(s["balance"], 0, places=2)
        self.assertAlmostEqual(s["amount_paid"], s["total"], places=2)
        self.assertEqual(s["status"], "Completed")

    def test_non_credit_sale_rejects_payment(self):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": 1, "unitPrice": 10.0, "costPrice": 1.0}])
        s = self.call("complete_sale", items, 0, 0, "Cash")["data"]
        res = self.call("record_credit_payment", s["id"], 5, "Cash", "", "")
        self.assertFalse(res["ok"])

    def test_inventory_role_cannot_touch_credit(self):
        self.login_as("inventory")
        self.assertFalse(self.call("get_credit_sales")["ok"])


class MigrationTests(unittest.TestCase):
    """An older database (pre-credit columns) must upgrade cleanly on init."""

    def test_legacy_sales_table_is_migrated(self):
        import sqlite3
        legacy = os.path.join(tempfile.mkdtemp(prefix="dwatrex_legacy_"), "old.db")
        conn = sqlite3.connect(legacy)
        conn.executescript("""
            CREATE TABLE sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, items_json TEXT NOT NULL,
                subtotal REAL, discount REAL DEFAULT 0, tax REAL DEFAULT 7.5,
                discount_amt REAL DEFAULT 0, tax_amt REAL DEFAULT 0, total REAL,
                payment TEXT, status TEXT DEFAULT 'Completed');
            INSERT INTO sales(date,items_json,subtotal,total,payment)
            VALUES('2026-01-01T10:00:00','[]',50,50,'Cash');
        """)
        conn.commit(); conn.close()

        conn = sqlite3.connect(legacy)
        conn.row_factory = sqlite3.Row
        db._migrate(conn)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sales)")}
        for c in ("customer_name", "customer_phone", "amount_paid", "balance"):
            self.assertIn(c, cols)
        # The pre-existing paid-in-full sale must be backfilled, not left null.
        row = conn.execute("SELECT amount_paid, balance FROM sales WHERE id=1").fetchone()
        self.assertAlmostEqual(row["amount_paid"], 50.0, places=2)
        self.assertAlmostEqual(row["balance"], 0.0, places=2)
        conn.close()


class WeekStartTests(BaseCase):
    """'This Week' is a true calendar week starting on the configured day."""

    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def _set_week_start(self, day):
        self.assertTrue(self.call("save_settings", json.dumps({"weekStart": str(day)}))["ok"])

    def test_default_is_monday(self):
        self.assertEqual(self.api.get_week_start_day(), 0)

    def test_monday_start_resolves_to_that_monday(self):
        import datetime as _dt
        self._set_week_start(0)
        # Wednesday 2 Sep 2026 -> week began Monday 31 Aug 2026.
        wed = _dt.datetime(2026, 9, 2, 15, 30)
        self.assertEqual(self.api._week_start_date(wed).date(), _dt.date(2026, 8, 31))

    def test_start_day_itself_returns_same_day_midnight(self):
        import datetime as _dt
        self._set_week_start(0)
        mon = _dt.datetime(2026, 8, 31, 9, 0)
        got = self.api._week_start_date(mon)
        self.assertEqual(got, _dt.datetime(2026, 8, 31, 0, 0))   # midnight, not 09:00

    def test_sunday_start_is_configurable(self):
        import datetime as _dt
        self._set_week_start(6)                                   # 6 = Sunday
        wed = _dt.datetime(2026, 9, 2, 15, 30)
        self.assertEqual(self.api._week_start_date(wed).date(), _dt.date(2026, 8, 30))

    def test_saturday_start_is_configurable(self):
        import datetime as _dt
        self._set_week_start(5)                                   # 5 = Saturday
        wed = _dt.datetime(2026, 9, 2, 15, 30)
        self.assertEqual(self.api._week_start_date(wed).date(), _dt.date(2026, 8, 29))

    def test_every_start_day_lands_on_that_weekday_and_is_within_7_days(self):
        import datetime as _dt
        probe = _dt.datetime(2026, 9, 2, 12, 0)                   # a Wednesday
        for day in range(7):
            self._set_week_start(day)
            start = self.api._week_start_date(probe)
            self.assertEqual(start.weekday(), day, f"start day {day}")
            delta = (probe.date() - start.date()).days
            self.assertTrue(0 <= delta < 7, f"start day {day} gave {delta} days back")

    def test_invalid_setting_falls_back_to_monday(self):
        db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('weekStart','nonsense')")
        self.assertEqual(self.api.get_week_start_day(), 0)
        db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('weekStart','99')")
        self.assertEqual(self.api.get_week_start_day(), 6)        # clamped into range

    def test_dashboard_exposes_week_start(self):
        self._set_week_start(0)
        d = self.call("get_dashboard_data")["data"]
        self.assertIn("weekStartDate", d)
        self.assertIn("weekStartLabel", d)
        import datetime as _dt
        expected = self.api._week_start_date(_dt.datetime.now()).strftime("%Y-%m-%d")
        self.assertEqual(d["weekStartDate"], expected)

    def test_week_total_only_counts_sales_since_week_start(self):
        import datetime as _dt
        self._set_week_start(0)
        p = self.first_product()
        items = json.dumps([{"productId": p["id"], "name": p["name"], "qty": 1,
                             "unitPrice": 10.0, "costPrice": 1.0}])
        before = self.call("get_dashboard_data")["data"]["weekSales"]
        self.call("complete_sale", items, 0, 0, "Cash")           # today -> inside the week
        after = self.call("get_dashboard_data")["data"]["weekSales"]
        self.assertAlmostEqual(after - before, 10.0, places=2)

        # A sale dated before this week's start must NOT be counted.
        start = self.api._week_start_date(_dt.datetime.now())
        older = (start - _dt.timedelta(days=1)).isoformat()
        db.execute("INSERT INTO sales(date,items_json,subtotal,total,payment,status,amount_paid,balance) "
                   "VALUES(?,?,?,?,?,?,?,?)", (older, "[]", 999, 999, "Cash", "Completed", 999, 0))
        after2 = self.call("get_dashboard_data")["data"]["weekSales"]
        self.assertAlmostEqual(after2, after, places=2, msg="last week's sale leaked into this week")


class MonthStartTests(BaseCase):
    """'This Month' is the calendar month to date, not a rolling 30 days."""

    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_month_start_is_the_first(self):
        import datetime as _dt
        got = self.api._month_start_date(_dt.datetime(2026, 9, 4, 16, 45))
        self.assertEqual(got, _dt.datetime(2026, 9, 1, 0, 0))

    def test_first_of_month_returns_itself_at_midnight(self):
        import datetime as _dt
        got = self.api._month_start_date(_dt.datetime(2026, 9, 1, 8, 30))
        self.assertEqual(got, _dt.datetime(2026, 9, 1, 0, 0))

    def test_handles_every_month_including_leap_february(self):
        import datetime as _dt
        for month in range(1, 13):
            got = self.api._month_start_date(_dt.datetime(2024, month, 15, 12, 0))  # 2024 is a leap year
            self.assertEqual(got, _dt.datetime(2024, month, 1, 0, 0))
        # 29 Feb in a leap year still resolves to 1 Feb.
        self.assertEqual(self.api._month_start_date(_dt.datetime(2024, 2, 29, 23, 59)),
                         _dt.datetime(2024, 2, 1, 0, 0))

    def test_dashboard_exposes_month_start(self):
        import datetime as _dt
        d = self.call("get_dashboard_data")["data"]
        expected = self.api._month_start_date(_dt.datetime.now()).strftime("%Y-%m-%d")
        self.assertEqual(d["monthStartDate"], expected)
        self.assertTrue(d["monthStartDate"].endswith("-01"), "month must start on the 1st")

    def test_last_months_sale_is_excluded(self):
        import datetime as _dt
        p = self.first_product()
        items = json.dumps([{"productId": p["id"], "name": p["name"], "qty": 1,
                             "unitPrice": 10.0, "costPrice": 1.0}])
        self.call("complete_sale", items, 0, 0, "Cash")          # this month
        before = self.call("get_dashboard_data")["data"]["monthSales"]

        # A sale dated the day before this month began must not be counted.
        start = self.api._month_start_date(_dt.datetime.now())
        last_month = (start - _dt.timedelta(days=1)).isoformat()
        db.execute("INSERT INTO sales(date,items_json,subtotal,total,payment,status,amount_paid,balance) "
                   "VALUES(?,?,?,?,?,?,?,?)", (last_month, "[]", 500, 500, "Cash", "Completed", 500, 0))
        after = self.call("get_dashboard_data")["data"]["monthSales"]
        self.assertAlmostEqual(after, before, places=2, msg="last month's sale leaked into this month")

    def test_profit_and_expenses_use_the_same_month_window(self):
        """Revenue, profit and expenses must cover one identical period so the
        dashboard figures reconcile."""
        import datetime as _dt
        start = self.api._month_start_date(_dt.datetime.now())
        old = (start - _dt.timedelta(days=2)).isoformat()
        # An expense from last month must not drag this month's net profit down.
        db.execute("INSERT INTO expenses(date,category,description,amount,payment,created_by) "
                   "VALUES(?,?,?,?,?,?)", (old, "Rent", "last month", 750.0, "Cash", "test"))
        d = self.call("get_dashboard_data")["data"]
        self.assertAlmostEqual(d["expenses"], 0.0, places=2)
        self.assertAlmostEqual(d["netProfit"], d["profit"], places=2)


class SaleItemsTests(BaseCase):
    """Sale lines are normalised into sale_items so reports can use SQL."""

    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _sell(self, qty=2, unit=20.0, cost_claim=999.0):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": qty, "unitPrice": unit, "costPrice": cost_claim}])
        return self.call("complete_sale", items, 0, 0, "Cash")

    def test_sale_writes_normalised_line(self):
        s = self._sell()["data"]
        rows = db.query("SELECT * FROM sale_items WHERE sale_id=?", (s["id"],))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["product_id"], self.p["id"])
        self.assertAlmostEqual(rows[0]["qty"], 2, places=2)

    def test_cost_comes_from_db_not_client(self):
        """A tampered request claiming a tiny/huge cost must not be trusted."""
        s = self._sell(cost_claim=999.0)["data"]
        row = db.query("SELECT cost_price FROM sale_items WHERE sale_id=?", (s["id"],))[0]
        self.assertAlmostEqual(row["cost_price"], self.p["cost_price"], places=2)
        self.assertNotAlmostEqual(row["cost_price"], 999.0, places=2)

    def test_category_snapshotted_on_the_line(self):
        s = self._sell()["data"]
        row = db.query("SELECT category FROM sale_items WHERE sale_id=?", (s["id"],))[0]
        self.assertEqual(row["category"], self.p["category"])

    def test_aggregation_by_product_is_possible_in_sql(self):
        self._sell(qty=2); self._sell(qty=3)
        row = db.query("SELECT SUM(qty) AS q, SUM(qty*unit_price) AS rev "
                       "FROM sale_items WHERE product_id=?", (self.p["id"],))[0]
        self.assertAlmostEqual(row["q"], 5, places=2)
        self.assertAlmostEqual(row["rev"], 100.0, places=2)

    def test_indexes_exist(self):
        names = {r["name"] for r in db.query(
            "SELECT name FROM sqlite_master WHERE type='index'")}
        for idx in ("idx_sales_date", "idx_sale_items_product", "idx_expenses_date"):
            self.assertIn(idx, names)


class CashTenderTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _items(self, qty=2, unit=20.0):
        return json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                            "qty": qty, "unitPrice": unit, "costPrice": 1.0}])

    def test_change_due_calculated(self):
        s = self.call("complete_sale", self._items(), 0, 0, "Cash", "", "", "", None, 50)["data"]
        self.assertAlmostEqual(s["tendered"], 50.0, places=2)
        self.assertAlmostEqual(s["change_due"], 10.0, places=2)   # 50 - 40

    def test_exact_tender_gives_zero_change(self):
        s = self.call("complete_sale", self._items(), 0, 0, "Cash", "", "", "", None, 40)["data"]
        self.assertAlmostEqual(s["change_due"], 0.0, places=2)

    def test_short_tender_rejected(self):
        res = self.call("complete_sale", self._items(), 0, 0, "Cash", "", "", "", None, 5)
        self.assertFalse(res["ok"])
        self.assertIn("less than", res["msg"].lower())

    def test_no_tender_is_allowed(self):
        s = self.call("complete_sale", self._items(), 0, 0, "Card")["data"]
        self.assertIsNone(s["tendered"])

    def test_tender_against_credit_deposit_only(self):
        # Owing 40, deposit 10, hands over 20 -> change is on the deposit, not the total.
        s = self.call("complete_sale", self._items(), 0, 0, "Credit", "", "Ama", "", 10, 20)["data"]
        self.assertAlmostEqual(s["change_due"], 10.0, places=2)
        self.assertAlmostEqual(s["balance"], 30.0, places=2)


class StockAdjustmentTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def test_adjust_down_records_everything(self):
        start = self.p["stock"]
        res = self.call("adjust_stock", self.p["id"], start - 3, "Damage", "broken")
        self.assertTrue(res["ok"], res.get("msg"))
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start - 3)
        adj = self.call("get_stock_adjustments")["data"]
        self.assertEqual(adj[0]["reason"], "Damage")
        self.assertAlmostEqual(adj[0]["delta"], -3, places=2)
        # A stock movement is recorded too, so the movement log stays complete.
        mv = db.query("SELECT * FROM stock_movements WHERE reference LIKE 'Adjustment%' ORDER BY id DESC")
        self.assertTrue(mv)

    def test_adjust_up_works(self):
        start = self.p["stock"]
        self.assertTrue(self.call("adjust_stock", self.p["id"], start + 5, "Found stock")["ok"])
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start + 5)

    def test_invalid_reason_rejected(self):
        res = self.call("adjust_stock", self.p["id"], 5, "Because I said so")
        self.assertFalse(res["ok"])

    def test_negative_quantity_rejected(self):
        self.assertFalse(self.call("adjust_stock", self.p["id"], -5, "Damage")["ok"])

    def test_no_change_rejected(self):
        res = self.call("adjust_stock", self.p["id"], self.p["stock"], "Count correction")
        self.assertFalse(res["ok"])

    def test_cashier_cannot_adjust(self):
        self.login_as("cashier")
        self.assertFalse(self.call("adjust_stock", self.p["id"], 1, "Damage")["ok"])


class VoidSaleTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _sell(self, qty=2, payment="Cash", **kw):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": qty, "unitPrice": 20.0, "costPrice": 1.0}])
        if payment == "Credit":
            return self.call("complete_sale", items, 0, 0, "Credit", "", "Ama", "", 0)
        return self.call("complete_sale", items, 0, 0, payment)

    def test_void_restocks_and_marks(self):
        start = self.p["stock"]
        s = self._sell(2)["data"]
        res = self.call("void_sale", s["id"], "rung up twice")
        self.assertTrue(res["ok"], res.get("msg"))
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start, "stock must return to its pre-sale level")
        row = db.query("SELECT voided, status, void_reason FROM sales WHERE id=?", (s["id"],))[0]
        self.assertEqual(row["voided"], 1)
        self.assertEqual(row["status"], "Voided")
        self.assertEqual(row["void_reason"], "rung up twice")

    def test_reason_required(self):
        s = self._sell()["data"]
        self.assertFalse(self.call("void_sale", s["id"], "")["ok"])

    def test_double_void_blocked(self):
        s = self._sell()["data"]
        self.assertTrue(self.call("void_sale", s["id"], "mistake")["ok"])
        self.assertFalse(self.call("void_sale", s["id"], "again")["ok"])

    def test_void_clears_credit_balance(self):
        s = self._sell(payment="Credit")["data"]
        self.assertGreater(s["balance"], 0)
        self.assertTrue(self.call("void_sale", s["id"], "cancelled order")["ok"])
        row = db.query("SELECT balance FROM sales WHERE id=?", (s["id"],))[0]
        self.assertAlmostEqual(row["balance"], 0, places=2)

    def test_void_requires_pin_when_configured(self):
        self.call("save_settings", json.dumps({"below_cost_pin": "4321"}))
        s = self._sell()["data"]
        self.assertFalse(self.call("void_sale", s["id"], "oops")["ok"])
        self.assertTrue(self.call("void_sale", s["id"], "oops", "4321")["ok"])

    def test_void_does_not_double_restock_returned_items(self):
        start = self.p["stock"]
        s = self._sell(3)["data"]                                  # stock -3
        self.call("save_return", s["id"], self.p["id"], self.p["name"], 1, "Defective", 1, 20.0)
        self.assertTrue(self.call("void_sale", s["id"], "cancelled")["ok"])
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start, "returned unit must not be restocked twice")


class WeightedCostTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def test_purchase_blends_cost(self):
        old_stock, old_cost = self.p["stock"], self.p["cost_price"]
        new_unit = old_cost * 2
        po = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                          "qty": old_stock, "unitCost": new_unit}])
        self.assertTrue(self.call("save_purchase", "Acme", po, "")["ok"])
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        expected = (old_stock * old_cost + old_stock * new_unit) / (old_stock * 2)
        self.assertAlmostEqual(after["cost_price"], expected, places=2)
        self.assertGreater(after["cost_price"], old_cost)

    def test_zero_unit_cost_leaves_cost_untouched(self):
        old_cost = self.p["cost_price"]
        po = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                          "qty": 5, "unitCost": 0}])
        self.call("save_purchase", "Acme", po, "")
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertAlmostEqual(after["cost_price"], old_cost, places=4)


class AuditLogTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _actions(self):
        return {e["action"] for e in self.call("get_audit_log")["data"]}

    def test_void_is_audited_with_user(self):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": 1, "unitPrice": 20.0, "costPrice": 1.0}])
        s = self.call("complete_sale", items, 0, 0, "Cash")["data"]
        self.call("void_sale", s["id"], "test")
        entries = [e for e in self.call("get_audit_log")["data"] if e["action"] == "sale.void"]
        self.assertTrue(entries)
        self.assertEqual(entries[0]["user_name"], "Test admin")
        self.assertIn("test", entries[0]["detail"])

    def test_stock_adjustment_audited(self):
        self.call("adjust_stock", self.p["id"], self.p["stock"] - 1, "Theft/Loss")
        self.assertIn("stock.adjust", self._actions())

    def test_settings_change_audited_without_leaking_pin(self):
        self.call("save_settings", json.dumps({"currency": "GH₵", "below_cost_pin": "9876"}))
        entries = [e for e in self.call("get_audit_log")["data"] if e["action"] == "settings.update"]
        self.assertTrue(entries)
        self.assertNotIn("9876", entries[0]["detail"] or "")
        self.assertNotIn("below_cost_pin", entries[0]["detail"] or "")

    def test_credit_payment_audited(self):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": 1, "unitPrice": 20.0, "costPrice": 1.0}])
        s = self.call("complete_sale", items, 0, 0, "Credit", "", "Ama", "", 0)["data"]
        self.call("record_credit_payment", s["id"], 5, "Cash", "", "")
        self.assertIn("credit.payment", self._actions())

    def test_non_admin_cannot_read_audit_log(self):
        self.login_as("manager")
        self.assertFalse(self.call("get_audit_log")["ok"])

    def test_audit_never_breaks_the_operation(self):
        """Even if the audit table is missing, the operation must succeed."""
        db.execute("DROP TABLE audit_log")
        res = self.call("adjust_stock", self.p["id"], self.p["stock"] - 1, "Damage")
        self.assertTrue(res["ok"], "audit failure must not block the adjustment")


class BackupRestoreTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_backup_creates_a_valid_database(self):
        dest = os.path.join(tempfile.mkdtemp(), "bk.db")
        res = self.call("backup_database", dest)
        self.assertTrue(res["ok"], res.get("msg"))
        self.assertTrue(os.path.exists(dest) and os.path.getsize(dest) > 0)
        import sqlite3 as s3
        conn = s3.connect(dest)
        n = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        conn.close()
        self.assertGreater(n, 0)

    def test_restore_round_trip(self):
        dest = os.path.join(tempfile.mkdtemp(), "bk.db")
        self.call("backup_database", dest)
        before = len(self.call("get_all_products")["data"])
        # Destroy some data, then restore.
        db.execute("DELETE FROM products")
        self.assertEqual(len(self.call("get_all_products")["data"]), 0)
        res = self.call("restore_database", dest)
        self.assertTrue(res["ok"], res.get("msg"))
        self.assertEqual(len(db.query("SELECT id FROM products")), before)

    def test_restore_rejects_a_non_database(self):
        junk = os.path.join(tempfile.mkdtemp(), "junk.db")
        with open(junk, "w") as fh:
            fh.write("this is not a database")
        res = self.call("restore_database", junk)
        self.assertFalse(res["ok"])

    def test_restore_rejects_unrelated_database(self):
        import sqlite3 as s3
        other = os.path.join(tempfile.mkdtemp(), "other.db")
        conn = s3.connect(other); conn.execute("CREATE TABLE cats(name TEXT)"); conn.commit(); conn.close()
        res = self.call("restore_database", other)
        self.assertFalse(res["ok"])
        self.assertIn("not a Dwatrex backup", res["msg"])

    def test_non_admin_cannot_backup_or_restore(self):
        self.login_as("manager")
        self.assertFalse(self.call("backup_database", "/tmp/x.db")["ok"])
        self.assertFalse(self.call("restore_database", "/tmp/x.db")["ok"])


class LoginLockoutTests(BaseCase):
    def setUp(self):
        super().setUp()
        StoreHubAPI._failed_logins.clear()

    def test_lockout_after_repeated_failures(self):
        for _ in range(StoreHubAPI.LOCKOUT_AFTER):
            self.assertFalse(self.call("login", "admin", "wrong")["ok"])
        res = self.call("login", "admin", "admin123")     # correct password, still locked
        self.assertFalse(res["ok"])
        self.assertIn("Too many failed attempts", res["msg"])

    def test_successful_login_clears_the_counter(self):
        self.call("login", "admin", "wrong")
        self.assertTrue(self.call("login", "admin", "admin123")["ok"])
        self.assertNotIn("admin", StoreHubAPI._failed_logins)

    def test_warns_before_locking(self):
        for _ in range(StoreHubAPI.LOCKOUT_AFTER - 2):
            self.call("login", "admin", "wrong")
        res = self.call("login", "admin", "wrong")
        self.assertIn("left before a lockout", res["msg"])

    def test_lockout_is_per_username(self):
        for _ in range(StoreHubAPI.LOCKOUT_AFTER):
            self.call("login", "admin", "wrong")
        self.assertTrue(self.call("login", "john_m", "pass123")["ok"])


class QuoteTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _items(self, qty=2, unit=20.0):
        return json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                            "qty": qty, "unitPrice": unit, "costPrice": 1.0}])

    def test_quote_does_not_touch_stock_or_revenue(self):
        start = self.p["stock"]
        sales_before = len(self.call("get_sales")["data"])
        res = self.call("save_quote", self._items(), 0, 0, "Ama Mensah", "0240000000", "wiring job")
        self.assertTrue(res["ok"], res.get("msg"))
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start, "a quote must not reserve or deduct stock")
        self.assertEqual(len(self.call("get_sales")["data"]), sales_before,
                         "a quote must not create a sale")

    def test_quote_totals(self):
        q = self.call("save_quote", self._items(2, 20.0), 10, 0, "Ama")["data"]
        self.assertAlmostEqual(q["subtotal"], 40.0, places=2)
        self.assertAlmostEqual(q["total"], 36.0, places=2)      # 10% off
        self.assertEqual(q["status"], "Open")

    def test_customer_name_required(self):
        self.assertFalse(self.call("save_quote", self._items(), 0, 0, "")["ok"])

    def test_convert_creates_sale_and_moves_stock(self):
        start = self.p["stock"]
        q = self.call("save_quote", self._items(2), 0, 0, "Ama")["data"]
        res = self.call("convert_quote", q["id"], "Cash")
        self.assertTrue(res["ok"], res.get("msg"))
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start - 2, "stock moves only on conversion")
        row = db.query("SELECT status, sale_id FROM quotes WHERE id=?", (q["id"],))[0]
        self.assertEqual(row["status"], "Converted")
        self.assertIsNotNone(row["sale_id"])

    def test_cannot_convert_twice(self):
        q = self.call("save_quote", self._items(1), 0, 0, "Ama")["data"]
        self.assertTrue(self.call("convert_quote", q["id"], "Cash")["ok"])
        self.assertFalse(self.call("convert_quote", q["id"], "Cash")["ok"])

    def test_convert_fails_gracefully_without_stock(self):
        q = self.call("save_quote", self._items(self.p["stock"] + 50), 0, 0, "Ama")["data"]
        res = self.call("convert_quote", q["id"], "Cash")
        self.assertFalse(res["ok"])
        self.assertIn("Insufficient", res["msg"])
        # The quote must stay open so it can be converted once restocked.
        self.assertEqual(db.query("SELECT status FROM quotes WHERE id=?", (q["id"],))[0]["status"], "Open")

    def test_cancel_quote(self):
        q = self.call("save_quote", self._items(), 0, 0, "Ama")["data"]
        self.assertTrue(self.call("cancel_quote", q["id"])["ok"])
        self.assertEqual(db.query("SELECT status FROM quotes WHERE id=?", (q["id"],))[0]["status"], "Cancelled")

    def test_cannot_cancel_converted_quote(self):
        q = self.call("save_quote", self._items(1), 0, 0, "Ama")["data"]
        self.call("convert_quote", q["id"], "Cash")
        self.assertFalse(self.call("cancel_quote", q["id"])["ok"])

    def test_open_value_total(self):
        self.call("save_quote", self._items(1, 10.0), 0, 0, "A")
        self.call("save_quote", self._items(1, 25.0), 0, 0, "B")
        self.assertAlmostEqual(self.call("get_quotes", "Open")["data"]["openValue"], 35.0, places=2)


class HeldSaleTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _items(self):
        return json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                            "qty": 2, "unitPrice": 20.0, "costPrice": 1.0}])

    def test_hold_then_resume_round_trip(self):
        start = self.p["stock"]
        h = self.call("hold_sale", self._items(), 0, 0, "Waiting customer")
        self.assertTrue(h["ok"])
        after = next(x for x in self.call("get_all_products")["data"] if x["id"] == self.p["id"])
        self.assertEqual(after["stock"], start, "holding must not touch stock")
        held = self.call("get_held_sales")["data"]
        self.assertEqual(len(held), 1)
        res = self.call("resume_held_sale", held[0]["id"])
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["data"]["items"]), 1)
        self.assertEqual(len(self.call("get_held_sales")["data"]), 0, "resuming removes the hold")

    def test_empty_cart_cannot_be_held(self):
        self.assertFalse(self.call("hold_sale", "[]", 0, 0, "")["ok"])

    def test_discard_held(self):
        self.call("hold_sale", self._items(), 0, 0, "x")
        hid = self.call("get_held_sales")["data"][0]["id"]
        self.assertTrue(self.call("delete_held_sale", hid)["ok"])
        self.assertEqual(len(self.call("get_held_sales")["data"]), 0)


class SplitPaymentTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _items(self):
        return json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                            "qty": 2, "unitPrice": 20.0, "costPrice": 1.0}])   # total 40

    def test_split_recorded(self):
        split = json.dumps([{"method": "Cash", "amount": 25},
                            {"method": "Mobile Money", "amount": 15}])
        res = self.call("complete_sale", self._items(), 0, 0, "Split", "", "", "", None, None, split)
        self.assertTrue(res["ok"], res.get("msg"))
        legs = db.query("SELECT * FROM sale_payments WHERE sale_id=?", (res["data"]["id"],))
        self.assertEqual(len(legs), 2)
        self.assertAlmostEqual(sum(l["amount"] for l in legs), 40.0, places=2)

    def test_split_must_reconcile(self):
        split = json.dumps([{"method": "Cash", "amount": 10},
                            {"method": "Mobile Money", "amount": 5}])
        res = self.call("complete_sale", self._items(), 0, 0, "Split", "", "", "", None, None, split)
        self.assertFalse(res["ok"])
        self.assertIn("Split payments total", res["msg"])


class CreditAgeingTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")
        self.p = self.first_product()

    def _credit_sale(self, name, unit=20.0, days_ago=0):
        items = json.dumps([{"productId": self.p["id"], "name": self.p["name"],
                             "qty": 1, "unitPrice": unit, "costPrice": 1.0}])
        s = self.call("complete_sale", items, 0, 0, "Credit", "", name, "0240000000", 0)["data"]
        if days_ago:
            import datetime as _dt
            when = (_dt.datetime.now() - _dt.timedelta(days=days_ago)).isoformat()
            db.execute("UPDATE sales SET date=? WHERE id=?", (when, s["id"]))
        return s

    def test_grouped_by_customer(self):
        self._credit_sale("Ama", 20.0)
        self._credit_sale("Ama", 30.0)
        self._credit_sale("Kofi", 10.0)
        data = self.call("get_credit_by_customer")["data"]
        ama = next(c for c in data["customers"] if c["customer"] == "Ama")
        self.assertAlmostEqual(ama["balance"], 50.0, places=2)
        self.assertEqual(ama["sales"], 2)
        self.assertEqual(data["totals"]["customers"], 2)

    def test_ageing_buckets(self):
        self._credit_sale("Ama", 10.0, days_ago=5)     # current
        self._credit_sale("Ama", 20.0, days_ago=45)    # 30-60
        self._credit_sale("Ama", 40.0, days_ago=120)   # 90+
        ama = next(c for c in self.call("get_credit_by_customer")["data"]["customers"]
                   if c["customer"] == "Ama")
        self.assertAlmostEqual(ama["current"], 10.0, places=2)
        self.assertAlmostEqual(ama["d30"], 20.0, places=2)
        self.assertAlmostEqual(ama["d90"], 40.0, places=2)
        self.assertGreaterEqual(ama["oldestDays"], 120)

    def test_settled_and_voided_excluded(self):
        s = self._credit_sale("Ama", 20.0)
        self.call("record_credit_payment", s["id"], 20.0, "Cash", "", "")   # settle it
        self.assertEqual(self.call("get_credit_by_customer")["data"]["totals"]["outstanding"], 0)

    def test_customer_detail(self):
        s = self._credit_sale("Ama", 20.0)
        self.call("record_credit_payment", s["id"], 5, "Cash", "", "")
        d = self.call("get_customer_credit_detail", "Ama")["data"]
        self.assertAlmostEqual(d["balance"], 15.0, places=2)
        self.assertEqual(len(d["payments"]), 1)


class RecurringExpenseTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_posts_once_per_month(self):
        self.assertTrue(self.call("save_recurring_expense", None, "Rent", "Shop rent",
                                  "500", "Bank Transfer", 1, 1)["ok"])
        first = self.call("post_due_recurring_expenses")
        self.assertTrue(first["ok"])
        self.assertEqual(len(first["data"]["posted"]), 1)
        # Running again in the same month must not double-charge.
        second = self.call("post_due_recurring_expenses")
        self.assertEqual(len(second["data"]["posted"]), 0)

    def test_not_posted_before_its_day(self):
        import datetime as _dt
        tomorrow = min(28, _dt.date.today().day + 1)
        if tomorrow <= _dt.date.today().day:
            self.skipTest("month-end edge; covered by the idempotency test")
        self.call("save_recurring_expense", None, "Rent", "Future rent", "500", "Cash", tomorrow, 1)
        res = self.call("post_due_recurring_expenses")
        self.assertEqual(len(res["data"]["posted"]), 0)

    def test_inactive_not_posted(self):
        self.call("save_recurring_expense", None, "Rent", "Paused", "500", "Cash", 1, 0)
        self.assertEqual(len(self.call("post_due_recurring_expenses")["data"]["posted"]), 0)

    def test_amount_must_be_positive(self):
        self.assertFalse(self.call("save_recurring_expense", None, "Rent", "x", "0", "Cash", 1, 1)["ok"])


class TaxComponentTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_components_saved_and_total_synced(self):
        comps = json.dumps([{"name": "VAT", "rate": 15}, {"name": "NHIL", "rate": 2.5},
                            {"name": "GETFund", "rate": 2.5}])
        self.assertTrue(self.call("save_tax_components", comps)["ok"])
        cfg = self.call("get_tax_config")["data"]
        self.assertEqual(len(cfg["components"]), 3)
        self.assertAlmostEqual(cfg["totalRate"], 20.0, places=2)
        rate = db.query("SELECT value FROM settings WHERE key='taxRate'")[0]["value"]
        self.assertAlmostEqual(float(rate), 20.0, places=2)

    def test_breakdown_splits_tax_proportionally(self):
        self.call("save_tax_components", json.dumps(
            [{"name": "VAT", "rate": 15}, {"name": "NHIL", "rate": 5}]))
        parts = self.api._tax_breakdown(20.0)          # 20 total tax on a 15/5 split
        self.assertAlmostEqual(parts[0]["amount"], 15.0, places=2)
        self.assertAlmostEqual(parts[1]["amount"], 5.0, places=2)

    def test_falls_back_to_flat_rate(self):
        db.execute("DELETE FROM settings WHERE key='taxComponents'")
        db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('taxRate','7.5')")
        comps = self.api.get_tax_components()
        self.assertEqual(len(comps), 1)
        self.assertAlmostEqual(comps[0]["rate"], 7.5, places=2)

    def test_invalid_rate_rejected(self):
        self.assertFalse(self.call("save_tax_components",
                                   json.dumps([{"name": "VAT", "rate": 500}]))["ok"])


class UnitAndBarcodeTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_measured_unit_allows_fractional_stock(self):
        res = self.call("save_product", None, "CBL-1", "2.5mm Cable", "Lighting", "",
                        "3.5", "6.0", "12.5", "5", "", "yard", "")
        self.assertTrue(res["ok"], res.get("msg"))
        p = next(x for x in self.call("get_all_products")["data"] if x["sku"] == "CBL-1")
        self.assertAlmostEqual(p["stock"], 12.5, places=2)
        self.assertEqual(p["unit"], "yard")

    def test_whole_unit_rounds_stock(self):
        self.call("save_product", None, "BX-1", "Box of bulbs", "Lighting", "",
                  "10", "15", "7.9", "2", "", "each", "")
        p = next(x for x in self.call("get_all_products")["data"] if x["sku"] == "BX-1")
        self.assertEqual(p["stock"], 7, "'each' items must hold whole numbers")

    def test_invalid_unit_falls_back(self):
        self.call("save_product", None, "U-1", "Thing", "Lighting", "",
                  "1", "2", "5", "1", "", "furlongs", "")
        p = next(x for x in self.call("get_all_products")["data"] if x["sku"] == "U-1")
        self.assertEqual(p["unit"], "each")

    def test_barcode_lookup(self):
        self.call("save_product", None, "BC-1", "Scanned Item", "Lighting", "",
                  "1", "2", "5", "1", "", "each", "5901234123457")
        res = self.call("find_product_by_code", "5901234123457")
        self.assertTrue(res["ok"])
        self.assertEqual(res["data"]["sku"], "BC-1")

    def test_sku_lookup_also_works(self):
        self.assertTrue(self.call("find_product_by_code", self.first_product()["sku"])["ok"])

    def test_unknown_code_reports_clearly(self):
        res = self.call("find_product_by_code", "does-not-exist")
        self.assertFalse(res["ok"])
        self.assertIn("No product matches", res["msg"])


class ProductPaginationTests(BaseCase):
    def setUp(self):
        super().setUp()
        self.login_as("admin")

    def test_paged_response_shape(self):
        res = self.call("get_products", "", "", "", 10, 0)["data"]
        self.assertIn("products", res)
        self.assertIn("total", res)
        self.assertLessEqual(len(res["products"]), 10)
        self.assertGreater(res["total"], 10)

    def test_offset_returns_different_rows(self):
        p1 = self.call("get_products", "", "", "", 5, 0)["data"]["products"]
        p2 = self.call("get_products", "", "", "", 5, 5)["data"]["products"]
        self.assertNotEqual([x["id"] for x in p1], [x["id"] for x in p2])

    def test_unpaged_still_returns_a_bare_list(self):
        """Existing callers pass no limit and must keep getting a plain list."""
        data = self.call("get_products", "", "", "")["data"]
        self.assertIsInstance(data, list)

    def test_every_product_is_reachable_by_paging(self):
        total = self.call("get_products", "", "", "", 1, 0)["data"]["total"]
        seen = set()
        page = 0
        while len(seen) < total and page < 100:
            rows = self.call("get_products", "", "", "", 10, page * 10)["data"]["products"]
            if not rows:
                break
            seen.update(r["id"] for r in rows)
            page += 1
        self.assertEqual(len(seen), total, "no product may be unreachable")


if __name__ == "__main__":
    unittest.main(verbosity=2)
