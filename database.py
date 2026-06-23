"""
Dwatrex Database Layer — SQLite with full schema and seed data.
"""
import sqlite3
import os
import sys
import json
import hashlib
import secrets
from contextlib import contextmanager
from datetime import datetime, timedelta
import random

# PBKDF2 parameters
_PBKDF2_ITERATIONS = 200_000
_LEGACY_SALT = 'dwatrex_salt_2026'  # only used to verify pre-existing accounts


def hash_password(password, salt=None):
    """Hash a password with PBKDF2-HMAC-SHA256 and a per-user random salt.

    Returns a self-describing string: 'pbkdf2_sha256$<iters>$<salt>$<hexhash>'.
    """
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_password(password, stored):
    """Constant-time verification. Supports new PBKDF2 hashes and legacy SHA-256."""
    if not stored:
        return False
    if stored.startswith('pbkdf2_sha256$'):
        try:
            _, iters, salt, hexhash = stored.split('$')
            dk = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), int(iters))
            return secrets.compare_digest(dk.hex(), hexhash)
        except Exception:
            return False
    # Legacy format: bare SHA-256(static_salt + password) hex digest
    legacy = hashlib.sha256(f"{_LEGACY_SALT}{password}".encode()).hexdigest()
    return secrets.compare_digest(legacy, stored)


def _get_db_path():
    """Store the database in a guaranteed user-writable per-user data directory.

    Avoids writing next to the executable, which may live in a read-only
    location (e.g. Program Files) for all-users installs.
    """
    override = os.environ.get('DWATREX_DB')
    if override:
        os.makedirs(os.path.dirname(os.path.abspath(override)), exist_ok=True)
        return override
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    elif sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Application Support')
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')
    data_dir = os.path.join(base, 'Dwatrex')
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "dwatrex.db")

DB_PATH = _get_db_path()


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_conn()
    c = conn.cursor()

    # ── Schema ──────────────────────────────────────────────
    c.executescript("""
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS categories (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS suppliers (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name    TEXT NOT NULL,
        contact TEXT,
        email   TEXT,
        phone   TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        sku           TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        category      TEXT,
        supplier      TEXT,
        cost_price    REAL NOT NULL DEFAULT 0,
        selling_price REAL NOT NULL DEFAULT 0,
        stock         INTEGER NOT NULL DEFAULT 0,
        reorder_level INTEGER NOT NULL DEFAULT 10,
        expiry        TEXT,
        status        TEXT NOT NULL DEFAULT 'In Stock'
    );
    CREATE TABLE IF NOT EXISTS sales (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT NOT NULL,
        items_json  TEXT NOT NULL,
        subtotal    REAL,
        discount    REAL DEFAULT 0,
        tax         REAL DEFAULT 7.5,
        discount_amt REAL DEFAULT 0,
        tax_amt     REAL DEFAULT 0,
        total       REAL,
        payment     TEXT,
        status      TEXT DEFAULT 'Completed'
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        date         TEXT NOT NULL,
        product_id   INTEGER,
        product_name TEXT,
        type         TEXT NOT NULL,
        qty          INTEGER NOT NULL,
        reference    TEXT
    );
    CREATE TABLE IF NOT EXISTS purchases (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        date       TEXT NOT NULL,
        supplier   TEXT,
        items_json TEXT NOT NULL,
        total_cost REAL,
        status     TEXT DEFAULT 'Received'
    );
    CREATE TABLE IF NOT EXISTS returns (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        date         TEXT NOT NULL,
        sale_id      INTEGER,
        product_id   INTEGER,
        product_name TEXT,
        qty          INTEGER,
        reason       TEXT,
        resellable   INTEGER DEFAULT 1,
        refund       REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT,
        username TEXT UNIQUE,
        password TEXT,
        role     TEXT,
        status   TEXT DEFAULT 'Active'
    );
    CREATE TABLE IF NOT EXISTS expenses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT NOT NULL,
        category    TEXT,
        description TEXT,
        amount      REAL NOT NULL DEFAULT 0,
        payment     TEXT,
        created_by  TEXT
    );
    """)
    conn.commit()

    # Always ensure default settings exist (currency, tax, thresholds, etc.).
    _seed_settings(conn)

    # Demo data (sample products, sales, AND demo user accounts) is OFF by
    # default so shipped builds start clean. Enable it for trials/development
    # by setting the environment variable DWATREX_DEMO=1 before first launch.
    if os.environ.get('DWATREX_DEMO') == '1':
        if c.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
            _seed_demo(conn)

    conn.close()


