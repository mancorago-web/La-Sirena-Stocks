// Auth state - set by Firebase on load
let authReady = false;
const authResolve = [];
let authError = null;
function waitForAuth() {
  if (authError) return Promise.reject(authError);
  if (authReady) return Promise.resolve();
  return new Promise(resolve => authResolve.push(resolve));
}

// Helper: format date for input[type=date]
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2500);
}

// Shared cache for con-inventario data (reused across tabs)
let _invCache = { fecha: null, data: null, pending: null };
function getInventario(fecha) {
  if (_invCache.fecha === fecha && _invCache.data) return Promise.resolve(_invCache.data);
  if (_invCache.fecha === fecha && _invCache.pending) return _invCache.pending;
  const p = api('GET', '/api/almacenes/con-inventario?fecha=' + fecha).then(data => {
    _invCache = { fecha, data, pending: null };
    return data;
  }).catch(err => { _invCache = { fecha: null, data: null, pending: null }; throw err; });
  _invCache.pending = p;
  return p;
}

const DISPLAY_NAMES = { 'davejs@gmail.com': 'David' };
let currentUserName = '';
firebase.auth().onAuthStateChanged(user => {
  const info = document.getElementById('user-info');
  const el = document.getElementById('user-email');
  if (!user) {
    window.location.href = '/login.html';
    return;
  }
  if (info) info.style.display = '';
  const name = DISPLAY_NAMES[user.email] || user.displayName || user.email;
  currentUserName = name;
  if (el) el.textContent = name;
  authReady = true;
  authResolve.forEach(r => r());
  authResolve.length = 0;
  // Persist displayName via API (runs once per session)
  if (DISPLAY_NAMES[user.email] && !user.displayName) {
    user.getIdToken().then(token => {
      fetch('/api/setup/display-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ displayName: DISPLAY_NAMES[user.email] })
      }).catch(() => {});
    });
  }
  // Auto-repair propagation for today
  user.getIdToken().then(token => {
    fetch('/api/repair/propagar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ fecha: todayStr() })
    }).catch(() => {});
  });
  // Auto-migrate (one-time setup, no re-sync on every load)
  user.getIdToken().then(async token => {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } };
    await fetch('/api/migrate/normalize-units', opts).catch(() => {});
    await fetch('/api/migrate/import-recetas-base', opts).catch(() => {});
    await fetch('/api/migrate/fix-receta-ingredientes', opts).catch(e => console.error('fix-receta-ingredientes error:', e));
    await fetch('/api/migrate/rename-mantgras', opts).catch(e => console.error('rename-mantgras error:', e));
    await fetch('/api/migrate/fix-montgrass-name', opts).catch(e => console.error('fix-montgrass-name error:', e));
  });
  // Register service worker for PWA (sin recargar la página al actualizar para no molestar al usuario)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      setInterval(() => reg.update(), 300000);
    }).catch(() => {});
  }
});
document.addEventListener('click', e => {
  if (e.target.id === 'btn-salir') {
    firebase.auth().signOut();
  }
});

const _loaded = {};
window.__vista = { cat: null, tab: null, sub: null, pestana: null };
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    document.getElementById('tab-' + name).classList.add('active');
    window.__vista = { cat: 'stocks', tab: name };
    // Recargar siempre para mantener todo actualizado en cadena
    const loaders = {
      almacenes: () => cargarAlmacenes(document.getElementById('fecha-almacenes')?.value),
      ingresos: () => cargarIngresos(document.getElementById('fecha-ingresos')?.value),
      salidas: () => cargarSalidas(document.getElementById('fecha-salidas')?.value),
      ventas: () => cargarVentas(document.getElementById('fecha-ventas')?.value),
      bajas: () => cargarBajas(document.getElementById('fecha-bajas')?.value),
      stocks: () => cargarStocks(),
      reportes: () => cargarReportes(),
      precios: () => cargarBaseDatosStocks(),
      busquedaventas: () => cargarSugerenciasBusquedaVentas()
    };
    if (loaders[name]) loaders[name]();
  });
});

// --- Navigation: main menu / categories ---
let _ocultarCero = true;
function toggleVerCero() {
  _ocultarCero = !_ocultarCero;
  const btn = document.getElementById('btn-ver-cero');
  if (btn) {
    btn.textContent = _ocultarCero ? '🙈' : '👁️';
    btn.title = _ocultarCero ? 'Mostrar items con stock 0' : 'Ocultar items con stock 0';
  }
  const fecha = document.getElementById('fecha-almacenes')?.value;
  cargarAlmacenes(fecha);
}
function dibujarFlujoMenu() {
  const cont = document.getElementById('menu-flow-container');
  const svg = document.getElementById('menu-flow-svg');
  if (!cont || !svg || cont.offsetWidth === 0) return;
  const rect = cont.getBoundingClientRect();
  const comprasBtn = document.getElementById('btn-compras');
  const ventasBtn = document.getElementById('btn-ventas');
  const mids = ['stocks', 'barra', 'cocina']
    .map(cat => cont.querySelector('.category-btn.menu-' + cat))
    .filter(Boolean);
  if (!comprasBtn || !ventasBtn || !mids.length) return;
  const cr = comprasBtn.getBoundingClientRect();
  const vr = ventasBtn.getBoundingClientRect();
  const comprasBottom = { x: (cr.left + cr.width / 2) - rect.left, y: cr.bottom - rect.top };
  const ventasTop = { x: (vr.left + vr.width / 2) - rect.left, y: vr.top - rect.top };
  const tops = mids.map(b => { const r = b.getBoundingClientRect(); return { x: (r.left + r.width / 2) - rect.left, y: r.top - rect.top }; });
  const bottoms = mids.map(b => { const r = b.getBoundingClientRect(); return { x: (r.left + r.width / 2) - rect.left, y: r.bottom - rect.top }; });
  let paths = '';
  tops.forEach(t => {
    const midY = (comprasBottom.y + t.y) / 2;
    paths += `<path class="flow-path" d="M ${comprasBottom.x} ${comprasBottom.y} C ${comprasBottom.x} ${midY}, ${t.x} ${midY}, ${t.x} ${t.y}"/>`;
  });
  bottoms.forEach(b => {
    const midY = (b.y + ventasTop.y) / 2;
    paths += `<path class="flow-path" d="M ${b.x} ${b.y} C ${b.x} ${midY}, ${ventasTop.x} ${midY}, ${ventasTop.x} ${ventasTop.y}"/>`;
  });
  svg.innerHTML = paths;
}
window.addEventListener('load', () => { dibujarFlujoMenu(); actualizarContadoresMenu(); cargarSugerenciasBusquedaVentas(); });

// Refresco automático: recarga la vista actual al volver a la pestaña o cada 30s,
// para que todos los dispositivos/navegadores vean la misma información actualizada.
function refrescarVista() {
  const v = window.__vista;
  if (!v || !v.cat) return;
  _invCache = { fecha: null, data: null, pending: null };
  if (v.cat === 'stocks') {
    const loaders = {
      almacenes: () => cargarAlmacenes(document.getElementById('fecha-almacenes')?.value),
      ingresos: () => cargarIngresos(document.getElementById('fecha-ingresos')?.value),
      salidas: () => cargarSalidas(document.getElementById('fecha-salidas')?.value),
      ventas: () => cargarVentas(document.getElementById('fecha-ventas')?.value),
      bajas: () => cargarBajas(document.getElementById('fecha-bajas')?.value),
      stocks: () => cargarStocks(),
      reportes: () => cargarReportes(),
      precios: () => cargarBaseDatosStocks()
    };
    if (loaders[v.tab]) loaders[v.tab]();
  } else if (v.cat === 'barra') {
    if (['ingresos', 'ventas', 'bajas'].includes(v.sub)) cargarBarraMovimientos(v.sub);
    else if (v.sub === 'stock') cargarStockBarra();
    else if (v.sub === 'recetas') cargarRecetas();
    else if (v.sub === 'basedatos') cargarPrecios();
  } else if (v.cat === 'cocina') {
    if (['ingresos', 'salidas', 'ventas'].includes(v.sub)) cargarCocinaMovimientos(v.sub);
    else if (v.sub === 'stock') cargarStockCocina();
    else if (v.sub === 'recetas') cargarRecetasCocina();
    else if (v.sub === 'basedatos') cargarPreciosCocina();
  } else if (v.cat === 'ventas') {
    if (v.sub === 'busqueda') cargarSugerenciasBusquedaVentasTotal();
    else cargarVentasCentral();
  } else if (v.cat === 'compras') {
    cargarCompras();
  } else if (v.cat === 'costos' && v.pestana) {
    cargarCostoCategoria(v.pestana);
  }
}
// Sin actualización automática de la vista: recargar la vista re-renderiza los formularios y
// puede borrar valores sin guardar o colapsar los acordeones. La app se refresca al navegar o recargar.

function actualizarContadoresMenu() {
  const s = document.getElementById('menu-items-stocks');
  const b = document.getElementById('menu-items-barra');
  const c = document.getElementById('menu-items-cocina');
  if (!s && !b && !c) return;
  api('GET', '/api/resumen/items?fecha=' + todayStr()).then(r => {
    if (s) s.textContent = 'Items: ' + (r.stocks === undefined ? '—' : r.stocks);
    if (b) b.textContent = 'Items: ' + (r.barra === undefined ? '—' : r.barra);
    if (c) c.textContent = 'Items: ' + (r.cocina === undefined ? '—' : r.cocina);
    requestAnimationFrame(dibujarFlujoMenu);
  }).catch(() => {});
}
window.addEventListener('resize', dibujarFlujoMenu);
setTimeout(dibujarFlujoMenu, 300);

function irBaseDatos() {
  // Cerrar cualquier modal abierto
  const modalEl = document.getElementById('modal');
  if (modalEl) modalEl.style.display = 'none';
  // Vista de categoría: muestra BLAKBOX fijo en PC (en Android solo se ve en el menú principal)
  document.body.classList.add('en-categoria');
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('container').style.display = 'block';
  document.getElementById('btn-back').style.display = '';
  window.__vista = { cat: 'basedatos' };
  document.querySelectorAll('.tabs-bar').forEach(tb => tb.style.display = 'none');
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  const tab = document.getElementById('tab-basedatos-unificada');
  if (tab) tab.classList.add('active');
  cargarBaseDatosUnificada();
}

const BD_STOPWORDS = ['DE','DEL','LA','EL','LOS','LAS','Y','X','CON','SIN','EN','A','AL','E','O','PEDRO','MANUEL','BOTELLA','BOT','LATA','FRASCO','POTE','PAQUETE','CAJA','SOBRE','ROLLO','BOLSA','BOL'];
function bdNormKey(n) {
  let s = String(n || '').toUpperCase();
  if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(LT|L|ML|CC|G|GR|KG|OZ|ONZAS|UNID|U)?\b/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 1 && !BD_STOPWORDS.includes(w))
    .join(' ');
}

let _bdUnificada = [];
let _bdNoDup = [];
try { _bdNoDup = JSON.parse(localStorage.getItem('bd_no_dup') || '[]'); } catch (e) { _bdNoDup = []; }
function cargarBaseDatosUnificada() {
  const wrap = document.getElementById('bd-unificada-wrap');
  if (!wrap) return;
  // Solo mostrar "Cargando..." la primera vez; si ya hay datos, se actualizan sin borrar la lista
  if (!_bdUnificada.length) wrap.innerHTML = '<p>Cargando...</p>';
  api('GET', '/api/basedatos/unificada').then(data => {
    _bdUnificada = data || [];
    renderBaseDatosUnificada();
  }).catch(err => {
    console.error('Base de datos unificada:', err);
    if (!_bdUnificada.length) wrap.innerHTML = '<p style="color:#c62828;">No se pudo cargar la base de datos: ' + esc(err && err.message ? err.message : 'error desconocido') + '</p>';
  });
}

const _BD_CATEGORIAS = [
  { label: 'AGUAS', test: n => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS/i.test(n) },
  { label: 'GASEOSAS', test: n => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS/i.test(n) },
  { label: 'KOMBUCHAS', test: n => /^KOMBUCHA/i.test(n) },
  { label: 'CERVEZAS', test: n => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(n) },
  { label: 'VINOS', test: n => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|VERMOUTH CINZANO/i.test(n) },
  { label: 'BARRA', test: n => /APEROL X 750ML|BARNIDET CREMA DE PECH|BELLS JUGO CRANBERRY|GINGER ALE EVERVESS|JOSE CUERVO BLANCO|JW RED LABEL|MATACUY DESTILADO|RED BULL|RICADONNA PRO SECO|RON KINGSTON|SALQA CAÑA|VODKA ABSOLUTE|VODKA SMIRNOFF|PISCO PORTON ACHOLADO/i.test(n) },
  { label: 'LACTEOS', test: n => /NESTLE LECHE CONDENSADA|NESTLE - CREMA DE LECHE|LA TABERNA CREMA DE COCO|GLORIA LECHE EVAPORDA|GLORIA LECHE CAJA|LECHE DE COCO|LECHE EVAPORADA DE COCO|LECHE PURA VIDA|BOLSA MANTEQUILLA|CREMA DE COCO|QUESO PARMESANO|GRAN PADANO/i.test(n) },
  { label: 'SERVICIO', test: n => /SERVILLETAS|SCOTCH BRITE|MICROFIBER CLOTHS|NUBE - PAPEL HIGIENICO/i.test(n) },
  { label: 'DELIVERY', test: n => /TUPPER TRANSPARENTE RECTANGULAR|TUPPER REDONDO GRANDES|TUPPER REDONDO CHICO/i.test(n) },
];
function bdCategoria(nombre) {
  for (const c of _BD_CATEGORIAS) { if (c.test(nombre)) return c.label; }
  return 'COCINA';
}

function renderBaseDatosUnificada() {
  const q = (document.getElementById('buscar-bd-unificada')?.value || '').trim().toLowerCase();
  const wrap = document.getElementById('bd-unificada-wrap');
  if (!wrap) return;
  const filtrados = q ? _bdUnificada.filter(x => x.nombre.toLowerCase().includes(q)) : _bdUnificada;
  // Agrupar por nombre (mismo nombre en varias zonas => una sola fila con todas las zonas)
  const grupos = new Map();
  filtrados.forEach(x => {
    const k = x.nombre.trim().toUpperCase();
    if (!grupos.has(k)) grupos.set(k, { nombre: x.nombre, items: [] });
    grupos.get(k).items.push(x);
  });
  // Posibles duplicados: dos NOMBRES distintos que normalizados coinciden (candidatos a unificar)
  const gruposDup = new Map();
  [...grupos.keys()].forEach(k => {
    const gNombre = grupos.get(k).nombre;
    if (_bdNoDup.includes(String(gNombre || '').trim().toUpperCase())) return; // usuario descartó el duplicado
    const nk = bdNormKey(gNombre);
    if (!nk) return;
    if (!gruposDup.has(nk)) gruposDup.set(nk, []);
    gruposDup.get(nk).push(k);
  });
  const esDup = new Set();
  gruposDup.forEach(keys => { if (keys.length > 1) keys.forEach(k => esDup.add(k)); });
  const claves = [...grupos.keys()].sort((a, b) => a.localeCompare(b));
  if (!claves.length) { wrap.innerHTML = '<p>Sin resultados.</p>'; return; }
  // Agrupar los items por título (AGUAS, GASEOSAS, ..., COCINA)
  const porCategoria = new Map();
  claves.forEach(k => {
    const g = grupos.get(k);
    const itCat = g.items.find(x => x.categoria) || g.items[0];
    const label = itCat.categoria || bdCategoria(g.nombre);
    if (!porCategoria.has(label)) porCategoria.set(label, []);
    porCategoria.get(label).push(k);
  });
  let html = '<div style="margin-bottom:0.6rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">'
    + '<button class="btn-guardar-dia" onclick="unificarItemsBaseDatos()" style="width:auto;">🔗 UNIFICAR</button>'
    + '<span style="font-size:0.8rem;color:#888;">Marca los items que son el mismo producto y presiona UNIFICAR (se usará 1 solo nombre en toda la app).</span></div>';
  porCategoria.forEach((ks, label) => {
    html += '<div class="diff-almacen">';
    html += '<div class="diff-header" onclick="toggleAcordeon(this)"><span class="accordion-title">' + label + ' <span style="font-weight:400;font-size:0.85rem;color:#777;">(' + ks.length + ')</span></span><span class="accordion-arrow">▶</span></div>';
    html += '<div class="accordion-body open"><div class="table-wrap"><table><thead><tr><th></th><th>Item</th><th>Zonas</th><th>Unidad Compra</th><th>Precio Compra</th><th>Unidad Venta</th><th>Precio Venta</th><th></th></tr></thead><tbody>';
    ks.forEach(k => {
      const g = grupos.get(k);
      const zonas = [...new Set(g.items.map(x => x.zona))].join(' · ');
      const dup = esDup.has(k);
      // Al unificar, se prioriza mostrar los datos del item de BARRA (luego COCINA, luego STOCKS)
      const primero = g.items.find(x => x.zona === 'BARRA') || g.items.find(x => x.zona === 'COCINA') || g.items[0];
      html += `<tr style="${dup ? 'background:#fff9c4;' : ''}">
        <td><input type="checkbox" class="chk-bd-unificar" data-nombre="${esc(g.nombre)}" title="Marcar para unificar"></td>
        <td>${esc(g.nombre)}${dup ? ' <span class="badge-observacion" style="background:#f57f17;">DUP</span>' : ''}</td>
        <td><span class="badge-zona">${zonas}</span></td>
        <td>${esc(primero.unidad_compra || '—')}</td>
        <td>${primero.precio_compra || 0}</td>
        <td>${esc(primero.unidad_venta || '—')}</td>
        <td>${primero.precio_venta || 0}</td>
        <td style="white-space:nowrap;">
          <button onclick="editarItemBaseDatos('${primero.origen}', ${primero.id})" style="background:#0f3460;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.75rem;">EDITAR</button>
        </td>
      </tr>`;
    });
    html += '</tbody></table></div></div></div>';
  });
  html += '<p style="font-size:0.8rem;color:#666;margin-top:0.5rem;">Total: <strong>' + claves.length + '</strong> items · candidatos a unificar: <strong style="color:#f57f17;">' + esDup.size + '</strong></p>';
  wrap.innerHTML = html;
}

function unificarItemsBaseDatos() {
  const nombres = Array.from(document.querySelectorAll('.chk-bd-unificar:checked')).map(cb => cb.dataset.nombre);
  if (nombres.length < 2) { alert('Selecciona al menos 2 items que sean el mismo producto.'); return; }
  const canonico = prompt('Nombre unificado para estos items (se usará en toda la app):', nombres[0]);
  if (!canonico || !canonico.trim()) return;
  const nombreFinal = canonico.trim();
  const ops = [];
  const vistos = new Set();
  nombres.forEach(n => {
    const nk = String(n || '').trim().toUpperCase();
    if (nk === nombreFinal.trim().toUpperCase() || vistos.has(nk)) return;
    vistos.add(nk);
    const item = _bdUnificada.find(x => x.nombre.trim().toUpperCase() === nk);
    if (item) ops.push(api('POST', '/api/basedatos/renombrar', { origen: item.origen, id: item.id, nombre_anterior: item.nombre, nombre_nuevo: nombreFinal }));
  });
  if (!ops.length) { alert('Nada que unificar (ya tienen el mismo nombre).'); return; }
  Promise.all(ops).then(() => {
    showToast('Unificado como "' + nombreFinal + '"');
    cargarBaseDatosUnificada();
  }).catch(() => alert('Error al unificar'));
}

function irACategoria(cat) {
  // Cerrar cualquier modal abierto para que nunca salte sobre otra vista
  const modalEl = document.getElementById('modal');
  if (modalEl) modalEl.style.display = 'none';
  // La marca BLAKBOX se oculta al navegar SOLO en móvil/Android (CSS por breakpoint)
  document.body.classList.add('en-categoria');
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('container').style.display = 'block';
  document.getElementById('btn-back').style.display = '';
  window.__vista = { cat, tab: null, sub: null, pestana: null };
  // Hide all tabs-bars
  document.querySelectorAll('.tabs-bar').forEach(tb => tb.style.display = 'none');
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  if (cat === 'stocks') {
    document.getElementById('tabs-bar').style.display = '';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="almacenes"]').classList.add('active');
    document.getElementById('tab-almacenes').classList.add('active');
    window.__vista = { cat: 'stocks', tab: 'almacenes' };
  } else {
    const tabsEl = document.getElementById('tabs-' + cat);
    if (tabsEl) tabsEl.style.display = '';
    const tabId = cat === 'ventas' ? 'tab-ventas-central' : 'tab-' + cat;
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if (!_loaded[cat]) {
      _loaded[cat] = true;
      if (cat === 'barra') { cargarRecetas(); cargarStockBarra(); cargarPrecios(); cargarSugerenciasStock(); }
      if (cat === 'cocina') { cargarStockCocina(); cargarRecetasCocina(); cargarPreciosCocina(); }
      if (cat === 'costos') {
        cargarPestanas().then(() => {
          const firstSub = document.querySelector('#tabs-costos .sub-tab[data-subtab]');
          if (firstSub) cambiarSubTab(firstSub.dataset.subtab, 'costos');
        });
        return;
      }
    }
    // Siempre recargar COMPRAS y VENTAS para no perder datos ni mostrar datos viejos
    if (cat === 'compras') { cargarCompras(); }
    if (cat === 'ventas') { cargarVentasCentral(); }
    // Activate first sub-tab for the category
    const firstSub = tabsEl ? tabsEl.querySelector('.sub-tab') : null;
    if (firstSub) cambiarSubTab(firstSub.dataset.subtab, cat);
  }
}
function volverMenu() {
  document.body.classList.remove('en-categoria');
  document.getElementById('main-menu').style.display = '';
  document.getElementById('container').style.display = 'none';
  document.querySelectorAll('.tabs-bar').forEach(tb => tb.style.display = 'none');
  document.getElementById('btn-back').style.display = 'none';
}

const vinosOrder = [
  'Montgrass Merlot 2022',
  'LA CELIA RESERVA MALBEC 2023',
  'PRADOREY CRIANZA 2021',
  'ESCORIHUELA GASCON MALBEC 2023',
  'PRADOREY ORIGEN 2023',
  'MALJUNTA RESERVA CABERNET FRANC 2024',
  'MONTGRASS DE VINE RESERVE CARBERNET SAUVIGNON 2023',
  'CRODERO DI MONTEZEMOLO 2023',
  'MALAJUNTA RESERVA MALBEC 2024',
  'MALAJUNTA RESERVA MALBEC 2023',
  'MALAJUNTA RESERVA CABERNET FRANC 2022',
  'MONTGRASS QUATRO TINTO 2021',
  'CHAMPAGNE VOLLEREAUX RESERVA BRUT',
];

function api(method, url, data) {
  return waitForAuth().then(() => {
    return firebase.auth().currentUser.getIdToken();
  }).then(token => {
    return fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: data ? JSON.stringify(data) : undefined
    }).then(r => {
      if (r.status === 401) { window.location.href = '/login.html'; throw new Error('No autorizado'); }
      if (!r.ok) throw new Error('Error del servidor: ' + r.status);
      return r.json();
    });
  }).catch(err => {
    console.error('API error:', url, err);
    throw err;
  });
}

let _aperturaEditable = false;
function setAperturaEditable(val) {
  _aperturaEditable = !!val;
  const fecha = document.getElementById('fecha-almacenes')?.value;
  if (fecha) cargarAlmacenes(fecha);
  const btn = document.getElementById('btn-toggle-apertura');
  if (btn) {
    btn.textContent = _aperturaEditable ? '🔒 BLOQUEAR APERTURA' : '✏️ EDITAR APERTURA (conteo)';
    btn.style.background = _aperturaEditable ? '#c62828' : '#0f3460';
  }
}

function itemRow(i, a) {
  const obs = (i.stock_observado || 0) > 0 ? ' <span class="badge-observacion" title="En observación (cuarentena): ' + (i.stock_observado || 0) + '">EN OBSERVACIÓN</span>' : '';
  const aperturaReadonly = _aperturaEditable
    ? ''
    : 'readonly title="Apertura fija del día (no editable)" style="background:#f0f0f0;color:#555;cursor:not-allowed;"';
  return `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
    <td>${i.nombre}${obs}</td>
    <td><input type="number" class="input-num input-apertura" value="${i.stock_apertura || 0}" step="0.01" ${aperturaReadonly} oninput="calcCierre(this)"></td>
    <td><input type="number" class="input-num input-ingreso" value="${i.stock_ingreso || 0}" step="0.01" oninput="calcCierre(this)"></td>
    <td><input type="number" class="input-num input-salida" value="${i.salida_almacen || 0}" step="0.01" oninput="calcCierre(this)"></td>
    <td><input type="number" class="input-num input-ventas" value="${i.total_ventas || 0}" step="0.01" oninput="calcCierre(this)"></td>
    <td><input type="number" class="input-num input-falta" value="${i.falta_almacen || 0}" step="0.01" oninput="calcCierre(this)"></td>
    <td><input type="hidden" class="input-baja" value="${i.stock_baja || 0}">
    <td><input type="number" class="input-num input-cierre" value="${i.stock_cierre || 0}" step="0.01" readonly></td>
    <td style="white-space:nowrap">
      <button onclick="editarItemAlmacen(${i.id}, ${a.id})" style="background:#0f3460;color:#fff;border:none;padding:0.2rem 0.4rem;border-radius:3px;cursor:pointer;font-size:0.75rem;">EDITAR</button>
      <button onclick="eliminarItemAlmacen(${i.id}, ${a.id})" style="background:#c62828;color:#fff;border:none;padding:0.2rem 0.4rem;border-radius:3px;cursor:pointer;font-size:0.75rem;">✕</button>
    </td>
  </tr>`;
}

function calcCierre(el) {
  const tr = el.closest('tr');
  const a = parseFloat(tr.querySelector('.input-apertura').value) || 0;
  const i = parseFloat(tr.querySelector('.input-ingreso').value) || 0;
  const s = parseFloat(tr.querySelector('.input-salida').value) || 0;
  const v = parseFloat(tr.querySelector('.input-ventas').value) || 0;
  const f = parseFloat(tr.querySelector('.input-falta')?.value) || 0;
  const b = parseFloat(tr.querySelector('.input-baja')?.value) || 0;
  tr.querySelector('.input-cierre').value = (a + i - s - v - f - b).toFixed(2);
  compararCierre(tr.querySelector('.input-cierre'));
}

function compararCierre(el) {
  const tr = el.closest('tr');
  const a = parseFloat(tr.querySelector('.input-apertura').value) || 0;
  const c = parseFloat(el.value) || 0;
  const e = el.classList;
  e.remove('cierre-verde', 'cierre-amarillo');
  if (c === a && c !== 0) {
    e.add('cierre-verde');
  } else if (c < a) {
    e.add('cierre-amarillo');
  }
}

function normalizeUnit(u) {
  const map = { 'oz': 'onzas', 'onz': 'onzas', 'und': 'unidad', 'unidades': 'unidad', 'gr': 'gramos', 'gramo': 'gramos' };
  return map[u ? u.toLowerCase().trim() : ''] || (u ? u.trim().toLowerCase() : 'unidad');
}
function recargarTodo(fecha) {
  _invCache = { fecha: null, data: null, pending: null };
  cargarAlmacenes(fecha);
  cargarIngresos(fecha);
  cargarSalidas(fecha);
  cargarVentas(fecha);
  cargarBajas(fecha);
  cargarStocks();
}

// --- Búsqueda de Ventas (STOCKS) ---
function cargarSugerenciasBusquedaVentas() {
  const dl = document.getElementById('busqueda-venta-sugerencias');
  if (!dl) return;
  api('GET', '/api/stock/precios/items').then(names => {
    dl.innerHTML = (names || []).map(n => '<option value="' + n.replace(/"/g, '&quot;') + '">').join('');
  }).catch(() => {});
}

function buscarVentas() {
  const item = document.getElementById('busqueda-venta-item')?.value.trim() || '';
  const desde = document.getElementById('busqueda-venta-desde')?.value;
  const hasta = document.getElementById('busqueda-venta-hasta')?.value;
  const cont = document.getElementById('busqueda-ventas-result');
  if (!cont) return;
  if (!desde || !hasta) { cont.innerHTML = '<p>Selecciona las fechas de inicio y fin.</p>'; return; }
  cont.innerHTML = '<p>Cargando...</p>';
  api('GET', '/api/ventas/busqueda?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta) + '&item=' + encodeURIComponent(item)).then(res => {
    if (!res.length) {
      cont.innerHTML = '<p>No se encontraron ventas en ese rango' + (item ? ' para "<b>' + esc(item) + '</b>"' : '') + '.</p>';
      return;
    }
    cont.innerHTML = res.map(g => `
      <div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${esc(g.nombre)} <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${esc(g.almacen_nombre)} — Total: ${g.total}</span></span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          <div class="table-wrap"><table>
            <thead><tr><th>Fecha</th><th>Cantidad Vendida</th><th>Usuario</th></tr></thead>
            <tbody>
              ${g.detalle.map(d => `<tr><td>${d.fecha}</td><td>${d.cantidad}</td><td>${esc(d.saved_by)}</td></tr>`).join('')}
            </tbody>
          </table></div>
        </div>
      </div>`).join('');
  }).catch(() => { cont.innerHTML = '<p>Error al buscar.</p>'; });
}

function exportarBusquedaVentas() {
  const item = document.getElementById('busqueda-venta-item')?.value.trim() || '';
  const desde = document.getElementById('busqueda-venta-desde')?.value;
  const hasta = document.getElementById('busqueda-venta-hasta')?.value;
  if (!desde || !hasta) { alert('Selecciona las fechas'); return; }
  api('GET', '/api/ventas/busqueda?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta) + '&item=' + encodeURIComponent(item)).then(res => {
    const wsData = [['Item', 'Almacén', 'Fecha', 'Cantidad', 'Usuario']];
    res.forEach(g => g.detalle.forEach(d => wsData.push([g.nombre, g.almacen_nombre, d.fecha, d.cantidad, d.saved_by])));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Ventas');
    XLSX.writeFile(libro, 'BusquedaVentas_' + desde + '_' + hasta + '.xlsx');
  }).catch(() => alert('Error al exportar'));
}

// --- Búsqueda de Ventas TOTAL (STOCKS + BARRA + COCINA) en la pestaña VENTAS ---
function cargarSugerenciasBusquedaVentasTotal() {
  const dl = document.getElementById('sugerencias-ventas-total');
  if (!dl) return;
  const desde = document.getElementById('busqueda-ventas-desde');
  const hasta = document.getElementById('busqueda-ventas-hasta');
  if (desde && !desde.value) desde.value = todayStr();
  if (hasta && !hasta.value) hasta.value = todayStr();
  api('GET', '/api/ventas/items-vendidos').then(names => {
    dl.innerHTML = (names || []).map(n => '<option value="' + n.replace(/"/g, '&quot;') + '">').join('');
  }).catch(() => {});
}

function buscarVentasTotal() {
  const item = document.getElementById('busqueda-ventas-item')?.value.trim() || '';
  const desde = document.getElementById('busqueda-ventas-desde')?.value;
  const hasta = document.getElementById('busqueda-ventas-hasta')?.value;
  const cont = document.getElementById('busqueda-ventas-total-result');
  if (!cont) return;
  if (!desde || !hasta) { cont.innerHTML = '<p>Selecciona las fechas de inicio y fin.</p>'; return; }
  cont.innerHTML = '<p>Cargando...</p>';
  api('GET', '/api/ventas/busqueda-total?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta) + '&item=' + encodeURIComponent(item)).then(res => {
    if (!res.length) {
      cont.innerHTML = '<p>No se encontraron ventas en ese rango' + (item ? ' para "<b>' + esc(item) + '</b>"' : '') + '.</p>';
      return;
    }
    const clave = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim().replace(/(\d+)\s+(ML|LT|CC|GR|G|KG|OZ|CL|GL)\b/g, (m, d, u) => d + u).replace(/[*\u2013\-.]+$/g, '').trim();
    // agrupar por item normalizado + destino (+ almacén)
    const grupos = {};
    res.forEach(r => {
      const key = clave(r.nombre) + '|' + r.destino + '|' + (r.almacen_id || '');
      if (!grupos[key]) grupos[key] = { nombre: r.nombre, destino: r.destino, almacen_nombre: r.almacen_nombre || '', detalle: [], total: 0 };
      grupos[key].detalle.push(r);
      grupos[key].total += r.cantidad || 0;
    });
    const keys = Object.keys(grupos).sort();
    cont.innerHTML = '<p style="margin:0.5rem 0;">Ventas encontradas: <b>' + res.length + '</b></p>' +
      keys.map(k => {
        const g = grupos[k];
        const etiqueta = g.destino.toUpperCase() + (g.almacen_nombre ? ' → ' + esc(g.almacen_nombre) : '');
        return `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${esc(g.nombre)} <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${etiqueta} — Total: ${g.total}</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Fecha</th><th>Cantidad</th><th>Usuario</th><th>Hora</th></tr></thead>
              <tbody>
                ${g.detalle.map(r => {
                  const t = r.created_at ? new Date(r.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
                  return `<tr><td>${r.fecha}</td><td>${r.cantidad}</td><td>${esc(r.saved_by)}</td><td>${t}</td></tr>`;
                }).join('')}
              </tbody>
            </table></div>
          </div>
        </div>`;
      }).join('');
  }).catch(() => { cont.innerHTML = '<p>Error al buscar.</p>'; });
}

function exportarBusquedaVentasTotal() {
  const item = document.getElementById('busqueda-ventas-item')?.value.trim() || '';
  const desde = document.getElementById('busqueda-ventas-desde')?.value;
  const hasta = document.getElementById('busqueda-ventas-hasta')?.value;
  if (!desde || !hasta) { alert('Selecciona las fechas'); return; }
  api('GET', '/api/ventas/busqueda-total?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta) + '&item=' + encodeURIComponent(item)).then(res => {
    const wsData = [['Item', 'Destino', 'Almacén', 'Fecha', 'Cantidad', 'Usuario']];
    res.forEach(r => wsData.push([r.nombre, r.destino.toUpperCase(), r.almacen_nombre || '', r.fecha, r.cantidad, r.saved_by]));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Ventas');
    XLSX.writeFile(libro, 'BusquedaVentas_' + desde + '_' + hasta + '.xlsx');
  }).catch(() => alert('Error al exportar'));
}

// --- VENTAS: importar desde Excel ---
let ventasImportRows = [];
let ventasPruebaRows = [];

function onVentasExcelSeleccionado(input) {
  const file = input.files[0];
  if (!file) return;
  parseVentasExcel(file, false);
  input.value = '';
}

function onVentasExcelPruebaSeleccionado(input) {
  const file = input.files[0];
  if (!file) return;
  parseVentasExcel(file, true);
  input.value = '';
}

// Etiquetas que aparecen en EXCEL pero NO son productos vendidos
const NO_PRODUCTO_KEYS = ['subtotal', 'total', 'igv', 'descuento', 'propina', 'vuelto', 'importe', 'caja chica', 'efectivo'];

function esFilaNoProducto(item) {
  const k = String(item || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (!k) return true;
  return NO_PRODUCTO_KEYS.some(e => k === e || k.startsWith(e + ' ') || k.includes(' ' + e) || k.includes(e + ':') || k.endsWith(e));
}

function parseVentasExcel(file, esPrueba) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) { alert('El archivo está vacío'); return; }
      const keys = Object.keys(rows[0]);
      const norm = (k) => String(k || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
      const findKey = (aliases) => keys.find(k => { const n = norm(k); return aliases.some(a => n === a || n.includes(a) || a.includes(n)); });
      const colFecha = findKey(['fecha', 'date', 'dia']);
      const colItem = findKey(['item', 'producto', 'nombre', 'articulo', 'descripcion']);
      const colCant = findKey(['cantidad', 'cant', 'qty', 'und']);
      if (!colItem || !colCant) { alert('No encontré columnas de Item y Cantidad. Usa columnas como: Fecha | Item | Cantidad'); return; }
      const filas = rows.map(r => ({
        item: String(r[colItem] || '').trim(),
        cantidad: parseFloat(String(r[colCant] || '').replace(',', '.')) || 0,
        fecha: document.getElementById('fecha-ventas-menu')?.value || todayStr(),
        destino: ''
      })).filter(x => x.item && x.cantidad > 0 && !esFilaNoProducto(x.item));
      if (esPrueba) { ventasPruebaRows = filas; } else { ventasImportRows = filas; }
      analizarVentas(esPrueba);
    } catch (err) {
      alert('Error al leer el Excel: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

// Analiza los items importados: aplica destinos guardados, predice y pide asignar los nuevos
function analizarVentas(esPrueba) {
  const filas = esPrueba ? ventasPruebaRows : ventasImportRows;
  if (!filas.length) { renderVentasImportPreview(esPrueba); return; }
  Promise.all([
    api('GET', '/api/ventas/import-mapping'),
    api('GET', '/api/ventas/import-match'),
    api('GET', '/api/recetas'),
    api('GET', '/api/cocina/recetas'),
    api('GET', '/api/stock/precios/items'),
    getInventario((filas[0] && filas[0].fecha) || todayStr())
  ]).then(([mapRes, matchRes, barraRec, cocinaRec, stockItems, invData]) => {
    const mapping = (mapRes && mapRes.mapping) || {};
    const match = (matchRes && matchRes.match) || {};
    const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const barraSet = new Set((barraRec || []).map(x => norm(x.nombre)));
    const cocinaSet = new Set((cocinaRec || []).map(x => norm(x.nombre)));
    const stockSet = new Set((stockItems || []).map(n => norm(n)));
    const barraNombres = (barraRec || []).map(x => x.nombre);
    const cocinaNombres = (cocinaRec || []).map(x => x.nombre);
    const stocksPorNombre = {};
    (invData || []).forEach(a => {
      (a.items || []).forEach(it => {
        if (esBasura(it.nombre)) return;
        const k = norm(it.nombre);
        if (!stocksPorNombre[k]) stocksPorNombre[k] = [];
        stocksPorNombre[k].push({ almacen_id: a.id, almacen_nombre: a.nombre, cantidad: it.stock_cierre !== undefined && it.stock_cierre !== null ? it.stock_cierre : (it.stock_apertura || 0) });
      });
    });
    window._ventasImportStocks = stocksPorNombre;
    const stockNombres = (stockItems || []).filter(n => !esBasura(n));
    const uniq = {};
    filas.forEach(r => {
      const k = norm(r.item);
      if (!uniq[k]) uniq[k] = { nombre: r.item, cantidad: 0 };
      uniq[k].cantidad += r.cantidad;
    });
    const items = Object.values(uniq).map((i, idx) => { i.idx = idx; return i; });
    // Busca el mejor candidato existente (COCINA/BARRA/STOCKS) por similitud de nombre
    const mejorCandidato = (nombre) => {
      const pool = [
        ...(cocinaNombres || []).map(n => ({ n, zona: 'cocina' })),
        ...(barraNombres || []).map(n => ({ n, zona: 'barra' })),
        ...(stockNombres || []).filter(n => !esBasura(n)).map(n => ({ n, zona: 'stocks' })),
      ];
      let best = null, bestS = 0;
      pool.forEach(p => { const s = similitud(nombre, p.n); if (s > bestS) { bestS = s; best = p; } });
      return best && bestS >= 0.6 ? { ...best, score: bestS } : null;
    };
    const nuevos = [];
    items.forEach(i => {
      const k = norm(i.nombre);
      const fuzzy = mejorCandidato(i.nombre);
      // Destino: mapeo guardado > coincidencia exacta > coincidencia difusa
      if (mapping[k]) { i.destino = mapping[k]; }
      else if (cocinaSet.has(k)) i.destino = 'cocina';
      else if (barraSet.has(k)) i.destino = 'barra';
      else if (stockSet.has(k)) i.destino = 'stocks';
      else i.destino = (fuzzy ? fuzzy.zona : 'stocks');
      // Emparejamiento: nombre del Excel ya mapeado a un item/receta real de la app
      const m = match[k];
      const esSelf = m && norm(m) === k;
      const mValido = m && ((i.destino === 'cocina' && cocinaSet.has(norm(m))) ||
                            (i.destino === 'barra' && barraSet.has(norm(m))) ||
                            (i.destino === 'stocks' && stockSet.has(norm(m))));
      if (m && !esSelf && mValido) {
        i.matched = m;
        i.emparejado = true;
      } else if ((i.destino === 'cocina' && cocinaSet.has(k)) ||
                 (i.destino === 'barra' && barraSet.has(k)) ||
                 (i.destino === 'stocks' && stockSet.has(k) && !esBasura(i.nombre))) {
        i.matched = i.nombre;
        i.emparejado = true;
      } else if (fuzzy && fuzzy.zona === i.destino && fuzzy.score >= 0.6) {
        i.matched = fuzzy.n;
        i.emparejado = true;
      } else {
        i.sinEmparejar = true;
        i.nuevo = true;
        nuevos.push(i);
      }
      if (!i.emparejado && !i.sinEmparejar) i.matched = i.nombre;
    });
    const byKey = {};
    items.forEach(i => { byKey[norm(i.nombre)] = i; });
    filas.forEach(r => { const i = byKey[norm(r.item)]; if (i) { r.destino = i.destino; r.matched = i.matched || i.nombre; } });
    window._ventasImportCtx = { barraNombres, cocinaNombres, stockNombres };
    window._ventasImportFecha = (filas[0] && filas[0].fecha) || todayStr();
    renderVentasAsignacion(items, esPrueba ? 'ventas-import-prueba-preview' : 'ventas-import-preview');
  }).catch(() => { renderVentasImportPreview(esPrueba); });
}

// Vista inline (sin modal) para asignar destino y emparejar items
function renderVentasAsignacion(items, containerId) {
  const cont = document.getElementById(containerId);
  if (!cont) return;
  if (!items.length) { cont.innerHTML = '<p style="color:#888;margin-top:0.5rem;">Sube un Excel para ver los items.</p>'; return; }
  const ctx = window._ventasImportCtx || { barraNombres: [], cocinaNombres: [], stockNombres: [] };
  const total = items.reduce((s, i) => s + i.cantidad, 0);
  const fecha = window._ventasImportFecha || todayStr();
  const radios = (i) => ['stocks', 'barra', 'cocina'].map(d => {
    const checked = (i.destino || 'stocks') === d ? ' checked' : '';
    return '<label style="display:inline-flex;align-items:center;gap:0.25rem;margin-right:0.75rem;font-size:0.85rem;cursor:pointer;"><input type="radio" name="dest-prueba-' + i.idx + '" value="' + d + '"' + checked + ' onchange="onPruebaDestinoChange(this)"> ' + d.toUpperCase() + '</label>';
  }).join('');
  const emparejar = (i) => {
    if (i.emparejado) return '<span style="color:#2e7d32;">✓ ' + esc(i.matched) + '</span><input type="hidden" class="match-ya" value="' + esc(i.matched) + '">';
    const candidatos = candidatosTodos(i.nombre, i.destino);
    const opts = candidatos.map(c => '<option value="' + esc(c.n) + '" data-zona="' + c.zona + '">' + esc(c.n) + ' (' + c.zona + ')</option>').join('') +
      '<option value="__excel__">Usar nombre del Excel</option>' +
      '<option value="__nuevo__">Crear nuevo' + (i.destino === 'barra' || i.destino === 'cocina' ? ' (receta)' : '') + '</option>';
    return '<select class="select-match-import" data-item="' + esc(i.nombre) + '" onchange="onMatchSelectChange(this)">' +
      '<option value="">— Emparejar —</option>' + opts + '</select>' +
      '<input class="input-match-nuevo" data-item="' + esc(i.nombre) + '" placeholder="Nombre nuevo..." style="display:none;margin-top:0.3rem;padding:0.3rem;border:1px solid #ccc;border-radius:4px;width:90%;">';
  };
  const almacen = (i) => {
    if (i.destino !== 'stocks') return '<td style="color:#999;">—</td>';
    const nombre = i.matched || i.nombre;
    return '<td class="celda-almacen">' + buildAlmacenSelect(nombre) + '</td>';
  };
  cont.innerHTML = '<p style="margin:0.5rem 0;">Fecha: <b>' + fecha + '</b> — Items: <b>' + items.length + '</b> — Total unidades: <b>' + total + '</b></p>' +
    '<div class="table-wrap"><table><thead><tr><th>Item (Excel)</th><th>Cantidad</th><th>Destino</th><th>Emparejar con</th><th>Almacén (STOCKS)</th></tr></thead><tbody>' +
    items.map(i => `<tr>
      <td>${esc(i.nombre)}${i.sinEmparejar ? ' <span style="color:#c62828;" title="Sin emparejar">*</span>' : ''}</td>
      <td>${i.cantidad}</td>
      <td>${radios(i)}</td>
      <td>${emparejar(i)}</td>
      ${almacen(i)}
    </tr>`).join('') +
    '</tbody></table></div>' +
    '<p style="font-size:0.8rem;color:#999;margin:0.5rem 0 0;">* Sin emparejar: elige a qué item/receta de la app corresponde. Se guardará y la próxima vez se aplicará solo.</p>';
}

function onMatchSelectChange(sel) {
  const input = sel.parentElement.querySelector('.input-match-nuevo');
  if (input) input.style.display = sel.value === '__nuevo__' ? '' : 'none';
  const option = sel.selectedOptions && sel.selectedOptions[0];
  const zona = option ? option.dataset.zona : '';
  if (zona) {
    const radio = sel.closest('tr').querySelector('input[type="radio"][value="' + zona.toLowerCase() + '"]');
    if (radio) radio.checked = true;
  }
  actualizarAlmacenImport(sel.closest('tr'));
}

function onPruebaDestinoChange(radio) {
  const tr = radio.closest('tr');
  const itemNombre = tr.querySelector('td') ? tr.querySelector('td').textContent.replace(/ *\*?$/, '').trim() : '';
  const candidatos = candidatosTodos(itemNombre, radio.value);
  const sel = tr.querySelector('.select-match-import');
  if (!sel) return;
  const opts = candidatos.map(c => '<option value="' + esc(c.n) + '" data-zona="' + c.zona + '">' + esc(c.n) + ' (' + c.zona + ')</option>').join('') +
    '<option value="__excel__">Usar nombre del Excel</option>' +
    '<option value="__nuevo__">Crear nuevo' + (radio.value === 'barra' || radio.value === 'cocina' ? ' (receta)' : '') + '</option>';
  sel.innerHTML = '<option value="">— Emparejar —</option>' + opts;
  const input = tr.querySelector('.input-match-nuevo');
  if (input) input.style.display = 'none';
  actualizarAlmacenImport(tr);
}

// Nombres basura que vienen del EXCEL (artefactos) y no deben auto-emparejarse en STOCKS
function esBasura(nombre) {
  const n = String(nombre || '').trim();
  if (!n) return true;
  if (n.includes('*')) return true;
  if (/[.\u2013]$/.test(n)) return true;
  if (n.endsWith('-')) return true;
  return false;
}

// Similitud por palabras (ignora símbolos y palabras vacías)
const STOPWORDS = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'CON', 'POR', 'PARA', 'Y', 'A', 'AL', 'UN', 'UNA', 'X', 'ML', 'LT', 'L', 'KG', 'GR', 'S', 'C', 'G']);
function tokensDe(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\*/g, ' ')
    .split(/[^A-Z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = [];
  for (let i = 0; i <= m; i++) dp[i] = [i];
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similitud(a, b) {
  const ta = tokensDe(a);
  const tb = tokensDe(b);
  if (!ta.length || !tb.length) return 0;
  let hits = 0;
  ta.forEach(w => {
    if (tb.some(t => w === t ||
      (w.length >= 3 && t.length >= 3 && (w.startsWith(t) || t.startsWith(w))) ||
      (w.length >= 4 && t.length >= 4 && levenshtein(w, t) <= 1))) hits++;
  });
  return hits / Math.max(1, tb.length);
}

// Candidatos del GRUPO elegido (STOCKS/BARRA/COCINA) según el destino seleccionado
function candidatosTodos(nombre, destino) {
  const ctx = window._ventasImportCtx || { barraNombres: [], cocinaNombres: [], stockNombres: [] };
  const pool = [];
  if (destino === 'barra') {
    (ctx.barraNombres || []).forEach(n => pool.push({ n, zona: 'BARRA' }));
  } else if (destino === 'cocina') {
    (ctx.cocinaNombres || []).forEach(n => pool.push({ n, zona: 'COCINA' }));
  } else {
    (ctx.stockNombres || []).forEach(n => { if (!esBasura(n)) pool.push({ n, zona: 'STOCKS' }); });
  }
  const scored = pool.map(p => ({ p, s: similitud(nombre, p.n) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 15).map(x => x.p);
  return scored;
}

// Selector de almacén para items de STOCKS (muestra cuántos hay en cada almacén)
function buildAlmacenSelect(nombre) {
  const stocks = window._ventasImportStocks || {};
  const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const list = stocks[norm(nombre)] || [];
  if (!list.length) return '<span style="color:#c62828;">Sin stock</span>';
  return '<select class="select-almacen-import" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;">' +
    list.map(al => '<option value="' + al.almacen_id + '">' + esc(al.almacen_nombre) + ' (' + al.cantidad + ')</option>').join('') + '</select>';
}

function actualizarAlmacenImport(tr) {
  const cell = tr.querySelector('.celda-almacen');
  if (!cell) return;
  const radio = tr.querySelector('input[type="radio"]:checked');
  const destino = radio ? radio.value : 'stocks';
  if (destino !== 'stocks') { cell.innerHTML = '<span style="color:#999;">—</span>'; return; }
  const sel = tr.querySelector('.select-match-import');
  let nombre = tr.querySelector('td') ? tr.querySelector('td').textContent.replace(/ *\*?$/, '').trim() : '';
  if (sel && sel.value && sel.value !== '__excel__' && sel.value !== '__nuevo__') nombre = sel.value;
  cell.innerHTML = buildAlmacenSelect(nombre);
}

function guardarVentasPrueba() {
  if (!ventasPruebaRows.length) { alert('Primero selecciona un Excel con ventas'); return; }
  guardarVentasAsignadas('ventas-import-prueba-preview', ventasPruebaRows, () => {
    ventasPruebaRows = [];
    renderVentasAsignacion([], 'ventas-import-prueba-preview');
  });
}

function guardarVentasReal() {
  if (!ventasImportRows.length) { alert('Primero selecciona un Excel con ventas'); return; }
  guardarVentasAsignadas('ventas-import-preview', ventasImportRows, () => {
    ventasImportRows = [];
    renderVentasAsignacion([], 'ventas-import-preview');
  });
}

function guardarVentasAsignadas(containerId, filas, onDone) {
  const ctx = window._ventasImportCtx || { barraNombres: [], cocinaNombres: [], stockNombres: [] };
  const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const barraSet = new Set(ctx.barraNombres.map(n => norm(n)));
  const cocinaSet = new Set(ctx.cocinaNombres.map(n => norm(n)));
  const stockSet = new Set((ctx.stockNombres || []).map(n => norm(n)));
  const match = {};
  const mapping = {};
  const almacenes = {};
  const recetasNuevas = [];
  const recetasCreadas = new Set();
  const sinEmparejar = [];
  document.querySelectorAll('#' + containerId + ' tbody tr').forEach(tr => {
    const itemNombre = tr.querySelector('td') ? tr.querySelector('td').textContent.replace(/ *\*?$/, '').trim() : '';
    if (!itemNombre) return;
    const destinoRadio = tr.querySelector('input[type="radio"]:checked');
    const destino = destinoRadio ? destinoRadio.value : 'stocks';
    const ya = tr.querySelector('.match-ya');
    const sel = tr.querySelector('.select-match-import');
    const inputNuevo = tr.querySelector('.input-match-nuevo');
    const alSel = tr.querySelector('.select-almacen-import');
    let matched = itemNombre;
    if (ya) {
      matched = ya.value;
    } else if (sel) {
      if (sel.value === '__nuevo__') {
        matched = (inputNuevo && inputNuevo.value.trim()) || itemNombre;
        const nk = norm(matched);
        const pool = destino === 'barra' ? (ctx.barraNombres || []) : (destino === 'cocina' ? (ctx.cocinaNombres || []) : []);
        const exacto = pool.find(n2 => norm(n2) === nk);
        const similar = exacto ? null : (candidatosTodos(matched, destino).find(c => similitud(matched, c.n) >= 0.6) || null);
        if (exacto) {
          // Ya existe la receta: emparejar, NO crear duplicado
          matched = exacto;
        } else if (similar) {
          // Existe una receta muy parecida: emparejar con ella en vez de crear
          matched = similar.n;
        } else if (destino === 'barra') {
          const key = 'B:' + nk;
          if (!barraSet.has(nk) && !recetasCreadas.has(key)) { recetasNuevas.push({ nombre: matched, tipo: 'barra' }); recetasCreadas.add(key); }
        } else if (destino === 'cocina') {
          const key = 'C:' + nk;
          if (!cocinaSet.has(nk) && !recetasCreadas.has(key)) { recetasNuevas.push({ nombre: matched, tipo: 'cocina' }); recetasCreadas.add(key); }
        }
      } else if (sel.value && sel.value !== '__excel__') {
        matched = sel.value;
      } else {
        // Sin emparejar o "usar nombre del Excel" en STOCKS sin item existente → bloquear
        if (!sel.value || (sel.value === '__excel__' && destino === 'stocks' && !stockSet.has(norm(itemNombre)))) {
          sinEmparejar.push(itemNombre);
        }
      }
    }
    match[norm(itemNombre)] = matched;
    mapping[norm(itemNombre)] = destino;
    if (destino === 'stocks' && alSel && alSel.value) almacenes[norm(itemNombre)] = Number(alSel.value);
  });
  if (sinEmparejar.length) {
    alert('Debes emparejar estos items antes de guardar (elige el item de la app):\n\n- ' + sinEmparejar.join('\n- '));
    return;
  }
  if (!Object.keys(mapping).length) { alert('No hay items para guardar'); return; }
  filas.forEach(r => {
    const k = norm(r.item);
    if (mapping[k]) r.destino = mapping[k];
    if (match[k]) r.matched = match[k];
    if (almacenes[k]) r.almacenes = [almacenes[k]];
  });
  const crearRecetas = recetasNuevas.map(rec => {
    return (rec.tipo === 'barra'
      ? api('POST', '/api/recetas', { nombre: rec.nombre, categoria: 'Clásicos' })
      : api('POST', '/api/cocina/recetas', { nombre: rec.nombre, categoria: 'PLATOS' }))
      .then(res => ({ pedido: rec.nombre, real: (res && res.nombre) || rec.nombre }));
  });
  Promise.all(crearRecetas)
    .then(resps => {
      // Corregir el match para que apunte a la receta REAL (si el servidor deduplicó o renombró)
      resps.forEach(r => {
        if (norm(r.real) === norm(r.pedido)) return;
        Object.keys(match).forEach(mk => { if (norm(match[mk]) === norm(r.pedido)) match[mk] = r.real; });
      });
      return api('POST', '/api/ventas/import-match', { match });
    })
    .then(() => api('POST', '/api/ventas/import-mapping', { mapping }))
    .then(() => { registrarVentasFilas(filas, onDone); })
    .catch(() => alert('Error al guardar'));
}

function limpiarVentasImport() {
  ventasImportRows = [];
  renderVentasAsignacion([], 'ventas-import-preview');
}

function limpiarVentasPrueba() {
  ventasPruebaRows = [];
  renderVentasAsignacion([], 'ventas-import-prueba-preview');
}

function mostrarModalAsignarVentas(items, esPrueba) {
  const body = document.getElementById('modal-body');
  const radios = (i) => ['stocks', 'barra', 'cocina'].map(d => {
    const checked = (i.destino || 'stocks') === d ? ' checked' : '';
    const nombre = 'dest-import-' + i.idx;
    return '<label style="display:inline-flex;align-items:center;gap:0.25rem;margin-right:0.75rem;font-size:0.85rem;cursor:pointer;"><input type="radio" name="' + nombre + '" value="' + d + '"' + checked + '> ' + d.toUpperCase() + '</label>';
  }).join('');
  body.innerHTML = `
    <h3>Asignar destino de ventas</h3>
    <p style="color:#666;font-size:0.85rem;">Fecha de registro: <b>${todayStr()}</b>. Marca a qué zona van las ventas de cada item.${esPrueba ? ' <b>(PRUEBA: no se guarda ni se registra)</b>' : ' Los destinos se guardan y la próxima vez aparecerán marcados automáticamente.'}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>STOCKS</th><th>BARRA</th><th>COCINA</th></tr></thead>
      <tbody>
        ${items.map(i => `<tr>
          <td>${esc(i.nombre)}${i.nuevo ? ' <span style="color:#c62828;" title="Item nuevo">*</span>' : ''}</td>
          <td colspan="3">${radios(i)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p style="font-size:0.8rem;color:#999;margin:0.5rem 0 0;">* Item nuevo (nunca asignado antes). Los demás ya tienen destino guardado.</p>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="guardarAsignacionVentas(${esPrueba})" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar destinos</button>
      <button onclick="cerrarModal(); renderVentasImportPreview(${esPrueba});" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>`;
  document.getElementById('modal').style.display = 'block';
}

function guardarAsignacionVentas(esPrueba) {
  const mapping = {};
  document.querySelectorAll('#modal-body tbody input[type="radio"]:checked').forEach(radio => {
    const tr = radio.closest('tr');
    const itemNombre = tr.querySelector('td') ? tr.querySelector('td').textContent.replace(/ *\*?$/, '').trim() : '';
    if (itemNombre) mapping[itemNombre.toUpperCase().replace(/\s+/g, ' ')] = radio.value;
  });
  const aplicar = () => {
    cerrarModal();
    const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const filas = esPrueba ? ventasPruebaRows : ventasImportRows;
    filas.forEach(r => { const k = norm(r.item); if (mapping[k]) r.destino = mapping[k]; });
    renderVentasImportPreview(esPrueba);
  };
  if (esPrueba) {
    aplicar();
    showToast('Destinos aplicados (prueba)');
    return;
  }
  api('POST', '/api/ventas/import-mapping', { mapping }).then(() => {
    aplicar();
    showToast('Destinos guardados');
  }).catch(() => alert('Error al guardar destinos'));
}

function normalizarFechaExcel(val) {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0');
    return '';
  }
  let s = String(val).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m) {
    let d = parseInt(m[1]), mo = parseInt(m[2]);
    if (d > 12) { const t = d; d = mo; mo = t; }
    return m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  return s;
}

function renderVentasImportPreview(esPrueba) {
  const cont = document.getElementById(esPrueba ? 'ventas-import-prueba-preview' : 'ventas-import-preview');
  const filas = esPrueba ? ventasPruebaRows : ventasImportRows;
  if (!cont) return;
  if (!filas.length) { cont.innerHTML = '<p style="color:#888;margin-top:0.5rem;">No se detectaron filas válidas (item con cantidad).</p>'; return; }
  const total = filas.reduce((s, r) => s + r.cantidad, 0);
  const sinFecha = filas.filter(r => !r.fecha).length;
  cont.innerHTML = '<p style="margin:0.5rem 0;">Filas detectadas: <b>' + filas.length + '</b> — Total unidades: <b>' + total + '</b>' +
    (sinFecha ? ' — <span style="color:#c62828;">' + sinFecha + ' sin fecha (usarán la fecha seleccionada)</span>' : '') + '</p>' +
    '<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Item</th><th>Cantidad</th><th>Destino</th></tr></thead><tbody>' +
    filas.map(r => '<tr><td>' + (r.fecha || '—') + '</td><td>' + esc(r.item) + '</td><td>' + r.cantidad + '</td><td>' + (r.destino ? r.destino.toUpperCase() : '—') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

// Registra un conjunto de filas de ventas agrupándolas por fecha + destino
function registrarVentasFilas(filas, onDone) {
  const fechaDefault = document.getElementById('fecha-ventas-menu')?.value || todayStr();
  const grupos = {};
  filas.forEach(r => {
    const fecha = r.fecha || fechaDefault;
    const destino = r.destino || 'stocks';
    const key = fecha + '|' + destino;
    if (!grupos[key]) grupos[key] = [];
    grupos[key].push({ nombre: r.matched || r.item, cantidad: r.cantidad, destino, almacenes: r.almacenes });
  });
  const keys = Object.keys(grupos);
  if (!keys.length) { if (onDone) onDone(); return; }
  if (!confirm('¿Registrar ' + filas.length + ' ventas (' + keys.length + ' grupos por fecha/destino)?')) return;
  let idx = 0;
  let noEncontrados = 0;
  function procesar() {
    if (idx >= keys.length) {
      showToast('Ventas registradas' + (noEncontrados ? ' (' + noEncontrados + ' no encontrados)' : ''));
      if (onDone) onDone();
      cargarVentasCentral();
      _invCache = { fecha: null, data: null, pending: null };
      actualizarContadoresMenu();
      return;
    }
    const key = keys[idx++];
    const partes = key.split('|');
    const fecha = partes[0];
    const destino = partes[1];
    const items = grupos[key];
    api('POST', '/api/ventas/guardar', { fecha, items }).then(r => {
      noEncontrados += (r.resumen && r.resumen.noEncontrados) ? r.resumen.noEncontrados.length : 0;
      procesar();
    }).catch(() => {
      alert('Error registrando las ventas de ' + fecha);
    });
  }
  procesar();
}

function guardarDia() {
  const fecha = document.getElementById('fecha-almacenes').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const registros = [];
  document.querySelectorAll('#accordion-almacenes .accordion-item').forEach(item => {
    const almacenId = parseInt(item.dataset.almacenId);
    item.querySelectorAll('tr[data-item-id]').forEach(tr => {
      const itemId = parseInt(tr.dataset.itemId);
      registros.push({
        item_id: itemId,
        almacen_id: almacenId,
        stock_apertura: parseFloat(tr.querySelector('.input-apertura').value) || 0,
        stock_ingreso: parseFloat(tr.querySelector('.input-ingreso').value) || 0,
        salida_almacen: parseFloat(tr.querySelector('.input-salida').value) || 0,
        total_ventas: parseFloat(tr.querySelector('.input-ventas').value) || 0,
        falta_almacen: parseFloat(tr.querySelector('.input-falta').value) || 0,
        stock_baja: parseFloat(tr.querySelector('.input-baja').value) || 0,
        stock_cierre: parseFloat(tr.querySelector('.input-cierre').value) || 0,
      });
    });
  });
  const btn = document.querySelector('.btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  api('POST', '/api/almacenes/guardar-dia', { fecha, registros, saved_by: currentUserName }).then(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR';
    showToast('Datos Guardados');
    recargarTodo(fecha);
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR';
    alert('Error al guardar');
  });
}

function cargarAlmacenes(fecha) {
  const openIds = [];
  document.querySelectorAll('.accordion-item .accordion-body.open').forEach(body => {
    const item = body.closest('.accordion-item');
    if (item) openIds.push(item.dataset.almacenId);
  });
  // Preservar los valores ya escritos en los inputs (para no perder datos al re-renderizar al buscar)
  const valores = {};
  document.querySelectorAll('#accordion-almacenes tr[data-item-id]').forEach(tr => {
    const key = tr.dataset.almacenId + '_' + tr.dataset.itemId;
    const obj = {};
    tr.querySelectorAll('input').forEach(inp => {
      const cls = (inp.className || '').split(' ').find(c => c.startsWith('input-'));
      if (cls) obj[cls] = inp.value;
    });
    valores[key] = obj;
  });
  if (!fecha) fecha = document.getElementById('fecha-almacenes').value;
  getInventario(fecha).then(data => {
    // Si hay una busqueda activa, NO ocultar los items con stock 0 (para encontrarlos y evitar duplicados)
    const buscarTerm = (document.getElementById('buscar-item')?.value || '').trim();
    if (_ocultarCero && !buscarTerm) {
      data.forEach(a => { a.items = (a.items || []).filter(i => (i.stock_apertura || 0) !== 0 || (i.stock_cierre || 0) !== 0); });
    }
    const categoriasPorAlmacen = {
      1: [
        { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
        { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
        { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
        { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|PROTOS/i.test(i.nombre) },
      ],
    };
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
      { label: 'KOMBUCHAS', test: i => /^KOMBUCHA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|VERMOUTH CINZANO|PROSECCO/i.test(i.nombre) && !/^VINO CLOS CBERNET/i.test(i.nombre) },
      { label: 'BARRA', test: i => /APEROL X 750ML|BARNIDET CREMA DE PECH|BELLS JUGO CRANBERRY|GINGER ALE EVERVESS|JOSE CUERVO BLANCO|JW RED LABEL|MATACUY DESTILADO|RED BULL|RICADONNA PRO SECO|RON KINGSTON|SALQA CAÑA|VODKA ABSOLUTE|VODKA SMIRNOFF|PISCO PORTON ACHOLADO/i.test(i.nombre) },
      { label: 'LACTEOS', test: i => /NESTLE LECHE CONDENSADA|NESTLE - CREMA DE LECHE|LA TABERNA CREMA DE COCO|GLORIA LECHE EVAPORDA|GLORIA LECHE CAJA|LECHE DE COCO|LECHE EVAPORADA DE COCO|LECHE PURA VIDA|BOLSA MANTEQUILLA|CREMA DE COCO|QUESO PARMESANO|GRAN PADANO/i.test(i.nombre) },
      { label: 'SERVICIO', test: i => /SERVILLETAS|SCOTCH BRITE|MICROFIBER CLOTHS|NUBE - PAPEL HIGIENICO/i.test(i.nombre) },
      { label: 'DELIVERY', test: i => /TUPPER TRANSPARENTE RECTANGULAR|TUPPER REDONDO GRANDES|TUPPER REDONDO CHICO/i.test(i.nombre) },
    ];
    data = data.map(a => {
      const categorias = categoriasPorAlmacen[a.id] || defaultCategorias;
      const usado = new Set();
      const secciones = categorias.map(cat => {
        const items = a.items.filter(i => cat.test(i) && !usado.has(i.id)).sort((x, y) => {
          const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
          const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
          if (xg !== yg) return xg - yg;
          if (cat.label === 'VINOS' && a.id === 2) {
            const xi = vinosOrder.indexOf(x.nombre);
            const yi = vinosOrder.indexOf(y.nombre);
            return (xi === -1 ? 999 : xi) - (yi === -1 ? 999 : yi);
          }
          return x.nombre.localeCompare(y.nombre);
        });
        items.forEach(i => usado.add(i.id));
        return { ...cat, items };
      });
      // La categoria explicita del item tiene prioridad sobre la seccion inferida por nombre
      secciones.forEach(s => {
        s.items = s.items.filter(i => {
          if (i.categoria) {
            const target = secciones.find(ss => ss.label.toUpperCase() === String(i.categoria).toUpperCase());
            if (target && target !== s) { target.items.push(i); return false; }
          }
          return true;
        });
      });
      let otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
      if (otros.length) {
        otros = otros.filter(i => {
          if (i.categoria) {
            const cat = secciones.find(s => s.label.toUpperCase() === i.categoria.toUpperCase());
            if (cat) { cat.items.push(i); return false; }
          }
          return true;
        });
      }
      return { ...a, secciones, otros };
    });
    const container = document.getElementById('accordion-almacenes');
    container.innerHTML = data.map(a => `
      <div class="accordion-item" data-almacen-id="${a.id}">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${a.nombre}</span>
          <span class="accordion-actions" onclick="event.stopPropagation()">
            <button onclick="exportarAlmacen(${a.id})">Exportar</button>
          </span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          ${a.items.length ? `
            <div class="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Stock Total Apertura</th><th>Ingreso</th><th>Salida Almacén</th><th>Total Ventas</th><th>Falta</th><th>Stock Total Cierre</th><th></th></tr></thead>
              <tbody>
                ${a.secciones.map(s => s.items.length ? `
                  <tr class="section-header"><td colspan="8">— ${s.label} —</td></tr>
                  ${s.items.map(i => itemRow(i, a)).join('')}
                ` : '').join('')}
                ${a.otros.length ? `
                  <tr class="section-header"><td colspan="8">— ${a.id === 3 ? 'CAFE' : (a.id === 1 ? 'KOMBUCHAS' : 'COCINA')} —</td></tr>
                  ${a.otros.map(i => itemRow(i, a)).join('')}
                ` : ''}
              </tbody>
            </table>
            </div>
          ` : '<p class="sin-items">Este almacén no tiene items.</p>'}
          <button class="btn-agregar-item" onclick="agregarItemAlmacen(${a.id}, '${a.nombre}')">+ Agregar Item</button>
        </div>
      </div>
    `).join('');
    const ba = document.getElementById('buscar-item');
    if (ba && ba.value) buscarEnTabla(ba.value, 'accordion-almacenes');
    container.querySelectorAll('tr[data-item-id]').forEach(tr => {
      const el = tr.querySelector('.input-apertura');
      if (el) { try { calcCierre(el); } catch (e) { console.error('calcCierre:', e); } }
    });
    openIds.forEach(id => {
      const item = container.querySelector(`.accordion-item[data-almacen-id="${id}"]`);
      if (item) {
        item.querySelector('.accordion-body').classList.add('open');
        item.querySelector('.accordion-arrow').classList.add('open');
        item.querySelector('.accordion-header').classList.add('active');
      }
    });
    // Restaurar los valores editados (por si hubo re-render al buscar)
    Object.entries(valores).forEach(([key, obj]) => {
      const [al, item] = key.split('_');
      const tr = container.querySelector(`tr[data-item-id="${item}"][data-almacen-id="${al}"]`);
      if (!tr) return;
      Object.entries(obj).forEach(([cls, val]) => {
        const inp = tr.querySelector('input.' + cls);
        if (inp && val !== '') inp.value = val;
      });
    });
  });
}

// Busqueda en ALMACENES: al iniciar o limpiar la busqueda se re-renderiza la lista para que los
// items con stock 0 aparezcan (o se oculten) y evitar crear duplicados por no verlos.
let _buscarAlmacenTerm = '';
function buscarItemAlmacen(value) {
  const term = (value || '').trim();
  const cambioEstado = (_buscarAlmacenTerm === '') !== (term === '');
  _buscarAlmacenTerm = term;
  if (cambioEstado) cargarAlmacenes();
  else buscarEnTabla(term, 'accordion-almacenes');
}

function toggleAcordeon(header) {
  header.classList.toggle('active');
  header.nextElementSibling.classList.toggle('open');
  header.querySelector('.accordion-arrow').classList.toggle('open');
}

async function agregarItemAlmacen(almacenId, almacenNombre) {
  let sugerencias = [];
  try {
    const data = await getInventario(todayStr());
    const seen = new Set();
    data.forEach(al => (al.items || []).forEach(it => {
      if (it.nombre && !seen.has(it.nombre)) { seen.add(it.nombre); sugerencias.push(it.nombre); }
    }));
  } catch (e) { console.error('Error cargando sugerencias:', e); }
  showModal('item-almacen', { almacenId, almacenNombre, sugerencias });
}

function editarItemAlmacen(itemId, almacenId) {
  const tr = document.querySelector(`tr[data-item-id="${itemId}"][data-almacen-id="${almacenId}"]`);
  if (!tr) return;
  const nombre = tr.querySelector('td:first-child').textContent;
  // Try to find categoria from section header
  let categoria = '';
  const section = tr.closest('.accordion-item');
  if (section) {
    const header = section.querySelector('.accordion-title');
    const almacenNombre = header ? header.textContent.trim() : '';
    // Look up the section header row before this item
    let prev = tr.previousElementSibling;
    while (prev) {
      if (prev.classList.contains('section-header')) {
        const label = prev.querySelector('td')?.textContent?.replace(/[—\s]/g, '') || '';
        const cats = ['VINOS','AGUAS','GASEOSAS','CERVEZAS','KOMBUCHAS','LECHES'];
        const found = cats.find(c => label.toUpperCase().includes(c));
        if (found) { categoria = found; break; }
      }
      prev = prev.previousElementSibling;
    }
  }
  const sectionItem = tr.closest('.accordion-item');
  const almacenNombre = sectionItem ? sectionItem.querySelector('.accordion-title')?.textContent?.trim() || '' : '';
  showModal('editar-item-almacen', { itemId, almacenId, nombre, categoria, almacenNombre });
}

async function guardarItemAlmacen() {
  const nombre = document.getElementById('f-nombre-item').value.trim();
  const almacen_id = parseInt(document.getElementById('f-almacen_id').value);
  const categoria = document.getElementById('f-categoria-item').value;
  const cantidad = parseFloat(document.getElementById('f-cantidad').value) || 0;
  const nota = document.getElementById('f-nota').value || 'Agregado desde almacén';
  if (!nombre) { alert('Ingresa el nombre del item'); return; }
  try {
    await api('POST', '/api/inventario/agregar-item', { nombre, almacen_id, categoria, cantidad, nota, fecha: todayStr() });
  } catch (err) {
    console.error(err);
    alert('Error al guardar el item: ' + (err.message || err));
    return;
  }
  cerrarModal();
  _invCache = { fecha: null, data: null, pending: null };
  cargarAlmacenes();
  cargarReportes();
}

function guardarEdicionItem(itemId, almacenId) {
  const nombre = document.getElementById('f-editar-nombre').value.trim();
  const categoria = document.getElementById('f-editar-categoria').value;
  if (!nombre) { alert('Ingresa el nombre del item'); return; }
  api('PUT', '/api/inventario/' + itemId + '/' + almacenId, { nombre, categoria }).then(() => {
    cerrarModal();
    _invCache = { fecha: null, data: null, pending: null };
    cargarAlmacenes();
    cargarReportes();
  }).catch(() => alert('Error al guardar'));
}

function eliminarItemAlmacen(itemId, almacenId) {
  if (!confirm('¿Eliminar este item permanentemente?')) return;
  api('DELETE', '/api/inventario/' + itemId + '/' + almacenId).then(() => {
    _invCache = { fecha: null, data: null, pending: null };
    cargarAlmacenes();
    cargarReportes();
  }).catch(() => alert('Error al eliminar'));
}

function cargarSalidas(fecha) {
  if (!fecha) fecha = document.getElementById('fecha-salidas').value;
  if (!fecha) return;
  _invCache = { fecha: null, data: null, pending: null };
  getInventario(fecha).then(data => {
    const todosAlmacenes = data.map(al => ({ id: al.id, nombre: al.nombre }));
    // Solo mostrar items con salida registrada en esta fecha (todos los almacenes)
    data = data.filter(a => {
      a.items = (a.items || []).filter(i => (i.salida_almacen || 0) > 0);
      return a.items.length > 0;
    });
    const categoriasPorAlmacen = {};
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|VERMOUTH CINZANO|PROSECCO/i.test(i.nombre) && !/^VINO CLOS CBERNET/i.test(i.nombre) },
      { label: 'BARRA', test: i => /APEROL X 750ML|BARNIDET CREMA DE PECH|BELLS JUGO CRANBERRY|GINGER ALE EVERVESS|JOSE CUERVO BLANCO|JW RED LABEL|MATACUY DESTILADO|RED BULL|RICADONNA PRO SECO|RON KINGSTON|SALQA CAÑA|VODKA ABSOLUTE|VODKA SMIRNOFF|PISCO PORTON ACHOLADO/i.test(i.nombre) },
      { label: 'LACTEOS', test: i => /NESTLE LECHE CONDENSADA|NESTLE - CREMA DE LECHE|LA TABERNA CREMA DE COCO|GLORIA LECHE EVAPORDA|GLORIA LECHE CAJA|LECHE DE COCO|LECHE EVAPORADA DE COCO|LECHE PURA VIDA|BOLSA MANTEQUILLA|CREMA DE COCO|QUESO PARMESANO|GRAN PADANO/i.test(i.nombre) },
      { label: 'SERVICIO', test: i => /SERVILLETAS|SCOTCH BRITE|MICROFIBER CLOTHS|NUBE - PAPEL HIGIENICO/i.test(i.nombre) },
      { label: 'DELIVERY', test: i => /TUPPER TRANSPARENTE RECTANGULAR|TUPPER REDONDO GRANDES|TUPPER REDONDO CHICO/i.test(i.nombre) },
    ];
    data = data.map(a => {
      const categorias = defaultCategorias;
      const usado = new Set();
      const secciones = categorias.map(cat => {
        const items = a.items.filter(i => cat.test(i) && !usado.has(i.id)).sort((x, y) => {
          const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
          const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
          return xg - yg || x.nombre.localeCompare(y.nombre);
        });
        items.forEach(i => usado.add(i.id));
        return { ...cat, items };
      });
      // La categoria explicita del item tiene prioridad sobre la seccion inferida por nombre
      secciones.forEach(s => {
        s.items = s.items.filter(i => {
          if (i.categoria) {
            const target = secciones.find(ss => ss.label.toUpperCase() === String(i.categoria).toUpperCase());
            if (target && target !== s) { target.items.push(i); return false; }
          }
          return true;
        });
      });
      let otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
      if (otros.length) {
        otros = otros.filter(i => {
          if (i.categoria) {
            const cat = secciones.find(s => s.label.toUpperCase() === i.categoria.toUpperCase());
            if (cat) { cat.items.push(i); return false; }
          }
          return true;
        });
      }
      return { ...a, secciones, otros };
    });
    const container = document.getElementById('accordion-salidas');
    container.innerHTML = data.map(a => {
      const alOpts = todosAlmacenes.filter(x => x.id !== a.id).map(x => `<option value="${x.id}">${x.nombre}</option>`).join('');
      if (!window._transferAlOpts) window._transferAlOpts = {};
      window._transferAlOpts[a.id] = alOpts;
      return `
      <div class="accordion-item" data-almacen-id="${a.id}">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${a.nombre}</span>
          <span class="accordion-actions" onclick="event.stopPropagation()">
            <button onclick="exportarSalidaAlmacen(${a.id})">Exportar</button>
          </span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          ${a.items.length ? `
            <div class="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Stock Actual</th><th>Salida</th><th>Destino</th></tr></thead>
              <tbody>
                ${a.secciones.map(s => s.items.length ? `
                  <tr class="section-header"><td colspan="4">— ${s.label} —</td></tr>
                  ${s.items.map(i => {
                    const dRows = buildDestinoRows(i);
                    const esT = tieneStocksTransfer(i);
                    return `<tr data-item-id="${i.id}" data-almacen-id="${a.id}" data-tiene-stocks="${esT ? '1' : '0'}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-salida" value="${i.salida_almacen || 0}" step="0.01" oninput="updateTransferTotal(this.closest('tr'))"></td>
                    <td>
                      ${dRows ? `<div class="destino-list">${dRows}</div>` : ''}
                      ${dRows ? `<button type="button" class="btn-add-destino" onclick="addDestinoSalida(this)" style="margin-top:0.25rem;padding:0.2rem 0.4rem;font-size:0.75rem;cursor:pointer;">+ Destino</button>` : ''}
                      ${dRows ? `<span class="destino-total" style="font-size:0.8rem;margin-left:0.4rem;">Suma: ${i.salida_almacen || 0} / ${i.salida_almacen || 0}</span>` : ''}
                      <div class="transfer-wrap" style="display:none;margin-top:0.3rem;">
                        <div class="transfer-list">${buildTransferRows(i, alOpts)}</div>
                        <div style="margin-top:0.3rem;">
                          <button type="button" class="btn-add-transfer" onclick="addTransferencia(this)" style="padding:0.2rem 0.4rem;font-size:0.75rem;cursor:pointer;">+ Almacén</button>
                          <span class="transfer-total" style="font-size:0.8rem;margin-left:0.4rem;">Suma: ${i.salida_almacen || 0} / ${i.salida_almacen || 0}</span>
                        </div>
                      </div>
                    </td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-ingreso" value="${i.stock_ingreso || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`;
                  }).join('')}
                ` : '').join('')}
                ${a.otros.length ? `
                  <tr class="section-header"><td colspan="4">— ${a.id === 3 ? 'CAFE' : (a.id === 1 ? 'KOMBUCHAS' : 'COCINA')} —</td></tr>
                  ${a.otros.map(i => {
                    const dRows = buildDestinoRows(i);
                    const esT = tieneStocksTransfer(i);
                    return `<tr data-item-id="${i.id}" data-almacen-id="${a.id}" data-tiene-stocks="${esT ? '1' : '0'}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-salida" value="${i.salida_almacen || 0}" step="0.01" oninput="updateTransferTotal(this.closest('tr'))"></td>
                    <td>
                      ${dRows ? `<div class="destino-list">${dRows}</div>` : ''}
                      ${dRows ? `<button type="button" class="btn-add-destino" onclick="addDestinoSalida(this)" style="margin-top:0.25rem;padding:0.2rem 0.4rem;font-size:0.75rem;cursor:pointer;">+ Destino</button>` : ''}
                      ${dRows ? `<span class="destino-total" style="font-size:0.8rem;margin-left:0.4rem;">Suma: ${i.salida_almacen || 0} / ${i.salida_almacen || 0}</span>` : ''}
                      <div class="transfer-wrap" style="display:none;margin-top:0.3rem;">
                        <div class="transfer-list">${buildTransferRows(i, alOpts)}</div>
                        <div style="margin-top:0.3rem;">
                          <button type="button" class="btn-add-transfer" onclick="addTransferencia(this)" style="padding:0.2rem 0.4rem;font-size:0.75rem;cursor:pointer;">+ Almacén</button>
                          <span class="transfer-total" style="font-size:0.8rem;margin-left:0.4rem;">Suma: ${i.salida_almacen || 0} / ${i.salida_almacen || 0}</span>
                        </div>
                      </div>
                    </td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-ingreso" value="${i.stock_ingreso || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`;
                  }).join('')}
                ` : ''}
              </tbody>
            </table>
            </div>
          ` : '<p class="sin-items">Este almacén no tiene items.</p>'}
        </div>
      </div>
    `; }).join('');
    const bs = document.getElementById('buscar-salida');
    if (bs && bs.value) buscarEnTabla(bs.value, 'accordion-salidas');
    container.querySelectorAll('tr[data-item-id]').forEach(tr => onCambioDestinoSalida(tr));
  });
}

function guardarSalidas() {
  const fecha = document.getElementById('fecha-salidas').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const registros = [];
  document.querySelectorAll('#accordion-salidas .accordion-item').forEach(item => {
    const almacenId = parseInt(item.dataset.almacenId);
    item.querySelectorAll('tr[data-item-id]').forEach(tr => {
      const itemId = parseInt(tr.dataset.itemId);
      const salida = parseFloat(tr.querySelector('.input-salida').value) || 0;
      const destinos = Array.from(tr.querySelectorAll('.destino-row')).map(r => ({
        destino: r.querySelector('.select-destino-salida')?.value || '',
        cantidad: parseFloat(r.querySelector('.input-destino-cant')?.value) || 0
      })).filter(d => d.destino && d.destino.toLowerCase() !== 'stocks' && d.cantidad > 0);
      const transferencias = Array.from(tr.querySelectorAll('.transfer-row')).map(r => ({
        almacen_id: parseInt(r.querySelector('.select-transfer-almacen')?.value) || 0,
        cantidad: parseFloat(r.querySelector('.input-transfer-cant')?.value) || 0
      })).filter(t => t.almacen_id > 0 && t.cantidad > 0);
      const destinoPrimario = transferencias.length ? 'stocks' : (destinos.length ? destinos[0].destino : '');
      registros.push({ item_id: itemId, almacen_id: almacenId, salida_almacen: salida, destino_salida: destinoPrimario, destino_salidas: destinos, transferencias: transferencias.length ? transferencias : undefined });
    });
  });
  const btn = document.querySelector('#tab-salidas .btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  api('POST', '/api/almacenes/guardar-dia', { fecha, registros, saved_by: currentUserName }).then(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR SALIDAS';
    showToast('Salida Guardada');
    recargarTodo(fecha);
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR SALIDAS';
    alert('Error al guardar');
  });
}

function onCambioDestinoSalida(sel) {
  const tr = sel && sel.closest ? sel.closest('tr') : sel;
  if (!tr) return;
  const wrap = tr.querySelector('.transfer-wrap');
  const tieneStocks = tr.dataset.tieneStocks === '1' || Array.from(tr.querySelectorAll('.select-destino-salida')).some(s => s.value === 'stocks');
  if (wrap) wrap.style.display = tieneStocks ? '' : 'none';
  if (tieneStocks) updateTransferTotal(tr);
  updateDestinoTotal(tr);
}

function tieneStocksTransfer(i) {
  return (i.destino_salida || '').toLowerCase() === 'stocks'
    || (Array.isArray(i.transferencias) && i.transferencias.length > 0)
    || (Array.isArray(i.destino_salidas) && i.destino_salidas.some(d => d.destino && d.destino.toLowerCase() === 'stocks'));
}

function buildDestinoRows(i) {
  // Las transferencias a STOCKS se muestran en la seccion de Almacen destino (no como fila de destino)
  const esStocks = tieneStocksTransfer(i);
  let rows;
  if (Array.isArray(i.destino_salidas) && i.destino_salidas.length) {
    rows = i.destino_salidas.filter(r => r.destino && r.destino.toLowerCase() !== 'stocks');
  } else if (esStocks) {
    return '';
  } else {
    rows = [{ destino: i.destino_salida || '', cantidad: i.salida_almacen || 0 }];
  }
  if (!rows.length) return '';
  return rows.map(r => {
    const d = String(r.destino || '');
    const fijos = ['', 'barra', 'cocina', 'juan', 'stocks'].map(v =>
      `<option value="${v}" ${d === v ? 'selected' : ''}>${v === '' ? '—' : v.toUpperCase()}</option>`).join('');
    const extra = d && !['barra', 'cocina', 'juan', 'stocks'].includes(d)
      ? `<option value="${esc(d)}" selected>${esc(d)}</option>` : '';
    return '<div class="destino-row">'
      + '<select class="select-destino-salida" onchange="onCambioDestinoSalida(this)" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;">'
      + fijos + extra
      + '</select>'
      + '<input type="number" class="input-num input-destino-cant" value="' + (r.cantidad || 0) + '" step="0.01" min="0" oninput="updateDestinoTotal(this.closest(\'tr\'))" style="width:70px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;margin-left:0.2rem;">'
      + '<button type="button" class="btn-remove-destino" onclick="removeDestinoSalida(this)" title="Quitar" style="margin-left:0.2rem;cursor:pointer;">✕</button>'
      + '</div>';
  }).join('');
}

function addDestinoSalida(btn) {
  const tr = btn.closest('tr');
  const list = tr.querySelector('.destino-list');
  const div = document.createElement('div');
  div.className = 'destino-row';
  div.innerHTML = '<select class="select-destino-salida" onchange="onCambioDestinoSalida(this)" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;">'
    + '<option value="">—</option><option value="barra">BARRA</option><option value="cocina">COCINA</option><option value="juan">JUAN</option><option value="stocks">STOCKS</option>'
    + '</select>'
    + '<input type="number" class="input-num input-destino-cant" value="0" step="0.01" min="0" oninput="updateDestinoTotal(this.closest(\'tr\'))" style="width:70px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;margin-left:0.2rem;">'
    + '<button type="button" class="btn-remove-destino" onclick="removeDestinoSalida(this)" title="Quitar" style="margin-left:0.2rem;cursor:pointer;">✕</button>';
  list.appendChild(div);
  updateDestinoTotal(tr);
}

function removeDestinoSalida(btn) {
  const tr = btn.closest('tr');
  btn.closest('.destino-row').remove();
  onCambioDestinoSalida(tr.querySelector('.select-destino-salida'));
}

function updateDestinoTotal(tr) {
  if (!tr) return;
  const salida = parseFloat(tr.querySelector('.input-salida')?.value) || 0;
  const sum = Array.from(tr.querySelectorAll('.input-destino-cant')).reduce((acc, el) => acc + (parseFloat(el.value) || 0), 0);
  const total = tr.querySelector('.destino-total');
  if (total) {
    total.textContent = 'Suma: ' + Math.round(sum * 100) / 100 + ' / ' + Math.round(salida * 100) / 100;
    total.style.color = Math.abs(sum - salida) < 0.005 ? '#28a745' : '#dc3545';
  }
}

function buildTransferRows(i, alOpts) {
  let transfers = (Array.isArray(i.transferencias) && i.transferencias.length)
    ? i.transferencias.filter(t => t.almacen_id)
    : (i.destino_almacen_id ? [{ almacen_id: i.destino_almacen_id, cantidad: i.salida_almacen || 0 }] : [{ almacen_id: '', cantidad: 0 }]);
  return transfers.map(t => {
    const opts = alOpts.replace(new RegExp('<option value="' + t.almacen_id + '">', 'g'), '<option value="' + t.almacen_id + '" selected>');
    return '<div class="transfer-row">'
      + '<select class="select-transfer-almacen" onchange="updateTransferTotal(this.closest(\'tr\'))" style="padding:0.25rem;border:1px solid #ccc;border-radius:4px;">'
      + '<option value="">—</option>' + opts
      + '</select>'
      + '<input type="number" class="input-num input-transfer-cant" value="' + (t.cantidad || 0) + '" step="0.01" min="0" oninput="updateTransferTotal(this.closest(\'tr\'))" style="width:70px;">'
      + '<button type="button" class="btn-remove-transfer" onclick="removeTransferencia(this)" title="Quitar" style="margin-left:0.2rem;cursor:pointer;">✕</button>'
      + '</div>';
  }).join('');
}

function addTransferencia(btn) {
  const tr = btn.closest('tr');
  const opts = window._transferAlOpts && window._transferAlOpts[tr.dataset.almacenId] ? window._transferAlOpts[tr.dataset.almacenId] : '';
  const list = tr.querySelector('.transfer-list');
  const div = document.createElement('div');
  div.className = 'transfer-row';
  div.innerHTML = '<select class="select-transfer-almacen" onchange="updateTransferTotal(this.closest(\'tr\'))" style="padding:0.25rem;border:1px solid #ccc;border-radius:4px;">'
    + '<option value="">—</option>' + opts + '</select>'
    + '<input type="number" class="input-num input-transfer-cant" value="0" step="0.01" min="0" oninput="updateTransferTotal(this.closest(\'tr\'))" style="width:70px;">'
    + '<button type="button" class="btn-remove-transfer" onclick="removeTransferencia(this)" title="Quitar" style="margin-left:0.2rem;cursor:pointer;">✕</button>';
  list.appendChild(div);
  updateTransferTotal(tr);
}

function removeTransferencia(btn) {
  btn.closest('.transfer-row').remove();
  updateTransferTotal(btn.closest('tr'));
}

function updateTransferTotal(tr) {
  if (!tr) return;
  const salida = parseFloat(tr.querySelector('.input-salida')?.value) || 0;
  const sum = Array.from(tr.querySelectorAll('.input-transfer-cant')).reduce((acc, el) => acc + (parseFloat(el.value) || 0), 0);
  const total = tr.querySelector('.transfer-total');
  if (total) {
    total.textContent = 'Suma: ' + Math.round(sum * 100) / 100 + ' / ' + Math.round(salida * 100) / 100;
    total.style.color = Math.abs(sum - salida) < 0.005 ? '#28a745' : '#dc3545';
  }
  updateDestinoTotal(tr);
}

function verDetallesSalidas() {
  const fecha = document.getElementById('fecha-salidas').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
    const alNombres = {};
    data.forEach(al => { alNombres[al.id] = al.nombre; });
    data = data.filter(a => a.id === 4 || a.id === 8);
    let html = '<h3>Detalle de Salidas — ' + fecha + '</h3>';
    let totalItems = 0;
    data.forEach(a => {
      const itemsConSalida = a.items.filter(i => (i.salida_almacen || 0) > 0);
      if (!itemsConSalida.length) return;
      totalItems += itemsConSalida.length;
      html += '<div class="accordion-item">';
      html += '<div class="accordion-header" onclick="toggleAcordeon(this)"><span class="accordion-title">' + a.nombre + '</span><span class="accordion-arrow">▶</span></div>';
      html += '<div class="accordion-body open">';
      html += '<table><thead><tr><th>Item</th><th>Salida</th><th>Destino</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
      itemsConSalida.forEach(i => {
        const t = i.updated_at ? new Date(i.updated_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
        const u = DISPLAY_NAMES[i.saved_by] || i.saved_by || '-';
        const destino = (i.destino_salida || '').toUpperCase() || '—';
        let destinoMostrar = destino;
        if ((i.destino_salida || '').toLowerCase() === 'stocks') {
          const ts = (Array.isArray(i.transferencias) && i.transferencias.length) ? i.transferencias : (i.destino_almacen_id ? [{ almacen_id: i.destino_almacen_id, cantidad: i.salida_almacen || 0 }] : []);
          destinoMostrar = ts.length ? 'STOCKS: ' + ts.map(t => (alNombres[t.almacen_id] || 'Almacén ' + t.almacen_id) + ' (' + (t.cantidad || 0) + ')').join(' + ') : 'STOCKS';
        } else if (Array.isArray(i.destino_salidas) && i.destino_salidas.length) {
          destinoMostrar = i.destino_salidas.map(d => (d.destino || '').toUpperCase() + ' (' + (d.cantidad || 0) + ')').join(' + ');
        }
        html += '<tr><td>' + i.nombre + '</td><td>' + (i.salida_almacen || 0) + '</td><td>' + destinoMostrar + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    if (!totalItems) {
      html += '<p>No hay salidas registradas en esta fecha.</p>';
    }
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function verDetallesVentas() {
  const fecha = document.getElementById('fecha-ventas').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id !== 3 && a.id !== 9 && a.id !== 16);
    let html = '<h3>Detalle de Ventas — ' + fecha + '</h3>';
    let totalItems = 0;
    data.forEach(a => {
      const itemsConVentas = a.items.filter(i => (i.total_ventas || 0) > 0);
      if (!itemsConVentas.length) return;
      totalItems += itemsConVentas.length;
      html += '<div class="accordion-item">';
      html += '<div class="accordion-header" onclick="toggleAcordeon(this)"><span class="accordion-title">' + a.nombre + '</span><span class="accordion-arrow">▶</span></div>';
      html += '<div class="accordion-body open">';
      html += '<table><thead><tr><th>Item</th><th>Total Ventas</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
      itemsConVentas.forEach(i => {
        const t = i.updated_at ? new Date(i.updated_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
        const u = DISPLAY_NAMES[i.saved_by] || i.saved_by || '-';
        html += '<tr><td>' + i.nombre + '</td><td>' + (i.total_ventas || 0) + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    if (!totalItems) {
      html += '<p>No hay ventas registradas en esta fecha.</p>';
    }
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function verDetallesBajas() {
  const fecha = document.getElementById('fecha-bajas').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
    let html = '<h3>Detalle de Bajas — ' + fecha + '</h3>';
    let totalItems = 0;
    data.forEach(a => {
      const itemsConBaja = a.items.filter(i => (i.stock_baja || 0) > 0);
      if (!itemsConBaja.length) return;
      totalItems += itemsConBaja.length;
      html += '<div class="accordion-item">';
      html += '<div class="accordion-header" onclick="toggleAcordeon(this)"><span class="accordion-title">' + a.nombre + '</span><span class="accordion-arrow">▶</span></div>';
      html += '<div class="accordion-body open">';
      html += '<table><thead><tr><th>Item</th><th>Baja</th><th>Motivo</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
      itemsConBaja.forEach(i => {
        const t = i.updated_at ? new Date(i.updated_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
        const u = DISPLAY_NAMES[i.saved_by] || i.saved_by || '-';
        html += '<tr><td>' + i.nombre + '</td><td>' + (i.stock_baja || 0) + '</td><td style="max-width:250px;white-space:normal;word-break:break-word;">' + (i.nota_baja || '-') + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    if (!totalItems) {
      html += '<p>No hay bajas registradas en esta fecha.</p>';
    }
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function cargarVentas(fecha) {
  if (!fecha) fecha = document.getElementById('fecha-ventas').value;
  _invCache = { fecha: null, data: null, pending: null };
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id !== 3 && a.id !== 9 && a.id !== 16);
    // Solo mostrar items que se vendieron en esta fecha
    data = data.filter(a => {
      a.items = (a.items || []).filter(i => (i.total_ventas || 0) > 0);
      return a.items.length > 0;
    });
    const categoriasPorAlmacen = {};
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|VERMOUTH CINZANO|PROSECCO/i.test(i.nombre) && !/^VINO CLOS CBERNET/i.test(i.nombre) },
      { label: 'BARRA', test: i => /APEROL X 750ML|BARNIDET CREMA DE PECH|BELLS JUGO CRANBERRY|GINGER ALE EVERVESS|JOSE CUERVO BLANCO|JW RED LABEL|MATACUY DESTILADO|RED BULL|RICADONNA PRO SECO|RON KINGSTON|SALQA CAÑA|VODKA ABSOLUTE|VODKA SMIRNOFF|PISCO PORTON ACHOLADO/i.test(i.nombre) },
      { label: 'LACTEOS', test: i => /NESTLE LECHE CONDENSADA|NESTLE - CREMA DE LECHE|LA TABERNA CREMA DE COCO|GLORIA LECHE EVAPORDA|GLORIA LECHE CAJA|LECHE DE COCO|LECHE EVAPORADA DE COCO|LECHE PURA VIDA|BOLSA MANTEQUILLA|CREMA DE COCO|QUESO PARMESANO|GRAN PADANO/i.test(i.nombre) },
      { label: 'SERVICIO', test: i => /SERVILLETAS|SCOTCH BRITE|MICROFIBER CLOTHS|NUBE - PAPEL HIGIENICO/i.test(i.nombre) },
      { label: 'DELIVERY', test: i => /TUPPER TRANSPARENTE RECTANGULAR|TUPPER REDONDO GRANDES|TUPPER REDONDO CHICO/i.test(i.nombre) },
    ];
    data = data.map(a => {
      const categorias = defaultCategorias;
      const usado = new Set();
      const secciones = categorias.map(cat => {
        const items = a.items.filter(i => cat.test(i) && !usado.has(i.id)).sort((x, y) => {
          const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
          const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
          if (xg !== yg) return xg - yg;
          if (cat.label === 'VINOS' && a.id === 2) {
            const xi = vinosOrder.indexOf(x.nombre);
            const yi = vinosOrder.indexOf(y.nombre);
            return (xi === -1 ? 999 : xi) - (yi === -1 ? 999 : yi);
          }
          return x.nombre.localeCompare(y.nombre);
        });
        items.forEach(i => usado.add(i.id));
        return { ...cat, items };
      });
      // La categoria explicita del item tiene prioridad sobre la seccion inferida por nombre
      secciones.forEach(s => {
        s.items = s.items.filter(i => {
          if (i.categoria) {
            const target = secciones.find(ss => ss.label.toUpperCase() === String(i.categoria).toUpperCase());
            if (target && target !== s) { target.items.push(i); return false; }
          }
          return true;
        });
      });
      let otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
      if (otros.length) {
        otros = otros.filter(i => {
          if (i.categoria) {
            const cat = secciones.find(s => s.label.toUpperCase() === i.categoria.toUpperCase());
            if (cat) { cat.items.push(i); return false; }
          }
          return true;
        });
      }
      return { ...a, secciones, otros };
    });
    const container = document.getElementById('accordion-ventas');
    container.innerHTML = data.map(a => `
      <div class="accordion-item" data-almacen-id="${a.id}">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${a.nombre}</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          ${a.items.length ? `
            <div class="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Stock Actual</th><th>Total Ventas</th></tr></thead>
              <tbody>
                ${a.secciones.map(s => s.items.length ? `
                  <tr class="section-header"><td colspan="3">— ${s.label} —</td></tr>
                  ${s.items.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-ventas" value="${i.total_ventas || 0}" step="0.01"></td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-salida" value="${i.salida_almacen || 0}">
                    <input type="hidden" class="hidden-ingreso" value="${i.stock_ingreso || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`).join('')}
                ` : '').join('')}
                ${a.otros.length ? `
                  <tr class="section-header"><td colspan="3">— ${a.id === 3 ? 'CAFE' : (a.id === 1 ? 'KOMBUCHAS' : 'COCINA')} —</td></tr>
                  ${a.otros.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-ventas" value="${i.total_ventas || 0}" step="0.01"></td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-salida" value="${i.salida_almacen || 0}">
                    <input type="hidden" class="hidden-ingreso" value="${i.stock_ingreso || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`).join('')}
                ` : ''}
              </tbody>
            </table>
            </div>
          ` : '<p class="sin-items">Este almacén no tiene items.</p>'}
        </div>
      </div>
    `).join('');
    const bv = document.getElementById('buscar-venta');
    if (bv && bv.value) buscarEnTabla(bv.value, 'accordion-ventas');
  });
}

function guardarVentas() {
  const fecha = document.getElementById('fecha-ventas').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const registros = [];
  document.querySelectorAll('#accordion-ventas .accordion-item').forEach(item => {
    const almacenId = parseInt(item.dataset.almacenId);
    item.querySelectorAll('tr[data-item-id]').forEach(tr => {
      const itemId = parseInt(tr.dataset.itemId);
      const ventas = parseFloat(tr.querySelector('.input-ventas').value) || 0;
      registros.push({ item_id: itemId, almacen_id: almacenId, total_ventas: ventas });
    });
  });
  const btn = document.querySelector('#tab-ventas .btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  api('POST', '/api/almacenes/guardar-dia', { fecha, registros, saved_by: currentUserName }).then(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR VENTAS';
    showToast('Venta Guardada');
    recargarTodo(fecha);
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR VENTAS';
    alert('Error al guardar');
  });
}

function cargarBajas(fecha) {
  if (!fecha) fecha = document.getElementById('fecha-bajas').value;
  getInventario(fecha).then(data => {
    // Solo mostrar items con BAJA registrada en esta fecha
    data = data.map(al => ({ ...al, items: (al.items || []).filter(i => (i.stock_baja || 0) > 0) })).filter(al => al.items.length > 0);
    const categoriasPorAlmacen = {};
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|VERMOUTH CINZANO|PROSECCO/i.test(i.nombre) && !/^VINO CLOS CBERNET/i.test(i.nombre) },
      { label: 'BARRA', test: i => /APEROL X 750ML|BARNIDET CREMA DE PECH|BELLS JUGO CRANBERRY|GINGER ALE EVERVESS|JOSE CUERVO BLANCO|JW RED LABEL|MATACUY DESTILADO|RED BULL|RICADONNA PRO SECO|RON KINGSTON|SALQA CAÑA|VODKA ABSOLUTE|VODKA SMIRNOFF|PISCO PORTON ACHOLADO/i.test(i.nombre) },
      { label: 'LACTEOS', test: i => /NESTLE LECHE CONDENSADA|NESTLE - CREMA DE LECHE|LA TABERNA CREMA DE COCO|GLORIA LECHE EVAPORDA|GLORIA LECHE CAJA|LECHE DE COCO|LECHE EVAPORADA DE COCO|LECHE PURA VIDA|BOLSA MANTEQUILLA|CREMA DE COCO|QUESO PARMESANO|GRAN PADANO/i.test(i.nombre) },
      { label: 'SERVICIO', test: i => /SERVILLETAS|SCOTCH BRITE|MICROFIBER CLOTHS|NUBE - PAPEL HIGIENICO/i.test(i.nombre) },
      { label: 'DELIVERY', test: i => /TUPPER TRANSPARENTE RECTANGULAR|TUPPER REDONDO GRANDES|TUPPER REDONDO CHICO/i.test(i.nombre) },
    ];
    data = data.map(a => {
      const categorias = defaultCategorias;
      const usado = new Set();
      const secciones = categorias.map(cat => {
        const items = a.items.filter(i => cat.test(i) && !usado.has(i.id)).sort((x, y) => {
          const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
          const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
          if (xg !== yg) return xg - yg;
          if (cat.label === 'VINOS' && a.id === 2) {
            const xi = vinosOrder.indexOf(x.nombre);
            const yi = vinosOrder.indexOf(y.nombre);
            return (xi === -1 ? 999 : xi) - (yi === -1 ? 999 : yi);
          }
          return x.nombre.localeCompare(y.nombre);
        });
        items.forEach(i => usado.add(i.id));
        return { ...cat, items };
      });
      // La categoria explicita del item tiene prioridad sobre la seccion inferida por nombre
      secciones.forEach(s => {
        s.items = s.items.filter(i => {
          if (i.categoria) {
            const target = secciones.find(ss => ss.label.toUpperCase() === String(i.categoria).toUpperCase());
            if (target && target !== s) { target.items.push(i); return false; }
          }
          return true;
        });
      });
      let otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
      if (otros.length) {
        otros = otros.filter(i => {
          if (i.categoria) {
            const cat = secciones.find(s => s.label.toUpperCase() === i.categoria.toUpperCase());
            if (cat) { cat.items.push(i); return false; }
          }
          return true;
        });
      }
      return { ...a, secciones, otros };
    });
    const container = document.getElementById('accordion-bajas');
    if (!data.length) {
      container.innerHTML = '<p>No hay items con BAJA registrada en esta fecha.</p>';
      const bb = document.getElementById('buscar-baja');
      if (bb) bb.value = '';
      return;
    }
    container.innerHTML = data.map(a => `
      <div class="accordion-item" data-almacen-id="${a.id}">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${a.nombre}</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          ${a.items.length ? `
            <div class="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Stock Actual</th><th>Baja</th><th></th></tr></thead>
              <tbody>
                ${a.secciones.map(s => s.items.length ? `
                  <tr class="section-header"><td colspan="4">— ${s.label} —</td></tr>
                  ${s.items.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-baja" value="${i.stock_baja || 0}" step="0.01" onchange="abrirModalBaja(this)" oninput="mostrarBotonNota(this)"></td>
                    <td><button class="btn-nota-baja" onclick="abrirModalBaja(this.closest('tr').querySelector('.input-baja'))" style="background:none;border:none;cursor:pointer;font-size:1.1rem;${(i.stock_baja||0)>0?'':'display:none'}">📝</button></td>
                    <input type="hidden" class="hidden-nota-baja" value="${(i.nota_baja||'')}">
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-ingreso" value="${i.stock_ingreso || 0}">
                    <input type="hidden" class="hidden-salida" value="${i.salida_almacen || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                  </tr>`).join('')}
                ` : '').join('')}
                ${a.otros.length ? `
                  <tr class="section-header"><td colspan="4">— ${a.id === 3 ? 'CAFE' : (a.id === 1 ? 'KOMBUCHAS' : 'COCINA')} —</td></tr>
                  ${a.otros.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-baja" value="${i.stock_baja || 0}" step="0.01" onchange="abrirModalBaja(this)" oninput="mostrarBotonNota(this)"></td>
                    <td><button class="btn-nota-baja" onclick="abrirModalBaja(this.closest('tr').querySelector('.input-baja'))" style="background:none;border:none;cursor:pointer;font-size:1.1rem;${(i.stock_baja||0)>0?'':'display:none'}">📝</button></td>
                    <input type="hidden" class="hidden-nota-baja" value="${(i.nota_baja||'')}">
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-ingreso" value="${i.stock_ingreso || 0}">
                    <input type="hidden" class="hidden-salida" value="${i.salida_almacen || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                  </tr>`).join('')}
                ` : ''}
              </tbody>
            </table>
            </div>
          ` : '<p class="sin-items">Este almacén no tiene items.</p>'}
        </div>
      </div>
    `).join('');
    const bb = document.getElementById('buscar-baja');
    if (bb && bb.value) buscarEnTabla(bb.value, 'accordion-bajas');
  });
}

function guardarBajas() {
  const fecha = document.getElementById('fecha-bajas').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const registros = [];
  document.querySelectorAll('#accordion-bajas .accordion-item').forEach(item => {
    const almacenId = parseInt(item.dataset.almacenId);
    item.querySelectorAll('tr[data-item-id]').forEach(tr => {
      const itemId = parseInt(tr.dataset.itemId);
      const baja = parseFloat(tr.querySelector('.input-baja').value) || 0;
      const nota_baja = tr.querySelector('.hidden-nota-baja')?.value || '';
      registros.push({ item_id: itemId, almacen_id: almacenId, stock_baja: baja, nota_baja });
    });
  });
  const btn = document.querySelector('#tab-bajas .btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  api('POST', '/api/almacenes/guardar-dia', { fecha, registros, saved_by: currentUserName }).then(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR BAJAS';
    showToast('Baja Guardada');
    recargarTodo(fecha);
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR BAJAS';
    alert('Error al guardar');
  });
}

function abrirModalBaja(inputEl) {
  const tr = inputEl.closest('tr');
  const notaInput = tr.querySelector('.hidden-nota-baja');
  const itemName = tr.querySelector('td')?.textContent || '';
  const almacenId = tr.dataset.almacenId;
  const itemId = tr.dataset.itemId;
  const body = document.getElementById('modal-body');
  body.innerHTML = `
    <h3>Motivo de la Baja</h3>
    <p><strong>Item:</strong> ${itemName}</p>
    <label style="display:block;margin-top:1rem;">
      Describe el motivo:
      <textarea id="nota-baja-texto" style="width:100%;min-height:100px;margin-top:0.5rem;padding:0.5rem;border:1px solid #ccc;border-radius:4px;font-family:inherit;font-size:0.9rem;">${notaInput.value}</textarea>
    </label>
    <button onclick="guardarNotaBaja('${itemId}', '${almacenId}')" style="margin-top:1rem;padding:0.5rem 1.5rem;background:#1a237e;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
  `;
  document.getElementById('modal').style.display = 'block';
}

function guardarNotaBaja(itemId, almacenId) {
  const texto = document.getElementById('nota-baja-texto').value;
  const tr = document.querySelector(`tr[data-item-id="${itemId}"][data-almacen-id="${almacenId}"]`);
  if (tr) {
    tr.querySelector('.hidden-nota-baja').value = texto;
  }
  document.getElementById('modal').style.display = 'none';
}

function mostrarBotonNota(inputEl) {
  const tr = inputEl.closest('tr');
  const btn = tr.querySelector('.btn-nota-baja');
  const val = parseFloat(inputEl.value) || 0;
  if (btn) {
    btn.style.display = val > 0 ? '' : 'none';
  }
}

function cargarIngresos(fecha) {
  if (!fecha) fecha = document.getElementById('fecha-ingresos').value;
  _invCache = { fecha: null, data: null, pending: null };
  getInventario(fecha).then(data => {
    const alNombres = {};
    data.forEach(al => { alNombres[al.id] = al.nombre; });
    data = data.filter(a => a.id !== 3 && a.id !== 9 && a.id !== 16);
    // Solo mostrar items con ingreso registrado en esta fecha
    data = data.filter(a => {
      a.items = (a.items || []).filter(i => (i.stock_ingreso || 0) > 0);
      return a.items.length > 0;
    });
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|VERMOUTH CINZANO|PROSECCO/i.test(i.nombre) && !/^VINO CLOS CBERNET/i.test(i.nombre) },
      { label: 'BARRA', test: i => /APEROL X 750ML|BARNIDET CREMA DE PECH|BELLS JUGO CRANBERRY|GINGER ALE EVERVESS|JOSE CUERVO BLANCO|JW RED LABEL|MATACUY DESTILADO|RED BULL|RICADONNA PRO SECO|RON KINGSTON|SALQA CAÑA|VODKA ABSOLUTE|VODKA SMIRNOFF|PISCO PORTON ACHOLADO/i.test(i.nombre) },
      { label: 'LACTEOS', test: i => /NESTLE LECHE CONDENSADA|NESTLE - CREMA DE LECHE|LA TABERNA CREMA DE COCO|GLORIA LECHE EVAPORDA|GLORIA LECHE CAJA|LECHE DE COCO|LECHE EVAPORADA DE COCO|LECHE PURA VIDA|BOLSA MANTEQUILLA|CREMA DE COCO|QUESO PARMESANO|GRAN PADANO/i.test(i.nombre) },
      { label: 'SERVICIO', test: i => /SERVILLETAS|SCOTCH BRITE|MICROFIBER CLOTHS|NUBE - PAPEL HIGIENICO/i.test(i.nombre) },
      { label: 'DELIVERY', test: i => /TUPPER TRANSPARENTE RECTANGULAR|TUPPER REDONDO GRANDES|TUPPER REDONDO CHICO/i.test(i.nombre) },
    ];
    data = data.map(a => {
      const categorias = defaultCategorias;
      const usado = new Set();
      const secciones = categorias.map(cat => {
        const items = a.items.filter(i => cat.test(i) && !usado.has(i.id)).sort((x, y) => {
          const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
          const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
          if (xg !== yg) return xg - yg;
          if (cat.label === 'VINOS' && a.id === 2) {
            const xi = vinosOrder.indexOf(x.nombre);
            const yi = vinosOrder.indexOf(y.nombre);
            return (xi === -1 ? 999 : xi) - (yi === -1 ? 999 : yi);
          }
          return x.nombre.localeCompare(y.nombre);
        });
        items.forEach(i => usado.add(i.id));
        return { ...cat, items };
      });
      // La categoria explicita del item tiene prioridad sobre la seccion inferida por nombre
      secciones.forEach(s => {
        s.items = s.items.filter(i => {
          if (i.categoria) {
            const target = secciones.find(ss => ss.label.toUpperCase() === String(i.categoria).toUpperCase());
            if (target && target !== s) { target.items.push(i); return false; }
          }
          return true;
        });
      });
      let otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
      if (otros.length) {
        otros = otros.filter(i => {
          if (i.categoria) {
            const cat = secciones.find(s => s.label.toUpperCase() === i.categoria.toUpperCase());
            if (cat) { cat.items.push(i); return false; }
          }
          return true;
        });
      }
      return { ...a, secciones, otros };
    });
    const container = document.getElementById('accordion-ingresos');
    container.innerHTML = data.map(a => `
      <div class="accordion-item" data-almacen-id="${a.id}">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${a.nombre}</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          ${a.items.length ? `
            <div class="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Stock Actual</th><th>Ingreso</th><th>Origen</th></tr></thead>
              <tbody>
                ${a.secciones.map(s => s.items.length ? `
                  <tr class="section-header"><td colspan="4">— ${s.label} —</td></tr>
                  ${s.items.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-ingreso" value="${i.stock_ingreso || 0}" step="0.01"></td>
                    <td class="celda-origen">${formatOrigenIngreso(i, alNombres)}</td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-salida" value="${i.salida_almacen || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`).join('')}
                ` : '').join('')}
                ${a.otros.length ? `
                  <tr class="section-header"><td colspan="4">— ${a.id === 3 ? 'CAFE' : (a.id === 1 ? 'KOMBUCHAS' : 'COCINA')} —</td></tr>
                  ${a.otros.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-ingreso" value="${i.stock_ingreso || 0}" step="0.01"></td>
                    <td class="celda-origen">${formatOrigenIngreso(i, alNombres)}</td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-salida" value="${i.salida_almacen || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`).join('')}
                ` : ''}
              </tbody>
            </table>
            </div>
          ` : '<p class="sin-items">Este almacén no tiene items.</p>'}
        </div>
      </div>
    `).join('');
    const bi = document.getElementById('buscar-ingreso');
    if (bi && bi.value) buscarEnTabla(bi.value, 'accordion-ingresos');
  });
}

function guardarIngresos() {
  const fecha = document.getElementById('fecha-ingresos').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const registros = [];
  document.querySelectorAll('#accordion-ingresos .accordion-item').forEach(item => {
    const almacenId = parseInt(item.dataset.almacenId);
    item.querySelectorAll('tr[data-item-id]').forEach(tr => {
      const itemId = parseInt(tr.dataset.itemId);
      const ingreso = parseFloat(tr.querySelector('.input-ingreso').value) || 0;
      registros.push({ item_id: itemId, almacen_id: almacenId, stock_ingreso: ingreso });
    });
  });
  const btn = document.querySelector('#tab-ingresos .btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  api('POST', '/api/almacenes/guardar-dia', { fecha, registros, saved_by: currentUserName }).then(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR INGRESOS';
    showToast('Ingreso Guardado');
    recargarTodo(fecha);
    actualizarContadoresMenu();
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR INGRESOS';
    alert('Error al guardar');
  });
}

function formatOrigenIngreso(i, alNombres) {
  const ors = Array.isArray(i.ingreso_origen) && i.ingreso_origen.length ? i.ingreso_origen : [];
  if (!ors.length) return '—';
  return ors.map(o => {
    const cant = o.cantidad != null ? ' (' + o.cantidad + ')' : '';
    if (o.tipo === 'stocks') {
      const nm = o.almacen_id ? (alNombres[o.almacen_id] || 'Almacén ' + o.almacen_id) : 'STOCKS';
      return 'STOCK → ' + nm + cant;
    }
    if (o.tipo === 'conversion') {
      return 'CONVERSIÓN' + cant;
    }
    return 'PROVEEDOR' + cant;
  }).join(' + ');
}

function verDetallesIngresos() {
  const fecha = document.getElementById('fecha-ingresos').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
    const alNombres = {};
    data.forEach(al => { alNombres[al.id] = al.nombre; });
    data = data.filter(a => a.id !== 3 && a.id !== 9 && a.id !== 16);
    let html = '<h3>Detalle de Ingresos — ' + fecha + '</h3>';
    let totalItems = 0;
    data.forEach(a => {
      const itemsConIngreso = a.items.filter(i => (i.stock_ingreso || 0) > 0);
      if (!itemsConIngreso.length) return;
      totalItems += itemsConIngreso.length;
      html += '<div class="accordion-item">';
      html += '<div class="accordion-header" onclick="toggleAcordeon(this)"><span class="accordion-title">' + a.nombre + '</span><span class="accordion-arrow">▶</span></div>';
      html += '<div class="accordion-body open">';
      html += '<table><thead><tr><th>Item</th><th>Ingreso</th><th>Origen</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
      itemsConIngreso.forEach(i => {
        const t = i.updated_at ? new Date(i.updated_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
        const u = DISPLAY_NAMES[i.saved_by] || i.saved_by || '-';
        html += '<tr><td>' + i.nombre + '</td><td>' + (i.stock_ingreso || 0) + '</td><td>' + formatOrigenIngreso(i, alNombres) + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    if (!totalItems) {
      html += '<p>No hay ingresos registrados en esta fecha.</p>';
    }
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function cargarReportes() {
  const ini = document.getElementById('reporte-fecha-ini');
  const fin = document.getElementById('reporte-fecha-fin');
  if (ini && fin) {
    if (!ini.value) ini.value = todayStr();
    if (!fin.value) fin.value = todayStr();
    cargarReporteDiferencias();
  }
}

function showModal(tipo, data) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';

  if (tipo === 'almacen') {
    body.innerHTML = `
      <h3>${data ? 'Editar' : 'Nuevo'} Almacén</h3>
      <label>Nombre <input id="f-nombre" value="${data ? data.nombre : ''}"></label>
      <label>Descripción <textarea id="f-descripcion">${data ? data.descripcion : ''}</textarea></label>
      <button onclick="guardarAlmacen(${data ? data.id : 'null'})">Guardar</button>
    `;
  } else if (tipo === 'item-almacen') {
    body.innerHTML = `
      <h3>Agregar Item a: ${data.almacenNombre}</h3>
      <label style="display:block;margin-top:1rem;">
        Nombre del Item
        <input type="text" id="f-nombre-item" placeholder="Ej: COCA COLA 500ml" list="sugerencias-items" autocomplete="off" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
        <datalist id="sugerencias-items">
          ${(data.sugerencias || []).map(n => `<option value="${n.replace(/"/g, '&quot;')}">`).join('')}
        </datalist>
      </label>
      <label style="display:block;margin-top:1rem;">
        Título / Categoría
        <select id="f-categoria-item" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          <option value="">Sin categoría</option>
          <option value="VINOS">VINOS</option>
          <option value="AGUAS">AGUAS</option>
          <option value="GASEOSAS">GASEOSAS</option>
          <option value="CERVEZAS">CERVEZAS</option>
          <option value="KOMBUCHAS">KOMBUCHAS</option>
          <option value="LECHES">LECHES</option>
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Cantidad Inicial
        <input type="number" id="f-cantidad" value="0" min="0" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Nota
        <textarea id="f-nota" placeholder="Opcional" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;"></textarea>
      </label>
      <input type="hidden" id="f-almacen_id" value="${data.almacenId}">
      <button onclick="guardarItemAlmacen()" style="margin-top:1rem;padding:0.5rem 1.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
    `;
  } else if (tipo === 'editar-item-almacen') {
    body.innerHTML = `
      <h3>Editar Item</h3>
      <p style="color:#666;font-size:0.9rem;">Almacén: ${data.almacenNombre}</p>
      <label style="display:block;margin-top:1rem;">
        Nombre del Item
        <input type="text" id="f-editar-nombre" value="${data.nombre}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Título / Categoría
        <select id="f-editar-categoria" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          <option value="">Sin categoría</option>
          ${['VINOS','AGUAS','GASEOSAS','CERVEZAS','KOMBUCHAS','LECHES'].map(c =>
            `<option value="${c}" ${data.categoria === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="guardarEdicionItem(${data.itemId}, ${data.almacenId})" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
      </div>
    `;
  } else if (tipo === 'editar-stock-item') {
    const uniOpts = UNIDADES_STOCK.map(u => `<option value="${u}" ${data.unidad === u ? 'selected' : ''}>${u}</option>`).join('');
    body.innerHTML = `
      <h3>Editar Item de Stock</h3>
      <label style="display:block;margin-top:1rem;">
        Nombre del Item
        <input id="f-stock-nombre" value="${esc(data.nombre)}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Cantidad
        <input type="number" id="f-stock-cantidad" step="0.01" min="0" value="${data.cantidad}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad
        <select id="f-stock-unidad" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">${uniOpts}</select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Mueble
        <select id="f-stock-grupo" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          ${GRUPOS_BARRA.map(g => `<option value="${g}" ${data.grupo === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="guardarEdicionStock(${data.id})" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
      </div>
    `;
  } else if (tipo === 'item-cocina') {
    const uniOpts = UNIDADES_STOCK.map(u => `<option value="${u}">${u}</option>`).join('');
    const famOpts = FAMILIAS_COCINA.map(f => `<option value="${f}" ${((data.familia || '').toUpperCase() === f) ? 'selected' : ''}>${f}</option>`).join('');
    body.innerHTML = `
      <h3>Agregar Item de Cocina</h3>
      <label style="display:block;margin-top:1rem;">
        Nombre del Item
        <input id="f-cocina-nombre" placeholder="Ej: Tomate" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Cantidad
        <input type="number" id="f-cocina-cantidad" step="0.01" min="0" value="0" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad
        <select id="f-cocina-unidad" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">${uniOpts}</select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Familia
        <select id="f-cocina-familia" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">${famOpts}</select>
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="guardarNuevoItemCocina()" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
      </div>
    `;
  } else if (tipo === 'editar-cocina-stock') {
    const uniOpts = UNIDADES_STOCK.map(u => `<option value="${u}" ${data.unidad === u ? 'selected' : ''}>${u}</option>`).join('');
    const famOpts = FAMILIAS_COCINA.map(f => `<option value="${f}" ${data.familia === f ? 'selected' : ''}>${f}</option>`).join('');
    body.innerHTML = `
      <h3>Editar Item de Stock Cocina</h3>
      <label style="display:block;margin-top:1rem;">
        Nombre del Item
        <input id="f-cocina-nombre" value="${esc(data.nombre)}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Cantidad
        <input type="number" id="f-cocina-cantidad" step="0.01" min="0" value="${data.cantidad}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad
        <select id="f-cocina-unidad" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">${uniOpts}</select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Familia
        <select id="f-cocina-familia" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">${famOpts}</select>
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="guardarEdicionStockCocina(${data.id})" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
      </div>
    `;
  }
}

function cerrarModal() {
  const mc = document.querySelector('.modal-content');
  if (mc) mc.classList.remove('modal-wide');
  document.getElementById('modal').style.display = 'none';
}

function guardarAlmacen(id) {
  const nombre = document.getElementById('f-nombre').value;
  const descripcion = document.getElementById('f-descripcion').value;
  const req = id
    ? api('PUT', '/api/almacenes/' + id, { nombre, descripcion })
    : api('POST', '/api/almacenes', { nombre, descripcion });
  req.then(() => { cerrarModal(); cargarAlmacenes(); });
}

function eliminarAlmacen(id) {
  if (confirm('¿Eliminar este almacén?')) {
    api('DELETE', '/api/almacenes/' + id).then(() => { cargarAlmacenes(); });
  }
}

function editarAlmacen(id, nombre, descripcion) {
  showModal('almacen', { id, nombre, descripcion });
}

function guardarMinimosStocks() {
  const btn = document.querySelector('#tab-stocks .btn-guardar-dia');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  const minimos = [];
  document.querySelectorAll('#accordion-stocks tr[data-item-id]').forEach(tr => {
    const itemId = parseInt(tr.dataset.itemId);
    const almacenId = parseInt(tr.dataset.almacenId);
    if (isNaN(itemId) || isNaN(almacenId)) return;
    const val = parseFloat(tr.querySelector('.input-minimo').value) || 0;
    minimos.push({ item_id: itemId, almacen_id: almacenId, cantidad_minima: val });
  });
  if (!minimos.length) {
    if (btn) { btn.disabled = false; btn.textContent = '💾 GUARDAR MINIMOS'; }
    alert('No hay items para guardar en STOCK/STOCKS');
    return;
  }
  api('PUT', '/api/inventario/minimos', { minimos }).then(() => {
    if (btn) {
      btn.textContent = '✓ Guardado';
      setTimeout(() => { btn.disabled = false; btn.textContent = '💾 GUARDAR MINIMOS'; }, 2000);
    }
    showToast('Mínimos guardados');
    cargarStocks();
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = '💾 GUARDAR MINIMOS'; }
    alert('Error al guardar');
  });
}

let _stocksBajosData = null;

function verReporteStocksBajos() {
  const fecha = document.getElementById('fecha-stocks').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
    // Agregar por NOMBRE de item en TODOS los almacenes (stock total del restaurante)
    const porNombre = new Map();
    (data || []).forEach(a => {
      (a.items || []).forEach(i => {
        const k = String(i.nombre || '').trim().toUpperCase();
        if (!k) return;
        if (!porNombre.has(k)) porNombre.set(k, { nombre: i.nombre, total: 0, min: 0, detalles: [] });
        const g = porNombre.get(k);
        g.total += (i.stock_cierre || 0);
        g.min = Math.max(g.min, i.cantidad_minima || 0);
        g.detalles.push({ almacen: a.nombre, cantidad: i.stock_cierre || 0 });
      });
    });
    const bajos = [];
    porNombre.forEach(g => { if (g.min > 0 && g.total < g.min) bajos.push(g); });
    bajos.sort((x, y) => x.total - y.total);
    let html = '<h3>Productos con Stock Bajo — ' + fecha + ' (todos los almacenes)</h3>';
    if (!bajos.length) {
      html += '<p>No hay productos con stock bajo.</p>';
    } else {
      html += '<p style="font-size:0.8rem;color:#666;">Stock TOTAL del restaurante (suma de todos los almacenes) por debajo de la cantidad mínima.</p>';
      html += '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Stock Total</th><th>Cant. Mínima</th><th>Por almacén</th></tr></thead><tbody>';
      bajos.forEach(g => {
        const detalle = g.detalles.filter(d => (d.cantidad || 0) > 0).map(d => d.almacen + ': ' + d.cantidad).join(', ') || '—';
        html += '<tr class="stock-bajo"><td>' + g.nombre + '</td><td>' + g.total + '</td><td>' + g.min + '</td><td style="font-size:0.8rem;">' + detalle + '</td></tr>';
      });
      html += '</tbody></table></div>';
      html = '<div style="margin-bottom:0.75rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">'
        + '<button class="btn-detalles" onclick="enviarAvisoStockWhatsApp()" style="width:auto;margin-top:0;background:#25d366;color:#fff;font-weight:700;">📲 AVISO DE STOCK</button>'
        + '<span style="font-size:0.8rem;color:#888;">Envía el detalle por WhatsApp</span></div>' + html;
    }
    _stocksBajosData = { fecha, lista: bajos.map(g => ({ nombre: g.nombre, total: g.total, min: g.min, detalles: g.detalles })) };
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function enviarAvisoStockWhatsApp() {
  if (!_stocksBajosData || !_stocksBajosData.lista.length) return;
  const lines = ['AVISO DE STOCK BAJO - ' + _stocksBajosData.fecha, ''];
  _stocksBajosData.lista.forEach((i, idx) => {
    lines.push((idx + 1) + '. ' + i.nombre + ' - ' + i.total);
  });
  const msg = lines.join('\n');
  const url = 'https://wa.me/?text=' + encodeURIComponent(msg);
  window.open(url, '_blank');
}

function cargarStocks() {
  const fecha = document.getElementById('fecha-stocks').value;
  if (!fecha) return;
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id === 4 || a.id === 8);
    const categoriasPorAlmacen = {
      1: [
        { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
        { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
        { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
        { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO/i.test(i.nombre) },
      ],
    };
    const defaultCategorias = [
      { label: 'LECHES', test: i => /leche/i.test(i.nombre) },
      { label: 'AGUAS', test: i => /^AGUA\s|SAN CARLOS SIN GAS|SAN MATEO SIN GAS|TONIC WATER BRITVIC/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA|MR\. PERKINS GINGER BEER|MR\. PERKINS TONIC WATER|PINK SODA MR PERKINS|GINGER MR PERKINS/i.test(i.nombre) },
      { label: 'KOMBUCHAS', test: i => /^KOMBUCHA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|VERMOUTH CINZANO|PROSECCO/i.test(i.nombre) && !/^VINO CLOS CBERNET/i.test(i.nombre) },
      { label: 'BARRA', test: i => /APEROL X 750ML|BARNIDET CREMA DE PECH|BELLS JUGO CRANBERRY|GINGER ALE EVERVESS|JOSE CUERVO BLANCO|JW RED LABEL|MATACUY DESTILADO|RED BULL|RICADONNA PRO SECO|RON KINGSTON|SALQA CAÑA|VODKA ABSOLUTE|VODKA SMIRNOFF|PISCO PORTON ACHOLADO/i.test(i.nombre) },
      { label: 'LACTEOS', test: i => /NESTLE LECHE CONDENSADA|NESTLE - CREMA DE LECHE|LA TABERNA CREMA DE COCO|GLORIA LECHE EVAPORDA|GLORIA LECHE CAJA|LECHE DE COCO|LECHE EVAPORADA DE COCO|LECHE PURA VIDA|BOLSA MANTEQUILLA|CREMA DE COCO|QUESO PARMESANO|GRAN PADANO/i.test(i.nombre) },
      { label: 'SERVICIO', test: i => /SERVILLETAS|SCOTCH BRITE|MICROFIBER CLOTHS|NUBE - PAPEL HIGIENICO/i.test(i.nombre) },
      { label: 'DELIVERY', test: i => /TUPPER TRANSPARENTE RECTANGULAR|TUPPER REDONDO GRANDES|TUPPER REDONDO CHICO/i.test(i.nombre) },
    ];
    data = data.map(a => {
      const categorias = categoriasPorAlmacen[a.id] || defaultCategorias;
      const usado = new Set();
      const secciones = categorias.map(cat => {
        const items = a.items.filter(i => cat.test(i) && !usado.has(i.id)).sort((x, y) => {
          const xg = (x.stock_cierre || 0) > 0 ? 0 : 1;
          const yg = (y.stock_cierre || 0) > 0 ? 0 : 1;
          if (xg !== yg) return xg - yg;
          if (cat.label === 'VINOS' && a.id === 2) {
            const xi = vinosOrder.indexOf(x.nombre);
            const yi = vinosOrder.indexOf(y.nombre);
            return (xi === -1 ? 999 : xi) - (yi === -1 ? 999 : yi);
          }
          return x.nombre.localeCompare(y.nombre);
        });
        items.forEach(i => usado.add(i.id));
        return { ...cat, items };
      });
      // La categoria explicita del item tiene prioridad sobre la seccion inferida por nombre
      secciones.forEach(s => {
        s.items = s.items.filter(i => {
          if (i.categoria) {
            const target = secciones.find(ss => ss.label.toUpperCase() === String(i.categoria).toUpperCase());
            if (target && target !== s) { target.items.push(i); return false; }
          }
          return true;
        });
      });
      let otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_cierre || 0) > 0 ? 0 : 1;
        const yg = (y.stock_cierre || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
      if (otros.length) {
        otros = otros.filter(i => {
          if (i.categoria) {
            const cat = secciones.find(s => s.label.toUpperCase() === i.categoria.toUpperCase());
            if (cat) { cat.items.push(i); return false; }
          }
          return true;
        });
      }
      return { ...a, secciones, otros };
    });
    const container = document.getElementById('accordion-stocks');
    const html = data.map(a => {
      const renderItems = items => items.map(i => {
        const cierre = i.stock_cierre || 0;
        const minima = i.cantidad_minima || 0;
        const bajo = minima > 0 && cierre <= minima;
        return `<tr data-item-id="${i.id}" data-almacen-id="${a.id}" class="${bajo ? 'stock-bajo' : ''}">
          <td>${i.nombre}</td>
          <td><input type="number" class="input-num input-minimo" value="${minima}" step="0.01"></td>
          <td>${cierre}</td>
        </tr>`;
      }).join('');
      return `<div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${a.nombre}</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          <div class="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Cantidad Minima</th><th>Stock Total Cierre</th></tr></thead>
            <tbody>
              ${a.secciones.map(s => s.items.length ? `
                <tr class="section-header"><td colspan="3">— ${s.label} —</td></tr>
                ${renderItems(s.items)}
              ` : '').join('')}
              ${a.otros.length ? `
                <tr class="section-header"><td colspan="3">— ${a.id === 3 ? 'CAFE' : (a.id === 1 ? 'KOMBUCHAS' : 'COCINA')} —</td></tr>
                ${renderItems(a.otros)}
              ` : ''}
            </tbody>
          </table>
          </div>
        </div>
      </div>`;
    }).join('');
    container.innerHTML = html || '<p>Sin datos para esta fecha.</p>';
    const bs = document.getElementById('buscar-stock');
    if (bs && bs.value) buscarEnTabla(bs.value, 'accordion-stocks');

    // Botellas Abiertas: items with decimal stock_cierre
    getInventario(fecha).then(fullData => {
      fullData = fullData.filter(a => a.id === 1 || a.id === 5 || a.id === 6);
      const botellas = [];
      fullData.forEach(a => {
        a.items.forEach(i => {
          const c = i.stock_cierre || 0;
          const frac = c % 1;
          if (frac > 0) {
            botellas.push({ item_id: i.id, almacen_id: a.id, nombre: i.nombre, almacen: a.nombre, fraccion: frac, fecha_apertura: i.fecha_apertura || '' });
          }
        });
      });
      window.botellasData = botellas;
      const bc = document.getElementById('botellas-container');
      if (!botellas.length) {
        bc.innerHTML = '<p>No hay botellas abiertas.</p>';
        return;
      }
      bc.innerHTML = `
        <div class="table-wrap">
        <table style="box-shadow:none;border:1px solid #eee;">
          <thead><tr><th>Almacén</th><th>Item</th><th>Fracción</th><th>Fecha de Apertura</th></tr></thead>
          <tbody>
            ${botellas.map((b, idx) => `<tr>
              <td>${b.almacen}</td>
              <td>${b.nombre}</td>
              <td>${b.fraccion.toFixed(2)}</td>
              <td><input type="date" class="input-fecha-apertura" value="${b.fecha_apertura}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;font-size:0.85rem;width:150px;" data-idx="${idx}"></td>
            </tr>`).join('')}
          </tbody>
        </table>
        </div>`;
      // auto-open the accordion
      const header = bc.closest('.accordion-body')?.previousElementSibling;
      if (header && !header.classList.contains('active')) {
        header.classList.add('active');
        header.nextElementSibling.classList.add('open');
        header.querySelector('.accordion-arrow')?.classList.add('open');
      }
    });
  });
}



function renderReporteTabla(items, titulo) {
  if (!items.length) return '';
  const conFalta = titulo === 'PRODUCTOS CON FALTA';
  const rows = items.map(r => {
    const diff = r.diferencia;
    const f = r.falta_almacen || 0;
    const cls = diff < 0 ? 'diff-neg' : 'diff-pos';
    const estado = f > 0 ? '<span class="estado-falta">FALTA</span>' : '<span class="estado-ok">OK</span>';
    return `<tr><td>${r.nombre}</td><td>${r.almacen_nombre}</td><td>${r.stock_apertura}</td><td>${r.stock_ingreso || 0}</td><td>${r.salida_almacen || 0}</td><td>${r.total_ventas || 0}</td>${conFalta ? '<td style="color:red">' + f + '</td>' : '<td>' + f + '</td>'}<td>${r.stock_cierre}</td><td class="${cls}">${diff > 0 ? '+' : ''}${diff}</td><td>${estado}</td></tr>`;
  }).join('');
  return `<div class="diff-almacen">
    <div class="diff-header" onclick="toggleAcordeon(this)">
      <span class="accordion-title">${titulo} (${items.length})</span>
      <span class="accordion-arrow">▶</span>
    </div>
    <div class="accordion-body open">
      <div class="table-wrap">
      <table><thead><tr><th>Item</th><th>Almacén</th><th>Apertura</th><th>Ingreso</th><th>Salidas</th><th>Ventas</th>${conFalta ? '<th style="color:red">Falta</th>' : '<th>Falta</th>'}<th>Cierre</th><th>Diferencia</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
  </div>`;
}

function prevWorkingDayStr(fecha) {
  const d = new Date(fecha + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 2) d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function abrirAccionesReportes() {
  const ini = document.getElementById('reporte-fecha-ini')?.value;
  const fin = document.getElementById('reporte-fecha-fin')?.value;
  if (!ini || !fin) { alert('Selecciona el rango de fechas del reporte (Desde/Hasta)'); return; }
  api('GET', '/api/reportes/faltantes?fecha_inicio=' + ini + '&fecha_fin=' + fin).then(faltantes => {
    const body = document.getElementById('modal-body');
    if (!faltantes.length) {
      body.innerHTML = '<h3>ACCIONES</h3><p>No hay items con FALTA en el rango seleccionado.</p>';
      document.getElementById('modal').style.display = 'block';
      return;
    }
    let html = '<h3>ACCIONES — Items con FALTA</h3>';
    html += '<p style="font-size:0.8rem;color:#888;margin-bottom:0.6rem;">Elige la acción para cada faltante: <strong>→ COCINA</strong> (salida a cocina el día real), <strong>BAJA</strong> (registra en STOCK/BAJAS), <strong>OBSERVAR</strong> (cuarentena) o <strong>INTERCAMBIO</strong> (los meseros registraron un producto por otro: corrige la falta, el ingreso y las ventas).</p>';
    html += '<div class="table-wrap"><table><thead><tr><th>Fecha Falta</th><th>Item</th><th>Almacén</th><th>Falta</th><th>Fecha Real Salida</th><th>→ COCINA</th><th>BAJA</th><th>OBSERVAR</th><th>INTERCAMBIO</th></tr></thead><tbody>';
    faltantes.forEach(f => {
      html += `<tr data-accion-item="${f.item_id}" data-accion-al="${f.almacen_id}" data-accion-falta="${f.falta}" data-accion-fecha="${f.fecha}">
        <td>${f.fecha}</td>
        <td>${esc(f.nombre)}</td>
        <td>${esc(f.almacen_nombre)}</td>
        <td style="color:red;font-weight:700;">${f.falta}</td>
        <td><input type="date" class="input-fecha-salida" value="${prevWorkingDayStr(f.fecha)}"></td>
        <td><button class="btn-detalles" onclick="convertirFaltaACocina(this)" style="background:#2e7d32;color:#fff;">→ COCINA</button></td>
        <td><button class="btn-detalles" onclick="darDeBajaFalta(this)" style="background:#b71c1c;color:#fff;">BAJA</button></td>
        <td><button class="btn-detalles" onclick="observarFalta(this)" style="background:#e65100;color:#fff;">OBSERVAR</button></td>
        <td><button class="btn-detalles" onclick="intercambiarFalta(this)" style="background:#6a1b9a;color:#fff;">INTERCAMBIO</button></td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    body.innerHTML = html;
    const mc = document.querySelector('.modal-content');
    if (mc) mc.classList.add('modal-wide');
    document.getElementById('modal').style.display = 'block';
  }).catch(() => alert('Error al cargar los faltantes'));
}

function darDeBajaFalta(btn) {
  const tr = btn.closest('tr');
  const item_id = parseInt(tr.dataset.accionItem);
  const almacen_id = parseInt(tr.dataset.accionAl);
  const cantidad = parseFloat(tr.dataset.accionFalta);
  const fecha = tr.dataset.accionFecha;
  if (!confirm('¿Dar de BAJA ' + cantidad + ' de este item por FALTA? Se registrará en STOCK/BAJAS el ' + fecha + '.')) return;
  btn.disabled = true; btn.textContent = '...';
  api('POST', '/api/reportes/accion/baja', {
    fecha, item_id, almacen_id, cantidad, saved_by: currentUserName
  }).then(() => {
    showToast('Registrado en STOCK/BAJAS');
    cerrarModal();
    cargarReporteDiferencias();
  }).catch(() => { btn.disabled = false; btn.textContent = 'BAJA'; alert('Error al dar de baja'); });
}

function observarFalta(btn) {
  const tr = btn.closest('tr');
  const item_id = parseInt(tr.dataset.accionItem);
  const almacen_id = parseInt(tr.dataset.accionAl);
  const cantidad = parseFloat(tr.dataset.accionFalta);
  const fecha = tr.dataset.accionFecha;
  if (!confirm('¿Poner ' + cantidad + ' de este item en OBSERVACIÓN (cuarentena)? El item quedará listado en el botón CUARENTENA y podrás usarlo como venta manualmente.')) return;
  btn.disabled = true; btn.textContent = '...';
  api('POST', '/api/reportes/accion/observacion', {
    fecha, item_id, almacen_id, cantidad, saved_by: currentUserName
  }).then(() => {
    showToast('Item en OBSERVACIÓN');
    cerrarModal();
    cargarReporteDiferencias();
  }).catch(() => { btn.disabled = false; btn.textContent = 'OBSERVAR'; alert('Error al marcar en observación'); });
}

function intercambiarFalta(btn) {
  const tr = btn.closest('tr');
  const item_id = parseInt(tr.dataset.accionItem);
  const almacen_id = parseInt(tr.dataset.accionAl);
  const cantidad = parseFloat(tr.dataset.accionFalta);
  const fecha = tr.dataset.accionFecha;
  const nombreItem = tr.querySelector('td:nth-child(2)').textContent.trim();
  const body = document.getElementById('modal-body');
  body.innerHTML = '<h3>INTERCAMBIO DE PRODUCTO</h3>'
    + '<p style="font-size:0.85rem;color:#666;" id="intercambio-info">Cargando productos con INGRESO...</p>';
  getInventario(fecha).then(data => {
    const al = (data || []).find(a => a.id === almacen_id);
    const conIngreso = (al && al.items ? al.items : []).filter(i => (i.stock_ingreso || 0) > 0 && i.id !== item_id);
    if (!conIngreso.length) {
      body.innerHTML = '<h3>INTERCAMBIO DE PRODUCTO</h3>'
        + '<p style="color:#c62828;">No hay productos con INGRESO en <b>' + esc(al ? al.nombre : 'almacén ' + almacen_id) + '</b> el ' + fecha + ' para emparejar el intercambio. ¿Tal vez el ingreso sobrante está en otro almacén o se marcó como otro tipo de ajuste?</p>'
        + '<button onclick="cerrarModal()" style="margin-top:0.5rem;">CERRAR</button>';
      return;
    }
    body.innerHTML = '<h3>INTERCAMBIO DE PRODUCTO</h3>'
      + '<p style="font-size:0.85rem;color:#666;margin-bottom:0.6rem;">El faltante es de <b>' + esc(nombreItem) + '</b> (' + cantidad + ') el ' + fecha + ' en <b>' + esc(al.nombre) + '</b>. Se registrará la venta del producto correcto y se quitará la del equivocado (corrige falta, ingreso y ventas).</p>'
      + '<label style="display:block;font-weight:600;margin-bottom:0.3rem;">Producto registrado por error (el que tiene el INGRESO):</label>'
      + '<select id="intercambio-producto" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;margin-bottom:0.6rem;">'
      + conIngreso.map(i => `<option value="${i.id}" data-nombre="${esc(i.nombre)}">${esc(i.nombre)} (ingreso ${i.stock_ingreso})</option>`).join('')
      + '</select>'
      + '<label style="display:block;font-weight:600;margin-bottom:0.3rem;">Cantidad a intercambiar:</label>'
      + '<input id="intercambio-cant" type="number" step="0.01" min="0" value="' + cantidad + '" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;margin-bottom:0.8rem;">'
      + '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">'
      + '<button onclick="confirmarIntercambio()" style="flex:1;min-width:120px;background:#6a1b9a;color:#fff;">CORREGIR INTERCAMBIO</button>'
      + '<button onclick="cerrarModal()" style="flex:1;min-width:120px;background:#888;">Cancelar</button>'
      + '</div>';
    window._intercambioCtx = { fecha, almacen_id, item_falta: item_id };
  }).catch(() => { body.innerHTML = '<p style="color:#c62828;">Error cargando el inventario.</p>'; });
}

function confirmarIntercambio() {
  const ctx = window._intercambioCtx;
  if (!ctx) return;
  const sel = document.getElementById('intercambio-producto');
  if (!sel) return;
  const item_ingreso = parseInt(sel.value);
  const nomIng = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.nombre : '';
  const cantidad = parseFloat(document.getElementById('intercambio-cant').value) || 0;
  if (!item_ingreso || cantidad <= 0) { alert('Selecciona el producto y la cantidad'); return; }
  if (!confirm('¿Corregir el intercambio? Se registrará la venta real de ' + cantidad + ' ' + (nomIng ? 'del producto faltante' : '') + ', se quitará la venta de ' + nomIng + ' y se ajustarán la falta y el ingreso.')) return;
  api('POST', '/api/reportes/accion/intercambio', {
    fecha: ctx.fecha, almacen_id: ctx.almacen_id, item_falta: ctx.item_falta, item_ingreso, cantidad, saved_by: currentUserName
  }).then(() => {
    showToast('Intercambio corregido');
    cerrarModal();
    cargarReporteDiferencias();
  }).catch(() => alert('Error al corregir intercambio'));
}

function convertirFaltaACocina(btn) {
  const tr = btn.closest('tr');
  const item_id = parseInt(tr.dataset.accionItem);
  const almacen_id = parseInt(tr.dataset.accionAl);
  const cantidad = parseFloat(tr.dataset.accionFalta);
  const fecha_falta = tr.dataset.accionFecha;
  const fecha_salida = tr.querySelector('.input-fecha-salida').value;
  if (!fecha_salida) { alert('Indica la fecha real en que salió el item'); return; }
  if (!confirm('¿Convertir la falta de ' + cantidad + ' en SALIDA A COCINA el ' + fecha_salida + '?')) return;
  btn.disabled = true; btn.textContent = 'Procesando...';
  api('POST', '/api/reportes/accion/salida-cocina', {
    fecha_falta, fecha_salida, item_id, almacen_id, cantidad, saved_by: currentUserName
  }).then(() => {
    showToast('Convertido a SALIDA A COCINA');
    cerrarModal();
    cargarReporteDiferencias();
  }).catch(() => {
    btn.disabled = false; btn.textContent = '→ COCINA';
    alert('Error al convertir');
  });
}

function abrirCuarentena() {
  api('GET', '/api/reportes/cuarentena').then(lista => {
    const body = document.getElementById('modal-body');
    if (!lista.length) {
      body.innerHTML = '<h3>CUARENTENA</h3><p>No hay items en observación.</p>';
      document.getElementById('modal').style.display = 'block';
      return;
    }
    let html = '<h3>CUARENTENA — Items en observación</h3>';
    html += '<p style="font-size:0.8rem;color:#888;margin-bottom:0.6rem;">El item está apartado (cuarentena). Para usarlo como venta, hazlo <strong>manualmente</strong>: indica la fecha de la venta y pulsa "USAR COMO VENTA".</p>';
    html += '<div class="table-wrap"><table><thead><tr><th>Fecha Observación</th><th>Item</th><th>Almacén</th><th>Cantidad</th><th>Fecha Venta</th><th></th></tr></thead><tbody>';
    lista.forEach(f => {
      html += `<tr data-cua-item="${f.item_id}" data-cua-al="${f.almacen_id}" data-cua-cant="${f.cantidad}" data-cua-fecha="${f.fecha}">
        <td>${f.fecha}</td>
        <td>${esc(f.nombre)}</td>
        <td>${esc(f.almacen_nombre)}</td>
        <td style="font-weight:700;color:#e65100;">${f.cantidad}</td>
        <td><input type="date" class="input-fecha-venta" value="${f.fecha}"></td>
        <td style="white-space:nowrap;">
          <button class="btn-detalles" onclick="usarObservacionComoVenta(this)" style="background:#0f3460;color:#fff;">USAR COMO VENTA</button>
          <button class="btn-detalles" onclick="sacarDeCuarentena(this)" style="background:#c62828;color:#fff;">SACAR</button>
        </td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    body.innerHTML = html;
    const mc = document.querySelector('.modal-content');
    if (mc) mc.classList.add('modal-wide');
    document.getElementById('modal').style.display = 'block';
  }).catch(() => alert('Error al cargar la cuarentena'));
}

function usarObservacionComoVenta(btn) {
  const tr = btn.closest('tr');
  const item_id = parseInt(tr.dataset.cuaItem);
  const almacen_id = parseInt(tr.dataset.cuaAl);
  const cantidad = parseFloat(tr.dataset.cuaCant);
  const fecha_observacion = tr.dataset.cuaFecha;
  const fecha_venta = tr.querySelector('.input-fecha-venta').value;
  if (!fecha_venta) { alert('Indica la fecha de la venta'); return; }
  if (!confirm('¿Usar ' + cantidad + ' de este item como VENTA el ' + fecha_venta + '? Se registrará la venta y se liberará la observación.')) return;
  btn.disabled = true; btn.textContent = 'Procesando...';
  api('POST', '/api/reportes/accion/usar-venta', {
    fecha_observacion, fecha_venta, item_id, almacen_id, cantidad, saved_by: currentUserName
  }).then(() => {
    showToast('Registrado como VENTA');
    cerrarModal();
    cargarReporteDiferencias();
  }).catch(() => { btn.disabled = false; btn.textContent = 'USAR COMO VENTA'; alert('Error al usar como venta'); });
}

function sacarDeCuarentena(btn) {
  const tr = btn.closest('tr');
  const item_id = parseInt(tr.dataset.cuaItem);
  const almacen_id = parseInt(tr.dataset.cuaAl);
  const cantidad = parseFloat(tr.dataset.cuaCant);
  const fecha = tr.dataset.cuaFecha;
  if (!confirm('¿Sacar ' + cantidad + ' de este item de cuarentena? Volverá a REPORTES como FALTANTE (se restaura la falta).')) return;
  btn.disabled = true; btn.textContent = 'Procesando...';
  api('POST', '/api/reportes/accion/sacar-cuarentena', {
    fecha, item_id, almacen_id, cantidad, saved_by: currentUserName
  }).then(() => {
    showToast('Sacado de cuarentena y devuelto como falta');
    abrirCuarentena();
    cargarReporteDiferencias();
  }).catch(() => { btn.disabled = false; btn.textContent = 'SACAR'; alert('Error al sacar de cuarentena'); });
}

let _bdEditando = null;
function agregarItemBaseDatos() {
  const body = document.getElementById('modal-body');
  const cats = _BD_CATEGORIAS.map(c => c.label);
  body.innerHTML = '<h3>AGREGAR ITEM A LA BASE DE DATOS</h3>'
    + '<label style="display:block;margin-bottom:0.4rem;">Nombre: <input id="bd-add-nombre" placeholder="Nombre del item" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;"></label>'
    + '<label style="display:block;margin-bottom:0.4rem;">Categoría: <select id="bd-add-categoria" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;">'
    + cats.map(c => '<option value="' + c + '">' + c + '</option>').join('')
    + '<option value="COCINA">COCINA</option></select></label>'
    + '<label style="display:block;margin-bottom:0.4rem;">Unidad Compra: <input id="bd-add-uc" value="unidad" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;"></label>'
    + '<label style="display:block;margin-bottom:0.4rem;">Precio Compra: <input id="bd-add-pc" type="number" step="0.01" min="0" value="0" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;"></label>'
    + '<label style="display:block;margin-bottom:0.4rem;">Unidad Venta: <input id="bd-add-uv" value="unidad" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;"></label>'
    + '<label style="display:block;margin-bottom:0.4rem;">Precio Venta: <input id="bd-add-pv" type="number" step="0.01" min="0" value="0" style="width:100%;padding:0.4rem;border:1px solid #ccc;border-radius:4px;"></label>'
    + '<div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap;">'
    + '<button onclick="guardarNuevoItemBaseDatos()" style="flex:1;min-width:120px;">AGREGAR</button>'
    + '<button onclick="cerrarModal()" style="flex:1;min-width:120px;background:#888;">Cancelar</button>'
    + '</div>';
  document.getElementById('modal').style.display = 'block';
}

function guardarNuevoItemBaseDatos() {
  const nombre = document.getElementById('bd-add-nombre').value.trim();
  if (!nombre) { alert('El nombre es requerido'); return; }
  api('POST', '/api/basedatos/agregar', {
    nombre,
    categoria: document.getElementById('bd-add-categoria').value,
    unidad_compra: document.getElementById('bd-add-uc').value.trim(),
    precio_compra: parseFloat(document.getElementById('bd-add-pc').value) || 0,
    unidad_venta: document.getElementById('bd-add-uv').value.trim(),
    precio_venta: parseFloat(document.getElementById('bd-add-pv').value) || 0
  }).then(r => {
    if (r && r.ok === false) { alert(r.error || 'El item ya existe'); return; }
    cerrarModal();
    showToast('Item agregado a la base de datos');
    cargarBaseDatosUnificada();
  }).catch(() => alert('Error al agregar el item'));
}

function editarItemBaseDatos(origen, id) {
  const x = _bdUnificada.find(i => i.origen === origen && i.id === id);
  if (!x) return;
  _bdEditando = x;
  const body = document.getElementById('modal-body');
  let categoriaHtml = '';
  if (x.origen === 'unificada') {
    const cats = _BD_CATEGORIAS.map(c => c.label).concat('COCINA');
    categoriaHtml = '<label>Categoría: <select id="bd-edit-categoria">'
      + cats.map(c => '<option value="' + c + '" ' + (x.categoria === c ? 'selected' : '') + '>' + c + '</option>').join('')
      + '</select></label>';
  }
  body.innerHTML = '<h3>EDITAR ITEM (' + x.zona + ')</h3>'
    + '<label>Nombre: <input id="bd-edit-nombre" value="' + esc(x.nombre) + '"></label>'
    + categoriaHtml
    + '<label>Unidad Compra: <input id="bd-edit-uc" value="' + esc(x.unidad_compra || '') + '"></label>'
    + '<label>Precio Compra: <input id="bd-edit-pc" type="number" step="0.01" min="0" value="' + (x.precio_compra || 0) + '"></label>'
    + '<label>Unidad Venta: <input id="bd-edit-uv" value="' + esc(x.unidad_venta || '') + '"></label>'
    + '<label>Precio Venta: <input id="bd-edit-pv" type="number" step="0.01" min="0" value="' + (x.precio_venta || 0) + '"></label>'
    + '<div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap;">'
    + '<button onclick="guardarItemBaseDatos()" style="flex:1;min-width:120px;">Guardar</button>'
    + '<button onclick="eliminarDupBaseDatos()" style="flex:1;min-width:120px;background:#f57f17;">ELIMINAR DUP</button>'
    + '<button onclick="cerrarModal()" style="flex:1;min-width:120px;background:#888;">Cancelar</button>'
    + '</div>';
  document.getElementById('modal').style.display = 'block';
}

function eliminarDupBaseDatos() {
  if (!_bdEditando) return;
  const nombre = String(_bdEditando.nombre || '').trim().toUpperCase();
  if (nombre && !_bdNoDup.includes(nombre)) {
    _bdNoDup.push(nombre);
    try { localStorage.setItem('bd_no_dup', JSON.stringify(_bdNoDup)); } catch (e) {}
  }
  showToast('Advertencia de duplicado eliminada');
  cerrarModal();
  renderBaseDatosUnificada();
}

function guardarItemBaseDatos() {
  if (!_bdEditando) return;
  const nombre = document.getElementById('bd-edit-nombre').value.trim();
  if (!nombre) { alert('El nombre es requerido'); return; }
  const uc = document.getElementById('bd-edit-uc').value.trim();
  const pc = parseFloat(document.getElementById('bd-edit-pc').value) || 0;
  const uv = document.getElementById('bd-edit-uv').value.trim();
  const pv = parseFloat(document.getElementById('bd-edit-pv').value) || 0;
  const o = _bdEditando.origen;
  const id = _bdEditando.id;
  // Si cambió el nombre, renombrar y propagar por toda la app (STOCKS/BARRA/COCINA + emparejamiento EXCEL)
  if (nombre.trim().toUpperCase() !== String(_bdEditando.nombre || '').trim().toUpperCase()) {
    api('POST', '/api/basedatos/renombrar', {
      origen: o, id,
      nombre_anterior: _bdEditando.nombre,
      nombre_nuevo: nombre,
      unidad_compra: uc, precio_compra: pc, unidad_venta: uv, precio_venta: pv
    }).then(() => {
      showToast('Item renombrado en toda la app');
      cerrarModal();
      cargarBaseDatosUnificada();
    }).catch(() => alert('Error al renombrar'));
    return;
  }
  let url, data;
  if (o === 'stock') { url = '/api/stock/precios/' + id; data = { nombre, unidad: uc, precio: pc, unidad_venta: uv, precio_venta: pv }; }
  else if (o === 'barra') { url = '/api/barra/precios/' + id; data = { ingrediente: nombre, unidad_compra: uc, precio_compra: pc, unidad: uv, precio: pv }; }
  else if (o === 'unificada') {
    url = '/api/basedatos/items/' + id;
    data = { nombre, unidad_compra: uc, precio_compra: pc, unidad_venta: uv, precio_venta: pv };
    const catSel = document.getElementById('bd-edit-categoria');
    if (catSel) data.categoria = catSel.value;
  }
  else { url = '/api/cocina/precios/' + id; data = { ingrediente: nombre, unidad_compra: uc, precio_compra: pc, unidad: uv, precio: pv }; }
  api('PUT', url, data).then(() => {
    showToast('Item actualizado');
    cerrarModal();
    cargarBaseDatosUnificada();
  }).catch(() => alert('Error al guardar'));
}

function cargarReporteDiferencias() {
  const ini = document.getElementById('reporte-fecha-ini')?.value;
  const fin = document.getElementById('reporte-fecha-fin')?.value;
  if (!ini || !fin) return;
  const url = '/api/reportes/diferencias?fecha_inicio=' + ini + '&fecha_fin=' + fin;
  api('GET', url).then(data => {
    if (data.length === 0) {
      document.getElementById('reporte-diferencias').innerHTML = '<p>Sin diferencias en este rango.</p>';
      return;
    }
    const conFalta = data.filter(r => (r.falta_almacen || 0) > 0);
    let html = '<p style="margin-bottom:0.5rem;color:#666;">Rango: <strong>' + ini + '</strong> → <strong>' + fin + '</strong></p>';
    html += renderReporteTabla(conFalta, 'PRODUCTOS CON FALTA');
    if (!html) html = '<p>Sin diferencias en este rango.</p>';
    document.getElementById('reporte-diferencias').innerHTML = html;
  });
}

function normalizarBusquedaStock(el) {
  const v = el.value;
  if (v.includes(' — ')) el.value = v.split(' — ')[0].trim();
  buscarTablaBarra(el.value, 'barra-stock-container', 'tr[data-stock-id]');
}

function exportarStockBarra() {
  const fecha = document.getElementById('fecha-stock-barra')?.value || todayStr();
  const esHoy = fecha === todayStr();
  const wsData = [['Mueble', 'Item', 'Cantidad', 'Unidad', 'Onzas']];
  document.querySelectorAll('#barra-stock-container .accordion-item').forEach(acc => {
    const mueble = acc.querySelector('.accordion-title')?.textContent?.split(' — ')[0] || '';
    acc.querySelectorAll('tbody tr[data-stock-id]').forEach(tr => {
      const ing = tr.querySelector('.stock-nombre')?.textContent || '';
      let cant, uni, onz;
      if (esHoy) {
        cant = tr.querySelector('.input-stock-cant')?.value || '';
        uni = tr.querySelector('.select-stock-uni')?.value || '';
        onz = tr.querySelector('.onzas-stock')?.textContent || '';
      } else {
        const tds = tr.querySelectorAll('td');
        cant = tds[1]?.textContent || '';
        uni = tds[2]?.textContent || '';
        onz = tds[3]?.textContent || '';
      }
      wsData.push([mueble, ing, cant, uni, onz]);
    });
  });
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(libro, hoja, 'Stock Barra');
  XLSX.writeFile(libro, `StockBarra_${fecha}.xlsx`);
}

function buscarReceta(q) {
  const term = (q || '').trim();
  const palabras = term.toLowerCase().split(/\s+/).filter(Boolean);
  const container = document.getElementById('recetas-container');
  if (!container) return;
  // Recipes: match por letra/palabra sobre nombre + familia + todos los ingredientes
  container.querySelectorAll('.accordion-item[data-receta-id]').forEach(recipe => {
    const nombre = recipe.querySelector('.accordion-title')?.textContent?.toLowerCase() || '';
    const familia = (recipe.closest('.accordion-body')?.parentElement
      ?.querySelector('.accordion-header .accordion-title')?.textContent || '').toLowerCase();
    const ingredientes = Array.from(recipe.querySelectorAll('.accordion-body tbody td:first-child'))
      .map(td => (td.textContent || '').toLowerCase().trim());
    const texto = (nombre + ' ' + familia + ' ' + ingredientes.join(' ')).toLowerCase();
    const match = !palabras.length || palabras.every(p => texto.includes(p));
    recipe.style.display = match ? '' : 'none';
  });
  // Categories: show only those with matching recipes; expand them while searching
  Array.from(container.children).forEach(cat => {
    if (!cat.classList.contains('accordion-item')) return;
    const recipes = cat.querySelectorAll('.accordion-item[data-receta-id]');
    const anyVisible = Array.from(recipes).some(r => r.style.display !== 'none');
    cat.style.display = !term || anyVisible ? '' : 'none';
    if (term && anyVisible) {
      const header = cat.querySelector('.accordion-header');
      if (header && !header.classList.contains('active')) toggleAcordeon(header);
    }
  });
}

// Buscador inteligente: empareja por letra o por palabra (todas las palabras deben coincidir),
// funciona tanto en acordeones como en tablas planas, y busca por nombre + ingredientes + familia.
function buscarSmart(term, containerId, selector) {
  const q = (term || '').trim();
  const container = document.getElementById(containerId);
  if (!container) return;
  const palabras = q.toLowerCase().split(/\s+/).filter(Boolean);
  function matchRow(tr) {
    if (!palabras.length) return true;
    let texto = (tr.children[0]?.textContent || '').toLowerCase();
    // Incluir el nombre de la familia/grupo (título del acordeón contenedor)
    const acc = tr.closest('.accordion-item');
    const titulo = acc ? acc.querySelector('.accordion-header .accordion-title')?.textContent : '';
    if (titulo) texto += ' ' + titulo.toLowerCase();
    const ingAttr = tr.getAttribute('data-ingredientes');
    if (ingAttr) {
      try {
        texto += ' ' + JSON.parse(ingAttr).map(i => (i.ingrediente || '')).join(' ').toLowerCase();
      } catch (e) {}
    }
    return palabras.every(p => texto.includes(p));
  }
  const accordions = container.querySelectorAll('.accordion-item');
  if (accordions.length) {
    accordions.forEach(item => {
      let visible = false;
      item.querySelectorAll(selector).forEach(tr => {
        const m = matchRow(tr);
        tr.style.display = m ? '' : 'none';
        if (m) visible = true;
      });
      item.style.display = (visible || !palabras.length) ? '' : 'none';
      const header = item.querySelector('.accordion-header');
      const body = item.querySelector('.accordion-body');
      const arrow = header ? header.querySelector('.accordion-arrow') : null;
      if (palabras.length && visible && header && !header.classList.contains('active')) {
        header.classList.add('active');
        if (body) body.classList.add('open');
        if (arrow) arrow.classList.add('open');
      } else if (!palabras.length && header && header.classList.contains('active')) {
        header.classList.remove('active');
        if (body) body.classList.remove('open');
        if (arrow) arrow.classList.remove('open');
      }
    });
    return;
  }
  // Tabla plana (sin acordeones)
  const wraps = container.querySelectorAll('.table-wrap');
  const targets = wraps.length ? wraps : container.querySelectorAll('table');
  targets.forEach(tbl => {
    const rows = tbl.querySelectorAll(selector);
    if (!rows.length) return;
    let visible = false;
    rows.forEach(tr => {
      const m = matchRow(tr);
      tr.style.display = m ? '' : 'none';
      if (m) visible = true;
    });
    tbl.style.display = (visible || !palabras.length) ? '' : 'none';
  });
}

function buscarEnTabla(term, containerId) {
  buscarSmart(term, containerId, 'tr[data-item-id]');
}

function buscarTablaBarra(term, containerId, selector) {
  buscarSmart(term, containerId, selector);
}

function exportarExcel() {
  const fecha = document.getElementById('fecha-almacenes')?.value || new Date().toISOString().split('T')[0];
  const wsData = [['Almacén', 'Sección', 'Item', 'Stock Total Apertura', 'Ingreso', 'Salida Almacén', 'Total Ventas', 'Falta', 'Stock Total Cierre']];
  document.querySelectorAll('#accordion-almacenes .accordion-item').forEach(item => {
    const almacen = item.querySelector('.accordion-title')?.textContent || '';
    let seccion = '';
    item.querySelectorAll('tbody tr').forEach(tr => {
      if (tr.classList.contains('section-header')) {
        seccion = tr.querySelector('td')?.textContent?.replace(/—/g, '').trim() || '';
      } else if (tr.dataset.itemId) {
        const celdas = tr.querySelectorAll('td');
        const nombre = celdas[0]?.textContent || '';
        const apertura = celdas[1]?.querySelector('input')?.value || '0';
        const ingreso = celdas[2]?.querySelector('input')?.value || '0';
        const salida = celdas[3]?.querySelector('input')?.value || '0';
        const ventas = celdas[4]?.querySelector('input')?.value || '0';
        const falta = celdas[5]?.querySelector('input')?.value || '0';
        const cierre = celdas[7]?.querySelector('input')?.value || '0';
        wsData.push([almacen, seccion, nombre, apertura, ingreso, salida, ventas, falta, cierre]);
      }
    });
  });
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(libro, hoja, 'Inventario');
  XLSX.writeFile(libro, `Inventario_${fecha}.xlsx`);
}

function exportarAlmacen(almacenId) {
  const fecha = document.getElementById('fecha-almacenes')?.value || new Date().toISOString().split('T')[0];
  const item = document.querySelector(`.accordion-item[data-almacen-id="${almacenId}"]`);
  if (!item) return;
  const almacen = item.querySelector('.accordion-title')?.textContent || '';
  const wsData = [['Sección', 'Item', 'Stock Total Apertura', 'Ingreso', 'Salida Almacén', 'Total Ventas', 'Falta', 'Stock Total Cierre']];
  let seccion = '';
  item.querySelectorAll('tbody tr').forEach(tr => {
    if (tr.classList.contains('section-header')) {
      seccion = tr.querySelector('td')?.textContent?.replace(/—/g, '').trim() || '';
    } else if (tr.dataset.itemId) {
      const celdas = tr.querySelectorAll('td');
      const nombre = celdas[0]?.textContent || '';
      const apertura = celdas[1]?.querySelector('input')?.value || '0';
      const ingreso = celdas[2]?.querySelector('input')?.value || '0';
      const salida = celdas[3]?.querySelector('input')?.value || '0';
      const ventas = celdas[4]?.querySelector('input')?.value || '0';
      const falta = celdas[5]?.querySelector('input')?.value || '0';
      const cierre = celdas[7]?.querySelector('input')?.value || '0';
      wsData.push([seccion, nombre, apertura, ingreso, salida, ventas, falta, cierre]);
    }
  });
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(libro, hoja, almacen.slice(0, 31));
  XLSX.writeFile(libro, `${almacen}_${fecha}.xlsx`);
}

function exportarDiferencias() {
  const ini = document.getElementById('reporte-fecha-ini')?.value;
  const fin = document.getElementById('reporte-fecha-fin')?.value;
  if (!ini || !fin) return;
  const url = '/api/reportes/diferencias?fecha_inicio=' + ini + '&fecha_fin=' + fin;
  api('GET', url).then(data => {
    const wsData = [['Almacén', 'Item', 'Apertura', 'Ingreso', 'Salidas', 'Ventas', 'Falta', 'Baja', 'Cierre', 'Diferencia', 'Estado']];
    data.forEach(r => {
      const f = r.falta_almacen || 0;
      const estado = f > 0 ? 'FALTA' : 'OK';
      wsData.push([r.almacen_nombre, r.nombre, r.stock_apertura, r.stock_ingreso || 0, r.salida_almacen || 0, r.total_ventas || 0, f, r.stock_baja || 0, r.stock_cierre, r.diferencia, estado]);
    });
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Diferencias');
    XLSX.writeFile(libro, `Diferencias_${ini}_${fin}.xlsx`);
  });
}

function exportarVinos() {
  const fecha = document.getElementById('reporte-fecha-fin')?.value || todayStr();
  api('GET', '/api/reportes/vinos?fecha=' + fecha).then(data => {
    const items = data.items.filter(i => i.total > 0);
    const wsData = [['Vino', 'Cantidad Total']];
    const allAlms = new Set();
    items.forEach(i => Object.keys(i.almacenes).forEach(a => allAlms.add(a)));
    const almsHeaders = Array.from(allAlms).sort();
    wsData[0] = ['Vino', 'Cantidad Total', ...almsHeaders];

    items.forEach(i => {
      const row = [i.nombre, i.total];
      almsHeaders.forEach(a => row.push(i.almacenes[a] || 0));
      wsData.push(row);
    });
    const totalRow = ['TOTAL', data.totalStock];
    almsHeaders.forEach(a => {
      totalRow.push(items.reduce((s, i) => s + (i.almacenes[a] || 0), 0));
    });
    wsData.push(totalRow);

    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Vinos');
    XLSX.writeFile(libro, `Vinos_${fecha}.xlsx`);
  }).catch(e => { console.error(e); alert('Error al generar reporte de vinos'); });
}

function exportarSalidaAlmacen(almacenId) {
  const fecha = document.getElementById('fecha-salidas')?.value || new Date().toISOString().split('T')[0];
  const item = document.querySelector(`#accordion-salidas .accordion-item[data-almacen-id="${almacenId}"]`);
  if (!item) return;
  const almacen = item.querySelector('.accordion-title')?.textContent || '';
  const wsData = [['Sección', 'Item', 'Stock Actual', 'Salida']];
  let seccion = '';
  item.querySelectorAll('tbody tr').forEach(tr => {
    if (tr.classList.contains('section-header')) {
      seccion = tr.querySelector('td')?.textContent?.replace(/—/g, '').trim() || '';
    } else if (tr.dataset.itemId) {
      const celdas = tr.querySelectorAll('td');
      const nombre = celdas[0]?.textContent || '';
      const stock = celdas[1]?.textContent || '0';
      const salida = celdas[2]?.querySelector('input')?.value || '0';
      wsData.push([seccion, nombre, stock, salida]);
    }
  });
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(libro, hoja, 'Salidas');
  XLSX.writeFile(libro, `Salidas_${almacen}_${fecha}.xlsx`);
}

function initPicker(id, fn, persist) {
  const el = document.getElementById(id);
  if (el) {
    const saved = persist ? localStorage.getItem('fecha_' + id) : null;
    el.value = saved || todayStr();
    if (persist) el.addEventListener('change', () => localStorage.setItem('fecha_' + id, el.value));
    if (fn) fn(el.value);
  }
}
initPicker('fecha-almacenes', cargarAlmacenes);
initPicker('fecha-salidas', cargarSalidas);
initPicker('fecha-ventas', cargarVentas);
initPicker('fecha-bajas', cargarBajas);
initPicker('fecha-ingresos', cargarIngresos);
initPicker('fecha-compras', cargarCompras);
initPicker('fecha-ventas-menu', cargarVentasCentral);
// Barra: just set today's date, actual load happens via lazy-load in cambiarSubTab
initPicker('fecha-stock-barra');
['fecha-barra-ingresos','fecha-barra-ventas','fecha-barra-bajas'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.value = todayStr();
});
// Cocina: just set today's date on movement pickers (load happens lazily in cambiarSubTab)
['fecha-cocina-ingresos','fecha-cocina-salidas','fecha-cocina-ventas'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.value = todayStr();
});
// Costos: set today's date on pickers (load happens lazily in cambiarSubTab)
['fecha-costos-planillas','fecha-costos-servicios','fecha-costos-gastos'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.value = todayStr();
});
initPicker('fecha-stocks', function() { cargarStocks(); });
// reportes, precios, barra loaded lazily on first tab click
initPicker('reporte-fecha-ini');
initPicker('reporte-fecha-fin');
// Búsqueda de Ventas: fechas por defecto = hoy
['busqueda-venta-desde', 'busqueda-venta-hasta'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.value = todayStr();
});
window.addEventListener('click', e => { if (e.target === document.getElementById('modal')) cerrarModal(); });

// --- BARRA: Recetas ---
function renderReceta(r) {
  const costoTotal = r.costoTotal || 0;
  const esBase = r.categoria === 'RECETAS BASE';
  return `<div class="accordion-item" data-receta-id="${r.id}"${esBase ? ' style="background:#e3f2fd;"' : ''}>
    <div class="accordion-header" onclick="toggleAcordeon(this)">
      <span class="accordion-title">${r.nombre}${costoTotal > 0 ? ` <span style="font-weight:400;font-size:0.85rem;color:#555">— COSTO: S/${costoTotal.toFixed(2)}</span>` : ''}</span>
      <span class="accordion-actions" onclick="event.stopPropagation()">
        <button onclick="editarReceta(${r.id})" style="margin-right:0.3rem">EDITAR</button>
        <button class="danger" onclick="eliminarReceta(${r.id})">ELIMINAR</button>
      </span>
      <span class="accordion-arrow">▶</span>
    </div>
    <div class="accordion-body">
      <table>
        <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th><th>P.Unitario</th><th>P.Total</th><th></th></tr></thead>
        <tbody>
          ${r.ingredientes.map(ing => {
            const pu = ing.precioUnidad || 0;
            const pt = ing.costo || 0;
            const convIcon = ing.converted ? ' ⚡' : '';
            return `<tr data-ing-id="${ing.id}">
              <td>${ing.ingrediente}</td>
              <td>${ing.cantidad}</td>
              <td>${ing.unidad}</td>
              <td>${ing.precioMatch ? 'S/' + pu.toFixed(5) : '—'}${convIcon}</td>
              <td>${ing.precioMatch ? 'S/' + pt.toFixed(2) : '—'}</td>
              <td><button class="danger" onclick="eliminarIngrediente(${r.id}, ${ing.id})">✕</button></td>
            </tr>`;
          }).join('')}
          ${costoTotal > 0 ? `
          <tr style="font-weight:700;background:#f0f0ff">
            <td colspan="4">COSTO TOTAL</td>
            <td>S/${costoTotal.toFixed(2)}</td>
            <td></td>
          </tr>
          <tr style="font-weight:700;background:#fdecea;color:#c62828">
            <td colspan="4">COSTO + 10% PÉRDIDA</td>
            <td>S/${(costoTotal * 1.10).toFixed(2)}</td>
            <td></td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>`;
}

function cargarRecetas(openId) {
  api('GET', '/api/recetas').then(data => {
    console.log('Recetas cargadas:', data.length);
    const container = document.getElementById('recetas-container');
    if (!data.length) {
      container.innerHTML = '<p>No hay recetas. Agrega una nueva.</p>';
      return;
    }
    const grupos = {};
    data.forEach(r => {
      const cat = r.categoria || 'Clásicos';
      if (!grupos[cat]) grupos[cat] = [];
      grupos[cat].push(r);
    });
    const ordenCat = ['RECETAS BASE', 'Clásicos', 'Mojitos', 'Limonadas', 'LIMONADAS MENU', 'SODAS', 'JUGO DE FRUTAS', 'DEL BARMAN', 'Chilcanos y Sours', 'SHOTS', 'VINO TINTOS'];
      let html = '';
    const catsToRender = [...ordenCat, ...Object.keys(grupos).filter(c => !ordenCat.includes(c))];
    catsToRender.forEach(cat => {
      const recs = grupos[cat] || [];
      html += `<div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${cat}${recs.length ? ` <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${recs.length} receta(s)</span>` : ''}</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          ${recs.map(r => renderReceta(r)).join('') || '<p style="padding:0.75rem;color:#888;">Sin recetas aún.</p>'}
        </div>
      </div>`;
    });
    container.innerHTML = html;
    if (openId !== undefined) {
      const el = container.querySelector(`[data-receta-id="${openId}"]`);
      if (el) {
        // El accordion de la receta esta dentro del accordion-body de la categoria
        const catBody = el.parentElement;
        const parent = catBody && catBody.classList.contains('accordion-body') ? catBody.parentElement : null;
        if (parent) {
          const catHeader = parent.querySelector('.accordion-header');
          if (catHeader && !catHeader.classList.contains('active')) toggleAcordeon(catHeader);
        }
        const recHeader = el.querySelector('.accordion-header');
        if (recHeader && !recHeader.classList.contains('active')) toggleAcordeon(recHeader);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }).catch(e => console.error('Error cargando recetas:', e));
}

function exportarRecetas() {
  api('GET', '/api/recetas').then(data => {
    const wsData = [['Categoría', 'Receta', 'Ingrediente', 'Cantidad', 'Unidad', 'P.Unitario', 'P.Total']];
    data.forEach(r => {
      if (r.ingredientes && r.ingredientes.length) {
        r.ingredientes.forEach(ing => {
          wsData.push([
            r.categoria || 'Clásicos',
            r.nombre,
            ing.ingrediente,
            ing.cantidad,
            ing.unidad,
            ing.precioMatch ? 'S/' + (ing.precioUnidad || 0).toFixed(2) : '—',
            ing.precioMatch ? 'S/' + (ing.costo || 0).toFixed(2) : '—'
          ]);
        });
        wsData.push([r.categoria, r.nombre, 'COSTO TOTAL', '', '', '', 'S/' + (r.costoTotal || 0).toFixed(2)]);
        wsData.push([]);
      } else {
        wsData.push([r.categoria || 'Clásicos', r.nombre, '—', '', '', '', '']);
        wsData.push([]);
      }
    });
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Recetas');
    XLSX.writeFile(libro, 'Recetas_Barra.xlsx');
  });
}

function guardarReceta() {
  const input = document.getElementById('nueva-receta-input');
  const cat = document.getElementById('nueva-receta-cat').value;
  const nombre = input.value.trim();
  if (!nombre) { alert('Ingresa un nombre'); return; }
  api('POST', '/api/recetas', { nombre, categoria: cat }).then(() => {
    input.value = '';
    cargarRecetas();
  }).catch(() => alert('Error al crear receta'));
}

function eliminarReceta(id) {
  if (!confirm('¿Eliminar esta receta?')) return;
  api('DELETE', '/api/recetas/' + id).then(() => cargarRecetas());
}

function editarReceta(id) {
  Promise.all([
    api('GET', '/api/recetas'),
    api('GET', '/api/barra/precios')
  ]).then(([recetas, precios]) => {
    const r = recetas.find(rec => rec.id === id);
    if (!r) { alert('Receta no encontrada'); return; }
    const dl = document.getElementById('recetas-base-datalist');
    if (dl) {
      // Only show items currently in barra_precios (BASE DE DATOS)
      dl.innerHTML = precios.map(p => `<option value="${p.ingrediente}">`).join('');
    }
    let html = `
      <h3 style="margin-top:0">EDITAR RECETA</h3>
      <label style="font-weight:600;display:block;margin-bottom:0.2rem">Nombre</label>
      <input id="edit-receta-nombre" value="${r.nombre}" style="width:100%;margin-bottom:0.5rem;">
      <label style="font-weight:600;display:block;margin-bottom:0.2rem">Categoría</label>
      <select id="edit-receta-categoria" style="width:100%;margin-bottom:1rem;">
        ${['RECETAS BASE','Clásicos','Mojitos','Limonadas','LIMONADAS MENU','SODAS','JUGO DE FRUTAS','DEL BARMAN','Chilcanos y Sours','SHOTS','VINO TINTOS'].map(c =>
          `<option value="${c}" ${r.categoria === c ? 'selected' : ''}>${c}</option>`
        ).join('')}
      </select>
      <table>
        <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th><th></th></tr></thead>
        <tbody id="edit-ingredientes-tbody">
          ${r.ingredientes.map((ing, idx) => `
            <tr data-edit-ing-idx="${idx}">
              <td><input class="edit-ing-nombre" value="${ing.ingrediente}" list="recetas-base-datalist" style="width:100%"></td>
              <td><input class="edit-ing-cant" type="number" step="0.01" value="${ing.cantidad}" style="width:80px"></td>
              <td><select class="edit-ing-uni" style="width:90px">
                <option value="unidad" ${normalizeUnit(ing.unidad) === 'unidad' ? 'selected' : ''}>unidad</option>
                <option value="onzas" ${normalizeUnit(ing.unidad) === 'onzas' ? 'selected' : ''}>onzas</option>
                <option value="gramos" ${normalizeUnit(ing.unidad) === 'gramos' ? 'selected' : ''}>gramos</option>
                <option value="ml" ${normalizeUnit(ing.unidad) === 'ml' ? 'selected' : ''}>ml</option>
                <option value="kg" ${normalizeUnit(ing.unidad) === 'kg' ? 'selected' : ''}>kg</option>
                <option value="lt" ${normalizeUnit(ing.unidad) === 'lt' ? 'selected' : ''}>lt</option>
                <option value="hojas" ${normalizeUnit(ing.unidad) === 'hojas' ? 'selected' : ''}>hojas</option>
                <option value="gotas" ${normalizeUnit(ing.unidad) === 'gotas' ? 'selected' : ''}>gotas</option>
                <option value="rodajas" ${normalizeUnit(ing.unidad) === 'rodajas' ? 'selected' : ''}>rodajas</option>
              </select></td>
              <td><button class="danger" onclick="this.closest('tr').remove()">✕</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <button onclick="agregarFilaIngrediente()" style="margin:0.5rem 0">+ AGREGAR INGREDIENTE</button>
      <br>
      <button onclick="guardarEdicionReceta(${id})" style="margin-top:0.5rem">GUARDAR</button>
      <button onclick="cerrarModal()" style="margin-top:0.5rem;margin-left:0.5rem">CANCELAR</button>
    `;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function agregarFilaIngrediente() {
  const tbody = document.getElementById('edit-ingredientes-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="edit-ing-nombre" value="" list="recetas-base-datalist" style="width:100%" placeholder="Ingrediente"></td>
    <td><input class="edit-ing-cant" type="number" step="0.01" value="0" style="width:80px"></td>
    <td><select class="edit-ing-uni" style="width:90px">
      <option value="ml" selected>ml</option>
      <option value="unidad">unidad</option>
      <option value="onzas">onzas</option>
      <option value="gramos">gramos</option>
      <option value="kg">kg</option>
      <option value="lt">lt</option>
      <option value="hojas">hojas</option>
      <option value="gotas">gotas</option>
      <option value="rodajas">rodajas</option>
    </select></td>
    <td><button class="danger" onclick="this.closest('tr').remove()">✕</button></td>
  `;
  tbody.appendChild(tr);
}

function guardarEdicionReceta(id) {
  const nombre = document.getElementById('edit-receta-nombre').value.trim();
  const categoria = document.getElementById('edit-receta-categoria').value;
  if (!nombre) { alert('Nombre requerido'); return; }
  const ingredientes = [];
  document.querySelectorAll('#edit-ingredientes-tbody tr').forEach(tr => {
    const nomIn = tr.querySelector('.edit-ing-nombre');
    const cantIn = tr.querySelector('.edit-ing-cant');
    const uniIn = tr.querySelector('.edit-ing-uni');
    if (nomIn && nomIn.value.trim()) {
      ingredientes.push({
        ingrediente: nomIn.value.trim(),
        cantidad: parseFloat(cantIn.value) || 0,
        unidad: normalizeUnit(uniIn.value)
      });
    }
  });
  api('PUT', '/api/recetas/' + id + '/with-ingredientes', { nombre, categoria, ingredientes }).then(() => {
    cerrarModal();
    cargarRecetas(id);
  }).catch(e => { console.error('Error guardando receta:', e); alert('Error al guardar'); });
}

function agregarIngrediente(recetaId, btn) {
  const tr = btn.closest('tr');
  const ingrediente = tr.querySelector('.input-nuevo-ing').value.trim();
  const cantidad = parseFloat(tr.querySelector('.input-nuevo-cant').value) || 0;
  const unidad = tr.querySelector('.input-nuevo-uni').value;
  if (!ingrediente) { alert('Ingresa el nombre del ingrediente'); return; }
  api('POST', '/api/recetas/' + recetaId + '/ingredientes', { ingrediente, cantidad, unidad: normalizeUnit(unidad) }).then(() => {
    cargarRecetas();
  });
}

function eliminarIngrediente(recetaId, id) {
  if (!confirm('¿Eliminar este ingrediente?')) return;
  api('DELETE', '/api/receta-ingredientes/' + id).then(() => cargarRecetas(recetaId));
}

// --- BARRA: Sub-tabs ---
function cambiarSubTab(nombre, prefix) {
  if (!prefix) prefix = 'barra';
  window.__vista = { cat: prefix, tab: null, sub: nombre, pestana: prefix === 'costos' ? nombre : null };
  const tabsBar = document.getElementById('tabs-' + prefix);
  tabsBar.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  tabsBar.querySelector(`.sub-tab[data-subtab="${nombre}"]`).classList.add('active');
  // Switch content (VENTAS usa tab-ventas-central)
  const tabId = prefix === 'ventas' ? 'tab-ventas-central' : 'tab-' + prefix;
  document.querySelectorAll('#' + tabId + ' .sub-tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById('sub-' + prefix + '-' + nombre).classList.add('active');
  // Lazy load barra movement tabs
  if (prefix === 'barra' && ['ingresos','ventas','bajas'].includes(nombre)) {
    const key = 'barra_' + nombre;
    if (!_loaded[key]) { _loaded[key] = true; cargarBarraMovimientos(nombre); }
  }
  // Lazy load cocina movement tabs
  if (prefix === 'cocina' && ['ingresos','salidas','ventas'].includes(nombre)) {
    const key = 'cocina_' + nombre;
    if (!_loaded[key]) { _loaded[key] = true; cargarCocinaMovimientos(nombre); }
  }
  // Lazy load cocina porcionamiento
  if (prefix === 'cocina' && nombre === 'porcionamiento') {
    const key = 'cocina_porcionamiento';
    if (!_loaded[key]) { _loaded[key] = true; cargarPorcionamientoCocina(); }
  }
  // Lazy load cocina desperdicios
  if (prefix === 'cocina' && nombre === 'desperdicios') {
    const key = 'cocina_desperdicios';
    if (!_loaded[key]) { _loaded[key] = true; cargarDesperdicios(); }
  }
  // Lazy load costos tabs
  if (prefix === 'costos') {
    const key = 'costos_' + nombre;
    if (!_loaded[key]) {
      _loaded[key] = true;
      if (CATEGORIAS_COSTOS[nombre]) {
        cargarCostoCategoria(nombre);
      }
    }
  }
  // VENTAS: registro / búsqueda
  if (prefix === 'ventas') {
    if (nombre === 'registro') cargarVentasCentral();
    else if (nombre === 'busqueda') cargarSugerenciasBusquedaVentasTotal();
  }
}

// --- BARRA: Stock ---
const GRUPOS_BARRA = ['MUEBLE DE ARRIBA', 'MUEBLE DE ABAJO', 'MUEBLE DE APOYO'];
const UNIDADES_STOCK = ['ml', 'unidad', 'onzas', 'gramos', 'kg', 'lt', 'hojas', 'gotas', 'rodajas'];
let _stockDirty = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function marcarStockDirty() {
  _stockDirty = true;
  const b = document.getElementById('btn-guardar-stock');
  if (b) { b.style.background = '#c62828'; b.textContent = '💾 GUARDAR (*)'; }
}

window.addEventListener('beforeunload', (e) => {
  if (_stockDirty) { e.preventDefault(); e.returnValue = ''; }
});

// --- Conversión automática a onzas ---
function botellaParaMl(nombre) {
  const t = String(nombre || '').toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(ml|cc|l|lt)\b/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return (m[2] === 'ml' || m[2] === 'cc') ? v : v * 1000;
}

function calcularOnzas(item) {
  const cant = parseFloat(item.cantidad) || 0;
  const u = (item.unidad || '').toLowerCase();
  if (u === 'onzas') return cant;
  // Regla: 750 ml = 25 onzas (30 ml por onza) como margen de pérdidas
  if (u === 'ml') return cant / 30;
  if (u === 'lt') return (cant * 1000) / 30;
  if (u === 'gramos') return cant / 28.3495;
  if (u === 'kg') return (cant * 1000) / 28.3495;
  if (u === 'unidad' || u === 'botella') {
    const ml = botellaParaMl(item.ingrediente);
    return ml ? (cant * ml) / 30 : null;
  }
  return null;
}

function formatoOnzas(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return n.toFixed(1) + ' onzas';
}

function actualizarOnzasFila(inputEl) {
  const tr = inputEl.closest('tr');
  if (!tr) return;
  const nombre = tr.querySelector('.stock-nombre').textContent.trim();
  const cantidad = parseFloat(inputEl.value) || 0;
  const unidad = tr.querySelector('.select-stock-uni').value;
  tr.querySelector('.onzas-stock').textContent = formatoOnzas(calcularOnzas({ ingrediente: nombre, cantidad, unidad }));
}

function onUnidadStockChange(sel) {
  const cantEl = sel.closest('tr').querySelector('.input-stock-cant');
  actualizarOnzasFila(cantEl);
  marcarStockDirty();
}

function cargarSugerenciasStock() {
  api('GET', '/api/barra/precios').then(data => {
    const dl = document.getElementById('sugerencia-stock-input');
    if (!dl) return;
    const seen = new Set();
    dl.innerHTML = data.map(s => {
      const n = (s.ingrediente || '').trim();
      if (!n || seen.has(n.toLowerCase())) return '';
      seen.add(n.toLowerCase());
      return '<option value="' + n.replace(/"/g, '&quot;') + '"></option>';
    }).join('');
  }).catch(e => console.error('Error cargando sugerencias de stock:', e));
  api('GET', '/api/barra/stock').then(data => {
    const dl = document.getElementById('sugerencia-stock-buscar');
    if (!dl) return;
    const seen = new Set();
    dl.innerHTML = data.map(s => {
      const n = (s.ingrediente || '').trim();
      if (!n || seen.has(n.toLowerCase())) return '';
      seen.add(n.toLowerCase());
      const g = (s.grupo || 'SIN CLASIFICAR').toUpperCase();
      const c = parseFloat(s.cantidad) || 0;
      return '<option value="' + n.replace(/"/g, '&quot;') + ' — ' + esc(g) + ' (' + c + ')"></option>';
    }).join('');
  }).catch(e => console.error('Error cargando sugerencias de busqueda:', e));
}

function cargarStockBarra() {
  const fechaEl = document.getElementById('fecha-stock-barra');
  const fecha = fechaEl ? fechaEl.value : todayStr();
  const esHoy = fecha === todayStr();
  const formAdd = document.getElementById('barra-stock-add-form');
  const banner = document.getElementById('barra-stock-banner');
  if (formAdd) formAdd.style.display = esHoy ? '' : 'none';
  if (banner) {
    if (esHoy) { banner.style.display = 'none'; banner.innerHTML = ''; }
    else {
      banner.style.display = '';
      banner.innerHTML = '<p style="color:#0f3460;background:#e3f2fd;padding:0.5rem 0.75rem;border-radius:6px;">📅 Vista histórica del stock del <b>' + fecha + '</b> (solo lectura). Hoy (' + todayStr() + ') es editable.</p>';
    }
  }
  const url = esHoy ? '/api/barra/stock' : '/api/barra/stock?fecha=' + fecha;
  api('GET', url).then(data => {
    const container = document.getElementById('barra-stock-container');
    if (!data.length) {
      container.innerHTML = '<p>No hay ingredientes en stock' + (esHoy ? '. Agrega uno nuevo.' : ' para esta fecha.') + '</p>';
      _stockDirty = false;
      return;
    }
    const groups = {};
    GRUPOS_BARRA.forEach(g => { groups[g] = []; });
    groups['SIN CLASIFICAR'] = [];
    data.forEach(s => {
      const key = (s.grupo || '').toUpperCase();
      (groups[key] || groups['SIN CLASIFICAR']).push(s);
    });
    function fila(s) {
      const onz = formatoOnzas(calcularOnzas(s));
      const bajo = (parseFloat(s.cantidad) || 0) <= 0.2;
      const badge = bajo ? ' <span class="badge-stock-bajo" title="Stock bajo">STOCK BAJO</span>' : '';
      const cls = bajo ? ' class="stock-bajo"' : '';
      if (!esHoy) {
        return `<tr data-stock-id="${s.id}"${cls}>
          <td class="stock-nombre">${esc(s.ingrediente)}${badge}</td>
          <td>${s.cantidad}</td>
          <td>${s.unidad}</td>
          <td class="onzas-stock">${onz}</td>
          <td>${(s.grupo || 'SIN CLASIFICAR').toUpperCase()}</td>
          <td></td>
        </tr>`;
      }
      const opts = GRUPOS_BARRA.map(g => `<option value="${g}" ${((s.grupo || '').toUpperCase() === g) ? 'selected' : ''}>${g}</option>`).join('');
      const uniList = UNIDADES_STOCK.includes(s.unidad) ? UNIDADES_STOCK : [...UNIDADES_STOCK, s.unidad];
      const uniOpts = uniList.map(u => `<option value="${u}" ${s.unidad === u ? 'selected' : ''}>${u}</option>`).join('');
      return `<tr data-stock-id="${s.id}" data-orig-cantidad="${s.cantidad}" data-orig-unidad="${s.unidad}" data-orig-grupo="${(s.grupo || '').toUpperCase()}"${cls}>
        <td class="stock-nombre">${esc(s.ingrediente)}${badge}</td>
        <td><input type="number" class="input-stock-cant" value="${s.cantidad}" step="0.01" style="width:80px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="actualizarOnzasFila(this); marcarStockDirty()"></td>
        <td><select class="select-stock-uni" onchange="onUnidadStockChange(this)" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;">${uniOpts}</select></td>
        <td class="onzas-stock">${onz}</td>
        <td><select class="select-stock-grupo" onchange="marcarStockDirty()" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;">${opts}</select></td>
        <td>
          <button class="editar" onclick="editarItemStock(${s.id})" style="padding:0.3rem 0.6rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">EDITAR</button>
          <button class="danger" onclick="eliminarStockBarra(${s.id})">✕</button>
        </td>
      </tr>`;
    }
    container.innerHTML = GRUPOS_BARRA.map(g => {
      const items = groups[g];
      const total = items.reduce((sum, i) => sum + (parseFloat(i.cantidad) || 0), 0);
      return `
        <div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${g} <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${items.length} item(s)</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th><th>Onzas</th><th>Mueble</th><th></th></tr></thead>
              <tbody>${items.map(fila).join('') || '<tr><td colspan="6">Vacío.</td></tr>'}</tbody>
            </table></div>
          </div>
        </div>`;
    }).join('') + (groups['SIN CLASIFICAR'].length ? `
        <div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">SIN CLASIFICAR <span style="font-weight:400;font-size:0.85rem;color:#c62828;">— ${groups['SIN CLASIFICAR'].length} item(s) sin mueble asignado</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th><th>Onzas</th><th>Mueble</th><th></th></tr></thead>
              <tbody>${groups['SIN CLASIFICAR'].map(fila).join('')}</tbody>
            </table></div>
          </div>
        </div>` : '');
    _stockDirty = false;
    const b = document.getElementById('btn-guardar-stock');
    if (b) { b.style.background = '#2e7d32'; b.textContent = '💾 GUARDAR STOCK'; }
    if (esHoy) guardarSnapshotStock();
    cargarConsumoNoRegistrado(fecha, container);
  }).catch(e => { console.error(e); });
}

function cargarConsumoNoRegistrado(fecha, container) {
  api('GET', '/api/barra/consumo-no-registrado?fecha=' + encodeURIComponent(fecha)).then(r => {
    const items = r.noRegistrados || [];
    if (!items.length) return;
    const html = `
      <div class="accordion-item" style="border:1px solid #c62828;">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">⚠️ ITEMS CONSUMIDOS NO REGISTRADOS <span style="font-weight:400;font-size:0.85rem;color:#c62828;">— ${items.length} item(s) sin stock</span></span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          <div class="table-wrap"><table>
            <thead><tr><th>Ingrediente</th><th>Consumido</th><th>Unidad</th></tr></thead>
            <tbody>${items.map(it => `<tr><td>${esc(it.ingrediente)}</td><td>${it.cantidad}</td><td>${it.unidad}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>`;
    container.insertAdjacentHTML('beforeend', html);
  }).catch(() => {});
}

function guardarSnapshotStock() {
  const fecha = document.getElementById('fecha-stock-barra')?.value || todayStr();
  const items = [];
  document.querySelectorAll('#barra-stock-container tr[data-stock-id]').forEach(tr => {
    items.push({
      id: tr.getAttribute('data-stock-id'),
      ingrediente: tr.querySelector('.stock-nombre')?.textContent?.trim() || '',
      cantidad: tr.querySelector('.input-stock-cant')?.value || 0,
      unidad: tr.querySelector('.select-stock-uni')?.value || '',
      grupo: tr.querySelector('.select-stock-grupo')?.value || ''
    });
  });
  api('POST', '/api/barra/stock/diario', { fecha, items }).catch(e => console.error('Error guardando snapshot:', e));
}

function agregarStockBarra() {
  const ingrediente = document.getElementById('nuevo-stock-input').value.trim();
  const cantidad = parseFloat(document.getElementById('nuevo-stock-cant').value) || 0;
  const unidad = document.getElementById('nuevo-stock-uni').value;
  const grupo = document.getElementById('nuevo-stock-grupo')?.value || '';
  if (!ingrediente) { alert('Ingresa el nombre del ingrediente'); return; }
  api('POST', '/api/barra/stock', { ingrediente, cantidad, unidad: normalizeUnit(unidad), grupo }).then(() => {
    document.getElementById('nuevo-stock-input').value = '';
    document.getElementById('nuevo-stock-cant').value = '';
    cargarStockBarra();
  }).catch(() => alert('Error al agregar'));
}

function guardarStockBarra() {
  const rows = document.querySelectorAll('#barra-stock-container tr[data-stock-id]');
  const updates = [];
  rows.forEach(tr => {
    const id = Number(tr.getAttribute('data-stock-id'));
    const cantN = parseFloat(tr.querySelector('.input-stock-cant').value) || 0;
    const uni = tr.querySelector('.select-stock-uni').value;
    const grp = tr.querySelector('.select-stock-grupo').value;
    const oCant = parseFloat(tr.getAttribute('data-orig-cantidad')) || 0;
    const oUni = tr.getAttribute('data-orig-unidad');
    const oGrp = tr.getAttribute('data-orig-grupo');
    const body = {};
    if (cantN !== oCant) body.cantidad = cantN;
    if (uni !== oUni) body.unidad = uni;
    if (grp !== oGrp) body.grupo = grp;
    if (Object.keys(body).length) updates.push(api('PUT', '/api/barra/stock/' + id, body));
  });
  if (!updates.length) { showToast('Sin cambios por guardar'); return; }
  Promise.all(updates).then(() => {
    _stockDirty = false;
    const b = document.getElementById('btn-guardar-stock');
    if (b) { b.style.background = '#2e7d32'; b.textContent = '💾 GUARDAR STOCK'; }
    showToast('Stock guardado');
    cargarStockBarra();
  }).catch(() => alert('Error al guardar'));
}

function editarItemStock(id) {
  const tr = document.querySelector('#barra-stock-container tr[data-stock-id="' + id + '"]');
  if (!tr) return;
  showModal('editar-stock-item', {
    id,
    nombre: tr.querySelector('.stock-nombre').textContent.trim(),
    cantidad: tr.querySelector('.input-stock-cant').value,
    unidad: tr.querySelector('.select-stock-uni').value,
    grupo: tr.querySelector('.select-stock-grupo').value
  });
}

function guardarEdicionStock(id) {
  const nombre = document.getElementById('f-stock-nombre').value.trim();
  const cantidad = parseFloat(document.getElementById('f-stock-cantidad').value) || 0;
  const unidad = document.getElementById('f-stock-unidad').value;
  const grupo = document.getElementById('f-stock-grupo').value;
  if (!nombre) { alert('Ingresa el nombre'); return; }
  api('PUT', '/api/barra/stock/' + id, { ingrediente: nombre, cantidad, unidad, grupo }).then(() => {
    cerrarModal();
    showToast('Item actualizado');
    cargarStockBarra();
  }).catch(() => alert('Error al actualizar'));
}

function eliminarStockBarra(id) {
  if (!confirm('¿Eliminar este ingrediente del stock?')) return;
  api('DELETE', '/api/barra/stock/' + id).then(() => cargarStockBarra());
}

// --- COCINA: Stock con familias (flujo diario estilo ALMACENES) ---
const FAMILIAS_COCINA = ['FRUTAS', 'VERDURAS', 'CARNE', 'PESCADO', 'POLLO', 'LACTEOS', 'VINOS', 'CERVEZAS'];

function cargarStockCocina() {
  const fechaEl = document.getElementById('fecha-cocina-stock');
  if (fechaEl && !fechaEl.value) fechaEl.value = todayStr();
  const fecha = fechaEl ? fechaEl.value : todayStr();
  api('GET', '/api/cocina/stock/con-inventario?fecha=' + encodeURIComponent(fecha)).then(grupos => {
    const container = document.getElementById('cocina-stock-container');
    if (!container) return;
    const gruposArr = grupos || [];
    const byFam = {};
    FAMILIAS_COCINA.forEach(f => { byFam[f] = []; });
    byFam['SIN CLASIFICAR'] = [];
    gruposArr.forEach(g => {
      const fam = (g.familia || 'SIN CLASIFICAR').toUpperCase();
      const target = byFam[fam] || byFam['SIN CLASIFICAR'];
      (g.items || []).forEach(i => target.push(i));
    });
    function fila(i) {
      return `<tr data-cocina-id="${i.id}" data-cantidad="${i.cantidad}" data-unidad="${esc(i.unidad)}" data-familia="${esc(i.familia)}">
        <td>${esc(i.nombre)}</td>
        <td><input type="number" class="input-num input-apertura" value="${i.stock_apertura || 0}" step="0.01" oninput="calcCierre(this)"></td>
        <td><input type="number" class="input-num input-ingreso" value="${i.stock_ingreso || 0}" step="0.01" oninput="calcCierre(this)"></td>
        <td><input type="number" class="input-num input-salida" value="${i.salida_almacen || 0}" step="0.01" oninput="calcCierre(this)"></td>
        <td><input type="number" class="input-num input-ventas" value="${i.total_ventas || 0}" step="0.01" oninput="calcCierre(this)"></td>
        <td><input type="number" class="input-num input-falta" value="${i.falta_almacen || 0}" step="0.01" oninput="calcCierre(this)"></td>
        <td><input type="hidden" class="input-baja" value="${i.stock_baja || 0}">
        <td><input type="number" class="input-num input-cierre" value="${i.stock_cierre || 0}" step="0.01" readonly></td>
        <td style="white-space:nowrap">
          <button onclick="editarStockCocina(${i.id})" style="background:#0f3460;color:#fff;border:none;padding:0.2rem 0.4rem;border-radius:3px;cursor:pointer;font-size:0.75rem;">EDITAR</button>
          <button onclick="eliminarStockCocina(${i.id})" style="background:#c62828;color:#fff;border:none;padding:0.2rem 0.4rem;border-radius:3px;cursor:pointer;font-size:0.75rem;">✕</button>
        </td>
      </tr>`;
    }
    function familiaAccordion(f, items, extraClass) {
      return `
        <div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${f} <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${items.length} item(s)</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Item</th><th>Apertura</th><th>Ingreso</th><th>Salida</th><th>Ventas</th><th>Falta</th><th>Cierre</th><th></th></tr></thead>
              <tbody>${items.map(fila).join('') || '<tr><td colspan="8">Vacío.</td></tr>'}</tbody>
            </table></div>
            <button class="btn-agregar-item" onclick="agregarItemCocina('${f}')">+ Agregar Item</button>
          </div>
        </div>`;
    }
    container.innerHTML = FAMILIAS_COCINA.map(f => familiaAccordion(f, byFam[f])).join('') +
      (byFam['SIN CLASIFICAR'].length ? familiaAccordion('SIN CLASIFICAR', byFam['SIN CLASIFICAR'], 'c62828') : '');
    container.querySelectorAll('tr[data-cocina-id]').forEach(tr => calcCierre(tr.querySelector('.input-apertura')));
  }).catch(e => console.error(e));
}

function guardarCocinaDia() {
  const fecha = document.getElementById('fecha-cocina-stock').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const registros = [];
  document.querySelectorAll('#cocina-stock-container tr[data-cocina-id]').forEach(tr => {
    registros.push({
      item_id: Number(tr.getAttribute('data-cocina-id')),
      stock_apertura: parseFloat(tr.querySelector('.input-apertura').value) || 0,
      stock_ingreso: parseFloat(tr.querySelector('.input-ingreso').value) || 0,
      salida_almacen: parseFloat(tr.querySelector('.input-salida').value) || 0,
      total_ventas: parseFloat(tr.querySelector('.input-ventas').value) || 0,
      falta_almacen: parseFloat(tr.querySelector('.input-falta').value) || 0,
      stock_baja: parseFloat(tr.querySelector('.input-baja')?.value) || 0,
    });
  });
  if (!registros.length) { alert('No hay items por guardar'); return; }
  api('POST', '/api/cocina/stock/guardar-dia', { fecha, registros }).then(() => {
    showToast('Datos Guardados');
    cargarStockCocina();
  }).catch(() => alert('Error al guardar'));
}

function agregarItemCocina(familia) {
  showModal('item-cocina', { familia });
}

function guardarNuevoItemCocina() {
  const nombre = document.getElementById('f-cocina-nombre').value.trim();
  const cantidad = parseFloat(document.getElementById('f-cocina-cantidad').value) || 0;
  const unidad = document.getElementById('f-cocina-unidad').value;
  const familia = document.getElementById('f-cocina-familia').value;
  if (!nombre) { alert('Ingresa el nombre'); return; }
  api('POST', '/api/cocina/stock', { ingrediente: nombre, cantidad, unidad, familia }).then(() => {
    cerrarModal();
    showToast('Item agregado');
    cargarStockCocina();
  }).catch(() => alert('Error al agregar'));
}

function editarStockCocina(id) {
  const tr = document.querySelector('#cocina-stock-container tr[data-cocina-id="' + id + '"]');
  if (!tr) return;
  showModal('editar-cocina-stock', {
    id,
    nombre: tr.querySelector('td').textContent.trim(),
    cantidad: tr.getAttribute('data-cantidad') || 0,
    unidad: tr.getAttribute('data-unidad') || 'unidad',
    familia: tr.getAttribute('data-familia') || ''
  });
}

function guardarEdicionStockCocina(id) {
  const nombre = document.getElementById('f-cocina-nombre').value.trim();
  const cantidad = parseFloat(document.getElementById('f-cocina-cantidad').value) || 0;
  const unidad = document.getElementById('f-cocina-unidad').value;
  const familia = document.getElementById('f-cocina-familia').value;
  if (!nombre) { alert('Ingresa el nombre'); return; }
  api('PUT', '/api/cocina/stock/' + id, { ingrediente: nombre, cantidad, unidad, familia }).then(() => {
    cerrarModal();
    showToast('Item actualizado');
    cargarStockCocina();
  }).catch(() => alert('Error al actualizar'));
}

function eliminarStockCocina(id) {
  if (!confirm('¿Eliminar este ingrediente del stock de cocina?')) return;
  api('DELETE', '/api/cocina/stock/' + id).then(() => cargarStockCocina()).catch(() => alert('Error al eliminar'));
}

// --- COCINA: movimientos (ingresos, salidas, ventas) ---
function cargarCocinaMovimientos(tipo) {
  const fecha = document.getElementById('fecha-cocina-' + tipo)?.value || todayStr();
  const accId = 'accordion-cocina-' + tipo;
  if (tipo === 'ventas') {
    Promise.all([
      api('GET', '/api/cocina/recetas'),
      api('GET', '/api/cocina/movimientos?fecha=' + fecha + '&tipo=ventas'),
      api('GET', '/api/cocina/ventas?fecha=' + fecha)
    ]).then(([recetas, movs, ventasCentral]) => {
      const container = document.getElementById(accId);
      if (!container) return;
      if (!recetas.length) { container.innerHTML = '<p>No hay recetas. Crea recetas en COCINA/RECETAS para registrar ventas.</p>'; return; }
      const ordenCat = ['PLATOS', 'ENTRADAS', 'SOPAS', 'CARNES', 'MARISCOS', 'POLLO', 'GUARNICIONES', 'POSTRES', 'OTROS'];
      const recQty = {};
      movs.filter(m => m.es_receta !== false).forEach(m => { recQty[m.ingrediente] = (recQty[m.ingrediente] || 0) + (m.cantidad || 0); });
      // Sumar las ventas de COCINA registradas desde el apartado principal de VENTAS
      (ventasCentral || []).forEach(v => { recQty[v.nombre] = (recQty[v.nombre] || 0) + (v.cantidad || 0); });
      const grupos = {};
      recetas.forEach(r => { const cat = r.categoria || 'PLATOS'; if (!grupos[cat]) grupos[cat] = []; grupos[cat].push(r); });
      const catsToRender = [...ordenCat, ...Object.keys(grupos).filter(c => !ordenCat.includes(c))];
      let html = '<h3 style="margin:0 0 0.5rem 0;">RECETAS VENDIDAS</h3>';
      catsToRender.forEach(cat => {
        const recs = (grupos[cat] || []).filter(r => (recQty[r.nombre] || 0) > 0);
        if (!recs.length) return;
        html += `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${cat} <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${recs.length} receta(s)</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Receta</th><th>Cant. Vendida</th><th>Ingredientes</th></tr></thead>
              <tbody>
                ${recs.map(r => {
                  const qty = recQty[r.nombre] || '';
                  const ings = (r.ingredientes || []).map(i => i.ingrediente).join(', ');
                  return `<tr data-receta="${esc(r.nombre)}" data-ingredientes='${JSON.stringify((r.ingredientes || []).map(i => ({ ingrediente: i.ingrediente, cantidad: i.cantidad, unidad: i.unidad })))}'>
                    <td>${esc(r.nombre)}</td>
                    <td><input type="number" class="input-cocina-receta-qty" value="${qty}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="calcularItemsSalientesCocina()"></td>
                    <td style="font-size:0.8rem;color:#666;">${ings}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table></div>
          </div>
        </div>`;
      });
      html += '<div id="items-salientes-cocina"><h3 style="margin:1rem 0 0.5rem 0;">ITEMS SALIENTES</h3>';
      const ingSaved = movs.filter(m => m.es_receta === false);
      if (ingSaved.length) {
        const agg = {};
        const units = {};
        ingSaved.forEach(m => {
          const key = String(m.ingrediente || '').trim().toUpperCase().replace(/\s+/g, ' ');
          agg[key] = (agg[key] || 0) + (parseFloat(m.cantidad) || 0);
          units[key] = m.unidad || 'unidad';
        });
        const keys = Object.keys(agg).sort();
        html += '<div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Cantidad Consumida</th><th>Unidad</th></tr></thead><tbody>';
        keys.forEach(key => { html += `<tr><td>${key}</td><td>${(agg[key] || 0).toFixed(2)}</td><td>${units[key] || 'unidad'}</td></tr>`; });
        html += '</tbody></table></div>';
      } else {
        html += '<p style="color:#888;">Calculado automáticamente al ingresar cantidades de recetas.</p>';
      }
      html += '</div>';
      container.innerHTML = html;
      const bp = document.getElementById('buscar-cocina-ventas');
      if (bp && bp.value) buscarTablaBarra(bp.value, accId, 'tr[data-receta]');
    }).catch(e => console.error(e));
    return;
  }
  // INGRESOS / SALIDAS
  const fuenteIngresos = tipo === 'ingresos' ? api('GET', '/api/cocina/compras?fecha=' + fecha) : Promise.resolve([]);
  const fuenteSalidasStock = tipo === 'ingresos' ? api('GET', '/api/cocina/salidas-stock?fecha=' + fecha) : Promise.resolve([]);
  Promise.all([
    api('GET', '/api/cocina/stock'),
    api('GET', '/api/cocina/movimientos?fecha=' + fecha + '&tipo=' + tipo),
    fuenteIngresos,
    fuenteSalidasStock
  ]).then(([stock, movs, compras, salidasStock]) => {
    const container = document.getElementById(accId);
    if (!container) return;
    const movByIng = {};
    movs.forEach(m => { movByIng[m.ingrediente] = m; });
    // Sumar los ingresos de COMPRAS (origen PROVEEDOR) y de SALIDAS de STOCK con destino COCINA (origen STOCKS)
    if (tipo === 'ingresos') {
      (compras || []).forEach(c => {
        if (!movByIng[c.nombre]) movByIng[c.nombre] = { cantidad: 0, origen: 'proveedor', unidad: c.unidad || 'unidad' };
        movByIng[c.nombre].cantidad = (movByIng[c.nombre].cantidad || 0) + (c.cantidad || 0);
      });
      (salidasStock || []).forEach(s => {
        if (!movByIng[s.nombre]) movByIng[s.nombre] = { cantidad: 0, origen: 'stocks', unidad: s.unidad || 'unidad' };
        movByIng[s.nombre].cantidad = (movByIng[s.nombre].cantidad || 0) + (s.cantidad || 0);
      });
    }
    if (!stock.length && !Object.keys(movByIng).length) { container.innerHTML = '<p>No hay items en COCINA/STOCK.</p>'; return; }
    // Lista combinada: cocina_stock + items de ingresos que no están en cocina_stock
    const seen = new Set();
    const lista = [];
    stock.forEach(s => { seen.add(s.ingrediente.toUpperCase()); lista.push(s); });
    if (tipo === 'ingresos') {
      Object.keys(movByIng).forEach(n => {
        if (!seen.has(n.toUpperCase())) lista.push({ ingrediente: n, unidad: movByIng[n].unidad || 'unidad' });
      });
    }
    // INGRESOS: solo mostrar los items que SÍ tienen ingreso en la fecha (cantidad > 0)
    if (tipo === 'ingresos') {
      const conIngreso = lista.filter(s => (movByIng[s.ingrediente]?.cantidad || 0) > 0);
      if (!conIngreso.length) {
        container.innerHTML = '<p>No hay ingresos registrados en esta fecha (COMPRAS/INGRESOS o salidas de STOCK a COCINA).</p>';
        const bp = document.getElementById('buscar-cocina-' + tipo);
        if (bp) bp.value = '';
        return;
      }
      lista.length = 0;
      lista.push(...conIngreso);
    }
    const esIngreso = tipo === 'ingresos';
    const colOrigen = esIngreso ? '<th>Origen</th>' : '';
    const cellOrigen = (mov) => esIngreso ? `<td><select class="select-origen-cocina" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;">
      <option value="proveedor" ${mov.origen==='proveedor'?'selected':''}>PROVEEDOR</option>
      <option value="stocks" ${mov.origen==='stocks'?'selected':''}>STOCKS</option>
    </select></td>` : '';
    container.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th>${colOrigen}</tr></thead>
        <tbody>
          ${lista.map(s => {
            const mov = movByIng[s.ingrediente] || {};
            return `<tr data-ing="${esc(s.ingrediente)}" data-uni="${esc(s.unidad || 'unidad')}">
              <td>${esc(s.ingrediente)}</td>
              <td><input type="number" class="input-cocina-mov" value="${mov.cantidad || ''}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
              <td>${esc(s.unidad || 'unidad')}</td>
              ${cellOrigen(mov)}
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
    const bp = document.getElementById('buscar-cocina-' + tipo);
    if (bp && bp.value) buscarEnTabla(bp.value, accId);
  }).catch(e => console.error(e));
}

function guardarCocinaMovimientos(tipo) {
  const fecha = document.getElementById('fecha-cocina-' + tipo)?.value || todayStr();
  if (!fecha) { alert('Selecciona una fecha'); return; }
  let items = [];
  if (tipo === 'ventas') {
    document.querySelectorAll('#accordion-cocina-ventas tr[data-receta]').forEach(tr => {
      const qty = parseFloat(tr.querySelector('.input-cocina-receta-qty').value) || 0;
      if (qty > 0) {
        items.push({ ingrediente: tr.dataset.receta, cantidad: qty, unidad: 'unidad', es_receta: true });
        (JSON.parse(tr.dataset.ingredientes || '[]')).forEach(ing => {
          items.push({ ingrediente: ing.ingrediente, cantidad: (ing.cantidad || 0) * qty, unidad: ing.unidad || 'unidad', es_receta: false, receta: tr.dataset.receta });
        });
      }
    });
    if (!items.length) { alert('Ingresa cantidades de recetas vendidas'); return; }
  } else {
    document.querySelectorAll('#accordion-cocina-' + tipo + ' tr[data-ing]').forEach(tr => {
      const cant = parseFloat(tr.querySelector('.input-cocina-mov').value) || 0;
      if (cant > 0) {
        const item = { ingrediente: tr.dataset.ing, cantidad: cant, unidad: tr.dataset.uni || 'unidad' };
        if (tipo === 'ingresos') item.origen = tr.querySelector('.select-origen-cocina')?.value || 'proveedor';
        items.push(item);
      }
    });
    if (!items.length) { alert('Ingresa cantidades para guardar'); return; }
  }
  api('POST', '/api/cocina/movimientos', { fecha, tipo, items }).then(() => {
    showToast(tipo === 'ingresos' ? 'Ingresos Guardados' : tipo === 'salidas' ? 'Salidas Guardadas' : 'Ventas Guardadas');
    cargarCocinaMovimientos(tipo);
    if (tipo === 'ventas') { cargarStockCocina(); actualizarContadoresMenu(); }
  }).catch(e => { console.error(e); alert('Error al guardar'); });
}

function calcularItemsSalientesCocina() {
  const seccion = document.getElementById('items-salientes-cocina');
  if (!seccion) return;
  const totals = {};
  const units = {};
  document.querySelectorAll('#accordion-cocina-ventas tr[data-receta]').forEach(tr => {
    const qty = parseFloat(tr.querySelector('.input-cocina-receta-qty').value) || 0;
    if (qty > 0) {
      (JSON.parse(tr.dataset.ingredientes || '[]')).forEach(ing => {
        const name = String(ing.ingrediente || '').trim().toUpperCase().replace(/\s+/g, ' ');
        totals[name] = (totals[name] || 0) + ((ing.cantidad || 0) * qty);
        units[name] = ing.unidad || 'unidad';
      });
    }
  });
  const keys = Object.keys(totals).sort();
  let html = '<h3 style="margin:1rem 0 0.5rem 0;">ITEMS SALIENTES</h3>';
  if (!keys.length) { html += '<p style="color:#888;">Calculado automáticamente al ingresar cantidades de recetas.</p>'; }
  else {
    html += '<div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Cantidad Consumida</th><th>Unidad</th></tr></thead><tbody>';
    keys.forEach(key => { html += `<tr><td>${key}</td><td>${totals[key].toFixed(2)}</td><td>${units[key] || 'unidad'}</td></tr>`; });
    html += '</tbody></table></div>';
  }
  seccion.innerHTML = html;
}

function verDetallesCocina(tipo) {
  const fecha = document.getElementById('fecha-cocina-' + tipo)?.value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const label = tipo === 'ingresos' ? 'Ingresos' : tipo === 'salidas' ? 'Salidas' : 'Ventas';
  api('GET', '/api/cocina/movimientos?fecha=' + fecha + '&tipo=' + tipo).then(movs => {
    let html = '<h3>Detalle de ' + label + ' Cocina — ' + fecha + '</h3>';
    if (tipo === 'ventas') movs = movs.filter(m => m.es_receta !== false);
    if (!movs.length) { html += '<p>No hay movimientos registrados en esta fecha.</p>'; }
    else {
      const colOrigen = tipo === 'ingresos' ? '<th>Origen</th>' : '';
      html += '<div class="table-wrap"><table><thead><tr><th>Receta</th><th>Cantidad</th>' + colOrigen + '<th>Usuario</th><th>Hora</th></tr></thead><tbody>';
      movs.forEach(m => {
        const t = m.created_at ? new Date(m.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
        const u = DISPLAY_NAMES[m.saved_by] || m.saved_by || '-';
        const origen = tipo === 'ingresos' ? '<td>' + ((m.origen || '').toUpperCase() || '—') + '</td>' : '';
        html += '<tr><td>' + esc(m.ingrediente) + '</td><td>' + (m.cantidad || 0) + '</td>' + origen + '<td>' + u + '</td><td>' + t + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  }).catch(() => alert('Error al cargar detalle'));
}

// --- COCINA: Recetas ---
function renderRecetaCocina(r) {
  return `<div class="accordion-item" data-receta-id="${r.id}">
    <div class="accordion-header" onclick="toggleAcordeon(this)">
      <span class="accordion-title">${esc(r.nombre)}</span>
      <span class="accordion-actions" onclick="event.stopPropagation()">
        <button onclick="editarRecetaCocina(${r.id})" style="margin-right:0.3rem">EDITAR</button>
        <button class="danger" onclick="eliminarRecetaCocina(${r.id})">ELIMINAR</button>
      </span>
      <span class="accordion-arrow">▶</span>
    </div>
    <div class="accordion-body">
      <div class="table-wrap"><table>
        <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th></tr></thead>
        <tbody>
          ${(r.ingredientes || []).map(ing => `<tr><td>${esc(ing.ingrediente)}</td><td>${ing.cantidad}</td><td>${ing.unidad}</td></tr>`).join('') || '<tr><td colspan="3">Sin ingredientes.</td></tr>'}
        </tbody>
      </table></div>
    </div>
  </div>`;
}

function cargarRecetasCocina(openId) {
  api('GET', '/api/cocina/recetas').then(data => {
    const container = document.getElementById('cocina-recetas-container');
    if (!container) return;
    if (!data.length) { container.innerHTML = '<p>No hay recetas. Agrega una nueva.</p>'; return; }
    const grupos = {};
    data.forEach(r => { const cat = r.categoria || 'PLATOS'; if (!grupos[cat]) grupos[cat] = []; grupos[cat].push(r); });
    const ordenCat = ['PLATOS', 'ENTRADAS', 'SOPAS', 'CARNES', 'MARISCOS', 'POLLO', 'GUARNICIONES', 'POSTRES', 'OTROS'];
    const catsToRender = [...ordenCat, ...Object.keys(grupos).filter(c => !ordenCat.includes(c))];
    let html = '';
    catsToRender.forEach(cat => {
      const recs = grupos[cat] || [];
      if (!recs.length) return;
      html += `<div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${cat} <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${recs.length} receta(s)</span></span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">${recs.map(renderRecetaCocina).join('')}</div>
      </div>`;
    });
    container.innerHTML = html;
    if (openId !== undefined) {
      const el = container.querySelector(`[data-receta-id="${openId}"]`);
      if (el) {
        const catBody = el.parentElement;
        const parent = catBody && catBody.classList.contains('accordion-body') ? catBody.parentElement : null;
        if (parent) { const ch = parent.querySelector('.accordion-header'); if (ch && !ch.classList.contains('active')) toggleAcordeon(ch); }
        const rh = el.querySelector('.accordion-header');
        if (rh && !rh.classList.contains('active')) toggleAcordeon(rh);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }).catch(e => console.error(e));
}

function guardarRecetaCocina() {
  const input = document.getElementById('nueva-receta-cocina-input');
  const cat = document.getElementById('nueva-receta-cocina-cat').value;
  const nombre = input.value.trim();
  if (!nombre) { alert('Ingresa un nombre'); return; }
  api('POST', '/api/cocina/recetas', { nombre, categoria: cat }).then(() => {
    input.value = '';
    cargarRecetasCocina();
  }).catch(() => alert('Error al crear receta'));
}

function eliminarRecetaCocina(id) {
  if (!confirm('¿Eliminar esta receta?')) return;
  api('DELETE', '/api/cocina/recetas/' + id).then(() => cargarRecetasCocina()).catch(() => alert('Error al eliminar'));
}

function editarRecetaCocina(id) {
  api('GET', '/api/cocina/recetas').then(recetas => {
    const r = recetas.find(rec => rec.id === id);
    if (!r) { alert('Receta no encontrada'); return; }
    api('GET', '/api/basedatos/unificada').then(uni => {
      const dl = document.getElementById('recetas-base-datalist');
      if (dl) {
        const vistos = new Set();
        dl.innerHTML = (uni || []).map(p => {
          const n = String(p.nombre || '').trim();
          const k = n.toUpperCase();
          if (!n || vistos.has(k)) return '';
          vistos.add(k);
          return `<option value="${esc(n)}">`;
        }).join('');
      }
      const cats = ['PLATOS', 'ENTRADAS', 'SOPAS', 'CARNES', 'MARISCOS', 'POLLO', 'GUARNICIONES', 'POSTRES', 'OTROS'];
      document.getElementById('modal-body').innerHTML = `
        <h3 style="margin-top:0">EDITAR RECETA</h3>
        <label style="font-weight:600;display:block;margin-bottom:0.2rem">Nombre</label>
        <input id="edit-receta-cocina-nombre" value="${esc(r.nombre)}" style="width:100%;margin-bottom:0.5rem;">
        <label style="font-weight:600;display:block;margin-bottom:0.2rem">Categoría</label>
        <select id="edit-receta-cocina-categoria" style="width:100%;margin-bottom:1rem;">
          ${cats.map(c => `<option value="${c}" ${r.categoria === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <div class="table-wrap"><table>
          <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th><th></th></tr></thead>
          <tbody id="edit-cocina-ingredientes-tbody">
            ${(r.ingredientes || []).map(ing => `
              <tr data-edit-ing-idx="${ing.id}">
                <td><input class="edit-cocina-ing-nombre" value="${esc(ing.ingrediente)}" list="recetas-base-datalist" style="width:100%"></td>
                <td><input class="edit-cocina-ing-cant" type="number" step="0.01" value="${ing.cantidad}" style="width:80px"></td>
                <td><select class="edit-cocina-ing-uni" style="width:90px">
                  <option value="unidad" ${normalizeUnit(ing.unidad) === 'unidad' ? 'selected' : ''}>unidad</option>
                  <option value="kg" ${normalizeUnit(ing.unidad) === 'kg' ? 'selected' : ''}>kg</option>
                  <option value="gramos" ${normalizeUnit(ing.unidad) === 'gramos' ? 'selected' : ''}>gramos</option>
                  <option value="lt" ${normalizeUnit(ing.unidad) === 'lt' ? 'selected' : ''}>lt</option>
                  <option value="ml" ${normalizeUnit(ing.unidad) === 'ml' ? 'selected' : ''}>ml</option>
                  <option value="onzas" ${normalizeUnit(ing.unidad) === 'onzas' ? 'selected' : ''}>onzas</option>
                </select></td>
                <td><button class="danger" onclick="this.closest('tr').remove()">✕</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
        <button onclick="agregarFilaIngredienteCocina()" style="margin:0.5rem 0">+ AGREGAR INGREDIENTE</button>
        <div style="font-size:0.75rem;color:#777;margin:0.3rem 0 0.6rem;">Los ingredientes nuevos (que no existan en la base de datos) se agregan automáticamente a la base de datos unificada.</div>
        <br>
        <button onclick="guardarEdicionRecetaCocina(${id})" style="margin-top:0.5rem">GUARDAR</button>
        <button onclick="cerrarModal()" style="margin-top:0.5rem;margin-left:0.5rem">CANCELAR</button>
      `;
      document.getElementById('modal').style.display = 'block';
    }).catch(() => alert('Error cargando base de datos'));
  }).catch(() => alert('Error al cargar receta'));
}

function agregarFilaIngredienteCocina() {
  const tbody = document.getElementById('edit-cocina-ingredientes-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="edit-cocina-ing-nombre" value="" list="recetas-base-datalist" style="width:100%" placeholder="Ingrediente"></td>
    <td><input class="edit-cocina-ing-cant" type="number" step="0.01" value="0" style="width:80px"></td>
    <td><select class="edit-cocina-ing-uni" style="width:90px">
      <option value="unidad" selected>unidad</option>
      <option value="kg">kg</option>
      <option value="gramos">gramos</option>
      <option value="lt">lt</option>
      <option value="ml">ml</option>
      <option value="onzas">onzas</option>
    </select></td>
    <td><button class="danger" onclick="this.closest('tr').remove()">✕</button></td>
  `;
  tbody.appendChild(tr);
}

function guardarEdicionRecetaCocina(id) {
  const nombre = document.getElementById('edit-receta-cocina-nombre').value.trim();
  const categoria = document.getElementById('edit-receta-cocina-categoria').value;
  if (!nombre) { alert('Nombre requerido'); return; }
  const ingredientes = [];
  document.querySelectorAll('#edit-cocina-ingredientes-tbody tr').forEach(tr => {
    const nomIn = tr.querySelector('.edit-cocina-ing-nombre');
    const cantIn = tr.querySelector('.edit-cocina-ing-cant');
    const uniIn = tr.querySelector('.edit-cocina-ing-uni');
    if (nomIn && nomIn.value.trim()) {
      ingredientes.push({ ingrediente: nomIn.value.trim(), cantidad: parseFloat(cantIn.value) || 0, unidad: normalizeUnit(uniIn.value) });
    }
  });
  api('PUT', '/api/cocina/recetas/' + id + '/with-ingredientes', { nombre, categoria, ingredientes }).then(() => {
    cerrarModal();
    showToast('Receta actualizada');
    cargarRecetasCocina();
  }).catch(() => alert('Error al guardar receta'));
}

function buscarRecetaCocina(q) {
  const term = (q || '').trim();
  const palabras = term.toLowerCase().split(/\s+/).filter(Boolean);
  const container = document.getElementById('cocina-recetas-container');
  if (!container) return;
  container.querySelectorAll('.accordion-item[data-receta-id]').forEach(recipe => {
    const nombre = recipe.querySelector('.accordion-title')?.textContent?.toLowerCase() || '';
    const familia = (recipe.closest('.accordion-body')?.parentElement?.querySelector('.accordion-header .accordion-title')?.textContent || '').toLowerCase();
    const ingredientes = Array.from(recipe.querySelectorAll('.accordion-body tbody td:first-child')).map(td => (td.textContent || '').toLowerCase().trim());
    const texto = (nombre + ' ' + familia + ' ' + ingredientes.join(' ')).toLowerCase();
    recipe.style.display = (!palabras.length || palabras.every(p => texto.includes(p))) ? '' : 'none';
  });
  Array.from(container.children).forEach(cat => {
    if (!cat.classList.contains('accordion-item')) return;
    const recipes = cat.querySelectorAll('.accordion-item[data-receta-id]');
    const anyVisible = Array.from(recipes).some(r => r.style.display !== 'none');
    cat.style.display = !term || anyVisible ? '' : 'none';
    if (term && anyVisible) {
      const header = cat.querySelector('.accordion-header');
      if (header && !header.classList.contains('active')) toggleAcordeon(header);
    }
  });
}

function exportarRecetasCocina() {
  api('GET', '/api/cocina/recetas').then(data => {
    const wsData = [['Categoría', 'Receta', 'Ingrediente', 'Cantidad', 'Unidad']];
    data.forEach(r => {
      if (r.ingredientes && r.ingredientes.length) {
        r.ingredientes.forEach(ing => wsData.push([r.categoria || 'Platos', r.nombre, ing.ingrediente, ing.cantidad, ing.unidad]));
      } else {
        wsData.push([r.categoria || 'Platos', r.nombre, '—', '', '']);
      }
    });
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Recetas');
    XLSX.writeFile(libro, 'Recetas_Cocina.xlsx');
  });
}

// --- COCINA: PORCIONAMIENTO ---
let _porcionamientoCtx = null;

function cargarPorcionamientoCocina(seleccionarItem) {
  const fechaEl = document.getElementById('fecha-porcionamiento');
  if (fechaEl && !fechaEl.value) fechaEl.value = todayStr();
  const fecha = fechaEl ? fechaEl.value : todayStr();
  const container = document.getElementById('cocina-porcionamiento-container');
  if (!container) return;
  Promise.all([
    api('GET', '/api/cocina/stock'),
    api('GET', '/api/cocina/porcionamientos?fecha=' + fecha),
    api('GET', '/api/cocina/precios'),
    api('GET', '/api/cocina/compras')
  ]).then(([stock, porcs, precios, compras]) => {
    _porcionamientoCtx = { fecha, stock: stock || [], porcs: porcs || [], precios: precios || [], compras: compras || [], item: null };
    const items = stock || [];
    const porc = porcs || [];
    let html = '<div class="table-wrap" style="margin-bottom:0.5rem;"><div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">'
      + '<label style="font-weight:600;">Item de COCINA/STOCK:</label>'
      + '<select id="porcionamiento-item" onchange="cargarPorcionamientoItem()" style="padding:0.4rem;border:1px solid #ccc;border-radius:4px;min-width:260px;">'
      + '<option value="">— Seleccionar —</option>'
      + items.map(s => `<option value="${esc(s.ingrediente)}">${esc(s.ingrediente)} (${s.cantidad || 0})</option>`).join('')
      + '</select>'
      + '</div></div>';
    // Lista de TODOS los porcionamientos del día (guardados)
    html += '<div style="margin-top:0.5rem;margin-bottom:0.5rem;"><strong style="color:#0f3460;">Porcionamientos del día (' + porc.length + ')</strong></div>';
    if (porc.length) {
      html += '<div class="table-wrap" style="margin-bottom:0.5rem;"><table><thead><tr><th>Item</th><th>Stock</th><th>Secciones</th><th></th></tr></thead><tbody>';
      porc.forEach(p => {
        html += `<tr>
          <td>${esc(p.nombre)}</td>
          <td>${p.stock}</td>
          <td style="font-size:0.8rem;">${(p.secciones || []).map(s => esc(s.nombre) + ' ' + s.peso).join(' · ') || '—'}</td>
          <td style="white-space:nowrap;">
            <button onclick="cargarPorcionamientoExistente('${esc(p.nombre)}')" style="background:#0f3460;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.75rem;">ABRIR</button>
            <button class="danger" onclick="eliminarPorcionamiento('${p.id}')">✕</button>
          </td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    } else {
      html += '<p style="font-size:0.85rem;color:#888;margin-bottom:0.5rem;">Aún no hay porcionamientos guardados hoy. Selecciona un item y guarda.</p>';
    }
    html += '<div id="porcionamiento-editor"></div>';
    container.innerHTML = html;
    // Re-seleccionar el item que estaba activo (para seguir guardando varios)
    if (seleccionarItem) {
      const sel = document.getElementById('porcionamiento-item');
      if (sel) {
        sel.value = seleccionarItem;
        cargarPorcionamientoItem();
      }
    }
  }).catch(() => { container.innerHTML = '<p style="color:#c62828;">Error cargando porcionamiento.</p>'; });
}

function cargarPorcionamientoItem() {
  const ctx = _porcionamientoCtx;
  if (!ctx) return;
  const sel = document.getElementById('porcionamiento-item');
  const nombre = sel ? sel.value : '';
  const editor = document.getElementById('porcionamiento-editor');
  if (!editor) return;
  if (!nombre) { editor.innerHTML = ''; return; }
  const item = (ctx.stock || []).find(s => String(s.ingrediente || '') === nombre);
  const stock = item ? (item.cantidad || 0) : 0;
  const porc = (ctx.porcs || []).find(p => String(p.nombre || '').trim().toUpperCase() === String(nombre).trim().toUpperCase());
  const secciones = porc && porc.secciones && porc.secciones.length
    ? porc.secciones
    : [
        { nombre: 'PESO BRUTO', peso: stock },
        { nombre: 'CABEZA, COLA, ALETAS Y ESQUELETO', peso: 0 },
        { nombre: 'FILETES', peso: 0 },
        { nombre: 'DESPERDICIO', peso: 0 }
      ];
  // Calcular el precio TOTAL pagado por el item (ultima compra) para mostrarlo en el detalle
  const normF = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const nombreNorm = normF(nombre);
  const comprasItem = (ctx.compras || []).filter(c => normF(c.nombre) === nombreNorm);
  let precioTotal = 0;
  if (comprasItem.length) {
    comprasItem.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    const c = comprasItem[0];
    precioTotal = parseFloat(c.precio_total) > 0 ? parseFloat(c.precio_total) : (parseFloat(c.precio) || 0) * (parseFloat(c.cantidad) || 1);
  }
  _porcionamientoCtx.item = { nombre, stock, precioTotal };
  renderPorcionamientoEditor(secciones);
  // Consultar el precio SIEMPRE en vivo al backend y actualizar las celdas (garantiza el dato real)
  api('GET', '/api/cocina/compras').then(comprasAll => {
    const norm2 = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const list = (comprasAll || []).filter(c => norm2(c.nombre) === nombreNorm);
    if (list.length) {
      list.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
      const c = list[0];
      const pt = parseFloat(c.precio_total) > 0 ? parseFloat(c.precio_total) : (parseFloat(c.precio) || 0) * (parseFloat(c.cantidad) || 1);
      if (pt > 0) {
        _porcionamientoCtx.item.precioTotal = pt;
        _porcionamientoCtx.compras = comprasAll || [];
        actualizarTotalPorcionamiento();
      }
    }
  }).catch(() => {});
}

function cargarPorcionamientoExistente(nombre) {
  const sel = document.getElementById('porcionamiento-item');
  if (sel) sel.value = nombre;
  cargarPorcionamientoItem();
}

function renderPorcionamientoEditor(secciones) {
  const ctx = _porcionamientoCtx;
  const editor = document.getElementById('porcionamiento-editor');
  if (!editor || !ctx || !ctx.item) return;
  const stock = ctx.item.stock;
  editor.innerHTML = '<h3 style="margin-top:0">Porcionamiento: ' + esc(ctx.item.nombre) + '</h3>'
    + '<p style="font-size:0.85rem;color:#666;">Stock en COCINA: <b>' + stock + '</b>. Registra manualmente a dónde se fue cada porción.</p>'
    + '<div class="table-wrap"><table>'
    + '<thead><tr><th>Sección / Porcionamiento</th><th>Peso</th><th>%</th><th>Precio</th><th></th></tr></thead>'
    + '<tbody id="porcionamiento-secciones">' + secciones.map(porcionFila).join('') + '</tbody>'
    + '</table></div>'
    + '<button onclick="agregarSeccionPorcionamiento()" style="margin:0.5rem 0;">+ SECCIÓN</button>'
    + '<span id="porcionamiento-total" style="font-size:0.9rem;margin-left:0.5rem;display:inline-block;margin-top:0.2rem;"></span>'
    + '<br>'
    + '<div id="porcionamiento-packs" style="margin-top:0.75rem;padding:0.75rem;background:#e8f5e9;border-radius:8px;border:1px solid #c8e6c9;">'
    + '<strong style="color:#2e7d32;">📦 GENERAR PACKS desde FILETES</strong>'
    + '<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.5rem;">'
    + '<label>Tamaño del pack (gr):</label>'
    + '<input id="pack-gramos" type="number" step="1" min="1" value="150" style="width:80px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="calcularPacksPorcionamiento()">'
    + '<span style="font-size:0.9rem;">Peso de FILETES: <b id="pack-filet-peso">0</b> kg</span>'
    + '</div>'
    + '<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.5rem;">'
    + '<label>Packs calculados:</label>'
    + '<input id="pack-cantidad" type="number" step="1" min="0" value="0" style="width:80px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;">'
    + '<span style="font-size:0.8rem;color:#666;">(calculado automáticamente, puedes calibrarlo manualmente)</span>'
    + '</div>'
    + '</div>'
    + '<div class="porcionamiento-acciones">'
    + '<button class="btn-accion btn-transformar" onclick="aplicarTransformacionPorcionamiento()">🔄 APLICAR TRANSFORMACIÓN</button>'
    + '<button class="btn-accion btn-guardar" onclick="guardarPorcionamiento()">💾 GUARDAR</button>'
    + '<button class="btn-accion btn-eliminar" onclick="eliminarPorcionamientoActual()">🗑️ ELIMINAR</button>'
    + '</div>';
  actualizarTotalPorcionamiento();
  calcularPacksPorcionamiento();
}

function porcionFila(sec) {
  const nom = esc(sec.nombre);
  return '<tr>'
    + '<td><input class="input-porc-nombre" value="' + nom + '" style="width:100%;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="actualizarTotalPorcionamiento(); calcularPacksPorcionamiento();"></td>'
    + '<td><input class="input-porc-peso" type="number" step="0.01" min="0" value="' + (sec.peso || 0) + '" oninput="actualizarTotalPorcionamiento(); calcularPacksPorcionamiento();" style="width:80px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>'
    + '<td class="celda-porc-pct" style="text-align:right;font-weight:600;color:#0f3460;">—</td>'
    + '<td class="celda-porc-precio" style="text-align:right;">—</td>'
    + '<td><button class="danger" onclick="this.closest(\'tr\').remove(); actualizarTotalPorcionamiento(); calcularPacksPorcionamiento();">✕</button></td>'
    + '</tr>';
}

function agregarSeccionPorcionamiento() {
  const tbody = document.getElementById('porcionamiento-secciones');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><input class="input-porc-nombre" placeholder="Sección (ej. CABEZA, COLAS...)" style="width:100%;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="actualizarTotalPorcionamiento(); calcularPacksPorcionamiento();"></td>'
    + '<td><input class="input-porc-peso" type="number" step="0.01" min="0" value="0" oninput="actualizarTotalPorcionamiento(); calcularPacksPorcionamiento();" style="width:80px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>'
    + '<td class="celda-porc-pct" style="text-align:right;font-weight:600;color:#0f3460;">—</td>'
    + '<td class="celda-porc-precio" style="text-align:right;">—</td>'
    + '<td><button class="danger" onclick="this.closest(\'tr\').remove(); actualizarTotalPorcionamiento(); calcularPacksPorcionamiento();">✕</button></td>';
  tbody.appendChild(tr);
  actualizarTotalPorcionamiento();
  calcularPacksPorcionamiento();
}

// PESO BRUTO = total de peso que entra al porcionamiento. Las DEMAS secciones deben sumar
// igual que el PESO BRUTO; la diferencia se muestra como FALTANTE (o EXCESO).
function sumarPorcionamiento() {
  let bruto = 0;
  let sumaOtros = 0;
  document.querySelectorAll('#porcionamiento-secciones tr').forEach(tr => {
    const nom = (tr.querySelector('.input-porc-nombre')?.value || '').trim().toUpperCase();
    const peso = parseFloat(tr.querySelector('.input-porc-peso')?.value) || 0;
    if (nom === 'PESO BRUTO') bruto = peso;
    else sumaOtros += peso;
  });
  return { bruto, sumaOtros, faltante: bruto - sumaOtros };
}

function actualizarTotalPorcionamiento() {
  // 1) Calcular % por fila (independiente del precio, siempre se muestra)
  const { bruto, sumaOtros, faltante } = sumarPorcionamiento();
  const total = document.getElementById('porcionamiento-total');
  document.querySelectorAll('#porcionamiento-secciones tr').forEach(tr => {
    const peso = parseFloat(tr.querySelector('.input-porc-peso')?.value) || 0;
    const pctCell = tr.querySelector('.celda-porc-pct');
    if (pctCell) {
      pctCell.textContent = bruto > 0 ? (Math.round((peso / bruto) * 10000) / 100) + '%' : '—';
    }
  });

  // 2) Calcular PRECIO por fila (protegido, si falla no rompe el %)
  let precioPorKiloBruto = 0;
  let precioPorKiloFiletes = 0;
  try {
    const ctx = _porcionamientoCtx;
    const filetesPeso = obtenerPesoSeccion('FILETE');
    const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const nombreItem = ctx && ctx.item ? ctx.item.nombre : '';
    const precioTotalBruto = obtenerPrecioItem(ctx, norm(nombreItem));
    precioPorKiloBruto = bruto > 0 ? (precioTotalBruto / bruto) : 0;
    precioPorKiloFiletes = filetesPeso > 0 ? (precioTotalBruto / filetesPeso) : 0;

    document.querySelectorAll('#porcionamiento-secciones tr').forEach(tr => {
      const nom = (tr.querySelector('.input-porc-nombre')?.value || '').trim().toUpperCase();
      const precioCell = tr.querySelector('.celda-porc-precio');
      if (!precioCell) return;
      if (nom === 'PESO BRUTO') {
        precioCell.textContent = precioPorKiloBruto > 0 ? 'S/ ' + precioPorKiloBruto.toFixed(2) + '/kg' : '—';
      } else if (nom.includes('FILETE')) {
        precioCell.textContent = precioPorKiloFiletes > 0 ? 'S/ ' + precioPorKiloFiletes.toFixed(2) + '/kg' : '—';
      } else {
        precioCell.textContent = '';
      }
    });
  } catch (e) {
    console.error('Error calculando precio porcionamiento:', e);
  }

  // 3) Resumen inferior
  if (total) {
    const sumO = Math.round(sumaOtros * 100) / 100;
    const diff = Math.round(faltante * 100) / 100;
    let html = 'Peso bruto: <b>' + bruto + '</b> kg · Precio/kg bruto: <b>S/ ' + (precioPorKiloBruto > 0 ? precioPorKiloBruto.toFixed(2) : '0') + '</b> · Suma porciones: <b>' + sumO + '</b>';
    if (diff > 0) html += ' · <span style="color:#c62828;font-weight:700;">FALTANTE: ' + diff + '</span>';
    else if (diff < 0) html += ' · <span style="color:#e65100;font-weight:700;">EXCESO: ' + Math.abs(diff) + '</span>';
    else html += ' · <span style="color:#2e7d32;font-weight:700;">OK ✓</span>';
    total.innerHTML = html;
  }
}

// Obtiene el peso de una sección por nombre (ej. FILETE)
function obtenerPesoSeccion(filtro) {
  let peso = 0;
  // Acepta string (ej. 'FILETE') o regex (/FILETE/i)
  const esString = typeof filtro === 'string';
  document.querySelectorAll('#porcionamiento-secciones tr').forEach(tr => {
    const nom = (tr.querySelector('.input-porc-nombre')?.value || '').trim().toUpperCase();
    const p = parseFloat(tr.querySelector('.input-porc-peso')?.value) || 0;
    if (esString ? nom.includes(filtro.toUpperCase()) : filtro.test(nom)) peso = p;
  });
  return peso;
}

// Obtiene el precio TOTAL del peso bruto del item (el precio que se pago por la compra)
function obtenerPrecioItem(ctx, nombreNorm) {
  if (!ctx) return 0;
  // 0) Si ya se calculo el precioTotal al seleccionar el item, usarlo directamente
  if (ctx.item && ctx.item.precioTotal > 0) return ctx.item.precioTotal;
  const normF = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  // 1) Buscar la compra MÁS RECIENTE del item (precio_total = el precio real pagado por el peso bruto)
  const comprasItem = (ctx.compras || []).filter(c => normF(c.nombre) === nombreNorm);
  if (comprasItem.length) {
    comprasItem.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    const c = comprasItem[0];
    if (parseFloat(c.precio_total) > 0) return parseFloat(c.precio_total);
    if (parseFloat(c.precio) > 0) return parseFloat(c.precio) * (parseFloat(c.cantidad) || 1);
  }
  // 2) Buscar en cocina_precios el precio_compra (por unidad) * cantidad del stock
  const prec = (ctx.precios || []).find(p => normF(p.ingrediente) === nombreNorm);
  if (prec && parseFloat(prec.precio_compra) > 0) {
    const stock = (ctx.stock || []).find(s => normF(s.ingrediente) === nombreNorm);
    const cant = stock ? (parseFloat(stock.cantidad) || 0) : 1;
    return parseFloat(prec.precio_compra) * (cant > 0 ? cant : 1);
  }
  return 0;
}

function guardarPorcionamiento() {
  const ctx = _porcionamientoCtx;
  if (!ctx || !ctx.item) { alert('Selecciona un item'); return; }
  const secciones = [];
  document.querySelectorAll('#porcionamiento-secciones tr').forEach(tr => {
    const nom = tr.querySelector('.input-porc-nombre')?.value?.trim();
    const peso = parseFloat(tr.querySelector('.input-porc-peso')?.value) || 0;
    if (nom) secciones.push({ nombre: nom, peso });
  });
  if (!secciones.length) { alert('Agrega al menos una sección'); return; }
  const nombreGuardado = ctx.item.nombre;
  api('POST', '/api/cocina/porcionamientos', { nombre: ctx.item.nombre, fecha: ctx.fecha, secciones }).then(() => {
    showToast('Porcionamiento guardado');
    // Recargar la lista manteniendo el item seleccionado (para seguir con varios del día)
    cargarPorcionamientoCocina(nombreGuardado);
  }).catch(() => alert('Error al guardar'));
}

function eliminarPorcionamiento(id) {
  if (!confirm('¿Eliminar este porcionamiento?')) return;
  api('DELETE', '/api/cocina/porcionamientos/' + id).then(() => {
    showToast('Eliminado');
    cargarPorcionamientoCocina();
  }).catch(() => alert('Error al eliminar'));
}

function eliminarPorcionamientoActual() {
  const ctx = _porcionamientoCtx;
  if (!ctx || !ctx.item) return;
  const porc = (ctx.porcs || []).find(p => String(p.nombre || '').trim().toUpperCase() === String(ctx.item.nombre).trim().toUpperCase());
  if (!porc) return;
  eliminarPorcionamiento(porc.id);
}

// Calcula cuantos PACKS salen del peso de FILETES (automático, con opción de calibrar manual)
function calcularPacksPorcionamiento() {
  const filetEl = Array.from(document.querySelectorAll('#porcionamiento-secciones tr')).find(tr => {
    const nom = (tr.querySelector('.input-porc-nombre')?.value || '').trim().toUpperCase();
    return nom.includes('FILETE');
  });
  const filetPesoKg = filetEl ? (parseFloat(filetEl.querySelector('.input-porc-peso')?.value) || 0) : 0;
  const pesoEl = document.getElementById('pack-filet-peso');
  if (pesoEl) pesoEl.textContent = filetPesoKg;
  const gramos = parseFloat(document.getElementById('pack-gramos')?.value) || 0;
  const cantEl = document.getElementById('pack-cantidad');
  if (!cantEl) return;
  if (gramos > 0 && filetPesoKg > 0) {
    const packs = Math.floor((filetPesoKg * 1000) / gramos);
    cantEl.value = packs;
  }
}

// Aplica la transformacion: saca el item original (queda en 0) y mete los productos resultantes
// (cabeza/colas + packs) a COCINA/STOCK; registra el desperdicio en la pestaña DESPERDICIOS.
function aplicarTransformacionPorcionamiento() {
  const ctx = _porcionamientoCtx;
  if (!ctx || !ctx.item) { alert('Selecciona un item'); return; }
  const secciones = [];
  document.querySelectorAll('#porcionamiento-secciones tr').forEach(tr => {
    const nom = tr.querySelector('.input-porc-nombre')?.value?.trim();
    const peso = parseFloat(tr.querySelector('.input-porc-peso')?.value) || 0;
    if (nom) secciones.push({ nombre: nom, peso });
  });
  if (!secciones.length) { alert('Agrega al menos una sección'); return; }

  // Identificar secciones
  const getSeccion = (filtro) => {
    const s = secciones.find(x => filtro.test(x.nombre.toUpperCase()));
    return s ? s.peso : 0;
  };
  const bruto = getSeccion(/PESO BRUTO/);
  const cabeza = getSeccion(/CABEZA|COLA|ALETAS|ESQUELETO/);
  const filetes = getSeccion(/FILETE/);
  const desperdicio = getSeccion(/DESPERDICIO/);
  const gramos = parseFloat(document.getElementById('pack-gramos')?.value) || 0;
  const packs = parseInt(document.getElementById('pack-cantidad')?.value) || 0;

  if (!cabeza && !filetes) { alert('Define CABEZA/COLAS y FILETES en el porcionamiento'); return; }

  // Confirmar la transformación
  const nombreBase = ctx.item.nombre;
  // Patrón de nombres usado: cabeza/colas = "MERMA UTIL - <base>", packs = "PACK <gr>GR <base>"
  const nombreCabeza = cabeza > 0 ? 'MERMA UTIL - ' + nombreBase : null;
  const nombrePacks = packs > 0 ? 'PACK ' + gramos + 'GR ' + nombreBase : null;
  let msg = 'APLICAR TRANSFORMACIÓN de ' + nombreBase + ':\n\n'
    + '- Saldrá del stock de COCINA (queda en 0).\n';
  if (cabeza > 0) msg += '- Entrará: ' + nombreCabeza + ' = ' + cabeza + ' kg\n';
  if (nombrePacks) msg += '- Entrará: ' + nombrePacks + ' = ' + packs + ' packs\n';
  if (desperdicio > 0) msg += '- DESPERDICIO (no entra a stock): ' + desperdicio + ' kg\n';
  if (!confirm(msg + '\n¿Continuar?')) return;

  api('POST', '/api/cocina/porcionamiento/transformar', {
    nombre: nombreBase, fecha: ctx.fecha,
    cabeza: { nombre: nombreCabeza, peso: cabeza },
    packs: nombrePacks ? { nombre: nombrePacks, cantidad: packs } : null,
    desperdicio: { nombre: nombreBase, peso: desperdicio },
    secciones
  }).then(() => {
    showToast('Transformación aplicada');
    cargarPorcionamientoCocina();
  }).catch(() => alert('Error al aplicar transformación'));
}

// --- COCINA: DESPERDICIOS ---
function cargarDesperdicios() {
  const fechaEl = document.getElementById('fecha-desperdicios');
  if (fechaEl && !fechaEl.value) fechaEl.value = todayStr();
  const fecha = fechaEl ? fechaEl.value : todayStr();
  const container = document.getElementById('cocina-desperdicios-container');
  if (!container) return;
  api('GET', '/api/cocina/desperdicios?fecha=' + fecha).then(lista => {
    if (!lista.length) { container.innerHTML = '<p>No hay desperdicios registrados en esta fecha.</p>'; return; }
    let html = '<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Producto</th><th>Peso (kg)</th><th>Hora</th><th></th></tr></thead><tbody>';
    lista.forEach(d => {
      const t = d.created_at ? new Date(d.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
      html += `<tr><td>${d.fecha}</td><td>${esc(d.nombre)}</td><td>${d.peso}</td><td>${t}</td><td><button class="danger" onclick="eliminarDesperdicio('${d.id}')">✕</button></td></tr>`;
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }).catch(() => { container.innerHTML = '<p style="color:#c62828;">Error cargando desperdicios.</p>'; });
}

function eliminarDesperdicio(id) {
  if (!confirm('¿Eliminar este registro de desperdicio?')) return;
  api('DELETE', '/api/cocina/desperdicios/' + id).then(() => {
    showToast('Eliminado');
    cargarDesperdicios();
  }).catch(() => alert('Error al eliminar'));
}

// --- COCINA: Base de Datos (precios) ---
function cargarPreciosCocina() {
  Promise.all([
    api('GET', '/api/cocina/precios'),
    api('GET', '/api/cocina/stock')
  ]).then(([data, stock]) => {
    const container = document.getElementById('cocina-precios-container');
    if (!container) return;
    // Fusionar items del stock que aún no tienen entrada en precios (sincronización en vivo)
    const precKeys = new Set(data.map(s => (s.ingrediente || '').toUpperCase()));
    let maxId = data.length ? Math.max(...data.map(s => Number(s.id) || 0)) : 0;
    (stock || []).forEach(s => {
      const key = (s.ingrediente || '').toUpperCase();
      if (!precKeys.has(key)) {
        maxId++;
        data.push({ id: maxId, ingrediente: s.ingrediente, unidad: s.unidad || 'unidad', precio: 0, precio_compra: 0, unidad_compra: '' });
        precKeys.add(key);
      }
    });
    if (!data.length) {
      container.innerHTML = '<p>No hay ingredientes en la base de datos. Agrega uno nuevo o ingresa items en COCINA/STOCK.</p>';
      return;
    }
    const conPrecio = data.filter(s => parseFloat(s.precio) > 0);
    const sinPrecio = data.filter(s => !parseFloat(s.precio));
    function tablaItems(items) {
      return items.map(s => `
        <tr data-precio-id="${s.id}">
          <td>${esc(s.ingrediente)}</td>
          <td><select class="input-cocina-uni-compra" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;">${['','KILOS','GRAMOS','LITRO','ML','ONZAS','UNIDAD','BOTELLA','GALON'].map(u => `<option value="${u}" ${(s.unidad_compra||'')===u?'selected':''}>${u || '—'}</option>`).join('')}</select></td>
          <td><input type="number" class="input-cocina-precio-compra" value="${s.precio_compra || 0}" step="0.01" style="width:90px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
          <td style="font-size:0.85rem;color:#666;">${esc(s.unidad)}</td>
          <td><input type="number" class="input-cocina-precio-val" value="${s.precio || 0}" step="0.01" style="width:90px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
          <td style="white-space:nowrap">
            <button onclick="guardarFilaPrecioCocina(this)" style="background:#2e7d32;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">GUARDAR</button>
            <button onclick="editarPrecioCocina(${s.id})" style="background:#0f3460;color:#fff;border:none;padding:0.3rem 0.8rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">EDITAR</button>
            <button onclick="eliminarPrecioCocina(${s.id})" title="Eliminar" style="background:#c62828;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">✕</button>
          </td>
        </tr>`).join('');
    }
    let html = '';
    if (conPrecio.length) {
      html += `<div class="table-wrap" style="margin-bottom:1.5rem;">
        <table>
          <thead><tr><th>Ingrediente</th><th>Unidad Compra</th><th>Precio Compra</th><th>Unidad</th><th>Precio</th><th></th></tr></thead>
          <tbody>${tablaItems(conPrecio)}</tbody>
        </table>
      </div>`;
    }
    if (sinPrecio.length) {
      html += `<div class="table-wrap">
        <table>
          <thead><tr><th style="color:#999;">Ingrediente</th><th style="color:#999;">Unidad Compra</th><th style="color:#999;">Precio Compra</th><th style="color:#999;">Unidad</th><th style="color:#999;">Precio</th><th></th></tr></thead>
          <tbody>${tablaItems(sinPrecio)}</tbody>
        </table>
        ${conPrecio.length ? '<p style="margin-top:0.5rem;color:#999;font-size:0.85rem;">— Items sin precio —</p>' : ''}
      </div>`;
    }
    container.innerHTML = html;
    const bp = document.getElementById('buscar-precios-cocina');
    if (bp && bp.value) buscarTablaBarra(bp.value, 'cocina-precios-container', 'tr[data-precio-id]');
  }).catch(e => console.error(e));
}

function mostrarModalAgregarItemCocina() {
  const body = document.getElementById('modal-body');
  body.innerHTML = `
    <h3>Agregar Item</h3>
    <label style="display:block;margin-top:1rem;">
      Ingrediente:
      <input type="text" id="nuevo-precio-cocina-input" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <label style="display:block;margin-top:1rem;">
      Unidad Compra:
      <select id="nuevo-cocina-uni-compra" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
        <option value="">—</option>
        <option value="KILOS">KILOS</option>
        <option value="GRAMOS">GRAMOS</option>
        <option value="LITRO">LITRO</option>
        <option value="ML">ML</option>
        <option value="ONZAS">ONZAS</option>
        <option value="UNIDAD">UNIDAD</option>
        <option value="BOTELLA">BOTELLA</option>
        <option value="GALON">GALON</option>
      </select>
    </label>
    <label style="display:block;margin-top:1rem;">
      Precio Compra:
      <input type="number" id="nuevo-precio-cocina-compra" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <label style="display:block;margin-top:1rem;">
      Unidad (receta):
      <select id="nuevo-precio-cocina-uni" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
        <option value="unidad">unidad</option>
        <option value="kg">kg</option>
        <option value="gramos">gramos</option>
        <option value="lt">lt</option>
        <option value="ml">ml</option>
        <option value="onzas">onzas</option>
      </select>
    </label>
    <label style="display:block;margin-top:1rem;">
      Precio (por unidad receta):
      <input type="number" id="nuevo-precio-cocina-precio" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="agregarPrecioCocina()" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>`;
  document.getElementById('modal').style.display = 'block';
}

function agregarPrecioCocina() {
  const ingrediente = document.getElementById('nuevo-precio-cocina-input').value.trim();
  const unidad = document.getElementById('nuevo-precio-cocina-uni').value;
  const precio = parseFloat(document.getElementById('nuevo-precio-cocina-precio').value) || 0;
  const precio_compra = parseFloat(document.getElementById('nuevo-precio-cocina-compra').value) || 0;
  const unidad_compra = document.getElementById('nuevo-cocina-uni-compra').value;
  if (!ingrediente) { alert('Ingresa el nombre del ingrediente'); return; }
  api('POST', '/api/cocina/precios', { ingrediente, unidad, precio, precio_compra, unidad_compra }).then(() => {
    cerrarModal();
    cargarPreciosCocina();
  }).catch(() => alert('Error al agregar'));
}

function guardarFilaPrecioCocina(btn) {
  const tr = btn.closest('tr');
  const id = parseInt(tr.dataset.precioId);
  const precio = parseFloat(tr.querySelector('.input-cocina-precio-val').value) || 0;
  const precio_compra = parseFloat(tr.querySelector('.input-cocina-precio-compra').value) || 0;
  const unidad_compra = tr.querySelector('.input-cocina-uni-compra').value.trim();
  api('PUT', '/api/cocina/precios/' + id, { precio, precio_compra, unidad_compra }).then(() => {
    showToast('✓ Guardado');
  }).catch(() => alert('Error al guardar'));
}

function guardarPreciosBaseCocina() {
  const btn = document.querySelector('#sub-cocina-basedatos .btn-guardar-dia');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  const promises = [];
  document.querySelectorAll('#cocina-precios-container tr[data-precio-id]').forEach(tr => {
    const id = parseInt(tr.dataset.precioId);
    const precio = parseFloat(tr.querySelector('.input-cocina-precio-val').value) || 0;
    const precio_compra = parseFloat(tr.querySelector('.input-cocina-precio-compra').value) || 0;
    const unidad_compra = tr.querySelector('.input-cocina-uni-compra').value.trim();
    promises.push(api('PUT', '/api/cocina/precios/' + id, { precio, precio_compra, unidad_compra }));
  });
  Promise.all(promises).then(() => {
    if (btn) { btn.disabled = false; btn.textContent = '💾 GUARDAR'; }
    showToast('Precios Guardados');
    cargarPreciosCocina();
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = '💾 GUARDAR'; }
    alert('Error al guardar precios');
  });
}

function editarPrecioCocina(id) {
  api('GET', '/api/cocina/precios').then(data => {
    const item = data.find(d => d.id === id);
    if (!item) { alert('Item no encontrado'); return; }
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <h3>Editar Item</h3>
      <label style="display:block;margin-top:1rem;">
        Nombre:
        <input type="text" id="edit-cocina-precio-nombre" value="${esc(item.ingrediente)}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad Compra:
        <select id="edit-cocina-uni-compra" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          ${['','KILOS','GRAMOS','LITRO','ML','ONZAS','UNIDAD','BOTELLA','GALON'].map(u => `<option value="${u}" ${(item.unidad_compra||'')===u?'selected':''}>${u || '—'}</option>`).join('')}
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio Compra:
        <input type="number" id="edit-cocina-precio-compra" value="${item.precio_compra || 0}" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad (receta):
        <select id="edit-cocina-precio-unidad" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          ${['unidad','kg','gramos','lt','ml','onzas'].map(u => `<option value="${u}" ${item.unidad === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio (por unidad receta):
        <input type="number" id="edit-cocina-precio-valor" value="${item.precio || 0}" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="guardarEdicionPrecioCocina(${id})" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="eliminarPrecioCocina(${id})" style="flex:1;padding:0.5rem;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;">Eliminar</button>
      </div>
    `;
    document.getElementById('modal').style.display = 'block';
  });
}

function guardarEdicionPrecioCocina(id) {
  const ingrediente = document.getElementById('edit-cocina-precio-nombre').value.trim();
  const unidad = document.getElementById('edit-cocina-precio-unidad').value;
  const precio = parseFloat(document.getElementById('edit-cocina-precio-valor').value) || 0;
  const precio_compra = parseFloat(document.getElementById('edit-cocina-precio-compra').value) || 0;
  const unidad_compra = document.getElementById('edit-cocina-uni-compra').value.trim();
  if (!ingrediente) { alert('El nombre es requerido'); return; }
  api('PUT', '/api/cocina/precios/' + id, { ingrediente, unidad, precio, precio_compra, unidad_compra }).then(() => {
    cerrarModal();
    showToast('Item actualizado');
    cargarPreciosCocina();
  }).catch(() => alert('Error al actualizar'));
}

function eliminarPrecioCocina(id) {
  if (!confirm('¿Eliminar este ingrediente de la base de datos?')) return;
  api('DELETE', '/api/cocina/precios/' + id).then(() => cargarPreciosCocina()).catch(() => alert('Error al eliminar'));
}

function exportarBaseDatosCocina() {
  api('GET', '/api/cocina/precios').then(data => {
    const wsData = [['Ingrediente', 'Unidad Compra', 'Precio Compra', 'Unidad', 'Precio']];
    data.forEach(s => wsData.push([s.ingrediente, s.unidad_compra || '', s.precio_compra || 0, s.unidad || '', s.precio || 0]));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Base de Datos');
    XLSX.writeFile(libro, 'BaseDatos_Cocina.xlsx');
  });
}

function exportarBaseDatosSinPrecioCocina() {
  api('GET', '/api/cocina/precios').then(data => {
    const wsData = [['Ingrediente', 'Unidad']];
    data.filter(s => !parseFloat(s.precio)).forEach(s => wsData.push([s.ingrediente, s.unidad || '']));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Sin Precio');
    XLSX.writeFile(libro, 'BaseDatosSinPrecio_Cocina.xlsx');
  });
}

// --- BARRA: Base de Datos (precios) ---
function cargarPrecios() {
  Promise.all([
    api('GET', '/api/barra/precios'),
    api('GET', '/api/recetas')
  ]).then(([data, recetas]) => {
    const container = document.getElementById('barra-precios-container');
    if (!data.length) {
      container.innerHTML = '<p>No hay ingredientes en la base de datos. Agrega uno nuevo.</p>';
      return;
    }
    const recetasBase = recetas.filter(r => r.categoria === 'RECETAS BASE').map(r => r.nombre.toLowerCase());
    const destacados = ['jarabe de cherry y piña','jarabe de kion','jarabe de maiz morado','jarabe hoja de coca','pisco con canela','pisco con kion','pisco con maiz morado','pisco macerado con maiz morado','zumo de piña','concentrado flor de jamaica y canela'];
    const excluir = ['mango ciruelo'];
    const conPrecio = data.filter(s => parseFloat(s.precio) > 0);
    const sinPrecio = data.filter(s => !parseFloat(s.precio));
    function tablaItems(items) {
      return items.map(s => {
        const name = s.ingrediente.toLowerCase();
        const esRecetaBase = !excluir.includes(name) && (recetasBase.some(rn => rn.startsWith(name)) || destacados.includes(name));
        return `
        <tr data-precio-id="${s.id}"${esRecetaBase ? ' style="background:#e3f2fd;"' : ''}>
          <td>${s.ingrediente}</td>
          <td><select class="input-uni-compra" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;">${['','KILOS','GRAMOS','LITRO','ML','ONZAS','UNIDAD','HOJAS','BOTELLA','GALON'].map(u => `<option value="${u}" ${(s.unidad_compra||'')===u?'selected':''}>${u || '—'}</option>`).join('')}</select></td>
          <td><input type="number" class="input-precio-compra" value="${s.precio_compra || 0}" step="0.01" style="width:90px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
          <td style="font-size:0.85rem;color:#666;">${s.unidad}</td>
          <td><input type="number" class="input-precio-val" value="${s.precio}" step="0.01" style="width:90px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
          <td style="white-space:nowrap">
            <button onclick="guardarFilaPrecio(this)" style="background:#2e7d32;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">GUARDAR</button>
            <button onclick="editarPrecio(${s.id})" style="background:#0f3460;color:#fff;border:none;padding:0.3rem 0.8rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">EDITAR</button>
            <button onclick="eliminarPrecio(${s.id})" title="Eliminar" style="background:#c62828;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">✕</button>
          </td>
        </tr>`;
      }).join('');
    }
    let html = '';
    if (conPrecio.length) {
      html += `<div class="table-wrap" style="margin-bottom:1.5rem;">
      <table>
        <thead><tr><th>Ingrediente</th><th>Unidad Compra</th><th>Precio Compra</th><th>Unidad</th><th>Precio</th><th></th></tr></thead>
        <tbody>${tablaItems(conPrecio)}</tbody>
      </table>
      </div>`;
    }
    if (sinPrecio.length) {
      html += `<div class="table-wrap">
      <table>
        <thead><tr><th style="color:#999;">Ingrediente</th><th style="color:#999;">Unidad Compra</th><th style="color:#999;">Precio Compra</th><th style="color:#999;">Unidad</th><th style="color:#999;">Precio</th><th></th></tr></thead>
        <tbody>${tablaItems(sinPrecio)}</tbody>
      </table>
      ${conPrecio.length ? '<p style="margin-top:0.5rem;color:#999;font-size:0.85rem;">— Items sin precio —</p>' : ''}
      </div>`;
    }
    container.innerHTML = html;
  });
}

function mostrarModalAgregarItem() {
  const body = document.getElementById('modal-body');
  body.innerHTML = `
    <h3>Agregar Item</h3>
    <label style="display:block;margin-top:1rem;">
      Ingrediente:
      <input type="text" id="nuevo-precio-input" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <label style="display:block;margin-top:1rem;">
      Unidad Compra:
      <select id="nuevo-uni-compra" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
        <option value="">—</option>
        <option value="KILOS">KILOS</option>
        <option value="GRAMOS">GRAMOS</option>
        <option value="LITRO">LITRO</option>
        <option value="ML">ML</option>
        <option value="ONZAS">ONZAS</option>
        <option value="UNIDAD">UNIDAD</option>
        <option value="HOJAS">HOJAS</option>
        <option value="BOTELLA">BOTELLA</option>
        <option value="GALON">GALON</option>
      </select>
    </label>
    <label style="display:block;margin-top:1rem;">
      Precio Compra:
      <input type="number" id="nuevo-precio-compra" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <label style="display:block;margin-top:1rem;">
      Unidad (receta):
      <select id="nuevo-precio-uni" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
        <option value="unidad">unidad</option>
        <option value="onzas">onzas</option>
        <option value="gramos">gramos</option>
        <option value="kg">kg</option>
        <option value="lt">lt</option>
        <option value="ml">ml</option>
        <option value="hojas">hojas</option>
        <option value="gotas">gotas</option>
      </select>
    </label>
    <label style="display:block;margin-top:1rem;">
      Precio (por unidad receta):
      <input type="number" id="nuevo-precio-precio" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="agregarPrecio()" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>`;
  document.getElementById('modal').style.display = 'block';
}

function agregarPrecio() {
  const ingrediente = document.getElementById('nuevo-precio-input').value.trim();
  const unidad = document.getElementById('nuevo-precio-uni').value;
  const precio = parseFloat(document.getElementById('nuevo-precio-precio').value) || 0;
  const precio_compra = parseFloat(document.getElementById('nuevo-precio-compra').value) || 0;
  const unidad_compra = document.getElementById('nuevo-uni-compra').value;
  if (!ingrediente) { alert('Ingresa el nombre del ingrediente'); return; }
  api('POST', '/api/barra/precios', { ingrediente, unidad, precio, precio_compra, unidad_compra }).then(() => {
    cerrarModal();
    cargarPrecios();
  }).catch(() => alert('Error al agregar'));
}

function guardarFilaPrecio(btn) {
  const tr = btn.closest('tr');
  const id = parseInt(tr.dataset.precioId);
  const precio = parseFloat(tr.querySelector('.input-precio-val').value) || 0;
  const precio_compra = parseFloat(tr.querySelector('.input-precio-compra').value) || 0;
  const unidad_compra = tr.querySelector('.input-uni-compra').value.trim();
  api('PUT', '/api/barra/precios/' + id, { precio, precio_compra, unidad_compra }).then(() => {
    showToast('✓ Guardado');
  }).catch(() => alert('Error al guardar'));
}

function guardarPreciosBase() {
  const btn = document.querySelector('#sub-barra-basedatos .btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  const promises = [];
  document.querySelectorAll('#barra-precios-container tr[data-precio-id]').forEach(tr => {
    const id = parseInt(tr.dataset.precioId);
    const precio = parseFloat(tr.querySelector('.input-precio-val').value) || 0;
    const precio_compra = parseFloat(tr.querySelector('.input-precio-compra').value) || 0;
    const unidad_compra = tr.querySelector('.input-uni-compra').value.trim();
    promises.push(api('PUT', '/api/barra/precios/' + id, { precio, precio_compra, unidad_compra }));
  });
  Promise.all(promises).then(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR';
    showToast('Precios Guardados');
    cargarPrecios();
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR';
    alert('Error al guardar precios');
  });
}

function eliminarPrecio(id) {
  if (!confirm('¿Eliminar este ingrediente de la base de datos?')) return;
  api('DELETE', '/api/barra/precios/' + id).then(() => cargarPrecios());
}

function actualizarPrecio(id, el) {
  const precio = parseFloat(el.value) || 0;
  api('PUT', '/api/barra/precios/' + id, { precio }).then(() => showToast('✓ Guardado')).catch(() => alert('Error al actualizar'));
}

function editarPrecio(id) {
  api('GET', '/api/barra/precios').then(data => {
    const item = data.find(d => d.id === id);
    if (!item) { alert('Item no encontrado'); return; }
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <h3>Editar Item</h3>
      <label style="display:block;margin-top:1rem;">
        Nombre:
        <input type="text" id="edit-precio-nombre" value="${item.ingrediente}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad Compra:
        <select id="edit-uni-compra" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          ${['','KILOS','GRAMOS','LITRO','ML','ONZAS','UNIDAD','HOJAS','BOTELLA','GALON'].map(u =>
            `<option value="${u}" ${(item.unidad_compra||'')===u?'selected':''}>${u || '—'}</option>`
          ).join('')}
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio Compra:
        <input type="number" id="edit-precio-compra" value="${item.precio_compra || 0}" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad (receta):
        <select id="edit-precio-unidad" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          ${['unidad','onzas','gramos','kg','lt','ml','hojas','gotas'].map(u =>
            `<option value="${u}" ${item.unidad === u ? 'selected' : ''}>${u}</option>`
          ).join('')}
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio (por unidad receta):
        <input type="number" id="edit-precio-valor" value="${item.precio}" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="guardarEdicionPrecio(${id})" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="eliminarPrecio(${id})" style="flex:1;padding:0.5rem;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;">Eliminar</button>
      </div>
    `;
    document.getElementById('modal').style.display = 'block';
  });
}

function guardarEdicionPrecio(id) {
  const ingrediente = document.getElementById('edit-precio-nombre').value.trim();
  const unidad = document.getElementById('edit-precio-unidad').value;
  const precio = parseFloat(document.getElementById('edit-precio-valor').value) || 0;
  const precio_compra = parseFloat(document.getElementById('edit-precio-compra').value) || 0;
  const unidad_compra = document.getElementById('edit-uni-compra').value.trim();
  if (!ingrediente) { alert('El nombre es requerido'); return; }
  api('PUT', '/api/barra/precios/' + id, { ingrediente, unidad, precio, precio_compra, unidad_compra }).then(() => {
    document.getElementById('modal').style.display = 'none';
    cargarPrecios();
  }).catch(() => alert('Error al guardar'));
}

// --- PRECIOS POR ALMACEN ---
function cargarBaseDatosStocks() {
  Promise.all([
    api('GET', '/api/stock/precios'),
    api('GET', '/api/stock/precios/items')
  ]).then(([data, itemNames]) => {
    // Sincronizar: crear entradas faltantes para items de STOCKS/ALMACENES (uno por item, sin duplicados)
    const exist = new Set((data || []).map(s => (s.nombre || '').toUpperCase()));
    const faltantes = (itemNames || []).filter(n => !exist.has(n.toUpperCase()));
    if (faltantes.length) {
      return Promise.all(faltantes.map(n => api('POST', '/api/stock/precios', { nombre: n, unidad: 'UNIDAD', precio: 0, unidad_venta: 'UNIDAD', precio_venta: 0 })))
        .then(() => api('GET', '/api/stock/precios'));
    }
    return data;
  }).then(data => {
    const container = document.getElementById('accordion-precios');
    if (!container) return;
    // Deduplicar por nombre (un solo dato por item en la base de datos)
    const seen = new Set();
    data = (data || []).filter(s => {
      const k = (s.nombre || '').toUpperCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!data.length) {
      container.innerHTML = '<p>No hay items en la base de datos. Agrega uno nuevo.</p>';
      return;
    }
    const conPrecio = data.filter(s => parseFloat(s.precio_venta) > 0 || parseFloat(s.precio) > 0);
    const sinPrecio = data.filter(s => !parseFloat(s.precio_venta) && !parseFloat(s.precio));
    function tablaItems(items) {
      return items.map(s => `
        <tr data-precio-id="${s.id}">
          <td>${esc(s.nombre)}</td>
          <td><select class="input-stock-uni-compra" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;">${['','UNIDAD','CAJA','DOCENA','KILOS','GRAMOS','LITRO','ML','ONZAS','BOTELLA','GALON'].map(u => `<option value="${u}" ${(s.unidad||'')===u?'selected':''}>${u || '—'}</option>`).join('')}</select></td>
          <td><input type="number" class="input-stock-precio-compra" value="${s.precio || 0}" step="0.01" style="width:90px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
          <td><select class="input-stock-uni-venta" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;">${['','UNIDAD','VASO','BOTELLA','LATA','BOLSA','PLATO','RACION','ONZAS','ML','GRAMOS','KILOS'].map(u => `<option value="${u}" ${(s.unidad_venta||'')===u?'selected':''}>${u || '—'}</option>`).join('')}</select></td>
          <td><input type="number" class="input-stock-precio-venta" value="${s.precio_venta || 0}" step="0.01" style="width:90px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
          <td style="white-space:nowrap">
            <button onclick="guardarFilaPrecioStocks(this)" style="background:#2e7d32;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">GUARDAR</button>
            <button onclick="editarPrecioStocks(${s.id})" style="background:#0f3460;color:#fff;border:none;padding:0.3rem 0.8rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">EDITAR</button>
            <button onclick="eliminarPrecioStocks(${s.id})" title="Eliminar" style="background:#c62828;color:#fff;border:none;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.85rem;">✕</button>
          </td>
        </tr>`).join('');
    }
    let html = '';
    if (conPrecio.length) {
      html += `<div class="table-wrap" style="margin-bottom:1.5rem;">
        <table>
          <thead><tr><th>Item</th><th>Unidad Compra</th><th>Precio Compra</th><th>Unidad Venta</th><th>Precio Venta</th><th></th></tr></thead>
          <tbody>${tablaItems(conPrecio)}</tbody>
        </table>
      </div>`;
    }
    if (sinPrecio.length) {
      html += `<div class="table-wrap">
        <table>
          <thead><tr><th style="color:#999;">Item</th><th style="color:#999;">Unidad Compra</th><th style="color:#999;">Precio Compra</th><th style="color:#999;">Unidad Venta</th><th style="color:#999;">Precio Venta</th><th></th></tr></thead>
          <tbody>${tablaItems(sinPrecio)}</tbody>
        </table>
        ${conPrecio.length ? '<p style="margin-top:0.5rem;color:#999;font-size:0.85rem;">— Items sin precio —</p>' : ''}
      </div>`;
    }
    container.innerHTML = html;
    const bp = document.getElementById('buscar-precio-item');
    if (bp && bp.value) buscarTablaBarra(bp.value, 'accordion-precios', 'tr[data-precio-id]');
  }).catch(e => console.error(e));
}

function mostrarModalAgregarItemStocks() {
  const body = document.getElementById('modal-body');
  getInventario(todayStr()).then(inv => {
    const seen = new Set();
    let opts = '';
    (inv || []).forEach(a => (a.items || []).forEach(i => {
      const n = (i.nombre || '').trim();
      if (n && !seen.has(n.toUpperCase())) { seen.add(n.toUpperCase()); opts += '<option value="' + n.replace(/"/g, '&quot;') + '">'; }
    }));
    body.innerHTML = `
      <h3>Agregar Item</h3>
      <label style="display:block;margin-top:1rem;">
        Item (de STOCKS/ALMACEN):
        <input type="text" id="nuevo-precio-stock-input" list="sugerencias-stock-precios" autocomplete="off" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
        <datalist id="sugerencias-stock-precios">${opts}</datalist>
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad Compra:
        <select id="nuevo-stock-uni-compra" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          <option value="UNIDAD">UNIDAD</option>
          <option value="CAJA">CAJA</option>
          <option value="DOCENA">DOCENA</option>
          <option value="KILOS">KILOS</option>
          <option value="GRAMOS">GRAMOS</option>
          <option value="LITRO">LITRO</option>
          <option value="ML">ML</option>
          <option value="ONZAS">ONZAS</option>
          <option value="BOTELLA">BOTELLA</option>
          <option value="GALON">GALON</option>
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio de Compra (proveedor):
        <input type="number" id="nuevo-stock-precio-compra" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad de Venta:
        <select id="nuevo-stock-uni-venta" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          <option value="UNIDAD">UNIDAD</option>
          <option value="VASO">VASO</option>
          <option value="BOTELLA">BOTELLA</option>
          <option value="LATA">LATA</option>
          <option value="BOLSA">BOLSA</option>
          <option value="PLATO">PLATO</option>
          <option value="RACION">RACION</option>
          <option value="ONZAS">ONZAS</option>
          <option value="ML">ML</option>
          <option value="GRAMOS">GRAMOS</option>
          <option value="KILOS">KILOS</option>
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio de Venta (consumidor):
        <input type="number" id="nuevo-stock-precio-venta" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="agregarPrecioStocks()" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
      </div>`;
    document.getElementById('modal').style.display = 'block';
  }).catch(() => {
    body.innerHTML = '<p>Error cargando items.</p>';
    document.getElementById('modal').style.display = 'block';
  });
}

function agregarPrecioStocks() {
  const nombre = document.getElementById('nuevo-precio-stock-input').value.trim();
  const unidad = document.getElementById('nuevo-stock-uni-compra').value;
  const precio = parseFloat(document.getElementById('nuevo-stock-precio-compra').value) || 0;
  const unidad_venta = document.getElementById('nuevo-stock-uni-venta').value;
  const precio_venta = parseFloat(document.getElementById('nuevo-stock-precio-venta').value) || 0;
  if (!nombre) { alert('Ingresa el nombre del item'); return; }
  api('POST', '/api/stock/precios', { nombre, unidad, precio, unidad_venta, precio_venta }).then(() => {
    cerrarModal();
    showToast('Item agregado');
    cargarBaseDatosStocks();
  }).catch(() => alert('Error al agregar'));
}

function guardarFilaPrecioStocks(btn) {
  const tr = btn.closest('tr');
  const id = parseInt(tr.dataset.precioId);
  const unidad = tr.querySelector('.input-stock-uni-compra').value.trim();
  const precio = parseFloat(tr.querySelector('.input-stock-precio-compra').value) || 0;
  const unidad_venta = tr.querySelector('.input-stock-uni-venta').value.trim();
  const precio_venta = parseFloat(tr.querySelector('.input-stock-precio-venta').value) || 0;
  api('PUT', '/api/stock/precios/' + id, { unidad, precio, unidad_venta, precio_venta }).then(() => {
    showToast('✓ Guardado');
  }).catch(() => alert('Error al guardar'));
}

function guardarPreciosStocks() {
  const btn = document.querySelector('#tab-precios .btn-guardar-dia');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  const promises = [];
  document.querySelectorAll('#accordion-precios tr[data-precio-id]').forEach(tr => {
    const id = parseInt(tr.dataset.precioId);
    const unidad = tr.querySelector('.input-stock-uni-compra').value.trim();
    const precio = parseFloat(tr.querySelector('.input-stock-precio-compra').value) || 0;
    const unidad_venta = tr.querySelector('.input-stock-uni-venta').value.trim();
    const precio_venta = parseFloat(tr.querySelector('.input-stock-precio-venta').value) || 0;
    promises.push(api('PUT', '/api/stock/precios/' + id, { unidad, precio, unidad_venta, precio_venta }));
  });
  Promise.all(promises).then(() => {
    if (btn) { btn.disabled = false; btn.textContent = '💾 GUARDAR'; }
    showToast('Precios Guardados');
    cargarBaseDatosStocks();
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = '💾 GUARDAR'; }
    alert('Error al guardar precios');
  });
}

function editarPrecioStocks(id) {
  api('GET', '/api/stock/precios').then(data => {
    const item = data.find(d => d.id === id);
    if (!item) { alert('Item no encontrado'); return; }
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <h3>Editar Item</h3>
      <label style="display:block;margin-top:1rem;">
        Nombre:
        <input type="text" id="edit-stock-precio-nombre" value="${esc(item.nombre)}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad Compra:
        <select id="edit-stock-uni-compra" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          ${['','UNIDAD','CAJA','DOCENA','KILOS','GRAMOS','LITRO','ML','ONZAS','BOTELLA','GALON'].map(u => `<option value="${u}" ${(item.unidad||'')===u?'selected':''}>${u || '—'}</option>`).join('')}
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio de Compra:
        <input type="number" id="edit-stock-precio-compra" value="${item.precio || 0}" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <label style="display:block;margin-top:1rem;">
        Unidad de Venta:
        <select id="edit-stock-uni-venta" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
          ${['','UNIDAD','VASO','BOTELLA','LATA','BOLSA','PLATO','RACION','ONZAS','ML','GRAMOS','KILOS'].map(u => `<option value="${u}" ${(item.unidad_venta||'')===u?'selected':''}>${u || '—'}</option>`).join('')}
        </select>
      </label>
      <label style="display:block;margin-top:1rem;">
        Precio de Venta:
        <input type="number" id="edit-stock-precio-venta" value="${item.precio_venta || 0}" step="0.01" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
      </label>
      <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
        <button onclick="guardarEdicionPrecioStocks(${id})" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
        <button onclick="eliminarPrecioStocks(${id})" style="flex:1;padding:0.5rem;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;">Eliminar</button>
      </div>
    `;
    document.getElementById('modal').style.display = 'block';
  });
}

function guardarEdicionPrecioStocks(id) {
  const nombre = document.getElementById('edit-stock-precio-nombre').value.trim();
  const unidad = document.getElementById('edit-stock-uni-compra').value.trim();
  const precio = parseFloat(document.getElementById('edit-stock-precio-compra').value) || 0;
  const unidad_venta = document.getElementById('edit-stock-uni-venta').value.trim();
  const precio_venta = parseFloat(document.getElementById('edit-stock-precio-venta').value) || 0;
  if (!nombre) { alert('El nombre es requerido'); return; }
  api('PUT', '/api/stock/precios/' + id, { nombre, unidad, precio, unidad_venta, precio_venta }).then(() => {
    cerrarModal();
    showToast('Item actualizado');
    cargarBaseDatosStocks();
  }).catch(() => alert('Error al actualizar'));
}

function eliminarPrecioStocks(id) {
  if (!confirm('¿Eliminar este item de la base de datos?')) return;
  api('DELETE', '/api/stock/precios/' + id).then(() => cargarBaseDatosStocks()).catch(() => alert('Error al eliminar'));
}

function exportarBaseDatosStocks() {
  api('GET', '/api/stock/precios').then(data => {
    const wsData = [['Item', 'Unidad Compra', 'Precio Compra', 'Unidad Venta', 'Precio Venta']];
    data.forEach(s => wsData.push([s.nombre, s.unidad || '', s.precio || 0, s.unidad_venta || '', s.precio_venta || 0]));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Base de Datos');
    XLSX.writeFile(libro, 'BaseDatos_Stocks.xlsx');
  });
}

function exportarBaseDatosSinPrecioStocks() {
  api('GET', '/api/stock/precios').then(data => {
    const sin = data.filter(s => !parseFloat(s.precio_venta) && !parseFloat(s.precio));
    const wsData = [['Item', 'Unidad Compra']];
    sin.forEach(s => wsData.push([s.nombre, s.unidad || '']));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Sin Precio');
    XLSX.writeFile(libro, 'ItemsSinPrecio_Stocks.xlsx');
  });
}


function exportarBaseDatos() {
  api('GET', '/api/barra/precios').then(data => {
    const wsData = [['NOMBRE', 'UNIDAD COMPRA', 'PRECIO COMPRA', 'UNIDAD', 'PRECIO']];
    data.forEach(p => wsData.push([p.ingrediente, p.unidad_compra || '', p.precio_compra || 0, p.unidad || '', p.precio || 0]));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Base de Datos');
    XLSX.writeFile(libro, 'Base_de_Datos.xlsx');
  }).catch(() => alert('Error al exportar'));
}

function exportarBaseDatosSinPrecio() {
  api('GET', '/api/barra/precios').then(data => {
    const sinPrecio = data.filter(p => !parseFloat(p.precio));
    const wsData = [['NOMBRE', 'UNIDAD COMPRA', 'PRECIO COMPRA', 'UNIDAD', 'PRECIO']];
    sinPrecio.forEach(p => wsData.push([p.ingrediente, p.unidad_compra || '', p.precio_compra || 0, p.unidad || '', p.precio || 0]));
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Sin Precio');
    XLSX.writeFile(libro, 'Items_Sin_Precio.xlsx');
  }).catch(() => alert('Error al exportar'));
}

// --- BARRA: INGRESOS / VENTAS / BAJAS ---
function cargarBarraMovimientos(tipo) {
  const fecha = document.getElementById('fecha-barra-' + tipo)?.value || todayStr();
  const accId = 'accordion-barra-' + tipo;
  if (tipo === 'ventas') {
    Promise.all([
      api('GET', '/api/recetas'),
      api('GET', '/api/barra/movimientos?fecha=' + fecha + '&tipo=ventas')
    ]).then(([recetas, movs]) => {
    const ordenCat = ['RECETAS BASE', 'Clásicos', 'Mojitos', 'Limonadas', 'LIMONADAS MENU', 'SODAS', 'JUGO DE FRUTAS', 'DEL BARMAN', 'Chilcanos y Sours', 'SHOTS', 'VINO TINTOS'];
      const recetasGuardadas = movs.filter(m => m.es_receta !== false);
      const recQty = {};
      recetasGuardadas.forEach(m => { recQty[m.ingrediente] = m.cantidad; });
      const grupos = {};
      recetas.forEach(r => {
        const cat = r.categoria || 'Clásicos';
        if (!grupos[cat]) grupos[cat] = [];
        grupos[cat].push(r);
      });
      const catsToRender = [...ordenCat, ...Object.keys(grupos).filter(c => !ordenCat.includes(c))];
      const container = document.getElementById(accId);
      if (!recetas.length) { container.innerHTML = '<p>No hay recetas registradas.</p>'; return; }
      // RECETAS VENDIDAS (colapsable, con categorías dentro)
      let html = `<div class="accordion-item" id="recetas-vendidas-acc">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">RECETAS VENDIDAS</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">`;
      catsToRender.forEach(cat => {
        const recs = (grupos[cat] || []).filter(r => (recQty[r.nombre] || 0) > 0);
        if (!recs.length) return;
        html += `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${cat} <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${recs.length} receta(s) vendida(s)</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Receta</th><th style="text-align:center;">Cant. Vendida</th><th>Ingredientes</th></tr></thead>
              <tbody>
                ${recs.map(r => {
                  const qty = recQty[r.nombre] || 0;
                  const ings = r.ingredientes.map(i => i.ingrediente).join(', ');
                  return `<tr data-receta="${r.nombre}" data-costo="${r.costoTotal || 0}" data-ingredientes='${JSON.stringify(r.ingredientes.map(i => ({ ingrediente: i.ingrediente, cantidad: i.cantidad, unidad: i.unidad })))}'>
                    <td>${r.nombre}</td>
                    <td style="text-align:center;"><input type="number" class="input-barra-mov input-receta-qty" value="${qty}" step="0.01" style="width:90px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;text-align:center;" oninput="calcularItemsSalientes(); calcularCostosVenta()"></td>
                    <td style="font-size:0.8rem;color:#666;">${ings}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table></div>
          </div>
        </div>`;
      });
      html += '</div></div>';
      // ITEMS SALIENTES (colapsable)
      html += `<div class="accordion-item" id="items-salientes-acc">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">ITEMS SALIENTES</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body"><div id="items-salientes-section"></div></div>
      </div>`;
      // COSTOS DE VENTA (colapsable)
      html += `<div class="accordion-item" id="costos-venta-acc">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">COSTOS DE VENTA <span id="costo-venta-total" style="font-weight:400;font-size:0.85rem;color:#0f3460;"></span></span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body"><div id="costos-venta-section"></div></div>
      </div>`;
      container.innerHTML = html;
      calcularItemsSalientes();
      calcularCostosVenta();
      const bp = document.getElementById('buscar-barra-ventas');
      if (bp && bp.value) buscarTablaBarra(bp.value, accId, 'tr[data-receta]');
    });
  } else {
    // INGRESOS: solo los items que ingresaron en la fecha (COMPRAS + SALIDAS de STOCK) / BAJAS: items de BARRA/STOCK
    const esIngreso = tipo === 'ingresos';
    const fechaIni = document.getElementById('fecha-barra-' + tipo)?.value || todayStr();
    const fechaFin = esIngreso ? (document.getElementById('fecha-barra-' + tipo + '-fin')?.value || '') : '';
    const esRango = esIngreso && !!fechaFin;
    const qFecha = esRango ? 'fecha_inicio=' + fechaIni + '&fecha_fin=' + fechaFin : 'fecha=' + fechaIni;
    const fuente = esIngreso ? api('GET', '/api/barra/precios') : api('GET', '/api/barra/stock');
    const fuenteSalidasStock = esIngreso ? api('GET', '/api/barra/salidas-stock?' + qFecha) : Promise.resolve([]);
    Promise.all([
      fuente,
      api('GET', '/api/barra/movimientos?' + qFecha + '&tipo=' + tipo),
      fuenteSalidasStock
    ]).then(([items, movs, salidasStock]) => {
      const movByIng = {};
      if (esRango) {
        movs.forEach(m => {
          const k = String(m.ingrediente);
          if (!movByIng[k]) movByIng[k] = { cantidad: 0, origen: 'proveedor', unidad: m.unidad || 'unidad' };
          movByIng[k].cantidad = (movByIng[k].cantidad || 0) + (m.cantidad || 0);
          if (m.origen === 'stocks') movByIng[k].origen = 'stocks';
        });
      } else {
        movs.forEach(m => { movByIng[m.ingrediente] = m; });
      }
      // Sumar las salidas de STOCK con destino BARRA (origen STOCKS)
      if (esIngreso) {
        (salidasStock || []).forEach(s => {
          if (!movByIng[s.nombre]) movByIng[s.nombre] = { cantidad: 0, origen: 'stocks', unidad: s.unidad || 'unidad' };
          movByIng[s.nombre].cantidad = (movByIng[s.nombre].cantidad || 0) + (s.cantidad || 0);
          movByIng[s.nombre].origen = 'stocks';
        });
      }
      const container = document.getElementById(accId);
      let lista;
      if (esIngreso) {
        // Solo los items que tienen ingreso en esta fecha
        const preciosBy = {};
        items.forEach(p => preciosBy[String(p.ingrediente).toUpperCase()] = p);
        lista = Object.keys(movByIng).map(nombre => {
          const p = preciosBy[String(nombre).toUpperCase()];
          const mov = movByIng[nombre];
          return { ingrediente: nombre, unidad: (p ? (p.unidad_compra || p.unidad) : (mov.unidad || 'unidad')) };
        });
        if (!lista.length) { container.innerHTML = esRango ? '<p>No hay ingresos en el rango seleccionado.</p>' : '<p>No hay ingresos en esta fecha.</p>'; return; }
      } else {
        lista = items;
        if (!lista.length) { container.innerHTML = '<p>No hay items en BARRA/STOCK.</p>'; return; }
      }
      const colOrigen = esIngreso ? '<th>Origen</th>' : '';
      const cellOrigen = (mov) => esIngreso ? `<td><select class="select-origen-ingreso" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;">
        <option value="proveedor" ${mov.origen==='proveedor'?'selected':''}>PROVEEDOR</option>
        <option value="stocks" ${mov.origen==='stocks'?'selected':''}>STOCKS</option>
      </select></td>` : '';
      const avisoRango = esRango ? '<p style="font-size:0.8rem;color:#0f3460;font-weight:700;margin-bottom:0.5rem;">📊 RANGO: ' + fechaIni + ' → ' + fechaFin + ' (totales acumulados · solo lectura). Para guardar deja vacío "Hasta".</p>' : '';
      container.innerHTML = avisoRango + `
        <div class="table-wrap"><table>
          <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th>${colOrigen}</tr></thead>
          <tbody>
            ${lista.map(p => {
              const mov = movByIng[p.ingrediente] || {};
              const uc = p.unidad || 'unidad';
              const ro = esRango ? ' readonly' : '';
              return `<tr data-ing="${p.ingrediente}" data-uni-compra="${uc}">
                <td>${p.ingrediente}</td>
                <td><input type="number" class="input-barra-mov" value="${mov.cantidad || ''}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"${ro}></td>
                <td>${uc}</td>
                ${cellOrigen(mov)}
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>`;
      if (esRango) container.querySelectorAll('.select-origen-ingreso').forEach(sl => sl.setAttribute('disabled', ''));
      const bp = document.getElementById('buscar-barra-' + tipo);
      if (bp && bp.value) buscarEnTabla(bp.value, accId);
    });
  }
}

function guardarBarraMovimientos(tipo) {
  if (tipo === 'ingresos') {
    const fFin = document.getElementById('fecha-barra-ingresos-fin')?.value;
    if (fFin) { alert('Estás viendo un RANGO de fechas (solo lectura). Para guardar, deja vacío el campo "Hasta".'); return; }
  }
  const fecha = document.getElementById('fecha-barra-' + tipo)?.value || todayStr();
  if (tipo === 'ventas') {
    const items = [];
    // Recipe-level entries
    document.querySelectorAll('#accordion-barra-ventas tr[data-receta]').forEach(tr => {
      const qty = parseFloat(tr.querySelector('.input-receta-qty').value) || 0;
      if (qty > 0) {
        items.push({
          ingrediente: tr.dataset.receta,
          cantidad: qty,
          unidad: 'unidad',
          es_receta: true
        });
        // Expanded ingredient entries
        const ingredientes = JSON.parse(tr.dataset.ingredientes || '[]');
        ingredientes.forEach(ing => {
          items.push({
            ingrediente: ing.ingrediente,
            cantidad: (ing.cantidad || 0) * qty,
            unidad: ing.unidad || 'unidad',
            es_receta: false,
            receta: tr.dataset.receta
          });
        });
      }
    });
    api('POST', '/api/barra/movimientos', { fecha, tipo, items }).then(() => {
      showToast('Venta Guardada');
      cargarBarraMovimientos(tipo);
      cargarStockBarra();
      actualizarContadoresMenu();
    }).catch(e => { console.error(e); alert('Error al guardar'); });
  } else {
    const items = [];
    document.querySelectorAll('#accordion-barra-' + tipo + ' tr[data-ing]').forEach(tr => {
      const cant = parseFloat(tr.querySelector('.input-barra-mov').value) || 0;
      if (cant > 0) {
        const item = { ingrediente: tr.dataset.ing, cantidad: cant, unidad: tr.dataset.uniCompra || 'unidad' };
        if (tipo === 'ingresos') item.origen = tr.querySelector('.select-origen-ingreso')?.value || 'proveedor';
        items.push(item);
      }
    });
    api('POST', '/api/barra/movimientos', { fecha, tipo, items }).then(() => {
      showToast(tipo === 'ingresos' ? 'Ingreso Guardado' : 'Baja Guardada');
      cargarBarraMovimientos(tipo);
      actualizarContadoresMenu();
    }).catch(e => { console.error(e); alert('Error al guardar'); });
  }
}

function verDetallesBarra(tipo) {
  const fecha = document.getElementById('fecha-barra-' + tipo)?.value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const fechaFin = tipo === 'ingresos' ? (document.getElementById('fecha-barra-ingresos-fin')?.value || '') : '';
  const esRango = tipo === 'ingresos' && !!fechaFin;
  const qFecha = esRango ? 'fecha_inicio=' + fecha + '&fecha_fin=' + fechaFin : 'fecha=' + fecha;
  const label = tipo === 'ingresos' ? 'Ingresos' : tipo === 'ventas' ? 'Ventas' : 'Bajas';
  api('GET', '/api/barra/movimientos?' + qFecha + '&tipo=' + tipo).then(movs => {
    let html = '<h3>Detalle de ' + label + ' Barra — ' + (esRango ? fecha + ' a ' + fechaFin : fecha) + '</h3>';
    if (tipo === 'ventas') {
      // Show only recipe-level entries
      const recetas = movs.filter(m => m.es_receta !== false);
      if (!recetas.length) { html += '<p>No hay ventas registradas en esta fecha.</p>'; }
      else {
        html += '<table><thead><tr><th>Receta</th><th>Cantidad</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
        recetas.forEach(m => {
          const t = m.created_at ? new Date(m.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
          const u = DISPLAY_NAMES[m.saved_by] || m.saved_by || '-';
          html += '<tr><td>' + m.ingrediente + '</td><td>' + (m.cantidad || 0) + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
        });
        html += '</tbody></table>';
      }
    } else {
      if (!movs.length) { html += '<p>No hay movimientos registrados en esta fecha.</p>'; }
      else {
        const colOrigen = tipo === 'ingresos' ? '<th>Origen</th>' : '';
        html += '<table><thead><tr><th>Ingrediente</th><th>Cantidad</th>' + colOrigen + '<th>Usuario</th><th>Hora</th></tr></thead><tbody>';
        movs.forEach(m => {
          const t = m.created_at ? new Date(m.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
          const u = DISPLAY_NAMES[m.saved_by] || m.saved_by || '-';
          const origen = tipo === 'ingresos' ? '<td>' + ((m.origen || '').toUpperCase() || '—') + '</td>' : '';
          html += '<tr><td>' + m.ingrediente + '</td><td>' + (m.cantidad || 0) + '</td>' + origen + '<td>' + u + '</td><td>' + t + '</td></tr>';
        });
        html += '</tbody></table>';
      }
    }
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function calcularItemsSalientes() {
  const seccion = document.getElementById('items-salientes-section');
  if (!seccion) return;
  const totals = {};
  const units = {};
  document.querySelectorAll('#accordion-barra-ventas tr[data-receta]').forEach(tr => {
    const qty = parseFloat(tr.querySelector('.input-receta-qty').value) || 0;
    if (qty > 0) {
      const ingredientes = JSON.parse(tr.dataset.ingredientes || '[]');
      ingredientes.forEach(ing => {
        const name = String(ing.ingrediente || '').trim().toUpperCase().replace(/\s+/g, ' ');
        const cant = (ing.cantidad || 0) * qty;
        totals[name] = (totals[name] || 0) + cant;
        units[name] = ing.unidad || 'unidad';
      });
    }
  });
  const names = Object.keys(totals);
  if (!names.length) {
    seccion.innerHTML = '<p style="color:#888;">Calculado automáticamente al ingresar cantidades de recetas.</p>';
    return;
  }
  seccion.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th style="text-align:center;">Cantidad Consumida</th><th>Unidad</th></tr></thead><tbody>' +
    names.map(n => '<tr><td>' + n + '</td><td style="text-align:center;">' + (totals[n] || 0).toFixed(2) + '</td><td>' + (units[n] || 'unidad') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

function calcularCostosVenta() {
  const seccion = document.getElementById('costos-venta-section');
  const totalLabel = document.getElementById('costo-venta-total');
  if (!seccion) return;
  const filas = [];
  let total = 0;
  document.querySelectorAll('#accordion-barra-ventas tr[data-receta]').forEach(tr => {
    const qty = parseFloat(tr.querySelector('.input-receta-qty').value) || 0;
    const costo = parseFloat(tr.dataset.costo) || 0;
    if (qty > 0 && costo > 0) {
      const sub = costo * qty;
      total += sub;
      filas.push({ nombre: tr.dataset.receta, qty, costo, sub });
    }
  });
  if (totalLabel) totalLabel.textContent = total > 0 ? '— TOTAL: S/ ' + total.toFixed(2) : '';
  if (!filas.length) {
    seccion.innerHTML = '<p style="color:#888;">Ingresa cantidades de recetas para calcular los costos de venta.</p>';
    return;
  }
  seccion.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Receta</th><th style="text-align:center;">Cant.</th><th style="text-align:center;">Costo Unit.</th><th style="text-align:center;">Costo Total</th></tr></thead><tbody>' +
    filas.map(f => '<tr><td>' + esc(f.nombre) + '</td><td style="text-align:center;">' + f.qty + '</td><td style="text-align:center;">S/ ' + f.costo.toFixed(2) + '</td><td style="text-align:center;">S/ ' + f.sub.toFixed(2) + '</td></tr>').join('') +
    '<tr style="font-weight:700;background:#f0f0ff"><td>TOTAL COSTO DE VENTA</td><td colspan="3" style="text-align:center;">S/ ' + total.toFixed(2) + '</td></tr>' +
    '</tbody></table></div>';
}

// --- COSTOS: planillas, servicios y gastos operativos ---
const LABEL_COSTOS = { planillas: 'Planillas', servicios: 'Servicios', gastos: 'Gastos Operativos' };

function cargarCostos(tipo) {
  const fecha = document.getElementById('fecha-costos-' + tipo)?.value || todayStr();
  const accId = 'costos-' + tipo + '-container';
  const container = document.getElementById(accId);
  if (!container) return;
  api('GET', '/api/costos?fecha=' + fecha + '&tipo=' + tipo).then(list => {
    if (!list.length) {
      container.innerHTML = '<p>Sin registros en esta fecha.</p>' + formAgregarCosto(tipo);
      return;
    }
    let total = 0;
    let html = '<div class="table-wrap"><table><thead><tr><th>Concepto</th><th>Monto</th><th>Usuario</th><th></th></tr></thead><tbody>';
    list.forEach(c => {
      total += c.monto || 0;
      const u = DISPLAY_NAMES[c.saved_by] || c.saved_by || '-';
      html += `<tr>
        <td>${c.concepto || '-'}</td>
        <td>S/ ${(c.monto || 0).toFixed(2)}</td>
        <td>${u}</td>
        <td><button class="danger" onclick="eliminarCosto('${c.id}', '${tipo}')">✕</button></td>
      </tr>`;
    });
    html += `<tr style="font-weight:700;background:#f0f0ff"><td>TOTAL</td><td>S/ ${total.toFixed(2)}</td><td></td><td></td></tr>`;
    html += '</tbody></table></div>';
    html += formAgregarCosto(tipo);
    container.innerHTML = html;
  }).catch(e => { console.error(e); container.innerHTML = '<p>Error al cargar.</p>'; });
}

function formAgregarCosto(tipo) {
  return `
    <div style="margin-top:1rem;padding:1rem;background:#f9f9f9;border-radius:8px;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
      <input type="text" id="nuevo-costo-concepto-${tipo}" placeholder="Concepto / Descripción" style="padding:0.5rem;border:1px solid #ccc;border-radius:4px;flex:1;min-width:200px;">
      <input type="number" id="nuevo-costo-monto-${tipo}" placeholder="Monto (S/)" step="0.01" min="0" style="padding:0.5rem;border:1px solid #ccc;border-radius:4px;width:130px;">
      <button class="btn-guardar-dia" onclick="guardarCosto('${tipo}')">AGREGAR</button>
    </div>`;
}

function guardarCosto(tipo) {
  const fecha = document.getElementById('fecha-costos-' + tipo)?.value || todayStr();
  const concepto = document.getElementById('nuevo-costo-concepto-' + tipo)?.value.trim();
  const monto = parseFloat(document.getElementById('nuevo-costo-monto-' + tipo)?.value);
  if (!concepto || isNaN(monto)) { alert('Ingresa concepto y monto'); return; }
  api('POST', '/api/costos', { fecha, tipo, concepto, monto }).then(() => {
    showToast((LABEL_COSTOS[tipo] || 'Costo') + ' guardado');
    cargarCostos(tipo);
  }).catch(e => { console.error(e); alert('Error al guardar'); });
}

function eliminarCosto(id, tipo) {
  if (!confirm('¿Eliminar este registro?')) return;
  api('DELETE', '/api/costos/' + id).then(() => cargarCostos(tipo)).catch(e => { console.error(e); alert('Error al eliminar'); });
}

// --- COMPRAS: registro centralizado (reparte a STOCKS o BARRA) ---
let comprasCart = [];
let comprasAlmacenes = [];

function onCambiarDestinoCompra() {
  const destino = document.getElementById('nueva-compra-destino').value;
  const alSel = document.getElementById('compras-almacenes');
  const muSel = document.getElementById('compras-muebles');
  if (alSel) alSel.style.display = destino === 'stocks' ? '' : 'none';
  if (muSel) muSel.style.display = destino === 'barra' ? '' : 'none';
}

function onBuscarItemCompra(valor) {
  if (document.getElementById('nueva-compra-destino')?.value === 'stocks') {
    actualizarAlmacenesCompra(valor);
  }
}

function renderComprasAlmacenes(lista) {
  const cont = document.getElementById('compras-almacenes-lista');
  if (!cont) return;
  const chk = (x) => '<label style="font-size:0.82rem;display:flex;align-items:center;gap:0.25rem;padding:0.18rem 0;"><input type="checkbox" class="compra-almacen" value="' + Number(x.id) + '"> ' + esc(x.nombre) + (x.cantidad !== null && x.cantidad !== undefined ? ' <span style="color:#c62828;font-weight:700;">(' + x.cantidad + ')</span>' : '') + '</label>';
  const izquierda = lista.filter(x => !/ARRIBA/i.test(x.nombre));
  const derecha = lista.filter(x => /ARRIBA/i.test(x.nombre));
  cont.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem 1.5rem;align-items:start;">' +
      '<div>' +
        '<div style="font-size:0.72rem;font-weight:700;color:#666;margin-bottom:0.2rem;">ENTRADA / ABAJO</div>' +
        izquierda.map(chk).join('') +
        (!izquierda.length ? '<div style="color:#999;font-size:0.78rem;">Sin almacenes</div>' : '') +
      '</div>' +
      '<div>' +
        '<div style="font-size:0.72rem;font-weight:700;color:#666;margin-bottom:0.2rem;">ARRIBA</div>' +
        derecha.map(chk).join('') +
        (!derecha.length ? '<div style="color:#999;font-size:0.78rem;">Sin almacenes</div>' : '') +
      '</div>' +
    '</div>';
}

function actualizarAlmacenesCompra(nombre) {
  const q = (nombre || '').trim().toLowerCase().replace(/\s+/g, '');
  const fecha = document.getElementById('fecha-compras')?.value || todayStr();
  getInventario(fecha).then(inv => {
    const list = [];
    (inv || []).forEach(a => {
      let item = null;
      if (q) item = (a.items || []).find(i => String(i.nombre || '').toLowerCase().replace(/\s+/g, '').includes(q));
      if (!q) list.push({ id: a.id, nombre: a.nombre, cantidad: null });
      else if (item) list.push({ id: a.id, nombre: a.nombre, cantidad: item.stock_cierre !== undefined ? item.stock_cierre : item.stock_apertura });
    });
    renderComprasAlmacenes(list);
  }).catch(() => {});
}

function cargarCompras() {
  const fecha = document.getElementById('fecha-compras')?.value || todayStr();
  Promise.all([getInventario(fecha), api('GET', '/api/barra/precios'), api('GET', '/api/almacenes')]).then(([inv, precios, alms]) => {
    const dl = document.getElementById('sugerencia-compras');
    if (dl) {
      const seen = new Set();
      let html = '';
      const addSug = (n) => {
        const nombre = (n || '').trim().toUpperCase();
        if (!nombre) return;
        const key = nombre.replace(/\s+/g, '');
        if (seen.has(key)) return;
        seen.add(key);
        html += '<option value="' + nombre.replace(/"/g, '&quot;') + '"></option>';
      };
      (inv || []).forEach(a => (a.items || []).forEach(i => addSug(i.nombre)));
      (precios || []).forEach(p => addSug(p.ingrediente));
      dl.innerHTML = html;
    }
    comprasAlmacenes = alms || [];
    renderComprasAlmacenes(comprasAlmacenes.map(a => ({ id: Number(a.id), nombre: a.nombre, cantidad: null })));
    const muList = document.getElementById('compras-muebles-lista');
    if (muList) {
      muList.innerHTML = GRUPOS_BARRA.map(g =>
        '<label style="font-size:0.82rem;display:inline-flex;align-items:center;gap:0.25rem;"><input type="checkbox" class="compra-mueble" value="' + esc(g) + '" checked> ' + esc(g) + '</label>'
      ).join('');
    }
    onCambiarDestinoCompra();
    cargarComprasDetalle(fecha);
  }).catch(() => { cargarComprasDetalle(fecha); });
}

function comprasAlmacenesSeleccionados() {
  return Array.from(document.querySelectorAll('.compra-almacen:checked')).map(cb => Number(cb.value));
}

function comprasMueblesSeleccionados() {
  return Array.from(document.querySelectorAll('.compra-mueble:checked')).map(cb => cb.value);
}

function cargarComprasDetalle(fecha) {
  const c = document.getElementById('compras-detalle-container');
  if (!c) return;
  const fechaFinal = fecha || document.getElementById('fecha-compras')?.value || todayStr();
  api('GET', '/api/compras/detalle?fecha=' + encodeURIComponent(fechaFinal)).then(list => {
    const actual = document.getElementById('fecha-compras')?.value || todayStr();
    if (actual !== fechaFinal) return; // la fecha cambió, ignorar respuesta vieja
    if (!list || !list.length) {
      c.innerHTML = '<h3 style="margin:0 0 0.5rem 0;">DETALLE DE COMPRAS/INGRESOS</h3><p style="color:#888;">Aún no hay compras registradas en esta fecha.</p>';
      return;
    }
    const filas = list.map(r => {
      const alNombre = (id) => {
        const a = comprasAlmacenes.find(x => Number(x.id) === Number(id));
        return a ? a.nombre : ('Almacén ' + id);
      };
      let det = '';
      if (r.destino === 'stocks') det = 'STOCKS → ' + (r.almacenes || []).map(alNombre).join(', ');
      else if (r.destino === 'barra') det = 'BARRA → ' + (r.muebles || []).join(', ');
      else if (r.destino === 'cocina') det = 'COCINA';
      const t = r.created_at ? new Date(r.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
      const precioUni = parseFloat(r.precio) || 0;
      const precioTot = parseFloat(r.precio_total) || (precioUni * (r.cantidad || 0));
      return `<tr><td>${esc(r.nombre)}</td><td>${r.cantidad}</td><td>${precioUni > 0 ? 'S/ ' + precioUni.toFixed(2) : '—'}</td><td>${precioTot > 0 ? 'S/ ' + precioTot.toFixed(2) : '—'}</td><td>${esc(det)}</td><td>${t}</td><td>${esc(r.saved_by || '-')}</td><td><button class="danger" onclick="confirmarEliminarCompra('${r.id}')">✕</button></td></tr>`;
    }).join('');
    const totalCompra = (list || []).reduce((s, r) => s + (parseFloat(r.precio_total) || ((parseFloat(r.precio) || 0) * (r.cantidad || 0))), 0);
    c.innerHTML = '<h3 style="margin:0 0 0.5rem 0;">DETALLE DE COMPRAS/INGRESOS</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Cantidad</th><th>Precio Unidad</th><th>Precio Total</th><th>Destino</th><th>Hora</th><th>Usuario</th><th></th></tr></thead><tbody>' +
      filas + '</tbody></table></div>' +
      (totalCompra > 0 ? '<p style="font-weight:700;color:#0f3460;margin-top:0.5rem;">TOTAL COMPRAS: S/ ' + totalCompra.toFixed(2) + '</p>' : '');
  }).catch(() => { const actual = document.getElementById('fecha-compras')?.value || todayStr(); if (actual === fechaFinal) c.innerHTML = '<p style="color:#888;">DETALLE DE COMPRAS/INGRESOS</p>'; });
}

function confirmarEliminarCompra(id) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';
  body.innerHTML = `
    <h3>Eliminar Compra/Ingreso</h3>
    <p style="color:#666;margin-top:0.75rem;">¿Seguro que quieres eliminar este registro? Se revertirá el ingreso en STOCKS/BARRA correspondiente.</p>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="eliminarCompra('${id}')" style="flex:1;padding:0.5rem;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;">Eliminar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>
  `;
}

function eliminarCompra(id) {
  const fecha = document.getElementById('fecha-compras')?.value || todayStr();
  api('DELETE', '/api/compras/' + id + '?fecha=' + encodeURIComponent(fecha)).then(() => {
    cerrarModal();
    showToast('Compra/Ingreso eliminado');
    cargarComprasDetalle(fecha);
    _invCache = { fecha: null, data: null, pending: null };
    actualizarContadoresMenu();
    if (typeof cargarAlmacenes === 'function') cargarAlmacenes(fecha);
  }).catch(e => { console.error(e); alert('Error al eliminar'); });
}

// --- VENTAS: registro centralizado (salen de STOCKS, BARRA o COCINA) ---
let ventasCart = [];
let ventasAlmacenes = [];

function onCambiarDestinoVenta() {
  const destino = document.getElementById('nueva-venta-destino').value;
  const alSel = document.getElementById('ventas-almacenes');
  if (alSel) alSel.style.display = destino === 'stocks' ? '' : 'none';
  cargarSugerenciasVentas(destino);
}

function cargarSugerenciasVentas(destino) {
  const dl = document.getElementById('sugerencia-ventas');
  if (!dl) return;
  if (destino === 'barra') {
    api('GET', '/api/recetas').then(recetas => {
      const seen = new Set();
      let html = '';
      (recetas || []).forEach(r => {
        const n = (r.nombre || '').trim().toUpperCase();
        if (!n) return;
        const key = n.replace(/\s+/g, '');
        if (seen.has(key)) return;
        seen.add(key);
        html += '<option value="' + n.replace(/"/g, '&quot;') + '"></option>';
      });
      dl.innerHTML = html;
    }).catch(() => {});
    return;
  }
  const fecha = document.getElementById('fecha-ventas-menu')?.value || todayStr();
  getInventario(fecha).then(inv => {
    const seen = new Set();
    let html = '';
    (inv || []).forEach(a => (a.items || []).forEach(i => {
      const n = (i.nombre || '').trim().toUpperCase();
      if (!n) return;
      const key = n.replace(/\s+/g, '');
      if (seen.has(key)) return;
      seen.add(key);
      html += '<option value="' + n.replace(/"/g, '&quot;') + '"></option>';
    }));
    dl.innerHTML = html;
  }).catch(() => {});
}

function onBuscarItemVenta(valor) {
  if (document.getElementById('nueva-venta-destino')?.value === 'stocks') {
    actualizarAlmacenesVenta(valor);
  }
}

function renderVentasAlmacenes(lista) {
  const cont = document.getElementById('ventas-almacenes-lista');
  if (!cont) return;
  const chk = (x) => '<label style="font-size:0.82rem;display:flex;align-items:center;gap:0.25rem;padding:0.18rem 0;"><input type="checkbox" class="venta-almacen" value="' + Number(x.id) + '"> ' + esc(x.nombre) + (x.cantidad !== null && x.cantidad !== undefined ? ' <span style="color:#c62828;font-weight:700;">(' + x.cantidad + ')</span>' : '') + '</label>';
  const izquierda = lista.filter(x => !/ARRIBA/i.test(x.nombre));
  const derecha = lista.filter(x => /ARRIBA/i.test(x.nombre));
  cont.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem 1.5rem;align-items:start;">' +
      '<div>' +
        '<div style="font-size:0.72rem;font-weight:700;color:#666;margin-bottom:0.2rem;">ENTRADA / ABAJO</div>' +
        izquierda.map(chk).join('') +
        (!izquierda.length ? '<div style="color:#999;font-size:0.78rem;">Sin almacenes</div>' : '') +
      '</div>' +
      '<div>' +
        '<div style="font-size:0.72rem;font-weight:700;color:#666;margin-bottom:0.2rem;">ARRIBA</div>' +
        derecha.map(chk).join('') +
        (!derecha.length ? '<div style="color:#999;font-size:0.78rem;">Sin almacenes</div>' : '') +
      '</div>' +
    '</div>';
}

function actualizarAlmacenesVenta(nombre) {
  const q = (nombre || '').trim().toLowerCase().replace(/\s+/g, '');
  const fecha = document.getElementById('fecha-ventas-menu')?.value || todayStr();
  getInventario(fecha).then(inv => {
    const list = [];
    (inv || []).forEach(a => {
      let item = null;
      if (q) {
        item = (a.items || []).find(i => String(i.nombre || '').toLowerCase().replace(/\s+/g, '').includes(q));
      }
      if (!q) {
        list.push({ id: a.id, nombre: a.nombre, cantidad: null });
      } else if (item) {
        const cant = item.stock_cierre !== undefined ? item.stock_cierre : item.stock_apertura;
        list.push({ id: a.id, nombre: a.nombre, cantidad: cant });
      }
    });
    renderVentasAlmacenes(list);
  }).catch(() => {});
}

function cargarVentasCentral() {
  const fecha = document.getElementById('fecha-ventas-menu')?.value || todayStr();
  cargarVentasDetalle(fecha);
}

function ventasAlmacenesSeleccionados() {
  return Array.from(document.querySelectorAll('.venta-almacen:checked')).map(cb => Number(cb.value));
}

function agregarVenta() {
  const nombre = document.getElementById('nueva-venta-input').value.trim();
  const cantidad = parseFloat(document.getElementById('nueva-venta-cant').value);
  const destino = document.getElementById('nueva-venta-destino').value;
  if (!nombre || isNaN(cantidad) || cantidad <= 0) { alert('Ingresa un item/receta y una cantidad'); return; }
  const fecha = document.getElementById('fecha-ventas-menu')?.value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  let almacenes;
  if (destino === 'stocks') {
    const ids = ventasAlmacenesSeleccionados();
    if (!ids.length) { alert('Selecciona al menos un almacén de donde sale esta venta'); return; }
    almacenes = ventasAlmacenes.filter(a => ids.includes(Number(a.id))).map(a => Number(a.id));
  }
  const btn = document.getElementById('btn-agregar-venta');
  if (btn) btn.disabled = true;
  api('POST', '/api/ventas/guardar', { fecha, items: [{ nombre, cantidad, destino, almacenes }] }).then(r => {
    if (btn) btn.disabled = false;
    const res = r.resumen || {};
    let msg = 'Venta registrada: ' + nombre + ' x' + cantidad;
    if (res.noEncontrados && res.noEncontrados.length) msg += ' (no encontrado)';
    showToast(msg);
    document.getElementById('nueva-venta-input').value = '';
    document.getElementById('nueva-venta-cant').value = '';
    cargarVentasDetalle(fecha);
    _invCache = { fecha: null, data: null, pending: null };
    actualizarContadoresMenu();
    if (typeof cargarAlmacenes === 'function') cargarAlmacenes(fecha);
    if (typeof cargarVentas === 'function') cargarVentas(fecha);
    if (typeof cargarStockBarra === 'function') cargarStockBarra();
  }).catch(e => {
    console.error(e);
    if (btn) btn.disabled = false;
    alert('Error al registrar');
  });
}

function guardarVentasCentral() {
  agregarVenta();
}

let ventasDetalleMap = {};

function cargarVentasDetalle(fecha) {
  const c = document.getElementById('ventas-detalle-container');
  if (!c) return;
  const fechaFinal = fecha || document.getElementById('fecha-ventas-menu')?.value || todayStr();
  api('GET', '/api/ventas/detalle?fecha=' + encodeURIComponent(fechaFinal)).then(list => {
    // Solo renderizar si la fecha aún es la seleccionada (evita que una consulta vieja sobreescriba)
    const actual = document.getElementById('fecha-ventas-menu')?.value || todayStr();
    if (actual !== fechaFinal) return;
    if (!list || !list.length) {
      ventasDetalleMap = {};
      c.innerHTML = '<h3 style="margin:0 0 0.5rem 0;">DETALLE DE VENTAS</h3><p style="color:#888;">Aún no hay ventas registradas en esta fecha.</p>';
      return;
    }
    const alNombre = (id) => {
      const a = ventasAlmacenes.find(x => Number(x.id) === Number(id));
      return a ? a.nombre : ('Almacén ' + id);
    };
    ventasDetalleMap = {};
    list.forEach(r => { ventasDetalleMap[r.id] = r; });
    const filas = list.map(r => {
      let det = '';
      if (r.destino === 'stocks') det = 'STOCKS → ' + (r.almacenes || []).map(alNombre).join(', ');
      else if (r.destino === 'barra') det = 'BARRA (receta)';
      else if (r.destino === 'cocina') det = 'COCINA';
      const t = r.created_at ? new Date(r.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
      return `<tr><td>${esc(r.nombre)}</td><td>${r.cantidad}</td><td>${esc(det)}</td><td>${t}</td><td>${esc(r.saved_by || '-')}</td><td><button class="danger" onclick="confirmarEliminarVenta('${r.id}')">✕</button></td></tr>`;
    }).join('');
    c.innerHTML = '<h3 style="margin:0 0 0.5rem 0;">DETALLE DE VENTAS</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Cantidad</th><th>Destino</th><th>Hora</th><th>Usuario</th><th></th></tr></thead><tbody>' +
      filas + '</tbody></table></div>';
  }).catch(() => { const actual = document.getElementById('fecha-ventas-menu')?.value || todayStr(); if (actual === fechaFinal) c.innerHTML = '<p style="color:#888;">DETALLE DE VENTAS</p>'; });
}

function confirmarEliminarVenta(id) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';
  body.innerHTML = `
    <h3>Eliminar Venta</h3>
    <p style="color:#666;margin-top:0.75rem;">¿Seguro que quieres eliminar esta venta? Se revertirá en STOCKS/BARRA correspondiente.</p>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="eliminarVenta('${id}')" style="flex:1;padding:0.5rem;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;">Eliminar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>
  `;
}

function eliminarVenta(id) {
  const entry = ventasDetalleMap[id];
  const fecha = (entry && entry.fecha) || document.getElementById('fecha-ventas-menu')?.value || todayStr();
  let body;
  if (entry && entry.grupo) {
    if (entry.destino === 'stocks') body = { fecha, grupo: true, destino: 'stocks', item_id: entry.item_id, almacen_id: (entry.almacenes || [])[0], log_ids: entry.log_ids };
    else if (entry.destino === 'barra') body = { fecha, grupo: true, destino: 'barra', nombre: entry.nombre, log_ids: entry.log_ids };
  } else if (entry && !entry.log_id) {
    if (entry.destino === 'stocks') {
      const parts = String(id).split('_');
      body = { fecha, manual: true, destino: 'stocks', item_id: Number(parts[1]), almacen_id: Number(parts[2]) };
    } else if (entry.destino === 'barra') {
      body = { fecha, manual: true, destino: 'barra', nombre: entry.nombre, cantidad: entry.cantidad };
    }
  }
  api('DELETE', '/api/ventas/' + id, body).then(() => {
    cerrarModal();
    showToast('Venta eliminada');
    cargarVentasDetalle(fecha);
    _invCache = { fecha: null, data: null, pending: null };
    actualizarContadoresMenu();
    if (typeof cargarAlmacenes === 'function') cargarAlmacenes(fecha);
    if (typeof cargarVentas === 'function') cargarVentas(fecha);
    if (typeof cargarStockBarra === 'function') cargarStockBarra();
  }).catch(e => { console.error(e); alert('Error al eliminar'); });
}

function onCompraCantidadChange() {
  recalcularPrecioCompra('total');
}
function onCompraPrecioUnidadChange() {
  recalcularPrecioCompra('unidad');
}
function onCompraPrecioTotalChange() {
  recalcularPrecioCompra('total');
}
// Calcula el precio faltante: si se ingresa el TOTAL, divide total/cantidad para el precio unidad
// (ej. total 100 / cantidad 5 = 20 de precio unidad); si se ingresa el precio UNIDAD, multiplica
// unidad*cantidad para el total.
function recalcularPrecioCompra(origen) {
  const cant = parseFloat(document.getElementById('nueva-compra-cant').value) || 0;
  const uniEl = document.getElementById('nueva-compra-precio-uni');
  const totEl = document.getElementById('nueva-compra-precio-total');
  if (!uniEl || !totEl) return;
  const uni = parseFloat(uniEl.value) || 0;
  const tot = parseFloat(totEl.value) || 0;
  if (cant <= 0) return;
  if (origen === 'total' && tot > 0) {
    // Precio por unidad = total / cantidad (SIEMPRE se recalcula al cambiar el total o la cantidad)
    uniEl.value = Math.round((tot / cant) * 100) / 100;
  } else if (origen === 'unidad' && uni > 0) {
    totEl.value = Math.round(uni * cant * 100) / 100;
  } else if (origen === 'unidad' && uni === 0 && tot > 0) {
    uniEl.value = Math.round((tot / cant) * 100) / 100;
  }
}

function agregarCompra() {
  const nombre = document.getElementById('nueva-compra-input').value.trim();
  const cantidad = parseFloat(document.getElementById('nueva-compra-cant').value);
  const uniEl = document.getElementById('nueva-compra-precio-uni');
  const totEl = document.getElementById('nueva-compra-precio-total');
  let precioUni = uniEl ? (parseFloat(uniEl.value) || 0) : 0;
  let precioTotal = totEl ? (parseFloat(totEl.value) || 0) : 0;
  const destino = document.getElementById('nueva-compra-destino').value;
  if (!nombre || isNaN(cantidad) || cantidad <= 0) { alert('Ingresa un item y una cantidad'); return; }
  // Auto-cálculo: si solo hay TOTAL y cantidad, dividir para el precio por unidad
  if (precioTotal > 0 && precioUni === 0) precioUni = Math.round((precioTotal / cantidad) * 100) / 100;
  if (precioUni > 0 && precioTotal === 0) precioTotal = Math.round(precioUni * cantidad * 100) / 100;
  const fecha = document.getElementById('fecha-compras')?.value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  let almacenes;
  let muebles;
  if (destino === 'stocks') {
    const ids = comprasAlmacenesSeleccionados();
    almacenes = comprasAlmacenes.filter(a => ids.includes(Number(a.id))).map(a => Number(a.id));
  } else if (destino === 'barra') {
    muebles = comprasMueblesSeleccionados();
  }
  const btn = document.getElementById('btn-agregar-compra');
  if (btn) btn.disabled = true;
  api('POST', '/api/compras/guardar', { fecha, items: [{ nombre, cantidad, unidad: 'unidad', destino, almacenes, muebles, precio: precioUni, precio_total: precioTotal }] }).then(r => {
    if (btn) btn.disabled = false;
    const res = r.resumen || {};
    let msg = 'Compra registrada: ' + nombre + ' x' + cantidad + (precioTotal > 0 ? ' (S/ ' + precioTotal + ')' : '');
    if (res.noEncontrados && res.noEncontrados.length) msg += ' (no encontrado)';
    showToast(msg);
    document.getElementById('nueva-compra-input').value = '';
    document.getElementById('nueva-compra-cant').value = '';
    document.getElementById('nueva-compra-precio-uni').value = '';
    document.getElementById('nueva-compra-precio-total').value = '';
    cargarComprasDetalle(fecha);
    _invCache = { fecha: null, data: null, pending: null };
    actualizarContadoresMenu();
    if (typeof cargarAlmacenes === 'function') cargarAlmacenes(fecha);
  }).catch(e => {
    console.error(e);
    if (btn) btn.disabled = false;
    alert('Error al registrar');
  });
}

function guardarCompras() {
  agregarCompra();
}

// --- COSTOS: pestañas dinámicas ---
let CATEGORIAS_COSTOS = {};

function agregarCampo(prefix) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';
  body.innerHTML = `
    <h3>Agregar Campo</h3>
    <label style="display:block;margin-top:1rem;">
      Nombre del Campo
      <input type="text" id="f-nuevo-campo" placeholder="Ej: BARTENDERS" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="guardarCampo('${prefix}')" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>
  `;
}

function guardarCampo(prefix) {
  const nombre = document.getElementById('f-nuevo-campo').value.trim();
  if (!nombre) { alert('Ingresa un nombre'); return; }
  api('POST', '/api/' + prefix + '/titulos', { nombre }).then(() => {
    cerrarModal();
    showToast('Campo agregado');
    cargarCostoCategoria(prefix);
  }).catch(e => { console.error(e); alert('Error al agregar'); });
}

function editarTitulo(prefix, viejo) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';
  body.innerHTML = `
    <h3>Renombrar Campo</h3>
    <label style="display:block;margin-top:1rem;">
      Nombre Actual
      <input type="text" value="${viejo}" disabled style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;background:#f5f5f5;">
    </label>
    <label style="display:block;margin-top:1rem;">
      Nuevo Nombre
      <input type="text" id="f-nuevo-nombre" value="${viejo}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="guardarTitulo('${prefix}', '${viejo.replace(/'/g, "\\'")}')" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>
  `;
}

function guardarTitulo(prefix, viejo) {
  const nuevo = document.getElementById('f-nuevo-nombre').value.trim();
  if (!nuevo) { alert('Ingresa un nombre'); return; }
  if (nuevo.toUpperCase() === viejo.toUpperCase()) { cerrarModal(); return; }
  api('PUT', '/api/' + prefix + '/titulos', { viejo, nuevo }).then(() => {
    cerrarModal();
    showToast('Campo renombrado');
    cargarCostoCategoria(prefix);
  }).catch(e => { console.error(e); alert('Error al editar'); });
}

function confirmarEliminarTitulo(prefix, idx) {
  const cfg = CATEGORIAS_COSTOS[prefix];
  if (!cfg) return;
  const nombre = cfg.titulos[idx] || '';
  if (!nombre) return;
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';
  body.innerHTML = `
    <h3>Eliminar Campo</h3>
    <p style="color:#666;margin-top:0.75rem;">¿Seguro que quieres eliminar el campo <b>${esc(nombre)}</b>? Se eliminarán también sus registros asociados.</p>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="eliminarTitulo('${prefix}', ${idx})" style="flex:1;padding:0.5rem;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;">Eliminar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>
  `;
}

function eliminarTitulo(prefix, idx) {
  const cfg = CATEGORIAS_COSTOS[prefix];
  if (!cfg) return;
  const nombre = cfg.titulos[idx] || '';
  if (!nombre) return;
  api('DELETE', '/api/' + prefix + '/titulos', { nombre }).then(r => {
    cerrarModal();
    showToast('Campo eliminado' + (r.eliminados ? ' (' + r.eliminados + ' registros)' : ''));
    cargarCostoCategoria(prefix);
  }).catch(e => { console.error(e); alert('Error al eliminar'); });
}

function cargarPestanas() {
  return api('GET', '/api/costos/pestanas').then(r => {
    const pestanas = r.pestanas || [];
    CATEGORIAS_COSTOS = {};
    pestanas.forEach(p => {
      CATEGORIAS_COSTOS[p.id] = {
        tipo: p.tipo, titulos: p.titulos || [], campoSub: p.campoSub, campoTexto: p.campoTexto,
        colLabel: p.colLabel, phTexto: p.phTexto, editableTitulos: p.editableTitulos !== false,
        label: p.label, titulosDoc: p.titulosDoc, grupos: p.grupos || null, fechaGlobal: p.fechaGlobal === true,
        gastosFijos: p.gastosFijosOrigen ? { origen: p.gastosFijosOrigen } : null
      };
    });
    renderizarPestanas(pestanas);
    return pestanas;
  });
}

function renderizarPestanas(pestanas) {
  const tabsBar = document.getElementById('tabs-costos');
  const contentArea = document.getElementById('costos-content-area');
  if (!tabsBar || !contentArea) return;
  const tabsContainer = tabsBar.querySelector('.tabs');
  if (!tabsContainer) return;
  let tabsHtml = '';
  let contentHtml = '';
  pestanas.forEach((p, i) => {
    const activeClass = i === 0 ? 'active' : '';
    tabsHtml += `<div class="sub-tab ${activeClass}" data-subtab="${p.id}" onclick="cambiarSubTab('${p.id}', 'costos')">
      ${p.label}
      <button class="editar-titulo" onclick="event.stopPropagation(); editarPestana('${p.id}')" title="Renombrar" style="margin-left:0.3rem;padding:0.1rem 0.3rem;background:#0f3460;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:0.65rem;">✏️</button>
    </div>`;
    const activeContent = i === 0 ? 'active' : '';
    contentHtml += `<div id="sub-costos-${p.id}" class="sub-tab-content ${activeContent}">
      <div class="header-actions">
        <h2>${p.label}</h2>
        <button onclick="agregarCampo('${p.id}')" style="padding:0.5rem 1rem;background:#0f3460;color:#fff;border:none;border-radius:6px;font-size:0.9rem;font-weight:700;cursor:pointer;">➕ AGREGAR CAMPO</button>
      </div>
      <div id="costos-${p.id}-container"><p>Cargando...</p></div>
    </div>`;
  });
  tabsHtml += `<div class="sub-tab" onclick="nuevaPestana()" style="cursor:pointer;color:#0f3460;font-weight:700;">➕</div>`;
  tabsContainer.innerHTML = tabsHtml;
  contentArea.innerHTML = contentHtml;
}

function nuevaPestana() {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';
  body.innerHTML = `
    <h3>Nueva Pestaña</h3>
    <label style="display:block;margin-top:1rem;">
      Nombre de la Pestaña
      <input type="text" id="f-nueva-pestana" placeholder="Ej: COMISIONES" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="guardarNuevaPestana()" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Crear</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>
  `;
}

function guardarNuevaPestana() {
  const label = document.getElementById('f-nueva-pestana').value.trim();
  if (!label) { alert('Ingresa un nombre'); return; }
  api('POST', '/api/costos/pestanas', { label }).then(() => {
    cerrarModal();
    showToast('Pestaña creada');
    cargarPestanas().then(() => {
      CATEGORIAS_COSTOS._loaded = {};
    });
  }).catch(e => { console.error(e); alert(e.message || 'Error al crear'); });
}

function editarPestana(id) {
  const cfg = CATEGORIAS_COSTOS[id];
  if (!cfg) return;
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.style.display = 'block';
  body.innerHTML = `
    <h3>Renombrar Pestaña</h3>
    <label style="display:block;margin-top:1rem;">
      Nombre Actual
      <input type="text" value="${cfg.label}" disabled style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;background:#f5f5f5;">
    </label>
    <label style="display:block;margin-top:1rem;">
      Nuevo Nombre
      <input type="text" id="f-nuevo-label-pestana" value="${cfg.label}" style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px;margin-top:0.3rem;">
    </label>
    <div style="margin-top:1.5rem;display:flex;gap:0.5rem;">
      <button onclick="guardarEditarPestana('${id}')" style="flex:1;padding:0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;">Guardar</button>
      <button onclick="cerrarModal()" style="flex:1;padding:0.5rem;background:#666;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancelar</button>
    </div>
  `;
}

function guardarEditarPestana(id) {
  const label = document.getElementById('f-nuevo-label-pestana').value.trim();
  if (!label) { alert('Ingresa un nombre'); return; }
  api('PUT', '/api/costos/pestanas/' + id, { label }).then(() => {
    cerrarModal();
    showToast('Pestaña renombrada');
    cargarPestanas();
  }).catch(e => { console.error(e); alert('Error al editar'); });
}

function cargarCostoCategoria(prefix) {
  const cfg = CATEGORIAS_COSTOS[prefix];
  if (!cfg) return;
  const container = document.getElementById('costos-' + prefix + '-container');
  if (!container) return;
  if (cfg.grupos && cfg.grupos.length) { renderCostoGrupos(prefix, container, cfg); return; }
  const titulosDoc = cfg.titulosDoc || (prefix + '_titulos');
  api('GET', '/api/' + prefix + '/titulos').then(r => {
    if (r.titulos && r.titulos.length) cfg.titulos = r.titulos;
    renderCostoCategoria(prefix, container);
  }).catch(() => renderCostoCategoria(prefix, container));
}

function renderCostoCategoria(prefix, container) {
  const cfg = CATEGORIAS_COSTOS[prefix];
  let gfConfig = null;
  if (cfg.gastosFijos && cfg.gastosFijos.origen) {
    const origen = CATEGORIAS_COSTOS[cfg.gastosFijos.origen];
    if (origen && origen.grupos && origen.grupos.length) gfConfig = { grupos: origen.grupos };
  }
  const mes = document.getElementById('mes-pestana-' + prefix)?.value || todayStr().slice(0, 7);
  const peticiones = [api('GET', '/api/costos?tipo=' + cfg.tipo)];
  if (gfConfig) gfConfig.grupos.forEach(g => peticiones.push(api('GET', '/api/costos?tipo=' + g.tipo + '&mes=' + mes)));
  Promise.all(peticiones).then(resultados => {
    const list = resultados[0];
    const groups = {};
    cfg.titulos.forEach(t => { groups[t] = []; });
    groups['OTROS'] = [];
    list.forEach(c => {
      let key = (c[cfg.campoSub] || '').toUpperCase();
      if (!groups[key]) {
        const up = (c.concepto || '').toUpperCase();
        key = cfg.titulos.find(t => up.includes(t)) || 'OTROS';
      }
      groups[key].push(c);
    });
    let gfTotal = 0;
    let gfHtml = '';
    if (gfConfig) {
      const built = buildCostoGruposHTML(gfConfig.grupos, resultados.slice(1), prefix, true);
      gfHtml = built.html;
      gfTotal = built.totalGeneral;
    }
    const totalGeneral = list.reduce((s, r) => s + (r.monto || 0), 0) + gfTotal;
    let html = '';
    if (gfConfig) {
      html += `<div class="costos-fecha-row">
        <label>MES</label>
        <input type="month" id="mes-pestana-${prefix}" value="${mes}" onchange="cargarCostoCategoria('${prefix}')">
      </div>
      <div style="font-size:0.75rem;color:#888;margin:-0.25rem 0 0.75rem 0;">Los montos se acumulan durante el mes y se reinician a S/ 0 el 1ro del mes siguiente.</div>`;
    }
    html += `<div class="autosuma-box" id="autosuma-${prefix}" data-base="${totalGeneral}">
      <span class="autosuma-label">TOTAL</span>
      <span class="autosuma-monto">S/ ${totalGeneral.toFixed(2)}</span>
    </div>`;
    cfg.titulos.forEach((t, idx) => {
      if (gfConfig && String(t).toUpperCase() === 'GASTOS FIJOS') {
        html += `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${t} <span style="font-weight:400;font-size:0.85rem;color:#777;">— TOTAL: S/ ${gfTotal.toFixed(2)}</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">${gfHtml}</div>
        </div>`;
        return;
      }
      const records = groups[t].sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
      const total = records.reduce((sum, r) => sum + (r.monto || 0), 0);
      const rows = records.map(r => {
        const u = DISPLAY_NAMES[r.saved_by] || r.saved_by || '-';
        return `<tr>
          <td>${r[cfg.campoTexto] || r.concepto || '-'}</td>
          <td>${r.fecha || '-'}</td>
          <td>S/ ${(r.monto || 0).toFixed(2)}</td>
          <td>${u}</td>
          <td><button class="danger" onclick="eliminarCostoCategoria('${prefix}', '${r.id}')">✕</button></td>
        </tr>`;
      }).join('');
      html += `<div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${t} <span style="font-weight:400;font-size:0.85rem;color:#777;">— TOTAL: S/ ${total.toFixed(2)}</span></span>
          ${cfg.editableTitulos ? `<button class="editar-titulo" title="Renombrar campo" onclick="event.stopPropagation(); editarTitulo('${prefix}', '${esc(t).replace(/'/g, '&#39;')}')" style="margin-left:0.5rem;padding:0.2rem 0.5rem;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.75rem;">✏️ Renombrar</button>
          <button class="borrar-titulo" title="Eliminar campo" onclick="event.stopPropagation(); confirmarEliminarTitulo('${prefix}', ${idx})" style="margin-left:0.3rem;padding:0.2rem 0.5rem;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.75rem;">✕</button>` : ''}
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          <div class="table-wrap"><table>
            <thead><tr><th>${cfg.colLabel}</th><th>Fecha</th><th>Monto</th><th>Usuario</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5">Sin registros.</td></tr>'}</tbody>
          </table></div>
          <div style="margin-top:0.75rem;padding:0.75rem;background:#f9f9f9;border-radius:8px;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
            <input type="text" id="nuevo-${prefix}-texto-${idx}" placeholder="${cfg.phTexto}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;flex:1;min-width:160px;">
            <label>Fecha: <input type="date" id="nuevo-${prefix}-fecha-${idx}" value="${todayStr()}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></label>
            <input type="number" id="nuevo-${prefix}-monto-${idx}" placeholder="Monto (S/)" step="0.01" min="0" oninput="actualizarAutosuma('${prefix}')" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;width:120px;">
            <button class="btn-guardar-dia" onclick="guardarCostoCategoria('${prefix}', ${idx})">AGREGAR</button>
          </div>
        </div>
      </div>`;
    });
    if (groups['OTROS'].length) {
      html += '<p style="color:#c62828;margin-top:0.5rem;">Nota: ' + groups['OTROS'].length + ' registro(s) sin clasificar quedaron sin mostrar.</p>';
    }
    container.innerHTML = html;
  }).catch(e => { console.error(e); container.innerHTML = '<p>Error al cargar.</p>'; });
}

function guardarCostoCategoria(prefix, idx) {
  const cfg = CATEGORIAS_COSTOS[prefix];
  const sub = cfg.titulos[idx];
  const texto = document.getElementById('nuevo-' + prefix + '-texto-' + idx)?.value.trim() || sub;
  const fecha = document.getElementById('nuevo-' + prefix + '-fecha-' + idx)?.value;
  const monto = parseFloat(document.getElementById('nuevo-' + prefix + '-monto-' + idx)?.value);
  if (!fecha || isNaN(monto)) { alert('Ingresa fecha y monto'); return; }
  const body = { fecha, tipo: cfg.tipo, concepto: texto, monto };
  body[cfg.campoSub] = sub.toLowerCase();
  api('POST', '/api/costos', body).then(() => {
    showToast('Registro de ' + sub + ' guardado');
    cargarCostoCategoria(prefix);
  }).catch(e => { console.error(e); alert('Error al guardar'); });
}

function eliminarCostoCategoria(prefix, id) {
  if (!confirm('¿Eliminar este registro?')) return;
  api('DELETE', '/api/costos/' + id).then(() => cargarCostoCategoria(prefix)).catch(e => { console.error(e); alert('Error al eliminar'); });
}

function renderCostoGrupos(prefix, container, cfg) {
  const grupos = cfg.grupos;
  if (cfg.fechaGlobal) {
    renderCostoGruposGlobal(prefix, container, cfg, grupos);
  } else {
    renderCostoGruposPorCampo(prefix, container, cfg, grupos);
  }
}

function renderCostoGruposGlobal(prefix, container, cfg, grupos) {
  const fecha = document.getElementById('fecha-pestana-' + prefix)?.value || todayStr();
  Promise.all(grupos.map(g => api('GET', '/api/costos?fecha=' + fecha + '&tipo=' + g.tipo))).then(lists => {
    let totalGeneral = 0;
    let html = '';
    grupos.forEach((g, gi) => {
      const list = lists[gi] || [];
      const groups = {};
      g.titulos.forEach(t => { groups[t] = []; });
      groups['OTROS'] = [];
      let subTotal = 0;
      list.forEach(c => {
        subTotal += c.monto || 0;
        let key = (c[g.campoSub] || '').toUpperCase();
        if (!groups[key]) {
          const up = (c.concepto || '').toUpperCase();
          key = g.titulos.find(t => up.includes(t)) || 'OTROS';
        }
        groups[key].push(c);
      });
      totalGeneral += subTotal;
      html += `<div class="grupo-header"><span>${g.label}</span><span class="grupo-subtotal">S/ ${subTotal.toFixed(2)}</span></div>`;
      g.titulos.forEach((t, idx) => {
        const records = groups[t].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
        const total = records.reduce((s, r) => s + (r.monto || 0), 0);
        const last = records[records.length - 1];
        const montoOrig = last ? (last.monto || 0) : '';
        const textoOrig = last ? (last[g.campoTexto] || last.concepto || '') : '';
        const rows = records.map(r => {
          const u = DISPLAY_NAMES[r.saved_by] || r.saved_by || '-';
          return `<tr>
            <td>${r[g.campoTexto] || r.concepto || '-'}</td>
            <td>S/ ${(r.monto || 0).toFixed(2)}</td>
            <td>${u}</td>
            <td><button class="danger" onclick="eliminarCostoCategoriaGrupo('${prefix}', ${gi}, '${r.id}')">✕</button></td>
          </tr>`;
        }).join('');
        html += `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${t} <span style="font-weight:400;font-size:0.85rem;color:#777;">— S/ ${total.toFixed(2)}</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>${g.colLabel}</th><th>Monto</th><th>Usuario</th><th></th></tr></thead>
              <tbody>${rows || '<tr><td colspan="4">Sin registros en esta fecha.</td></tr>'}</tbody>
            </table></div>
            <div style="margin-top:0.75rem;padding:0.75rem;background:#f9f9f9;border-radius:8px;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
              <input type="text" id="nuevo-${prefix}-g${gi}-texto-${idx}" placeholder="${g.phTexto}" value="${esc(textoOrig)}" data-orig="${esc(textoOrig)}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;flex:1;min-width:160px;">
              <input type="number" id="nuevo-${prefix}-g${gi}-monto-${idx}" placeholder="Monto (S/)" step="0.01" min="0" value="${montoOrig}" data-orig="${montoOrig}" oninput="actualizarAutosuma('${prefix}')" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;width:120px;">
            </div>
          </div>
        </div>`;
      });
      if (groups['OTROS'].length) html += `<p style="color:#c62828;margin-top:0.5rem;">Nota: ${groups['OTROS'].length} registro(s) sin clasificar en ${g.label}.</p>`;
    });
    const top = `<div class="costos-fecha-row">
      <label>FECHA</label>
      <input type="date" id="fecha-pestana-${prefix}" value="${fecha}" data-prev="${fecha}" onchange="confirmarCambioFechaCosto('${prefix}')">
      <button class="btn-guardar-dia" onclick="guardarTodosLosCampos('${prefix}')">💾 GUARDAR</button>
    </div>`;
    const box = `<div class="autosuma-box" id="autosuma-${prefix}" data-base="${totalGeneral}">
      <span class="autosuma-label">TOTAL</span>
      <span class="autosuma-monto">S/ ${totalGeneral.toFixed(2)}</span>
    </div>`;
    container.innerHTML = top + box + html;
  }).catch(e => { console.error(e); container.innerHTML = '<p>Error al cargar.</p>'; });
}

// Versión por grupo: cada grupo/campo guarda con su propia fecha y acumula por mes (GASTOS FIJOS)
function renderCostoGruposPorCampo(prefix, container, cfg, grupos) {
  const mes = document.getElementById('mes-pestana-' + prefix)?.value || todayStr().slice(0, 7);
  Promise.all(grupos.map(g => api('GET', '/api/costos?tipo=' + g.tipo + '&mes=' + mes))).then(lists => {
    const built = buildCostoGruposHTML(grupos, lists, prefix, false);
    const box = `<div class="autosuma-box" id="autosuma-${prefix}" data-base="${built.totalGeneral}">
      <span class="autosuma-label">TOTAL</span>
      <span class="autosuma-monto">S/ ${built.totalGeneral.toFixed(2)}</span>
    </div>`;
    const top = `<div class="costos-fecha-row">
      <label>MES</label>
      <input type="month" id="mes-pestana-${prefix}" value="${mes}" onchange="cargarCostoCategoria('${prefix}')">
    </div>
    <div style="font-size:0.75rem;color:#888;margin:-0.25rem 0 0.75rem 0;">Los montos se acumulan durante el mes y se reinician a S/ 0 el 1ro del mes siguiente.</div>`;
    container.innerHTML = top + box + built.html;
  }).catch(e => { console.error(e); container.innerHTML = '<p>Error al cargar.</p>'; });
}

// Renderiza los grupos de una pestaña (readonly = solo vista, sin agregar ni eliminar)
function buildCostoGruposHTML(grupos, lists, prefix, readonly) {
  let totalGeneral = 0;
  let html = '';
  grupos.forEach((g, gi) => {
    const list = lists[gi] || [];
    const groups = {};
    g.titulos.forEach(t => { groups[t] = []; });
    groups['OTROS'] = [];
    let subTotal = 0;
    list.forEach(c => {
      subTotal += c.monto || 0;
      let key = (c[g.campoSub] || '').toUpperCase();
      if (!groups[key]) {
        const up = (c.concepto || '').toUpperCase();
        key = g.titulos.find(t => up.includes(t)) || 'OTROS';
      }
      groups[key].push(c);
    });
    totalGeneral += subTotal;
    html += `<div class="grupo-header"><span>${g.label}</span><span class="grupo-subtotal">S/ ${subTotal.toFixed(2)}</span></div>`;
    g.titulos.forEach((t, idx) => {
      const records = groups[t].sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
      const total = records.reduce((s, r) => s + (r.monto || 0), 0);
      const rows = records.map(r => {
        const u = DISPLAY_NAMES[r.saved_by] || r.saved_by || '-';
        const colAccion = readonly ? '' : `<td><button class="danger" onclick="eliminarCostoCategoriaGrupo('${prefix}', ${gi}, '${r.id}')">✕</button></td>`;
        return `<tr>
          <td>${r[g.campoTexto] || r.concepto || '-'}</td>
          <td>${r.fecha || '-'}</td>
          <td>S/ ${(r.monto || 0).toFixed(2)}</td>
          <td>${u}</td>
          ${colAccion}
        </tr>`;
      }).join('');
      const colspan = readonly ? 4 : 5;
      const form = readonly ? '' : `<div style="margin-top:0.75rem;padding:0.75rem;background:#f9f9f9;border-radius:8px;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
        <input type="text" id="nuevo-${prefix}-g${gi}-texto-${idx}" placeholder="${g.phTexto}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;flex:1;min-width:160px;">
        <label>Fecha: <input type="date" id="nuevo-${prefix}-g${gi}-fecha-${idx}" value="${todayStr()}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></label>
        <input type="number" id="nuevo-${prefix}-g${gi}-monto-${idx}" placeholder="Monto (S/)" step="0.01" min="0" oninput="actualizarAutosuma('${prefix}')" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;width:120px;">
        <button class="btn-guardar-dia" onclick="guardarCostoGrupo('${prefix}', ${gi}, ${idx})">AGREGAR</button>
      </div>`;
      html += `<div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${t} <span style="font-weight:400;font-size:0.85rem;color:#777;">— TOTAL: S/ ${total.toFixed(2)}</span></span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          <div class="table-wrap"><table>
            <thead><tr><th>${g.colLabel}</th><th>Fecha</th><th>Monto</th><th>Usuario</th>${readonly ? '' : '<th></th>'}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${colspan}">Sin registros.</td></tr>`}</tbody>
          </table></div>
          ${form}
        </div>
      </div>`;
    });
    if (groups['OTROS'].length) html += `<p style="color:#c62828;margin-top:0.5rem;">Nota: ${groups['OTROS'].length} registro(s) sin clasificar en ${g.label}.</p>`;
  });
  return { html, totalGeneral };
}

function guardarCostoGrupo(prefix, gi, idx) {
  const cfg = CATEGORIAS_COSTOS[prefix];
  const g = cfg.grupos[gi];
  const sub = g.titulos[idx];
  const texto = document.getElementById('nuevo-' + prefix + '-g' + gi + '-texto-' + idx)?.value.trim() || sub;
  const fecha = document.getElementById('nuevo-' + prefix + '-g' + gi + '-fecha-' + idx)?.value;
  const monto = parseFloat(document.getElementById('nuevo-' + prefix + '-g' + gi + '-monto-' + idx)?.value);
  if (!fecha || isNaN(monto)) { alert('Ingresa fecha y monto'); return; }
  const body = { fecha, tipo: g.tipo, concepto: texto, monto };
  body[g.campoSub] = sub.toLowerCase();
  api('POST', '/api/costos', body).then(() => {
    showToast('Registro de ' + sub + ' guardado');
    cargarCostoCategoria(prefix);
  }).catch(e => { console.error(e); alert('Error al guardar'); });
}

function guardarTodosLosCampos(prefix) {
  const cfg = CATEGORIAS_COSTOS[prefix];
  const fecha = document.getElementById('fecha-pestana-' + prefix)?.value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  const grupos = cfg.grupos.map((g, gi) => {
    const campos = g.titulos.map((sub, idx) => {
      const texto = document.getElementById('nuevo-' + prefix + '-g' + gi + '-texto-' + idx)?.value.trim() || sub;
      const raw = document.getElementById('nuevo-' + prefix + '-g' + gi + '-monto-' + idx)?.value;
      const monto = (raw === undefined || raw === null || raw.trim() === '') ? null : Math.round((parseFloat(raw) || 0) * 100) / 100;
      return { valor: sub, concepto: texto, monto };
    });
    return { tipo: g.tipo, campoSub: g.campoSub, campos };
  });
  api('POST', '/api/costos/reemplazar', { fecha, grupos }).then(r => {
    showToast('Guardado en ' + fecha);
    cargarCostoCategoria(prefix);
  }).catch(e => { console.error(e); alert('Error al guardar: ' + (e.message || e)); });
}

function confirmarCambioFechaCosto(prefix) {
  const inp = document.getElementById('fecha-pestana-' + prefix);
  if (!inp) return;
  if (hayCambiosSinGuardar(prefix)) {
    if (!confirm('Hay montos sin guardar en la fecha anterior. ¿Cambiar de fecha y perderlos?')) {
      inp.value = inp.dataset.prev || inp.value;
      return;
    }
  }
  inp.dataset.prev = inp.value;
  cargarCostoCategoria(prefix);
}

function hayCambiosSinGuardar(prefix) {
  const inputs = document.querySelectorAll('#costos-' + prefix + '-container input[id^="nuevo-' + prefix + '"]');
  let dirty = false;
  inputs.forEach(inp => {
    const orig = inp.dataset.orig || '';
    if (String(inp.value || '') !== String(orig)) dirty = true;
  });
  return dirty;
}

function eliminarCostoCategoriaGrupo(prefix, gi, id) {
  if (!confirm('¿Eliminar este registro?')) return;
  api('DELETE', '/api/costos/' + id).then(() => cargarCostoCategoria(prefix)).catch(e => { console.error(e); alert('Error al eliminar'); });
}

function actualizarAutosuma(prefix) {
  const box = document.getElementById('autosuma-' + prefix);
  if (!box) return;
  const base = parseFloat(box.dataset.base) || 0;
  const inputs = document.querySelectorAll('#costos-' + prefix + '-container input[id^="nuevo-' + prefix + '"][id*="monto-"]');
  let suma = 0;
  inputs.forEach(inp => { const v = parseFloat(inp.value); if (!isNaN(v)) suma += v; });
  const monto = box.querySelector('.autosuma-monto');
  if (monto) monto.textContent = 'S/ ' + (base + suma).toFixed(2);
}
