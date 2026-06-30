// ═══════════════════════════════════════════════════════════════
// DWATREX — Retail Operations Platform (Frontend)
// Calls Python backend via pywebview bridge
// ═══════════════════════════════════════════════════════════════

let currentRole = 'admin';
let currentUser = 'Admin';
let cart = [];
let chartInstances = {};
let cachedProducts = [];
let cachedSales = [];
let posProducts = [];
// Store profile shown on receipts (populated from Settings at login).
let storeInfo = { name: '', address: '', phone: '', email: '', logo: '' };
let logoDataUrl = '';  // working value while editing the Settings page

const fmt = d => new Date(d).toISOString().split('T')[0];
const fmtDate = d => new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
// Currency symbol is configurable in Settings; defaults to Ghanaian cedi.
let currencySymbol = 'GH₵';
const money = n => currencySymbol + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return d; };

// Escape user/DB-supplied text before inserting into innerHTML (prevents stored XSS).
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

// Friendly empty-state row spanning a table, used app-wide.
function emptyRow(cols, icon, msg) {
  return `<tr><td colspan="${cols}"><div class="empty-state"><span class="material-symbols-outlined">${icon}</span><span class="empty-msg">${esc(msg)}</span></div></td></tr>`;
}

// ── Kinetic Monolith palette for charts ───────────────────
const DWATREX_PALETTE = [
  '#b9c7e4','#ffb77d','#81c784','#ffb4ab','#a5b4fc','#f9a8d4',
  '#67e8f9','#fbbf24','#86efac','#c4b5fd','#fca5a1','#34d399',
  '#f472b6','#38bdf8','#facc15'
];

// ── Theme toggle ──────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  document.getElementById('themeIcon').textContent = next === 'light' ? 'dark_mode' : 'light_mode';
  try { localStorage.setItem('dwatrex-theme', next); } catch(e) {}
  // Update chart colors if any charts exist
  Object.keys(chartInstances).forEach(k => {
    if (chartInstances[k]) { chartInstances[k].destroy(); delete chartInstances[k]; }
  });
}
// Restore saved theme on load
(function() {
  try {
    const saved = localStorage.getItem('dwatrex-theme');
    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      const icon = document.getElementById('themeIcon');
      if (icon) icon.textContent = 'dark_mode';
    }
  } catch(e) {}
})();

// ── pywebview bridge helper ────────────────────────────────
async function api(method, ...args) {
  try {
    if (!window.pywebview || !window.pywebview.api) {
      return { ok: false, data: null, msg: 'Backend not ready. Please wait a moment and try again.' };
    }
    const raw = await window.pywebview.api[method](...args);
    return JSON.parse(raw);
  } catch (e) {
    console.error('API error in', method, e);
    return { ok: false, data: null, msg: 'Something went wrong talking to the backend. Please try again.' };
  }
}

// Wait for pywebview to be ready
window.addEventListener('pywebviewready', () => { checkFirstRun(); });
setTimeout(() => { if (!window.pywebview) console.warn('pywebview not found — running in browser-only mode'); }, 2000);

// ═══════ FIRST-RUN CHECK ══════════════════════════════════
async function checkFirstRun(attempt = 0) {
  const res = await api('check_first_run');
  // The JS↔Python bridge can be momentarily unready right after launch.
  // Retry instead of falling through to the login screen (a dead end on a
  // fresh install, where no account exists yet).
  if (!res.ok) {
    if (attempt < 15) { setTimeout(() => checkFirstRun(attempt + 1), 250); return; }
    document.getElementById('setupScreen').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('appContainer').classList.add('hidden');
    return;
  }
  const needSetup = !!res.data.setupNeeded;
  document.getElementById('setupScreen').classList.toggle('hidden', !needSetup);
  document.getElementById('loginScreen').classList.toggle('hidden', needSetup);
  document.getElementById('appContainer').classList.add('hidden');
}

// ═══════ SETUP WIZARD ═════════════════════════════════════
async function handleSetup(e) {
  e.preventDefault();
  const errEl = document.getElementById('setupError');
  errEl.style.display = 'none';

  const storeName = document.getElementById('setupStoreName').value.trim();
  const adminName = document.getElementById('setupAdminName').value.trim();
  const adminUser = document.getElementById('setupAdminUser').value.trim();
  const adminPass = document.getElementById('setupAdminPass').value;
  const adminPassConfirm = document.getElementById('setupAdminPassConfirm').value;

  if (adminPass !== adminPassConfirm) {
    errEl.textContent = 'Passwords do not match';
    errEl.style.display = 'block';
    return false;
  }
  if (adminPass.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters';
    errEl.style.display = 'block';
    return false;
  }

  const res = await api('complete_setup', storeName, adminName, adminUser, adminPass);
  if (!res.ok) {
    errEl.textContent = res.msg;
    errEl.style.display = 'block';
    return false;
  }

  showToast('Setup complete! Please sign in.');
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginUser').value = adminUser;
  document.getElementById('loginPass').focus();
  return false;
}

// ═══════ LOGIN ═════════════════════════════════════════════
async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  if (!user || !pass) { showToast('Please fill all fields','error'); return false; }

  const res = await api('login', user, pass);
  if (!res.ok) {
    errEl.textContent = res.msg;
    errEl.style.display = 'block';
    return false;
  }

  const userData = res.data;
  currentUser = userData.name;
  currentRole = userData.role;
  document.getElementById('currentUser').textContent = userData.name;
  document.getElementById('currentRole').textContent = userData.role;
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appContainer').classList.remove('hidden');
  applyRolePermissions();
  initApp();
  return false;
}
async function handleLogout() {
  try { await api('logout'); } catch(e) {}
  currentUser = ''; currentRole = '';
  cart = [];
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('appContainer').classList.add('hidden');
  document.getElementById('loginForm').reset();
  document.getElementById('loginError').style.display = 'none';
}
// 'profits' is a pseudo-permission (not a page) controlling visibility of
// profit/margin figures. Only admin has it.
const ROLE_PERMS = {
  admin:['dashboard','products','categories','suppliers','sales','purchases','inventory','returns','reports','insights','expenses','users','settings','profits'],
  manager:['dashboard','products','categories','suppliers','sales','purchases','inventory','returns','reports'],
  cashier:['dashboard','sales','returns'],
  inventory:['dashboard','products','categories','suppliers','purchases','inventory'],
};
function applyRolePermissions() {
  const perms = ROLE_PERMS[currentRole]||[];
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('hidden-nav', !perms.includes(el.dataset.page));
  });
  // Topbar tabs map to a representative page; hide tabs the role can't reach.
  const TAB_PAGE = { dashboard:'dashboard', inventory:'inventory', sales:'sales', reports:'reports' };
  document.querySelectorAll('.topbar-tabs a[data-tab]').forEach(a => {
    const page = TAB_PAGE[a.dataset.tab];
    a.classList.toggle('hidden', page ? !perms.includes(page) : false);
  });
  // Quick Transaction CTA only makes sense if the role can use the POS.
  const cta = document.querySelector('.sidebar-cta');
  if (cta) cta.classList.toggle('hidden', !perms.includes('sales'));

  // Profit/margin surfaces: hide dashboard profit tiles and the profit report
  // types for roles without 'profits'.
  const showProfits = perms.includes('profits');
  document.querySelectorAll('.perm-profits').forEach(el => {
    el.hidden = !showProfits;                 // works for <option> and tiles
    el.classList.toggle('hidden', !showProfits);
  });
  const rt = document.getElementById('reportType');
  if (rt && !showProfits) {
    const sel = rt.selectedOptions[0];
    if (sel && sel.classList.contains('perm-profits')) rt.value = 'dailySales';
  }
}

// ═══════ NAV ═══════════════════════════════════════════════
const PAGE_TITLES = {
  dashboard:'Operations Dashboard', products:'Product Catalog', categories:'Categories',
  suppliers:'Supply Chain', sales:'POS Command', purchases:'Purchase Orders',
  inventory:'Inventory Intelligence', returns:'Returns Management',
  reports:'Capital Analytics', insights:'Intelligence Center',
  expenses:'Expenses', users:'User Management', settings:'System Settings'
};

// Map pages to topbar tabs
const PAGE_TAB_MAP = {
  dashboard:'dashboard', products:'inventory', categories:'inventory',
  suppliers:'inventory', sales:'sales', purchases:'inventory',
  inventory:'inventory', returns:'sales', reports:'reports',
  insights:'reports', expenses:'reports', users:'dashboard', settings:'dashboard'
};

function navigateTo(page, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pg = document.getElementById('page-'+page);
  if (pg) pg.classList.add('active');
  (el || document.querySelector(`.nav-item[data-page="${page}"]`))?.classList.add('active');

  // Update topbar tabs active state
  const tabKey = PAGE_TAB_MAP[page] || 'dashboard';
  document.querySelectorAll('.topbar-tabs a').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === tabKey);
  });

  document.getElementById('sidebar').classList.remove('open');
  refreshPage(page);
}
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }

// Real stock alerts instead of a placeholder.
async function toggleNotifications() {
  const res = await api('get_inventory_summary');
  if (!res.ok) { showToast('Could not load alerts','error'); return; }
  const { lowStock=0, outOfStock=0 } = res.data || {};
  if (!lowStock && !outOfStock) { showToast('No stock alerts — all good','success'); return; }
  const parts = [];
  if (outOfStock) parts.push(`${outOfStock} out of stock`);
  if (lowStock) parts.push(`${lowStock} low on stock`);
  showToast(parts.join(' · '), outOfStock ? 'error' : 'success');
}

// Global search jumps to the Products catalog filtered by the query.
function handleGlobalSearch(e) {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  navigateTo('products', document.querySelector('[data-page=products]'));
  const ps = document.getElementById('productSearch');
  if (ps) { ps.value = q; renderProducts(); }
}

