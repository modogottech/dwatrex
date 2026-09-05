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
let belowCostPinSet = false;   // true when an admin has configured an approval PIN
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
  admin:['dashboard','products','categories','suppliers','sales','purchases','inventory','returns','quotes','credit','audit','reports','insights','expenses','users','settings','profits'],
  manager:['dashboard','products','categories','suppliers','sales','purchases','inventory','returns','quotes','credit','reports'],
  cashier:['dashboard','sales','returns','quotes','credit'],
  inventory:['dashboard','products','categories','suppliers','purchases','inventory'],
};
// Show a fade at the foot of the menu when there is more to scroll to, so a
// clipped list never looks like the whole list.
function updateNavScrollHint() {
  const nav = document.querySelector('.sidebar-nav');
  const wrap = document.querySelector('.sidebar-nav-wrap');
  if (!nav || !wrap) return;
  const more = nav.scrollHeight - nav.clientHeight - nav.scrollTop > 4;
  wrap.classList.toggle('can-scroll', more);
}
window.addEventListener('resize', updateNavScrollHint);
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.sidebar-nav')?.addEventListener('scroll', updateNavScrollHint);
  updateNavScrollHint();
});

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
  quotes:'Quotes & Estimates', credit:'Credit & Receivables', audit:'Activity Log',
  reports:'Capital Analytics', insights:'Intelligence Center',
  expenses:'Expenses', users:'User Management', settings:'System Settings'
};

