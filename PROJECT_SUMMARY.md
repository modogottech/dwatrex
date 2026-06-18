# DWATREX — Project Summary for Continuation

## What This Is

Dwatrex is a **desktop retail/store management system** built with Python + pywebview + SQLite. It uses the OS native web engine (like Tauri) for a ~51MB footprint. The design system is called **"The Kinetic Monolith"** — industrial dark theme with a light mode toggle.

The app is fully functional with 13 modules: Dashboard, Products, Categories, Suppliers, POS, Purchases, Inventory, Returns, Reports, Insights, Users, Settings.

---

## Architecture

```
Python Backend (pywebview)
  ├── main.py          → Entry point, creates native window titled "DWATREX — Retail Operations Platform"
  ├── api.py           → JS↔Python bridge (class StoreHubAPI), all business logic
  ├── database.py      → SQLite schema, seed data, query helpers, auth (SHA-256 + salt)
  └── dwatrex.db       → Auto-created on first run

Frontend (HTML/CSS/JS served via pywebview)
  ├── frontend/index.html   → Full UI: setup wizard, login, 12 app pages
  ├── frontend/styles.css   → ~600 lines, full Kinetic Monolith design system with light/dark themes
  └── frontend/app.js       → ~900 lines, all frontend logic (async, calls pywebview.api)

Build & Distribution
  ├── build.py              → PyInstaller build script (icon + version info)
  ├── create_icon.py        → Generates dwatrex.ico programmatically (no Pillow needed)
  ├── installer.iss         → Inno Setup script for Windows installer wizard
  ├── build_installer.bat   → One-click: pip install → icon → PyInstaller → Inno Setup
  ├── dwatrex.ico           → Pre-generated multi-size app icon
  ├── requirements.txt      → Just "pywebview"
  ├── LICENSE.txt            → Software license shown during install
  ├── README.md              → Full documentation
  └── preview.html           → Self-contained design preview (opens in any browser, no Python needed)
```

---

## Communication Pattern

Frontend JS calls Python via:
```javascript
async function api(method, ...args) {
  const raw = await window.pywebview.api[method](...args);
  return JSON.parse(raw);
}
```

Python methods return JSON strings via `self._ok(data, msg)` or `self._err(msg)`:
```python
def _ok(self, data=None, msg="success"):
    return json.dumps({"ok": True, "data": data, "msg": msg})
```

---

## Key Features Implemented

### Authentication & First-Run Setup
- **First-run detection**: `settings` table has a `setup_complete` flag
- **Setup wizard**: On first launch, user creates store name + admin account
- **Login**: Real auth via `authenticate_user(username, password)` with SHA-256 hashing
- **Role-based UI**: Admin, Manager, Cashier, Inventory Officer — each role sees only permitted pages
- **User CRUD**: Admins can add/edit/delete users from the Users page
- **Password**: SHA-256 with static salt `dwatrex_salt_2026`, min 4 chars

### Light/Dark Mode
- Toggle button (sun/moon icon) in the topbar, id="themeIcon"
- Sets `data-theme="light"` on `<html>` element
- All CSS uses CSS variables — `[data-theme="light"]` block overrides all colors
- Chart colors adapt via `chartColors()` function
- Preference saved to `localStorage` key `dwatrex-theme`

### CSV Bulk Import
- **Categories**: "Import CSV" button → modal with upload area → preview → bulk insert (skips duplicates)
- **Products**: Same flow, parses columns: sku, name, category, supplier, cost_price, selling_price, stock, reorder_level, expiry
- **Templates**: Both modals have a "Download template" link that generates a sample CSV
- **Auto-create categories**: Product import auto-creates missing categories
- Backend methods: `bulk_import_categories(names_json)`, `bulk_import_products(products_json)`

### POS Price Override
- Each cart item has an editable price input field (class `item-price`)
- When price changes, original price shown with strikethrough (class `item-original-price`)
- Anyone can change price (no role restriction)
- `updateCartPrice(index, value)` function handles it
- Cart items now store both `unitPrice` (current) and `originalPrice` (catalog price)

