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
    await fetch('/api/migrate/fix-receta-ingredientes', opts).catch(() => {});
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
    if (_loaded[name]) return;
    _loaded[name] = true;
    if (name === 'reportes') cargarReportes();
    if (name === 'precios') cargarPreciosAlmacen();
  });
});

// --- Navigation: main menu / categories ---
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
    document.getElementById('tabs-' + cat).style.display = '';
    document.getElementById('tab-' + cat).classList.add('active');
    if (!_loaded[cat]) {
      _loaded[cat] = true;
      if (cat === 'barra') { cargarRecetas(); cargarStockBarra(); cargarPrecios(); }
    }
    // Activate first sub-tab for the category
    const firstSub = document.querySelector('#tabs-' + cat + ' .sub-tab');
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
  'MANTGRAS DE VINE RESERVE CARBERNET SAUVIGNON 2023',
  'CRODERO DI MONTEZEMOLO 2023',
  'MALAJUNTA RESERVA MALBEC 2024',
  'MALAJUNTA RESERVA MALBEC 2023',
  'MALAJUNTA RESERVA CABERNET FRANC 2022',
  'MANTGRAS QUATRO TINTO 2021',
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
    <td></td>
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
    const categoriasPorAlmacen = {
      1: [
        { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
        { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
        { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
        { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO/i.test(i.nombre) },
      ],
    };
    const defaultCategorias = [
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'KOMBUCHAS', test: i => /^KOMBUCHA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MANTGRAS/i.test(i.nombre) },
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
      const otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
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

function agregarItemAlmacen(almacenId, almacenNombre) {
  showModal('item-almacen', { almacenId, almacenNombre });
}

async function guardarItemAlmacen() {
  const item_id = parseInt(document.getElementById('f-item_id').value);
  const almacen_id = parseInt(document.getElementById('f-almacen_id').value);
  const cantidad = parseFloat(document.getElementById('f-cantidad').value) || 0;
  const nota = document.getElementById('f-nota').value || 'Agregado desde almacén';
  if (!item_id) { alert('Selecciona un item'); return; }
  await api('POST', '/api/inventario/ajustar', { item_id, almacen_id, cantidad, nota });
  cerrarModal();
  cargarAlmacenes();
  cargarReportes();
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
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MANTGRAS/i.test(i.nombre) },
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
      const otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
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
      const celdas = tr.querySelectorAll('td');
      const apertura = parseFloat(celdas[1]?.textContent) || 0;
      const salida = parseFloat(tr.querySelector('.input-salida').value) || 0;
      const ventas = parseFloat(tr.querySelector('.hidden-ventas')?.value) || 0;
      const ingreso = parseFloat(tr.querySelector('.hidden-ingreso')?.value) || 0;
      const falta = parseFloat(tr.querySelector('.hidden-falta')?.value) || 0;
      const baja = parseFloat(tr.querySelector('.hidden-baja')?.value) || 0;
      const cierre = apertura + ingreso - salida - ventas - falta - baja;
      registros.push({
        item_id: itemId,
        almacen_id: almacenId,
        stock_apertura: apertura,
        stock_ingreso: ingreso,
        salida_almacen: salida,
        total_ventas: ventas,
        falta_almacen: falta,
        stock_baja: baja,
        stock_cierre: cierre,
      });
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
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MANTGRAS/i.test(i.nombre) },
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
      const otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
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
      const celdas = tr.querySelectorAll('td');
      const apertura = parseFloat(celdas[1]?.textContent) || 0;
      const salida = parseFloat(tr.querySelector('.hidden-salida')?.value) || 0;
      const ventas = parseFloat(tr.querySelector('.input-ventas').value) || 0;
      const ingreso = parseFloat(tr.querySelector('.hidden-ingreso')?.value) || 0;
      const falta = parseFloat(tr.querySelector('.hidden-falta')?.value) || 0;
      const baja = parseFloat(tr.querySelector('.hidden-baja')?.value) || 0;
      const cierre = apertura + ingreso - salida - ventas - falta - baja;
      registros.push({
        item_id: itemId,
        almacen_id: almacenId,
        stock_apertura: apertura,
        stock_ingreso: ingreso,
        salida_almacen: salida,
        total_ventas: ventas,
        falta_almacen: falta,
        stock_baja: baja,
        stock_cierre: cierre,
      });
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
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MANTGRAS/i.test(i.nombre) },
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
      const otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
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
      const celdas = tr.querySelectorAll('td');
      const apertura = parseFloat(celdas[1]?.textContent) || 0;
      const baja = parseFloat(tr.querySelector('.input-baja').value) || 0;
      const ingreso = parseFloat(tr.querySelector('.hidden-ingreso')?.value) || 0;
      const salida = parseFloat(tr.querySelector('.hidden-salida')?.value) || 0;
      const ventas = parseFloat(tr.querySelector('.hidden-ventas')?.value) || 0;
      const falta = parseFloat(tr.querySelector('.hidden-falta')?.value) || 0;
      const nota_baja = tr.querySelector('.hidden-nota-baja')?.value || '';
      const cierre = apertura + ingreso - salida - ventas - falta - baja;
      registros.push({
        item_id: itemId,
        almacen_id: almacenId,
        stock_apertura: apertura,
        stock_ingreso: ingreso,
        salida_almacen: salida,
        total_ventas: ventas,
        falta_almacen: falta,
        stock_baja: baja,
        nota_baja: nota_baja,
        stock_cierre: cierre,
      });
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
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MANTGRAS/i.test(i.nombre) },
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
      const otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_apertura || 0) > 0 ? 0 : 1;
        const yg = (y.stock_apertura || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
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
      const celdas = tr.querySelectorAll('td');
      const apertura = parseFloat(celdas[1]?.textContent) || 0;
      const ingreso = parseFloat(tr.querySelector('.input-ingreso').value) || 0;
      const salida = parseFloat(tr.querySelector('.hidden-salida')?.value) || 0;
      const ventas = parseFloat(tr.querySelector('.hidden-ventas')?.value) || 0;
      const falta = parseFloat(tr.querySelector('.hidden-falta')?.value) || 0;
      const baja = parseFloat(tr.querySelector('.hidden-baja')?.value) || 0;
      const cierre = apertura + ingreso - salida - ventas - falta - baja;
      registros.push({
        item_id: itemId,
        almacen_id: almacenId,
        stock_apertura: apertura,
        stock_ingreso: ingreso,
        salida_almacen: salida,
        total_ventas: ventas,
        falta_almacen: falta,
        stock_baja: baja,
        stock_cierre: cierre,
      });
    });
  });
  const btn = document.querySelector('#tab-ingresos .btn-guardar-dia');
  btn.disabled = true; btn.textContent = 'Guardando...';
  api('POST', '/api/almacenes/guardar-dia', { fecha, registros, saved_by: currentUserName }).then(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR INGRESOS';
    showToast('Ingreso Guardado');
    recargarTodo(fecha);
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
  const picker = document.getElementById('reporte-fecha-dif');
  if (picker) {
    if (!picker.value) picker.value = todayStr();
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
      <label>Item
        <select id="f-item_id"><option value="">Cargando...</option></select>
      </label>
      <label>Cantidad <input type="number" id="f-cantidad" value="0" min="0" step="0.01"></label>
      <label>Nota <textarea id="f-nota" placeholder="Opcional"></textarea></label>
      <input type="hidden" id="f-almacen_id" value="${data.almacenId}">
      <button onclick="guardarItemAlmacen()">Guardar</button>
    `;
    api('GET', '/api/items').then(items => {
      const sel = document.getElementById('f-item_id');
      sel.innerHTML = '<option value="">Seleccionar item...</option>' +
        items.map(i => `<option value="${i.id}">${i.nombre}</option>`).join('');
    });
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
  const items = [];
  document.querySelectorAll('#accordion-stocks tr[data-item-id]').forEach(tr => {
    const invId = parseInt(tr.dataset.invId);
    const val = parseFloat(tr.querySelector('.input-minimo').value) || 0;
    items.push({ id: invId, cantidad_minima: val });
  });
  const botellas = [];
  document.querySelectorAll('.input-fecha-apertura').forEach(inp => {
    const tr = inp.closest('tr');
    if (!tr) return;
    const idx = parseInt(inp.dataset.idx);
    const fecha_apertura = inp.value || null;
    botellas.push({ item_id: botellasData[idx].item_id, almacen_id: botellasData[idx].almacen_id, fecha_apertura });
  });
  api('PUT', '/api/inventario/minimos', { items, botellas }).then(() => {
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
        return min > 0 && (i.stock_cierre || 0) <= min;
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
        { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO/i.test(i.nombre) },
      ],
    };
    const defaultCategorias = [
      { label: 'LECHES', test: i => /leche/i.test(i.nombre) },
      { label: 'AGUAS', test: i => /^AGUA\s/i.test(i.nombre) },
      { label: 'GASEOSAS', test: i => /COCA|INKA/i.test(i.nombre) },
      { label: 'KOMBUCHAS', test: i => /^KOMBUCHA/i.test(i.nombre) },
      { label: 'CERVEZAS', test: i => /CUSQUE|CORONA|HEINEKEN|PILSEN|^CERVEZA/i.test(i.nombre) },
      { label: 'VINOS', test: i => /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MANTGRAS/i.test(i.nombre) },
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
      const otros = a.items.filter(i => !usado.has(i.id)).sort((x, y) => {
        const xg = (x.stock_cierre || 0) > 0 ? 0 : 1;
        const yg = (y.stock_cierre || 0) > 0 ? 0 : 1;
        return xg - yg || x.nombre.localeCompare(y.nombre);
      });
      return { ...a, secciones, otros };
    });
    const container = document.getElementById('accordion-stocks');
    const html = data.map(a => {
      const renderItems = items => items.map(i => {
        const cierre = i.stock_cierre || 0;
        const minima = i.cantidad_minima || 0;
        const bajo = minima > 0 && cierre <= minima;
        return `<tr data-item-id="${i.id}" data-inv-id="${i.inv_id}" class="${bajo ? 'stock-bajo' : ''}">
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
  const fecha = document.getElementById('reporte-fecha-dif')?.value;
  if (!fecha) return;
  api('GET', '/api/reportes/diferencias?fecha=' + fecha).then(data => {
    if (data.length === 0) {
      document.getElementById('reporte-diferencias').innerHTML = '<p>Sin diferencias en esta fecha.</p>';
      return;
    }
    const conFalta = data.filter(r => (r.falta_almacen || 0) > 0);
    const sinFalta = data.filter(r => !((r.falta_almacen || 0) > 0));
    let html = renderReporteTabla(conFalta, 'PRODUCTOS CON FALTA');
    html += renderReporteTabla(sinFalta, 'PRODUCTOS SIN FALTA');
    if (!html) html = '<p>Sin diferencias en esta fecha.</p>';
    document.getElementById('reporte-diferencias').innerHTML = html;
  });
}

function buscarTablaBarra(q, containerId, rowSelector) {
  const term = q.trim().toLowerCase();
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll(rowSelector).forEach(tr => {
    const name = tr.children[0]?.textContent?.toLowerCase() || '';
    tr.style.display = !term || name.includes(term) ? '' : 'none';
  });
}

function buscarReceta(q) {
  const term = q.trim().toLowerCase();
  document.querySelectorAll('#recetas-container .accordion-item').forEach(item => {
    const title = item.querySelector('.accordion-title')?.textContent?.toLowerCase() || '';
    item.style.display = !term || title.includes(term) ? '' : 'none';
  });
  document.querySelectorAll('#recetas-container .categoria-recetas').forEach(cat => {
    const visible = Array.from(cat.querySelectorAll('.accordion-item')).some(it => it.style.display !== 'none');
    cat.style.display = visible || !term ? '' : 'none';
  });
}

function buscarEnTabla(term, containerId) {
  const q = term.trim().toLowerCase();
  document.querySelectorAll('#' + containerId + ' .accordion-item').forEach(item => {
    let visible = false;
    item.querySelectorAll('tr[data-item-id]').forEach(tr => {
      const name = tr.children[0]?.textContent?.toLowerCase() || '';
      const match = !q || name.includes(q);
      tr.style.display = match ? '' : 'none';
      if (match) visible = true;
    });
    item.style.display = visible || !q ? '' : 'none';
  });
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
        const cierre = celdas[6]?.querySelector('input')?.value || '0';
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
      const cierre = celdas[6]?.querySelector('input')?.value || '0';
      wsData.push([seccion, nombre, apertura, ingreso, salida, ventas, falta, cierre]);
    }
  });
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(libro, hoja, almacen.slice(0, 31));
  XLSX.writeFile(libro, `${almacen}_${fecha}.xlsx`);
}