// Map pages to topbar tabs
const PAGE_TAB_MAP = {
  dashboard:'dashboard', products:'inventory', categories:'inventory',
  suppliers:'inventory', sales:'sales', purchases:'inventory',
  inventory:'inventory', returns:'sales', quotes:'sales', credit:'sales', audit:'dashboard', reports:'reports',
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
    belowCostPinSet = !!d.below_cost_pin_set;
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
    case 'sales': await renderPOSProducts(); renderCart(); await renderSalesHistory();
                  initPosShortcuts(); refreshHeldCount(); break;
    case 'purchases': await renderPurchases(); break;
    case 'inventory': await renderInventory(); break;
    case 'returns': await renderReturns(); break;
    case 'quotes': await renderQuotes(); break;
    case 'credit': await renderCredit(); break;
    case 'audit': await renderAudit(); break;
    case 'reports': await generateReport(); break;
    case 'insights': await renderInsights(); break;
    case 'expenses': await renderExpenses(); await api('post_due_recurring_expenses'); break;
    case 'users': await renderUsers(); break;
    case 'settings': await loadSettings(); loadBackupInfo(); loadTaxComponents(); break;
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
  const wf = document.getElementById('metricWeekFrom');
  if (wf) wf.textContent = d.weekStartLabel ? `since ${d.weekStartLabel}` : '';
  const mf = document.getElementById('metricMonthFrom');
  if (mf) mf.textContent = d.monthStartLabel || '';
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
// Real pagination replaces the old "first 100 only" cap, which silently hid
// products past #100 unless you happened to search for them.
let productPage = 0;
const PRODUCT_PAGE_SIZE = 50;

function gotoProductPage(p) { productPage = Math.max(0, p); renderProducts(true); }

async function renderProducts(keepPage) {
  if (!keepPage) productPage = 0;          // any filter change returns to page 1
  const s = document.getElementById('productSearch')?.value||'';
  const cat = document.getElementById('productCategoryFilter')?.value||'';
  const st = document.getElementById('productStatusFilter')?.value||'';
  const res = await api('get_products', s, cat, st,
                        PRODUCT_PAGE_SIZE, productPage * PRODUCT_PAGE_SIZE);
  if(!res.ok) return;
  const list = res.data.products || [];
  const total = res.data.total || 0;
  cachedProducts = list;
  const rows = list.map(p=>`
    <tr><td>${esc(p.sku)}</td><td>${esc(p.name)}${p.unit&&p.unit!=='each'?`<span class="per-unit"> /${esc(p.unit)}</span>`:''}</td><td>${esc(p.category)}</td><td>${money(p.cost_price)}</td><td>${money(p.selling_price)}</td>
    <td>${p.stock}</td><td>${p.reorder_level}</td>
    <td><span class="badge ${p.status==='In Stock'?'badge-success':p.status==='Low Stock'?'badge-warning':'badge-danger'}">${esc(p.status)}</span></td>
    <td class="actions"><button class="btn btn-sm btn-outline" aria-label="Edit product" onclick="openProductModal(${p.id})"><span class="material-symbols-outlined" style="font-size:14px">edit</span></button>
    <button class="btn btn-sm btn-outline" aria-label="Adjust stock" title="Adjust stock" onclick="openAdjustModal(${p.id})"><span class="material-symbols-outlined" style="font-size:14px">tune</span></button>
    <button class="btn btn-sm btn-danger" aria-label="Delete product" onclick="deleteProduct(${p.id})"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button></td></tr>
  `).join('');
  document.querySelector('#productsTable tbody').innerHTML = rows || emptyRow(9,'inventory_2','No products found');
  renderProductPager(total);
}

function renderProductPager(total) {
  const pages = Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE));
  const el = document.getElementById('productPager');
  if (!el) return;
  if (total <= PRODUCT_PAGE_SIZE) { el.innerHTML = ''; return; }
  const from = productPage * PRODUCT_PAGE_SIZE + 1;
  const to = Math.min(total, (productPage + 1) * PRODUCT_PAGE_SIZE);
  el.innerHTML = `
    <span class="pager-info">Showing ${from}–${to} of ${total}</span>
    <button class="btn btn-sm btn-outline" ${productPage===0?'disabled':''} onclick="gotoProductPage(${productPage-1})">Previous</button>
    <span class="pager-info">Page ${productPage+1} of ${pages}</span>
    <button class="btn btn-sm btn-outline" ${productPage>=pages-1?'disabled':''} onclick="gotoProductPage(${productPage+1})">Next</button>`;
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
      <div class="form-row"><div class="form-group"><label>Cost Price *</label><input type="number" step="0.01" id="pCost" value="${p?p.cost_price:''}" required min="0" oninput="updateMarginPreview()"></div>
      <div class="form-group"><label>Selling Price *</label><input type="number" step="0.01" id="pPrice" value="${p?p.selling_price:''}" required min="0" oninput="updateMarginPreview()"></div></div>
      <div class="form-row"><div class="form-group"><label>Stock Qty *</label><input type="number" step="0.01" id="pStock" value="${p?p.stock:'0'}" required min="0"></div>
      <div class="form-group"><label>Reorder Level</label><input type="number" id="pReorder" value="${p?p.reorder_level:'10'}" min="0"></div></div>
      <div class="form-row">
        <div class="form-group"><label>Sold By (unit)</label>
          <select id="pUnit">${UNIT_LIST.map(u=>`<option value="${u}" ${((p&&p.unit)||'each')===u?'selected':''}>${u}</option>`).join('')}</select>
          <p style="font-size:0.7rem;color:var(--on-surface-variant);margin-top:0.25rem">Cost and price must both be per this unit.</p></div>
        <div class="form-group"><label>Barcode</label>
          <input type="text" id="pBarcode" value="${p&&p.barcode?esc(p.barcode):''}" placeholder="Scan or type" autocomplete="off"></div>
      </div>
      <div class="form-group"><label>Expiry Date</label><input type="date" id="pExpiry" value="${p&&p.expiry?p.expiry:''}"></div>
      <div id="pMargin" style="font-size:0.78rem;margin-bottom:0.75rem"></div>
      <button type="submit" class="btn btn-primary btn-block">${p?'Update':'Add'} Product</button>
    </form>`);
  updateMarginPreview();
}

async function saveProduct(e, id) {
  e.preventDefault();
  const res = await api('save_product', id,
    document.getElementById('pSku').value.trim(), document.getElementById('pName').value.trim(),
    document.getElementById('pCategory').value, document.getElementById('pSupplier').value,
    document.getElementById('pCost').value, document.getElementById('pPrice').value,
    document.getElementById('pStock').value, document.getElementById('pReorder').value||'10',
    document.getElementById('pExpiry').value,
    document.getElementById('pUnit')?.value||'each',
    document.getElementById('pBarcode')?.value||'');
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('Product saved'); renderProducts();
}

// Live margin preview — catches a blank or wrong price at entry, which is what
// produced the "why is my profit negative" surprise.
function updateMarginPreview() {
  const c = parseFloat(document.getElementById('pCost')?.value||0) || 0;
  const s = parseFloat(document.getElementById('pPrice')?.value||0) || 0;
  const el = document.getElementById('pMargin');
  if (!el) return;
  if (!s) { el.innerHTML = '<span style="color:#ff6b6b">No selling price — this item would sell for nothing.</span>'; return; }
  if (!c) { el.innerHTML = '<span style="color:var(--outline)">No cost price — margin can\'t be calculated.</span>'; return; }
  const m = ((s-c)/s)*100;
  const col = m < 0 ? '#ff6b6b' : m < 10 ? '#ffb77d' : '#34d399';
  el.innerHTML = `<span style="color:${col};font-weight:700">Margin: ${m.toFixed(1)}% `
               + `(${money(s-c)} per unit)</span>`
               + (m < 0 ? ' — you would lose money on every sale' : '');
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
// A dense searchable list, not a card grid: with ~200 SKUs whose names differ
// by a single number (XBZ 6W / 10W / 15W), aligned columns are far easier to
// tell apart than tiles, and roughly twice as many fit on screen.
async function renderPOSProducts() {
  const s=document.getElementById('posSearch')?.value||'';
  const cat=document.getElementById('posCategoryFilter')?.value||'';
  const res=await api('get_products',s,cat,'');
  // Out-of-stock items stay visible (greyed out) so the cashier can see the
  // product exists and tell the customer, rather than it silently vanishing.
  const prods=(res.data||[]).slice().sort((a,b)=>(b.stock>0)-(a.stock>0)||a.name.localeCompare(b.name));
  posProducts = prods;  // cache for safe lookup by id (avoids interpolating names into onclick)
  const grid = document.getElementById('posProductGrid');
  grid.innerHTML = prods.map(p=>{
    const out = !(p.stock > 0);
    const unit = p.unit && p.unit !== 'each' ? `<span class="per-unit">/${esc(p.unit)}</span>` : '';
    return `<div class="pos-row${out?' out-of-stock':''}" ${out?'aria-disabled="true"':`onclick="addToCart(${p.id})" tabindex="0" onkeydown="if(event.key==='Enter'){addToCart(${p.id})}"`}>
      <div class="pos-row-main">
        <span class="pos-row-name">${esc(p.name)}</span>
        <span class="pos-row-sku">${esc(p.sku||'')}</span>
      </div>
      <span class="pos-row-stock">${out?'Out of stock':`${p.stock}${p.unit&&p.unit!=='each'?' '+esc(p.unit):''}`}</span>
      <span class="pos-row-price">${money(p.selling_price)}${unit}</span>
    </div>`;
  }).join('') || '<p style="padding:2rem;color:var(--outline);text-align:center">No products found</p>';
  const n = document.getElementById('posCount');
  if (n) {
    const sellable = prods.filter(p=>p.stock>0).length;
    n.textContent = prods.length
      ? `${prods.length} product${prods.length===1?'':'s'} · ${sellable} in stock`
      : '';
  }
}

function addToCart(id) {
  const p = posProducts.find(x=>x.id===id);
  if(!p){ showToast('Product unavailable','error'); return; }
  if(!(p.stock > 0)){ showToast(`${p.name} is out of stock`,'error'); return; }
  const ex=cart.find(c=>c.productId===id);
  if(ex){ if(ex.qty>=p.stock){showToast('Not enough stock','error');return;} ex.qty++; }
  else cart.push({productId:id,name:p.name,unitPrice:p.selling_price,originalPrice:p.selling_price,costPrice:p.cost_price,qty:1,unit:p.unit||'each',maxStock:p.stock});
  renderCart();
}
function renderCart() {
  const c=document.getElementById('cartItems');
  if(!cart.length) { c.innerHTML='<p style="text-align:center;color:var(--outline);padding:2rem">Cart is empty</p>'; }
  else { c.innerHTML=cart.map((it,i)=>{
    const priceChanged = it.unitPrice !== it.originalPrice;
    const belowCost = it.costPrice != null && it.unitPrice < it.costPrice;
    const zeroPrice = it.unitPrice <= 0;
    const warn = belowCost || zeroPrice;
    const warnTitle = zeroPrice ? 'This item is priced at 0 — no revenue'
                    : belowCost ? `Below cost (${money(it.costPrice)}) — this line makes a loss` : 'Edit price';
    return `<div class="cart-item"><span class="item-name">${esc(it.name)}</span>
    <input type="number" class="item-qty" value="${it.qty}" min="0.01" step="${WHOLE_UNITS.includes(it.unit||'each')?1:0.01}" max="${it.maxStock}" onchange="updateCartQty(${i},this.value)" title="${esc(it.unit||'each')}">${(it.unit&&it.unit!=='each')?`<span class="item-unit">${esc(it.unit)}</span>`:''}
    <input type="number" step="0.01" class="item-price${warn?' price-warn':''}" value="${it.unitPrice.toFixed(2)}" min="0" onchange="updateCartPrice(${i},this.value)" title="${warnTitle}">
    ${priceChanged ? `<span class="item-original-price">${money(it.originalPrice)}</span>` : ''}
    <span class="item-total">${money(it.qty*it.unitPrice)}</span>
    <button class="item-remove" onclick="removeFromCart(${i})"><span class="material-symbols-outlined" style="font-size:16px">close</span></button>
    ${warn?`<span class="item-loss-flag" title="${warnTitle}"><span class="material-symbols-outlined" style="font-size:13px">warning</span>${zeroPrice?'Zero price':'Below cost'}</span>`:''}</div>`;
  }).join(''); }
  // Show the approval-PIN field only when a below-cost line is present AND a PIN is configured.
  const hasBelowCost = cart.some(it => it.unitPrice <= 0 || (it.costPrice != null && it.unitPrice < it.costPrice));
  const pinRow = document.getElementById('belowCostPinRow');
  if (pinRow) pinRow.classList.toggle('hidden', !(hasBelowCost && belowCostPinSet));
  updateCartTotals();
}
function updateCartQty(i,v){
  const whole = WHOLE_UNITS.includes(cart[i].unit||'each');
  let q = whole ? parseInt(v) : parseFloat(v);
  if (!isNaN(q) && q>0 && q<=cart[i].maxStock) cart[i].qty = whole ? q : Math.round(q*100)/100;
  renderCart();
}
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
  renderQuickTender();
  updateChangeDue();
}

async function completeSale() {
  if(!cart.length){ showToast('Cart is empty','error'); return; }
  // Any line priced at 0 or below its cost is a loss-making sale.
  const problems = cart.filter(c => c.unitPrice <= 0 || (c.costPrice != null && c.unitPrice < c.costPrice));
  let approvalPin = "";
  if (problems.length) {
    const lines = problems.map(c => `• ${c.name}: selling ${money(c.unitPrice)} vs cost ${money(c.costPrice)}`).join('\n');
    if (belowCostPinSet) {
      // Approval PIN configured — the cashier must enter it in the cart field.
      approvalPin = (document.getElementById('belowCostPinInput')?.value || '').trim();
      if (!approvalPin) {
        showToast('Manager approval PIN required for below-cost items', 'error');
        const el = document.getElementById('belowCostPinInput'); if (el) el.focus();
        return;
      }
    } else {
      // No PIN set — just confirm the loss.
      if (!confirm(`${problems.length} item(s) are priced at or below cost — this sale will lose money:\n\n${lines}\n\nComplete the sale anyway?`)) return;
    }
  }
  const disc=parseFloat(document.getElementById('cartDiscount').value||0);
  const tax=parseFloat(document.getElementById('cartTax').value||0);
  const payment=document.getElementById('paymentMethod').value;
  // Credit sale: customer name is required; deposit is what they pay today.
  let custName='', custPhone='', deposit=0;
  if (payment === 'Credit') {
    custName = (document.getElementById('creditCustomerName')?.value||'').trim();
    custPhone = (document.getElementById('creditCustomerPhone')?.value||'').trim();
    deposit = parseFloat(document.getElementById('creditDeposit')?.value||0) || 0;
    if (!custName) {
      showToast('Enter the customer name for a credit sale','error');
      document.getElementById('creditCustomerName')?.focus();
      return;
    }
  }
  const tendered = parseFloat(document.getElementById('cashTendered')?.value||0) || 0;
  const items=cart.map(c=>({productId:c.productId,name:c.name,qty:c.qty,unitPrice:c.unitPrice,costPrice:c.costPrice}));
  const res=await api('complete_sale',JSON.stringify(items),disc,tax,payment,approvalPin,custName,custPhone,deposit,tendered,splitLegs?JSON.stringify(splitLegs):'');
  if(!res.ok){ showToast(res.msg,'error'); return; }
  const pinEl = document.getElementById('belowCostPinInput'); if (pinEl) pinEl.value = '';
  showReceipt(res.data);
  // Change due is the number the cashier needs after the drawer opens — keep it
  // on screen rather than only on the receipt.
  if (res.data.change_due > 0) showToast(`Change due: ${money(res.data.change_due)}`);
  cart=[]; renderCart(); renderPOSProducts(); renderSalesHistory();
  resetCreditFields(); resetTenderFields(); splitLegs=null;
  const bal = res.data.balance || 0;
  showToast(bal > 0 ? `Sale #${res.data.id} on credit — ${money(bal)} owed` : 'Sale completed! #'+res.data.id);
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
    ${(sale.taxComponents&&sale.taxComponents.length>1)
      ? sale.taxComponents.map(t=>`<div class="receipt-line"><span>${esc(t.name)} (${t.rate}%)</span><span>${money(t.amount)}</span></div>`).join('')
      : `<div class="receipt-line"><span>Tax (${sale.tax}%)</span><span>${money(sale.tax_amt)}</span></div>`}
    <div class="receipt-divider"></div>
    <div class="receipt-line receipt-total"><span>TOTAL</span><span>${money(sale.total)}</span></div>
    <div class="receipt-line"><span>Payment</span><span>${esc(sale.payment)}</span></div>
    ${(sale.payments&&sale.payments.length>1)?sale.payments.map(p=>`<div class="receipt-line"><span>&nbsp;&nbsp;${esc(p.method)}</span><span>${money(p.amount)}</span></div>`).join(''):''}
    ${sale.tendered?`<div class="receipt-line"><span>Tendered</span><span>${money(sale.tendered)}</span></div>`:''}
    ${sale.change_due?`<div class="receipt-line"><span>Change</span><span>${money(sale.change_due)}</span></div>`:''}
    ${sale.customer_name?`<div class="receipt-line"><span>Customer</span><span>${esc(sale.customer_name)}${sale.customer_phone?' · '+esc(sale.customer_phone):''}</span></div>`:''}
    ${(sale.balance||0)>0?`<div class="receipt-divider"></div>
      <div class="receipt-line"><span>Paid</span><span>${money(sale.amount_paid||0)}</span></div>
      <div class="receipt-line receipt-total"><span>BALANCE DUE</span><span>${money(sale.balance)}</span></div>`:''}
    <div class="receipt-footer">Powering Your Store Capital</div>`;
  document.getElementById('receiptModal').classList.remove('hidden');
}

const UNIT_LIST = ['each','yard','metre','foot','kg','gram','litre','box','roll','pack'];
const WHOLE_UNITS = ['each','box','pack'];

// ═══════ QUOTES / PRICE ESTIMATES ════════════════════════
let editingQuoteId = null;

function openQuoteModal() {
  if (!cart.length) { showToast('Add items to the cart first','error'); return; }
  const total = cartDue();
  openModal(editingQuoteId ? `Update Quote #${editingQuoteId}` : 'Save as Quote', `
    <form onsubmit="saveQuote(event)">
      <p style="font-size:0.8rem;color:var(--on-surface-variant);margin-bottom:1rem">
        A quote is a price estimate only — <strong>no stock is used and nothing is recorded as a sale</strong>
        until you convert it.
      </p>
      <div class="form-row">
        <div class="form-group"><label>Customer Name *</label>
          <input type="text" id="qCustomer" placeholder="Who is this quote for?" required></div>
        <div class="form-group"><label>Phone</label>
          <input type="text" id="qPhone" placeholder="e.g. 024 000 0000"></div>
      </div>
      <div class="form-group"><label>Notes</label>
        <input type="text" id="qNotes" placeholder="e.g. wiring for 3-bedroom house"></div>
      <p style="font-size:0.85rem;margin:0.75rem 0"><strong>${cart.length}</strong> item(s) ·
        Total <strong>${money(total)}</strong></p>
      <button type="submit" class="btn btn-primary btn-block">Save Quote</button>
    </form>`);
}

async function saveQuote(e) {
  e.preventDefault();
  const items = cart.map(c=>({productId:c.productId,name:c.name,qty:c.qty,
                              unitPrice:c.unitPrice,costPrice:c.costPrice,unit:c.unit||'each'}));
  const disc = parseFloat(document.getElementById('cartDiscount')?.value||0);
  const tax  = parseFloat(document.getElementById('cartTax')?.value||0);
  const res = await api('save_quote', JSON.stringify(items), disc, tax,
                        document.getElementById('qCustomer').value,
                        document.getElementById('qPhone').value,
                        document.getElementById('qNotes').value,
                        editingQuoteId);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  closeModal(); showToast(res.msg);
  editingQuoteId = null;
  cart=[]; renderCart(); renderPOSProducts();
}

async function renderQuotes() {
  const status = document.getElementById('quoteStatusFilter')?.value ?? 'Open';
  const res = await api('get_quotes', status);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  const { quotes, openValue } = res.data;
  document.getElementById('quotesOpenValue').textContent = money(openValue);
  document.getElementById('quotesOpenCount').textContent =
    quotes.filter(q=>q.status==='Open').length;
  document.querySelector('#quotesTable tbody').innerHTML = quotes.map(q=>{
    const badge = q.status==='Open' ? 'badge-warning'
                : q.status==='Converted' ? 'badge-success' : 'badge-danger';
    return `<tr>
      <td>#${q.id}</td>
      <td>${fmtDate(q.date)}</td>
      <td>${esc(q.customer_name||'—')}${q.notes?`<div style="font-size:0.7rem;color:var(--on-surface-variant)">${esc(q.notes)}</div>`:''}</td>
      <td>${q.customer_phone?`<a href="tel:${esc(q.customer_phone)}">${esc(q.customer_phone)}</a>`:'—'}</td>
      <td>${(q.items||[]).length}</td>
      <td><strong>${money(q.total)}</strong></td>
      <td><span class="badge ${badge}">${esc(q.status)}</span>${q.sale_id?` <span style="font-size:0.7rem">→ sale #${q.sale_id}</span>`:''}</td>
      <td class="actions">
        <button class="btn btn-sm btn-outline" aria-label="Print quote ${q.id}" onclick="printQuote(${q.id})"><span class="material-symbols-outlined" style="font-size:14px">print</span></button>
        ${q.status==='Open'?`
          <button class="btn btn-sm btn-primary" aria-label="Convert quote ${q.id}" onclick="convertQuote(${q.id})"><span class="material-symbols-outlined" style="font-size:14px">point_of_sale</span> Convert</button>
          <button class="btn btn-sm btn-outline" aria-label="Cancel quote ${q.id}" onclick="cancelQuote(${q.id})"><span class="material-symbols-outlined" style="font-size:14px">close</span></button>`:''}
      </td></tr>`;
  }).join('') || emptyRow(8,'request_quote','No quotes here yet');
  window._quotes = quotes;
}

async function cancelQuote(id) {
  if (!confirm(`Cancel quote #${id}?`)) return;
  const res = await api('cancel_quote', id);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  showToast(res.msg); renderQuotes();
}