// ═══════ TOAST / MODAL ════════════════════════════════════
function showToast(msg,type='success') {
  const t=document.getElementById('toast'); t.textContent=msg;
  t.className='toast show toast-'+type; setTimeout(()=>{t.className='toast hidden';},3000);
}
function openModal(title,html) {
  document.getElementById('modalTitle').textContent=title;
  document.getElementById('modalBody').innerHTML=html;
  document.getElementById('modal').classList.remove('hidden');
  // Autofocus the first field for keyboard users.
  const first = document.querySelector('#modalBody input, #modalBody select, #modalBody textarea');
  if (first) setTimeout(()=>first.focus(), 50);
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
function closeReceiptModal() { document.getElementById('receiptModal').classList.add('hidden'); }

// Print just the receipt (CSS isolates it via the body class).
function printReceipt() {
  document.body.classList.add('printing-receipt');
  window.print();
  setTimeout(()=>document.body.classList.remove('printing-receipt'), 500);
}

// Escape closes any open modal.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('modal')?.classList.contains('hidden')) closeModal();
    if (!document.getElementById('receiptModal')?.classList.contains('hidden')) closeReceiptModal();
  }
});

// ═══════ INIT ═════════════════════════════════════════════
async function initApp() {
  await applySettings();
  await populateFilters();
  const today = fmt(new Date());
  const ago30 = fmt(daysAgo(30));
  ['salesHistoryFrom','reportFrom','insightFrom','expenseFrom'].forEach(id => { const el=document.getElementById(id); if(el) el.value=ago30; });
  ['salesHistoryTo','reportTo','insightTo','expenseTo'].forEach(id => { const el=document.getElementById(id); if(el) el.value=today; });
  refreshPage('dashboard');
}

// Pull store settings (currency, tax, store profile) so they drive the whole UI.
async function applySettings() {
  const res = await api('get_settings');
  if (res.ok && res.data) {
    const d = res.data;
    if (d.currency) currencySymbol = d.currency;
    const taxEl = document.getElementById('cartTax');
    if (taxEl && d.taxRate != null && d.taxRate !== '') taxEl.value = d.taxRate;
    storeInfo = {
      name: d.storeName || '',
      address: d.storeAddress || '',
      phone: d.storePhone || '',
      email: d.storeEmail || '',
      logo: d.storeLogo || '',
    };
  }
}

async function refreshPage(page) {
  switch(page) {
    case 'dashboard': await renderDashboard(); break;
    case 'products': await renderProducts(); break;
    case 'categories': await renderCategories(); break;
    case 'suppliers': await renderSuppliers(); break;
    case 'sales': await renderPOSProducts(); renderCart(); await renderSalesHistory(); break;
    case 'purchases': await renderPurchases(); break;
    case 'inventory': await renderInventory(); break;
    case 'returns': await renderReturns(); break;
    case 'reports': await generateReport(); break;
    case 'insights': await renderInsights(); break;
    case 'expenses': await renderExpenses(); break;
    case 'users': await renderUsers(); break;
    case 'settings': await loadSettings(); break;
  }
}

async function populateFilters() {
  const res = await api('get_categories');
  if (!res.ok) return;
  const opts = res.data.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  ['productCategoryFilter','posCategoryFilter'].forEach(id => {
    const el=document.getElementById(id);
    if(el) el.innerHTML='<option value="">All Categories</option>'+opts;
  });
}

// ═══════ CHART CONFIG ════════════════════════════════════
function destroyChart(k) { if(chartInstances[k]) { chartInstances[k].destroy(); delete chartInstances[k]; } }
function chartColors() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return isLight
    ? { text: '#444444', grid: 'rgba(0,0,0,0.08)', bg: 'rgba(26,58,92,0.05)' }
    : { text: '#c5c6cd', grid: 'rgba(68,71,77,0.15)', bg: 'rgba(185,199,228,0.1)' };
}

// ═══════ DASHBOARD ════════════════════════════════════════
async function renderDashboard() {
  const res = await api('get_dashboard_data');
  if (!res.ok) return;
  const d = res.data;
  document.getElementById('metricTodaySales').textContent = money(d.todaySales);
  document.getElementById('metricWeekSales').textContent = money(d.weekSales);
  document.getElementById('metricMonthSales').textContent = money(d.monthSales);
  document.getElementById('metricTransactions').textContent = d.transactions;
  document.getElementById('metricInventoryVal').textContent = money(d.inventoryValue);
  document.getElementById('metricLowStock').textContent = d.lowStock;
  // Profit fields are null for roles without 'profits' (tiles are hidden anyway).
  if (d.profit != null) document.getElementById('metricProfit').textContent = money(d.profit);
  const np = document.getElementById('metricNetProfit');
  if (np && d.netProfit != null) np.textContent = money(d.netProfit);
  document.getElementById('metricProducts').textContent = d.totalProducts;

  const sr = await api('get_sales_for_period', fmt(daysAgo(30)), fmt(new Date()));
  if (!sr.ok) return;
  const sales = sr.data;
  renderSalesTrendChart(sales);
  renderCategorySalesChart(sales);

  const pMap = buildProductSalesMap(sales);
  const sorted = Object.entries(pMap).sort((a,b)=>b[1].qty-a[1].qty);

  document.querySelector('#fastMovingTable tbody').innerHTML =
    sorted.slice(0,5).map(([n,x])=>`<tr><td>${esc(n)}</td><td>${x.qty}</td><td>${money(x.revenue)}</td></tr>`).join('')||emptyRow(3,'trending_up','No sales yet');

  const slow = sorted.filter(([,x])=>x.qty>0).reverse();
  const prodRes = await api('get_all_products');
  const allProds = prodRes.ok ? prodRes.data : [];
  const noSales = allProds.filter(p=>!pMap[p.name]).map(p=>[p.name,{qty:0,revenue:0}]);
  const slowList = [...noSales,...slow].slice(0,5);
  document.querySelector('#slowMovingTable tbody').innerHTML =
    slowList.map(([n,x])=>`<tr><td>${esc(n)}</td><td>${x.qty}</td><td>-</td></tr>`).join('')||emptyRow(3,'inventory_2','No products yet');

  const recent = sales.slice(-10).reverse();
  document.querySelector('#recentSalesTable tbody').innerHTML =
    recent.map(s=>`<tr><td>#${s.id}</td><td>${fmtDate(s.date)}</td><td>${s.items.length}</td><td>${money(s.total)}</td><td>${esc(s.payment)}</td><td><span class="badge badge-success">${esc(s.status)}</span></td></tr>`).join('')||emptyRow(6,'receipt_long','No recent activity');
}

function buildProductSalesMap(sales) {
  const m={};
  sales.forEach(s=>{ (s.items||[]).forEach(i=>{
    if(!m[i.name]) m[i.name]={qty:0,revenue:0,cost:0};
    m[i.name].qty+=i.qty; m[i.name].revenue+=i.qty*i.unitPrice; m[i.name].cost+=i.qty*i.costPrice;
  });});
  return m;
}

function renderSalesTrendChart(sales) {
  destroyChart('salesTrend');
  const c = chartColors();
  const dMap = {};
  for(let i=29;i>=0;i--) dMap[fmt(daysAgo(i))]=0;
  sales.forEach(s=>{ const d=fmt(new Date(s.date)); if(dMap[d]!==undefined) dMap[d]+=s.total; });
  const labels = Object.keys(dMap).map(d=>{ const dt=new Date(d); return (dt.getMonth()+1)+'/'+dt.getDate(); });
  chartInstances['salesTrend'] = new Chart(document.getElementById('salesTrendChart'),{
    type:'line', data:{ labels, datasets:[{label:'Daily Sales',data:Object.values(dMap),
      borderColor:'#b9c7e4',backgroundColor:'rgba(185,199,228,0.08)',fill:true,tension:0.4,pointRadius:2,pointBackgroundColor:'#ffb77d'}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{color:c.text,font:{family:'Inter'}}}},
      scales:{x:{ticks:{color:c.text,maxTicksLimit:10,font:{family:'Inter',size:10}},grid:{color:c.grid}},
              y:{ticks:{color:c.text,callback:v=>'$'+v,font:{family:'Inter',size:10}},grid:{color:c.grid}}}}
  });
}

function renderCategorySalesChart(sales) {
  destroyChart('categorySales'); const c=chartColors(); const catMap={};
  sales.forEach(s=>(s.items||[]).forEach(i=>{ catMap[i.category||'Other']=(catMap[i.category||'Other']||0)+i.qty*i.unitPrice; }));
  if(Object.keys(catMap).length<=1 && cachedProducts.length) {
    const pm={}; cachedProducts.forEach(p=>pm[p.name]=p.category);
    const catMap2={};
    sales.forEach(s=>(s.items||[]).forEach(i=>{ const cat=pm[i.name]||'Other'; catMap2[cat]=(catMap2[cat]||0)+i.qty*i.unitPrice; }));
    Object.assign(catMap, catMap2);
    if(catMap['Other'] && Object.keys(catMap).length>1) delete catMap['Other'];
  }
  chartInstances['categorySales'] = new Chart(document.getElementById('categorySalesChart'),{
    type:'doughnut', data:{labels:Object.keys(catMap),datasets:[{data:Object.values(catMap),backgroundColor:DWATREX_PALETTE.slice(0,Object.keys(catMap).length),borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:c.text,boxWidth:12,padding:8,font:{size:11,family:'Inter'}}}}}
  });
}

// ═══════ PRODUCTS ═════════════════════════════════════════
async function renderProducts() {
  const s = document.getElementById('productSearch')?.value||'';
  const cat = document.getElementById('productCategoryFilter')?.value||'';
  const st = document.getElementById('productStatusFilter')?.value||'';
  const res = await api('get_products', s, cat, st);
  if(!res.ok) return;
  cachedProducts = res.data;
  const CAP = 100;
  const shown = res.data.slice(0, CAP);
  let rows = shown.map(p=>`
    <tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${money(p.cost_price)}</td><td>${money(p.selling_price)}</td>
    <td>${p.stock}</td><td>${p.reorder_level}</td>
    <td><span class="badge ${p.status==='In Stock'?'badge-success':p.status==='Low Stock'?'badge-warning':'badge-danger'}">${esc(p.status)}</span></td>
    <td class="actions"><button class="btn btn-sm btn-outline" aria-label="Edit product" onclick="openProductModal(${p.id})"><span class="material-symbols-outlined" style="font-size:14px">edit</span></button>
    <button class="btn btn-sm btn-danger" aria-label="Delete product" onclick="deleteProduct(${p.id})"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button></td></tr>
  `).join('');
  if (res.data.length > CAP) rows += `<tr><td colspan="9" style="text-align:center;color:var(--outline);padding:0.85rem">Showing first ${CAP} of ${res.data.length}. Use search or filters to narrow results.</td></tr>`;
  document.querySelector('#productsTable tbody').innerHTML = rows || emptyRow(9,'inventory_2','No products found');
}

