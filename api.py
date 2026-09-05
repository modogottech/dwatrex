"""
Dwatrex API layer — exposed to the frontend via pywebview's JS bridge.
Every public method becomes callable from JavaScript as window.pywebview.api.<method>(...)

Authorization: roles are enforced HERE, on the backend. The frontend hides
navigation per role, but that is cosmetic only — every sensitive method
re-checks the authenticated user's role on the server side.
"""
import json
import re
import sqlite3
from datetime import datetime, timedelta
import database as db


def _to_number(value, default=0.0):
    """Parse a number tolerantly from CSV/user input: ignores thousands
    separators, currency symbols, and stray spaces (e.g. 'GH₵1,200.00')."""
    s = re.sub(r'[^0-9.\-]', '', str(value if value is not None else ''))
    if s in ('', '-', '.', '-.', '--'):
        return default
    try:
        return float(s)
    except ValueError:
        return default


# Page/capability permissions per role (mirrors the frontend nav, authoritative here).
# Note: 'profits' is a pseudo-permission (not a navigable page). It gates
# profit/margin visibility — the dashboard profit tiles, the Profit & Loss and
# Profit-by-Period reports, and cost data carried on sales. Only admin holds it.
ROLE_PERMS = {
    'admin':     {'dashboard', 'products', 'categories', 'suppliers', 'sales',
                  'purchases', 'inventory', 'returns', 'reports', 'insights',
                  'expenses', 'users', 'settings', 'profits', 'credit'},
    'manager':   {'dashboard', 'products', 'categories', 'suppliers', 'sales',
                  'purchases', 'inventory', 'returns', 'reports', 'credit'},
    'cashier':   {'dashboard', 'sales', 'returns', 'credit'},
    'inventory': {'dashboard', 'products', 'categories', 'suppliers',
                  'purchases', 'inventory'},
}