async function convertQuote(id) {
  const q = (window._quotes||[]).find(x=>x.id===id);
  openModal(`Convert Quote #${id} to a Sale`, `
    <form onsubmit="doConvertQuote(event, ${id})">
      <p style="font-size:0.85rem;margin-bottom:1rem">
        ${q?`<strong>${esc(q.customer_name||'')}</strong> · ${money(q.total)}<br>`:''}
        This will record the sale and <strong>deduct the items from stock now</strong>.
      </p>
      <div class="form-group"><label>Payment Method</label>
        <select id="cvPayment"><option>Cash</option><option>Mobile Money</option><option>Card</option><option>Bank Transfer</option><option>Credit</option></select></div>
      <div class="form-group"><label>Manager PIN</label>
        <input type="password" id="cvPin" placeholder="Only if selling below cost" autocomplete="off"></div>
      <button type="submit" class="btn btn-primary btn-block">Convert to Sale</button>
    </form>`);
}

async function doConvertQuote(e, id) {
  e.preventDefault();
  const res = await api('convert_quote', id,
                        document.getElementById('cvPayment').value,
                        document.getElementById('cvPin').value, null, null);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  closeModal(); showToast(res.msg);
  showReceipt(res.data);
  renderQuotes();
}

function printQuote(id) {
  const q = (window._quotes||[]).find(x=>x.id===id);
  if (!q) { showToast('Quote not found','error'); return; }
  const si = storeInfo;
  const logoOk = si.logo && si.logo.startsWith('data:image/');
  document.getElementById('receiptContent').innerHTML = `
    <div class="receipt-header">
      ${logoOk?`<img src="${si.logo}" class="receipt-logo" alt="">`:''}
      <strong>${esc(si.name||'DWATREX')}</strong>
      ${si.address?`<div class="receipt-shop-line">${esc(si.address)}</div>`:''}
      ${si.phone?`<div class="receipt-shop-line">Tel: ${esc(si.phone)}</div>`:''}
      <div class="receipt-shop-line" style="margin-top:6px;font-weight:700">QUOTATION #${q.id}</div>
      <div class="receipt-shop-line">${fmtDate(q.date)}</div>
      <div class="receipt-shop-line">For: ${esc(q.customer_name||'')}</div>
    </div>
    ${(q.items||[]).map(i=>`<div class="receipt-line"><span>${esc(i.name)} x${i.qty}${i.unit&&i.unit!=='each'?' '+esc(i.unit):''}</span><span>${money(i.qty*i.unitPrice)}</span></div>`).join('')}
    <div class="receipt-divider"></div>
    <div class="receipt-line"><span>Subtotal</span><span>${money(q.subtotal)}</span></div>
    ${q.discount>0?`<div class="receipt-line"><span>Discount (${q.discount}%)</span><span>-${money(q.discount_amt)}</span></div>`:''}
    ${q.tax>0?`<div class="receipt-line"><span>Tax (${q.tax}%)</span><span>${money(q.tax_amt)}</span></div>`:''}
    <div class="receipt-divider"></div>
    <div class="receipt-line receipt-total"><span>TOTAL</span><span>${money(q.total)}</span></div>
    ${q.notes?`<div class="receipt-shop-line" style="margin-top:8px">${esc(q.notes)}</div>`:''}
    <div class="receipt-footer">This is a quotation, not a receipt. Prices subject to availability.</div>`;
  document.getElementById('receiptModal').classList.remove('hidden');
}

