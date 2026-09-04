#!/usr/bin/env python3
"""
Load dummy/demo data into the Dwatrex database for testing.

    python3 seed_demo_data.py            # top up whatever database the app uses
    python3 seed_demo_data.py --reset    # wipe transactions first, then seed

It targets the SAME database file the app opens (honouring DWATREX_DB), and
fills in the areas the built-in demo seed does not cover — operating expenses
and credit sales with partial repayments — so every screen has something in it.

This is a development/testing tool. It never touches your product catalogue
except to create one if the database is completely empty.
"""
import json
import os
import random
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import database as db  # noqa: E402

random.seed(20260904)  # stable output between runs

CUSTOMERS = [
    ("Ama Mensah",      "024 111 2233"),
    ("Kofi Boateng",    "020 444 5566"),
    ("Yaa Asantewaa",   "055 777 8899"),
    ("Kwame Owusu",     "027 222 3344"),
    ("Akosua Darko",    "050 999 0011"),
]

# Amounts are deliberately scaled to the small demo catalogue so the seeded
# store shows a healthy (positive) net profit rather than a confusing loss.
EXPENSES = [
    ("Rent",          "Shop rent",                  300.00, "Bank Transfer", 30),
    ("Utilities",     "ECG electricity",             85.50, "Mobile Money",  26),
    ("Salaries",      "Staff wages",                260.00, "Cash",          25),
    ("Transport",     "Delivery van fuel",           55.00, "Cash",          21),
    ("Supplies",      "Packaging bags & tape",       30.00, "Cash",          18),
    ("Utilities",     "Water bill",                  22.00, "Mobile Money",  14),
    ("Maintenance",   "Shelf repairs",               40.00, "Cash",          11),
    ("Marketing",     "Radio advert",                60.00, "Bank Transfer",  8),
    ("Bank Charges",  "Monthly account fees",        12.00, "Bank Transfer",  5),
    ("Transport",     "Restocking trip to Accra",    45.00, "Cash",           2),
]


def iso(days_ago, hour=11):
    d = datetime.now() - timedelta(days=days_ago)
    return d.replace(hour=hour, minute=random.randint(0, 59), second=0, microsecond=0).isoformat()