async function openProductModal(id) {
  let p = null;
  if(id) { const r=await api('get_products','','',''); p=r.data.find(x=>x.id===id); }
  const catRes = await api('get_categories');
  const supRes = await api('get_suppliers');
  const catOpts = (catRes.data||[]).map(c=>`<option value="${esc(c.name)}" ${p&&p.category===c.name?'selected':''}>${esc(c.name)}</option>`).join('');
  const supOpts = (supRes.data||[]).map(s=>`<option value="${esc(s.name)}" ${p&&p.supplier===s.name?'selected':''}>${esc(s.name)}</option>`).join('');
  openModal(p?'Edit Product':'Add Product',`
    <form onsubmit="saveProduct(event,${id||'null'})">
      <div class="form-row"><div class="form-group"><label>SKU *</label><input id="pSku" value="${p?esc(p.sku):''}" required></div>
      <div class="form-group"><label>Product Name *</label><input id="pName" value="${p?esc(p.name):''}" required></div></div>
      <div class="form-row"><div class="form-group"><label>Category *</label><select id="pCategory" required><option value="">Select</option>${catOpts}</select></div>
      <div class="form-group"><label>Supplier</label><select id="pSupplier"><option value="">Select</option>${supOpts}</select></div></div>
      <div class="form-row"><div class="form-group"><label>Cost Price *</label><input type="number" step="0.01" id="pCost" value="${p?p.cost_price:''}" required min="0"></div>
      <div class="form-group"><label>Selling Price *</label><input type="number" step="0.01" id="pPrice" value="${p?p.selling_price:''}" required min="0"></div></div>
      <div class="form-row"><div class="form-group"><label>Stock Qty *</label><input type="number" id="pStock" value="${p?p.stock:'0'}" required min="0"></div>
      <div class="form-group"><label>Reorder Level</label><input type="number" id="pReorder" value="${p?p.reorder_level:'10'}" min="0"></div></div>
      <div class="form-group"><label>Expiry Date</label><input type="date" id="pExpiry" value="${p&&p.expiry?p.expiry:''}"></div>
      <button type="submit" class="btn btn-primary btn-block">${p?'Update':'Add'} Product</button>
    </form>`);
}

async function saveProduct(e, id) {
  e.preventDefault();
  const res = await api('save_product', id,
    document.getElementById('pSku').value.trim(), document.getElementById('pName').value.trim(),
    document.getElementById('pCategory').value, document.getElementById('pSupplier').value,
    document.getElementById('pCost').value, document.getElementById('pPrice').value,
    document.getElementById('pStock').value, document.getElementById('pReorder').value||'10',
    document.getElementById('pExpiry').value);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('Product saved'); renderProducts();
}

async function deleteProduct(id) {
  if(!confirm('Delete this product?')) return;
  const res = await api('delete_product', id);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  showToast('Product deleted'); renderProducts();
}

// ═══════ CATEGORIES ═══════════════════════════════════════
async function renderCategories() {
  const res = await api('get_categories');
  const prods = await api('get_all_products');
  const prodList = prods.ok?prods.data:[];
  document.querySelector('#categoriesTable tbody').innerHTML = (res.data||[]).map(c=>{
    const cnt = prodList.filter(p=>p.category===c.name).length;
    return `<tr><td>${c.id}</td><td>${esc(c.name)}</td><td>${cnt}</td><td class="actions">
      <button class="btn btn-sm btn-outline" aria-label="Edit category" onclick="openCategoryModal(${c.id})"><span class="material-symbols-outlined" style="font-size:14px">edit</span></button>
      <button class="btn btn-sm btn-danger" aria-label="Delete category" onclick="deleteCategory(${c.id})"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button></td></tr>`;
  }).join('')||emptyRow(4,'category','No categories yet');
}
async function openCategoryModal(id) {
  let c=null;
  if(id){ const r=await api('get_categories'); c=r.data.find(x=>x.id===id); }
  openModal(c?'Edit Category':'Add Category',`
    <form onsubmit="saveCategory(event,${id||'null'})">
      <div class="form-group"><label>Category Name *</label><input id="catName" value="${c?esc(c.name):''}" required></div>
      <button type="submit" class="btn btn-primary btn-block">${c?'Update':'Add'} Category</button></form>`);
}
async function saveCategory(e,id) {
  e.preventDefault();
  const res = await api('save_category',id,document.getElementById('catName').value.trim());
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('Category saved'); renderCategories(); populateFilters();
}
async function deleteCategory(id) {
  if(!confirm('Delete?')) return;
  const res = await api('delete_category',id);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  showToast(res.msg); renderCategories(); populateFilters();
}

// ═══════ SUPPLIERS ════════════════════════════════════════
async function renderSuppliers() {
  const res=await api('get_suppliers');
  document.querySelector('#suppliersTable tbody').innerHTML=(res.data||[]).map(s=>{
    const email=s.email?`<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`:'';
    const phone=s.phone?`<a href="tel:${esc(String(s.phone).replace(/[^+\d]/g,''))}">${esc(s.phone)}</a>`:'';
    return `<tr><td>${s.id}</td><td>${esc(s.name)}</td><td>${esc(s.contact)}</td><td>${email}</td><td>${phone}</td><td class="actions">
    <button class="btn btn-sm btn-outline" aria-label="Edit supplier" onclick="openSupplierModal(${s.id})"><span class="material-symbols-outlined" style="font-size:14px">edit</span></button>
    <button class="btn btn-sm btn-danger" aria-label="Delete supplier" onclick="deleteSupplier(${s.id})"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button></td></tr>`;}).join('')||emptyRow(6,'local_shipping','No suppliers yet');
}
async function openSupplierModal(id) {
  let s=null;
  if(id){ const r=await api('get_suppliers'); s=r.data.find(x=>x.id===id); }
  openModal(s?'Edit Supplier':'Add Supplier',`
    <form onsubmit="saveSupplier(event,${id||'null'})">
      <div class="form-group"><label>Name *</label><input id="supName" value="${s?esc(s.name):''}" required></div>
      <div class="form-group"><label>Contact</label><input id="supContact" value="${s?esc(s.contact):''}"></div>
      <div class="form-row"><div class="form-group"><label>Email</label><input type="email" id="supEmail" value="${s?esc(s.email):''}"></div>
      <div class="form-group"><label>Phone</label><input id="supPhone" value="${s?esc(s.phone):''}"></div></div>
      <button type="submit" class="btn btn-primary btn-block">${s?'Update':'Add'} Supplier</button></form>`);
}
async function saveSupplier(e,id) {
  e.preventDefault();
  const res = await api('save_supplier',id,document.getElementById('supName').value.trim(),
    document.getElementById('supContact').value.trim(),document.getElementById('supEmail').value.trim(),
    document.getElementById('supPhone').value.trim());
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('Supplier saved'); renderSuppliers();
}
async function deleteSupplier(id) {
  if(!confirm('Delete?')) return;
  const res = await api('delete_supplier',id);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  showToast('Deleted'); renderSuppliers();
}

// ═══════ SALES / POS ═════════════════════════════════════
async function renderPOSProducts() {
  const s=document.getElementById('posSearch')?.value||'';
  const cat=document.getElementById('posCategoryFilter')?.value||'';
  const res=await api('get_products',s,cat,'');
  const prods=(res.data||[]).filter(p=>p.stock>0);
  posProducts = prods;  // cache for safe lookup by id (avoids interpolating names into onclick)
  document.getElementById('posProductGrid').innerHTML = prods.map(p=>`
    <div class="pos-product-card" onclick="addToCart(${p.id})">
      <div class="product-name">${esc(p.name)}</div><div class="product-price">${money(p.selling_price)}</div>
      <div class="product-stock">Stock: ${p.stock}</div></div>`).join('')||'<p style="padding:2rem;color:var(--outline);text-align:center">No products found</p>';
}

function addToCart(id) {
  const p = posProducts.find(x=>x.id===id);
  if(!p){ showToast('Product unavailable','error'); return; }
  const ex=cart.find(c=>c.productId===id);
  if(ex){ if(ex.qty>=p.stock){showToast('Not enough stock','error');return;} ex.qty++; }
  else cart.push({productId:id,name:p.name,unitPrice:p.selling_price,originalPrice:p.selling_price,costPrice:p.cost_price,qty:1,maxStock:p.stock});
  renderCart();
}
function renderCart() {
  const c=document.getElementById('cartItems');
  if(!cart.length) { c.innerHTML='<p style="text-align:center;color:var(--outline);padding:2rem">Cart is empty</p>'; }
  else { c.innerHTML=cart.map((it,i)=>{
    const priceChanged = it.unitPrice !== it.originalPrice;
    return `<div class="cart-item"><span class="item-name">${esc(it.name)}</span>
    <input type="number" class="item-qty" value="${it.qty}" min="1" max="${it.maxStock}" onchange="updateCartQty(${i},this.value)">
    <input type="number" step="0.01" class="item-price" value="${it.unitPrice.toFixed(2)}" min="0" onchange="updateCartPrice(${i},this.value)" title="Edit price">
    ${priceChanged ? `<span class="item-original-price">${money(it.originalPrice)}</span>` : ''}
    <span class="item-total">${money(it.qty*it.unitPrice)}</span>
    <button class="item-remove" onclick="removeFromCart(${i})"><span class="material-symbols-outlined" style="font-size:16px">close</span></button></div>`;
  }).join(''); }
  updateCartTotals();
}
function updateCartQty(i,v){ const q=parseInt(v); if(q>0&&q<=cart[i].maxStock) cart[i].qty=q; renderCart(); }
function updateCartPrice(i,v){ const p=parseFloat(v); if(p>=0) { cart[i].unitPrice=p; renderCart(); } }
function removeFromCart(i){ cart.splice(i,1); renderCart(); }
function clearCart(){ cart=[]; renderCart(); }
function updateCartTotals() {
  const sub=cart.reduce((s,i)=>s+i.qty*i.unitPrice,0);
  const disc=parseFloat(document.getElementById('cartDiscount')?.value||0);
  const tax=parseFloat(document.getElementById('cartTax')?.value||0);
  const da=sub*disc/100; const ta=(sub-da)*tax/100;
  document.getElementById('cartSubtotal').textContent=money(sub);
  document.getElementById('cartTotal').textContent=money(sub-da+ta);
}

