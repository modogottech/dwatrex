"""
Dwatrex API layer — exposed to the frontend via pywebview's JS bridge.
Every public method becomes callable from JavaScript as window.pywebview.api.<method>(...)

Authorization: roles are enforced HERE, on the backend. The frontend hides
navigation per role, but that is cosmetic only — every sensitive method
re-checks the authenticated user's role on the server side.
"""
import json
import sqlite3
from datetime import datetime, timedelta
import database as db


# Page/capability permissions per role (mirrors the frontend nav, authoritative here).
ROLE_PERMS = {
    'admin':     {'dashboard', 'products', 'categories', 'suppliers', 'sales',
                  'purchases', 'inventory', 'returns', 'reports', 'insights',
                  'users', 'settings'},
    'manager':   {'dashboard', 'products', 'categories', 'suppliers', 'sales',
                  'purchases', 'inventory', 'returns', 'reports', 'insights'},
    'cashier':   {'dashboard', 'sales', 'returns'},
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
    def login(self, username, password):
        """Authenticate user and return their profile (without password)."""
        user = db.authenticate_user(username, password)
        if user:
            safe_user = {k: v for k, v in user.items() if k != 'password'}
            self._current_user = {'id': user['id'], 'name': user['name'], 'role': user['role']}
            return self._ok(safe_user, "Login successful")
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
        return self._ok({r['key']: r['value'] for r in rows})

    def save_settings(self, settings_json):
        err = self._require_perm('settings')
        if err: return err
        try:
            s = json.loads(settings_json)
            with db.transaction() as conn:
                for k, v in s.items():
                    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, str(v)))
            return self._ok(msg="Settings saved")
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
    def get_products(self, search="", category="", status=""):
        # Readable by any authenticated user (POS needs this for cashiers).
        err = self._require_auth()
        if err: return err
        sql = "SELECT * FROM products WHERE 1=1"
        params = []
        if search:
            sql += " AND (name LIKE ? OR sku LIKE ?)"
            params += [f"%{search}%", f"%{search}%"]
        if category:
            sql += " AND category=?"
            params.append(category)
        if status:
            sql += " AND status=?"
            params.append(status)
        sql += " ORDER BY name"
        return self._ok(db.query(sql, params))

    def save_product(self, id, sku, name, category, supplier, cost_price, selling_price,
                     stock, reorder_level, expiry):
        err = self._require_perm('products')
        if err: return err
        sku = (sku or '').strip()
        name = (name or '').strip()
        if not sku or not name:
            return self._err("SKU and product name are required")
        try:
            stock = int(stock)
            reorder_level = int(reorder_level)
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
                                  selling_price=?,stock=?,reorder_level=?,expiry=?,status=? WHERE id=?""",
                                 (sku, name, category, supplier, cost_price, selling_price,
                                  stock, reorder_level, expiry or None, st, id))
                else:
                    conn.execute("""INSERT INTO products(sku,name,category,supplier,cost_price,selling_price,
                                  stock,reorder_level,expiry,status) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                                 (sku, name, category, supplier, cost_price, selling_price,
                                  stock, reorder_level, expiry or None, st))
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
                        cost_price = float(p.get('cost_price', 0))
                        selling_price = float(p.get('selling_price', 0))
                        stock = int(p.get('stock', 0))
                        reorder_level = int(p.get('reorder_level', 10))
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

    def complete_sale(self, items_json, discount, tax, payment):
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
            now = datetime.now().isoformat()
            with db.transaction() as conn:
                # Validate stock for every line BEFORE mutating anything.
                for i in items:
                    qty = int(i['qty'])
                    if qty <= 0:
                        raise ValueError("Quantities must be positive")
                    row = conn.execute("SELECT stock, name FROM products WHERE id=?", (i['productId'],)).fetchone()
                    if not row:
                        raise ValueError(f"Product '{i.get('name', '?')}' no longer exists")
                    if row['stock'] < qty:
                        raise ValueError(f"Insufficient stock for {row['name']} (have {row['stock']}, need {qty})")

                subtotal = sum(i['qty'] * i['unitPrice'] for i in items)
                discount_amt = subtotal * discount / 100
                tax_amt = (subtotal - discount_amt) * tax / 100
                total = subtotal - discount_amt + tax_amt

                cur = conn.execute(
                    """INSERT INTO sales(date,items_json,subtotal,discount,tax,discount_amt,tax_amt,total,payment,status)
                       VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (now, json.dumps(items), subtotal, discount, tax, discount_amt, tax_amt, total, payment, 'Completed'))
                sale_id = cur.lastrowid

                for i in items:
                    conn.execute("UPDATE products SET stock = stock - ? WHERE id=?", (i['qty'], i['productId']))
                    conn.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) VALUES(?,?,?,?,?,?)",
                                 (now, i['productId'], i['name'], 'OUT', i['qty'], f'Sale #{sale_id}'))
                    self._update_product_status(i['productId'], conn)

                sale = dict(conn.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone())
            sale['items'] = items
            return self._ok(sale, "Sale completed")
        except ValueError as e:
            return self._err(str(e))
        except Exception as e:
            return self._err(f"Sale failed: {e}")

    # ── Purchases ───────────────────────────────────────────
    def get_purchases(self):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT * FROM purchases ORDER BY date DESC")
        for r in rows:
            r['items'] = json.loads(r['items_json'])
        return self._ok(rows)

    def save_purchase(self, supplier, items_json):
        err = self._require_perm('purchases')
        if err: return err
        try:
            items = json.loads(items_json)
            if not items:
                return self._err("Add at least one item")
            now = datetime.now().isoformat()
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
                    conn.execute("UPDATE products SET stock = stock + ? WHERE id=?", (i['qty'], i['productId']))
                    conn.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) VALUES(?,?,?,?,?,?)",
                                 (now, i['productId'], i['name'], 'IN', i['qty'], f'PO-{po_id}'))
                    self._update_product_status(i['productId'], conn)
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
        week_ago = (now - timedelta(days=7)).strftime('%Y-%m-%d')
        month_ago = (now - timedelta(days=30)).strftime('%Y-%m-%d')

        today_sales = db.query("SELECT COALESCE(SUM(total),0) as v FROM sales WHERE date >= ?", (today,))
        week_sales = db.query("SELECT COALESCE(SUM(total),0) as v FROM sales WHERE date >= ?", (week_ago,))
        month_sales = db.query("SELECT COALESCE(SUM(total),0) as v FROM sales WHERE date >= ?", (month_ago,))
        total_tx = db.query("SELECT COUNT(*) as v FROM sales")[0]['v']
        products = db.query("SELECT * FROM products")
        inv_value = sum(p['stock'] * p['cost_price'] for p in products)
        low_stock = sum(1 for p in products if p['stock'] <= p['reorder_level'])
        total_prods = len(products)

        # Gross profit last 30 days
        month_sales_rows = db.query("SELECT items_json FROM sales WHERE date >= ?", (month_ago,))
        revenue = cost = 0
        for row in month_sales_rows:
            for item in json.loads(row['items_json']):
                revenue += item['qty'] * item['unitPrice']
                cost += item['qty'] * item.get('costPrice', 0)
        profit = revenue - cost

        return self._ok({
            'todaySales': today_sales[0]['v'],
            'weekSales': week_sales[0]['v'],
            'monthSales': month_sales[0]['v'],
            'transactions': total_tx,
            'inventoryValue': inv_value,
            'lowStock': low_stock,
            'profit': profit,
            'totalProducts': total_prods,
        })

    # ── Reporting data ──────────────────────────────────────
    def get_sales_for_period(self, date_from, date_to):
        err = self._require_auth()
        if err: return err
        rows = db.query("SELECT * FROM sales WHERE date >= ? AND date <= ? ORDER BY date",
                        (date_from, date_to + "T23:59:59"))
        for r in rows:
            r['items'] = json.loads(r['items_json'])
        return self._ok(rows)

    def get_all_products(self):
        err = self._require_auth()
        if err: return err
        return self._ok(db.query("SELECT * FROM products ORDER BY name"))

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