def _seed_settings(conn):
    """Insert default settings if they don't already exist (idempotent)."""
    c = conn.cursor()
    defaults = {
        'storeName': 'My Store', 'storeAddress': '', 'storePhone': '', 'storeEmail': '',
        'currency': 'GH₵', 'taxRate': '7.5',
        'lowStockThreshold': '10', 'fastMovingThreshold': '50', 'slowMovingThreshold': '5',
    }
    for k, v in defaults.items():
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
    conn.commit()


def is_setup_complete():
    """Check if first-run setup has been completed."""
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key='setup_complete'").fetchone()
    conn.close()
    return row is not None and row['value'] == '1'


def user_count():
    """Number of user accounts in the database."""
    conn = get_conn()
    n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    conn.close()
    return n


def complete_first_run_setup(store_name, admin_name, admin_username, admin_password):
    """Complete first-run setup: create admin account and mark setup done."""
    conn = get_conn()
    c = conn.cursor()
    # Create the admin user
    c.execute("INSERT INTO users(name, username, password, role, status) VALUES(?,?,?,?,?)",
              (admin_name, admin_username, hash_password(admin_password), 'admin', 'Active'))
    # Save store name
    c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('storeName', ?)", (store_name,))
    # Mark setup as complete
    c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('setup_complete', '1')")
    conn.commit()
    conn.close()


def authenticate_user(username, password):
    """Verify username/password. Returns user dict or None.

    Fetches by username then verifies in Python so per-user salts work, and
    transparently upgrades legacy SHA-256 hashes to PBKDF2 on successful login.
    """
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE username=? AND status='Active'",
                       (username,)).fetchone()
    if not row:
        conn.close()
        return None
    user = dict(row)
    if not verify_password(password, user['password']):
        conn.close()
        return None
    # Upgrade legacy hashes in place
    if not str(user['password']).startswith('pbkdf2_sha256$'):
        try:
            conn.execute("UPDATE users SET password=? WHERE id=?",
                         (hash_password(password), user['id']))
            conn.commit()
        except Exception:
            pass
    conn.close()
    return user