async function completeSale() {
  if(!cart.length){ showToast('Cart is empty','error'); return; }
  const disc=parseFloat(document.getElementById('cartDiscount').value||0);
  const tax=parseFloat(document.getElementById('cartTax').value||0);
  const payment=document.getElementById('paymentMethod').value;
  const items=cart.map(c=>({productId:c.productId,name:c.name,qty:c.qty,unitPrice:c.unitPrice,costPrice:c.costPrice}));
  const res=await api('complete_sale',JSON.stringify(items),disc,tax,payment);
  if(!res.ok){ showToast(res.msg,'error'); return; }
  showReceipt(res.data);
  cart=[]; renderCart(); renderPOSProducts(); renderSalesHistory();
  showToast('Sale completed! #'+res.data.id);
}

function showReceipt(sale) {
  const items = sale.items||[];
  const si = storeInfo;
  const name = si.name || 'DWATREX';
  const logoOk = si.logo && si.logo.startsWith('data:image/');
  const contactBits = [];
  if (si.phone) contactBits.push('Tel: ' + si.phone);
  if (si.email) contactBits.push(si.email);
  const header = `
    ${logoOk ? `<img src="${si.logo}" class="receipt-logo" alt="">` : ''}
    <strong>${esc(name)}</strong>
    ${si.address ? `<div class="receipt-shop-line">${esc(si.address)}</div>` : ''}
    ${contactBits.length ? `<div class="receipt-shop-line">${esc(contactBits.join('  •  '))}</div>` : ''}
    <div class="receipt-shop-line">Receipt #${sale.id} &middot; ${fmtDate(sale.date)}</div>`;
  document.getElementById('receiptContent').innerHTML=`
    <div class="receipt-header">${header}</div>
    ${items.map(i=>`<div class="receipt-line"><span>${esc(i.name)} x${i.qty}</span><span>${money(i.qty*i.unitPrice)}</span></div>`).join('')}
    <div class="receipt-divider"></div>
    <div class="receipt-line"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
    ${sale.discount>0?`<div class="receipt-line"><span>Discount (${sale.discount}%)</span><span>-${money(sale.discount_amt)}</span></div>`:''}
    <div class="receipt-line"><span>Tax (${sale.tax}%)</span><span>${money(sale.tax_amt)}</span></div>
    <div class="receipt-divider"></div>
    <div class="receipt-line receipt-total"><span>TOTAL</span><span>${money(sale.total)}</span></div>
    <div class="receipt-line"><span>Payment</span><span>${esc(sale.payment)}</span></div>
    <div class="receipt-footer">Powering Your Store Capital</div>`;
  document.getElementById('receiptModal').classList.remove('hidden');
}

async function renderSalesHistory() {
  const from=document.getElementById('salesHistoryFrom')?.value||fmt(daysAgo(30));
  const to=document.getElementById('salesHistoryTo')?.value||fmt(new Date());
  const res=await api('get_sales',from,to);
  if(!res.ok) return;
  document.querySelector('#salesHistoryTable tbody').innerHTML=res.data.slice(0,50).map(s=>`
    <tr><td>#${s.id}</td><td>${fmtDate(s.date)}</td><td>${(s.items||[]).length}</td>
    <td>${money(s.subtotal)}</td><td>${s.discount}%</td><td>${s.tax}%</td>
    <td><strong>${money(s.total)}</strong></td><td>${esc(s.payment)}</td>
    <td><button class="btn btn-sm btn-outline" aria-label="View receipt" onclick="showReceiptById(${s.id})"><span class="material-symbols-outlined" style="font-size:14px">receipt</span></button></td></tr>`).join('')||emptyRow(9,'point_of_sale','No sales in this range');
  cachedSales = res.data;
}

async function showReceiptById(id) {
  const s = cachedSales.find(x=>x.id===id);
  if(s) showReceipt(s);
}

// ═══════ PURCHASES ═══════════════════════════════════════
async function renderPurchases() {
  const res=await api('get_purchases');
  document.querySelector('#purchasesTable tbody').innerHTML=(res.data||[]).map(p=>
    `<tr><td>#${p.id}</td><td>${fmtDate(p.date)}</td><td>${esc(p.supplier)}</td><td>${(p.items||[]).length}</td>
    <td>${money(p.total_cost)}</td><td><span class="badge badge-success">${esc(p.status)}</span></td></tr>`).join('')||emptyRow(6,'shopping_cart_checkout','No purchases recorded');
}

async function openPurchaseModal() {
  const sRes=await api('get_suppliers'); const pRes=await api('get_all_products');
  const supOpts=(sRes.data||[]).map(s=>`<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  const prodOpts=(pRes.data||[]).map(p=>`<option value="${p.id}" data-cost="${p.cost_price}">${esc(p.name)} (${esc(p.sku)})</option>`).join('');
  openModal('New Purchase',`
    <form onsubmit="savePurchase(event)">
      <div class="form-group"><label>Supplier *</label><select id="puSupplier" required><option value="">Select</option>${supOpts}</select></div>
      <div id="purchaseItems"><div class="form-row purchase-item-row">
        <div class="form-group"><label>Product *</label><select class="puProduct" required><option value="">Select</option>${prodOpts}</select></div>
        <div class="form-group"><label>Qty *</label><input type="number" class="puQty" min="1" value="10" required></div>
        <div class="form-group"><label>Unit Cost *</label><input type="number" step="0.01" class="puCost" min="0" required></div>
      </div></div>
      <button type="button" class="btn btn-outline btn-sm" onclick="addPurchaseRow()" style="margin-bottom:1rem"><span class="material-symbols-outlined" style="font-size:14px">add</span> Add Item</button>
      <button type="submit" class="btn btn-primary btn-block">Save Purchase</button></form>`);
  window._purchaseProdOpts = prodOpts;
}
function addPurchaseRow() {
  const c=document.getElementById('purchaseItems'); const d=document.createElement('div');
  d.className='form-row purchase-item-row';
  d.innerHTML=`<div class="form-group"><label>Product *</label><select class="puProduct" required><option value="">Select</option>${window._purchaseProdOpts}</select></div>
    <div class="form-group"><label>Qty *</label><input type="number" class="puQty" min="1" value="10" required></div>
    <div class="form-group"><label>Unit Cost *</label><input type="number" step="0.01" class="puCost" min="0" required></div>`;
  c.appendChild(d);
}

async function savePurchase(e) {
  e.preventDefault();
  const supplier=document.getElementById('puSupplier').value;
  const rows=document.querySelectorAll('.purchase-item-row');
  const items=[];
  const allProds = (await api('get_all_products')).data||[];
  rows.forEach(row=>{
    const pid=parseInt(row.querySelector('.puProduct').value);
    const qty=parseInt(row.querySelector('.puQty').value);
    const cost=parseFloat(row.querySelector('.puCost').value);
    const prod=allProds.find(p=>p.id===pid);
    if(prod&&qty>0) items.push({productId:pid,name:prod.name,qty,unitCost:cost});
  });
  if(!items.length){ showToast('Add at least one item','error'); return; }
  const res = await api('save_purchase',supplier,JSON.stringify(items));
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('Purchase recorded'); renderPurchases();
}

// ═══════ INVENTORY ═══════════════════════════════════════
async function renderInventory() {
  const res=await api('get_inventory_summary');
  if(res.ok){ const d=res.data;
    document.getElementById('invTotalItems').textContent=d.totalItems.toLocaleString();
    document.getElementById('invTotalValue').textContent=money(d.totalValue);
    document.getElementById('invLowStock').textContent=d.lowStock;
    document.getElementById('invOutOfStock').textContent=d.outOfStock;
  }
  const mRes=await api('get_stock_movements',50);
  document.querySelector('#stockMovementTable tbody').innerHTML=(mRes.data||[]).map(m=>
    `<tr><td>${fmtDate(m.date)}</td><td>${esc(m.product_name)}</td>
    <td><span class="badge ${m.type==='IN'?'badge-success':'badge-danger'}">${esc(m.type)}</span></td>
    <td>${m.qty}</td><td>${esc(m.reference)}</td></tr>`).join('')||emptyRow(5,'warehouse','No stock movements yet');
}

// ═══════ RETURNS ═════════════════════════════════════════
async function renderReturns() {
  const res=await api('get_returns');
  document.querySelector('#returnsTable tbody').innerHTML=(res.data||[]).map(r=>
    `<tr><td>#${r.id}</td><td>${fmtDate(r.date)}</td><td>#${r.sale_id}</td><td>${esc(r.product_name)}</td>
    <td>${r.qty}</td><td>${esc(r.reason)}</td>
    <td><span class="badge ${r.resellable?'badge-success':'badge-danger'}">${r.resellable?'Yes':'No'}</span></td>
    <td>${money(r.refund)}</td></tr>`).join('')||emptyRow(8,'assignment_return','No returns recorded');
}

async function openReturnModal() {
  const sRes=await api('get_sales',fmt(daysAgo(60)),fmt(new Date()));
  const saleOpts=(sRes.data||[]).slice(0,30).map(s=>`<option value='${JSON.stringify({id:s.id,items:s.items}).replace(/'/g,"&#39;")}'>#${s.id} - ${fmtDate(s.date)} (${money(s.total)})</option>`).join('');
  openModal('New Return',`
    <form onsubmit="saveReturn(event)">
      <div class="form-group"><label>Sale *</label><select id="retSale" required onchange="loadReturnProducts()"><option value="">Select</option>${saleOpts}</select></div>
      <div class="form-group"><label>Product *</label><select id="retProduct" required><option value="">Select sale first</option></select></div>
      <div class="form-group"><label>Quantity *</label><input type="number" id="retQty" value="1" min="1" required></div>
      <div class="form-group"><label>Reason *</label><select id="retReason" required>
        <option>Defective</option><option>Expired</option><option>Wrong item</option><option>Customer changed mind</option><option>Damaged packaging</option></select></div>
      <div class="form-group"><label>Resellable?</label><select id="retResellable"><option value="1">Yes</option><option value="0">No</option></select></div>
      <button type="submit" class="btn btn-primary btn-block">Process Return</button></form>`);
}