class StoreHubAPI:

    def __init__(self):
        # Server-side session. Set on successful login, cleared on logout.
        self._current_user = None

    # ── helpers ─────────────────────────────────────────────
    def _ok(self, data=None, msg="success"):
        return json.dumps({"ok": True, "data": data, "msg": msg})

    def _err(self, msg="error"):
        return json.dumps({"ok": False, "data": None, "msg": msg})

    def _require_auth(self):
        """Return an error JSON string if no user is logged in, else None."""
        if not self._current_user:
            return self._err("Not authenticated. Please sign in.")
        return None

    def _require_perm(self, perm):
        """Return an error JSON string unless the current user's role grants `perm`."""
        if not self._current_user:
            return self._err("Not authenticated. Please sign in.")
        role = self._current_user.get('role')
        if perm not in ROLE_PERMS.get(role, set()):
            return self._err("Permission denied for your role.")
        return None

    def _has_perm(self, perm):
        """True if the current user's role grants `perm` (no error side effect)."""
        if not self._current_user:
            return False
        return perm in ROLE_PERMS.get(self._current_user.get('role'), set())

    def _audit(self, action, entity=None, entity_id=None, detail=None, conn=None):
        """Append an audit entry. Never raises — auditing must not break the
        operation it is recording."""
        try:
            u = self._current_user or {}
            row = (datetime.now().isoformat(), u.get('id'), u.get('name'), u.get('role'),
                   action, entity, str(entity_id) if entity_id is not None else None,
                   detail if isinstance(detail, str) else (json.dumps(detail) if detail else None))
            sql = ("INSERT INTO audit_log(date,user_id,user_name,role,action,entity,entity_id,detail) "
                   "VALUES(?,?,?,?,?,?,?,?)")
            if conn is not None:
                conn.execute(sql, row)
            else:
                db.execute(sql, row)
        except Exception:
            pass

    def get_audit_log(self, date_from="", date_to="", action="", limit=500):
        """Recent audit entries (admin only)."""
        err = self._require_perm('users')      # admin-only capability
        if err: return err
        sql, params = "SELECT * FROM audit_log WHERE 1=1", []
        if date_from:
            sql += " AND date >= ?"; params.append(date_from)
        if date_to:
            sql += " AND date <= ?"; params.append(date_to + "T23:59:59")
        if action:
            sql += " AND action = ?"; params.append(action)
        sql += " ORDER BY date DESC LIMIT ?"
        params.append(int(limit))
        return self._ok(db.query(sql, tuple(params)))

    @staticmethod
    def get_week_start_day():
        """Configured first day of the business week: 0=Monday … 6=Sunday."""
        row = db.query("SELECT value FROM settings WHERE key='weekStart'")
        try:
            return max(0, min(6, int(row[0]['value']))) if row else 0
        except (ValueError, TypeError, KeyError, IndexError):
            return 0

    @classmethod
    def _week_start_date(cls, when=None):
        """Midnight on the first day of the calendar week containing `when`.

        Python's weekday() is 0=Monday … 6=Sunday, matching how the setting is
        stored, so the offset is a simple modulo.
        """
        when = when or datetime.now()
        start_day = cls.get_week_start_day()
        days_since = (when.weekday() - start_day) % 7
        d = (when - timedelta(days=days_since)).date()
        return datetime(d.year, d.month, d.day)

    @staticmethod
    def _month_start_date(when=None):
        """Midnight on the 1st of the calendar month containing `when`."""
        when = when or datetime.now()
        return datetime(when.year, when.month, 1)

    @staticmethod
    def _resolve_backdate(date_str):
        """Turn an optional 'YYYY-MM-DD' into a timestamp for a back-dated record.

        Blank -> now. A past/today date keeps the current clock time so records
        stay ordered sensibly. Future dates are rejected.
        """
        date_str = (date_str or '').strip()
        if not date_str:
            return datetime.now().isoformat()
        try:
            d = datetime.strptime(date_str[:10], '%Y-%m-%d').date()
        except ValueError:
            raise ValueError("Invalid date. Use YYYY-MM-DD.")
        today = datetime.now().date()
        if d > today:
            raise ValueError("Date cannot be in the future.")
        if d == today:
            return datetime.now().isoformat()
        now_t = datetime.now().time()
        return datetime.combine(d, now_t).isoformat()

    # ── First-Run Setup ────────────────────────────────────
    def check_first_run(self):
        """Returns whether setup is needed.

        Setup is needed if the first-run flag isn't set OR if there are no user
        accounts at all — the latter guards against ever showing a login screen
        with no account to log into (e.g. an interrupted setup)."""
        needs = (not db.is_setup_complete()) or (db.user_count() == 0)
        return self._ok({'setupNeeded': needs})

    def complete_setup(self, store_name, admin_name, admin_username, admin_password):
        """Complete first-run setup: create admin and mark as done."""
        if not store_name or not admin_name or not admin_username or not admin_password:
            return self._err("All fields are required")
        if len(admin_password) < 8:
            return self._err("Password must be at least 8 characters")
        if db.is_setup_complete():
            return self._err("Setup has already been completed")
        existing = db.query("SELECT id FROM users WHERE username=?", (admin_username,))
        if existing:
            return self._err("Username already taken")
        try:
            db.complete_first_run_setup(store_name, admin_name, admin_username, admin_password)
            return self._ok(msg="Setup complete")
        except Exception as e:
            return self._err(str(e))

    # ── Authentication ─────────────────────────────────────
    # Failed-login tracking (in memory: resets when the app restarts, which is
    # fine — it exists to stop sustained guessing at the till, not a botnet).
    _failed_logins = {}
    LOCKOUT_AFTER = 5
    LOCKOUT_SECONDS = 60

    def login(self, username, password):
        """Authenticate user and return their profile (without password)."""
        key = (username or '').strip().lower()
        rec = self._failed_logins.get(key)
        if rec and rec['count'] >= self.LOCKOUT_AFTER:
            waited = (datetime.now() - rec['at']).total_seconds()
            # Each failure past the threshold doubles the wait, capped at 15 min.
            penalty = min(self.LOCKOUT_SECONDS * (2 ** (rec['count'] - self.LOCKOUT_AFTER)), 900)
            if waited < penalty:
                left = int(penalty - waited)
                return self._err(f"Too many failed attempts. Try again in {left} second"
                                 f"{'' if left == 1 else 's'}.")

        user = db.authenticate_user(username, password)
        if user:
            self._failed_logins.pop(key, None)
            safe_user = {k: v for k, v in user.items() if k != 'password'}
            self._current_user = {'id': user['id'], 'name': user['name'], 'role': user['role']}
            self._audit('auth.login', 'user', user['id'], {'username': username})
            return self._ok(safe_user, "Login successful")

        rec = self._failed_logins.setdefault(key, {'count': 0, 'at': datetime.now()})
        rec['count'] += 1
        rec['at'] = datetime.now()
        if rec['count'] == self.LOCKOUT_AFTER:
            self._audit('auth.lockout', 'user', None,
                        {'username': username, 'attempts': rec['count']})
        remaining = self.LOCKOUT_AFTER - rec['count']
        if 0 < remaining <= 2:
            return self._err(f"Invalid username or password. {remaining} attempt"
                             f"{'' if remaining == 1 else 's'} left before a lockout.")
        return self._err("Invalid username or password")

    def logout(self):
        """Clear the server-side session."""
        self._current_user = None
        return self._ok(msg="Logged out")

    def _update_product_status(self, product_id, conn=None):
        owns = conn is None
        conn = conn or db.get_conn()
        try:
            row = conn.execute("SELECT stock, reorder_level FROM products WHERE id=?", (product_id,)).fetchone()
            if row:
                stock, reorder = row['stock'], row['reorder_level']
                st = 'Out of Stock' if stock <= 0 else ('Low Stock' if stock <= reorder else 'In Stock')
                conn.execute("UPDATE products SET status=? WHERE id=?", (st, product_id))
                if owns:
                    conn.commit()
        finally:
            if owns:
                conn.close()

    # ── Settings ────────────────────────────────────────────
    def get_settings(self):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT key, value FROM settings")
        out = {}
        pin_set = False
        for r in rows:
            if r['key'] == 'below_cost_pin':
                pin_set = bool(r['value'])   # never expose the hash itself
                continue
            out[r['key']] = r['value']
        out['below_cost_pin_set'] = pin_set
        return self._ok(out)

    def save_settings(self, settings_json):
        err = self._require_perm('settings')
        if err: return err
        try:
            s = json.loads(settings_json)
            with db.transaction() as conn:
                for k, v in s.items():
                    # The below-cost approval PIN is stored hashed, never in plain text.
                    if k == 'below_cost_pin':
                        v = str(v)
                        if v == '':
                            continue                     # blank -> keep existing PIN
                        if v == '__clear__':
                            conn.execute("DELETE FROM settings WHERE key='below_cost_pin'")
                            continue
                        if len(v) < 4:
                            raise ValueError("Approval PIN must be at least 4 characters")
                        conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('below_cost_pin',?)",
                                     (db.hash_password(v),))
                        continue
                    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, str(v)))
            self._audit('settings.update', 'settings', None,
                        {'keys': sorted(k for k in s.keys() if k != 'below_cost_pin')})
            return self._ok(msg="Settings saved")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not save settings: {e}")

    # ── Categories ──────────────────────────────────────────
    def get_categories(self):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT * FROM categories ORDER BY name")
        return self._ok(rows)

    def save_category(self, id, name):
        err = self._require_perm('categories')
        if err: return err
        name = (name or '').strip()
        if not name:
            return self._err("Category name is required")
        try:
            with db.transaction() as conn:
                if id:
                    old = conn.execute("SELECT name FROM categories WHERE id=?", (id,)).fetchone()
                    if old:
                        conn.execute("UPDATE products SET category=? WHERE category=?", (name, old['name']))
                    conn.execute("UPDATE categories SET name=? WHERE id=?", (name, id))
                else:
                    conn.execute("INSERT INTO categories(name) VALUES(?)", (name,))
            return self._ok(msg="Category saved")
        except sqlite3.IntegrityError:
            return self._err(f"A category named '{name}' already exists")
        except Exception as e:
            return self._err(f"Could not save category: {e}")

    def delete_category(self, id):
        err = self._require_perm('categories')
        if err: return err
        try:
            with db.transaction() as conn:
                row = conn.execute("SELECT name FROM categories WHERE id=?", (id,)).fetchone()
                affected = 0
                if row:
                    cur = conn.execute("UPDATE products SET category='' WHERE category=?", (row['name'],))
                    affected = cur.rowcount
                conn.execute("DELETE FROM categories WHERE id=?", (id,))
            msg = "Category deleted"
            if affected:
                msg += f" ({affected} product(s) left uncategorized)"
            return self._ok(msg=msg)
        except Exception as e:
            return self._err(f"Could not delete category: {e}")

    def bulk_import_categories(self, names_json):
        """Import categories from a JSON array of names. Skips duplicates."""
        err = self._require_perm('categories')
        if err: return err
        try:
            names = json.loads(names_json)
            existing = {r['name'].lower() for r in db.query("SELECT name FROM categories")}
            added = skipped = 0
            with db.transaction() as conn:
                for name in names:
                    name = str(name).strip()
                    if not name:
                        continue
                    if name.lower() in existing:
                        skipped += 1
                        continue
                    conn.execute("INSERT INTO categories(name) VALUES(?)", (name,))
                    existing.add(name.lower())
                    added += 1
            return self._ok({'added': added, 'skipped': skipped},
                            f"Imported {added} categories ({skipped} duplicates skipped)")
        except Exception as e:
            return self._err(f"Import failed: {e}")

    # ── Suppliers ───────────────────────────────────────────
    def get_suppliers(self):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT * FROM suppliers ORDER BY name")
        return self._ok(rows)

    def save_supplier(self, id, name, contact, email, phone):
        err = self._require_perm('suppliers')
        if err: return err
        name = (name or '').strip()
        if not name:
            return self._err("Supplier name is required")
        try:
            with db.transaction() as conn:
                if id:
                    conn.execute("UPDATE suppliers SET name=?,contact=?,email=?,phone=? WHERE id=?",
                                 (name, contact, email, phone, id))
                else:
                    conn.execute("INSERT INTO suppliers(name,contact,email,phone) VALUES(?,?,?,?)",
                                 (name, contact, email, phone))
            return self._ok(msg="Supplier saved")
        except Exception as e:
            return self._err(f"Could not save supplier: {e}")

    def delete_supplier(self, id):
        err = self._require_perm('suppliers')
        if err: return err
        try:
            db.execute("DELETE FROM suppliers WHERE id=?", (id,))
            return self._ok(msg="Supplier deleted")
        except Exception as e:
            return self._err(f"Could not delete supplier: {e}")

    # ── Products ────────────────────────────────────────────
    # Units a small retailer actually sells in. 'each' is a whole-number unit;
    # the measured ones allow fractional quantities (2.5 yards of cable).
    UNITS = ['each', 'yard', 'metre', 'foot', 'kg', 'gram', 'litre', 'box', 'roll', 'pack']
    WHOLE_UNITS = {'each', 'box', 'pack'}

    def get_units(self):
        err = self._require_auth()
        if err: return err
        return self._ok({'units': self.UNITS, 'whole': sorted(self.WHOLE_UNITS)})

    def get_products(self, search="", category="", status="", limit=0, offset=0):
        """Products, optionally paged. `limit=0` returns everything (the POS
        and reports need the full list); the catalogue screen passes a page."""
        err = self._require_auth()
        if err: return err
        where, params = "FROM products WHERE 1=1", []
        if search:
            where += " AND (name LIKE ? OR sku LIKE ? OR COALESCE(barcode,'') LIKE ?)"
            params += [f"%{search}%", f"%{search}%", f"%{search}%"]
        if category:
            where += " AND category=?"
            params.append(category)
        if status:
            where += " AND status=?"
            params.append(status)
        total = db.query(f"SELECT COUNT(*) AS c {where}", tuple(params))[0]['c']
        sql = f"SELECT * {where} ORDER BY name"
        limit = int(_to_number(limit, 0))
        if limit > 0:
            sql += " LIMIT ? OFFSET ?"
            params += [limit, int(_to_number(offset, 0))]
        rows = db.query(sql, tuple(params))
        # Older callers expect a bare list; keep that contract and attach the
        # count separately so pagination is additive, not breaking.
        return self._ok({'products': rows, 'total': total} if limit > 0 else rows)

    def find_product_by_code(self, code):
        """Exact lookup by barcode or SKU — the scan-to-add path at the till."""
        err = self._require_auth()
        if err: return err
        code = (code or '').strip()
        if not code:
            return self._err("No code supplied")
        rows = db.query("SELECT * FROM products WHERE barcode=? OR sku=? LIMIT 1", (code, code))
        if not rows:
            return self._err(f"No product matches '{code}'")
        return self._ok(rows[0])

    def save_product(self, id, sku, name, category, supplier, cost_price, selling_price,
                     stock, reorder_level, expiry, unit="each", barcode=""):
        err = self._require_perm('products')
        if err: return err
        sku = (sku or '').strip()
        name = (name or '').strip()
        barcode = (barcode or '').strip()
        unit = (unit or 'each').strip().lower()
        if unit not in self.UNITS:
            unit = 'each'
        if not sku or not name:
            return self._err("SKU and product name are required")
        try:
            # Measured goods (cable by the yard) may hold fractional stock.
            stock = float(stock)
            if unit in self.WHOLE_UNITS:
                stock = int(stock)
            reorder_level = float(reorder_level)
            cost_price = float(cost_price)
            selling_price = float(selling_price)
        except (ValueError, TypeError):
            return self._err("Numeric fields must be valid numbers")
        if stock < 0 or reorder_level < 0 or cost_price < 0 or selling_price < 0:
            return self._err("Numeric fields cannot be negative")
        st = 'Out of Stock' if stock <= 0 else ('Low Stock' if stock <= reorder_level else 'In Stock')
        try:
            with db.transaction() as conn:
                if id:
                    conn.execute("""UPDATE products SET sku=?,name=?,category=?,supplier=?,cost_price=?,
                                  selling_price=?,stock=?,reorder_level=?,expiry=?,status=?,unit=?,barcode=?
                                  WHERE id=?""",
                                 (sku, name, category, supplier, cost_price, selling_price,
                                  stock, reorder_level, expiry or None, st, unit, barcode or None, id))
                else:
                    conn.execute("""INSERT INTO products(sku,name,category,supplier,cost_price,selling_price,
                                  stock,reorder_level,expiry,status,unit,barcode)
                                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                                 (sku, name, category, supplier, cost_price, selling_price,
                                  stock, reorder_level, expiry or None, st, unit, barcode or None))
            return self._ok(msg="Product saved")
        except sqlite3.IntegrityError:
            return self._err(f"A product with SKU '{sku}' already exists")
        except Exception as e:
            return self._err(f"Could not save product: {e}")

    def delete_product(self, id):
        err = self._require_perm('products')
        if err: return err
        try:
            db.execute("DELETE FROM products WHERE id=?", (id,))
            self._audit('product.delete', 'product', id)
            return self._ok(msg="Product deleted")
        except Exception as e:
            return self._err(f"Could not delete product: {e}")

    def bulk_import_products(self, products_json):
        """Import products from a JSON array of objects. Skips rows with duplicate SKU."""
        err = self._require_perm('products')
        if err: return err
        try:
            products = json.loads(products_json)
        except Exception as e:
            return self._err(f"Invalid import data: {e}")
        existing_skus = {r['sku'].lower() for r in db.query("SELECT sku FROM products")}
        existing_cats = {r['name'].lower() for r in db.query("SELECT name FROM categories")}
        added = skipped = 0
        errors = []
        try:
            with db.transaction() as conn:
                for i, p in enumerate(products):
                    try:
                        sku = str(p.get('sku', '')).strip()
                        name = str(p.get('name', '')).strip()
                        if not sku or not name:
                            errors.append(f"Row {i+1}: SKU and Name are required")
                            continue
                        if sku.lower() in existing_skus:
                            skipped += 1
                            continue
                        category = str(p.get('category', '')).strip()
                        supplier = str(p.get('supplier', '')).strip()
                        cost_price = _to_number(p.get('cost_price', 0))
                        selling_price = _to_number(p.get('selling_price', 0))
                        stock = int(_to_number(p.get('stock', 0)))
                        rl_raw = str(p.get('reorder_level', '')).strip()
                        reorder_level = int(_to_number(rl_raw, 10)) if rl_raw else 10
                        expiry = str(p.get('expiry', '')).strip() or None
                        st = 'Out of Stock' if stock <= 0 else ('Low Stock' if stock <= reorder_level else 'In Stock')
                        conn.execute("""INSERT INTO products(sku,name,category,supplier,cost_price,selling_price,
                                      stock,reorder_level,expiry,status) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                                     (sku, name, category, supplier, cost_price, selling_price,
                                      stock, reorder_level, expiry, st))
                        if category and category.lower() not in existing_cats:
                            conn.execute("INSERT INTO categories(name) VALUES(?)", (category,))
                            existing_cats.add(category.lower())
                        existing_skus.add(sku.lower())
                        added += 1
                    except Exception as e:
                        errors.append(f"Row {i+1}: {str(e)}")
        except Exception as e:
            return self._err(f"Import failed: {e}")
        msg = f"Imported {added} products ({skipped} duplicates skipped)"
        if errors:
            msg += f". {len(errors)} errors."
        return self._ok({'added': added, 'skipped': skipped, 'errors': errors[:10]}, msg)

    # ── Sales (POS) ─────────────────────────────────────────
    def get_sales(self, date_from="", date_to=""):
        err = self._require_auth()
        if err: return err
        sql = "SELECT * FROM sales WHERE 1=1"
        params = []
        if date_from:
            sql += " AND date >= ?"
            params.append(date_from)
        if date_to:
            sql += " AND date <= ?"
            params.append(date_to + "T23:59:59")
        sql += " ORDER BY date DESC"
        rows = db.query(sql, params)
        for r in rows:
            r['items'] = json.loads(r['items_json'])
        return self._ok(rows)

    @staticmethod
    def get_tax_components():
        """Configured tax components, e.g. VAT / NHIL / GETFund.

        Ghana layers several levies rather than charging one rate, so the
        receipt must be able to show them separately. Falls back to a single
        component built from the plain `taxRate` setting.
        """
        rows = db.query("SELECT value FROM settings WHERE key='taxComponents'")
        if rows and rows[0]['value']:
            try:
                parts = json.loads(rows[0]['value'])
                out = [{'name': str(p.get('name', 'Tax')), 'rate': float(p.get('rate', 0))}
                       for p in parts if float(p.get('rate', 0)) > 0]
                if out:
                    return out
            except (ValueError, TypeError):
                pass
        rate_rows = db.query("SELECT value FROM settings WHERE key='taxRate'")
        rate = _to_number(rate_rows[0]['value'], 0) if rate_rows else 0
        return [{'name': 'Tax', 'rate': rate}] if rate > 0 else []

    def _tax_breakdown(self, tax_amt):
        """Split a sale's tax into its configured components for the receipt."""
        comps = self.get_tax_components()
        total_rate = sum(c['rate'] for c in comps)
        if not comps or total_rate <= 0 or not tax_amt:
            return []
        return [{'name': c['name'], 'rate': c['rate'],
                 'amount': round(tax_amt * c['rate'] / total_rate, 2)} for c in comps]

    def get_tax_config(self):
        err = self._require_auth()
        if err: return err
        comps = self.get_tax_components()
        return self._ok({'components': comps,
                         'totalRate': round(sum(c['rate'] for c in comps), 4)})

    def save_tax_components(self, components_json):
        """Replace the tax component list (admin only)."""
        err = self._require_perm('settings')
        if err: return err
        try:
            parts = json.loads(components_json)
            clean = []
            for p in parts:
                name = str(p.get('name', '')).strip()
                rate = _to_number(p.get('rate'), 0)
                if not name:
                    continue
                if rate < 0 or rate > 100:
                    return self._err(f"'{name}' has an invalid rate")
                clean.append({'name': name, 'rate': rate})
            db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('taxComponents',?)",
                       (json.dumps(clean),))
            # Keep the flat rate in step so existing screens stay correct.
            db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('taxRate',?)",
                       (str(round(sum(c['rate'] for c in clean), 4)),))
            self._audit('settings.tax_updated', 'settings', None,
                        {'components': [c['name'] for c in clean],
                         'total': round(sum(c['rate'] for c in clean), 4)})
            return self._ok({'components': clean}, "Tax settings saved")
        except Exception as e:
            return self._err(f"Could not save tax settings: {e}")

    def complete_sale(self, items_json, discount, tax, payment, approval_pin="",
                      customer_name="", customer_phone="", amount_paid=None,
                      tendered=None, split_json=""):
        """Record a sale. When `payment` is 'Credit' a customer name is required and
        `amount_paid` is any deposit taken now; the rest becomes an outstanding
        balance. Credit sales still count as revenue immediately (accrual).
        `tendered` is cash handed over, used to compute change due."""
        err = self._require_perm('sales')
        if err: return err
        try:
            items = json.loads(items_json)
            if not items:
                return self._err("Cart is empty")
            discount = float(discount)
            tax = float(tax)
            if discount < 0 or discount > 100 or tax < 0:
                return self._err("Invalid discount or tax")
            is_credit = str(payment).strip().lower() == 'credit'
            customer_name = (customer_name or '').strip()
            customer_phone = (customer_phone or '').strip()
            if is_credit and not customer_name:
                return self._err("Customer name is required for a credit sale")
            now = datetime.now().isoformat()
            with db.transaction() as conn:
                # Validate stock for every line BEFORE mutating anything, and detect
                # any line sold at/below the product's real cost (from the DB, not
                # the client, so it can't be spoofed).
                below_cost = False
                for i in items:
                    qty = int(i['qty'])
                    if qty <= 0:
                        raise ValueError("Quantities must be positive")
                    row = conn.execute("SELECT stock, name, cost_price, category FROM products WHERE id=?",
                                       (i['productId'],)).fetchone()
                    if not row:
                        raise ValueError(f"Product '{i.get('name', '?')}' no longer exists")
                    if row['stock'] < qty:
                        raise ValueError(f"Insufficient stock for {row['name']} (have {row['stock']}, need {qty})")
                    unit = float(i['unitPrice'])
                    if unit <= 0 or unit < row['cost_price']:
                        below_cost = True
                    # Cost and category come from the database, never the client,
                    # so margins cannot be falsified by a tampered request.
                    i['costPrice'] = row['cost_price']
                    i['category'] = row['category']

                # A below-cost sale requires the admin-set approval PIN (if configured).
                if below_cost:
                    pin_row = conn.execute("SELECT value FROM settings WHERE key='below_cost_pin'").fetchone()
                    pin_hash = pin_row['value'] if pin_row else None
                    if pin_hash:
                        if not approval_pin or not db.verify_password(str(approval_pin), pin_hash):
                            raise ValueError("Below-cost sale requires the manager approval PIN.")

                subtotal = sum(i['qty'] * i['unitPrice'] for i in items)
                discount_amt = subtotal * discount / 100
                tax_amt = (subtotal - discount_amt) * tax / 100
                total = subtotal - discount_amt + tax_amt

                # Credit: any deposit taken now, remainder owed. Otherwise paid in full.
                if is_credit:
                    paid = _to_number(amount_paid, 0) if amount_paid not in (None, '') else 0.0
                    if paid < 0:
                        raise ValueError("Deposit cannot be negative")
                    if paid > total + 0.001:
                        raise ValueError("Deposit cannot exceed the sale total")
                    balance = round(total - paid, 2)
                    status = 'Completed' if balance <= 0.001 else 'Credit'
                else:
                    paid, balance, status = total, 0.0, 'Completed'

                # Cash handling: change due when more was tendered than owed.
                tend = _to_number(tendered, 0) if tendered not in (None, '') else None
                change = None
                if tend is not None and tend > 0:
                    due = paid if is_credit else total
                    if tend + 0.001 < due:
                        raise ValueError(f"Amount tendered is less than the {round(due, 2)} due")
                    change = round(tend - due, 2)

                cur = conn.execute(
                    """INSERT INTO sales(date,items_json,subtotal,discount,tax,discount_amt,tax_amt,total,payment,status,
                                         customer_name,customer_phone,amount_paid,balance,tendered,change_due,voided)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)""",
                    (now, json.dumps(items), subtotal, discount, tax, discount_amt, tax_amt, total, payment, status,
                     customer_name or None, customer_phone or None, round(paid, 2), balance, tend, change))
                sale_id = cur.lastrowid

                for i in items:
                    conn.execute("UPDATE products SET stock = stock - ? WHERE id=?", (i['qty'], i['productId']))
                    conn.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) VALUES(?,?,?,?,?,?)",
                                 (now, i['productId'], i['name'], 'OUT', i['qty'], f'Sale #{sale_id}'))
                    # Normalised line, so reports can aggregate in SQL.
                    conn.execute(
                        "INSERT INTO sale_items(sale_id,product_id,name,category,qty,unit_price,cost_price,date) "
                        "VALUES(?,?,?,?,?,?,?,?)",
                        (sale_id, i['productId'], i['name'], i.get('category'),
                         i['qty'], i['unitPrice'], i['costPrice'], now))
                    self._update_product_status(i['productId'], conn)

                if below_cost:
                    self._audit('sale.below_cost_approved', 'sale', sale_id,
                                {'total': round(total, 2), 'lines': len(items)}, conn)
                if discount and discount > 0:
                    self._audit('sale.discount', 'sale', sale_id,
                                {'discount_pct': discount, 'amount': round(discount_amt, 2)}, conn)

                # Split payment: record each leg. Must add up to what was paid.
                if split_json:
                    try:
                        legs = json.loads(split_json)
                    except (ValueError, TypeError):
                        raise ValueError("Invalid split payment data")
                    legs = [{'method': str(l.get('method', 'Cash')),
                             'amount': _to_number(l.get('amount'), 0)} for l in legs]
                    legs = [l for l in legs if l['amount'] > 0]
                    if legs:
                        expected = paid if is_credit else total
                        got = round(sum(l['amount'] for l in legs), 2)
                        if abs(got - round(expected, 2)) > 0.01:
                            raise ValueError(
                                f"Split payments total {got} but {round(expected, 2)} is due")
                        for l in legs:
                            conn.execute("INSERT INTO sale_payments(sale_id,method,amount) VALUES(?,?,?)",
                                         (sale_id, l['method'], round(l['amount'], 2)))

                sale = dict(conn.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone())
                sale['payments'] = [dict(r) for r in conn.execute(
                    "SELECT method, amount FROM sale_payments WHERE sale_id=?", (sale_id,))]
            sale['items'] = items
            sale['taxComponents'] = self._tax_breakdown(sale.get('tax_amt') or 0)
            return self._ok(sale, "Sale completed")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Sale failed: {e}")

    def void_sale(self, sale_id, reason="", approval_pin=""):
        """Reverse a whole sale: restock every line, clear any credit balance,
        and mark it voided. Requires the approval PIN when one is configured.
        The sale is kept (never deleted) so the audit trail stays intact."""
        err = self._require_perm('sales')
        if err: return err
        reason = (reason or '').strip()
        if not reason:
            return self._err("A reason is required to void a sale")
        try:
            now = datetime.now().isoformat()
            with db.transaction() as conn:
                sale = conn.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
                if not sale:
                    raise ValueError("Sale not found")
                if sale['voided']:
                    raise ValueError("That sale has already been voided")

                pin_row = conn.execute("SELECT value FROM settings WHERE key='below_cost_pin'").fetchone()
                pin_hash = pin_row['value'] if pin_row else None
                if pin_hash and (not approval_pin or not db.verify_password(str(approval_pin), pin_hash)):
                    raise ValueError("Voiding a sale requires the manager approval PIN.")

                # Anything already returned was restocked once; don't double-count.
                returned = {r['product_id']: r['q'] for r in conn.execute(
                    "SELECT product_id, COALESCE(SUM(qty),0) AS q FROM returns "
                    "WHERE sale_id=? AND resellable=1 GROUP BY product_id", (sale_id,))}

                items = json.loads(sale['items_json'] or '[]')
                for i in items:
                    pid = i.get('productId')
                    qty = float(i.get('qty', 0)) - float(returned.get(pid, 0))
                    if qty <= 0:
                        continue
                    conn.execute("UPDATE products SET stock = stock + ? WHERE id=?", (qty, pid))
                    conn.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) "
                                 "VALUES(?,?,?,?,?,?)",
                                 (now, pid, i.get('name'), 'IN', qty, f'Void Sale #{sale_id}'))
                    self._update_product_status(pid, conn)

                conn.execute("UPDATE sales SET voided=1, status='Voided', void_reason=?, "
                             "balance=0 WHERE id=?", (reason, sale_id))
                self._audit('sale.void', 'sale', sale_id,
                            {'reason': reason, 'total': sale['total'],
                             'was_credit': sale['payment'] == 'Credit'}, conn)
            return self._ok({'id': sale_id}, "Sale voided and stock returned")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not void sale: {e}")

    # ── Quotes / price estimates ────────────────────────────
    def get_quotes(self, status="Open"):
        """Quotes, newest first. status: 'Open', 'Converted', 'Cancelled' or ''."""
        err = self._require_perm('sales')
        if err: return err
        sql, params = "SELECT * FROM quotes WHERE 1=1", []
        if status:
            sql += " AND status = ?"; params.append(status)
        sql += " ORDER BY date DESC LIMIT 500"
        rows = db.query(sql, tuple(params))
        for r in rows:
            try:
                r['items'] = json.loads(r['items_json'] or '[]')
            except (ValueError, TypeError):
                r['items'] = []
        open_total = db.query(
            "SELECT COALESCE(SUM(total),0) AS v FROM quotes WHERE status='Open'")[0]['v']
        return self._ok({'quotes': rows, 'openValue': round(open_total, 2)})

    def save_quote(self, items_json, discount, tax, customer_name="",
                   customer_phone="", notes="", quote_id=None):
        """Create or update a price estimate.

        Deliberately does NOT move stock or record revenue — a quote is only a
        priced list until it is converted.
        """
        err = self._require_perm('sales')
        if err: return err
        try:
            items = json.loads(items_json)
            if not items:
                return self._err("Add at least one item to the quote")
            discount = float(discount or 0)
            tax = float(tax or 0)
            if discount < 0 or discount > 100 or tax < 0:
                return self._err("Invalid discount or tax")
            customer_name = (customer_name or '').strip()
            if not customer_name:
                return self._err("Customer name is required on a quote")

            now = datetime.now().isoformat()
            with db.transaction() as conn:
                # Price from the catalogue where possible so a quote can't be
                # built on stale or spoofed prices.
                for i in items:
                    row = conn.execute("SELECT name, unit FROM products WHERE id=?",
                                       (i.get('productId'),)).fetchone()
                    if row:
                        i['name'] = row['name']
                        i['unit'] = row['unit'] or 'each'
                    if float(i.get('qty', 0)) <= 0:
                        raise ValueError("Quantities must be greater than zero")

                subtotal = sum(float(i['qty']) * float(i['unitPrice']) for i in items)
                discount_amt = subtotal * discount / 100
                tax_amt = (subtotal - discount_amt) * tax / 100
                total = subtotal - discount_amt + tax_amt
                who = (self._current_user or {}).get('name', '')

                if quote_id:
                    cur = conn.execute("SELECT status FROM quotes WHERE id=?", (quote_id,)).fetchone()
                    if not cur:
                        raise ValueError("Quote not found")
                    if cur['status'] != 'Open':
                        raise ValueError("Only an open quote can be edited")
                    conn.execute(
                        """UPDATE quotes SET customer_name=?,customer_phone=?,items_json=?,subtotal=?,
                           discount=?,tax=?,discount_amt=?,tax_amt=?,total=?,notes=? WHERE id=?""",
                        (customer_name, customer_phone or None, json.dumps(items), subtotal,
                         discount, tax, discount_amt, tax_amt, total, notes or None, quote_id))
                    qid = quote_id
                else:
                    c2 = conn.execute(
                        """INSERT INTO quotes(date,customer_name,customer_phone,items_json,subtotal,
                           discount,tax,discount_amt,tax_amt,total,notes,status,created_by)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?, 'Open', ?)""",
                        (now, customer_name, customer_phone or None, json.dumps(items), subtotal,
                         discount, tax, discount_amt, tax_amt, total, notes or None, who))
                    qid = c2.lastrowid
                self._audit('quote.saved' if not quote_id else 'quote.updated', 'quote', qid,
                            {'customer': customer_name, 'total': round(total, 2)}, conn)
                quote = dict(conn.execute("SELECT * FROM quotes WHERE id=?", (qid,)).fetchone())
            quote['items'] = items
            return self._ok(quote, f"Quote #{qid} saved")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not save quote: {e}")

    def cancel_quote(self, quote_id):
        err = self._require_perm('sales')
        if err: return err
        row = db.query("SELECT status FROM quotes WHERE id=?", (quote_id,))
        if not row:
            return self._err("Quote not found")
        if row[0]['status'] == 'Converted':
            return self._err("That quote has already become a sale")
        db.execute("UPDATE quotes SET status='Cancelled' WHERE id=?", (quote_id,))
        self._audit('quote.cancelled', 'quote', quote_id)
        return self._ok(msg="Quote cancelled")

    def convert_quote(self, quote_id, payment="Cash", approval_pin="",
                      amount_paid=None, tendered=None):
        """Turn an open quote into a real sale. Stock moves only now."""
        err = self._require_perm('sales')
        if err: return err
        row = db.query("SELECT * FROM quotes WHERE id=?", (quote_id,))
        if not row:
            return self._err("Quote not found")
        q = row[0]
        if q['status'] != 'Open':
            return self._err(f"That quote is already {q['status'].lower()}")

        raw = self.complete_sale(q['items_json'], q['discount'], q['tax'], payment,
                                 approval_pin, q['customer_name'] or '',
                                 q['customer_phone'] or '', amount_paid, tendered)
        res = json.loads(raw)
        if not res.get('ok'):
            return raw                      # surface the reason (e.g. no stock)
        sale_id = res['data']['id']
        db.execute("UPDATE quotes SET status='Converted', sale_id=? WHERE id=?", (sale_id, quote_id))
        self._audit('quote.converted', 'quote', quote_id,
                    {'sale_id': sale_id, 'total': q['total']})
        res['msg'] = f"Quote #{quote_id} converted to sale #{sale_id}"
        return json.dumps(res)

    # ── Held (parked) sales ─────────────────────────────────
    def get_held_sales(self):
        err = self._require_perm('sales')
        if err: return err
        rows = db.query("SELECT * FROM held_sales ORDER BY date DESC")
        for r in rows:
            try:
                r['items'] = json.loads(r['items_json'] or '[]')
            except (ValueError, TypeError):
                r['items'] = []
        return self._ok(rows)

    def hold_sale(self, items_json, discount=0, tax=0, label=""):
        """Park the current cart so the till is free for the next customer."""
        err = self._require_perm('sales')
        if err: return err
        try:
            items = json.loads(items_json)
            if not items:
                return self._err("Cart is empty — nothing to hold")
            cur = db.execute(
                "INSERT INTO held_sales(date,label,items_json,discount,tax,held_by) VALUES(?,?,?,?,?,?)",
                (datetime.now().isoformat(), (label or '').strip() or None, json.dumps(items),
                 float(discount or 0), float(tax or 0), (self._current_user or {}).get('name', '')))
            return self._ok({'id': cur}, "Sale held")
        except Exception as e:
            return self._err(f"Could not hold sale: {e}")

    def resume_held_sale(self, held_id):
        err = self._require_perm('sales')
        if err: return err
        rows = db.query("SELECT * FROM held_sales WHERE id=?", (held_id,))
        if not rows:
            return self._err("That held sale is no longer available")
        r = rows[0]
        db.execute("DELETE FROM held_sales WHERE id=?", (held_id,))
        try:
            r['items'] = json.loads(r['items_json'] or '[]')
        except (ValueError, TypeError):
            r['items'] = []
        return self._ok(r, "Sale resumed")

    def delete_held_sale(self, held_id):
        err = self._require_perm('sales')
        if err: return err
        db.execute("DELETE FROM held_sales WHERE id=?", (held_id,))
        return self._ok(msg="Held sale discarded")

    # ── Recurring expenses ──────────────────────────────────
    def get_recurring_expenses(self):
        err = self._require_perm('expenses')
        if err: return err
        return self._ok(db.query("SELECT * FROM recurring_expenses ORDER BY category, description"))

    def save_recurring_expense(self, id, category, description, amount, payment, day_of_month, active=1):
        err = self._require_perm('expenses')
        if err: return err
        try:
            amt = _to_number(amount, 0)
            if amt <= 0:
                return self._err("Amount must be greater than zero")
            day = max(1, min(28, int(_to_number(day_of_month, 1))))   # 28 is safe in every month
            if id:
                db.execute("UPDATE recurring_expenses SET category=?,description=?,amount=?,payment=?,"
                           "day_of_month=?,active=? WHERE id=?",
                           (category, description, amt, payment, day, 1 if active else 0, id))
            else:
                db.execute("INSERT INTO recurring_expenses(category,description,amount,payment,day_of_month,active) "
                           "VALUES(?,?,?,?,?,?)", (category, description, amt, payment, day, 1 if active else 0))
            self._audit('expense.recurring_saved', 'recurring_expense', id,
                        {'category': category, 'amount': amt})
            return self._ok(msg="Recurring expense saved")
        except Exception as e:
            return self._err(f"Could not save: {e}")

    def delete_recurring_expense(self, id):
        err = self._require_perm('expenses')
        if err: return err
        db.execute("DELETE FROM recurring_expenses WHERE id=?", (id,))
        return self._ok(msg="Recurring expense removed")

    def post_due_recurring_expenses(self):
        """Create expense entries for any active template due this month.

        Idempotent: `last_posted` records the month already posted, so running
        this repeatedly (e.g. on every launch) never double-charges.
        """
        err = self._require_auth()
        if err: return err
        today = datetime.now()
        this_month = today.strftime('%Y-%m')
        posted = []
        try:
            with db.transaction() as conn:
                for r in conn.execute("SELECT * FROM recurring_expenses WHERE active=1").fetchall():
                    if (r['last_posted'] or '') >= this_month:
                        continue                       # already posted this month
                    if today.day < (r['day_of_month'] or 1):
                        continue                       # not due yet
                    when = today.replace(day=min(r['day_of_month'] or 1, today.day)).isoformat()
                    conn.execute("INSERT INTO expenses(date,category,description,amount,payment,created_by) "
                                 "VALUES(?,?,?,?,?,?)",
                                 (when, r['category'], f"{r['description']} (automatic)",
                                  r['amount'], r['payment'], 'Recurring'))
                    conn.execute("UPDATE recurring_expenses SET last_posted=? WHERE id=?",
                                 (this_month, r['id']))
                    posted.append({'category': r['category'], 'amount': r['amount']})
            if posted:
                self._audit('expense.recurring_posted', 'expenses', None,
                            {'count': len(posted), 'month': this_month})
            return self._ok({'posted': posted}, f"{len(posted)} recurring expense(s) posted")
        except Exception as e:
            return self._err(f"Could not post recurring expenses: {e}")

    # ── Stock adjustments ───────────────────────────────────
    ADJUSTMENT_REASONS = ['Count correction', 'Damage', 'Theft/Loss', 'Expiry',
                          'Supplier shortage', 'Found stock', 'Other']

    def get_stock_adjustments(self, date_from="", date_to=""):
        err = self._require_perm('inventory')
        if err: return err
        sql, params = "SELECT * FROM stock_adjustments WHERE 1=1", []
        if date_from:
            sql += " AND date >= ?"; params.append(date_from)
        if date_to:
            sql += " AND date <= ?"; params.append(date_to + "T23:59:59")
        sql += " ORDER BY date DESC LIMIT 500"
        return self._ok(db.query(sql, tuple(params)))

    def adjust_stock(self, product_id, new_qty, reason, note="", date=""):
        """Set a product's stock to a counted figure, recording why.

        This is the correct way to fix stock after a stocktake — using a fake
        sale or purchase would corrupt revenue and COGS.
        """
        err = self._require_perm('inventory')
        if err: return err
        try:
            reason = (reason or '').strip()
            if reason not in self.ADJUSTMENT_REASONS:
                return self._err("Choose a valid reason for the adjustment")
            after = _to_number(new_qty, None)
            if after is None or after < 0:
                return self._err("Enter a valid new quantity (0 or more)")
            when = self._resolve_backdate(date)
            with db.transaction() as conn:
                row = conn.execute("SELECT id, name, stock FROM products WHERE id=?", (product_id,)).fetchone()
                if not row:
                    raise ValueError("Product not found")
                before = row['stock']
                delta = round(after - before, 4)
                if abs(delta) < 0.0001:
                    raise ValueError("That is the same as the current stock — nothing to adjust")
                conn.execute("UPDATE products SET stock=? WHERE id=?", (after, product_id))
                conn.execute("INSERT INTO stock_adjustments(date,product_id,product_name,before_qty,after_qty,"
                             "delta,reason,note,adjusted_by) VALUES(?,?,?,?,?,?,?,?,?)",
                             (when, product_id, row['name'], before, after, delta, reason, note,
                              (self._current_user or {}).get('name', '')))
                conn.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) "
                             "VALUES(?,?,?,?,?,?)",
                             (when, product_id, row['name'], 'IN' if delta > 0 else 'OUT',
                              abs(delta), f'Adjustment: {reason}'))
                self._update_product_status(product_id, conn)
                self._audit('stock.adjust', 'product', product_id,
                            {'before': before, 'after': after, 'delta': delta,
                             'reason': reason, 'note': note}, conn)
            return self._ok({'before': before, 'after': after, 'delta': delta},
                            f"Stock adjusted by {delta:+g}")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not adjust stock: {e}")

    # ── Backup / restore ────────────────────────────────────
    def backup_database(self, dest_path=""):
        """Write a backup. With no path, opens a native Save dialog."""
        err = self._require_perm('settings')
        if err: return err
        try:
            if not dest_path:
                import webview
                stamp = datetime.now().strftime('%Y-%m-%d_%H%M')
                win = webview.windows[0] if getattr(webview, 'windows', None) else None
                chosen = win.create_file_dialog(
                    webview.SAVE_DIALOG, save_filename=f'dwatrex-backup-{stamp}.db') if win else None
                if not chosen:
                    return self._err("Backup cancelled")
                dest_path = chosen if isinstance(chosen, str) else chosen[0]
            db.backup_to(dest_path)
            self._audit('data.backup', 'database', None, {'path': dest_path})
            return self._ok({'path': dest_path}, "Backup saved")
        except Exception as e:
            return self._err(f"Backup failed: {e}")

    def restore_database(self, src_path=""):
        """Replace the live database with a backup file (admin only)."""
        err = self._require_perm('settings')
        if err: return err
        try:
            if not src_path:
                import webview
                win = webview.windows[0] if getattr(webview, 'windows', None) else None
                chosen = win.create_file_dialog(
                    webview.OPEN_DIALOG, allow_multiple=False,
                    file_types=('Dwatrex backup (*.db)', 'All files (*.*)')) if win else None
                if not chosen:
                    return self._err("Restore cancelled")
                src_path = chosen[0] if isinstance(chosen, (list, tuple)) else chosen
            safety = db.restore_from(src_path)
            self._audit('data.restore', 'database', None, {'from': src_path, 'safety_copy': safety})
            self._current_user = None      # sessions from the old database are void
            return self._ok({'safetyCopy': safety},
                            "Database restored. Please sign in again.")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Restore failed: {e}")

    def get_backup_info(self):
        """Where backups live and when the last one was taken."""
        err = self._require_perm('settings')
        if err: return err
        import os as _os
        folder = _os.path.join(_os.path.dirname(db.DB_PATH), 'backups')
        latest, count = None, 0
        if _os.path.isdir(folder):
            files = [f for f in _os.listdir(folder) if f.endswith('.db')]
            count = len(files)
            if files:
                newest = max(files)
                latest = datetime.fromtimestamp(
                    _os.path.getmtime(_os.path.join(folder, newest))).strftime('%d %b %Y, %H:%M')
        size = _os.path.getsize(db.DB_PATH) if _os.path.exists(db.DB_PATH) else 0
        return self._ok({'folder': folder, 'autoBackups': count, 'lastAuto': latest,
                         'dbPath': db.DB_PATH, 'dbSizeKb': round(size / 1024)})

    # ── Credit sales / receivables ──────────────────────────
    def get_credit_sales(self, status="outstanding"):
        """Credit sales. status: 'outstanding' (balance owed), 'settled', or 'all'."""
        err = self._require_perm('credit')
        if err: return err
        sql = ("SELECT id,date,customer_name,customer_phone,total,amount_paid,balance,status,payment "
               "FROM sales WHERE payment='Credit'")
        if status == 'outstanding':
            sql += " AND balance > 0.001"
        elif status == 'settled':
            sql += " AND balance <= 0.001"
        sql += " ORDER BY date DESC"
        rows = db.query(sql)
        totals = {
            'outstanding': round(sum(r['balance'] or 0 for r in db.query(
                "SELECT balance FROM sales WHERE payment='Credit' AND balance > 0.001")), 2),
            'customers': len({r['customer_name'] for r in db.query(
                "SELECT customer_name FROM sales WHERE payment='Credit' AND balance > 0.001")}),
        }
        return self._ok({'sales': rows, 'totals': totals})

    def get_credit_by_customer(self):
        """Receivables grouped by customer, with 30/60/90-day ageing.

        Ageing runs from the sale date: the older a debt, the less likely it is
        to be collected, so the buckets tell you who to chase first.
        """
        err = self._require_perm('credit')
        if err: return err
        now = datetime.now()
        rows = db.query(
            "SELECT id,date,customer_name,customer_phone,total,amount_paid,balance "
            "FROM sales WHERE payment='Credit' AND balance > 0.001 AND COALESCE(voided,0)=0 "
            "ORDER BY date")
        people = {}
        for r in rows:
            key = (r['customer_name'] or 'Unknown').strip()
            p = people.setdefault(key, {
                'customer': key, 'phone': r['customer_phone'], 'balance': 0.0,
                'sales': 0, 'oldestDays': 0,
                'current': 0.0, 'd30': 0.0, 'd60': 0.0, 'd90': 0.0})
            try:
                age = (now - datetime.fromisoformat(r['date'])).days
            except (ValueError, TypeError):
                age = 0
            bal = r['balance'] or 0
            p['balance'] += bal
            p['sales'] += 1
            p['oldestDays'] = max(p['oldestDays'], age)
            if age <= 30:   p['current'] += bal
            elif age <= 60: p['d30'] += bal
            elif age <= 90: p['d60'] += bal
            else:           p['d90'] += bal
            if not p['phone'] and r['customer_phone']:
                p['phone'] = r['customer_phone']
        out = sorted(people.values(), key=lambda x: -x['balance'])
        for p in out:
            for k in ('balance', 'current', 'd30', 'd60', 'd90'):
                p[k] = round(p[k], 2)
        totals = {
            'outstanding': round(sum(p['balance'] for p in out), 2),
            'current': round(sum(p['current'] for p in out), 2),
            'd30': round(sum(p['d30'] for p in out), 2),
            'd60': round(sum(p['d60'] for p in out), 2),
            'd90': round(sum(p['d90'] for p in out), 2),
            'customers': len(out),
        }
        return self._ok({'customers': out, 'totals': totals})

    def get_customer_credit_detail(self, customer_name):
        """Every outstanding sale for one customer, plus their payment history."""
        err = self._require_perm('credit')
        if err: return err
        sales = db.query(
            "SELECT id,date,total,amount_paid,balance,status FROM sales "
            "WHERE payment='Credit' AND customer_name=? AND COALESCE(voided,0)=0 ORDER BY date DESC",
            (customer_name,))
        ids = [s['id'] for s in sales]
        payments = []
        if ids:
            marks = ','.join('?' * len(ids))
            payments = db.query(
                f"SELECT * FROM credit_payments WHERE sale_id IN ({marks}) ORDER BY date DESC",
                tuple(ids))
        owed = round(sum(s['balance'] or 0 for s in sales), 2)
        return self._ok({'customer': customer_name, 'sales': sales,
                         'payments': payments, 'balance': owed})

    def get_credit_payments(self, sale_id):
        err = self._require_perm('credit')
        if err: return err
        rows = db.query("SELECT * FROM credit_payments WHERE sale_id=? ORDER BY date DESC", (sale_id,))
        return self._ok(rows)

    def record_credit_payment(self, sale_id, amount, method="Cash", date="", note=""):
        """Record a (possibly partial) repayment against a credit sale."""
        err = self._require_perm('credit')
        if err: return err
        try:
            amt = _to_number(amount, 0)
            if amt <= 0:
                return self._err("Payment amount must be greater than zero")
            when = self._resolve_backdate(date)
            taken_by = (self._current_user or {}).get('name', '')
            with db.transaction() as conn:
                sale = conn.execute("SELECT total, amount_paid, balance, payment FROM sales WHERE id=?",
                                    (sale_id,)).fetchone()
                if not sale:
                    raise ValueError("Sale not found")
                if sale['payment'] != 'Credit':
                    raise ValueError("That sale is not a credit sale")
                balance = sale['balance'] or 0
                if balance <= 0.001:
                    raise ValueError("This credit sale is already settled")
                if amt > balance + 0.001:
                    raise ValueError(f"Payment exceeds the outstanding balance of {round(balance, 2)}")
                new_paid = round((sale['amount_paid'] or 0) + amt, 2)
                new_balance = round((sale['total'] or 0) - new_paid, 2)
                status = 'Completed' if new_balance <= 0.001 else 'Credit'
                conn.execute("UPDATE sales SET amount_paid=?, balance=?, status=? WHERE id=?",
                             (new_paid, new_balance, status, sale_id))
                conn.execute("INSERT INTO credit_payments(sale_id,date,amount,method,note,taken_by) VALUES(?,?,?,?,?,?)",
                             (sale_id, when, round(amt, 2), method, note, taken_by))
                self._audit('credit.payment', 'sale', sale_id,
                            {'amount': round(amt, 2), 'balance': new_balance,
                             'method': method, 'settled': new_balance <= 0.001}, conn)
            settled = new_balance <= 0.001
            return self._ok({'balance': new_balance, 'settled': settled},
                            "Payment recorded — account settled" if settled else "Payment recorded")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not record payment: {e}")

    # ── Purchases ───────────────────────────────────────────
    def get_purchases(self):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT * FROM purchases ORDER BY date DESC")
        for r in rows:
            r['items'] = json.loads(r['items_json'])
        return self._ok(rows)

    def save_purchase(self, supplier, items_json, date=""):
        """Record a purchase. `date` (YYYY-MM-DD) allows back-dating a purchase
        that was completed on an earlier day; blank means now."""
        err = self._require_perm('purchases')
        if err: return err
        try:
            items = json.loads(items_json)
            if not items:
                return self._err("Add at least one item")
            now = self._resolve_backdate(date)
            with db.transaction() as conn:
                for i in items:
                    if int(i['qty']) <= 0:
                        raise ValueError("Quantities must be positive")
                    if not conn.execute("SELECT 1 FROM products WHERE id=?", (i['productId'],)).fetchone():
                        raise ValueError(f"Product '{i.get('name', '?')}' no longer exists")
                total_cost = sum(i['qty'] * i['unitCost'] for i in items)
                cur = conn.execute(
                    "INSERT INTO purchases(date,supplier,items_json,total_cost,status) VALUES(?,?,?,?,?)",
                    (now, supplier, json.dumps(items), total_cost, 'Received'))
                po_id = cur.lastrowid
                for i in items:
                    pid, qty = i['productId'], float(i['qty'])
                    unit_cost = _to_number(i.get('unitCost'), 0)
                    # Weighted-average costing: blend the new landed cost into the
                    # existing stock so COGS follows supplier price changes.
                    row = conn.execute("SELECT stock, cost_price FROM products WHERE id=?", (pid,)).fetchone()
                    if row and unit_cost > 0:
                        old_stock = max(0.0, float(row['stock'] or 0))
                        old_cost = float(row['cost_price'] or 0)
                        denom = old_stock + qty
                        new_cost = ((old_stock * old_cost) + (qty * unit_cost)) / denom if denom > 0 else unit_cost
                        conn.execute("UPDATE products SET cost_price=? WHERE id=?", (round(new_cost, 4), pid))
                        if abs(new_cost - old_cost) > 0.005:
                            self._audit('product.cost_updated', 'product', pid,
                                        {'from': round(old_cost, 4), 'to': round(new_cost, 4),
                                         'reason': f'PO-{po_id}'}, conn)
                    conn.execute("UPDATE products SET stock = stock + ? WHERE id=?", (qty, pid))
                    conn.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) VALUES(?,?,?,?,?,?)",
                                 (now, pid, i['name'], 'IN', qty, f'PO-{po_id}'))
                    self._update_product_status(pid, conn)
            return self._ok(msg="Purchase recorded")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not record purchase: {e}")

    # ── Inventory ───────────────────────────────────────────
    def get_inventory_summary(self):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT * FROM products ORDER BY name")
        total_items = sum(r['stock'] for r in rows)
        total_value = sum(r['stock'] * r['cost_price'] for r in rows)
        low = sum(1 for r in rows if 0 < r['stock'] <= r['reorder_level'])
        out = sum(1 for r in rows if r['stock'] <= 0)
        return self._ok({'totalItems': total_items, 'totalValue': total_value, 'lowStock': low, 'outOfStock': out})

    def get_stock_movements(self, limit=50):
        err = self._require_auth()
        if err: return err
        try:
            limit = int(limit)
        except (ValueError, TypeError):
            limit = 50
        rows = db.query("SELECT * FROM stock_movements ORDER BY date DESC LIMIT ?", (limit,))
        return self._ok(rows)

    # ── Returns ─────────────────────────────────────────────
    def get_returns(self):
        err = self._require_auth()
        if err: return err
        return self._ok(db.query("SELECT * FROM returns ORDER BY date DESC"))

    def save_return(self, sale_id, product_id, product_name, qty, reason, resellable, unit_price):
        err = self._require_perm('returns')
        if err: return err
        try:
            qty = int(qty)
            product_id = int(product_id)
            resellable = int(resellable)
            unit_price = float(unit_price)
            if qty <= 0:
                return self._err("Return quantity must be positive")
            now = datetime.now().isoformat()
            with db.transaction() as conn:
                sale = conn.execute("SELECT items_json FROM sales WHERE id=?", (sale_id,)).fetchone()
                if not sale:
                    raise ValueError("Sale not found")
                sold = sum(int(i['qty']) for i in json.loads(sale['items_json'])
                           if int(i['productId']) == product_id)
                if sold == 0:
                    raise ValueError("That product was not part of this sale")
                already = conn.execute(
                    "SELECT COALESCE(SUM(qty),0) AS v FROM returns WHERE sale_id=? AND product_id=?",
                    (sale_id, product_id)).fetchone()['v']
                remaining = sold - already
                if qty > remaining:
                    raise ValueError(f"Cannot return {qty}; only {remaining} of this item remain returnable")

                refund = unit_price * qty
                cur = conn.execute(
                    "INSERT INTO returns(date,sale_id,product_id,product_name,qty,reason,resellable,refund) VALUES(?,?,?,?,?,?,?,?)",
                    (now, sale_id, product_id, product_name, qty, reason, resellable, refund))
                ret_id = cur.lastrowid
                if resellable:
                    conn.execute("UPDATE products SET stock = stock + ? WHERE id=?", (qty, product_id))
                    conn.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) VALUES(?,?,?,?,?,?)",
                                 (now, product_id, product_name, 'IN', qty, f'Return #{ret_id}'))
                    self._update_product_status(product_id, conn)
            return self._ok(msg="Return processed")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not process return: {e}")

    # ── Users ───────────────────────────────────────────────
    def get_users(self):
        err = self._require_perm('users')
        if err: return err
        rows = db.query("SELECT id, name, username, role, status FROM users ORDER BY name")
        return self._ok(rows)

    def save_user(self, id, name, username, password, role, status):
        """Create or update a user. Password is optional on update (blank = keep existing)."""
        err = self._require_perm('users')
        if err: return err
        name = (name or '').strip()
        username = (username or '').strip()
        if not name or not username or not role:
            return self._err("Name, username, and role are required")
        if role not in ROLE_PERMS:
            return self._err("Invalid role")
        try:
            with db.transaction() as conn:
                if id:
                    # Prevent self-lockout: an admin cannot demote/deactivate their own account.
                    if self._current_user and int(id) == self._current_user['id'] and \
                            (role != 'admin' or status != 'Active'):
                        raise ValueError("You cannot change your own role or deactivate yourself")
                    dup = conn.execute("SELECT id FROM users WHERE username=? AND id<>?", (username, id)).fetchone()
                    if dup:
                        raise ValueError("Username already taken")
                    if password:
                        if len(password) < 8:
                            raise ValueError("Password must be at least 8 characters")
                        conn.execute("UPDATE users SET name=?, username=?, password=?, role=?, status=? WHERE id=?",
                                     (name, username, db.hash_password(password), role, status, id))
                    else:
                        conn.execute("UPDATE users SET name=?, username=?, role=?, status=? WHERE id=?",
                                     (name, username, role, status, id))
                else:
                    if not password:
                        raise ValueError("Password is required for new users")
                    if len(password) < 8:
                        raise ValueError("Password must be at least 8 characters")
                    dup = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
                    if dup:
                        raise ValueError("Username already taken")
                    conn.execute("INSERT INTO users(name, username, password, role, status) VALUES(?,?,?,?,?)",
                                 (name, username, db.hash_password(password), role, status))
            return self._ok(msg="User saved")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Could not save user: {e}")

    def delete_user(self, id):
        err = self._require_perm('users')
        if err: return err
        if self._current_user and int(id) == self._current_user['id']:
            return self._err("You cannot delete your own account")
        # Don't allow deleting the last active admin.
        admins = db.query("SELECT id FROM users WHERE role='admin' AND status='Active'")
        if len(admins) <= 1 and any(a['id'] == int(id) for a in admins):
            return self._err("Cannot delete the last active admin")
        try:
            db.execute("DELETE FROM users WHERE id=?", (id,))
            return self._ok(msg="User deleted")
        except Exception as e:
            return self._err(f"Could not delete user: {e}")

    # ── Dashboard metrics ───────────────────────────────────
    def get_dashboard_data(self):
        err = self._require_auth()
        if err: return err
        now = datetime.now()
        today = now.strftime('%Y-%m-%d')
        # "This week" is a true calendar week starting on the configured day
        # (default Monday), not a rolling 7-day window.
        week_start = self._week_start_date(now).strftime('%Y-%m-%d')
        # "This month" is the calendar month to date (1st → now), so sales,
        # profit and expenses on the dashboard all cover the same period.
        month_start = self._month_start_date(now).strftime('%Y-%m-%d')

        today_sales = db.query("SELECT COALESCE(SUM(total),0) as v FROM sales WHERE date >= ?", (today,))
        week_sales = db.query("SELECT COALESCE(SUM(total),0) as v FROM sales WHERE date >= ?", (week_start,))
        month_sales = db.query("SELECT COALESCE(SUM(total),0) as v FROM sales WHERE date >= ?", (month_start,))
        total_tx = db.query("SELECT COUNT(*) as v FROM sales")[0]['v']
        products = db.query("SELECT * FROM products")
        inv_value = sum(p['stock'] * p['cost_price'] for p in products)
        low_stock = sum(1 for p in products if p['stock'] <= p['reorder_level'])
        total_prods = len(products)

        # Gross profit last 30 days
        month_sales_rows = db.query("SELECT items_json FROM sales WHERE date >= ?", (month_start,))
        revenue = cost = 0
        for row in month_sales_rows:
            for item in json.loads(row['items_json']):
                revenue += item['qty'] * item['unitPrice']
                cost += item['qty'] * item.get('costPrice', 0)
        profit = revenue - cost

        # Operating expenses last 30 days -> net profit
        month_expenses = db.query("SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE date >= ?", (month_start,))[0]['v']
        net_profit = profit - month_expenses

        payload = {
            'todaySales': today_sales[0]['v'],
            'weekSales': week_sales[0]['v'],
            # So the tile can show which week it is actually reporting on.
            'weekStartDate': week_start,
            'weekStartLabel': self._week_start_date(now).strftime('%a %d %b'),
            'monthSales': month_sales[0]['v'],
            'monthStartDate': month_start,
            'monthStartLabel': self._month_start_date(now).strftime('%b %Y'),
            'transactions': total_tx,
            'inventoryValue': inv_value,
            'lowStock': low_stock,
            'profit': profit,
            'expenses': month_expenses,
            'netProfit': net_profit,
            'totalProducts': total_prods,
        }
        # Roles without 'profits' (e.g. manager) never receive profit figures.
        if not self._has_perm('profits'):
            payload['profit'] = None
            payload['expenses'] = None
            payload['netProfit'] = None
        return self._ok(payload)

    # ── Reporting data ──────────────────────────────────────
    def get_sales_for_period(self, date_from, date_to):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT * FROM sales WHERE date >= ? AND date <= ? ORDER BY date",
                        (date_from, date_to + "T23:59:59"))
        # Strip cost data for roles that can't see profit, so margins can't be
        # reconstructed client-side from the raw sale items.
        show_cost = self._has_perm('profits')
        for r in rows:
            items = json.loads(r['items_json'])
            if not show_cost:
                for it in items:
                    it.pop('costPrice', None)
                r.pop('items_json', None)
            r['items'] = items
        return self._ok(rows)

    def get_all_products(self):
        err = self._require_auth()
        if err: return err
        return self._ok(db.query("SELECT * FROM products ORDER BY name"))

    # ── Expenses (operating costs: rent, utilities, salaries…) ──
    def get_expenses(self, date_from="", date_to=""):
        err = self._require_perm('expenses')
        if err: return err
        sql = "SELECT * FROM expenses WHERE 1=1"
        params = []
        if date_from:
            sql += " AND date >= ?"; params.append(date_from)
        if date_to:
            sql += " AND date <= ?"; params.append(date_to + "T23:59:59")
        sql += " ORDER BY date DESC, id DESC"
        return self._ok(db.query(sql, params))

    def save_expense(self, id, date, category, description, amount, payment):
        err = self._require_perm('expenses')
        if err: return err
        try:
            amt = _to_number(amount)
            if amt <= 0:
                return self._err("Amount must be greater than zero")
            date = (str(date).strip() or datetime.now().strftime('%Y-%m-%d'))
            category = (str(category).strip() or 'Other')
            description = str(description or '').strip()
            payment = str(payment or '').strip()
            with db.transaction() as conn:
                if id:
                    conn.execute("UPDATE expenses SET date=?,category=?,description=?,amount=?,payment=? WHERE id=?",
                                 (date, category, description, amt, payment, id))
                else:
                    by = self._current_user['name'] if self._current_user else ''
                    conn.execute("INSERT INTO expenses(date,category,description,amount,payment,created_by) VALUES(?,?,?,?,?,?)",
                                 (date, category, description, amt, payment, by))
            return self._ok(msg="Expense saved")
        except Exception as e:
            return self._err(f"Could not save expense: {e}")

    def delete_expense(self, id):
        err = self._require_perm('expenses')
        if err: return err
        try:
            db.execute("DELETE FROM expenses WHERE id=?", (id,))
            return self._ok(msg="Expense deleted")
        except Exception as e:
            return self._err(f"Could not delete expense: {e}")

    def get_profit_loss(self, date_from, date_to):
        """Profit & Loss for a period: Revenue − Cost of Goods Sold = Gross Profit,
        then − Operating Expenses (by category) = Net Profit."""
        err = self._require_perm('profits')
        if err: return err
        sales = db.query("SELECT items_json FROM sales WHERE date >= ? AND date <= ?",
                         (date_from, date_to + "T23:59:59"))
        revenue = cogs = 0.0
        for s in sales:
            for it in json.loads(s['items_json']):
                revenue += it['qty'] * it['unitPrice']
                cogs += it['qty'] * it.get('costPrice', 0)
        gross = revenue - cogs
        cats = db.query("SELECT COALESCE(NULLIF(category,''),'Other') AS category, COALESCE(SUM(amount),0) AS amount "
                        "FROM expenses WHERE date >= ? AND date <= ? GROUP BY category ORDER BY amount DESC",
                        (date_from, date_to + "T23:59:59"))
        by_category = [{'category': c['category'], 'amount': c['amount']} for c in cats]
        expenses_total = sum(c['amount'] for c in by_category)
        return self._ok({
            'revenue': revenue, 'cogs': cogs, 'gross': gross,
            'byCategory': by_category, 'expensesTotal': expenses_total,
            'net': gross - expenses_total,
        })

    # ── File saving (CSV templates / exports) ───────────────
    def save_text_file(self, filename, content):
        """Save text to a user-chosen location via the OS Save dialog.

        Needed because a browser-style blob download (<a download>) does not
        work inside the desktop webview — this drives pywebview's native
        Save-As dialog and writes the file from Python instead."""
        err = self._require_auth()
        if err: return err
        try:
            import webview
            win = None
            if hasattr(webview, 'active_window') and webview.active_window():
                win = webview.active_window()
            elif getattr(webview, 'windows', None):
                win = webview.windows[0]
            if win is None:
                return self._err("No application window available")
            result = win.create_file_dialog(webview.SAVE_DIALOG, save_filename=filename)
            if not result:
                return self._ok({'cancelled': True}, "Save cancelled")
            path = result[0] if isinstance(result, (list, tuple)) else result
            with open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(content)
            return self._ok({'path': path}, "File saved")
        except Exception as e:
            return self._err(f"Could not save file: {e}")