function exportarDiferencias() {
  const fecha = document.getElementById('reporte-fecha-dif')?.value;
  if (!fecha) return;
  api('GET', '/api/reportes/diferencias?fecha=' + fecha).then(data => {
    const wsData = [['Almacén', 'Item', 'Apertura', 'Ingreso', 'Salidas', 'Ventas', 'Falta', 'Cierre', 'Diferencia', 'Estado']];
    data.forEach(r => {
      const f = r.falta_almacen || 0;
      const estado = f > 0 ? 'FALTA' : 'OK';
      wsData.push([r.almacen_nombre, r.nombre, r.stock_apertura, r.stock_ingreso || 0, r.salida_almacen || 0, r.total_ventas || 0, f, r.stock_cierre, r.diferencia, estado]);
    });
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(libro, hoja, 'Diferencias');
    XLSX.writeFile(libro, `Diferencias_${fecha}.xlsx`);
  });
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

function initPicker(id, fn) {
  const el = document.getElementById(id);
  if (el) {
    el.value = todayStr();
    if (fn) fn(el.value);
  }
}
initPicker('fecha-almacenes', cargarAlmacenes);
initPicker('fecha-salidas', cargarSalidas);
initPicker('fecha-ventas', cargarVentas);
initPicker('fecha-bajas', cargarBajas);
initPicker('fecha-ingresos', cargarIngresos);
// Barra: just set today's date, actual load happens via lazy-load in cambiarSubTab
['fecha-barra-ingresos','fecha-barra-ventas','fecha-barra-bajas'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.value = todayStr();
});
initPicker('fecha-stocks', function() { cargarStocks(); });
// reportes, precios, barra loaded lazily on first tab click
initPicker('reporte-fecha-dif');
window.addEventListener('click', e => { if (e.target === document.getElementById('modal')) cerrarModal(); });