function loadReturnProducts() {
  const sel=document.getElementById('retSale');
  try {
    const sale=JSON.parse(sel.value);
    document.getElementById('retProduct').innerHTML=(sale.items||[]).map(i=>
      `<option value='${JSON.stringify(i).replace(/'/g,"&#39;")}'>${esc(i.name)}</option>`).join('');
  } catch(e) { document.getElementById('retProduct').innerHTML='<option>Select sale first</option>'; }
}

async function saveReturn(e) {
  e.preventDefault();
  try {
    const sale=JSON.parse(document.getElementById('retSale').value);
    const item=JSON.parse(document.getElementById('retProduct').value);
    const qty=document.getElementById('retQty').value;
    const reason=document.getElementById('retReason').value;
    const resellable=document.getElementById('retResellable').value;
    const res = await api('save_return',sale.id,item.productId,item.name,qty,reason,resellable,item.unitPrice);
    if (!res.ok) { showToast(res.msg, 'error'); return; }
    closeModal(); showToast('Return processed'); renderReturns();
  } catch(err) { showToast('Invalid selection','error'); }
}

// ═══════ REPORTS ═════════════════════════════════════════
let reportChartInstance = null;

// Export the currently displayed report table to CSV (opens in Excel/Sheets).
function exportReportCSV() {
  const table = document.getElementById('reportTable');
  const rows = [...table.querySelectorAll('tr')];
  if (!rows.length) { showToast('Nothing to export yet','error'); return; }
  const csv = rows.map(tr =>
    [...tr.querySelectorAll('th,td')].map(c => {
      const t = c.textContent.replace(/"/g,'""');
      return /[",\n]/.test(t) ? `"${t}"` : t;
    }).join(',')
  ).join('\n');
  const type = document.getElementById('reportType')?.value || 'report';
  downloadCSV(csv, `dwatrex_${type}_${fmt(new Date())}.csv`);
  showToast('Report exported');
}

// "PDF" export uses the browser/OS print dialog (Save as PDF).
function exportReportPDF() {
  document.body.classList.add('printing-report');
  window.print();
  setTimeout(()=>document.body.classList.remove('printing-report'), 500);
}

async function generateReport() {
  const type=document.getElementById('reportType')?.value||'dailySales';
  const from=document.getElementById('reportFrom')?.value||fmt(daysAgo(30));
  const to=document.getElementById('reportTo')?.value||fmt(new Date());
  const sRes=await api('get_sales_for_period',from,to);
  const filtered=sRes.ok?sRes.data:[];
  if(reportChartInstance){ reportChartInstance.destroy(); reportChartInstance=null; }
  const c=chartColors();
  const ctx=document.getElementById('reportChart');
  const thead=document.querySelector('#reportTable thead');
  const tbody=document.querySelector('#reportTable tbody');

  switch(type) {
    case 'dailySales': {
      const map={}; filtered.forEach(s=>{ const d=fmt(new Date(s.date)); map[d]=(map[d]||0)+s.total; });
      const entries=Object.entries(map).sort();
      reportChartInstance=new Chart(ctx,{type:'bar',data:{labels:entries.map(e=>e[0]),datasets:[{label:'Daily Sales',data:entries.map(e=>e[1]),backgroundColor:'#b9c7e4',borderRadius:2}]},
        options:{responsive:true,maintainAspectRatio:false,scales:{y:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},x:{ticks:{color:c.text}}},plugins:{legend:{labels:{color:c.text}}}}});
      thead.innerHTML='<tr><th>Date</th><th>Sales</th><th>Transactions</th></tr>';
      tbody.innerHTML=entries.map(([d,v])=>{const cnt=filtered.filter(s=>fmt(new Date(s.date))===d).length; return `<tr><td>${d}</td><td>${money(v)}</td><td>${cnt}</td></tr>`;}).join('');
      break; }
    case 'weeklySales': {
      const map={}; filtered.forEach(s=>{const w=getWeek(new Date(s.date)); map[w]=(map[w]||0)+s.total;}); const entries=Object.entries(map).sort();
      reportChartInstance=new Chart(ctx,{type:'bar',data:{labels:entries.map(e=>e[0]),datasets:[{label:'Weekly Sales',data:entries.map(e=>e[1]),backgroundColor:'#81c784',borderRadius:2}]},
        options:{responsive:true,maintainAspectRatio:false,scales:{y:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},x:{ticks:{color:c.text}}},plugins:{legend:{labels:{color:c.text}}}}});
      thead.innerHTML='<tr><th>Week</th><th>Sales</th></tr>';
      tbody.innerHTML=entries.map(([w,v])=>`<tr><td>${w}</td><td>${money(v)}</td></tr>`).join(''); break; }
    case 'monthlySales': {
      const map={}; filtered.forEach(s=>{const d=new Date(s.date); const m=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); map[m]=(map[m]||0)+s.total;}); const entries=Object.entries(map).sort();
      reportChartInstance=new Chart(ctx,{type:'bar',data:{labels:entries.map(e=>e[0]),datasets:[{label:'Monthly Sales',data:entries.map(e=>e[1]),backgroundColor:'#a5b4fc',borderRadius:2}]},
        options:{responsive:true,maintainAspectRatio:false,scales:{y:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},x:{ticks:{color:c.text}}},plugins:{legend:{labels:{color:c.text}}}}});
      thead.innerHTML='<tr><th>Month</th><th>Sales</th></tr>';
      tbody.innerHTML=entries.map(([m,v])=>`<tr><td>${m}</td><td>${money(v)}</td></tr>`).join(''); break; }
    case 'salesByProduct': {
      const map=buildProductSalesMap(filtered); const entries=Object.entries(map).sort((a,b)=>b[1].revenue-a[1].revenue); const top=entries.slice(0,15);
      reportChartInstance=new Chart(ctx,{type:'bar',data:{labels:top.map(e=>e[0].substring(0,20)),datasets:[{label:'Revenue',data:top.map(e=>e[1].revenue),backgroundColor:DWATREX_PALETTE}]},
        options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',scales:{x:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},y:{ticks:{color:c.text,font:{size:10}}}},plugins:{legend:{display:false}}}});
      thead.innerHTML='<tr><th>Product</th><th>Qty Sold</th><th>Revenue</th></tr>';
      tbody.innerHTML=entries.map(([n,d])=>`<tr><td>${esc(n)}</td><td>${d.qty}</td><td>${money(d.revenue)}</td></tr>`).join(''); break; }
    case 'salesByCategory': {
      const map={}; const allP=(await api('get_all_products')).data||[]; const pm={}; allP.forEach(p=>pm[p.name]=p.category);
      filtered.forEach(s=>(s.items||[]).forEach(i=>{const cat=pm[i.name]||'Other'; map[cat]=(map[cat]||0)+i.qty*i.unitPrice;})); const entries=Object.entries(map).sort((a,b)=>b[1]-a[1]);
      reportChartInstance=new Chart(ctx,{type:'pie',data:{labels:entries.map(e=>e[0]),datasets:[{data:entries.map(e=>e[1]),backgroundColor:DWATREX_PALETTE,borderWidth:0}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:c.text}}}}});
      thead.innerHTML='<tr><th>Category</th><th>Revenue</th></tr>';
      tbody.innerHTML=entries.map(([cat,v])=>`<tr><td>${esc(cat)}</td><td>${money(v)}</td></tr>`).join(''); break; }
    case 'profitByPeriod': {
      const map={}; filtered.forEach(s=>{const d=fmt(new Date(s.date)); if(!map[d]) map[d]={revenue:0,cost:0};
        (s.items||[]).forEach(i=>{map[d].revenue+=i.qty*i.unitPrice; map[d].cost+=i.qty*i.costPrice;});}); const entries=Object.entries(map).sort();
      reportChartInstance=new Chart(ctx,{type:'line',data:{labels:entries.map(e=>e[0]),
        datasets:[{label:'Revenue',data:entries.map(e=>e[1].revenue),borderColor:'#b9c7e4',tension:0.3},
        {label:'Cost',data:entries.map(e=>e[1].cost),borderColor:'#ffb4ab',tension:0.3},
        {label:'Profit',data:entries.map(e=>e[1].revenue-e[1].cost),borderColor:'#81c784',backgroundColor:'rgba(129,199,132,0.08)',fill:true,tension:0.3}]},
        options:{responsive:true,maintainAspectRatio:false,scales:{y:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},x:{ticks:{color:c.text,maxTicksLimit:10}}},plugins:{legend:{labels:{color:c.text}}}}});
      thead.innerHTML='<tr><th>Date</th><th>Revenue</th><th>Cost</th><th>Profit</th></tr>';
      tbody.innerHTML=entries.map(([d,v])=>`<tr><td>${d}</td><td>${money(v.revenue)}</td><td>${money(v.cost)}</td><td>${money(v.revenue-v.cost)}</td></tr>`).join(''); break; }
    case 'profitLoss': {
      const plr = await api('get_profit_loss', from, to);
      const d = plr.ok ? plr.data : {revenue:0,cogs:0,gross:0,byCategory:[],expensesTotal:0,net:0};
      reportChartInstance=new Chart(ctx,{type:'bar',data:{labels:['Revenue','Cost of Goods','Gross Profit','Expenses','Net Profit'],
        datasets:[{label:'Amount',data:[d.revenue,d.cogs,d.gross,d.expensesTotal,d.net],
          backgroundColor:['#b9c7e4','#ffb4ab','#81c784','#ffb77d', d.net>=0?'#34d399':'#ff6b6b'],borderRadius:3}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},x:{ticks:{color:c.text}}}}});
      thead.innerHTML='<tr><th>Profit &amp; Loss</th><th style="text-align:right">Amount</th></tr>';
      let b=`<tr><td>Revenue (sales)</td><td style="text-align:right">${money(d.revenue)}</td></tr>
        <tr><td>Less: Cost of Goods Sold</td><td style="text-align:right">(${money(d.cogs)})</td></tr>
        <tr style="font-weight:700"><td>Gross Profit</td><td style="text-align:right">${money(d.gross)}</td></tr>`;
      (d.byCategory||[]).forEach(e=>{ b+=`<tr><td style="padding-left:1.5rem;color:var(--on-surface-variant)">Less: ${esc(e.category)}</td><td style="text-align:right">(${money(e.amount)})</td></tr>`; });
      b+=`<tr><td>Total Operating Expenses</td><td style="text-align:right">(${money(d.expensesTotal)})</td></tr>
        <tr style="font-weight:800"><td>Net Profit</td><td style="text-align:right;color:${d.net>=0?'var(--success)':'var(--error)'}">${money(d.net)}</td></tr>`;
      tbody.innerHTML=b; break; }
    case 'inventoryValuation': {
      const allP=(await api('get_all_products')).data||[];
      thead.innerHTML='<tr><th>Product</th><th>SKU</th><th>Stock</th><th>Cost Price</th><th>Total Value</th></tr>';
      const total=allP.reduce((s,p)=>s+p.stock*p.cost_price,0);
      tbody.innerHTML=allP.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.sku)}</td><td>${p.stock}</td><td>${money(p.cost_price)}</td><td>${money(p.stock*p.cost_price)}</td></tr>`).join('')
        +`<tr style="font-weight:700"><td colspan="4">Total</td><td>${money(total)}</td></tr>`; break; }
    case 'lowStock': {
      const allP=(await api('get_all_products')).data||[]; const low=allP.filter(p=>p.stock<=p.reorder_level);
      thead.innerHTML='<tr><th>Product</th><th>SKU</th><th>Stock</th><th>Reorder Level</th><th>Status</th></tr>';
      tbody.innerHTML=low.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.sku)}</td><td>${p.stock}</td><td>${p.reorder_level}</td><td><span class="badge ${p.stock<=0?'badge-danger':'badge-warning'}">${esc(p.status)}</span></td></tr>`).join(''); break; }
    case 'stockMovement': {
      const mRes=await api('get_stock_movements',200);
      const moves=(mRes.data||[]).filter(m=>{const d=fmt(new Date(m.date)); return d>=from&&d<=to;});
      thead.innerHTML='<tr><th>Date</th><th>Product</th><th>Type</th><th>Qty</th><th>Reference</th></tr>';
      tbody.innerHTML=moves.map(m=>`<tr><td>${fmtDate(m.date)}</td><td>${esc(m.product_name)}</td><td><span class="badge ${m.type==='IN'?'badge-success':'badge-danger'}">${esc(m.type)}</span></td><td>${m.qty}</td><td>${esc(m.reference)}</td></tr>`).join(''); break; }
    case 'returnsReport': {
      const rRes=await api('get_returns'); const rets=(rRes.data||[]).filter(r=>{const d=fmt(new Date(r.date)); return d>=from&&d<=to;});
      thead.innerHTML='<tr><th>ID</th><th>Date</th><th>Product</th><th>Qty</th><th>Reason</th><th>Resellable</th><th>Refund</th></tr>';
      tbody.innerHTML=rets.map(r=>`<tr><td>#${r.id}</td><td>${fmtDate(r.date)}</td><td>${esc(r.product_name)}</td><td>${r.qty}</td><td>${esc(r.reason)}</td><td>${r.resellable?'Yes':'No'}</td><td>${money(r.refund)}</td></tr>`).join(''); break; }
    case 'fastMoving': {
      const map=buildProductSalesMap(filtered); const entries=Object.entries(map).sort((a,b)=>b[1].qty-a[1].qty).slice(0,20);
      reportChartInstance=new Chart(ctx,{type:'bar',data:{labels:entries.map(e=>e[0].substring(0,20)),datasets:[{label:'Units Sold',data:entries.map(e=>e[1].qty),backgroundColor:DWATREX_PALETTE,borderRadius:2}]},
        options:{responsive:true,maintainAspectRatio:false,scales:{y:{ticks:{color:c.text},grid:{color:c.grid}},x:{ticks:{color:c.text,font:{size:10}}}},plugins:{legend:{display:false}}}});
      thead.innerHTML='<tr><th>Product</th><th>Qty Sold</th><th>Revenue</th></tr>';
      tbody.innerHTML=entries.map(([n,d])=>`<tr><td>${esc(n)}</td><td>${d.qty}</td><td>${money(d.revenue)}</td></tr>`).join(''); break; }
    case 'slowMoving': {
      const map=buildProductSalesMap(filtered); const allP=(await api('get_all_products')).data||[];
      const slow=allP.map(p=>({name:p.name,qty:map[p.name]?.qty||0,stock:p.stock})).sort((a,b)=>a.qty-b.qty).slice(0,20);
      thead.innerHTML='<tr><th>Product</th><th>Qty Sold</th><th>Current Stock</th></tr>';
      tbody.innerHTML=slow.map(p=>`<tr><td>${esc(p.name)}</td><td>${p.qty}</td><td>${p.stock}</td></tr>`).join(''); break; }
  }
}