def _seed_demo(conn):
    """Populate sample data for trials/development. NOT used in shipped builds
    unless DWATREX_DEMO=1 is set. Includes demo user accounts."""
    c = conn.cursor()

    # Categories
    cats = ['Beverages', 'Snacks & Confectionery', 'Dairy & Eggs', 'Bakery',
            'Personal Care', 'Household', 'Canned Goods', 'Grains & Cereals',
            'Fresh Produce', 'Frozen Foods']
    for cat in cats:
        c.execute("INSERT INTO categories(name) VALUES(?)", (cat,))

    # Suppliers
    suppliers = [
        ('FreshSource Ltd', 'James Okoro', 'james@freshsource.com', '+234-801-234-5678'),
        ('Global Imports Co', 'Sarah Chen', 'sarah@globalimports.com', '+1-555-0123'),
        ('Farm Direct', 'Amina Bello', 'amina@farmdirect.com', '+234-802-345-6789'),
        ('Metro Distributors', 'David Smith', 'david@metrodist.com', '+1-555-0456'),
        ('QuickSupply Inc', 'Liu Wei', 'liu@quicksupply.com', '+86-138-0000-1234'),
    ]
    for s in suppliers:
        c.execute("INSERT INTO suppliers(name,contact,email,phone) VALUES(?,?,?,?)", s)

    # Products
    products = [
        ('BEV-001','Coca-Cola 500ml','Beverages','FreshSource Ltd',0.80,1.50,150,30,'2026-08-15'),
        ('BEV-002','Pepsi 500ml','Beverages','FreshSource Ltd',0.75,1.50,120,30,'2026-09-20'),
        ('BEV-003','Fanta Orange 500ml','Beverages','FreshSource Ltd',0.78,1.50,90,25,'2026-07-10'),
        ('BEV-004','Sprite 500ml','Beverages','FreshSource Ltd',0.78,1.50,85,25,'2026-08-01'),
        ('BEV-005','Bottled Water 1L','Beverages','Global Imports Co',0.30,0.75,300,50,'2027-01-01'),
        ('BEV-006','Orange Juice 1L','Beverages','Farm Direct',1.50,3.00,8,15,'2026-04-15'),
        ('SNK-001',"Lay's Classic Chips",'Snacks & Confectionery','Global Imports Co',1.20,2.50,200,40,'2026-06-30'),
        ('SNK-002','Oreo Cookies','Snacks & Confectionery','Global Imports Co',1.00,2.25,175,35,'2026-10-01'),
        ('SNK-003','Snickers Bar','Snacks & Confectionery','Metro Distributors',0.60,1.25,250,50,'2026-12-01'),
        ('SNK-004','Pringles Original','Snacks & Confectionery','Global Imports Co',1.50,3.00,5,20,'2026-05-15'),
        ('DRY-001','Whole Milk 1L','Dairy & Eggs','Farm Direct',1.00,2.00,60,20,'2026-04-01'),
        ('DRY-002','Eggs (Dozen)','Dairy & Eggs','Farm Direct',2.00,3.50,45,15,'2026-04-10'),
        ('DRY-003','Cheddar Cheese 200g','Dairy & Eggs','Farm Direct',2.50,4.50,35,10,'2026-05-20'),
        ('DRY-004','Greek Yogurt 500g','Dairy & Eggs','Farm Direct',1.80,3.50,0,15,'2026-04-05'),
        ('BAK-001','White Bread Loaf','Bakery','Farm Direct',1.00,2.00,40,15,'2026-03-25'),
        ('BAK-002','Croissants (4pk)','Bakery','Metro Distributors',2.00,4.00,25,10,'2026-03-22'),
        ('BAK-003','Chocolate Muffins (6pk)','Bakery','Metro Distributors',2.50,5.00,3,10,'2026-03-21'),
        ('PER-001','Colgate Toothpaste','Personal Care','QuickSupply Inc',1.50,3.00,80,20,'2027-06-01'),
        ('PER-002','Dove Soap Bar','Personal Care','QuickSupply Inc',1.00,2.25,65,20,'2027-12-01'),
        ('PER-003','Head & Shoulders 400ml','Personal Care','QuickSupply Inc',3.50,6.50,40,10,'2027-09-01'),
        ('HOU-001','Dishwashing Liquid 1L','Household','QuickSupply Inc',2.00,4.00,55,15,None),
        ('HOU-002','Trash Bags (30pk)','Household','QuickSupply Inc',2.50,5.00,70,20,None),
        ('HOU-003','Bleach 2L','Household','Metro Distributors',1.80,3.50,0,10,None),
        ('CAN-001','Baked Beans 400g','Canned Goods','Global Imports Co',0.80,1.75,100,25,'2027-05-01'),
        ('CAN-002','Tuna Chunks 185g','Canned Goods','Global Imports Co',1.20,2.50,85,20,'2027-08-01'),
        ('CAN-003','Tomato Paste 400g','Canned Goods','FreshSource Ltd',0.60,1.25,120,30,'2027-03-01'),
        ('GRN-001','Basmati Rice 5kg','Grains & Cereals','Farm Direct',4.00,7.50,50,15,'2027-01-01'),
        ('GRN-002','Spaghetti 500g','Grains & Cereals','Global Imports Co',0.80,1.75,110,25,'2027-06-01'),
        ('GRN-003','Corn Flakes 500g','Grains & Cereals','Metro Distributors',2.00,4.00,7,15,'2026-11-01'),
        ('FRZ-001','Frozen Chicken Wings 1kg','Frozen Foods','FreshSource Ltd',4.00,7.00,30,10,'2026-06-01'),
        ('FRZ-002','Frozen Pizza','Frozen Foods','Metro Distributors',3.00,5.50,20,8,'2026-07-01'),
        ('FRZ-003','Ice Cream 1L','Frozen Foods','FreshSource Ltd',2.50,5.00,2,10,'2026-05-01'),
        ('PRD-001','Bananas (bunch)','Fresh Produce','Farm Direct',0.80,1.50,60,20,'2026-03-25'),
        ('PRD-002','Tomatoes 1kg','Fresh Produce','Farm Direct',1.20,2.50,40,15,'2026-03-24'),
        ('PRD-003','Onions 2kg','Fresh Produce','Farm Direct',1.00,2.00,55,20,'2026-04-10'),
    ]
    for p in products:
        stock = p[6]
        reorder = p[7]
        status = 'Out of Stock' if stock == 0 else ('Low Stock' if stock <= reorder else 'In Stock')
        c.execute("""INSERT INTO products(sku,name,category,supplier,cost_price,selling_price,stock,reorder_level,expiry,status)
                     VALUES(?,?,?,?,?,?,?,?,?,?)""", (*p, status))

    # Users — these are demo users, NOT created during first-run setup.
    # The first-run wizard creates the real admin; these are only seeded for demo purposes.
    users = [
        ('Admin User', 'admin', hash_password('admin123'), 'admin', 'Active'),
        ('John Manager', 'john_m', hash_password('pass123'), 'manager', 'Active'),
        ('Jane Cashier', 'jane_c', hash_password('pass123'), 'cashier', 'Active'),
        ('Mike Inventory', 'mike_i', hash_password('pass123'), 'inventory', 'Active'),
        ('Sara Cashier', 'sara_c', hash_password('pass123'), 'cashier', 'Inactive'),
    ]
    for u in users:
        c.execute("INSERT INTO users(name,username,password,role,status) VALUES(?,?,?,?,?)", u)

    # (Settings defaults are seeded separately in _seed_settings.)

    # ── Generate 60 days of sample sales ──
    all_products = c.execute("SELECT * FROM products").fetchall()
    payment_methods = ['Cash', 'Mobile Money', 'Card', 'Bank Transfer']
    now = datetime.now()

    for day_offset in range(59, -1, -1):
        sale_date = now - timedelta(days=day_offset)
        num_sales = random.randint(2, 7)
        for _ in range(num_sales):
            num_items = random.randint(1, 4)
            chosen = random.sample(list(all_products), min(num_items, len(all_products)))
            items = []
            for prod in chosen:
                qty = random.randint(1, 5)
                items.append({
                    'productId': prod['id'], 'name': prod['name'], 'qty': qty,
                    'unitPrice': prod['selling_price'], 'costPrice': prod['cost_price']
                })
            subtotal = sum(i['qty'] * i['unitPrice'] for i in items)
            discount = random.choice([0, 0, 0, 0, random.randint(1, 10)])
            tax = 7.5
            discount_amt = subtotal * discount / 100
            tax_amt = (subtotal - discount_amt) * tax / 100
            total = subtotal - discount_amt + tax_amt
            hour = random.randint(8, 19)
            minute = random.randint(0, 59)
            sale_dt = sale_date.replace(hour=hour, minute=minute, second=0)
            c.execute("""INSERT INTO sales(date,items_json,subtotal,discount,tax,discount_amt,tax_amt,total,payment,status)
                         VALUES(?,?,?,?,?,?,?,?,?,?)""",
                      (sale_dt.isoformat(), json.dumps(items), subtotal, discount, tax,
                       discount_amt, tax_amt, total, random.choice(payment_methods), 'Completed'))
            sale_id = c.lastrowid
            for i in items:
                c.execute("""INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference)
                             VALUES(?,?,?,?,?,?)""",
                          (sale_dt.isoformat(), i['productId'], i['name'], 'OUT', i['qty'], f'Sale #{sale_id}'))

    # Sample purchases
    for i in range(12):
        sup = random.choice(suppliers)
        p_items = []
        for _ in range(random.randint(1, 3)):
            prod = random.choice(list(all_products))
            qty = random.randint(10, 50)
            p_items.append({'productId': prod['id'], 'name': prod['name'], 'qty': qty, 'unitCost': prod['cost_price']})
        total_cost = sum(x['qty'] * x['unitCost'] for x in p_items)
        po_date = (now - timedelta(days=random.randint(0, 45))).isoformat()
        c.execute("INSERT INTO purchases(date,supplier,items_json,total_cost,status) VALUES(?,?,?,?,?)",
                  (po_date, sup[0], json.dumps(p_items), total_cost, 'Received'))
        po_id = c.lastrowid
        for pi in p_items:
            c.execute("INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) VALUES(?,?,?,?,?,?)",
                      (po_date, pi['productId'], pi['name'], 'IN', pi['qty'], f'PO-{po_id}'))

    # Sample returns
    recent_sales = c.execute("SELECT id, items_json, date FROM sales ORDER BY id DESC LIMIT 50").fetchall()
    reasons = ['Defective', 'Expired', 'Wrong item', 'Customer changed mind', 'Damaged packaging']
    for _ in range(8):
        sale = random.choice(recent_sales)
        items = json.loads(sale['items_json'])
        item = random.choice(items)
        resellable = 1 if random.random() > 0.3 else 0
        ret_date = (now - timedelta(days=random.randint(0, 20))).isoformat()
        c.execute("INSERT INTO returns(date,sale_id,product_id,product_name,qty,reason,resellable,refund) VALUES(?,?,?,?,?,?,?,?)",
                  (ret_date, sale['id'], item['productId'], item['name'], 1, random.choice(reasons), resellable, item['unitPrice']))

    conn.commit()


# ══════════════════════════════════════════════════════════════
# Query helpers — used by the API layer
# ══════════════════════════════════════════════════════════════

def _rows_to_list(rows):
    return [dict(r) for r in rows]


def query(sql, params=()):
    conn = get_conn()
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return _rows_to_list(rows)


def execute(sql, params=()):
    conn = get_conn()
    cur = conn.execute(sql, params)
    conn.commit()
    last_id = cur.lastrowid
    conn.close()
    return last_id


def execute_many(statements):
    """Run multiple (sql, params) pairs in one transaction."""
    conn = get_conn()
    results = []
    try:
        for sql, params in statements:
            cur = conn.execute(sql, params)
            results.append(cur.lastrowid)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return results


@contextmanager
def transaction():
    """Context manager yielding a connection that commits on success and
    rolls back on any exception. Use for multi-statement atomic operations."""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