// --- BARRA: Recetas ---
function renderReceta(r) {
  const costoTotal = r.costoTotal || 0;
  return `<div class="accordion-item" data-receta-id="${r.id}">
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
            return `<tr data-ing-id="${ing.id}">
              <td>${ing.ingrediente}</td>
              <td>${ing.cantidad}</td>
              <td>${ing.unidad}</td>
              <td>${ing.precioMatch ? 'S/' + pu.toFixed(2) : '—'}</td>
              <td>${ing.precioMatch ? 'S/' + pt.toFixed(2) : '—'}</td>
              <td><button class="danger" onclick="eliminarIngrediente(${ing.id})">✕</button></td>
            </tr>`;
          }).join('')}
          ${costoTotal > 0 ? `
          <tr style="font-weight:700;background:#f0f0ff">
            <td colspan="4">COSTO TOTAL</td>
            <td>S/${costoTotal.toFixed(2)}</td>
            <td></td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>`;
}

function cargarRecetas() {
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
    const ordenCat = ['RECETAS BASE', 'Clásicos', 'Mojitos', 'Limonadas', 'DEL BARMAN', 'Chilcanos y Sours'];
    let html = '';
    const catsToRender = [...ordenCat.filter(c => grupos[c]), ...Object.keys(grupos).filter(c => !ordenCat.includes(c))];
    catsToRender.forEach(cat => {
      html += `<div class="accordion-item">
        <div class="accordion-header" onclick="toggleAcordeon(this)">
          <span class="accordion-title">${cat}</span>
          <span class="accordion-arrow">▶</span>
        </div>
        <div class="accordion-body">
          ${grupos[cat].map(r => renderReceta(r)).join('')}
        </div>
      </div>`;
    });
    container.innerHTML = html;
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
        ${['RECETAS BASE','Clásicos','Mojitos','Limonadas','DEL BARMAN','Chilcanos y Sours'].map(c =>
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
    cargarRecetas();
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

function eliminarIngrediente(id) {
  if (!confirm('¿Eliminar este ingrediente?')) return;
  api('DELETE', '/api/receta-ingredientes/' + id).then(() => cargarRecetas());
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
}

// --- BARRA: Stock ---
function cargarStockBarra() {
  api('GET', '/api/barra/stock').then(data => {
    const container = document.getElementById('barra-stock-container');
    if (!data.length) {
      container.innerHTML = '<p>No hay ingredientes en stock. Agrega uno nuevo.</p>';
      return;
    }
    container.innerHTML = `
      <div class="table-wrap">
      <table>
        <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th><th></th></tr></thead>
        <tbody>
          ${data.map(s => `
            <tr data-stock-id="${s.id}">
              <td>${s.ingrediente}</td>
              <td><input type="number" class="input-stock-cant" value="${s.cantidad}" step="0.01" style="width:80px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" onchange="actualizarStockCant(${s.id}, this)"></td>
              <td>${s.unidad}</td>
              <td><button class="danger" onclick="eliminarStockBarra(${s.id})">✕</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `;
  });
}