function getWeek(d){const s=new Date(d.getFullYear(),0,1); const diff=d-s; const w=Math.ceil((diff/86400000+s.getDay()+1)/7); return d.getFullYear()+'-W'+String(w).padStart(2,'0');}

// ═══════ INSIGHTS ════════════════════════════════════════
function insightEmptyRow(cols, icon, msg) {
  return `<tr><td colspan="${cols}"><div class="empty-state"><span class="material-symbols-outlined">${icon}</span><span class="empty-msg">${esc(msg)}</span></div></td></tr>`;
}

// Date-range presets
function setInsightRange(btn) {
  document.querySelectorAll('#insightPresets .preset-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const today=new Date();
  let fromD;
  if(btn.dataset.preset==='mtd') fromD=new Date(today.getFullYear(),today.getMonth(),1);
  else if(btn.dataset.preset==='qtd') fromD=new Date(today.getFullYear(),Math.floor(today.getMonth()/3)*3,1);
  else fromD=daysAgo(parseInt(btn.dataset.days));
  document.getElementById('insightFrom').value=fmt(fromD);
  document.getElementById('insightTo').value=fmt(today);
  renderInsights();
}
function onInsightDateManual() {
  document.querySelectorAll('#insightPresets .preset-btn').forEach(b=>b.classList.remove('active'));
  renderInsights();
}

async function renderInsights() {
  const status=document.getElementById('insightStatus');
  if(status){ status.textContent='Updating…'; status.classList.add('busy'); }
  try {
    const from=document.getElementById('insightFrom')?.value||fmt(daysAgo(30));
    const to=document.getElementById('insightTo')?.value||fmt(new Date());
    const count=parseInt(document.getElementById('insightCount')?.value||10);
    const label=`${fmtDate(from)} – ${fmtDate(to)}`;

    const sRes=await api('get_sales_for_period',from,to);
    const sales=sRes.ok?sRes.data:[];
    const map=buildProductSalesMap(sales);
    // Best/worst tables show "Qty Sold", so rank by units; profitability ranks by profit.
    const byQty=Object.entries(map).sort((a,b)=>b[1].qty-a[1].qty);
    const byProfit=Object.entries(map).sort((a,b)=>(b[1].revenue-b[1].cost)-(a[1].revenue-a[1].cost));
    const c=chartColors();
    const allP=(await api('get_all_products')).data||[];

    // Range labels on ranked cards
    ['bestMeta','worstMeta','profitMeta'].forEach(id=>{const e=document.getElementById(id); if(e) e.textContent=label;});

    document.querySelector('#insightBestSelling tbody').innerHTML=
      byQty.slice(0,count).map(([n,d])=>`<tr><td>${esc(n)}</td><td>${d.qty}</td><td>${money(d.revenue)}</td></tr>`).join('')||insightEmptyRow(3,'inventory_2','No sales in this period');

    const worst=byQty.filter(([,d])=>d.qty>0).reverse();
    document.querySelector('#insightWorstSelling tbody').innerHTML=
      worst.slice(0,count).map(([n,d])=>`<tr><td>${esc(n)}</td><td>${d.qty}</td><td>${money(d.revenue)}</td></tr>`).join('')||insightEmptyRow(3,'inventory_2','No sales in this period');

    // Dead stock — point-in-time snapshot; show all, ranked by value tied up
    const soldIds=new Set(); sales.forEach(s=>(s.items||[]).forEach(i=>soldIds.add(i.productId)));
    const dead=allP.filter(p=>!soldIds.has(p.id)&&p.stock>0).sort((a,b)=>(b.stock*b.cost_price)-(a.stock*a.cost_price));
    const deadValue=dead.reduce((s,p)=>s+p.stock*p.cost_price,0);
    document.querySelector('#insightDeadStock tbody').innerHTML=
      dead.map(p=>`<tr><td>${esc(p.name)}</td><td>${p.stock}</td><td class="val-emphasis">${money(p.stock*p.cost_price)}</td></tr>`).join('')||insightEmptyRow(3,'check_circle','No dead stock — everything is moving');
    const deadMeta=document.getElementById('deadMeta'); if(deadMeta) deadMeta.textContent=dead.length?`${dead.length} idle · ${money(deadValue)}`:'';

    // Urgent restock — snapshot; show all, with severity
    const restock=allP.filter(p=>p.stock<=p.reorder_level).sort((a,b)=>a.stock-b.stock);
    document.querySelector('#insightRestock tbody').innerHTML=
      restock.map(p=>{const out=p.stock<=0; const cls=out?'row-danger':'row-warn';
        const badge=out?'<span class="badge badge-danger">Out</span>':'<span class="badge badge-warning">Low</span>';
        return `<tr class="${cls}"><td>${esc(p.name)}</td><td>${p.stock}</td><td>${p.reorder_level}</td><td>${badge}</td></tr>`;}).join('')||insightEmptyRow(4,'check_circle','All stock is above its reorder level');
    const restockMeta=document.getElementById('restockMeta'); if(restockMeta) restockMeta.textContent=restock.length?`${restock.length} item${restock.length===1?'':'s'}`:'';

    // Profitability with margin chips (negative margins flagged red)
    document.querySelector('#insightProfitability tbody').innerHTML=
      byProfit.slice(0,count).map(([n,d])=>{const pr=d.revenue-d.cost; const mg=d.revenue>0?(pr/d.revenue*100):0;
        const cls=mg<0?'margin-bad':(mg<10?'margin-mid':'margin-good');
        return `<tr><td>${esc(n)}</td><td>${money(d.revenue)}</td><td>${money(d.cost)}</td><td>${money(pr)}</td><td><span class="margin-chip ${cls}">${mg.toFixed(1)}%</span></td></tr>`;}).join('')||insightEmptyRow(5,'paid','No sales in this period');

    // Peak days — single hue, highlight the best day
    destroyChart('peakDays');
    const dayShort=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayFull=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const daySales=[0,0,0,0,0,0,0];
    sales.forEach(s=>{ daySales[new Date(s.date).getDay()]+=s.total; });
    const maxDay=daySales.indexOf(Math.max(...daySales));
    const peakColors=daySales.map((v,i)=> (i===maxDay && v>0) ? '#ffb77d' : 'rgba(185,199,228,0.35)');
    chartInstances['peakDays']=new Chart(document.getElementById('peakDaysChart'),{
      type:'bar',data:{labels:dayShort,datasets:[{label:'Sales by Day',data:daySales,backgroundColor:peakColors,borderRadius:4}]},
      options:{responsive:true,maintainAspectRatio:false,scales:{y:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},x:{ticks:{color:c.text}}},plugins:{legend:{display:false}}}});

    // Revenue by category — horizontal bar, top 6 + Other
    destroyChart('revenueCategory');
    const pm={}; allP.forEach(p=>pm[p.name]=p.category); const catMap={};
    sales.forEach(s=>(s.items||[]).forEach(i=>{const cat=pm[i.name]||'Other'; catMap[cat]=(catMap[cat]||0)+i.qty*i.unitPrice;}));
    let catEntries=Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
    if(catEntries.length>6){ const top=catEntries.slice(0,6); const other=catEntries.slice(6).reduce((s,e)=>s+e[1],0); top.push(['Other',other]); catEntries=top; }
    chartInstances['revenueCategory']=new Chart(document.getElementById('revenueCategoryChart'),{
      type:'bar',data:{labels:catEntries.map(e=>e[0]),datasets:[{label:'Revenue',data:catEntries.map(e=>e[1]),backgroundColor:DWATREX_PALETTE,borderRadius:4}]},
      options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,scales:{x:{ticks:{color:c.text,callback:v=>'$'+v},grid:{color:c.grid}},y:{ticks:{color:c.text,font:{size:11}}}},plugins:{legend:{display:false}}}});

    // KPI strip
    const setKpi=(id,v)=>{const e=document.getElementById(id); if(e) e.textContent=v;};
    setKpi('kpiReorder', restock.length);
    setKpi('kpiDeadValue', money(deadValue));
    setKpi('kpiDeadCount', `${dead.length} SKU${dead.length===1?'':'s'} idle`);
    if(daySales.some(v=>v>0)){ setKpi('kpiBestDay', dayFull[maxDay]); setKpi('kpiBestDaySub', `${money(daySales[maxDay])} in range`); }
    else { setKpi('kpiBestDay','—'); setKpi('kpiBestDaySub','no sales yet'); }
    if(catEntries.length){ setKpi('kpiTopCat', catEntries[0][0]); setKpi('kpiTopCatSub', `${money(catEntries[0][1])} revenue`); }
    else { setKpi('kpiTopCat','—'); setKpi('kpiTopCatSub','no sales yet'); }

    // Recommendations
    const recs=[];
    restock.slice(0,5).forEach(p=>{recs.push({type:'alert-error',icon:'error',title:`Reorder: ${p.name}`,text:`Stock at ${p.stock} (reorder level: ${p.reorder_level}).`});});
    byQty.slice(0,5).forEach(([n,d])=>{const prod=allP.find(p=>p.name===n); if(prod&&prod.stock<d.qty*2) recs.push({type:'alert-warning',icon:'trending_up',title:`Stock up: ${n}`,text:`Fast mover (${d.qty} sold). Stock (${prod.stock}) may not last.`});});
    dead.slice(0,5).forEach(p=>{recs.push({type:'alert-info',icon:'info',title:`Investigate: ${p.name}`,text:`No sales in period, ${p.stock} units (${money(p.stock*p.cost_price)}). Consider promotion.`});});
    if(!recs.length) recs.push({type:'alert-info',icon:'check_circle',title:'All good!',text:'No urgent recommendations right now.'});
    document.getElementById('insightRecommendations').innerHTML=recs.map(r=>
      `<div class="rec-item ${r.type}"><span class="material-symbols-outlined rec-icon" style="font-size:20px">${r.icon}</span><div class="rec-text"><strong>${esc(r.title)}</strong>${esc(r.text)}</div></div>`).join('');
  } finally {
    if(status){ status.textContent=''; status.classList.remove('busy'); }
  }
}