// ═══════ HELD (PARKED) SALES ═════════════════════════════
async function holdCurrentSale() {
  if (!cart.length) { showToast('Cart is empty','error'); return; }
  const label = cart[0].name + (cart.length>1?` +${cart.length-1} more`:'');
  const items = cart.map(c=>({productId:c.productId,name:c.name,qty:c.qty,
                              unitPrice:c.unitPrice,costPrice:c.costPrice,unit:c.unit||'each'}));
  const res = await api('hold_sale', JSON.stringify(items),
                        document.getElementById('cartDiscount')?.value||0,
                        document.getElementById('cartTax')?.value||0, label);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  showToast('Sale held — till is free');
  cart=[]; renderCart(); refreshHeldCount();
}

async function refreshHeldCount() {
  const res = await api('get_held_sales');
  const n = res.ok ? res.data.length : 0;
  const b = document.getElementById('heldCount');
  if (b) { b.textContent = n; b.classList.toggle('hidden', n===0); }
}

async function openHeldSales() {
  const res = await api('get_held_sales');
  const rows = res.ok ? res.data : [];
  openModal('Held Sales', rows.length ? `
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Held</th><th>Items</th><th>Description</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(h=>`<tr>
        <td>${fmtDate(h.date)}</td><td>${(h.items||[]).length}</td><td>${esc(h.label||'')}</td>
        <td class="actions">
          <button class="btn btn-sm btn-primary" onclick="resumeHeld(${h.id})">Resume</button>
          <button class="btn btn-sm btn-outline" onclick="discardHeld(${h.id})"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button>
        </td></tr>`).join('')}</tbody>
    </table></div>`
    : `<div class="empty-state"><span class="material-symbols-outlined">pause_circle</span><span class="empty-msg">No held sales</span></div>`);
}

async function resumeHeld(id) {
  if (cart.length && !confirm('Resuming will replace the current cart. Continue?')) return;
  const res = await api('resume_held_sale', id);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  const prods = (await api('get_all_products')).data || [];
  cart = (res.data.items||[]).map(i=>{
    const p = prods.find(x=>x.id===i.productId) || {};
    return {productId:i.productId, name:i.name, unitPrice:i.unitPrice,
            originalPrice:p.selling_price ?? i.unitPrice, costPrice:i.costPrice,
            qty:i.qty, unit:i.unit||p.unit||'each', maxStock:p.stock ?? i.qty};
  });
  const d=document.getElementById('cartDiscount'); if(d) d.value=res.data.discount||0;
  const t=document.getElementById('cartTax'); if(t) t.value=res.data.tax||0;
  closeModal(); renderCart(); refreshHeldCount(); showToast('Sale resumed');
}

async function discardHeld(id) {
  if (!confirm('Discard this held sale?')) return;
  await api('delete_held_sale', id);
  openHeldSales(); refreshHeldCount();
}

// ═══════ SPLIT PAYMENT ═══════════════════════════════════
let splitLegs = null;
function openSplitPayment() {
  if (!cart.length) { showToast('Cart is empty','error'); return; }
  const total = cartDue();
  openModal('Split Payment', `
    <form onsubmit="applySplit(event)">
      <p style="font-size:0.85rem;margin-bottom:1rem">Total due <strong>${money(total)}</strong>.
        Split it across two methods — the parts must add up exactly.</p>
      <div class="form-row">
        <div class="form-group"><label>First Method</label>
          <select id="sp1m"><option>Cash</option><option>Mobile Money</option><option>Card</option><option>Bank Transfer</option></select></div>
        <div class="form-group"><label>Amount</label>
          <input type="number" step="0.01" min="0" id="sp1a" value="${(total/2).toFixed(2)}" oninput="syncSplit(${total})"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Second Method</label>
          <select id="sp2m"><option>Mobile Money</option><option>Cash</option><option>Card</option><option>Bank Transfer</option></select></div>
        <div class="form-group"><label>Amount</label>
          <input type="number" step="0.01" min="0" id="sp2a" value="${(total/2).toFixed(2)}" oninput="syncSplit(${total}, true)"></div>
      </div>
      <div id="splitStatus" style="font-size:0.8rem;margin-bottom:0.75rem"></div>
      <button type="submit" class="btn btn-primary btn-block">Use This Split</button>
    </form>`);
  syncSplit(total);
}
function syncSplit(total, second) {
  const a1=document.getElementById('sp1a'), a2=document.getElementById('sp2a');
  if (!a1||!a2) return;
  // Editing one side auto-fills the other so the parts always reconcile.
  if (second) a1.value = Math.max(0, total - (parseFloat(a2.value)||0)).toFixed(2);
  else        a2.value = Math.max(0, total - (parseFloat(a1.value)||0)).toFixed(2);
  const sum = (parseFloat(a1.value)||0) + (parseFloat(a2.value)||0);
  const el = document.getElementById('splitStatus');
  const ok = Math.abs(sum-total) < 0.011;
  if (el) el.innerHTML = ok
    ? `<span style="color:#34d399;font-weight:700">Adds up to ${money(sum)} ✓</span>`
    : `<span style="color:#ff6b6b;font-weight:700">${money(sum)} — must equal ${money(total)}</span>`;
}
function applySplit(e) {
  e.preventDefault();
  const legs = [
    {method:document.getElementById('sp1m').value, amount:parseFloat(document.getElementById('sp1a').value)||0},
    {method:document.getElementById('sp2m').value, amount:parseFloat(document.getElementById('sp2a').value)||0},
  ].filter(l=>l.amount>0);
  const sum = legs.reduce((s,l)=>s+l.amount,0);
  if (Math.abs(sum - cartDue()) > 0.011) { showToast('Split amounts must equal the total','error'); return; }
  splitLegs = legs;
  closeModal();
  showToast(`Split set: ${legs.map(l=>l.method+' '+money(l.amount)).join(' + ')}`);
}