function agregarStockBarra() {
  const ingrediente = document.getElementById('nuevo-stock-input').value.trim();
  const cantidad = parseFloat(document.getElementById('nuevo-stock-cant').value) || 0;
  const unidad = document.getElementById('nuevo-stock-uni').value;
  if (!ingrediente) { alert('Ingresa el nombre del ingrediente'); return; }
  api('POST', '/api/barra/stock', { ingrediente, cantidad, unidad: normalizeUnit(unidad) }).then(() => {
    document.getElementById('nuevo-stock-input').value = '';
    document.getElementById('nuevo-stock-cant').value = '';
    cargarStockBarra();
  }).catch(() => alert('Error al agregar'));
}

function eliminarStockBarra(id) {
  if (!confirm('¿Eliminar este ingrediente del stock?')) return;
  api('DELETE', '/api/barra/stock/' + id).then(() => cargarStockBarra());
}

function actualizarStockCant(id, el) {
  const cantidad = parseFloat(el.value) || 0;
  api('PUT', '/api/barra/stock/' + id, { cantidad }).catch(() => alert('Error al actualizar'));
}

// --- BARRA: Base de Datos (precios) ---
function cargarPrecios() {
  api('GET', '/api/barra/precios').then(data => {
    const container = document.getElementById('barra-precios-container');
    if (!data.length) {
      container.innerHTML = '<p>No hay ingredientes en la base de datos. Agrega uno nuevo.</p>';
      return;
    }
    container.innerHTML = `
      <div class="table-wrap">
      <table>
        <thead><tr><th>Ingrediente</th><th>Unidad</th><th>Precio</th><th></th></tr></thead>
        <tbody>
          ${data.map(s => `
            <tr data-precio-id="${s.id}">
              <td>${s.ingrediente}</td>
              <td>${s.unidad}</td>
              <td><input type="number" class="input-precio-val" value="${s.precio}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" onchange="actualizarPrecio(${s.id}, this)"></td>
              <td><button class="danger" onclick="eliminarPrecio(${s.id})">✕</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `;
  });
}

function agregarPrecio() {
  const ingrediente = document.getElementById('nuevo-precio-input').value.trim();
  const unidad = document.getElementById('nuevo-precio-uni').value;
  const precio = parseFloat(document.getElementById('nuevo-precio-precio').value) || 0;
  if (!ingrediente) { alert('Ingresa el nombre del ingrediente'); return; }
  api('POST', '/api/barra/precios', { ingrediente, unidad, precio }).then(() => {
    document.getElementById('nuevo-precio-input').value = '';
    document.getElementById('nuevo-precio-precio').value = '';
    cargarPrecios();
  }).catch(() => alert('Error al agregar'));
}

function eliminarPrecio(id) {
  if (!confirm('¿Eliminar este ingrediente de la base de datos?')) return;
  api('DELETE', '/api/barra/precios/' + id).then(() => cargarPrecios());
}

function actualizarPrecio(id, el) {
  const precio = parseFloat(el.value) || 0;
  api('PUT', '/api/barra/precios/' + id, { precio }).catch(() => alert('Error al actualizar'));
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
  api('PUT', '/api/precios', { items }).then(() => {
    btn.textContent = '✓ Guardado';
    setTimeout(() => { btn.disabled = false; btn.textContent = '💾 GUARDAR PRECIOS'; }, 2000);
  }).catch(() => {
    btn.disabled = false; btn.textContent = '💾 GUARDAR PRECIOS';
    alert('Error al guardar');
  });
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
      const ordenCat = ['RECETAS BASE', 'Clásicos', 'Mojitos', 'Limonadas', 'DEL BARMAN', 'Chilcanos y Sours'];
      const recetasGuardadas = movs.filter(m => m.es_receta !== false);
      const recQty = {};
      recetasGuardadas.forEach(m => { recQty[m.ingrediente] = m.cantidad; });
      const grupos = {};
      recetas.forEach(r => {
        const cat = r.categoria || 'Clásicos';
        if (!grupos[cat]) grupos[cat] = [];
        grupos[cat].push(r);
      });
      const catsToRender = [...ordenCat.filter(c => grupos[c]), ...Object.keys(grupos).filter(c => !ordenCat.includes(c))];
      const container = document.getElementById(accId);
      if (!recetas.length) { container.innerHTML = '<p>No hay recetas registradas.</p>'; return; }
      let html = '<h3 style="margin:0 0 0.5rem 0;">RECETAS VENDIDAS</h3>';
      catsToRender.forEach(cat => {
        html += `<div class="accordion-item">
          <div class="accordion-header" onclick="toggleAcordeon(this)">
            <span class="accordion-title">${cat}</span>
            <span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <div class="table-wrap"><table>
              <thead><tr><th>Receta</th><th>Cant. Vendida</th><th>Ingredientes</th></tr></thead>
              <tbody>
                ${grupos[cat].map(r => {
                  const qty = recQty[r.nombre] || '';
                  const ings = r.ingredientes.map(i => i.ingrediente).join(', ');
                  return `<tr data-receta="${r.nombre}" data-ingredientes='${JSON.stringify(r.ingredientes.map(i => ({ ingrediente: i.ingrediente, cantidad: i.cantidad, unidad: i.unidad })))}'>
                    <td>${r.nombre}</td>
                    <td><input type="number" class="input-barra-mov input-receta-qty" value="${qty}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;" oninput="calcularItemsSalientes()"></td>
                    <td style="font-size:0.8rem;color:#666;">${ings}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table></div>
          </div>
        </div>`;
      });
      // ITEMS SALIENTES section
      html += '<div id="items-salientes-section"><h3 style="margin:1rem 0 0.5rem 0;">ITEMS SALIENTES</h3>';
      const ingSaved = movs.filter(m => m.es_receta === false);
      if (ingSaved.length) {
        html += '<div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Cantidad Consumida</th><th>Unidad</th></tr></thead><tbody>';
        ingSaved.forEach(m => {
          html += `<tr><td>${m.ingrediente}</td><td>${m.cantidad || 0}</td><td>${m.unidad || 'unidad'}</td></tr>`;
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
              return `<tr data-ing="${p.ingrediente}">
                <td>${p.ingrediente}</td>
                <td><input type="number" class="input-barra-mov" value="${mov.cantidad || ''}" step="0.01" style="width:100px;padding:0.3rem;border:1px solid #ccc;border-radius:4px;"></td>
                <td>${p.unidad || 'unidad'}</td>
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
    }).catch(e => { console.error(e); alert('Error al guardar'); });
  } else {
    const items = [];
    document.querySelectorAll('#accordion-barra-' + tipo + ' tr[data-ing]').forEach(tr => {
      const cant = parseFloat(tr.querySelector('.input-barra-mov').value) || 0;
      if (cant > 0) {
        items.push({ ingrediente: tr.dataset.ing, cantidad: cant, unidad: 'unidad' });
      }
    });
    api('POST', '/api/barra/movimientos', { fecha, tipo, items }).then(() => {
      showToast(tipo === 'ingresos' ? 'Ingreso Guardado' : 'Baja Guardada');
      cargarBarraMovimientos(tipo);
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
        const name = ing.ingrediente;
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