// ═══════ EXPENSES ════════════════════════════════════════
const EXPENSE_CATEGORIES = ['Rent','Utilities','Salaries','Transport','Supplies','Marketing','Maintenance','Bank Charges','Other'];

async function renderExpenses() {
  const from = document.getElementById('expenseFrom')?.value || fmt(daysAgo(30));
  const to = document.getElementById('expenseTo')?.value || fmt(new Date());
  const res = await api('get_expenses', from, to);
  const rows = res.ok ? res.data : [];
  const total = rows.reduce((s, e) => s + Number(e.amount || 0), 0);
  const tEl = document.getElementById('expTotal'); if (tEl) tEl.textContent = money(total);
  const cEl = document.getElementById('expCount'); if (cEl) cEl.textContent = rows.length;
  document.querySelector('#expensesTable tbody').innerHTML = rows.map(e => `
    <tr><td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.description)}</td>
    <td>${money(e.amount)}</td><td>${esc(e.payment)}</td><td>${esc(e.created_by)}</td>
    <td class="actions">
      <button class="btn btn-sm btn-outline" aria-label="Edit expense" onclick="openExpenseModal(${e.id})"><span class="material-symbols-outlined" style="font-size:14px">edit</span></button>
      <button class="btn btn-sm btn-danger" aria-label="Delete expense" onclick="deleteExpense(${e.id})"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button>
    </td></tr>`).join('') || emptyRow(7, 'account_balance_wallet', 'No expenses recorded in this range');
}

let _expenseCache = [];
async function openExpenseModal(id) {
  let e = null;
  if (id) {
    const r = await api('get_expenses', '', '');
    e = (r.data || []).find(x => x.id === id);
  }
  const catOpts = EXPENSE_CATEGORIES.map(c =>
    `<option value="${c}" ${e && e.category === c ? 'selected' : ''}>${c}</option>`).join('');
  const payOpts = ['Cash','Mobile Money','Card','Bank Transfer'].map(p =>
    `<option ${e && e.payment === p ? 'selected' : ''}>${p}</option>`).join('');
  openModal(e ? 'Edit Expense' : 'Add Expense', `
    <form onsubmit="saveExpense(event,${id || 'null'})">
      <div class="form-row">
        <div class="form-group"><label>Date *</label><input type="date" id="expDate" value="${e ? esc(e.date) : fmt(new Date())}" required></div>
        <div class="form-group"><label>Category *</label><select id="expCategory" required>${catOpts}</select></div>
      </div>
      <div class="form-group"><label>Description</label><input id="expDesc" value="${e ? esc(e.description) : ''}" placeholder="e.g. March electricity bill"></div>
      <div class="form-row">
        <div class="form-group"><label>Amount *</label><input type="number" step="0.01" min="0" id="expAmount" value="${e ? e.amount : ''}" required></div>
        <div class="form-group"><label>Payment</label><select id="expPayment">${payOpts}</select></div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${e ? 'Update' : 'Add'} Expense</button>
    </form>`);
}

async function saveExpense(ev, id) {
  ev.preventDefault();
  const res = await api('save_expense', id,
    document.getElementById('expDate').value,
    document.getElementById('expCategory').value,
    document.getElementById('expDesc').value.trim(),
    document.getElementById('expAmount').value,
    document.getElementById('expPayment').value);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('Expense saved'); renderExpenses();
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  const res = await api('delete_expense', id);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  showToast('Expense deleted'); renderExpenses();
}

// ═══════ USERS ═══════════════════════════════════════════
async function renderUsers() {
  const res=await api('get_users');
  document.querySelector('#usersTable tbody').innerHTML=(res.data||[]).map(u=>
    `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td><span class="role-badge">${esc(u.role)}</span></td>
    <td><span class="badge ${u.status==='Active'?'badge-success':'badge-danger'}">${esc(u.status)}</span></td>
    <td class="actions">
      <button class="btn btn-sm btn-outline" aria-label="Edit user" onclick="openUserModal(${u.id})"><span class="material-symbols-outlined" style="font-size:14px">edit</span></button>
      <button class="btn btn-sm btn-danger" aria-label="Delete user" onclick="deleteUser(${u.id})"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button>
    </td></tr>`).join('')||emptyRow(5,'group','No users yet');
}

async function openUserModal(id) {
  let u = null;
  if (id) {
    const r = await api('get_users');
    u = (r.data||[]).find(x => x.id === id);
  }
  const roles = ['admin','manager','cashier','inventory'];
  const roleOpts = roles.map(r => `<option value="${r}" ${u&&u.role===r?'selected':''}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`).join('');
  const statusOpts = ['Active','Inactive'].map(s => `<option value="${s}" ${u&&u.status===s?'selected':''}>${s}</option>`).join('');
  openModal(u ? 'Edit User' : 'Add User', `
    <form onsubmit="saveUser(event,${id||'null'})">
      <div class="form-group"><label>Full Name *</label><input id="uName" value="${u?esc(u.name):''}" required></div>
      <div class="form-group"><label>Username *</label><input id="uUsername" value="${u?esc(u.username):''}" required></div>
      <div class="form-group"><label>Password ${u?'(leave blank to keep current)':'*'}</label><input type="password" id="uPassword" placeholder="${u?'Leave blank to keep current':'Min 8 characters'}" ${u?'':'required minlength="8"'}></div>
      <div class="form-row">
        <div class="form-group"><label>Role *</label><select id="uRole" required>${roleOpts}</select></div>
        <div class="form-group"><label>Status</label><select id="uStatus">${statusOpts}</select></div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${u?'Update':'Add'} User</button>
    </form>`);
}

async function saveUser(e, id) {
  e.preventDefault();
  const res = await api('save_user', id,
    document.getElementById('uName').value.trim(),
    document.getElementById('uUsername').value.trim(),
    document.getElementById('uPassword').value,
    document.getElementById('uRole').value,
    document.getElementById('uStatus').value);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('User saved'); renderUsers();
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  const res = await api('delete_user', id);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  showToast('User deleted'); renderUsers();
}

// ═══════ CSV IMPORT — CATEGORIES ═════════════════════════
function downloadCategoryTemplate() {
  const csv = 'name\nElectronics\nBeverages\nSnacks\n';
  downloadCSV(csv, 'category_template.csv');
}