// ═══════ BARCODE SCAN-TO-ADD + KEYBOARD SHORTCUTS ════════
async function handleScanInput(e) {
  // A keyboard-wedge scanner types the code then presses Enter.
  if (e.key !== 'Enter') return;
  const code = e.target.value.trim();
  if (!code) return;
  const res = await api('find_product_by_code', code);
  if (res.ok) {
    addToCart(res.data.id);
    e.target.value = '';
    showToast(`Added ${res.data.name}`);
  } else {
    // Not an exact code — fall back to filtering the grid by that text.
    renderPOSProducts();
    showToast(res.msg, 'error');
  }
}
function initPosShortcuts() {
  if (window._posKeysBound) return;
  window._posKeysBound = true;
  document.addEventListener('keydown', e => {
    // Only on the POS page, and never while typing in a field.
    const onPos = !document.getElementById('page-sales')?.classList.contains('hidden')
                  && currentPage === 'sales';
    if (!onPos) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName||'');
    if (e.key === 'F9') { e.preventDefault(); completeSale(); }
    else if (e.key === 'F2') { e.preventDefault(); holdCurrentSale(); }
    else if (e.key === 'F3') { e.preventDefault(); openHeldSales(); }
    else if (e.key === 'F4') { e.preventDefault(); document.getElementById('posScan')?.focus(); }
    else if (e.key === 'Escape' && !typing && cart.length) { clearCart(); }
  });
}

// ═══════ ACTIVITY LOG ════════════════════════════════════
const AUDIT_LABELS = {
  'auth.login':'Signed in', 'auth.lockout':'Account locked (failed logins)',
  'sale.void':'Sale voided', 'sale.discount':'Discount applied',
  'sale.below_cost_approved':'Below-cost sale approved',
  'stock.adjust':'Stock adjusted', 'product.delete':'Product deleted',
  'product.cost_updated':'Cost price updated', 'credit.payment':'Credit payment taken',
  'settings.update':'Settings changed', 'data.backup':'Backup taken',
  'data.restore':'Database restored',
};
function auditDetail(raw) {
  if (!raw) return '';
  try {
    const d = JSON.parse(raw);
    return Object.entries(d).map(([k,v]) => `${k.replace(/_/g,' ')}: ${v}`).join(' · ');
  } catch (e) { return String(raw); }
}
async function renderAudit() {
  const from = document.getElementById('auditFrom')?.value || '';
  const to   = document.getElementById('auditTo')?.value || '';
  const act  = document.getElementById('auditAction')?.value || '';
  const res = await api('get_audit_log', from, to, act, 500);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  const rows = res.data;
  // Populate the action filter once, from what actually exists.
  const sel = document.getElementById('auditAction');
  if (sel && sel.options.length <= 1) {
    const seen = [...new Set(rows.map(r=>r.action))].sort();
    seen.forEach(a => sel.insertAdjacentHTML('beforeend',
      `<option value="${esc(a)}">${esc(AUDIT_LABELS[a]||a)}</option>`));
  }
  document.querySelector('#auditTable tbody').innerHTML = rows.map(r=>`<tr>
      <td>${fmtDate(r.date)}</td>
      <td>${esc(r.user_name||'—')}</td>
      <td>${esc(r.role||'')}</td>
      <td>${esc(AUDIT_LABELS[r.action]||r.action)}</td>
      <td>${esc(r.entity||'')}${r.entity_id?' #'+esc(r.entity_id):''}</td>
      <td style="font-size:0.75rem;color:var(--on-surface-variant)">${esc(auditDetail(r.detail))}</td>
    </tr>`).join('') || emptyRow(6,'history_edu','No activity recorded for this period');
}
function exportAudit() {
  const rows = [...document.querySelectorAll('#auditTable tbody tr')]
    .map(tr => [...tr.children].map(td => `"${td.textContent.replace(/"/g,'""')}"`).join(','));
  if (!rows.length) { showToast('Nothing to export','error'); return; }
  downloadCSV('When,User,Role,Action,Item,Details\n' + rows.join('\n'), 'activity-log.csv');
}

// ═══════ TAX COMPONENTS ══════════════════════════════════
let taxComponents = [];
function renderTaxComponents() {
  const box = document.getElementById('taxComponents');
  if (!box) return;
  box.innerHTML = taxComponents.map((c,i)=>`
    <div class="form-row" style="gap:0.4rem;margin-bottom:0.35rem;align-items:center">
      <input type="text" value="${esc(c.name)}" placeholder="Name (e.g. VAT)"
             onchange="taxComponents[${i}].name=this.value">
      <input type="number" step="0.01" min="0" max="100" value="${c.rate}" style="max-width:90px"
             onchange="taxComponents[${i}].rate=parseFloat(this.value)||0; renderTaxComponents()">
      <button type="button" class="btn btn-sm btn-outline" aria-label="Remove ${esc(c.name)}"
              onclick="taxComponents.splice(${i},1); renderTaxComponents()"><span class="material-symbols-outlined" style="font-size:14px">close</span></button>
    </div>`).join('') ||
    '<p style="font-size:0.78rem;color:var(--outline)">No tax charged.</p>';
  const total = taxComponents.reduce((s,c)=>s+(c.rate||0),0);
  const el = document.getElementById('taxTotalRate');
  if (el) el.textContent = total.toFixed(2) + '%';
  const hidden = document.getElementById('settingTaxRate');
  if (hidden) hidden.value = total;
}
function addTaxComponent() {
  taxComponents.push({name:'', rate:0});
  renderTaxComponents();
}
async function loadTaxComponents() {
  const res = await api('get_tax_config');
  taxComponents = (res.ok && res.data.components) ? res.data.components : [];
  renderTaxComponents();
}

// ═══════ RECURRING EXPENSES ══════════════════════════════
async function openRecurringModal() {
  const res = await api('get_recurring_expenses');
  const rows = res.ok ? res.data : [];
  openModal('Recurring Monthly Expenses', `
    <p style="font-size:0.8rem;color:var(--on-surface-variant);margin-bottom:1rem">
      Fixed costs like rent and salaries post themselves each month, so your net profit
      is never wrong because someone forgot to enter them.
    </p>
    <div class="table-scroll" style="max-height:220px;margin-bottom:1rem"><table class="data-table">
      <thead><tr><th>Category</th><th>Description</th><th>Amount</th><th>Day</th><th>Active</th><th></th></tr></thead>
      <tbody>${rows.map(r=>`<tr>
        <td>${esc(r.category||'')}</td><td>${esc(r.description||'')}</td>
        <td>${money(r.amount)}</td><td>${r.day_of_month}</td>
        <td>${r.active?'<span class="badge badge-success">Yes</span>':'<span class="badge">No</span>'}</td>
        <td><button class="btn btn-sm btn-outline" onclick="removeRecurring(${r.id})" aria-label="Remove"><span class="material-symbols-outlined" style="font-size:14px">delete</span></button></td>
      </tr>`).join('')||emptyRow(6,'event_repeat','None set up yet')}</tbody>
    </table></div>
    <form onsubmit="saveRecurring(event)">
      <div class="form-row">
        <div class="form-group"><label>Category *</label>
          <select id="rcCategory">${EXPENSE_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select></div>
        <div class="form-group"><label>Description *</label>
          <input type="text" id="rcDesc" placeholder="e.g. Shop rent" required></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Amount *</label>
          <input type="number" step="0.01" min="0.01" id="rcAmount" required></div>
        <div class="form-group"><label>Day of month</label>
          <input type="number" min="1" max="28" id="rcDay" value="1"></div>
        <div class="form-group"><label>Method</label>
          <select id="rcPayment"><option>Cash</option><option>Bank Transfer</option><option>Mobile Money</option></select></div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Add Recurring Expense</button>
    </form>`);
}
async function saveRecurring(e) {
  e.preventDefault();
  const res = await api('save_recurring_expense', null,
    document.getElementById('rcCategory').value,
    document.getElementById('rcDesc').value,
    document.getElementById('rcAmount').value,
    document.getElementById('rcPayment').value,
    document.getElementById('rcDay').value, 1);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  showToast(res.msg); openRecurringModal();
}
async function removeRecurring(id) {
  if (!confirm('Remove this recurring expense?')) return;
  await api('delete_recurring_expense', id);
  openRecurringModal();
}

