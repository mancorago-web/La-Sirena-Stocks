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
  // Register service worker for PWA (auto-update on new deploy)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // Check for updates every 5 minutes while app is open
      setInterval(() => reg.update(), 300000);
      // Auto-reload when a new version activates
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    }).catch(() => {});
  }
});
document.addEventListener('click', e => {
  if (e.target.id === 'btn-salir') {
    firebase.auth().signOut();
  }
});

const _loaded = {};
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    document.getElementById('tab-' + name).classList.add('active');
    // Recargar siempre para mantener todo actualizado en cadena
    const loaders = {
      almacenes: () => cargarAlmacenes(document.getElementById('fecha-almacenes')?.value),
      ingresos: () => cargarIngresos(document.getElementById('fecha-ingresos')?.value),
      salidas: () => cargarSalidas(document.getElementById('fecha-salidas')?.value),
      ventas: () => cargarVentas(document.getElementById('fecha-ventas')?.value),
      bajas: () => cargarBajas(document.getElementById('fecha-bajas')?.value),
      stocks: () => cargarStocks(),
      reportes: () => cargarReportes(),
      precios: () => cargarPreciosAlmacen()
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
window.addEventListener('load', () => { dibujarFlujoMenu(); actualizarContadoresMenu(); });

function actualizarContadoresMenu() {
  const s = document.getElementById('menu-items-stocks');
  const b = document.getElementById('menu-items-barra');
  if (!s && !b) return;
  api('GET', '/api/resumen/items?fecha=' + todayStr()).then(r => {
    if (s) s.textContent = 'Items: ' + (r.stocks === undefined ? '—' : r.stocks);
    if (b) b.textContent = 'Items: ' + (r.barra === undefined ? '—' : r.barra);
  }).catch(() => {});
}
window.addEventListener('resize', dibujarFlujoMenu);
setTimeout(dibujarFlujoMenu, 300);

function irACategoria(cat) {
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('container').style.display = 'block';
  document.getElementById('btn-back').style.display = '';
  // Hide all tabs-bars
  document.querySelectorAll('.tabs-bar').forEach(tb => tb.style.display = 'none');
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  if (cat === 'stocks') {
    document.getElementById('tabs-bar').style.display = '';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="almacenes"]').classList.add('active');
    document.getElementById('tab-almacenes').classList.add('active');
  } else {
    const tabsEl = document.getElementById('tabs-' + cat);
    if (tabsEl) tabsEl.style.display = '';
    const tabId = cat === 'ventas' ? 'tab-ventas-central' : 'tab-' + cat;
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if (!_loaded[cat]) {
      _loaded[cat] = true;
      if (cat === 'barra') { cargarRecetas(); cargarStockBarra(); cargarPrecios(); cargarSugerenciasStock(); }
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

function itemRow(i, a) {
  return `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
    <td>${i.nombre}</td>
    <td><input type="number" class="input-num input-apertura" value="${i.stock_apertura || 0}" step="0.01" oninput="calcCierre(this)"></td>
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
  if (!fecha) fecha = document.getElementById('fecha-almacenes').value;
  getInventario(fecha).then(data => {
    // Ocultar items con stock 0 (toggle del ojo)
    if (_ocultarCero) {
      data.forEach(a => { a.items = (a.items || []).filter(i => (i.stock_apertura || 0) !== 0 || (i.stock_cierre || 0) !== 0); });
    }
    const categoriasPorAlmacen = {
      1: [
        { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
        { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
        { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
        { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|PROTOS/i.test(i.nombre) },
      ],
    };
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'KOMBUCHAS', test: i => /^KOMBUCHA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS/i.test(i.nombre) },
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
                  <tr class="section-header"><td colspan="8">— OTROS —</td></tr>
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
      calcCierre(tr.querySelector('.input-apertura'));
    });
    openIds.forEach(id => {
      const item = container.querySelector(`.accordion-item[data-almacen-id="${id}"]`);
      if (item) {
        item.querySelector('.accordion-body').classList.add('open');
        item.querySelector('.accordion-arrow').classList.add('open');
        item.querySelector('.accordion-header').classList.add('active');
      }
    });
  });
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
  await api('POST', '/api/inventario/agregar-item', { nombre, almacen_id, categoria, cantidad, nota });
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
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id === 4 || a.id === 8);
    const categoriasPorAlmacen = {};
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS/i.test(i.nombre) },
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
    container.innerHTML = data.map(a => `
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
              <thead><tr><th>Item</th><th>Stock Actual</th><th>Salida</th></tr></thead>
              <tbody>
                ${a.secciones.map(s => s.items.length ? `
                  <tr class="section-header"><td colspan="3">— ${s.label} —</td></tr>
                  ${s.items.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-salida" value="${i.salida_almacen || 0}" step="0.01"></td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-ingreso" value="${i.stock_ingreso || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`).join('')}
                ` : '').join('')}
                ${a.otros.length ? `
                  <tr class="section-header"><td colspan="3">— OTROS —</td></tr>
                  ${a.otros.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-salida" value="${i.salida_almacen || 0}" step="0.01"></td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
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
    const bs = document.getElementById('buscar-salida');
    if (bs && bs.value) buscarEnTabla(bs.value, 'accordion-salidas');
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
      registros.push({ item_id: itemId, almacen_id: almacenId, salida_almacen: salida });
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

function verDetallesSalidas() {
  const fecha = document.getElementById('fecha-salidas').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
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
      html += '<table><thead><tr><th>Item</th><th>Salida</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
      itemsConSalida.forEach(i => {
        const t = i.updated_at ? new Date(i.updated_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
        const u = DISPLAY_NAMES[i.saved_by] || i.saved_by || '-';
        html += '<tr><td>' + i.nombre + '</td><td>' + (i.salida_almacen || 0) + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
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
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id !== 3 && a.id !== 9 && a.id !== 16);
    const categoriasPorAlmacen = {};
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS/i.test(i.nombre) },
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
                  <tr class="section-header"><td colspan="3">— OTROS —</td></tr>
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
    const categoriasPorAlmacen = {};
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS/i.test(i.nombre) },
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
                  <tr class="section-header"><td colspan="4">— OTROS —</td></tr>
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
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id !== 3 && a.id !== 9 && a.id !== 16);
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS/i.test(i.nombre) },
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
              <thead><tr><th>Item</th><th>Stock Actual</th><th>Ingreso</th></tr></thead>
              <tbody>
                ${a.secciones.map(s => s.items.length ? `
                  <tr class="section-header"><td colspan="3">— ${s.label} —</td></tr>
                  ${s.items.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-ingreso" value="${i.stock_ingreso || 0}" step="0.01"></td>
                    <input type="hidden" class="hidden-cierre" value="${i.stock_cierre || 0}">
                    <input type="hidden" class="hidden-salida" value="${i.salida_almacen || 0}">
                    <input type="hidden" class="hidden-ventas" value="${i.total_ventas || 0}">
                    <input type="hidden" class="hidden-falta" value="${i.falta_almacen || 0}">
                    <input type="hidden" class="hidden-baja" value="${i.stock_baja || 0}">
                  </tr>`).join('')}
                ` : '').join('')}
                ${a.otros.length ? `
                  <tr class="section-header"><td colspan="3">— OTROS —</td></tr>
                  ${a.otros.map(i => `<tr data-item-id="${i.id}" data-almacen-id="${a.id}">
                    <td>${i.nombre}</td>
                    <td>${i.stock_apertura || 0}</td>
                    <td><input type="number" class="input-num input-ingreso" value="${i.stock_ingreso || 0}" step="0.01"></td>
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

function verDetallesIngresos() {
  const fecha = document.getElementById('fecha-ingresos').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
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
      html += '<table><thead><tr><th>Item</th><th>Ingreso</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
      itemsConIngreso.forEach(i => {
        const t = i.updated_at ? new Date(i.updated_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
        const u = DISPLAY_NAMES[i.saved_by] || i.saved_by || '-';
        html += '<tr><td>' + i.nombre + '</td><td>' + (i.stock_ingreso || 0) + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
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
  }
}

function cerrarModal() {
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
  btn.disabled = true; btn.textContent = 'Guardando...';
  const minimos = [];
  document.querySelectorAll('#accordion-stocks tr[data-item-id]').forEach(tr => {
    const itemId = parseInt(tr.dataset.itemId);
    const almacenId = parseInt(tr.dataset.almacenId);
    if (isNaN(itemId) || isNaN(almacenId)) return;
    const val = parseFloat(tr.querySelector('.input-minimo').value) || 0;
    minimos.push({ item_id: itemId, almacen_id: almacenId, cantidad_minima: val });
  });
  api('PUT', '/api/inventario/minimos', { minimos }).then(() => {
    btn.textContent = '✓ Guardado';
    setTimeout(() => { btn.disabled = false; btn.textContent = '💾 GUARDAR MINIMOS'; }, 2000);
    cargarStocks();
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR MINIMOS';
    alert('Error al guardar');
  });
}

function verReporteStocksBajos() {
  const fecha = document.getElementById('fecha-stocks').value;
  if (!fecha) { alert('Selecciona una fecha'); return; }
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id === 4 || a.id === 8);
    let html = '<h3>Productos con Stock Bajo — ' + fecha + '</h3>';
    let totalItems = 0;
    data.forEach(a => {
      const itemsBajos = a.items.filter(i => {
        const min = i.cantidad_minima || 0;
        return min > 0 && (i.stock_cierre || 0) < min;
      });
      if (!itemsBajos.length) return;
      totalItems += itemsBajos.length;
      html += '<div class="diff-almacen">';
      html += '<div class="diff-header" onclick="toggleAcordeon(this)"><span>' + a.nombre + '</span><span class="accordion-arrow">▶</span></div>';
      html += '<div class="accordion-body">';
      html += '<table><thead><tr><th>Item</th><th>Cantidad Minima</th><th>Stock Actual</th></tr></thead><tbody>';
      itemsBajos.forEach(i => {
        html += '<tr class="stock-bajo"><td>' + i.nombre + '</td><td>' + (i.cantidad_minima || 0) + '</td><td>' + (i.stock_cierre || 0) + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    if (!totalItems) {
      html += '<p>No hay productos con stock bajo.</p>';
    }
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal').style.display = 'block';
  });
}

function cargarStocks() {
  const fecha = document.getElementById('fecha-stocks').value;
  if (!fecha) return;
  getInventario(fecha).then(data => {
    data = data.filter(a => a.id === 4 || a.id === 8);
    const categoriasPorAlmacen = {
      1: [
        { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
        { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
        { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
        { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO/i.test(i.nombre) },
      ],
    };
    const defaultCategorias = [
      { label: 'LECHES', test: i => /leche/i.test(i.nombre) },
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'KOMBUCHAS', test: i => /^KOMBUCHA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONNAY|CHARDONAY|PINOT|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS/i.test(i.nombre) },
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
                <tr class="section-header"><td colspan="3">— OTROS —</td></tr>
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
// Costos: set today's date on pickers (load happens lazily in cambiarSubTab)
['fecha-costos-planillas','fecha-costos-servicios','fecha-costos-gastos'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.value = todayStr();
});
initPicker('fecha-stocks', function() { cargarStocks(); });
// reportes, precios, barra loaded lazily on first tab click
initPicker('reporte-fecha-ini');
initPicker('reporte-fecha-fin');
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
    const ordenCat = ['RECETAS BASE', 'Clásicos', 'Mojitos', 'Limonadas', 'SODAS', 'JUGO DE FRUTAS', 'DEL BARMAN', 'Chilcanos y Sours', 'SHOTS'];
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
        ${['RECETAS BASE','Clásicos','Mojitos','Limonadas','SODAS','JUGO DE FRUTAS','DEL BARMAN','Chilcanos y Sours','SHOTS'].map(c =>
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
  const tabsBar = document.getElementById('tabs-' + prefix);
  tabsBar.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  tabsBar.querySelector(`.sub-tab[data-subtab="${nombre}"]`).classList.add('active');
  // Switch content
  document.querySelectorAll('#tab-' + prefix + ' .sub-tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById('sub-' + prefix + '-' + nombre).classList.add('active');
  // Lazy load barra movement tabs
  if (prefix === 'barra' && ['ingresos','ventas','bajas'].includes(nombre)) {
    const key = 'barra_' + nombre;
    if (!_loaded[key]) { _loaded[key] = true; cargarBarraMovimientos(nombre); }
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
      if (!esHoy) {
        return `<tr data-stock-id="${s.id}">
          <td class="stock-nombre">${esc(s.ingrediente)}</td>
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
      return `<tr data-stock-id="${s.id}" data-orig-cantidad="${s.cantidad}" data-orig-unidad="${s.unidad}" data-orig-grupo="${(s.grupo || '').toUpperCase()}">
        <td class="stock-nombre">${esc(s.ingrediente)}</td>
        <td><input type="number" class="input-stock-cant" value="${s.cantidad}" step="0.01" min="0" style="width:80px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="actualizarOnzasFila(this); marcarStockDirty()"></td>
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
function cargarPreciosAlmacen() {
  const fecha = document.getElementById('fecha-almacenes')?.value || new Date().toISOString().split('T')[0];
  api('GET', '/api/precios?fecha=' + fecha).then(data => {
    const container = document.getElementById('accordion-precios');
    if (!data.length) {
      container.innerHTML = '<p>No hay items con precios.</p>';
      return;
    }
    const html = data.map(a => `
      <div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${a.almacen}</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          <div class="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Stock Actual</th><th>Precio Unidad</th><th>Total</th></tr></thead>
            <tbody>
              ${a.items.map(i => {
                const total = (i.stock_cierre || 0) * (i.precio || 0);
                return `<tr data-item-id="${i.item_id}" data-almacen-id="${a.almacen_id}">
                  <td>${i.item}</td>
                  <td>${i.stock_cierre || 0}</td>
                  <td><input type="number" class="input-precio-almacen" value="${i.precio}" step="0.01" style="width:120px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" onchange="calcularTotalPrecio(this)"></td>
                  <td class="total-precio">S/${total.toFixed(2)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    `).join('');
    container.innerHTML = html;
    const bp = document.getElementById('buscar-precio-item');
    if (bp && bp.value) buscarEnTabla(bp.value, 'accordion-precios');
  });
}

function calcularTotalPrecio(input) {
  const tr = input.closest('tr');
  const stock = parseFloat(tr.children[1].textContent) || 0;
  const precio = parseFloat(input.value) || 0;
  tr.querySelector('.total-precio').textContent = 'S/' + (stock * precio).toFixed(2);
}

function guardarPreciosAlmacen() {
  const btn = document.querySelector('#tab-precios .btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  const items = [];
  document.querySelectorAll('#accordion-precios tr[data-item-id]').forEach(tr => {
    const item_id = parseInt(tr.dataset.itemId);
    const almacen_id = parseInt(tr.dataset.almacenId);
    const precio = parseFloat(tr.querySelector('.input-precio-almacen').value) || 0;
    items.push({ item_id, almacen_id, precio });
  });
  api('PUT', '/api/precios', { precios: items }).then(() => {
    btn.textContent = '✓ Guardado';
    setTimeout(() => { btn.disabled = false; btn.textContent = '💾 GUARDAR PRECIOS'; }, 2000);
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR PRECIOS';
    alert('Error al guardar');
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

function exportarPrecios() {
  const fecha = document.getElementById('fecha-almacenes')?.value || new Date().toISOString().split('T')[0];
  const wsData = [['Almacén', 'Item', 'Stock Actual', 'Precio Unidad', 'Total']];
  document.querySelectorAll('#accordion-precios .accordion-item').forEach(item => {
    const almacen = item.querySelector('.accordion-title')?.textContent || '';
    item.querySelectorAll('tbody tr[data-item-id]').forEach(tr => {
      const celdas = tr.querySelectorAll('td');
      const nombre = celdas[0]?.textContent || '';
      const stock = celdas[1]?.textContent || '0';
      const precio = tr.querySelector('.input-precio-almacen')?.value || '0';
      const total = celdas[3]?.textContent?.replace('S/', '') || '0';
      wsData.push([almacen, nombre, stock, precio, total]);
    });
  });
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(libro, hoja, 'Precios');
  XLSX.writeFile(libro, `Precios_${fecha}.xlsx`);
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
      const ordenCat = ['RECETAS BASE', 'Clásicos', 'Mojitos', 'Limonadas', 'SODAS', 'JUGO DE FRUTAS', 'DEL BARMAN', 'Chilcanos y Sours', 'SHOTS'];
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
      let html = '<h3 style="margin:0 0 0.5rem 0;">RECETAS VENDIDAS</h3>';
      catsToRender.forEach(cat => {
        const recs = grupos[cat] || [];
        html += `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${cat}${recs.length ? ` <span style="font-weight:400;font-size:0.85rem;color:#777;">— ${recs.length} receta(s)</span>` : ''}</span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Receta</th><th>Cant. Vendida</th><th>Ingredientes</th></tr></thead>
              <tbody>
                ${recs.map(r => {
                  const qty = recQty[r.nombre] || '';
                  const ings = r.ingredientes.map(i => i.ingrediente).join(', ');
                  return `<tr data-receta="${r.nombre}" data-ingredientes='${JSON.stringify(r.ingredientes.map(i => ({ ingrediente: i.ingrediente, cantidad: i.cantidad, unidad: i.unidad })))}'>
                    <td>${r.nombre}</td>
                    <td><input type="number" class="input-barra-mov input-receta-qty" value="${qty}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="calcularItemsSalientes()"></td>
                    <td style="font-size:0.8rem;color:#666;">${ings}</td>
                  </tr>`;
                }).join('') || '<tr><td colspan="3" style="color:#888;">Sin recetas aún.</td></tr>'}
              </tbody>
            </table></div>
          </div>
        </div>`;
      });
      // ITEMS SALIENTES section
      html += '<div id="items-salientes-section"><h3 style="margin:1rem 0 0.5rem 0;">ITEMS SALIENTES</h3>';
      const ingSaved = movs.filter(m => m.es_receta === false);
      if (ingSaved.length) {
        const unitMap = {};
        recetas.forEach(r => (r.ingredientes || []).forEach(i => {
          const k = String(i.ingrediente || '').trim().toUpperCase().replace(/\s+/g, ' ');
          if (k && !unitMap[k]) unitMap[k] = i.unidad || 'unidad';
        }));
        const agg = {};
        const units = {};
        ingSaved.forEach(m => {
          const key = String(m.ingrediente || '').trim().toUpperCase().replace(/\s+/g, ' ');
          agg[key] = (agg[key] || 0) + (parseFloat(m.cantidad) || 0);
          units[key] = unitMap[key] || m.unidad || 'unidad';
        });
        const keys = Object.keys(agg).sort();
        html += '<div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Cantidad Consumida</th><th>Unidad</th></tr></thead><tbody>';
        keys.forEach(key => {
          html += `<tr><td>${key}</td><td>${(agg[key] || 0).toFixed(2)}</td><td>${units[key] || 'unidad'}</td></tr>`;
        });
        html += '</tbody></table></div>';
      } else {
        html += '<p style="color:#888;">Calculado automáticamente al ingresar cantidades de recetas.</p>';
      }
      html += '</div>';
      container.innerHTML = html;
      const bp = document.getElementById('buscar-barra-ventas');
      if (bp && bp.value) buscarTablaBarra(bp.value, accId, 'tr[data-receta]');
    });
  } else {
    // INGRESOS / BAJAS: show barra_precios items
    Promise.all([
      api('GET', '/api/barra/precios'),
      api('GET', '/api/barra/movimientos?fecha=' + fecha + '&tipo=' + tipo)
    ]).then(([precios, movs]) => {
      const movByIng = {};
      movs.forEach(m => { movByIng[m.ingrediente] = m; });
      const container = document.getElementById(accId);
      if (!precios.length) { container.innerHTML = '<p>No hay items en BASE DE DATOS.</p>'; return; }
      container.innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th></tr></thead>
          <tbody>
            ${precios.map(p => {
              const mov = movByIng[p.ingrediente] || {};
              const uc = p.unidad_compra || p.unidad || 'unidad';
              return `<tr data-ing="${p.ingrediente}" data-uni-compra="${uc}">
                <td>${p.ingrediente}</td>
                <td><input type="number" class="input-barra-mov" value="${mov.cantidad || ''}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
                <td>${uc}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>`;
      const bp = document.getElementById('buscar-barra-' + tipo);
      if (bp && bp.value) buscarEnTabla(bp.value, accId);
    });
  }
}

function guardarBarraMovimientos(tipo) {
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
        items.push({ ingrediente: tr.dataset.ing, cantidad: cant, unidad: tr.dataset.uniCompra || 'unidad' });
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
  const label = tipo === 'ingresos' ? 'Ingresos' : tipo === 'ventas' ? 'Ventas' : 'Bajas';
  api('GET', '/api/barra/movimientos?fecha=' + fecha + '&tipo=' + tipo).then(movs => {
    let html = '<h3>Detalle de ' + label + ' Barra — ' + fecha + '</h3>';
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
        html += '<table><thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Usuario</th><th>Hora</th></tr></thead><tbody>';
        movs.forEach(m => {
          const t = m.created_at ? new Date(m.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
          const u = DISPLAY_NAMES[m.saved_by] || m.saved_by || '-';
          html += '<tr><td>' + m.ingrediente + '</td><td>' + (m.cantidad || 0) + '</td><td>' + u + '</td><td>' + t + '</td></tr>';
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
    seccion.innerHTML = '<h3 style="margin:1rem 0 0.5rem 0;">ITEMS SALIENTES</h3><p style="color:#888;">Calculado automáticamente al ingresar cantidades de recetas.</p>';
    return;
  }
  seccion.innerHTML = '<h3 style="margin:1rem 0 0.5rem 0;">ITEMS SALIENTES</h3><div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Cantidad Consumida</th><th>Unidad</th></tr></thead><tbody>' +
    names.map(n => '<tr><td>' + n + '</td><td>' + (totals[n] || 0).toFixed(2) + '</td><td>' + (units[n] || 'unidad') + '</td></tr>').join('') +
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
      return `<tr><td>${esc(r.nombre)}</td><td>${r.cantidad}</td><td>${esc(det)}</td><td>${t}</td><td>${esc(r.saved_by || '-')}</td><td><button class="danger" onclick="confirmarEliminarCompra('${r.id}')">✕</button></td></tr>`;
    }).join('');
    c.innerHTML = '<h3 style="margin:0 0 0.5rem 0;">DETALLE DE COMPRAS/INGRESOS</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Cantidad</th><th>Destino</th><th>Hora</th><th>Usuario</th><th></th></tr></thead><tbody>' +
      filas + '</tbody></table></div>';
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
  api('GET', '/api/almacenes').then(alms => {
    ventasAlmacenes = alms || [];
    renderVentasAlmacenes(ventasAlmacenes.map(a => ({ id: Number(a.id), nombre: a.nombre, cantidad: null })));
  }).catch(() => {});
  onCambiarDestinoVenta();
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

function agregarCompra() {
  const nombre = document.getElementById('nueva-compra-input').value.trim();
  const cantidad = parseFloat(document.getElementById('nueva-compra-cant').value);
  const destino = document.getElementById('nueva-compra-destino').value;
  if (!nombre || isNaN(cantidad) || cantidad <= 0) { alert('Ingresa un item y una cantidad'); return; }
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
  api('POST', '/api/compras/guardar', { fecha, items: [{ nombre, cantidad, unidad: 'unidad', destino, almacenes, muebles }] }).then(r => {
    if (btn) btn.disabled = false;
    const res = r.resumen || {};
    let msg = 'Compra registrada: ' + nombre + ' x' + cantidad;
    if (res.noEncontrados && res.noEncontrados.length) msg += ' (no encontrado)';
    showToast(msg);
    document.getElementById('nueva-compra-input').value = '';
    document.getElementById('nueva-compra-cant').value = '';
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
        label: p.label, titulosDoc: p.titulosDoc, grupos: p.grupos || null, fechaGlobal: p.fechaGlobal === true
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
  api('GET', '/api/costos?tipo=' + cfg.tipo).then(list => {
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
    const totalGeneral = list.reduce((s, r) => s + (r.monto || 0), 0);
    let html = `<div class="autosuma-box" id="autosuma-${prefix}" data-base="${totalGeneral}">
      <span class="autosuma-label">TOTAL</span>
      <span class="autosuma-monto">S/ ${totalGeneral.toFixed(2)}</span>
    </div>`;
    cfg.titulos.forEach((t, idx) => {
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

// Versión por grupo: cada grupo/campo guarda con su propia fecha (GASTOS FIJOS)
function renderCostoGruposPorCampo(prefix, container, cfg, grupos) {
  Promise.all(grupos.map(g => api('GET', '/api/costos?tipo=' + g.tipo))).then(lists => {
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
          return `<tr>
            <td>${r[g.campoTexto] || r.concepto || '-'}</td>
            <td>${r.fecha || '-'}</td>
            <td>S/ ${(r.monto || 0).toFixed(2)}</td>
            <td>${u}</td>
            <td><button class="danger" onclick="eliminarCostoCategoriaGrupo('${prefix}', ${gi}, '${r.id}')">✕</button></td>
          </tr>`;
        }).join('');
        html += `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${t} <span style="font-weight:400;font-size:0.85rem;color:#777;">— TOTAL: S/ ${total.toFixed(2)}</span></span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>${g.colLabel}</th><th>Fecha</th><th>Monto</th><th>Usuario</th><th></th></tr></thead>
              <tbody>${rows || '<tr><td colspan="5">Sin registros.</td></tr>'}</tbody>
            </table></div>
            <div style="margin-top:0.75rem;padding:0.75rem;background:#f9f9f9;border-radius:8px;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
              <input type="text" id="nuevo-${prefix}-g${gi}-texto-${idx}" placeholder="${g.phTexto}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;flex:1;min-width:160px;">
              <label>Fecha: <input type="date" id="nuevo-${prefix}-g${gi}-fecha-${idx}" value="${todayStr()}" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></label>
              <input type="number" id="nuevo-${prefix}-g${gi}-monto-${idx}" placeholder="Monto (S/)" step="0.01" min="0" oninput="actualizarAutosuma('${prefix}')" style="padding:0.3rem;border:1px solid #ccc;border-radius:4px;width:120px;">
              <button class="btn-guardar-dia" onclick="guardarCostoGrupo('${prefix}', ${gi}, ${idx})">AGREGAR</button>
            </div>
          </div>
        </div>`;
      });
      if (groups['OTROS'].length) html += `<p style="color:#c62828;margin-top:0.5rem;">Nota: ${groups['OTROS'].length} registro(s) sin clasificar en ${g.label}.</p>`;
    });
    const box = `<div class="autosuma-box" id="autosuma-${prefix}" data-base="${totalGeneral}">
      <span class="autosuma-label">TOTAL</span>
      <span class="autosuma-monto">S/ ${totalGeneral.toFixed(2)}</span>
    </div>`;
    container.innerHTML = box + html;
  }).catch(e => { console.error(e); container.innerHTML = '<p>Error al cargar.</p>'; });
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