function openCategoryUploadModal() {
  openModal('Import Categories', `
    <p style="font-size:0.85rem;color:var(--on-surface-variant);margin-bottom:1rem">Upload a CSV file with a <strong>name</strong> column. One category per row. Duplicates are skipped automatically.</p>
    <div class="upload-area" onclick="document.getElementById('categoryFileInput').click()">
      <span class="material-symbols-outlined">upload_file</span>
      <p>Click to select CSV file</p>
      <p class="upload-hint">Supports .csv files</p>
      <input type="file" id="categoryFileInput" accept=".csv" onchange="handleCategoryFile(this)">
    </div>
    <div id="categoryUploadPreview"></div>
    <span class="template-link" onclick="downloadCategoryTemplate()"><span class="material-symbols-outlined" style="font-size:14px">download</span> Download template</span>`);
}

function handleCategoryFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const rows = _csvCells(e.target.result);
    if (!rows.length) { showToast('No categories found in file', 'error'); return; }
    const first = (rows[0][0] || '').toLowerCase().trim();
    const hasHeader = ['name', 'category', 'categories'].includes(first);
    let col = 0;
    if (hasHeader) { const hdr = rows[0].map(h => h.toLowerCase().trim()); const ix = hdr.indexOf('name'); col = ix >= 0 ? ix : 0; }
    const data = hasHeader ? rows.slice(1) : rows;
    const names = [...new Set(data.map(r => (r[col] || '').trim()).filter(Boolean))];
    if (!names.length) { showToast('No categories found in file', 'error'); return; }
    document.getElementById('categoryUploadPreview').innerHTML = `
      <p style="font-size:0.8rem;margin:1rem 0 0.5rem">Found <strong>${names.length}</strong> categories:</p>
      <div style="max-height:150px;overflow-y:auto;background:var(--surface-container-lowest);padding:0.75rem;border-radius:var(--radius);font-size:0.8rem;margin-bottom:1rem">
        ${names.map(n => `<div>${esc(n)}</div>`).join('')}
      </div>
      <button class="btn btn-primary btn-block" onclick="importCategories(${JSON.stringify(names).replace(/"/g,'&quot;')})">
        <span class="material-symbols-outlined">upload</span> Import ${names.length} Categories
      </button>`;
  };
  reader.readAsText(file);
}

async function importCategories(names) {
  const res = await api('bulk_import_categories', JSON.stringify(names));
  if (res.ok) {
    closeModal();
    showToast(res.msg);
    renderCategories();
    populateFilters();
  } else {
    showToast(res.msg, 'error');
  }
}

// ═══════ CSV IMPORT — PRODUCTS ══════════════════════════
function downloadProductTemplate() {
  const csv = 'sku,name,category,supplier,cost_price,selling_price,stock,reorder_level,expiry\nSKU001,Sample Product,Electronics,,10.00,15.00,100,10,\nSKU002,Another Item,Beverages,,5.00,8.50,50,15,2026-12-31\n';
  downloadCSV(csv, 'product_template.csv');
}

function openProductUploadModal() {
  openModal('Import Products', `
    <p style="font-size:0.85rem;color:var(--on-surface-variant);margin-bottom:1rem">Upload a CSV file with product data. Required columns: <strong>sku</strong>, <strong>name</strong>. Optional: category, supplier, cost_price, selling_price, stock, reorder_level, expiry. Duplicate SKUs are skipped.</p>
    <div class="upload-area" onclick="document.getElementById('productFileInput').click()">
      <span class="material-symbols-outlined">upload_file</span>
      <p>Click to select CSV file</p>
      <p class="upload-hint">Supports .csv files</p>
      <input type="file" id="productFileInput" accept=".csv" onchange="handleProductFile(this)">
    </div>
    <div id="productUploadPreview"></div>
    <span class="template-link" onclick="downloadProductTemplate()"><span class="material-symbols-outlined" style="font-size:14px">download</span> Download template</span>`);
}

// Robust CSV cell parser: strips a BOM, auto-detects the delimiter
// (comma / semicolon / tab), and handles quoted fields that contain commas,
// escaped quotes ("") and embedded newlines, plus CR / CRLF / LF line endings.
function _csvCells(text) {
  text = String(text).replace(/^﻿/, '');
  // Detect delimiter from the first physical line (ignoring quoted sections).
  let firstEnd = text.length, q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) { firstEnd = i; break; }
  }
  const head = text.slice(0, firstEnd);
  const count = ch => (head.split(ch).length - 1);
  let delim = ',';
  if (count(';') > count(',') && count(';') >= count('\t')) delim = ';';
  else if (count('\t') > count(',')) delim = '\t';

  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') { inQ = true; }
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

function parseCSV(text) {
  const rows = _csvCells(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] != null ? String(r[i]) : '').trim(); });
    return obj;
  }).filter(obj => obj.sku || obj.name);
}

function handleProductFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const products = parseCSV(e.target.result);
    if (!products.length) { showToast('No products found in file', 'error'); return; }
    window._pendingProductImport = products;
    document.getElementById('productUploadPreview').innerHTML = `
      <p style="font-size:0.8rem;margin:1rem 0 0.5rem">Found <strong>${products.length}</strong> products:</p>
      <div style="max-height:200px;overflow-y:auto;background:var(--surface-container-lowest);padding:0.75rem;border-radius:var(--radius);font-size:0.75rem;margin-bottom:1rem">
        <table style="width:100%"><thead><tr><th style="text-align:left;padding:0.25rem">SKU</th><th style="text-align:left;padding:0.25rem">Name</th><th style="text-align:left;padding:0.25rem">Category</th><th style="text-align:right;padding:0.25rem">Price</th><th style="text-align:right;padding:0.25rem">Stock</th></tr></thead>
        <tbody>${products.slice(0, 20).map(p => `<tr><td style="padding:0.25rem">${p.sku||''}</td><td style="padding:0.25rem">${p.name||''}</td><td style="padding:0.25rem">${p.category||''}</td><td style="text-align:right;padding:0.25rem">${p.selling_price||''}</td><td style="text-align:right;padding:0.25rem">${p.stock||''}</td></tr>`).join('')}
        ${products.length > 20 ? `<tr><td colspan="5" style="padding:0.25rem;color:var(--outline)">...and ${products.length - 20} more</td></tr>` : ''}
        </tbody></table>
      </div>
      <button class="btn btn-primary btn-block" onclick="importProducts()">
        <span class="material-symbols-outlined">upload</span> Import ${products.length} Products
      </button>`;
  };
  reader.readAsText(file);
}

async function importProducts() {
  const products = window._pendingProductImport;
  if (!products || !products.length) return;
  const res = await api('bulk_import_products', JSON.stringify(products));
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal();
  const d = res.data || {};
  // Tell the user exactly what happened, including why rows didn't import.
  showToast(res.msg, d.added ? 'success' : 'error');
  renderProducts();
  populateFilters();
  if (d.errors && d.errors.length) {
    setTimeout(() => showToast(`First issue: ${d.errors[0]}`, 'error'), 1600);
  }
}

async function downloadCSV(content, filename) {
  // In the desktop app, save through the native dialog (blob downloads don't
  // work inside the webview). Fall back to a blob download in a plain browser.
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save_text_file) {
    const res = await api('save_text_file', filename, content);
    if (res.ok) { if (!(res.data && res.data.cancelled)) showToast('File saved'); }
    else showToast(res.msg || 'Could not save file', 'error');
    return;
  }
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ═══════ SETTINGS ════════════════════════════════════════
async function loadSettings() {
  const res = await api('get_settings');
  const d = (res.ok && res.data) ? res.data : {};
  const setVal = (id, v) => { const el=document.getElementById(id); if(el && v!=null && v!=='') el.value=v; };
  setVal('settingStoreName', d.storeName);
  setVal('settingStoreAddress', d.storeAddress);
  setVal('settingStorePhone', d.storePhone);
  setVal('settingStoreEmail', d.storeEmail);
  setVal('settingCurrency', d.currency);
  setVal('settingTaxRate', d.taxRate);
  setVal('settingLowStock', d.lowStockThreshold);
  setVal('settingFastMoving', d.fastMovingThreshold);
  setVal('settingSlowMoving', d.slowMovingThreshold);
  logoDataUrl = d.storeLogo || '';
  showLogoPreview(logoDataUrl);
}

async function saveSettings() {
  const s={
    storeName:document.getElementById('settingStoreName').value,
    storeAddress:document.getElementById('settingStoreAddress').value,
    storePhone:document.getElementById('settingStorePhone').value,
    storeEmail:document.getElementById('settingStoreEmail').value,
    storeLogo:logoDataUrl,
    currency:document.getElementById('settingCurrency').value.trim()||'GH₵',
    taxRate:document.getElementById('settingTaxRate').value, lowStockThreshold:document.getElementById('settingLowStock').value,
    fastMovingThreshold:document.getElementById('settingFastMoving').value, slowMovingThreshold:document.getElementById('settingSlowMoving').value};
  const res = await api('save_settings',JSON.stringify(s));
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  currencySymbol = s.currency;          // take effect immediately, app-wide
  const taxEl = document.getElementById('cartTax'); if (taxEl) taxEl.value = s.taxRate;
  storeInfo = { name:s.storeName, address:s.storeAddress, phone:s.storePhone, email:s.storeEmail, logo:s.storeLogo };
  showToast('Settings saved');
}

// ── Logo upload (optional; stored as a data URL in settings) ──
function handleLogoUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) { showToast('Logo too large (max 1 MB)', 'error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    const url = e.target.result;
    if (typeof url !== 'string' || !url.startsWith('data:image/')) { showToast('Please choose an image file', 'error'); return; }
    logoDataUrl = url;
    showLogoPreview(url);
  };
  reader.readAsDataURL(file);
  input.value = '';
}
function removeLogo() { logoDataUrl=''; showLogoPreview(''); }
function showLogoPreview(url) {
  const img = document.getElementById('settingLogoPreview');
  const rm = document.getElementById('settingLogoRemove');
  if (!img) return;
  if (url && url.startsWith('data:image/')) {
    img.src = url; img.classList.remove('hidden');
    if (rm) rm.classList.remove('hidden');
  } else {
    img.removeAttribute('src'); img.classList.add('hidden');
    if (rm) rm.classList.add('hidden');
  }
}