// ═══════ BACKUP & RESTORE ════════════════════════════════
async function loadBackupInfo() {
  const res = await api('get_backup_info');
  const el = document.getElementById('backupInfo');
  if (!el || !res.ok) return;
  const d = res.data;
  el.innerHTML = `
    <div><strong>Database size:</strong> ${d.dbSizeKb.toLocaleString()} KB</div>
    <div><strong>Automatic backups:</strong> ${d.autoBackups}${d.lastAuto?` (latest ${esc(d.lastAuto)})`:''}</div>
    <div style="word-break:break-all"><strong>Location:</strong> ${esc(d.folder)}</div>`;
}
async function doBackup() {
  showToast('Preparing backup…');
  const res = await api('backup_database', '');
  if (!res.ok) { showToast(res.msg,'error'); return; }
  showToast('Backup saved');
  loadBackupInfo();
}
async function doRestore() {
  if (!confirm('Restoring replaces ALL current data with the contents of the backup file.\n\n'
             + 'A safety copy of the current database is made first, and you will need to sign in again.\n\n'
             + 'Continue?')) return;
  const res = await api('restore_database', '');
  if (!res.ok) { showToast(res.msg,'error'); return; }
  alert('Database restored. Dwatrex will now return to the sign-in screen.');
  location.reload();
}

// ═══════ STOCK ADJUSTMENT ════════════════════════════════
const ADJUST_REASONS = ['Count correction','Damage','Theft/Loss','Expiry','Supplier shortage','Found stock','Other'];
async function openAdjustModal(productId) {
  const res = await api('get_all_products');
  const prods = res.ok ? res.data : [];
  const p = prods.find(x=>x.id===productId);
  const opts = prods.map(x=>`<option value="${x.id}" ${x.id===productId?'selected':''}>${esc(x.name)} (${esc(x.sku)}) — ${x.stock} in stock</option>`).join('');
  openModal('Adjust Stock', `
    <form onsubmit="saveAdjustment(event)">
      <p style="font-size:0.8rem;color:var(--on-surface-variant);margin-bottom:1rem">
        Use this after a stock count, or when goods are damaged or missing. It records the reason —
        never use a fake sale or purchase to correct stock.
      </p>
      <div class="form-group"><label>Product *</label>
        <select id="adjProduct" required onchange="onAdjustProductChange()">${opts}</select></div>
      <div class="form-row">
        <div class="form-group"><label>Counted Quantity *</label>
          <input type="number" step="0.01" min="0" id="adjQty" value="${p?p.stock:0}" required oninput="onAdjustProductChange(true)"></div>
        <div class="form-group"><label>Date *</label>
          <input type="date" id="adjDate" value="${fmt(new Date())}" max="${fmt(new Date())}" required></div>
      </div>
      <div id="adjDelta" style="font-size:0.8rem;margin-bottom:0.75rem"></div>
      <div class="form-group"><label>Reason *</label>
        <select id="adjReason" required>${ADJUST_REASONS.map(r=>`<option>${r}</option>`).join('')}</select></div>
      <div class="form-group"><label>Note</label><input type="text" id="adjNote" placeholder="Optional detail"></div>
      <button type="submit" class="btn btn-primary btn-block">Record Adjustment</button>
    </form>`);
  window._adjProducts = prods;
  onAdjustProductChange();
}
function onAdjustProductChange(keepQty) {
  const prods = window._adjProducts || [];
  const id = parseInt(document.getElementById('adjProduct')?.value);
  const p = prods.find(x=>x.id===id);
  const qtyEl = document.getElementById('adjQty');
  if (!p || !qtyEl) return;
  if (!keepQty) qtyEl.value = p.stock;
  const now = parseFloat(qtyEl.value||0) || 0;
  const delta = now - p.stock;
  const el = document.getElementById('adjDelta');
  if (el) el.innerHTML = Math.abs(delta) < 0.0001
    ? `<span style="color:var(--outline)">System stock is ${p.stock} — no change.</span>`
    : `<span style="color:${delta<0?'#ff6b6b':'#34d399'};font-weight:700">
         System ${p.stock} → counted ${now} (${delta>0?'+':''}${delta.toFixed(2)})</span>`;
}
async function saveAdjustment(e) {
  e.preventDefault();
  const res = await api('adjust_stock',
    parseInt(document.getElementById('adjProduct').value),
    document.getElementById('adjQty').value,
    document.getElementById('adjReason').value,
    document.getElementById('adjNote').value,
    document.getElementById('adjDate').value);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  closeModal(); showToast(res.msg);
  renderInventory(); renderProducts();
}

// ═══════ VOID SALE ═══════════════════════════════════════
async function voidSale(saleId) {
  const reason = prompt ? null : null;   // pywebview prompt() is unreliable — use a modal
  openModal(`Void Sale #${saleId}`, `
    <form onsubmit="confirmVoid(event, ${saleId})">
      <p style="font-size:0.85rem;margin-bottom:1rem;color:#ff6b6b">
        <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle">warning</span>
        This reverses the whole sale: every item goes back into stock and any credit balance is cleared.
        The sale is kept on record, marked as voided.
      </p>
      <div class="form-group"><label>Reason *</label>
        <input type="text" id="voidReason" placeholder="e.g. rung up twice" required></div>
      <div class="form-group"><label>Manager PIN</label>
        <input type="password" id="voidPin" placeholder="Required if a PIN is set" autocomplete="off"></div>
      <button type="submit" class="btn btn-primary btn-block">Void This Sale</button>
    </form>`);
}
async function confirmVoid(e, saleId) {
  e.preventDefault();
  const res = await api('void_sale', saleId,
    document.getElementById('voidReason').value,
    document.getElementById('voidPin').value);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  closeModal(); showToast(res.msg);
  renderSalesHistory(); renderPOSProducts();
}

// ═══════ CASH HANDLING (tendered / change due) ═══════════
function cartDue() {
  const sub = cart.reduce((s,i)=>s+i.qty*i.unitPrice,0);
  const disc = parseFloat(document.getElementById('cartDiscount')?.value||0);
  const tax  = parseFloat(document.getElementById('cartTax')?.value||0);
  const da = sub*disc/100;
  return sub - da + (sub-da)*tax/100;
}
function updateChangeDue() {
  const due = cartDue();
  const t = parseFloat(document.getElementById('cashTendered')?.value||0) || 0;
  const row = document.getElementById('changeRow');
  const out = document.getElementById('changeDue');
  if (!row || !out) return;
  if (!t) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  const change = t - due;
  out.textContent = money(Math.abs(change));
  row.classList.toggle('short', change < -0.001);
  out.previousElementSibling.textContent = change < -0.001 ? 'Still Owing' : 'Change Due';
}
// Suggest realistic notes the customer is likely to hand over.
function renderQuickTender() {
  const box = document.getElementById('quickTender');
  if (!box) return;
  const due = cartDue();
  if (due <= 0) { box.innerHTML = ''; return; }
  const notes = [1,2,5,10,20,50,100,200];
  const opts = new Set([Math.ceil(due)]);
  notes.forEach(n => { if (n >= due) opts.add(n); });
  // Next round 10/50/100 above the total.
  [10,50,100].forEach(step => opts.add(Math.ceil(due/step)*step));
  const list = [...opts].filter(v=>v>=due).sort((a,b)=>a-b).slice(0,4);
  box.innerHTML = list.map(v=>`<button type="button" class="tender-chip" onclick="setTender(${v})">${money(v)}</button>`).join('')
                + `<button type="button" class="tender-chip" onclick="setTender(${due.toFixed(2)})">Exact</button>`;
}
function setTender(v) {
  const el = document.getElementById('cashTendered');
  if (el) { el.value = Number(v).toFixed(2); updateChangeDue(); }
}
function resetTenderFields() {
  const el = document.getElementById('cashTendered'); if (el) el.value = '';
  document.getElementById('changeRow')?.classList.add('hidden');
}