def main():
    reset = "--reset" in sys.argv
    db.init_db()                     # ensures schema + migrations are current
    conn = db.get_conn()
    c = conn.cursor()
    print(f"Database: {db.DB_PATH}\n")

    if reset:
        for t in ("credit_payments", "expenses", "returns", "purchases", "sales", "stock_movements"):
            try:
                c.execute(f"DELETE FROM {t}")
            except Exception:
                pass
        conn.commit()
        print("Cleared existing transactions (products and users kept).\n")

    # ── 1. Base catalogue + sales history ────────────────────────────────
    if c.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0:
        print("No products found — seeding the full demo store...")
        db._seed_demo(conn)
        c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('setup_complete','1')")
        conn.commit()
        print("  demo catalogue, sales history and user accounts created")
        print("  log in as  admin / admin123\n")

    products = c.execute(
        "SELECT id,name,cost_price,selling_price,stock FROM products WHERE stock > 5 LIMIT 40"
    ).fetchall()
    if not products:
        print("No stocked products available — add stock, then re-run.")
        return

    # ── 2. Operating expenses (for Profit & Loss / net profit) ───────────
    added = 0
    for category, desc, amount, method, days in EXPENSES:
        c.execute(
            "INSERT INTO expenses(date,category,description,amount,payment,created_by) VALUES(?,?,?,?,?,?)",
            (iso(days), category, desc, amount, method, "Demo Seed"))
        added += 1
    conn.commit()
    print(f"Expenses:      {added} added "
          f"(total GH₵{sum(e[2] for e in EXPENSES):,.2f})")

    # ── 3. Credit sales, in a mix of states ──────────────────────────────
    # (paid_fraction, days_ago, n_payments) -> outstanding / part-paid / settled
    plans = [
        (0.0,  18, 0),   # nothing paid yet
        (0.0,  12, 0),
        (0.35,  9, 1),   # part-paid, one repayment
        (0.60,  6, 2),   # part-paid, two repayments
        (1.0,   4, 1),   # fully settled
        (0.25,  2, 1),
    ]
    made = settled = 0
    total_owed = 0.0

    for idx, (frac, days_ago, n_pay) in enumerate(plans):
        cust, phone = CUSTOMERS[idx % len(CUSTOMERS)]
        picks = random.sample(products, k=min(3, len(products)))
        items = []
        for p in picks:
            qty = random.randint(1, 3)
            if p["stock"] < qty:
                continue
            items.append({
                "productId": p["id"], "name": p["name"], "qty": qty,
                "unitPrice": round(p["selling_price"], 2),
                "costPrice": round(p["cost_price"], 2),
            })
        if not items:
            continue

        subtotal = round(sum(i["qty"] * i["unitPrice"] for i in items), 2)
        tax = 0.0
        total = round(subtotal, 2)
        paid = round(total * frac, 2)
        balance = round(total - paid, 2)
        status = "Completed" if balance <= 0.001 else "Credit"
        when = iso(days_ago)

        cur = c.execute(
            """INSERT INTO sales(date,items_json,subtotal,discount,tax,discount_amt,tax_amt,total,payment,status,
                                 customer_name,customer_phone,amount_paid,balance)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (when, json.dumps(items), subtotal, 0, tax, 0, 0, total, "Credit", status,
             cust, phone, paid, balance))
        sale_id = cur.lastrowid

        # Deduct stock + movements, exactly as a real sale does.
        for i in items:
            c.execute("UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?", (i["qty"], i["productId"]))
            c.execute(
                "INSERT INTO stock_movements(date,product_id,product_name,type,qty,reference) VALUES(?,?,?,?,?,?)",
                (when, i["productId"], i["name"], "OUT", i["qty"], f"Sale #{sale_id}"))

        # Split whatever was paid across n_pay repayment records.
        if paid > 0 and n_pay > 0:
            each = round(paid / n_pay, 2)
            running = 0.0
            for k in range(n_pay):
                amt = round(paid - running, 2) if k == n_pay - 1 else each
                running = round(running + amt, 2)
                c.execute(
                    "INSERT INTO credit_payments(sale_id,date,amount,method,note,taken_by) VALUES(?,?,?,?,?,?)",
                    (sale_id, iso(max(0, days_ago - (k + 1) * 2)), amt,
                     random.choice(["Cash", "Mobile Money", "Bank Transfer"]),
                     "Part payment" if k < n_pay - 1 else "Payment", "Demo Seed"))

        made += 1
        total_owed += balance
        if balance <= 0.001:
            settled += 1

    conn.commit()
    print(f"Credit sales:  {made} added "
          f"({made - settled} outstanding, {settled} settled, GH₵{total_owed:,.2f} owed)")

    # ── 4. Refresh product statuses so stock badges are right ────────────
    for row in c.execute("SELECT id,stock,reorder_level FROM products").fetchall():
        st = ("Out of Stock" if row["stock"] <= 0
              else "Low Stock" if row["stock"] <= row["reorder_level"] else "In Stock")
        c.execute("UPDATE products SET status=? WHERE id=?", (st, row["id"]))
    conn.commit()

    n_users = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    print(f"\nDone. {c.execute('SELECT COUNT(*) FROM products').fetchone()[0]} products, "
          f"{c.execute('SELECT COUNT(*) FROM sales').fetchone()[0]} sales, "
          f"{c.execute('SELECT COUNT(*) FROM expenses').fetchone()[0]} expenses, "
          f"{n_users} users.")
    print("Start the app with:  python3 main.py")
    conn.close()


if __name__ == "__main__":
    main()