### Other Features
- **POS**: Product grid, cart with qty/price editing, discount %, tax %, payment method, receipt modal
- **Purchases**: Record purchase orders, auto-update stock + stock movements
- **Inventory Intelligence**: Summary metrics, stock movement log
- **Returns**: Process returns against sales, optionally restock
- **Capital Analytics (Reports)**: 12 report types with Chart.js charts + data tables
- **Intelligence Center (Insights)**: Best/worst sellers, dead stock, restock alerts, profitability, peak days, AI-style recommendations
- **Settings**: Store name, currency, tax rate, thresholds

---

## Database Schema (database.py)

Tables: `settings`, `categories`, `suppliers`, `products`, `sales`, `purchases`, `stock_movements`, `returns`, `users`

Key columns on `users`: id, name, username, password (hashed), role, status
Key columns on `products`: id, sku, name, category, supplier, cost_price, selling_price, stock, reorder_level, expiry, status

Seed data: 6 categories, 3 suppliers, 15 products, 20 sales with items, stock movements, 2 returns. Seed users have hashed passwords (admin/admin123, manager/pass123, cashier/pass123, inventory/pass123) but are only created if `setup_complete` flag is not set.

---

## CSS Design System

- **Dark theme** (default): #131313 base, steel blue primary (#b9c7e4), electric orange accent (#ffb77d)
- **Light theme**: #f5f5f5 base, deep blue primary (#1a3a5c), warm orange accent (#c56b00)
- **Typography**: Manrope (headings, 800 weight), Inter (body)
- **Icons**: Material Symbols Outlined (Google Fonts CDN)
- **Charts**: Chart.js 4.4.1
- **No borders** — tonal depth instead. Glassmorphism modals (backdrop-filter blur).
- **Radius**: 0.125rem–0.75rem (architectural, hard-edge)

---

## File Locations on User's Mac

The project lives in iCloud Drive:
```
~/Library/Mobile Documents/com~apple~CloudDocs/Daddy Joe/Dwatrex-Desktop/
```

To run: `cd` to that folder, then `python3 main.py` (pywebview already installed).

---

## Windows Installer Pipeline

1. `build_installer.bat` → one-click on Windows
2. Requires: Python 3.8+, Inno Setup 6
3. Produces: `installer_output/DwatrexSetup.exe` (~51MB)
4. Per-user install (no admin rights), desktop shortcut, Start Menu entry, uninstaller
5. End users need NOTHING installed — just run the .exe installer

---

## What's NOT Done / Potential Next Steps

- **Excel (.xlsx) upload support** — currently CSV only. Could add SheetJS or openpyxl parsing.
- **Export to CSV/Excel** — no export functionality yet for any data
- **Barcode scanning** — POS could support barcode input
- **Multi-store support** — currently single-store only
- **Backup/restore** — no database backup feature
- **Receipt printing** — receipt modal exists but no actual print integration
- **Cloud sync** — fully offline, no cloud features
- **Password reset** — no forgot password flow (admin must reset manually)
- **Audit log** — no activity logging
- **Dashboard charts** — could add more chart types or date range selectors
- **The build has only been tested conceptually** — the actual PyInstaller + Inno Setup build needs to run on a real Windows machine

---

## API Methods Reference (api.py — class StoreHubAPI)

### Auth & Setup
- `check_first_run()` → `{setupNeeded: bool}`
- `complete_setup(store_name, admin_name, admin_username, admin_password)`
- `login(username, password)` → user object (without password field)

### Categories
- `get_categories()`, `save_category(id, name)`, `delete_category(id)`
- `bulk_import_categories(names_json)`

### Suppliers
- `get_suppliers()`, `save_supplier(id, name, contact, email, phone)`, `delete_supplier(id)`

### Products
- `get_products(search, category, status)`, `save_product(id, sku, name, ...)`, `delete_product(id)`
- `bulk_import_products(products_json)`, `get_all_products()`

### Sales
- `get_sales(date_from, date_to)`, `complete_sale(items_json, discount, tax, payment)`

### Purchases
- `get_purchases()`, `save_purchase(supplier, items_json)`

### Inventory
- `get_inventory_summary()`, `get_stock_movements(limit)`

### Returns
- `get_returns()`, `save_return(sale_id, product_id, product_name, qty, reason, resellable, unit_price)`

### Users
- `get_users()`, `save_user(id, name, username, password, role, status)`, `delete_user(id)`

### Dashboard & Reports
- `get_dashboard_data()`, `get_sales_for_period(date_from, date_to)`

### Settings
- `get_settings()`, `save_settings(settings_json)`