// ═══════ CREDIT / RECEIVABLES ════════════════════════════
function onPaymentMethodChange() {
  const isCredit = document.getElementById('paymentMethod')?.value === 'Credit';
  const el = document.getElementById('creditFields');
  if (el) el.classList.toggle('hidden', !isCredit);
  // Tendering applies to cash-like payments, and to a credit deposit.
  const tf = document.getElementById('tenderFields');
  if (tf) tf.classList.toggle('hidden', isCredit);
  if (!isCredit) resetCreditFields();
  renderQuickTender(); updateChangeDue();
}
function resetCreditFields() {
  ['creditCustomerName','creditCustomerPhone'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
  const d=document.getElementById('creditDeposit'); if(d) d.value='0';
  const f=document.getElementById('creditFields'); if(f) f.classList.add('hidden');
  const pm=document.getElementById('paymentMethod'); if(pm && pm.value==='Credit') pm.value='Cash';
}

// Build a WhatsApp link so chasing a debt is one tap. wa.me needs digits only,
// and Ghana numbers are stored locally (024…) so add the country code.
function waLink(phone, text) {
  let d = String(phone||'').replace(/\D/g,'');
  if (!d) return '';
  if (d.startsWith('0')) d = '233' + d.slice(1);
  else if (!d.startsWith('233') && d.length <= 9) d = '233' + d;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

async function renderCreditAgeing() {
  const res = await api('get_credit_by_customer');
  if (!res.ok) { showToast(res.msg,'error'); return; }
  const { customers, totals } = res.data;
  document.getElementById('creditOutstanding').textContent = money(totals.outstanding);
  document.getElementById('creditCustomers').textContent = totals.customers;
  const cell = (v, warn) => v > 0.001
    ? `<td style="${warn?'color:#ff6b6b;font-weight:700':''}">${money(v)}</td>` : '<td>—</td>';
  document.querySelector('#creditAgeingTable tbody').innerHTML = customers.map(c=>{
    const msg = `Hello ${c.customer}, a friendly reminder that your balance with ${storeInfo.name||'us'} is ${money(c.balance)}. Thank you.`;
    const wa = waLink(c.phone, msg);
    return `<tr>
      <td><strong>${esc(c.customer)}</strong>${c.oldestDays>90?' <span class="badge badge-danger">Overdue</span>':''}</td>
      <td>${c.phone?`<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>`:'—'}</td>
      <td>${c.sales}</td>
      ${cell(c.current)}${cell(c.d30)}${cell(c.d60,true)}${cell(c.d90,true)}
      <td style="font-weight:800">${money(c.balance)}</td>
      <td class="actions">
        <button class="btn btn-sm btn-outline" onclick="openCustomerCredit('${esc(c.customer).replace(/'/g,"\\'")}')" aria-label="View ${esc(c.customer)}">Details</button>
        ${wa?`<a class="btn btn-sm btn-primary" href="${wa}" target="_blank" rel="noopener" aria-label="WhatsApp reminder"><span class="material-symbols-outlined" style="font-size:14px">chat</span></a>`:''}
      </td></tr>`;
  }).join('') || emptyRow(9,'handshake','Nobody owes you anything — nice');
}

async function openCustomerCredit(name) {
  const res = await api('get_customer_credit_detail', name);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  const d = res.data;
  openModal(`${name} — owes ${money(d.balance)}`, `
    <h4 style="font-size:0.8rem;margin-bottom:0.5rem">Credit sales</h4>
    <div class="table-scroll" style="max-height:200px"><table class="data-table">
      <thead><tr><th>Sale</th><th>Date</th><th>Total</th><th>Paid</th><th>Balance</th><th></th></tr></thead>
      <tbody>${d.sales.map(s=>`<tr><td>#${s.id}</td><td>${fmtDate(s.date)}</td>
        <td>${money(s.total)}</td><td>${money(s.amount_paid||0)}</td>
        <td style="${(s.balance||0)>0?'color:#ff6b6b;font-weight:700':''}">${money(s.balance||0)}</td>
        <td>${(s.balance||0)>0?`<button class="btn btn-sm btn-primary" onclick="closeModal();openCreditPaymentModal(${s.id})">Pay</button>`:''}</td>
        </tr>`).join('')||emptyRow(6,'receipt','No credit sales')}</tbody>
    </table></div>
    <h4 style="font-size:0.8rem;margin:1rem 0 0.5rem">Payment history</h4>
    <div class="table-scroll" style="max-height:160px"><table class="data-table">
      <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Taken by</th></tr></thead>
      <tbody>${d.payments.map(p=>`<tr><td>${fmtDate(p.date)}</td><td>${money(p.amount)}</td>
        <td>${esc(p.method||'')}</td><td>${esc(p.taken_by||'')}</td></tr>`).join('')
        ||emptyRow(4,'payments','No payments yet')}</tbody>
    </table></div>`);
}

async function renderCredit() {
  const view = document.getElementById('creditView')?.value || 'customers';
  document.getElementById('creditAgeingCard')?.classList.toggle('hidden', view!=='customers');
  document.getElementById('creditSalesCard')?.classList.toggle('hidden', view==='customers');
  document.getElementById('creditStatusFilter')?.classList.toggle('hidden', view==='customers');
  if (view === 'customers') return renderCreditAgeing();
  const status = document.getElementById('creditStatusFilter')?.value || 'outstanding';
  const res = await api('get_credit_sales', status);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  const { sales, totals } = res.data;
  document.getElementById('creditOutstanding').textContent = money(totals.outstanding);
  document.getElementById('creditCustomers').textContent = totals.customers;
  document.querySelector('#creditTable tbody').innerHTML = sales.map(s=>{
    const owed = s.balance || 0;
    const settled = owed <= 0.001;
    return `<tr>
      <td>#${s.id}</td>
      <td>${fmtDate(s.date)}</td>
      <td>${esc(s.customer_name||'—')}</td>
      <td>${s.customer_phone?`<a href="tel:${esc(s.customer_phone)}">${esc(s.customer_phone)}</a>`:'—'}</td>
      <td>${money(s.total)}</td>
      <td>${money(s.amount_paid||0)}</td>
      <td class="${settled?'':'val-emphasis'}" style="${settled?'':'color:#ff6b6b;font-weight:700'}">${money(owed)}</td>
      <td><span class="badge ${settled?'badge-success':'badge-warning'}">${settled?'Settled':'Owing'}</span></td>
      <td class="actions">
        ${settled?'':`<button class="btn btn-sm btn-primary" aria-label="Record payment for sale ${s.id}" onclick="openCreditPaymentModal(${s.id})"><span class="material-symbols-outlined" style="font-size:14px">payments</span> Pay</button>`}
        <button class="btn btn-sm btn-outline" aria-label="Payment history for sale ${s.id}" onclick="openCreditHistory(${s.id})"><span class="material-symbols-outlined" style="font-size:14px">history</span></button>
      </td></tr>`;
  }).join('') || emptyRow(9,'handshake', status==='outstanding' ? 'No outstanding credit — everyone has paid' : 'No credit sales here');
}

async function openCreditPaymentModal(saleId) {
  const res = await api('get_credit_sales','all');
  const sale = (res.ok ? res.data.sales : []).find(s=>s.id===saleId);
  if (!sale) { showToast('Sale not found','error'); return; }
  openModal(`Record Payment — Sale #${saleId}`,`
    <form onsubmit="saveCreditPayment(event, ${saleId})">
      <p style="font-size:0.85rem;margin-bottom:1rem">
        <strong>${esc(sale.customer_name||'')}</strong>${sale.customer_phone?` · ${esc(sale.customer_phone)}`:''}<br>
        Total ${money(sale.total)} · Paid ${money(sale.amount_paid||0)} ·
        <span style="color:#ff6b6b;font-weight:700">Owing ${money(sale.balance||0)}</span>
      </p>
      <div class="form-row">
        <div class="form-group"><label>Amount *</label>
          <input type="number" step="0.01" min="0.01" max="${sale.balance}" id="cpAmount" value="${(sale.balance||0).toFixed(2)}" required></div>
        <div class="form-group"><label>Date *</label>
          <input type="date" id="cpDate" value="${fmt(new Date())}" max="${fmt(new Date())}" required></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Method</label>
          <select id="cpMethod"><option>Cash</option><option>Mobile Money</option><option>Card</option><option>Bank Transfer</option></select></div>
        <div class="form-group"><label>Note</label><input type="text" id="cpNote" placeholder="Optional"></div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Record Payment</button>
    </form>`);
}

async function saveCreditPayment(e, saleId) {
  e.preventDefault();
  const amount = document.getElementById('cpAmount').value;
  const date = document.getElementById('cpDate').value;
  const method = document.getElementById('cpMethod').value;
  const note = document.getElementById('cpNote').value;
  const res = await api('record_credit_payment', saleId, amount, method, date, note);
  if (!res.ok) { showToast(res.msg,'error'); return; }
  closeModal(); showToast(res.msg); renderCredit(); renderSalesHistory();
}

async function openCreditHistory(saleId) {
  const res = await api('get_credit_payments', saleId);
  const rows = res.ok ? res.data : [];
  openModal(`Payment History — Sale #${saleId}`, `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Note</th><th>Taken by</th></tr></thead>
        <tbody>${rows.map(r=>`<tr><td>${fmtDate(r.date)}</td><td>${money(r.amount)}</td><td>${esc(r.method||'')}</td><td>${esc(r.note||'')}</td><td>${esc(r.taken_by||'')}</td></tr>`).join('')
          || emptyRow(5,'receipt_long','No payments recorded yet')}</tbody>
      </table>
    </div>`);
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
    <td class="actions"><button class="btn btn-sm btn-outline" aria-label="View receipt" onclick="showReceiptById(${s.id})"><span class="material-symbols-outlined" style="font-size:14px">receipt</span></button>
    ${s.voided
      ? '<span class="badge badge-danger" title="'+esc(s.void_reason||'')+'">Voided</span>'
      : `<button class="btn btn-sm btn-outline" aria-label="Void sale ${s.id}" title="Void this sale" onclick="voidSale(${s.id})"><span class="material-symbols-outlined" style="font-size:14px">block</span></button>`}
    </td></tr>`).join('')||emptyRow(9,'point_of_sale','No sales in this range');
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
      <div class="form-row">
        <div class="form-group"><label>Supplier *</label><select id="puSupplier" required><option value="">Select</option>${supOpts}</select></div>
        <div class="form-group"><label>Purchase Date *</label><input type="date" id="puDate" value="${fmt(new Date())}" max="${fmt(new Date())}" required>
          <p style="font-size:0.7rem;color:var(--on-surface-variant);margin-top:0.25rem">Set an earlier date to record a past purchase.</p></div>
      </div>
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
  const poDate = document.getElementById('puDate')?.value || '';
  const res = await api('save_purchase',supplier,JSON.stringify(items),poDate);
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  closeModal(); showToast('Purchase recorded'); renderPurchases(); renderInventory();
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

// ── Collapsible panels ───────────────────────────────────
// Every panel starts expanded (nothing is hidden by surprise); the user's
// choices persist. Panel keys derive from the heading text — if a heading is
// ever renamed that panel simply reopens, which is harmless.
const INSIGHT_COLLAPSE_KEY = 'dwatrex.insights.collapsed';

function _panelKey(card) {
  const h = card.querySelector('.card-header h3');
  return h ? h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
}
function _loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(INSIGHT_COLLAPSE_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function _saveCollapsed(set) {
  try { localStorage.setItem(INSIGHT_COLLAPSE_KEY, JSON.stringify([...set])); } catch (e) {}
}
// A chart drawn inside a hidden panel has zero size — resize it once visible.
function resizeChartsIn(el) {
  el.querySelectorAll('canvas').forEach(cv => {
    Object.values(chartInstances).forEach(inst => {
      if (inst && inst.canvas === cv) { try { inst.resize(); } catch (e) {} }
    });
  });
}
function toggleInsightPanel(card) {
  const collapsed = card.classList.toggle('collapsed');
  const header = card.querySelector('.card-header');
  if (header) header.setAttribute('aria-expanded', String(!collapsed));
  const set = _loadCollapsed();
  const key = _panelKey(card);
  if (collapsed) set.add(key); else set.delete(key);
  _saveCollapsed(set);
  if (!collapsed) resizeChartsIn(card);
}
function initInsightCollapse() {
  const page = document.getElementById('page-insights');
  if (!page || page.dataset.collapseReady) return;   // wire up once
  const collapsed = _loadCollapsed();
  page.querySelectorAll('.card').forEach(card => {
    const header = card.querySelector('.card-header');
    if (!header) return;                             // skip anything headerless
    const chev = document.createElement('span');
    chev.className = 'material-symbols-outlined collapse-chevron';
    chev.textContent = 'expand_more';
    chev.setAttribute('aria-hidden', 'true');
    header.appendChild(chev);
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'true');
    header.addEventListener('click', () => toggleInsightPanel(card));
    header.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleInsightPanel(card); }
    });
    if (collapsed.has(_panelKey(card))) {
      card.classList.add('collapsed');
      header.setAttribute('aria-expanded', 'false');
    }
  });
  page.dataset.collapseReady = '1';
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
  initInsightCollapse();
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

    // Charts just rebuilt: any that are in an open panel may have been sized
    // while the page was mid-layout, so settle them on the next frame.
    requestAnimationFrame(() => {
      document.querySelectorAll('#page-insights .card:not(.collapsed)').forEach(resizeChartsIn);
    });
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
  // Excel on Windows assumes the system codepage unless the file starts with a
  // UTF-8 byte-order mark — without it "GH₵" opens as mojibake.
  const BOM = '﻿';
  if (!content.startsWith(BOM)) content = BOM + content;
  // In the desktop app, save through the native dialog (blob downloads don't
  // work inside the webview). Fall back to a blob download in a plain browser.
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save_text_file) {
    const res = await api('save_text_file', filename, content);
    if (res.ok) { if (!(res.data && res.data.cancelled)) showToast('File saved'); }
    else showToast(res.msg || 'Could not save file', 'error');
    return;
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
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
  const ws = document.getElementById('settingWeekStart');
  if (ws) ws.value = (d.weekStart != null && d.weekStart !== '') ? String(d.weekStart) : '0';
  setVal('settingLowStock', d.lowStockThreshold);
  setVal('settingFastMoving', d.fastMovingThreshold);
  setVal('settingSlowMoving', d.slowMovingThreshold);
  logoDataUrl = d.storeLogo || '';
  showLogoPreview(logoDataUrl);
  belowCostPinSet = !!d.below_cost_pin_set;
  const pinInput = document.getElementById('settingBelowCostPin');
  if (pinInput) pinInput.value = '';
  const clearBox = document.getElementById('settingBelowCostPinClear');
  if (clearBox) clearBox.checked = false;
  const hint = document.getElementById('belowCostPinHint');
  if (hint) hint.textContent = belowCostPinSet
    ? 'A PIN is currently set. Type a new one to change it, or leave blank to keep it.'
    : 'No PIN set — below-cost sales only prompt a confirmation. Set a PIN (min 4 chars) to require approval.';
}

async function saveSettings() {
  const s={
    storeName:document.getElementById('settingStoreName').value,
    storeAddress:document.getElementById('settingStoreAddress').value,
    storePhone:document.getElementById('settingStorePhone').value,
    storeEmail:document.getElementById('settingStoreEmail').value,
    storeLogo:logoDataUrl,
    currency:document.getElementById('settingCurrency').value.trim()||'GH₵',
    taxRate:document.getElementById('settingTaxRate').value,
    weekStart:document.getElementById('settingWeekStart')?.value ?? '0',
    lowStockThreshold:document.getElementById('settingLowStock').value,
    fastMovingThreshold:document.getElementById('settingFastMoving').value, slowMovingThreshold:document.getElementById('settingSlowMoving').value};
  // Below-cost approval PIN: clear it, set/change it, or leave it untouched.
  const clearPin = document.getElementById('settingBelowCostPinClear')?.checked;
  const newPin = (document.getElementById('settingBelowCostPin')?.value || '').trim();
  if (clearPin) s.below_cost_pin = '__clear__';
  else if (newPin) s.below_cost_pin = newPin;   // blank -> key omitted, PIN kept
  await api('save_tax_components', JSON.stringify(taxComponents.filter(c=>c.name.trim())));
  const res = await api('save_settings',JSON.stringify(s));
  if (!res.ok) { showToast(res.msg, 'error'); return; }
  currencySymbol = s.currency;          // take effect immediately, app-wide
  const taxEl = document.getElementById('cartTax'); if (taxEl) taxEl.value = s.taxRate;
  storeInfo = { name:s.storeName, address:s.storeAddress, phone:s.storePhone, email:s.storeEmail, logo:s.storeLogo };
  if (clearPin) belowCostPinSet = false;
  else if (newPin) belowCostPinSet = true;
  showToast('Settings saved');
  loadSettings();   // refresh the hint / clear the field
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
