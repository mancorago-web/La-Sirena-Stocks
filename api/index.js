const admin = require('firebase-admin');
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Versión de caché automática: cambia cada vez que app.js o style.css cambien.
// Así todos los navegadores/dispositivos cargan siempre el código actual (sin caché vieja).
function computeCacheVersion() {
  try {
    const a = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'));
    const c = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'));
    return crypto.createHash('sha1').update(a).update(c).digest('hex').slice(0, 8);
  } catch (e) {
    return '1';
  }
}

console.log('=== Sirena API starting ===');
console.log('CWD:', process.cwd());
console.log('__dirname:', __dirname);
console.log('FIREBASE_SERVICE_ACCOUNT env present:', !!process.env.FIREBASE_SERVICE_ACCOUNT);

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      console.log('FIREBASE_SERVICE_ACCOUNT length:', raw.length);
      return JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env:', e.message);
      throw e;
    }
  }
  const localPath = path.join(__dirname, '..', 'service-account.json');
  console.log('Loading service account from local file:', localPath);
  return require(localPath);
}

let db;
try {
  const serviceAccount = loadServiceAccount();
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  db = admin.firestore();
  console.log('Firebase initialized successfully');
} catch (e) {
  console.error('FATAL: Firebase initialization failed:', e.message, e.stack);
  // Create minimal Express app that shows error
  const app = express();
  app.get('*', (req, res) => {
    res.status(500).send('Error de configuración: Firebase no se pudo inicializar. Verifica la variable FIREBASE_SERVICE_ACCOUNT en Vercel.');
  });
// --- DEBUG: check fallback data ---
app.get('/api/debug/fallback', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
  const snap = await col('inventario_diario').where('fecha', '==', fecha).get();
  const info = { fecha, hasData: !snap.empty, count: snap.docs.length, walks: [] };
  let prev = new Date(fecha + 'T12:00:00');
  for (let tries = 0; tries < 10; tries++) {
    prev.setDate(prev.getDate() - 1);
    const prevStr = prev.toISOString().split('T')[0];
    const prevSnap = await col('inventario_diario').where('fecha', '==', prevStr).get();
    const entry = { fecha: prevStr, hasData: !prevSnap.empty, count: prevSnap.docs.length };
    if (!prevSnap.empty) {
      entry.someCierreGT0 = prevSnap.docs.some(d => (d.data().stock_cierre || 0) > 0);
      // Find gas butano (item_id=66, almacen_id=4)
      const gas = prevSnap.docs.find(d => d.data().item_id === 66 && d.data().almacen_id === 4);
      entry.gasButano = gas ? gas.data() : null;
      info.walks.push(entry);
      break;
    }
    info.walks.push(entry);
  }
  res.json(info);
});

module.exports = app;
  return;
}

const app = express();

app.use(express.json());
// No-cache para archivos estaticos (app.js, style.css) para evitar versiones viejas
app.use((req, res, next) => {
  if (req.path === '/app.js' || req.path === '/style.css') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- DIAGNOSTIC (no auth, must be BEFORE auth middleware) ---
app.get('/api/diag', async (req, res) => {
  try {
    const alms = await col('almacenes').get();
    const inv = await col('inventario').get();
    const dia = await col('inventario_diario').limit(1).get();
    const rec = await col('recetas').get();
    res.json({
      almacenes: alms.size,
      inventario: inv.size,
      inventario_diario_exists: dia.size > 0,
      inventario_diario_fields: dia.docs.length ? Object.keys(dia.docs[0].data()) : null,
      inventario_diario_fecha: dia.docs.length ? dia.docs[0].data().fecha : null,
      recetas: rec.size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- DEBUG: inspect barra_precios and receta_ingredientes (no auth) ---
app.get('/api/debug/ingredientes', async (req, res) => {
  try {
    const precSnap = await col('barra_precios').orderBy('ingrediente').get();
    const precios = precSnap.docs.map(d => ({ id: Number(d.id), ...d.data() }));
    const ingSnap = await col('receta_ingredientes').get();
    const recIngs = {};
    ingSnap.docs.forEach(d => {
      const ing = d.data();
      const key = ing.ingrediente.toLowerCase().trim().replace(/[^a-z0-9áéíóúüñ ]/g, '').replace(/\s+/g, ' ');
      if (!recIngs[key]) recIngs[key] = { variantes: {}, count: 0 };
      const variant = ing.ingrediente.trim();
      if (!recIngs[key].variantes[variant]) recIngs[key].variantes[variant] = { unidades: new Set(), veces: 0 };
      recIngs[key].variantes[variant].unidades.add(ing.unidad);
      recIngs[key].variantes[variant].veces++;
      recIngs[key].count++;
    });
    const uniques = Object.entries(recIngs).map(([key, v]) => ({
      key,
      variantes: Object.entries(v.variantes).map(([name, info]) => ({
        nombre: name, unidades: [...info.unidades], veces: info.veces
      })),
      total_usos: v.count
    }));
    res.json({ barra_precios: precios, receta_ingredientes_agrupados: uniques });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- DEBUG: compare recipe ingredients vs barra_precios (no auth) ---
app.get('/api/debug/verificar-recetas', async (req, res) => {
  try {
    const precSnap = await col('barra_precios').get();
    const canonical = {};
    precSnap.docs.forEach(d => {
      const data = d.data();
      canonical[data.ingrediente.toLowerCase().trim()] = data.ingrediente;
    });
    const ingSnap = await col('receta_ingredientes').get();
    const recetasSnap = await col('recetas').get();
    const recetaMap = {};
    recetasSnap.docs.forEach(d => {
      const r = d.data();
      recetaMap[r.id] = r.nombre || '(sin nombre)';
    });
    const mismatches = [];
    ingSnap.docs.forEach(d => {
      const ing = d.data();
      const lower = ing.ingrediente.toLowerCase().trim();
      if (!canonical[lower]) {
        // Find closest match
        const keys = Object.keys(canonical);
        const close = keys.find(k => k.includes(lower) || lower.includes(k));
        mismatches.push({
          receta: recetaMap[ing.receta_id] || `id:${ing.receta_id}`,
          receta_id: ing.receta_id,
          ingrediente_actual: ing.ingrediente,
          sugerencia: close ? canonical[close] : null,
          unidad: ing.unidad
        });
      }
    });
    res.json({ total_recetas: recetasSnap.size, total_ingredientes: ingSnap.docs.length, mismatches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- DEBUG: check fallback data (no auth) ---
app.get('/api/debug/fallback', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
  const snap = await col('inventario_diario').where('fecha', '==', fecha).get();
  const info = { fecha, hasData: !snap.empty, count: snap.docs.length, walks: [], prevDay: prevWorkingDay(fecha) };
  const firstPrevStr = prevWorkingDay(fecha);
  let pSnap = await col('inventario_diario').where('fecha', '==', firstPrevStr).get();
  info.firstPrev = { fecha: firstPrevStr, hasData: !pSnap.empty, count: pSnap.docs.length };
  if (pSnap.empty) {
    // Walk further back
    let prev = new Date(firstPrevStr + 'T12:00:00');
    for (let tries = 0; tries < 10; tries++) {
      prev.setDate(prev.getDate() - 1);
      const prevStr = prev.toISOString().split('T')[0];
      pSnap = await col('inventario_diario').where('fecha', '==', prevStr).get();
      info.walks.push({ fecha: prevStr, hasData: !pSnap.empty, count: pSnap.docs.length });
      if (!pSnap.empty) break;
    }
  }
  // Check gas butano (item 66, almacen 4)
  const gasSnap = await col('inventario_diario').where('fecha', '==', firstPrevStr).where('item_id', '==', 66).where('almacen_id', '==', 4).limit(1).get();
  info.gasButanoOnPrev = gasSnap.empty ? null : gasSnap.docs[0].data();
  // Also check it on the requested fecha
  const gasToday = await col('inventario_diario').where('fecha', '==', fecha).where('item_id', '==', 66).where('almacen_id', '==', 4).limit(1).get();
  info.gasButanoToday = gasToday.empty ? null : gasToday.docs[0].data();
  res.json(info);
});

// Auth middleware
async function authMiddleware(req, res, next) {
  if (req.path === '/login.html' || req.path === '/app.js' || req.path === '/style.css') return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}
// Apply to /api/* routes only
app.use('/api', authMiddleware);

// --- View engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.render('index', { cacheVersion: computeCacheVersion() });
});

// --- Helper functions ---
function col(name) { return db.collection(name); }

function docId(name, ...parts) { return parts.join('_'); }

// Simple in-memory cache (per Vercel instance, better than nothing)
const _cache = {};
function cached(key, ttlMs, fetchFn) {
  const now = Date.now();
  if (_cache[key] && _cache[key].data && now - _cache[key].ts < ttlMs) return Promise.resolve(_cache[key].data);
  if (_cache[key] && _cache[key].pending) return _cache[key].pending;
  const p = fetchFn().then(data => {
    _cache[key] = { data, ts: now, pending: null };
    return data;
  }).catch(err => {
    _cache[key] = { data: null, ts: 0, pending: null };
    throw err;
  });
  _cache[key] = { pending: p };
  return p;
}

// --- ALMACENES ---
app.get('/api/almacenes', async (req, res) => {
  const snap = await col('almacenes').orderBy('orden').get();
  const almacenes = snap.docs.map(d => ({ id: Number(d.id), ...d.data() }));
  res.json(almacenes);
});

app.get('/api/almacenes/con-inventario', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.json([]);
  try {
    const result = await cached('con_inv_' + fecha, 5000, async () => {
      const [almsSnap, allItemsSnap] = await Promise.all([
        col('almacenes').orderBy('orden').get(),
        col('inventario').get(),
      ]);
      const itemsByAl = {};
      allItemsSnap.docs.forEach(d => {
        const inv = d.data();
        const alId = inv.almacen_id;
        if (!itemsByAl[alId]) itemsByAl[alId] = [];
        itemsByAl[alId].push(inv);
      });
      let allDiasSnap = { docs: [] };
      let prevDiasByAl = {};
      if (fecha) {
        allDiasSnap = await col('inventario_diario').where('fecha', '==', fecha).get();
        // Deterministic: try the previous working day first (e.g. Wed → Mon, skipping Tue)
        const firstPrevStr = prevWorkingDay(fecha);
        let prevSnap = await col('inventario_diario').where('fecha', '==', firstPrevStr).get();
        if (prevSnap.empty) {
          // Walk further back if the immediate prev working day has no data
          let prev = new Date(firstPrevStr + 'T12:00:00');
          for (let tries = 0; tries < 10; tries++) {
            prev.setDate(prev.getDate() - 1);
            const prevStr = prev.toISOString().split('T')[0];
            prevSnap = await col('inventario_diario').where('fecha', '==', prevStr).get();
            if (!prevSnap.empty) break;
          }
        }
        if (!prevSnap.empty) {
          prevSnap.docs.forEach(d => {
            const dd = d.data();
            const alId = dd.almacen_id;
            if (!prevDiasByAl[alId]) prevDiasByAl[alId] = {};
            prevDiasByAl[alId][dd.item_id] = dd;
          });
        }
      }
      const diasByAl = {};
      allDiasSnap.docs.forEach(d => {
        const dd = d.data();
        const alId = dd.almacen_id;
        if (!diasByAl[alId]) diasByAl[alId] = {};
        diasByAl[alId][dd.item_id] = dd;
      });
      return almsSnap.docs.map(alDoc => {
        const alId = Number(alDoc.id);
        const invItems = itemsByAl[alId] || [];
        const diaMap = diasByAl[alId] || {};
        const prevMap = prevDiasByAl[alId] || {};
        const items = invItems.map(inv => {
          const dia = diaMap[inv.item_id] || {};
          const prevDia = prevMap[inv.item_id] || {};
          // If today's doc exists (from propagation or user-saved), use its apertura.
          // If not (new item or no data), fall back to prev day's cierre, then inventario base.
          const apertura = (dia.stock_apertura ?? prevDia.stock_cierre ?? inv.stock_apertura ?? 0);
          const ingreso = (dia.stock_ingreso ?? 0);
          const salida = (dia.salida_almacen ?? 0);
          const ventas = (dia.total_ventas ?? 0);
          const falta = (dia.falta_almacen ?? 0);
          const baja = (dia.stock_baja ?? 0);
          const cierre = apertura + ingreso - salida - ventas - falta - baja;
          return {
            id: inv.item_id,
            nombre: inv.nombre,
            categoria: inv.categoria || '',
            stock_apertura: apertura,
            stock_ingreso: ingreso,
            salida_almacen: salida,
            total_ventas: ventas,
            falta_almacen: falta,
            stock_baja: baja,
            nota_baja: dia.nota_baja || '',
            stock_observado: dia.stock_observado || 0,
            destino_salida: dia.destino_salida || '',
            destino_salidas: Array.isArray(dia.destino_salidas) ? dia.destino_salidas.map(d => ({ destino: String(d.destino || ''), cantidad: Number(d.cantidad) || 0 })).filter(d => d.destino && d.cantidad > 0) : [],
            destino_almacen_id: dia.destino_almacen_id || null,
            transferencias: Array.isArray(dia.transferencias) ? dia.transferencias.map(t => ({ almacen_id: Number(t.almacen_id), cantidad: Number(t.cantidad) || 0 })) : [],
            ingreso_origen: (Array.isArray(dia.ingreso_origen) && dia.ingreso_origen.length)
              ? dia.ingreso_origen.map(o => ({ tipo: o.tipo || 'proveedor', almacen_id: o.almacen_id ? Number(o.almacen_id) : null, cantidad: Number(o.cantidad) || 0 }))
              : ((dia.ingreso_transferencia || 0) > 0
                  ? [{ tipo: 'stocks', almacen_id: null, cantidad: Number(dia.ingreso_transferencia) || 0 }]
                  : (dia.stock_ingreso > 0 ? [{ tipo: 'proveedor', cantidad: dia.stock_ingreso }] : [])),
            stock_cierre: Math.round(cierre * 100) / 100,
            cantidad_minima: inv.cantidad_minima || 0,
            fecha_apertura: inv.fecha_apertura || '',
            saved_by: dia.saved_by || null,
            updated_at: dia.updated_at || null,
          };
        });
        return { id: alId, nombre: alDoc.data().nombre, items };
      });
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- RESUMEN: contadores de items para el menú principal ---
app.get('/api/resumen/items', async (req, res) => {
  try {
    const fecha = String(req.query.fecha || '').trim();
    const [almSnap, allItemsSnap, diaSnap] = await Promise.all([
      col('almacenes').get(),
      col('inventario').get(),
      fecha ? col('inventario_diario').where('fecha', '==', fecha).get() : Promise.resolve({ docs: [] }),
    ]);
    const diaByKey = {};
    diaSnap.docs.forEach(d => { const dd = d.data(); diaByKey[dd.almacen_id + '_' + dd.item_id] = dd; });
    let totalStocks = 0;
    allItemsSnap.docs.forEach(d => {
      const inv = d.data();
      const dia = diaByKey[inv.almacen_id + '_' + inv.item_id] || {};
      const apertura = (dia.stock_apertura ?? inv.stock_apertura ?? 0);
      const ingreso = (dia.stock_ingreso ?? 0);
      const salida = (dia.salida_almacen ?? 0);
      const ventas = (dia.total_ventas ?? 0);
      const falta = (dia.falta_almacen ?? 0);
      const baja = (dia.stock_baja ?? 0);
      totalStocks += apertura + ingreso - salida - ventas - falta - baja;
    });
    const barraSnap = await col('barra_stock').get();
    let totalBarra = 0;
    barraSnap.docs.forEach(d => { totalBarra += parseFloat(d.data().cantidad) || 0; });
    const cocinaSnap = await col('cocina_stock').get();
    let totalCocina = 0;
    cocinaSnap.docs.forEach(d => { totalCocina += parseFloat(d.data().cantidad) || 0; });
    res.json({ stocks: Math.round(totalStocks * 100) / 100, barra: Math.round(totalBarra * 100) / 100, cocina: Math.round(totalCocina * 100) / 100 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- GUARDAR DÍA ---
async function guardarDiaInterno(fecha, registros, savedBy) {
  if (!fecha || !registros) throw new Error('fecha y registros requeridos');

  // Read existing docs for all records to merge partial updates
  const existentes = {};
  await Promise.all(registros.map(async r => {
    const id = docId('invdiario', fecha, r.almacen_id, r.item_id);
    const snap = await col('inventario_diario').doc(id).get();
    existentes[id] = snap.exists ? snap.data() : {};
  }));

  const batch = db.batch();
  const changedKeys = new Set();
  const invSnap = await col('inventario').get();
  let maxItemId = invSnap.docs.length > 0 ? Math.max(...invSnap.docs.map(d => Number(d.data().item_id) || 0)) : 0;
  const invDocMap = {};
  invSnap.docs.forEach(d => { invDocMap[Number(d.data().almacen_id) + '_' + Number(d.data().item_id)] = d.data(); });

  // --- Transferencias STOCKS del día ---
  // La fuente de verdad es el destino_salida='stocks' + transferencias guardados en inventario_diario.
  // Se recalcula en cada guardado (idempotente) para no duplicar ingresos al volver a guardar.
  const allDaySnap = await col('inventario_diario').where('fecha', '==', fecha).get();
  const dayDocs = {};
  allDaySnap.docs.forEach(d => { dayDocs[d.id] = d.data(); });
  const savedValues = {}; // diaId -> valores finales calculados en ESTE guardado (para no sobrescribirlos)
  const transferMap = {}; // destAl_nombreUpper -> { [almacen_origen]: cantidad }
  const destKeys = new Set(); // destAl_nombreUpper que tienen transferencias hoy (para resetear si se eliminan)
  const addTransf = (k, srcAl, cant) => {
    if (!transferMap[k]) transferMap[k] = {};
    transferMap[k][srcAl] = (transferMap[k][srcAl] || 0) + cant;
  };
  allDaySnap.docs.forEach(d => {
    const x = d.data();
    if (String(x.destino_salida || '') === 'stocks' && Array.isArray(x.transferencias)) {
      const srcInv = invDocMap[Number(x.almacen_id) + '_' + Number(x.item_id)];
      const nombre = srcInv ? srcInv.nombre : null;
      if (!nombre) return;
      x.transferencias.forEach(t => {
        if (!t.almacen_id) return;
        const k = Number(t.almacen_id) + '_' + String(nombre).toUpperCase();
        destKeys.add(k);
        addTransf(k, Number(x.almacen_id), Number(t.cantidad) || 0);
      });
    }
  });
  // Los registros de ESTE guardado reemplazan su contribución previa (re-save o cambio de destino)
  registros.forEach(r => {
    const srcId = docId('invdiario', fecha, r.almacen_id, r.item_id);
    const old = dayDocs[srcId];
    const srcInv = invDocMap[Number(r.almacen_id) + '_' + Number(r.item_id)];
    const nombre = srcInv ? srcInv.nombre : null;
    // Transferencias efectivas: las del registro actual, o las ya guardadas (para no perderlas
    // al re-guardar desde ALMACENES, que no envía este campo).
    const destino = r.destino_salida !== undefined ? String(r.destino_salida) : (old ? String(old.destino_salida || '') : '');
    let transf = null;
    if (Array.isArray(r.transferencias)) transf = r.transferencias;
    else if (destino === 'stocks' && old && Array.isArray(old.transferencias)) transf = old.transferencias;
    if (old && Array.isArray(old.transferencias) && nombre) {
      old.transferencias.forEach(t => {
        if (!t.almacen_id) return;
        const k = Number(t.almacen_id) + '_' + String(nombre).toUpperCase();
        addTransf(k, Number(r.almacen_id), -(Number(t.cantidad) || 0));
      });
    }
    if (destino === 'stocks' && transf && nombre) {
      transf.forEach(t => {
        if (!t.almacen_id) return;
        const k = Number(t.almacen_id) + '_' + String(nombre).toUpperCase();
        destKeys.add(k);
        addTransf(k, Number(r.almacen_id), Number(t.cantidad) || 0);
      });
    }
  });

  // --- Auto-apertura de botellas para cubrir ventas de COPAS ---
  // Si se venden copas de un item "X - COPA" y el stock de copas no alcanza, se abre
  // automáticamente una botella del item "X - BOTELLA" del mismo almacén (1 botella = 5 copas).
  const COPAS_POR_BOTELLA = 5;
  const ajusteCopa = {};    // al_item -> copas extra (ingreso de la copa)
  const ajusteBotella = {}; // al_item -> botellas abiertas (salida de la botella)
  for (const r of registros) {
    if (r.total_ventas === undefined) continue;
    const ventasReg = parseFloat(r.total_ventas) || 0;
    if (ventasReg <= 0) continue;
    const invCopa = invDocMap[Number(r.almacen_id) + '_' + Number(r.item_id)];
    if (!invCopa || !/ - COPA$/i.test(String(invCopa.nombre || ''))) continue;
    const copaKey = Number(r.almacen_id) + '_' + Number(r.item_id);
    const copaId = docId('invdiario', fecha, Number(r.almacen_id), Number(r.item_id));
    const dc = dayDocs[copaId] || {};
    // Copas disponibles para VENDER hoy (sin restar las ventas ya registradas): apertura + ingreso - salida - falta - baja
    const dispCopa = (dc.stock_apertura || 0) + (dc.stock_ingreso || 0) + (ajusteCopa[copaKey] || 0) - (dc.salida_almacen || 0) - (dc.falta_almacen || 0) - (dc.stock_baja || 0);
    const faltante = Math.max(0, ventasReg - dispCopa);
    if (faltante <= 0) continue;
    const base = String(invCopa.nombre).replace(/ - COPA$/i, '');
    const botNombre = base + ' - BOTELLA';
    const botInv = invSnap.docs.find(d => Number(d.data().almacen_id) === Number(r.almacen_id) && String(d.data().nombre || '').trim().toUpperCase() === botNombre.trim().toUpperCase());
    if (!botInv) continue;
    const botKey = Number(r.almacen_id) + '_' + Number(botInv.data().item_id);
    const botId = docId('invdiario', fecha, Number(r.almacen_id), Number(botInv.data().item_id));
    const dbot = dayDocs[botId] || {};
    const dispBot = (dbot.stock_apertura || 0) + (dbot.stock_ingreso || 0) - (dbot.salida_almacen || 0) - (dbot.total_ventas || 0) - (dbot.falta_almacen || 0) - (dbot.stock_baja || 0) - (ajusteBotella[botKey] || 0);
    const necesarias = Math.ceil(faltante / COPAS_POR_BOTELLA);
    const aAbrir = Math.min(necesarias, Math.max(0, dispBot));
    if (aAbrir > 0) {
      ajusteCopa[copaKey] = (ajusteCopa[copaKey] || 0) + aAbrir * COPAS_POR_BOTELLA;
      ajusteBotella[botKey] = (ajusteBotella[botKey] || 0) + aAbrir;
    }
  }

  const cocinaStockAjustes = [];
  const barraStockAjustes = [];
  for (const r of registros) {
    const id = docId('invdiario', fecha, r.almacen_id, r.item_id);
    const prev = existentes[id] || {};

    // Merge incoming with existing — only override fields that were actually sent
    const apertura = r.stock_apertura !== undefined ? (parseFloat(r.stock_apertura) || 0) : (prev.stock_apertura || 0);
    let ingreso = r.stock_ingreso !== undefined ? (parseFloat(r.stock_ingreso) || 0) : (prev.stock_ingreso || 0);
    let salida = r.salida_almacen !== undefined ? (parseFloat(r.salida_almacen) || 0) : (prev.salida_almacen || 0);
    const ventas = r.total_ventas !== undefined ? (parseFloat(r.total_ventas) || 0) : (prev.total_ventas || 0);
    const falta = r.falta_almacen !== undefined ? (parseFloat(r.falta_almacen) || 0) : (prev.falta_almacen || 0);
    const baja = r.stock_baja !== undefined ? (parseFloat(r.stock_baja) || 0) : (prev.stock_baja || 0);
    const notaBaja = r.nota_baja !== undefined ? (r.nota_baja || '') : (prev.nota_baja || '');
    const clave = Number(r.almacen_id) + '_' + Number(r.item_id);
    // Ajustes por auto-apertura de botella (copa recibe ingreso, botella registra salida)
    if (ajusteCopa[clave]) ingreso += ajusteCopa[clave];
    if (ajusteBotella[clave]) salida += ajusteBotella[clave];
    // Valores finales de este guardado (para que las transferencias no sobrescriban lo recién editado)
    savedValues[id] = { stock_apertura: apertura, stock_ingreso: ingreso, salida_almacen: salida, total_ventas: ventas, falta_almacen: falta, stock_baja: baja };
    const cierre = apertura + ingreso - salida - ventas - falta - baja;
    const cierreR = Math.round(cierre * 100) / 100;
    // SALIDA con destino COCINA: sumar al COCINA/STOCK (respeta el desglose de destinos si existe)
    const dsCocina = Array.isArray(r.destino_salidas) ? r.destino_salidas.filter(d => String(d.destino).toLowerCase() === 'cocina').reduce((s, d) => s + (Number(d.cantidad) || 0), 0) : 0;
    const cocinaDelta = dsCocina || (String(r.destino_salida || '') === 'cocina' ? salida : 0);
    if (cocinaDelta > 0) {
      const nCoc = invDocMap[Number(r.almacen_id) + '_' + Number(r.item_id)];
      if (nCoc && nCoc.nombre) cocinaStockAjustes.push({ nombre: nCoc.nombre, delta: cocinaDelta, unidad: 'unidad' });
    }
    // SALIDA con destino BARRA: sumar al BARRA/STOCK (para que las recetas de ventas tengan stock que descontar)
    const dsBarra = Array.isArray(r.destino_salidas) ? r.destino_salidas.filter(d => String(d.destino).toLowerCase() === 'barra').reduce((s, d) => s + (Number(d.cantidad) || 0), 0) : 0;
    const barraDelta = dsBarra || (String(r.destino_salida || '') === 'barra' ? salida : 0);
    if (barraDelta > 0) {
      const nBar = invDocMap[Number(r.almacen_id) + '_' + Number(r.item_id)];
      if (nBar && nBar.nombre) barraStockAjustes.push({ nombre: nBar.nombre, delta: barraDelta, unidad: 'unidad' });
    }

    // Solo se propagan los items cuyo cierre/apertura realmente cambió.
    // Endurecido: cualquier guardado de movimientos también propaga (aunque el cierre no cambie
    // numéricamente), para que la apertura del día siguiente SIEMPRE quede = cierre de hoy.
    const cierreCambio = (prev.stock_apertura || 0) !== apertura || (prev.stock_cierre || 0) !== cierreR;
    const esMovimiento = r.total_ventas !== undefined || r.salida_almacen !== undefined ||
      r.stock_ingreso !== undefined || r.falta_almacen !== undefined || r.stock_baja !== undefined;
    if (cierreCambio || esMovimiento) {
      changedKeys.add(Number(r.almacen_id) + '_' + Number(r.item_id));
    }

    const data = { fecha, item_id: Number(r.item_id), almacen_id: Number(r.almacen_id) };
    if (r.stock_apertura !== undefined) data.stock_apertura = apertura;
    if (r.stock_ingreso !== undefined) data.stock_ingreso = ingreso;
    if (r.salida_almacen !== undefined) data.salida_almacen = salida;
    if (r.total_ventas !== undefined) data.total_ventas = ventas;
    if (r.falta_almacen !== undefined) data.falta_almacen = falta;
    if (r.stock_baja !== undefined) data.stock_baja = baja;
    if (r.nota_baja !== undefined) data.nota_baja = notaBaja;
    if (r.destino_salida !== undefined) data.destino_salida = String(r.destino_salida || '');
    // Desglose de destinos (varias salidas del mismo item a destinos distintos, ej. COPAS x4 + JUAN x1)
    if (r.destino_salidas !== undefined) {
      data.destino_salidas = Array.isArray(r.destino_salidas)
        ? r.destino_salidas.map(d => ({ destino: String(d.destino || ''), cantidad: Number(d.cantidad) || 0 })).filter(d => d.destino && d.cantidad > 0)
        : [];
    }
    if (r.transferencias !== undefined) data.transferencias = Array.isArray(r.transferencias) ? r.transferencias.map(t => ({ almacen_id: Number(t.almacen_id), cantidad: Number(t.cantidad) || 0 })) : [];
    if (r.ingreso_origen !== undefined) data.ingreso_origen = Array.isArray(r.ingreso_origen) ? r.ingreso_origen : [];
    // Si hubo auto-apertura de botella, forzar la escritura del ingreso (copa) o salida (botella)
    if (ajusteCopa[clave]) {
      data.stock_ingreso = Math.round(ingreso * 100) / 100;
      // Marcar el ingreso de copas como CONVERSION (apertura de botella)
      const origPrev = Array.isArray(prev.ingreso_origen) ? prev.ingreso_origen.filter(o => o.tipo !== 'conversion').map(o => ({ tipo: o.tipo, almacen_id: o.almacen_id, cantidad: o.cantidad })) : [];
      origPrev.push({ tipo: 'conversion', cantidad: ajusteCopa[clave] });
      data.ingreso_origen = origPrev;
    }
    if (ajusteBotella[clave]) data.salida_almacen = Math.round(salida * 100) / 100;
    // Stock en observación: solo se fija explícitamente (se libera manualmente con la accion "usar como venta")
    if (r.stock_observado !== undefined) {
      data.stock_observado = Math.max(0, Number(r.stock_observado) || 0);
    }
    data.stock_cierre = Math.round(cierre * 100) / 100;
    data.updated_at = new Date().toISOString();
    data.saved_by = savedBy;
    batch.set(col('inventario_diario').doc(id), data, { merge: true });

    // Update permanent stock_apertura in inventario (only if provided)
    if (r.stock_apertura !== undefined) {
      const invId = docId('inventario', r.item_id, r.almacen_id);
      batch.set(col('inventario').doc(invId), { stock_apertura: apertura }, { merge: true });
    }
  }

  // --- Procesar las transferencias del día hacia los almacenes destino (idempotente) ---
  const transferCache = {};
  for (const key of destKeys) {
    const origObj = transferMap[key] || {};
    const totalTransfer = Object.keys(origObj).reduce((acc, a) => acc + Math.max(0, origObj[a] || 0), 0);
    const newTransfer = Math.round(totalTransfer * 100) / 100;
    const usIdx = key.lastIndexOf('_');
    const destAl = Number(key.slice(0, usIdx));
    const nombre = key.slice(usIdx + 1);
    let destItemId;
    if (transferCache[key]) {
      destItemId = transferCache[key].item_id;
    } else {
      const destInv = invSnap.docs.find(d => Number(d.data().almacen_id) === destAl && String(d.data().nombre || '').trim().toLowerCase() === String(nombre).trim().toLowerCase());
      if (destInv) {
        destItemId = Number(destInv.data().item_id);
      } else {
        maxItemId++;
        destItemId = maxItemId;
        const anyInv = invSnap.docs.find(d => String(d.data().nombre || '').trim().toLowerCase() === String(nombre).trim().toLowerCase());
        batch.set(col('inventario').doc(docId('inventario', destItemId, destAl)), { item_id: destItemId, almacen_id: destAl, nombre, categoria: anyInv ? anyInv.data().categoria || '' : '', stock_apertura: 0, cantidad_minima: 0, updated_at: new Date().toISOString() });
      }
      transferCache[key] = { item_id: destItemId };
    }
    const destId = docId('invdiario', fecha, destAl, destItemId);
    const prevDest = dayDocs[destId] || {};
    // Usar los valores recién guardados si el destino también fue editado en este guardado
    const dp = savedValues[destId] || prevDest;
    const manual = Math.max(0, (dp.stock_ingreso || 0) - (prevDest.ingreso_transferencia || 0));
    const ingreso = Math.round((manual + newTransfer) * 100) / 100;
    const cierre = Math.round((((dp.stock_apertura || 0) + ingreso - (dp.salida_almacen || 0) - (dp.total_ventas || 0) - (dp.falta_almacen || 0) - (dp.stock_baja || 0)) * 100)) / 100;
    const ingreso_origen = [];
    Object.keys(origObj).forEach(a => {
      const c = Math.round(Math.max(0, origObj[a]) * 100) / 100;
      if (c > 0) ingreso_origen.push({ tipo: 'stocks', almacen_id: Number(a), cantidad: c });
    });
    if (manual > 0) ingreso_origen.push({ tipo: 'proveedor', cantidad: manual });
    batch.set(col('inventario_diario').doc(destId), {
      fecha, item_id: destItemId, almacen_id: destAl, stock_apertura: dp.stock_apertura || 0, stock_ingreso: ingreso,
      salida_almacen: dp.salida_almacen || 0, total_ventas: dp.total_ventas || 0, falta_almacen: dp.falta_almacen || 0,
      stock_baja: dp.stock_baja || 0, stock_cierre: cierre, ingreso_transferencia: newTransfer,
      ingreso_origen,
      saved_by: savedBy, updated_at: new Date().toISOString()
    }, { merge: true });
    changedKeys.add(destAl + '_' + destItemId);
  }

  // Botellas abiertas que NO vienen en los registros del guardado: escribirlas directamente
  for (const [botKey, abertura] of Object.entries(ajusteBotella)) {
    if (!abertura || abertura <= 0) continue;
    const us = botKey.indexOf('_');
    const alBot = Number(botKey.slice(0, us));
    const botItem = Number(botKey.slice(us + 1));
    const botId = docId('invdiario', fecha, alBot, botItem);
    if (existentes[botId]) continue; // ya lo procesó el loop
    const dbot = dayDocs[botId] || {};
    const nuevaSalida = Math.round(((dbot.salida_almacen || 0) + abertura) * 100) / 100;
    const cierreBot = Math.round(((dbot.stock_apertura || 0) + (dbot.stock_ingreso || 0) - nuevaSalida - (dbot.total_ventas || 0) - (dbot.falta_almacen || 0) - (dbot.stock_baja || 0)) * 100) / 100;
    batch.set(col('inventario_diario').doc(botId), {
      fecha, item_id: botItem, almacen_id: alBot,
      stock_apertura: dbot.stock_apertura || 0, stock_ingreso: dbot.stock_ingreso || 0,
      salida_almacen: nuevaSalida, total_ventas: dbot.total_ventas || 0,
      falta_almacen: dbot.falta_almacen || 0, stock_baja: dbot.stock_baja || 0,
      stock_cierre: cierreBot, updated_at: new Date().toISOString()
    }, { merge: true });
    changedKeys.add(alBot + '_' + botItem);
  }

  // SALIDAS de STOCK con destino COCINA: sumar al COCINA/STOCK (los ingresos de cocina
  // llegan tanto de COMPRAS/INGRESOS como de las SALIDAS de STOCKS con destino COCINA)
  if (cocinaStockAjustes.length) {
    await ajustarCocinaStock(cocinaStockAjustes);
  }

  // SALIDAS de STOCK con destino BARRA: sumar al BARRA/STOCK (los items que van a BARRA
  // quedan disponibles para descontar en las VENTAS de recetas de BARRA)
  if (barraStockAjustes.length) {
    await ajustarBarraStock(barraStockAjustes);
  }

  await batch.commit();
  delete _cache['inv_diario_' + fecha];
  delete _cache['con_inv_' + fecha];

  // Propagation: cadena hacia adelante SOLO de los items cuyo cierre/apertura cambió
  const propErrors = [];
  try {
    if (changedKeys.size) {
      const keysArr = Array.from(changedKeys);
      // Generar la secuencia de días hábiles (hasta 30)
      const secuencia = [];
      let srcFecha = fecha;
      for (let i = 0; i < 30; i++) {
        const targetDay = getNextWorkingDay(srcFecha);
        secuencia.push({ src: srcFecha, tgt: targetDay });
        srcFecha = targetDay;
      }
      // Leer TODOS los docs (origen+destino de cada día) en PARALELO
      const reads = [];
      const idxMap = [];
      secuencia.forEach(({ src, tgt }, si) => {
        keysArr.forEach(key => {
          const [al, item] = key.split('_');
          idxMap.push({ si, key, tipo: 'src', id: docId('invdiario', src, Number(al), Number(item)) });
          idxMap.push({ si, key, tipo: 'tgt', id: docId('invdiario', tgt, Number(al), Number(item)) });
          reads.push(col('inventario_diario').doc(idxMap[idxMap.length - 2].id).get());
          reads.push(col('inventario_diario').doc(idxMap[idxMap.length - 1].id).get());
        });
      });
      const results = await Promise.all(reads);
      const srcData = {};
      const tgtData = {};
      idxMap.forEach((m, i) => {
        const d = results[i];
        if (m.tipo === 'src') {
          if (d.exists) { if (!srcData[m.si]) srcData[m.si] = {}; srcData[m.si][m.key] = d.data(); }
        } else {
          if (!tgtData[m.si]) tgtData[m.si] = {};
          tgtData[m.si][m.key] = d.exists ? d.data() : null;
        }
      });
      // Calcular la cadena en memoria (el cierre de un día alimenta la apertura del siguiente)
      const prevCierre = {};
      const perDayWrites = {};
      for (let si = 0; si < secuencia.length; si++) {
        const srcs = srcData[si] || {};
        const tgts = tgtData[si] || {};
        if (!Object.keys(srcs).length) break;
        const tgt = secuencia[si].tgt;
        for (const key of Object.keys(srcs)) {
          const d = srcs[key];
          const existing = tgts[key];
          const apertura = prevCierre[key] !== undefined ? prevCierre[key] : (d.stock_cierre ?? 0);
          const nextId = docId('invdiario', tgt, d.almacen_id, d.item_id);
          if (existing) {
            const ingreso = existing.stock_ingreso ?? 0;
            const salida = existing.salida_almacen ?? 0;
            const ventas = existing.total_ventas ?? 0;
            const falta = existing.falta_almacen ?? 0;
            const baja = existing.stock_baja ?? 0;
            const cierre = Math.round((apertura + ingreso - salida - ventas - falta - baja) * 100) / 100;
            prevCierre[key] = cierre;
            if (existing.stock_apertura === apertura && existing.stock_cierre === cierre) continue;
            const upd = { stock_apertura: apertura, stock_cierre: cierre, updated_at: new Date().toISOString() };
            if (existing.nota_baja) upd.nota_baja = existing.nota_baja;
            if (!perDayWrites[si]) perDayWrites[si] = [];
            perDayWrites[si].push({ ref: col('inventario_diario').doc(nextId), type: 'update', data: upd });
          } else {
            const cierre = apertura;
            prevCierre[key] = cierre;
            if (!perDayWrites[si]) perDayWrites[si] = [];
            perDayWrites[si].push({ ref: col('inventario_diario').doc(nextId), type: 'set', data: {
              fecha: tgt, item_id: d.item_id, almacen_id: d.almacen_id,
              stock_apertura: apertura, stock_ingreso: 0, salida_almacen: 0,
              total_ventas: 0, falta_almacen: 0, stock_baja: 0, stock_cierre: apertura,
              updated_at: new Date().toISOString(),
            } });
          }
        }
      }
      // Escribir por día (un batch por día, en paralelo) — evita superar el límite de 500 por batch
      const commits = Object.keys(perDayWrites).map(si => {
        const batch = db.batch();
        perDayWrites[si].forEach(w => {
          if (w.type === 'update') batch.update(w.ref, w.data);
          else batch.set(w.ref, w.data);
        });
        return batch.commit();
      });
      if (commits.length) await Promise.all(commits);
    }
  } catch (e) {
    propErrors.push(e.message);
    console.error('Propagation error:', e.message);
  }

  return { ok: true, propagated: propErrors.length === 0 };
}

app.post('/api/almacenes/guardar-dia', async (req, res) => {
  try {
    const savedBy = req.body.saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
    const result = await guardarDiaInterno(req.body.fecha, req.body.registros, savedBy);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getNextWorkingDay(fecha) {
  const d = new Date(fecha + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 2) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}
function prevWorkingDay(fecha) {
  const d = new Date(fecha + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 2) d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// --- COMPRAS: consulta de destino de un item (almacenes de STOCKS + si es de BARRA) ---
app.get('/api/compras/destino', async (req, res) => {
  try {
    const nombre = String(req.query.nombre || '').trim();
    if (!nombre) return res.json({ stocks: [], barra: false });
    const key = nombre.toUpperCase();
    const [almsSnap, invSnap, precSnap, stockSnap] = await Promise.all([
      col('almacenes').get(),
      col('inventario').get(),
      col('barra_precios').get(),
      col('barra_stock').get(),
    ]);
    const alNombres = {};
    almsSnap.docs.forEach(d => { alNombres[Number(d.id)] = d.data().nombre; });
    const stocks = [];
    invSnap.docs.forEach(d => {
      const a = d.data();
      if (String(a.nombre || '').trim().toUpperCase() === key) {
        stocks.push({ almacen_id: a.almacen_id, almacen_nombre: alNombres[a.almacen_id] || ('Almacén ' + a.almacen_id) });
      }
    });
    const barraPrecio = precSnap.docs.some(d => String(d.data().ingrediente || '').trim().toUpperCase() === key);
    const barraStock = stockSnap.docs.some(d => String(d.data().ingrediente || '').trim().toUpperCase() === key);
    res.json({ stocks, barra: barraPrecio || barraStock });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- COMPRAS: guardado centralizado (enruta a STOCKS o BARRA según el item) ---
app.post('/api/compras/guardar', authMiddleware, async (req, res) => {
  try {
    const { fecha, items } = req.body;
    if (!fecha || !Array.isArray(items)) return res.status(400).json({ error: 'fecha e items requeridos' });
    const savedBy = req.user?.name || req.user?.email || 'unknown';

    // Índice para enrutar a STOCKS (inventario), normalizado (sin espacios, mayúsculas)
    const invSnap = await col('inventario').get();
    const stocksNorm = {};
    let maxItemId = 0;
    invSnap.docs.forEach(d => {
      const a = d.data();
      const norm = String(a.nombre || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!norm) return;
      if (!stocksNorm[norm]) stocksNorm[norm] = [];
      stocksNorm[norm].push({ item_id: a.item_id, almacen_id: a.almacen_id });
      if (Number(a.item_id) > maxItemId) maxItemId = Number(a.item_id);
    });
    // Coincidencia flexible: igual por nombre normalizado, o que el nombre del item contenga el buscado
    const matchStocks = (nombre) => {
      const norm = String(nombre || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!norm) return [];
      if (stocksNorm[norm]) return stocksNorm[norm];
      const cands = [];
      for (const [key, arr] of Object.entries(stocksNorm)) {
        if (key.includes(norm) || norm.includes(key)) cands.push(...arr);
      }
      return cands;
    };

    const registrosStocks = [];
    const movsBarra = [];
    const cocinaCompras = [];
    const resumen = { stocks: [], barra: [], cocina: [], noEncontrados: [] };

    for (const it of items) {
      const nombre = String(it.nombre || '').trim();
      if (!nombre) continue;
      const cantidad = parseFloat(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      const key = nombre.toUpperCase();
      const destino = String(it.destino || 'stocks').toLowerCase();
      if (destino === 'stocks') {
        const candidatos = matchStocks(nombre);
        // Almacenes elegidos por el usuario (o todos donde coincide el item)
        let seleccionados;
        if (Array.isArray(it.almacenes) && it.almacenes.length) {
          seleccionados = Array.from(new Set(it.almacenes.map(a => Number(a))));
        } else {
          seleccionados = Array.from(new Set(candidatos.map(c => Number(c.almacen_id))));
        }
        const almacenes = [];
        for (const alId of seleccionados) {
          let match = candidatos.find(c => Number(c.almacen_id) === alId);
          if (!match) {
            // Crear el item en ese almacén si no existe
            maxItemId += 1;
            const nuevoItem = { item_id: maxItemId, almacen_id: alId, nombre, categoria: '', stock_apertura: 0, cantidad_minima: 0 };
            await col('inventario').doc(docId('inventario', maxItemId, alId)).set(nuevoItem);
            match = { item_id: maxItemId, almacen_id: alId };
          }
          // SUMAR al ingreso ya registrado del día (no sobrescribir)
          const diaId = docId('invdiario', fecha, match.almacen_id, match.item_id);
          const diaSnap = await col('inventario_diario').doc(diaId).get();
          const cur = diaSnap.exists ? (parseFloat(diaSnap.data().stock_ingreso) || 0) : 0;
          const nuevoTotal = cur + cantidad;
          registrosStocks.push({ almacen_id: match.almacen_id, item_id: match.item_id, stock_ingreso: nuevoTotal });
          almacenes.push(match.almacen_id);
        }
        if (almacenes.length) resumen.stocks.push({ nombre, cantidad, almacenes });
        else resumen.noEncontrados.push({ nombre, cantidad, destino: 'stocks', msg: 'sin almacenes seleccionados' });
      } else if (destino === 'barra') {
        movsBarra.push({ ingrediente: nombre, cantidad, unidad: it.unidad || 'unidad', muebles: Array.isArray(it.muebles) ? it.muebles : [] });
        resumen.barra.push({ nombre, cantidad, unidad: it.unidad || 'unidad', muebles: Array.isArray(it.muebles) ? it.muebles : [] });
      } else if (destino === 'cocina') {
        cocinaCompras.push({ nombre, cantidad, unidad: it.unidad || 'unidad' });
        resumen.cocina.push({ nombre, cantidad, unidad: it.unidad || 'unidad' });
      } else {
        resumen.noEncontrados.push({ nombre, cantidad, destino });
      }
    }

    // Aplicar a STOCKS (inventario_diario + propagación)
    if (registrosStocks.length) {
      await guardarDiaInterno(fecha, registrosStocks, savedBy);
      // Asegurar que los items nuevos existan en stock_precios (Base de Datos de STOCKS)
      // para que aparezcan automáticamente en la BASE DE DATOS UNIFICADA.
      const spSnap = await col('stock_precios').get();
      const spBy = new Set(spSnap.docs.map(d => String(d.data().nombre || '').trim().toUpperCase()));
      let maxSpId = spSnap.docs.length ? Math.max(...spSnap.docs.map(d => Number(d.id) || 0)) : 0;
      const spBatch = db.batch();
      let spNuevos = 0;
      const now = new Date().toISOString();
      for (const r of resumen.stocks) {
        const key = String(r.nombre || '').trim().toUpperCase();
        if (!key || spBy.has(key)) continue;
        maxSpId++;
        spBatch.set(col('stock_precios').doc(String(maxSpId)), {
          id: maxSpId, nombre: r.nombre, unidad: 'unidad', precio: 0,
          unidad_venta: 'unidad', precio_venta: 0, created_at: now, updated_at: now
        });
        spBy.add(key); spNuevos++;
      }
      if (spNuevos) await spBatch.commit();
    }

    // Aplicar a BARRA (movimientos de ingreso + sumar al stock de barra según mueble)
    if (movsBarra.length) {
      const batch = db.batch();
      for (const m of movsBarra) {
        batch.set(col('barra_movimientos').doc(), {
          fecha, tipo: 'ingresos', ingrediente: m.ingrediente, cantidad: m.cantidad,
          unidad: m.unidad, muebles: m.muebles || [], saved_by: savedBy, created_at: new Date().toISOString()
        });
      }
      await batch.commit();
      // Sumar al stock de barra (barra_stock) según el mueble elegido, con conversión a onzas
      const stockSnap = await col('barra_stock').get();
      let maxBarraId = 0;
      const stockByNameGrupo = {};
      stockSnap.docs.forEach(d => {
        const a = d.data();
        const k = String(a.ingrediente || '').trim().toUpperCase();
        const g = String(a.grupo || '').toUpperCase();
        if (!stockByNameGrupo[k]) stockByNameGrupo[k] = {};
        if (!stockByNameGrupo[k][g]) stockByNameGrupo[k][g] = { ref: d.ref, data: a };
        if (Number(d.id) > maxBarraId) maxBarraId = Number(d.id);
      });
      const stockBatch = db.batch();
      let ajustados = 0;
      for (const m of movsBarra) {
        const key = String(m.ingrediente || '').trim().toUpperCase();
        const compraOz = aOnzas(m.cantidad, m.unidad, m.ingrediente);
        if (compraOz === null || isNaN(compraOz)) continue;
        const muebles = Array.isArray(m.muebles) && m.muebles.length ? m.muebles : GRUPOS_BARRA;
        for (const mueble of muebles) {
          const g = String(mueble || '').toUpperCase();
          const existente = (stockByNameGrupo[key] || {})[g];
          if (existente) {
            const stockOz = aOnzas(existente.data.cantidad, existente.data.unidad, existente.data.ingrediente);
            if (stockOz === null || isNaN(stockOz)) continue;
            const nuevaOz = Math.max(0, stockOz + compraOz);
            const nueva = Math.round(desdeOnzas(nuevaOz, existente.data.unidad, existente.data.ingrediente) * 100) / 100;
            stockBatch.update(existente.ref, { cantidad: nueva, updated_at: new Date().toISOString() });
            ajustados++;
          } else {
            // Crear el item en ese mueble si no existe
            maxBarraId += 1;
            stockBatch.set(col('barra_stock').doc(String(maxBarraId)), {
              id: maxBarraId, ingrediente: m.ingrediente, cantidad: m.cantidad,
              unidad: m.unidad, grupo: g, updated_at: new Date().toISOString()
            });
            if (!stockByNameGrupo[key]) stockByNameGrupo[key] = {};
            stockByNameGrupo[key][g] = { ref: null, data: { cantidad: m.cantidad, unidad: m.unidad, ingrediente: m.ingrediente } };
            ajustados++;
          }
        }
      }
      if (ajustados) await stockBatch.commit();

      // Asegurar que los items nuevos existan en barra_precios (Base de Datos de BARRA)
      // para que aparezcan automáticamente en la BASE DE DATOS UNIFICADA.
      const precSnap = await col('barra_precios').get();
      const precBy = new Set(precSnap.docs.map(d => String(d.data().ingrediente || '').trim().toUpperCase()));
      let maxPrecId = precSnap.docs.length ? Math.max(...precSnap.docs.map(d => Number(d.id) || 0)) : 0;
      const precBatch = db.batch();
      let precNuevos = 0;
      const now = new Date().toISOString();
      for (const m of movsBarra) {
        const key = String(m.ingrediente || '').trim().toUpperCase();
        if (!key || precBy.has(key)) continue;
        maxPrecId++;
        const uni = normalizeUnit(m.unidad);
        const parsed = uni === 'unidad' ? parseEquivFromName(m.ingrediente) : {};
        precBatch.set(col('barra_precios').doc(String(maxPrecId)), {
          id: maxPrecId, ingrediente: m.ingrediente, precio: 0, unidad: uni,
          precio_compra: 0, unidad_compra: '', equiv_ml: parsed.equiv_ml || 0, equiv_gr: parsed.equiv_gr || 0,
          created_at: now, updated_at: now
        });
        precBy.add(key);
        precNuevos++;
      }
      if (precNuevos) await precBatch.commit();
    }

    // Aplicar a COCINA (registro de compras + sumar al COCINA/STOCK)
    if (cocinaCompras.length) {
      const batch = db.batch();
      for (const m of cocinaCompras) {
        batch.set(col('cocina_compras').doc(), {
          fecha, nombre: m.nombre, cantidad: m.cantidad, unidad: m.unidad,
          saved_by: savedBy, created_at: new Date().toISOString()
        });
      }
      await batch.commit();
      // Sumar al COCINA/STOCK (si el item no existe, se crea)
      await ajustarCocinaStock(cocinaCompras.map(m => ({ nombre: m.nombre, delta: m.cantidad, unidad: m.unidad })));
      // Asegurar que los items nuevos existan en cocina_precios (Base de Datos de COCINA)
      // para que aparezcan automáticamente en la BASE DE DATOS UNIFICADA.
      const cpSnap = await col('cocina_precios').get();
      const cpBy = new Set(cpSnap.docs.map(d => String(d.data().ingrediente || '').trim().toUpperCase()));
      let maxCpId = cpSnap.docs.length ? Math.max(...cpSnap.docs.map(d => Number(d.id) || 0)) : 0;
      const cpBatch = db.batch();
      let cpNuevos = 0;
      const now = new Date().toISOString();
      for (const m of cocinaCompras) {
        const key = String(m.nombre || '').trim().toUpperCase();
        if (!key || cpBy.has(key)) continue;
        maxCpId++;
        cpBatch.set(col('cocina_precios').doc(String(maxCpId)), {
          id: maxCpId, ingrediente: m.nombre, precio: 0, unidad: 'unidad',
          precio_compra: 0, unidad_compra: '', created_at: now, updated_at: now
        });
        cpBy.add(key); cpNuevos++;
      }
      if (cpNuevos) await cpBatch.commit();
    }

    // Registrar el log de cada compra (para el detalle de COMPRAS/INGRESOS)
    if (resumen.stocks.length || resumen.barra.length || resumen.cocina.length) {
      const logBatch = db.batch();
      resumen.stocks.forEach(r => {
        logBatch.set(col('compras').doc(), {
          fecha, nombre: r.nombre, cantidad: r.cantidad, unidad: 'unidad', destino: 'stocks',
          almacenes: r.almacenes || [], saved_by: savedBy, created_at: new Date().toISOString()
        });
      });
      resumen.barra.forEach(r => {
        logBatch.set(col('compras').doc(), {
          fecha, nombre: r.nombre, cantidad: r.cantidad, unidad: r.unidad || 'unidad', destino: 'barra',
          muebles: r.muebles || [], saved_by: savedBy, created_at: new Date().toISOString()
        });
      });
      resumen.cocina.forEach(r => {
        logBatch.set(col('compras').doc(), {
          fecha, nombre: r.nombre, cantidad: r.cantidad, unidad: r.unidad || 'unidad', destino: 'cocina',
          saved_by: savedBy, created_at: new Date().toISOString()
        });
      });
      await logBatch.commit();
    }

    res.json({ ok: true, resumen });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- COMPRAS: detalle de compras/ingresos registrados por fecha ---
app.get('/api/compras/detalle', async (req, res) => {
  try {
    const fecha = req.query.fecha;
    if (!fecha) return res.json([]);
    // BARRA y COCINA desde el log; los de STOCKS se derivan de inventario_diario (fuente única)
    const logSnap = await col('compras').where('fecha', '==', fecha).get();
    const lista = logSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.destino !== 'stocks');
    const [invSnap, diaSnap] = await Promise.all([
      col('inventario').get(),
      col('inventario_diario').where('fecha', '==', fecha).get()
    ]);
    const nombres = {};
    invSnap.docs.forEach(d => {
      const a = d.data();
      if (a.almacen_id !== undefined && a.item_id !== undefined) nombres[a.almacen_id + ':' + a.item_id] = a.nombre;
    });
    diaSnap.docs.forEach(d => {
      const a = d.data();
      const ing = parseFloat(a.stock_ingreso) || 0;
      if (ing <= 0) return;
      const nombre = nombres[a.almacen_id + ':' + a.item_id];
      if (!nombre) return;
      lista.push({
        id: 'inv:' + a.almacen_id + ':' + a.item_id,
        fecha,
        nombre,
        cantidad: ing,
        unidad: 'unidad',
        destino: 'stocks',
        almacenes: [Number(a.almacen_id)],
        saved_by: a.saved_by || '-',
        created_at: a.updated_at || new Date().toISOString()
      });
    });
    lista.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    res.json(lista);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- COMPRAS: eliminar una compra/ingreso registrada (efecto en cadena) ---
app.delete('/api/compras/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const fecha = String(req.query.fecha || '');
    if (String(id).startsWith('inv:')) {
      const parts = String(id).split(':');
      const almacenId = Number(parts[1]);
      const itemId = Number(parts[2]);
      if (!fecha || isNaN(almacenId) || isNaN(itemId)) return res.status(400).json({ error: 'Parámetros inválidos' });
      const savedBy = req.user?.name || req.user?.email || 'unknown';
      await guardarDiaInterno(fecha, [{ almacen_id: almacenId, item_id: itemId, stock_ingreso: 0 }], savedBy);
      return res.json({ ok: true });
    }
    const logRef = col('compras').doc(id);
    const logSnap = await logRef.get();
    if (!logSnap.exists) return res.status(404).json({ error: 'Registro no encontrado' });
    const log = logSnap.data();
    const nombre = log.nombre;
    const cantidad = parseFloat(log.cantidad) || 0;
    const savedBy = req.user?.name || req.user?.email || 'unknown';

    if (log.destino === 'stocks') {
      // Revertir el ingreso en inventario_diario (resta + propagación)
      const invSnap = await col('inventario').get();
      const stocksNorm = {};
      invSnap.docs.forEach(d => {
        const a = d.data();
        const norm = String(a.nombre || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!norm) return;
        if (!stocksNorm[norm]) stocksNorm[norm] = [];
        stocksNorm[norm].push({ item_id: a.item_id, almacen_id: a.almacen_id });
      });
      const norm = String(nombre).trim().toUpperCase().replace(/\s+/g, '');
      const cands = stocksNorm[norm] || [];
      const almacenes = Array.isArray(log.almacenes) && log.almacenes.length ? log.almacenes.map(Number) : [];
      const registros = [];
      for (const alId of almacenes) {
        const match = cands.find(c => Number(c.almacen_id) === alId);
        if (match) {
          // Restar al ingreso actual del día (no dejar negativo)
          const diaId = docId('invdiario', fecha, match.almacen_id, match.item_id);
          const diaSnap = await col('inventario_diario').doc(diaId).get();
          const cur = diaSnap.exists ? (parseFloat(diaSnap.data().stock_ingreso) || 0) : 0;
          const nuevo = Math.max(0, cur - cantidad);
          registros.push({ almacen_id: match.almacen_id, item_id: match.item_id, stock_ingreso: nuevo });
        }
      }
      if (registros.length) await guardarDiaInterno(fecha, registros, savedBy);
    } else if (log.destino === 'barra') {
      // Eliminar movimientos de ingreso de barra de la fecha
      const bm = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', 'ingresos').get();
      const batch = db.batch();
      let borrado = false;
      bm.docs.forEach(d => {
        const a = d.data();
        if (String(a.ingrediente || '').toUpperCase() === String(nombre).toUpperCase() &&
            Math.abs((parseFloat(a.cantidad) || 0) - cantidad) < 0.001) {
          batch.delete(d.ref);
          borrado = true;
        }
      });
      if (borrado) await batch.commit();
      // Restar del stock de barra según muebles
      const stockSnap = await col('barra_stock').get();
      const key = String(nombre).trim().toUpperCase();
      const muebles = Array.isArray(log.muebles) && log.muebles.length ? log.muebles : GRUPOS_BARRA;
      const compraOz = aOnzas(cantidad, log.unidad || 'unidad', nombre);
      const stockBatch = db.batch();
      let ajustados = 0;
      if (compraOz !== null && !isNaN(compraOz)) {
        stockSnap.docs.forEach(d => {
          const a = d.data();
          const g = String(a.grupo || '').toUpperCase();
          if (String(a.ingrediente || '').trim().toUpperCase() === key && muebles.map(m => String(m).toUpperCase()).includes(g)) {
            const stockOz = aOnzas(a.cantidad, a.unidad, a.ingrediente);
            if (stockOz === null || isNaN(stockOz)) return;
            const nuevaOz = Math.max(0, stockOz - compraOz);
            const nueva = Math.round(desdeOnzas(nuevaOz, a.unidad, a.ingrediente) * 100) / 100;
            stockBatch.update(d.ref, { cantidad: nueva, updated_at: new Date().toISOString() });
            ajustados++;
          }
        });
      }
      if (ajustados) await stockBatch.commit();
    } else if (log.destino === 'cocina') {
      const cc = await col('cocina_compras').where('fecha', '==', fecha).get();
      const batch = db.batch();
      let borrado = false;
      cc.docs.forEach(d => {
        const a = d.data();
        if (String(a.nombre || '').toUpperCase() === String(nombre).toUpperCase() &&
            Math.abs((parseFloat(a.cantidad) || 0) - cantidad) < 0.001) {
          batch.delete(d.ref);
          borrado = true;
        }
      });
      if (borrado) await batch.commit();
    }

    // Eliminar el registro del log
    await logRef.delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- VENTAS: helpers de stock de barra (descontar / sumar consumo de recetas) ---
async function descontarStockBarra(consumos) {
  const stockSnap = await col('barra_stock').get();
  const allStock = stockSnap.docs.map(d => ({ ref: d.ref, id: Number(d.id) || 0, data: d.data() }));
  const byNombre = {};
  allStock.forEach(s => {
    const k = String(s.data.ingrediente || '').trim().toUpperCase();
    if (!byNombre[k]) byNombre[k] = [];
    byNombre[k].push(s);
  });
  const batch = db.batch();
  let ajustados = 0;
  for (const c of consumos) {
    const key = String(c.ingrediente || '').trim().toUpperCase();
    const deltaOz = aOnzas(c.cantidad, c.unidad, c.ingrediente);
    if (deltaOz === null || isNaN(deltaOz)) continue;
    let matches = byNombre[key] || [];
    if (!matches.length) matches = matchStockFuzzy(c.ingrediente, allStock);
    if (!matches.length) continue;
    let restante = deltaOz;
    for (const m of matches) {
      if (restante === 0) break;
      const si = m.item || m;
      const ozItem = aOnzas(si.data.cantidad, si.data.unidad, si.data.ingrediente);
      if (ozItem === null || isNaN(ozItem)) continue;
      const aDescontar = Math.min(ozItem, restante);
      const nuevoOz = Math.max(0, ozItem - aDescontar);
      const nueva = Math.round(desdeOnzas(nuevoOz, si.data.unidad, si.data.ingrediente) * 100) / 100;
      batch.update(si.ref, { cantidad: nueva, updated_at: new Date().toISOString() });
      restante -= aDescontar;
      ajustados++;
    }
  }
  if (ajustados) await batch.commit();
}

async function sumarStockBarra(consumos) {
  const stockSnap = await col('barra_stock').get();
  const allStock = stockSnap.docs.map(d => ({ ref: d.ref, id: Number(d.id) || 0, data: d.data() }));
  const byNombre = {};
  allStock.forEach(s => {
    const k = String(s.data.ingrediente || '').trim().toUpperCase();
    if (!byNombre[k]) byNombre[k] = [];
    byNombre[k].push(s);
  });
  const batch = db.batch();
  let ajustados = 0;
  for (const c of consumos) {
    const key = String(c.ingrediente || '').trim().toUpperCase();
    const deltaOz = aOnzas(c.cantidad, c.unidad, c.ingrediente);
    if (deltaOz === null || isNaN(deltaOz)) continue;
    let matches = byNombre[key] || [];
    if (!matches.length) matches = matchStockFuzzy(c.ingrediente, allStock);
    if (!matches.length) continue;
    for (const m of matches) {
      const si = m.item || m;
      const ozItem = aOnzas(si.data.cantidad, si.data.unidad, si.data.ingrediente);
      if (ozItem === null || isNaN(ozItem)) continue;
      const nuevaOz = Math.max(0, ozItem + deltaOz);
      const nueva = Math.round(desdeOnzas(nuevaOz, si.data.unidad, si.data.ingrediente) * 100) / 100;
      batch.update(si.ref, { cantidad: nueva, updated_at: new Date().toISOString() });
      ajustados++;
    }
  }
  if (ajustados) await batch.commit();
}

// --- VENTAS: guardado centralizado (salen de STOCKS, BARRA o COCINA) ---
app.post('/api/ventas/guardar', authMiddleware, async (req, res) => {
  try {
    const { fecha, items } = req.body;
    if (!fecha || !Array.isArray(items)) return res.status(400).json({ error: 'fecha e items requeridos' });
    const savedBy = req.user?.name || req.user?.email || 'unknown';

    const invSnap = await col('inventario').get();
    const stocksNorm = {};
    let maxItemId = 0;
    invSnap.docs.forEach(d => {
      const a = d.data();
      const norm = String(a.nombre || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!norm) return;
      if (!stocksNorm[norm]) stocksNorm[norm] = [];
      stocksNorm[norm].push({ item_id: a.item_id, almacen_id: a.almacen_id });
      if (Number(a.item_id) > maxItemId) maxItemId = Number(a.item_id);
    });
    const matchStocks = (nombre) => {
      const norm = String(nombre || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!norm) return [];
      if (stocksNorm[norm]) return stocksNorm[norm];
      const cands = [];
      for (const [key, arr] of Object.entries(stocksNorm)) {
        if (key.includes(norm) || norm.includes(key)) cands.push(...arr);
      }
      return cands;
    };

    const registrosStocks = [];
    const ventasBarra = [];
    const cocinaVentas = [];
    const resumen = { stocks: [], barra: [], cocina: [], noEncontrados: [] };

    for (const it of items) {
      const nombre = String(it.nombre || '').trim();
      if (!nombre) continue;
      const cantidad = parseFloat(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      const destino = String(it.destino || 'stocks').toLowerCase();
      if (destino === 'stocks') {
        const candidatos = matchStocks(nombre);
        let seleccionados;
        if (Array.isArray(it.almacenes) && it.almacenes.length) {
          seleccionados = Array.from(new Set(it.almacenes.map(a => Number(a))));
        } else if (candidatos.length) {
          // Sin almacenes elegidos: registrar en un solo almacén (evita duplicar la venta en todos)
          seleccionados = [Number(candidatos[0].almacen_id)];
        } else {
          seleccionados = [];
        }
        const almacenes = [];
        for (const alId of seleccionados) {
          let match = candidatos.find(c => Number(c.almacen_id) === alId);
          if (!match) {
            maxItemId += 1;
            await col('inventario').doc(docId('inventario', maxItemId, alId)).set({ item_id: maxItemId, almacen_id: alId, nombre, categoria: '', stock_apertura: 0, cantidad_minima: 0 });
            match = { item_id: maxItemId, almacen_id: alId };
          }
          // SUMAR a las ventas ya registradas del día (no sobrescribir)
          const diaId = docId('invdiario', fecha, match.almacen_id, match.item_id);
          const diaSnap = await col('inventario_diario').doc(diaId).get();
          const cur = diaSnap.exists ? (parseFloat(diaSnap.data().total_ventas) || 0) : 0;
          const nuevoTotal = cur + cantidad;
          registrosStocks.push({ almacen_id: match.almacen_id, item_id: match.item_id, total_ventas: nuevoTotal });
          almacenes.push(match.almacen_id);
        }
        if (almacenes.length) resumen.stocks.push({ nombre, cantidad, almacenes });
        else resumen.noEncontrados.push({ nombre, cantidad, destino: 'stocks' });
      } else if (destino === 'barra') {
        ventasBarra.push({ nombre, cantidad });
        resumen.barra.push({ nombre, cantidad });
      } else if (destino === 'cocina') {
        cocinaVentas.push({ nombre, cantidad });
        resumen.cocina.push({ nombre, cantidad });
      } else {
        resumen.noEncontrados.push({ nombre, cantidad, destino });
      }
    }

    // Aplicar a STOCKS (total_ventas en inventario_diario + propagación)
    if (registrosStocks.length) {
      await guardarDiaInterno(fecha, registrosStocks, savedBy);
    }

    // Aplicar a BARRA (movimientos de venta de recetas + descontar stock)
    if (ventasBarra.length) {
      const recSnap = await col('recetas').get();
      const ingSnap = await col('receta_ingredientes').get();
      const recetasMap = {};
      recSnap.docs.forEach(d => { const a = d.data(); recetasMap[String(a.nombre).trim().toUpperCase()] = { id: d.id, nombre: a.nombre }; });
      const ingByRec = {};
      ingSnap.docs.forEach(d => { const a = d.data(); if (!ingByRec[a.receta_id]) ingByRec[a.receta_id] = []; ingByRec[a.receta_id].push(a); });
      const batch = db.batch();
      const consumos = [];
      for (const v of ventasBarra) {
        const rec = recetasMap[String(v.nombre).trim().toUpperCase()];
        const recNombre = rec ? rec.nombre : v.nombre;
        const recId = rec ? rec.id : null;
        batch.set(col('barra_movimientos').doc(), {
          fecha, tipo: 'ventas', ingrediente: recNombre, cantidad: v.cantidad, unidad: 'unidad',
          es_receta: true, receta: recNombre, saved_by: savedBy, created_at: new Date().toISOString()
        });
        if (recId) {
          (ingByRec[recId] || []).forEach(ing => {
            const cant = Math.round(((parseFloat(ing.cantidad) || 0) * v.cantidad) * 100) / 100;
            consumos.push({ ingrediente: ing.ingrediente, cantidad: cant, unidad: ing.unidad || 'unidad' });
            batch.set(col('barra_movimientos').doc(), {
              fecha, tipo: 'ventas', ingrediente: ing.ingrediente, cantidad: cant, unidad: ing.unidad || 'unidad',
              es_receta: false, receta: recNombre, saved_by: savedBy, created_at: new Date().toISOString()
            });
          });
        }
      }
      await batch.commit();
      await descontarStockBarra(consumos);
    }

    // Aplicar a COCINA
    if (cocinaVentas.length) {
      const batch = db.batch();
      cocinaVentas.forEach(v => batch.set(col('cocina_ventas').doc(), { fecha, nombre: v.nombre, cantidad: v.cantidad, unidad: 'unidad', saved_by: savedBy, created_at: new Date().toISOString() }));
      await batch.commit();
    }

    // Log de ventas (detalle)
    if (resumen.stocks.length || resumen.barra.length || resumen.cocina.length) {
      const logBatch = db.batch();
      resumen.stocks.forEach(r => logBatch.set(col('ventas').doc(), { fecha, nombre: r.nombre, cantidad: r.cantidad, unidad: 'unidad', destino: 'stocks', almacenes: r.almacenes || [], saved_by: savedBy, created_at: new Date().toISOString() }));
      resumen.barra.forEach(r => logBatch.set(col('ventas').doc(), { fecha, nombre: r.nombre, cantidad: r.cantidad, unidad: 'unidad', destino: 'barra', saved_by: savedBy, created_at: new Date().toISOString() }));
      resumen.cocina.forEach(r => logBatch.set(col('ventas').doc(), { fecha, nombre: r.nombre, cantidad: r.cantidad, unidad: 'unidad', destino: 'cocina', saved_by: savedBy, created_at: new Date().toISOString() }));
      await logBatch.commit();
    }

    res.json({ ok: true, resumen });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- VENTAS: detalle por fecha ---
app.get('/api/ventas/detalle', async (req, res) => {
  try {
    const fecha = req.query.fecha;
    if (!fecha) return res.json([]);
    const list = [];

    // Índice STOCKS (nombre normalizado -> items) y nombres
    const invSnap = await col('inventario').get();
    const stocksNorm = {};
    const nombreByKey = {};
    invSnap.docs.forEach(d => {
      const a = d.data();
      const norm = String(a.nombre || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!norm) return;
      if (!stocksNorm[norm]) stocksNorm[norm] = [];
      stocksNorm[norm].push({ item_id: a.item_id, almacen_id: a.almacen_id });
      nombreByKey[a.item_id + '_' + a.almacen_id] = a.nombre;
    });
    const matchStocks = (nombre) => {
      const norm = String(nombre || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!norm) return [];
      if (stocksNorm[norm]) return stocksNorm[norm];
      const cands = [];
      for (const [k, arr] of Object.entries(stocksNorm)) { if (k.includes(norm) || norm.includes(k)) cands.push(...arr); }
      return cands;
    };

    const log = await col('ventas').where('fecha', '==', fecha).get();

    // STOCKS: agrupar por (item, almacen) usando el inventario diario como total
    const dia = await col('inventario_diario').where('fecha', '==', fecha).get();
    const stocksGroups = {};
    dia.docs.map(d => d.data()).filter(a => (a.total_ventas || 0) > 0).forEach(a => {
      const key = a.item_id + '_' + a.almacen_id;
      stocksGroups[key] = { almacen_id: a.almacen_id, item_id: a.item_id, nombre: nombreByKey[key] || String(a.item_id), cantidad: a.total_ventas, log_ids: [], created_at: a.updated_at || '', saved_by: a.saved_by || '-' };
    });
    log.docs.forEach(d => {
      const a = d.data();
      if (a.destino !== 'stocks') return;
      const cands = matchStocks(a.nombre);
      (a.almacenes || []).forEach(al => {
        const m = cands.find(c => Number(c.almacen_id) === Number(al));
        if (!m) return;
        const key = m.item_id + '_' + Number(al);
        if (stocksGroups[key]) { stocksGroups[key].log_ids.push(d.id); stocksGroups[key].saved_by = a.saved_by || stocksGroups[key].saved_by; }
      });
    });
    Object.keys(stocksGroups).forEach(key => {
      const g = stocksGroups[key];
      list.push({ id: 'grp_stocks_' + key, grupo: true, fecha, nombre: g.nombre, cantidad: g.cantidad, unidad: 'unidad', destino: 'stocks', almacenes: [g.almacen_id], item_id: g.item_id, log_ids: g.log_ids, saved_by: g.saved_by, created_at: g.created_at });
    });

    // BARRA: agrupar por receta
    const barraLogKeys = new Set();
    const barraGroups = {};
    log.docs.forEach(d => {
      const a = d.data();
      if (a.destino !== 'barra') return;
      const key = String(a.nombre || '').trim().toUpperCase();
      barraLogKeys.add(key + '|' + (a.cantidad || 0));
      if (!barraGroups[key]) barraGroups[key] = { nombre: a.nombre, cantidad: 0, log_ids: [], created_at: '', saved_by: a.saved_by || '-' };
      barraGroups[key].cantidad += a.cantidad || 0;
      barraGroups[key].log_ids.push(d.id);
      if (!barraGroups[key].created_at || (a.created_at && a.created_at < barraGroups[key].created_at)) barraGroups[key].created_at = a.created_at;
      barraGroups[key].saved_by = a.saved_by || barraGroups[key].saved_by;
    });
    const bm = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', 'ventas').get();
    bm.docs.map(d => d.data()).filter(a => a.es_receta !== false).forEach(a => {
      const key = String(a.ingrediente || '').trim().toUpperCase();
      if (barraLogKeys.has(key + '|' + (a.cantidad || 0))) return; // ya está en el log
      if (!barraGroups[key]) barraGroups[key] = { nombre: a.ingrediente, cantidad: 0, log_ids: [], created_at: '', saved_by: a.saved_by || '-' };
      barraGroups[key].cantidad += a.cantidad || 0;
      if (!barraGroups[key].created_at || (a.created_at && a.created_at < barraGroups[key].created_at)) barraGroups[key].created_at = a.created_at;
      barraGroups[key].saved_by = a.saved_by || barraGroups[key].saved_by;
    });
    Object.keys(barraGroups).forEach(key => {
      const g = barraGroups[key];
      list.push({ id: 'grp_barra_' + key, grupo: true, fecha, nombre: g.nombre, cantidad: g.cantidad, unidad: 'unidad', destino: 'barra', log_ids: g.log_ids, saved_by: g.saved_by, created_at: g.created_at });
    });

    // COCINA: agrupar por receta
    const cocinaLogKeys = new Set();
    const cocinaGroups = {};
    log.docs.forEach(d => {
      const a = d.data();
      if (a.destino !== 'cocina') return;
      const key = String(a.nombre || '').trim().toUpperCase();
      cocinaLogKeys.add(key + '|' + (a.cantidad || 0));
      if (!cocinaGroups[key]) cocinaGroups[key] = { nombre: a.nombre, cantidad: 0, log_ids: [], created_at: '', saved_by: a.saved_by || '-' };
      cocinaGroups[key].cantidad += a.cantidad || 0;
      cocinaGroups[key].log_ids.push(d.id);
      if (!cocinaGroups[key].created_at || (a.created_at && a.created_at < cocinaGroups[key].created_at)) cocinaGroups[key].created_at = a.created_at;
      cocinaGroups[key].saved_by = a.saved_by || cocinaGroups[key].saved_by;
    });
    const cve = await col('cocina_ventas').where('fecha', '==', fecha).get();
    cve.docs.forEach(d => {
      const a = d.data();
      const key = String(a.nombre || '').trim().toUpperCase();
      if (cocinaLogKeys.has(key + '|' + (a.cantidad || 0))) return; // ya está en el log
      if (!cocinaGroups[key]) cocinaGroups[key] = { nombre: a.nombre, cantidad: 0, log_ids: [], created_at: '', saved_by: a.saved_by || '-' };
      cocinaGroups[key].cantidad += a.cantidad || 0;
      if (!cocinaGroups[key].created_at || (a.created_at && a.created_at < cocinaGroups[key].created_at)) cocinaGroups[key].created_at = a.created_at;
      cocinaGroups[key].saved_by = a.saved_by || cocinaGroups[key].saved_by;
    });
    Object.keys(cocinaGroups).forEach(key => {
      const g = cocinaGroups[key];
      list.push({ id: 'grp_cocina_' + key, grupo: true, fecha, nombre: g.nombre, cantidad: g.cantidad, unidad: 'unidad', destino: 'cocina', log_ids: g.log_ids, saved_by: g.saved_by, created_at: g.created_at });
    });

    list.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- VENTAS: búsqueda por rango de fechas e item (STOCKS) ---
app.get('/api/ventas/busqueda', async (req, res) => {
  try {
    const { desde, hasta, item } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta requeridos' });
    const [almsSnap, invSnap] = await Promise.all([col('almacenes').get(), col('inventario').get()]);
    const alName = {};
    almsSnap.docs.forEach(d => { alName[Number(d.id)] = d.data().nombre; });
    const invById = {};
    invSnap.docs.forEach(d => {
      const inv = d.data();
      invById[Number(inv.item_id) + '_' + Number(inv.almacen_id)] = inv;
    });
    const dia = await col('inventario_diario').where('fecha', '>=', desde).where('fecha', '<=', hasta).get();
    const qNorm = claveNombre(item);
    const groups = {};
    dia.docs.forEach(dd => {
      const f = dd.data();
      const ventas = f.total_ventas || 0;
      if (!(ventas > 0)) return;
      const inv = invById[Number(f.item_id) + '_' + Number(f.almacen_id)] || {};
      const nombre = inv.nombre || String(f.item_id);
      if (qNorm && !claveNombre(nombre).includes(qNorm)) return;
      const key = Number(f.item_id) + '_' + Number(f.almacen_id);
      if (!groups[key]) groups[key] = { item_id: Number(f.item_id), nombre, almacen_id: Number(f.almacen_id), almacen_nombre: alName[Number(f.almacen_id)] || ('Almacén ' + f.almacen_id), detalle: [], total: 0 };
      groups[key].detalle.push({ fecha: f.fecha, cantidad: ventas, saved_by: f.saved_by || '-' });
      groups[key].total += ventas;
    });
    const result = Object.values(groups);
    result.forEach(g => { g.detalle.sort((a, b) => a.fecha.localeCompare(b.fecha)); g.total = Math.round(g.total * 100) / 100; });
    result.sort((a, b) => a.nombre.localeCompare(b.nombre) || (a.almacen_id - b.almacen_id));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- VENTAS: búsqueda total (STOCKS + BARRA + COCINA) por rango de fechas e item ---
app.get('/api/ventas/busqueda-total', async (req, res) => {
  try {
    const { desde, hasta, item } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta requeridos' });
    const qNorm = claveNombre(item);
    const registros = [];

    const [invSnap, alSnap] = await Promise.all([col('inventario').get(), col('almacenes').get()]);
    const invByKey = {};
    invSnap.docs.forEach(d => { const a = d.data(); invByKey[Number(a.item_id) + '_' + Number(a.almacen_id)] = a.nombre; });
    const alName = {};
    alSnap.docs.forEach(d => { alName[Number(d.id)] = d.data().nombre; });

    // STOCKS (inventario diario)
    const dia = await col('inventario_diario').where('fecha', '>=', desde).where('fecha', '<=', hasta).get();
    dia.docs.forEach(d => {
      const a = d.data();
      if (!((a.total_ventas || 0) > 0)) return;
      const nombre = invByKey[Number(a.item_id) + '_' + Number(a.almacen_id)] || String(a.item_id);
      registros.push({ fecha: a.fecha, nombre, cantidad: a.total_ventas, destino: 'stocks', almacen_id: Number(a.almacen_id), almacen_nombre: alName[Number(a.almacen_id)] || '', saved_by: a.saved_by || '-', created_at: a.updated_at || '' });
    });

    // Log de ventas (BARRA / COCINA) + dedupe
    const seen = new Set();
    const log = await col('ventas').where('fecha', '>=', desde).where('fecha', '<=', hasta).get();
    const push = (r) => {
      const key = r.fecha + '|' + r.destino + '|' + String(r.nombre || '') + '|' + (r.cantidad || 0);
      if (seen.has(key)) return;
      seen.add(key);
      registros.push(r);
    };
    log.docs.forEach(d => {
      const a = d.data();
      if (a.destino !== 'barra' && a.destino !== 'cocina') return;
      push({ fecha: a.fecha, nombre: a.nombre, cantidad: a.cantidad, destino: a.destino, almacen_id: null, almacen_nombre: '', saved_by: a.saved_by || '-', created_at: a.created_at || '' });
    });
    // BARRA movimientos (recetas) si no está en el log
    const bm = await col('barra_movimientos').where('tipo', '==', 'ventas').get();
    bm.docs.forEach(d => {
      const a = d.data();
      if (a.es_receta === false) return;
      if (a.fecha < desde || a.fecha > hasta) return;
      push({ fecha: a.fecha, nombre: a.ingrediente, cantidad: a.cantidad, destino: 'barra', almacen_id: null, almacen_nombre: '', saved_by: a.saved_by || '-', created_at: a.created_at || '' });
    });
    // COCINA ventas si no está en el log
    const cv = await col('cocina_ventas').where('fecha', '>=', desde).where('fecha', '<=', hasta).get();
    cv.docs.forEach(d => {
      const a = d.data();
      push({ fecha: a.fecha, nombre: a.nombre, cantidad: a.cantidad, destino: 'cocina', almacen_id: null, almacen_nombre: '', saved_by: a.saved_by || '-', created_at: a.created_at || '' });
    });

    const filtrados = qNorm ? registros.filter(r => claveNombre(r.nombre).includes(qNorm)) : registros;
    filtrados.sort((a, b) => String(a.fecha || '').localeCompare(b.fecha || '') || String(a.nombre || '').localeCompare(b.nombre || ''));
    res.json(filtrados);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nombres únicos de items/recetas vendidos (para autocompletar en búsqueda)
function claveNombre(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim()
    .replace(/(\d+)\s+(ML|LT|CC|GR|G|KG|OZ|CL|GL)\b/g, (m, d, u) => d + u)
    .replace(/[*\u2013\-.]+$/g, '').trim();
}

app.get('/api/ventas/items-vendidos', async (req, res) => {
  try {
    const porClave = {};
    const add = (n) => { const k = String(n || '').trim(); if (!k) return; const c = claveNombre(k); if (!(c in porClave)) porClave[c] = k; };
    const log = await col('ventas').get(); log.docs.forEach(d => add(d.data().nombre));
    const bm = await col('barra_movimientos').where('tipo', '==', 'ventas').get(); bm.docs.forEach(d => { if (d.data().es_receta !== false) add(d.data().ingrediente); });
    const cv = await col('cocina_ventas').get(); cv.docs.forEach(d => add(d.data().nombre));
    const inv = await col('inventario').get(); inv.docs.forEach(d => add(d.data().nombre));
    const rec = await col('recetas').get(); rec.docs.forEach(d => add(d.data().nombre));
    const crec = await col('cocina_recetas').get(); crec.docs.forEach(d => add(d.data().nombre));
    res.json(Object.values(porClave).sort((a, b) => a.localeCompare(b)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- VENTAS: mapeo item -> destino (persistente para importar Excel) ---
app.get('/api/ventas/import-mapping', async (req, res) => {
  try {
    const doc = await col('config').doc('ventas_import_mapping').get();
    res.json({ mapping: doc.exists ? (doc.data().mapping || {}) : {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ventas/import-mapping', async (req, res) => {
  try {
    const { mapping } = req.body;
    if (!mapping) return res.status(400).json({ error: 'mapping requerido' });
    const doc = await col('config').doc('ventas_import_mapping').get();
    const prev = doc.exists ? (doc.data().mapping || {}) : {};
    const nuevo = { ...prev };
    Object.keys(mapping).forEach(k => {
      const v = String(mapping[k] || '').trim().toLowerCase();
      if (v && ['stocks', 'barra', 'cocina'].includes(v)) nuevo[k] = v;
    });
    await col('config').doc('ventas_import_mapping').set({ mapping: nuevo, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- VENTAS: emparejamiento item del EXCEL -> item de la app ---
app.get('/api/ventas/import-match', async (req, res) => {
  try {
    const doc = await col('config').doc('ventas_import_match').get();
    res.json({ match: doc.exists ? (doc.data().match || {}) : {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ventas/import-match', async (req, res) => {
  try {
    const { match } = req.body;
    if (!match) return res.status(400).json({ error: 'match requerido' });
    const doc = await col('config').doc('ventas_import_match').get();
    const prev = doc.exists ? (doc.data().match || {}) : {};
    await col('config').doc('ventas_import_match').set({ match: { ...prev, ...match }, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- VENTAS: eliminar una venta (efecto en cadena) ---
app.delete('/api/ventas/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const savedBy = req.user?.name || req.user?.email || 'unknown';

    // --- Ventas agrupadas (grupo por item+destino, borra todo el grupo en cadena) ---
    if (req.body && req.body.grupo) {
      const fecha = req.body.fecha;
      if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
      if (Array.isArray(req.body.log_ids) && req.body.log_ids.length) {
        const batch = db.batch();
        req.body.log_ids.forEach(lid => batch.delete(col('ventas').doc(lid)));
        await batch.commit();
      }
      if (req.body.destino === 'stocks') {
        const item = Number(req.body.item_id);
        const al = Number(req.body.almacen_id);
        if (item && al) await guardarDiaInterno(fecha, [{ almacen_id: al, item_id: item, total_ventas: 0 }], savedBy);
      } else if (req.body.destino === 'barra') {
        const nombre = String(req.body.nombre || '');
        const bm = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', 'ventas').get();
        const batch = db.batch();
        const consumos = [];
        let borrado = false;
        bm.docs.forEach(d => {
          const a = d.data();
          if (a.es_receta !== false && String(a.ingrediente || '').toUpperCase() === String(nombre).toUpperCase()) {
            batch.delete(d.ref); borrado = true;
          } else if (a.es_receta === false && a.receta && String(a.receta).toUpperCase() === String(nombre).toUpperCase()) {
            batch.delete(d.ref); borrado = true;
            consumos.push({ ingrediente: a.ingrediente, cantidad: a.cantidad, unidad: a.unidad || 'unidad' });
          }
        });
        if (borrado) await batch.commit();
        if (consumos.length) await sumarStockBarra(consumos);
      }
      return res.json({ ok: true });
    }

    // --- Ventas registradas manualmente (STOCK/VENTAS o BARRA/VENTAS) ---
    if (req.body && req.body.manual) {
      const fecha = req.body.fecha;
      if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
      if (req.body.destino === 'stocks') {
        const item = Number(req.body.item_id);
        const al = Number(req.body.almacen_id);
        if (!item || !al) return res.status(400).json({ error: 'item/almacen requeridos' });
        await guardarDiaInterno(fecha, [{ almacen_id: al, item_id: item, total_ventas: 0 }], savedBy);
        return res.json({ ok: true });
      }
      if (req.body.destino === 'barra') {
        const nombre = String(req.body.nombre || '');
        const cant = parseFloat(req.body.cantidad) || 0;
        const bm = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', 'ventas').get();
        const batch = db.batch();
        const consumos = [];
        let borrado = false;
        bm.docs.forEach(d => {
          const a = d.data();
          if (a.es_receta !== false && String(a.ingrediente || '').toUpperCase() === String(nombre).toUpperCase() &&
              Math.abs((parseFloat(a.cantidad) || 0) - cant) < 0.001) {
            batch.delete(d.ref); borrado = true;
          } else if (a.es_receta === false && a.receta && String(a.receta).toUpperCase() === String(nombre).toUpperCase()) {
            batch.delete(d.ref); borrado = true;
            consumos.push({ ingrediente: a.ingrediente, cantidad: a.cantidad, unidad: a.unidad || 'unidad' });
          }
        });
        if (borrado) await batch.commit();
        if (consumos.length) await sumarStockBarra(consumos);
        return res.json({ ok: true });
      }
    }

    // --- Ventas del log central (apartado VENTAS) ---
    const logRef = col('ventas').doc(id);
    const logSnap = await logRef.get();
    if (!logSnap.exists) return res.status(404).json({ error: 'Registro no encontrado' });
    const log = logSnap.data();
    const fecha = log.fecha;
    const nombre = log.nombre;
    const cantidad = parseFloat(log.cantidad) || 0;

    if (log.destino === 'stocks') {
      const invSnap = await col('inventario').get();
      const stocksNorm = {};
      invSnap.docs.forEach(d => {
        const a = d.data();
        const norm = String(a.nombre || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!norm) return;
        if (!stocksNorm[norm]) stocksNorm[norm] = [];
        stocksNorm[norm].push({ item_id: a.item_id, almacen_id: a.almacen_id });
      });
      const norm = String(nombre).trim().toUpperCase().replace(/\s+/g, '');
      let cands = stocksNorm[norm] || [];
      if (!cands.length) {
        for (const [key, arr] of Object.entries(stocksNorm)) {
          if (key.includes(norm) || norm.includes(key)) cands.push(...arr);
        }
      }
      const almacenes = Array.isArray(log.almacenes) && log.almacenes.length ? log.almacenes.map(Number) : [];
      const registros = [];
      for (const alId of almacenes) {
        const match = cands.find(c => Number(c.almacen_id) === alId);
        if (match) {
          const diaId = docId('invdiario', fecha, match.almacen_id, match.item_id);
          const diaSnap = await col('inventario_diario').doc(diaId).get();
          const cur = diaSnap.exists ? (parseFloat(diaSnap.data().total_ventas) || 0) : 0;
          const nuevo = Math.max(0, cur - cantidad);
          registros.push({ almacen_id: match.almacen_id, item_id: match.item_id, total_ventas: nuevo });
        }
      }
      if (registros.length) await guardarDiaInterno(fecha, registros, savedBy);
    } else if (log.destino === 'barra') {
      // Quitar movimientos de venta de la receta y sumar de vuelta el consumo al stock
      const bm = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', 'ventas').get();
      const batch = db.batch();
      let borrado = false;
      bm.docs.forEach(d => {
        const a = d.data();
        if (String(a.ingrediente || '').toUpperCase() === String(nombre).toUpperCase() &&
            Math.abs((parseFloat(a.cantidad) || 0) - cantidad) < 0.001 && a.es_receta !== false) {
          batch.delete(d.ref);
          borrado = true;
        }
      });
      // Consumo de ingredientes asociados a esa receta
      const consumos = [];
      bm.docs.forEach(d => {
        const a = d.data();
        if (a.es_receta === false && a.receta && String(a.receta).toUpperCase() === String(nombre).toUpperCase()) {
          batch.delete(d.ref);
          borrado = true;
          consumos.push({ ingrediente: a.ingrediente, cantidad: a.cantidad, unidad: a.unidad || 'unidad' });
        }
      });
      if (borrado) await batch.commit();
      if (consumos.length) await sumarStockBarra(consumos);
    } else if (log.destino === 'cocina') {
      const cc = await col('cocina_ventas').where('fecha', '==', fecha).get();
      const batch = db.batch();
      let borrado = false;
      cc.docs.forEach(d => {
        const a = d.data();
        if (String(a.nombre || '').toUpperCase() === String(nombre).toUpperCase() &&
            Math.abs((parseFloat(a.cantidad) || 0) - cantidad) < 0.001) {
          batch.delete(d.ref);
          borrado = true;
        }
      });
      if (borrado) await batch.commit();
    }

    await logRef.delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// --- REPAIR: propagate last known data to a target fecha ---
app.post('/api/repair/propagar', async (req, res) => {
  try {
    const targetFecha = req.body.fecha;
    if (!targetFecha) return res.status(400).json({ error: 'fecha requerida' });
    // Check if targetFecha already has data
    const existing = await col('inventario_diario').where('fecha', '==', targetFecha).get();
    if (!existing.empty) return res.json({ ok: true, msg: targetFecha + ' ya tiene datos' });
    // Walk backwards up to 10 days to find data
    let sourceFecha = null;
    let sourceSnap = null;
    const d = new Date(targetFecha + 'T12:00:00');
    for (let tries = 0; tries < 10; tries++) {
      d.setDate(d.getDate() - 1);
      const prevStr = d.toISOString().split('T')[0];
      const snap = await col('inventario_diario').where('fecha', '==', prevStr).get();
      if (!snap.empty) { sourceFecha = prevStr; sourceSnap = snap; break; }
    }
    if (!sourceFecha) return res.json({ ok: true, msg: 'No hay data anterior' });
    const batch = db.batch();
    for (const doc of sourceSnap.docs) {
      const dd = doc.data();
      const nextId = docId('invdiario', targetFecha, dd.almacen_id, dd.item_id);
      batch.set(col('inventario_diario').doc(nextId), {
        fecha: targetFecha,
        item_id: dd.item_id,
        almacen_id: dd.almacen_id,
        stock_apertura: dd.stock_cierre ?? 0,
        stock_ingreso: 0,
        salida_almacen: 0,
        total_ventas: 0,
        falta_almacen: 0,
        stock_cierre: dd.stock_cierre ?? 0,
        updated_at: new Date().toISOString(),
      });
    }
    await batch.commit();
    res.json({ ok: true, msg: 'Propagado ' + sourceFecha + ' → ' + targetFecha + ' (' + sourceSnap.docs.length + ' docs)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- REPAIR: fix apertura of existing data to match prev working day's cierre ---
app.post('/api/repair/fix-apertura', async (req, res) => {
  try {
    const { fecha } = req.body;
    if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
    const prevStr = prevWorkingDay(fecha);
    const [prevSnap, curSnap] = await Promise.all([
      col('inventario_diario').where('fecha', '==', prevStr).get(),
      col('inventario_diario').where('fecha', '==', fecha).get(),
    ]);
    if (prevSnap.empty) return res.json({ ok: false, msg: 'No hay data anterior en ' + prevStr });
    const prevByKey = {};
    prevSnap.docs.forEach(d => {
      const dd = d.data();
      prevByKey[dd.almacen_id + '_' + dd.item_id] = dd;
    });
    const batch = db.batch();
    let changed = 0;
    curSnap.docs.forEach(d => {
      const dd = d.data();
      const prev = prevByKey[dd.almacen_id + '_' + dd.item_id];
      if (prev && dd.stock_apertura !== prev.stock_cierre) {
        const newCierre = (prev.stock_cierre ?? 0) + (dd.stock_ingreso ?? 0) - (dd.salida_almacen ?? 0) - (dd.total_ventas ?? 0) - (dd.falta_almacen ?? 0);
        batch.update(d.ref, {
          stock_apertura: prev.stock_cierre ?? 0,
          stock_cierre: Math.round(newCierre * 100) / 100,
        });
        changed++;
      }
    });
    if (changed > 0) await batch.commit();
    res.json({ ok: true, msg: `Corregidas ${changed} aperturas en ${fecha} (prev: ${prevStr})` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- MINIMOS ---
app.put('/api/inventario/minimos', async (req, res) => {
  try {
    const { minimos, botellas } = req.body;
    const batch = db.batch();
    if (minimos) {
      for (const m of minimos) {
        const id = docId('inventario', m.item_id, m.almacen_id);
        const ref = col('inventario').doc(id);
        batch.set(ref, { cantidad_minima: parseFloat(m.cantidad_minima) || 0 }, { merge: true });
      }
    }
    if (botellas) {
      for (const b of botellas) {
        const id = docId('inventario', b.item_id, b.almacen_id);
        const ref = col('inventario').doc(id);
        batch.set(ref, { fecha_apertura: b.fecha_apertura || '' }, { merge: true });
      }
    }
    await batch.commit();
    res.json({ ok: true });
  } catch (e) {
    console.error('Error en minimos:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- PRECIOS ---
app.get('/api/precios', async (req, res) => {
  const fecha = req.query.fecha;
  const [almsSnap, allInvSnap, allDiasSnap] = await Promise.all([
    col('almacenes').orderBy('orden').get(),
    col('inventario').get(),
    fecha ? col('inventario_diario').where('fecha', '==', fecha).get() : Promise.resolve({ docs: [] }),
  ]);
  const invByAl = {};
  allInvSnap.docs.forEach(d => {
    const inv = d.data();
    if (!invByAl[inv.almacen_id]) invByAl[inv.almacen_id] = [];
    invByAl[inv.almacen_id].push(inv);
  });
  const diasByAl = {};
  allDiasSnap.docs.forEach(d => {
    const dd = d.data();
    if (!diasByAl[dd.almacen_id]) diasByAl[dd.almacen_id] = {};
    diasByAl[dd.almacen_id][dd.item_id] = dd;
  });
  const result = almsSnap.docs.map(alDoc => {
    const alId = Number(alDoc.id);
    const invItems = invByAl[alId] || [];
    const stockMap = diasByAl[alId] || {};
    const items = invItems.map(inv => {
      const dia = stockMap[inv.item_id] || {};
      const cierre = (dia.stock_apertura ?? inv.stock_apertura ?? 0) + (dia.stock_ingreso ?? 0) - (dia.salida_almacen ?? 0) - (dia.total_ventas ?? 0) - (dia.falta_almacen ?? 0) - (dia.stock_baja ?? 0);
      return {
        id: inv.item_id,
        nombre: inv.nombre,
        precio: inv.precio || 0,
        stock_cierre: Math.round(cierre * 100) / 100,
      };
    });
    return { id: alId, nombre: alDoc.data().nombre, items };
  });
  res.json(result);
});

app.put('/api/precios', async (req, res) => {
  const { precios } = req.body;
  if (!precios) return res.status(400).json({ error: 'precios requerido' });
  const batch = db.batch();
  for (const p of precios) {
    const id = docId('inventario', p.item_id, p.almacen_id);
    const ref = col('inventario').doc(id);
    batch.set(ref, { precio: parseFloat(p.precio) || 0 }, { merge: true });
  }
  await batch.commit();
  res.json({ ok: true });
});

// --- RECETAS ---
app.get('/api/recetas', async (req, res) => {
  const [recSnap, precSnap, ingSnap] = await Promise.all([
    col('recetas').orderBy('nombre').get(),
    col('barra_precios').orderBy('ingrediente').get(),
    col('receta_ingredientes').orderBy('id').get(),
  ]);
  const precios = precSnap.docs.map(d => d.data());
  const ingByRec = {};
  ingSnap.docs.forEach(idoc => {
    const ing = { id: Number(idoc.id), ...idoc.data() };
    const rid = ing.receta_id;
    if (!ingByRec[rid]) ingByRec[rid] = [];
    ingByRec[rid].push(ing);
  });
  const result = recSnap.docs.map(d => {
    const r = { id: Number(d.id), ...d.data() };
    const ingredientes = ingByRec[r.id] || [];
    let costoTotal = 0;
    const ingredientesConPrecio = ingredientes.map(ing => {
      const match = precios.find(p => p.ingrediente && p.ingrediente.toLowerCase() === ing.ingrediente.toLowerCase());
      const precioUnidad = match ? (match.precio || 0) : 0;
      const conv = match
        ? calcularCosto(ing.cantidad, ing.unidad, precioUnidad, match.unidad, match.equiv_ml, match.equiv_gr, match.ingrediente)
        : { costo: (ing.cantidad || 0) * precioUnidad, converted: false };
      const costo = typeof conv === 'object' ? conv.costo : conv;
      const converted = typeof conv === 'object' ? conv.converted : false;
      costoTotal += costo;
      return { ...ing, precioUnidad, costo, converted, precioMatch: !!match };
    });
    return { ...r, ingredientes: ingredientesConPrecio, costoTotal };
  });
  res.json(result);
});

app.post('/api/recetas', async (req, res) => {
  const { nombre, categoria } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const n = String(nombre).trim();
  const norm = s => String(s || '').trim().toUpperCase().replace(/[\s-]+/g, ' ');
  // Evitar recetas duplicadas: si ya existe con el mismo nombre (normalizado), devolver la existente
  const all = await col('recetas').get();
  const existente = all.docs.find(d => norm(d.data().nombre) === norm(n));
  if (existente) return res.json({ id: Number(existente.id) || null, nombre: existente.data().nombre, existente: true });
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('recetas').doc(String(nextId)).set({
    nombre: n, categoria: categoria || 'Clásicos',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  res.json({ id: nextId, nombre: n });
});

app.put('/api/recetas/:id', async (req, res) => {
  const { nombre, categoria } = req.body;
  await col('recetas').doc(req.params.id).update({
    nombre, categoria: categoria || 'Clásicos',
    updated_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.delete('/api/recetas/:id', async (req, res) => {
  const id = req.params.id;
  const ingSnap = await col('receta_ingredientes').where('receta_id', '==', Number(id)).get();
  const batch = db.batch();
  ingSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(col('recetas').doc(id));
  await batch.commit();
  res.json({ ok: true });
});

app.post('/api/recetas/:id/ingredientes', async (req, res) => {
  const { ingrediente, cantidad, unidad } = req.body;
  const ref = col('receta_ingredientes').doc();
  const all = await col('receta_ingredientes').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('receta_ingredientes').doc(String(nextId)).set({
    id: nextId, receta_id: Number(req.params.id),
    ingrediente, cantidad: cantidad || 0, unidad: normalizeUnit(unidad)
  });
  await ensureIngredienteInPrecios(ingrediente, unidad);
  res.json({ ok: true });
});

app.put('/api/receta-ingredientes/:id', async (req, res) => {
  const { ingrediente, cantidad, unidad } = req.body;
  await col('receta_ingredientes').doc(req.params.id).update({
    ingrediente, cantidad: cantidad || 0, unidad: normalizeUnit(unidad)
  });
  res.json({ ok: true });
});

app.delete('/api/receta-ingredientes/:id', async (req, res) => {
  await col('receta_ingredientes').doc(req.params.id).delete();
  res.json({ ok: true });
});

app.put('/api/recetas/:id/with-ingredientes', async (req, res) => {
  const { nombre, categoria, ingredientes } = req.body;
  const id = req.params.id;
  await col('recetas').doc(id).update({
    nombre, categoria: categoria || 'Clásicos', updated_at: new Date().toISOString()
  });
  const oldSnap = await col('receta_ingredientes').where('receta_id', '==', Number(id)).get();
  const batch = db.batch();
  oldSnap.docs.forEach(d => batch.delete(d.ref));
  if (ingredientes && ingredientes.length) {
    const all = await col('receta_ingredientes').get();
    let maxId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) : 0;
    for (const ing of ingredientes) {
      maxId++;
      const ref = col('receta_ingredientes').doc(String(maxId));
      batch.set(ref, { id: maxId, receta_id: Number(id), ingrediente: ing.ingrediente, cantidad: ing.cantidad || 0, unidad: normalizeUnit(ing.unidad) });
    }
  }
  await batch.commit();
  // Auto-add all ingredients to barra_precios if not already there
  if (ingredientes && ingredientes.length) {
    await Promise.all(ingredientes.map(ing => ensureIngredienteInPrecios(ing.ingrediente, ing.unidad)));
  }
  res.json({ ok: true });
});

// --- Helper: ensure an ingredient exists in barra_precios ---
async function ensureIngredienteInPrecios(ingrediente, unidad) {
  if (!ingrediente) return null;
  // Case-insensitive check: try exact match first, then scan all
  const exact = await col('barra_precios').where('ingrediente', '==', ingrediente).get();
  if (!exact.empty) return exact.docs[0];
  const all = await col('barra_precios').get();
  const lower = ingrediente.toLowerCase().trim();
  const existing = all.docs.find(d => d.data().ingrediente.toLowerCase().trim() === lower);
  if (existing) return existing;
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  const dbUnidad = normalizeUnit(unidad || 'unidad');
  const ref = col('barra_precios').doc(String(nextId));
  await ref.set({
    id: nextId, ingrediente: lower, precio: 0, unidad: dbUnidad,
    ...(dbUnidad === 'unidad' ? parseEquivFromName(lower) : {}),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  return { id: nextId };
}

// --- BARRA STOCK ---
const GRUPOS_BARRA = ['MUEBLE DE ARRIBA', 'MUEBLE DE ABAJO', 'MUEBLE DE APOYO'];
function normalizeGrupo(g) {
  const up = String(g || '').toUpperCase().trim();
  return GRUPOS_BARRA.find(x => x === up) || '';
}

app.get('/api/barra/stock', async (req, res) => {
  const { fecha } = req.query;
  const hoy = new Date().toISOString().split('T')[0];
  if (fecha && fecha !== hoy) {
    const snap = await col('barra_stock_diario').where('fecha', '==', fecha).get();
    return res.json(snap.docs.map(d => ({ ...d.data() })));
  }
  const snap = await col('barra_stock').orderBy('id').get();
  res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
});

// Guarda un snapshot histórico del stock para una fecha
app.post('/api/barra/stock/diario', authMiddleware, async (req, res) => {
  try {
    const { fecha, items } = req.body;
    if (!fecha || !Array.isArray(items)) return res.status(400).json({ error: 'fecha e items requeridos' });
    const batch = db.batch();
    const existing = await col('barra_stock_diario').where('fecha', '==', fecha).get();
    existing.docs.forEach(d => batch.delete(d.ref));
    items.forEach(it => {
      const id = Number(it.id);
      const ref = col('barra_stock_diario').doc(fecha + '_' + id);
      batch.set(ref, {
        id,
        fecha,
        ingrediente: String(it.ingrediente || ''),
        cantidad: parseFloat(it.cantidad) || 0,
        unidad: normalizeUnit(it.unidad),
        grupo: String(it.grupo || '').toUpperCase(),
        saved_at: new Date().toISOString()
      });
    });
    await batch.commit();
    res.json({ ok: true, fecha, count: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/barra/stock', async (req, res) => {
  const { ingrediente, cantidad, unidad, grupo } = req.body;
  if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
  const all = await col('barra_stock').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('barra_stock').doc(String(nextId)).set({
    id: nextId, ingrediente, cantidad: cantidad || 0, unidad: normalizeUnit(unidad),
    grupo: normalizeGrupo(grupo),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.put('/api/barra/stock/:id', async (req, res) => {
  const { cantidad, ingrediente, unidad, grupo } = req.body;
  const upd = { updated_at: new Date().toISOString() };
  if (cantidad !== undefined) upd.cantidad = cantidad;
  if (ingrediente) upd.ingrediente = ingrediente;
  if (unidad) upd.unidad = normalizeUnit(unidad);
  if (grupo !== undefined) upd.grupo = normalizeGrupo(grupo);
  await col('barra_stock').doc(req.params.id).update(upd);
  res.json({ ok: true });
});

app.delete('/api/barra/stock/:id', async (req, res) => {
  await col('barra_stock').doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- COCINA: Stock con familias ---
app.get('/api/cocina/stock', async (req, res) => {
  try {
    const snap = await col('cocina_stock').orderBy('id').get();
    res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cocina/stock', async (req, res) => {
  try {
    const { ingrediente, cantidad, unidad, familia } = req.body;
    if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
    const all = await col('cocina_stock').get();
    const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    await col('cocina_stock').doc(String(nextId)).set({
      id: nextId, ingrediente: String(ingrediente).trim(), cantidad: parseFloat(cantidad) || 0,
      unidad: normalizeUnit(unidad), familia: String(familia || '').toUpperCase(),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    await ensureIngredienteCocinaPrecios(ingrediente, unidad);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cocina/stock/:id', async (req, res) => {
  try {
    const { cantidad, ingrediente, unidad, familia } = req.body;
    const upd = { updated_at: new Date().toISOString() };
    if (cantidad !== undefined) upd.cantidad = parseFloat(cantidad) || 0;
    if (ingrediente) upd.ingrediente = String(ingrediente).trim();
    if (unidad) upd.unidad = normalizeUnit(unidad);
    if (familia !== undefined) upd.familia = String(familia || '').toUpperCase();
    await col('cocina_stock').doc(req.params.id).update(upd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cocina/stock/:id', async (req, res) => {
  try {
    await col('cocina_stock').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// COCINA: inventario diario por familias (igual que STOCK/ALMACENES)
app.get('/api/cocina/stock/con-inventario', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.json([]);
  try {
    const [stockSnap, diaSnap, prevSnap] = await Promise.all([
      col('cocina_stock').orderBy('id').get(),
      col('cocina_stock_diario').where('fecha', '==', fecha).get(),
      col('cocina_stock_diario').where('fecha', '==', prevWorkingDay(fecha)).get(),
    ]);
    const diaMap = {};
    diaSnap.docs.forEach(d => { const dd = d.data(); diaMap[Number(dd.item_id)] = dd; });
    const prevMap = {};
    prevSnap.docs.forEach(d => { const dd = d.data(); prevMap[Number(dd.item_id)] = dd; });
    const groups = {};
    stockSnap.docs.forEach(d => {
      const item = d.data();
      const fam = (item.familia || 'SIN CLASIFICAR').toUpperCase();
      const dia = diaMap[Number(item.id)] || {};
      const prev = prevMap[Number(item.id)] || {};
      const apertura = (dia.stock_apertura ?? prev.stock_cierre ?? item.cantidad ?? 0);
      const ingreso = dia.stock_ingreso ?? 0;
      const salida = dia.salida_almacen ?? 0;
      const ventas = dia.total_ventas ?? 0;
      const falta = dia.falta_almacen ?? 0;
      const baja = dia.stock_baja ?? 0;
      const cierre = apertura + ingreso - salida - ventas - falta - baja;
      if (!groups[fam]) groups[fam] = [];
      groups[fam].push({
        id: Number(item.id),
        nombre: item.ingrediente,
        unidad: item.unidad || 'unidad',
        familia: fam,
        cantidad: item.cantidad || 0,
        stock_apertura: apertura,
        stock_ingreso: ingreso,
        salida_almacen: salida,
        total_ventas: ventas,
        falta_almacen: falta,
        stock_baja: baja,
        stock_cierre: Math.round(cierre * 100) / 100,
      });
    });
    res.json(Object.keys(groups).map(f => ({ familia: f, items: groups[f] })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function guardarCocinaDiaInterno(fecha, registros, savedBy) {
  if (!fecha || !Array.isArray(registros)) throw new Error('fecha y registros requeridos');
  const existentes = {};
  await Promise.all(registros.map(async r => {
    const id = docId('cocdia', fecha, r.item_id);
    const snap = await col('cocina_stock_diario').doc(id).get();
    existentes[id] = snap.exists ? snap.data() : {};
  }));
  const batch = db.batch();
  const changedKeys = new Set();
  for (const r of registros) {
    const id = docId('cocdia', fecha, r.item_id);
    const prev = existentes[id] || {};
    const apertura = r.stock_apertura !== undefined ? (parseFloat(r.stock_apertura) || 0) : (prev.stock_apertura || 0);
    const ingreso = r.stock_ingreso !== undefined ? (parseFloat(r.stock_ingreso) || 0) : (prev.stock_ingreso || 0);
    const salida = r.salida_almacen !== undefined ? (parseFloat(r.salida_almacen) || 0) : (prev.salida_almacen || 0);
    const ventas = r.total_ventas !== undefined ? (parseFloat(r.total_ventas) || 0) : (prev.total_ventas || 0);
    const falta = r.falta_almacen !== undefined ? (parseFloat(r.falta_almacen) || 0) : (prev.falta_almacen || 0);
    const baja = r.stock_baja !== undefined ? (parseFloat(r.stock_baja) || 0) : (prev.stock_baja || 0);
    const cierre = Math.round((apertura + ingreso - salida - ventas - falta - baja) * 100) / 100;
    if ((prev.stock_apertura || 0) !== apertura || (prev.stock_cierre || 0) !== cierre) {
      changedKeys.add(Number(r.item_id));
    }
    const data = { fecha, item_id: Number(r.item_id) };
    if (r.stock_apertura !== undefined) data.stock_apertura = apertura;
    if (r.stock_ingreso !== undefined) data.stock_ingreso = ingreso;
    if (r.salida_almacen !== undefined) data.salida_almacen = salida;
    if (r.total_ventas !== undefined) data.total_ventas = ventas;
    if (r.falta_almacen !== undefined) data.falta_almacen = falta;
    if (r.stock_baja !== undefined) data.stock_baja = baja;
    data.stock_cierre = cierre;
    data.saved_by = savedBy;
    data.updated_at = new Date().toISOString();
    batch.set(col('cocina_stock_diario').doc(id), data, { merge: true });
  }
  await batch.commit();

  // Propagación hacia adelante del cierre como apertura del siguiente día hábil
  if (changedKeys.size) {
    const keysArr = Array.from(changedKeys);
    const secuencia = [];
    let srcFecha = fecha;
    for (let i = 0; i < 30; i++) {
      const targetDay = getNextWorkingDay(srcFecha);
      secuencia.push({ src: srcFecha, tgt: targetDay });
      srcFecha = targetDay;
    }
    const prevCierre = {};
    const perDayWrites = {};
    for (const key of keysArr) {
      const itemId = Number(key);
      let cierre = null;
      for (let si = 0; si < secuencia.length; si++) {
        const src = secuencia[si].src;
        const tgt = secuencia[si].tgt;
        if (cierre === null) {
          const srcSnap = await col('cocina_stock_diario').doc(docId('cocdia', src, itemId)).get();
          cierre = srcSnap.exists ? (srcSnap.data().stock_cierre ?? 0) : 0;
        }
        const nextId = docId('cocdia', tgt, itemId);
        const tgtSnap = await col('cocina_stock_diario').doc(nextId).get();
        if (tgtSnap.exists) {
          const t = tgtSnap.data();
          const apertura = prevCierre[itemId] !== undefined ? prevCierre[itemId] : cierre;
          const nuevo = Math.round((apertura + (t.stock_ingreso ?? 0) - (t.salida_almacen ?? 0) - (t.total_ventas ?? 0) - (t.falta_almacen ?? 0) - (t.stock_baja ?? 0)) * 100) / 100;
          prevCierre[itemId] = nuevo;
          if (t.stock_apertura === apertura && t.stock_cierre === nuevo) continue;
          if (!perDayWrites[si]) perDayWrites[si] = [];
          perDayWrites[si].push({ ref: col('cocina_stock_diario').doc(nextId), type: 'update', data: { stock_apertura: apertura, stock_cierre: nuevo, updated_at: new Date().toISOString() } });
        } else {
          const apertura = prevCierre[itemId] !== undefined ? prevCierre[itemId] : cierre;
          prevCierre[itemId] = apertura;
          if (!perDayWrites[si]) perDayWrites[si] = [];
          perDayWrites[si].push({ ref: col('cocina_stock_diario').doc(nextId), type: 'set', data: {
            fecha: tgt, item_id: itemId, stock_apertura: apertura, stock_ingreso: 0, salida_almacen: 0,
            total_ventas: 0, falta_almacen: 0, stock_baja: 0, stock_cierre: apertura, updated_at: new Date().toISOString()
          } });
        }
      }
    }
    const commits = Object.keys(perDayWrites).map(si => {
      const b = db.batch();
      perDayWrites[si].forEach(w => { if (w.type === 'update') b.update(w.ref, w.data); else b.set(w.ref, w.data); });
      return b.commit();
    });
    if (commits.length) await Promise.all(commits);
  }
  return { ok: true };
}

app.post('/api/cocina/stock/guardar-dia', async (req, res) => {
  try {
    const savedBy = req.body.saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
    const result = await guardarCocinaDiaInterno(req.body.fecha, req.body.registros, savedBy);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- COCINA: movimientos (ingresos, salidas, ventas) ---
app.get('/api/cocina/movimientos', authMiddleware, async (req, res) => {
  try {
    const { fecha, tipo } = req.query;
    if (!fecha || !tipo) return res.json([]);
    const snap = await col('cocina_movimientos').where('fecha', '==', fecha).where('tipo', '==', tipo).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ventas de COCINA registradas desde el apartado principal de VENTAS
app.get('/api/cocina/ventas', async (req, res) => {
  try {
    const fecha = req.query.fecha;
    if (!fecha) return res.json([]);
    const snap = await col('cocina_ventas').where('fecha', '==', fecha).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ingresos de COCINA registrados desde COMPRAS/INGRESOS (destino COCINA)
app.get('/api/cocina/compras', async (req, res) => {
  try {
    const fecha = req.query.fecha;
    if (!fecha) return res.json([]);
    const snap = await col('cocina_compras').where('fecha', '==', fecha).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Salidas de STOCKS con destino COCINA (son ingresos de cocina con origen STOCKS)
app.get('/api/cocina/salidas-stock', async (req, res) => {
  try {
    const fecha = req.query.fecha;
    if (!fecha) return res.json([]);
    const invSnap = await col('inventario').get();
    const byKey = {};
    invSnap.docs.forEach(d => { const a = d.data(); byKey[Number(a.item_id) + '_' + Number(a.almacen_id)] = a.nombre; });
    const dia = await col('inventario_diario').where('fecha', '==', fecha).get();
    const out = [];
    dia.docs.forEach(d => {
      const a = d.data();
      if (!((a.salida_almacen || 0) > 0)) return;
      if (String(a.destino_salida || '') !== 'cocina') return;
      const nombre = byKey[Number(a.item_id) + '_' + Number(a.almacen_id)] || String(a.item_id);
      out.push({ fecha, nombre, cantidad: a.salida_almacen, unidad: 'unidad', saved_by: a.saved_by || '-', created_at: a.updated_at || '' });
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Salidas de STOCKS con destino BARRA (son ingresos de barra con origen STOCKS)
app.get('/api/barra/salidas-stock', async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin } = req.query;
    if (!fecha && !(fecha_inicio && fecha_fin)) return res.json([]);
    const invSnap = await col('inventario').get();
    const byKey = {};
    invSnap.docs.forEach(d => { const a = d.data(); byKey[Number(a.item_id) + '_' + Number(a.almacen_id)] = a.nombre; });
    let diasSnap;
    if (fecha) {
      diasSnap = await col('inventario_diario').where('fecha', '==', fecha).get();
    } else {
      if (fecha_inicio > fecha_fin) [fecha_inicio, fecha_fin] = [fecha_fin, fecha_inicio];
      diasSnap = await col('inventario_diario').where('fecha', '>=', fecha_inicio).where('fecha', '<=', fecha_fin).get();
    }
    const agg = {};
    const meta = {};
    diasSnap.docs.forEach(d => {
      const a = d.data();
      if (!((a.salida_almacen || 0) > 0)) return;
      if (String(a.destino_salida || '') !== 'barra') return;
      const nombre = byKey[Number(a.item_id) + '_' + Number(a.almacen_id)] || String(a.item_id);
      agg[nombre] = (agg[nombre] || 0) + (a.salida_almacen || 0);
      if (!meta[nombre]) meta[nombre] = { unidad: 'unidad', saved_by: a.saved_by || '-', created_at: a.updated_at || '' };
    });
    const out = Object.keys(agg).map(nombre => ({
      fecha: fecha || (fecha_inicio + ' a ' + fecha_fin),
      nombre,
      cantidad: agg[nombre],
      unidad: meta[nombre].unidad,
      saved_by: meta[nombre].saved_by,
      created_at: meta[nombre].created_at,
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Suma (o resta) cantidades al stock de cocina; crea el item si no existe
async function ajustarCocinaStock(ajustes) {
  const cs = await col('cocina_stock').get();
  let maxId = cs.docs.length > 0 ? Math.max(...cs.docs.map(d => Number(d.id) || 0)) : 0;
  const byName = {};
  cs.docs.forEach(d => { byName[String(d.data().ingrediente || '').toUpperCase()] = d; });
  const batch = db.batch();
  const now = new Date().toISOString();
  for (const aj of ajustes) {
    const key = String(aj.nombre || '').toUpperCase();
    if (!key || !aj.delta) continue;
    const existente = byName[key];
    if (existente) {
      const nueva = Math.max(0, (parseFloat(existente.data().cantidad) || 0) + aj.delta);
      batch.update(existente.ref, { cantidad: nueva, updated_at: now });
    } else if (aj.delta > 0) {
      maxId++;
      const ref = col('cocina_stock').doc(String(maxId));
      batch.set(ref, { id: maxId, ingrediente: aj.nombre, cantidad: aj.delta, unidad: aj.unidad || 'unidad', familia: 'SIN CLASIFICAR', created_at: now, updated_at: now });
      byName[key] = { ref, data: { cantidad: aj.delta } };
    }
  }
  await batch.commit();
}

// Suma (o resta) cantidades al stock de BARRA; crea el item si no existe
async function ajustarBarraStock(ajustes) {
  const bs = await col('barra_stock').get();
  let maxId = bs.docs.length > 0 ? Math.max(...bs.docs.map(d => Number(d.id) || 0)) : 0;
  const byName = {};
  bs.docs.forEach(d => { byName[String(d.data().ingrediente || '').toUpperCase()] = d; });
  const batch = db.batch();
  const now = new Date().toISOString();
  for (const aj of ajustes) {
    const key = String(aj.nombre || '').toUpperCase();
    if (!key || !aj.delta) continue;
    const existente = byName[key];
    if (existente) {
      const nueva = Math.max(0, (parseFloat(existente.data().cantidad) || 0) + aj.delta);
      batch.update(existente.ref, { cantidad: nueva, updated_at: now });
    } else if (aj.delta > 0) {
      maxId++;
      const ref = col('barra_stock').doc(String(maxId));
      batch.set(ref, { id: maxId, ingrediente: aj.nombre, cantidad: aj.delta, unidad: aj.unidad || 'unidad', grupo: 'MUEBLE DE APOYO', created_at: now, updated_at: now });
      byName[key] = { ref, data: { cantidad: aj.delta } };
    }
  }
  await batch.commit();
}

app.post('/api/cocina/movimientos', authMiddleware, async (req, res) => {
  try {
    const { fecha, tipo, items } = req.body;
    if (!fecha || !tipo || !items) return res.status(400).json({ error: 'fecha, tipo e items requeridos' });
    const batch = db.batch();
    const existing = await col('cocina_movimientos').where('fecha', '==', fecha).where('tipo', '==', tipo).get();

    // Consumo anterior de ventas (idempotencia: al re-guardar se revierte antes de descontar de nuevo)
    let oldConsumo = {};
    if (tipo === 'ventas') {
      existing.docs.forEach(d => {
        const dd = d.data();
        if (dd.es_receta === false) {
          const key = String(dd.ingrediente || '').trim().toUpperCase();
          if (!key) return;
          if (!oldConsumo[key]) oldConsumo[key] = { cant: 0, unidad: dd.unidad || 'unidad', nombre: dd.ingrediente };
          oldConsumo[key].cant += parseFloat(dd.cantidad) || 0;
        }
      });
    }

    existing.docs.forEach(d => batch.delete(d.ref));
    for (const item of items) {
      if (!item.cantidad || item.cantidad <= 0) continue;
      const ref = col('cocina_movimientos').doc();
      const doc = {
        fecha, tipo, ingrediente: item.ingrediente,
        cantidad: item.cantidad, unidad: item.unidad || 'unidad',
        saved_by: req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown',
        created_at: new Date().toISOString()
      };
      if (item.es_receta !== undefined) doc.es_receta = item.es_receta;
      if (item.receta) doc.receta = item.receta;
      if (item.origen) doc.origen = String(item.origen);
      batch.set(ref, doc);
    }
    await batch.commit();

    // Ajustar COCINA/STOCK según el ingreso (suma si existe, agrega si no), revirtiendo lo anterior
    if (tipo === 'ingresos') {
      try {
        const deltas = {};
        existing.docs.forEach(d => {
          const dd = d.data();
          const k = String(dd.ingrediente || '').trim().toUpperCase();
          if (!k) return;
          deltas[k] = (deltas[k] || 0) - (parseFloat(dd.cantidad) || 0);
        });
        items.forEach(it => {
          if (!it.cantidad || it.cantidad <= 0) return;
          const k = String(it.ingrediente || '').trim().toUpperCase();
          if (!k) return;
          deltas[k] = (deltas[k] || 0) + (parseFloat(it.cantidad) || 0);
        });
        // necesitamos el nombre y unidad originales por clave
        const nombres = {};
        const unidades = {};
        existing.docs.forEach(d => { const dd = d.data(); const k = String(dd.ingrediente || '').trim().toUpperCase(); nombres[k] = dd.ingrediente; unidades[k] = dd.unidad || 'unidad'; });
        items.forEach(it => { const k = String(it.ingrediente || '').trim().toUpperCase(); nombres[k] = it.ingrediente; unidades[k] = it.unidad || 'unidad'; });
        const ajustesFiltrados = Object.keys(deltas).map(k => ({ nombre: nombres[k] || k, unidad: unidades[k] || 'unidad', delta: deltas[k] })).filter(a => a.delta !== 0);
        await ajustarCocinaStock(ajustesFiltrados);
      } catch (e) { console.error('Error ajustando cocina stock por ingreso:', e.message); }
    }

    // Descontar el consumo de ventas del stock de cocina (best-effort)
    if (tipo === 'ventas') {
      try {
        const newConsumo = {};
        items.forEach(it => {
          if (it.es_receta === false) {
            const key = String(it.ingrediente || '').trim().toUpperCase();
            if (!key) return;
            if (!newConsumo[key]) newConsumo[key] = { cant: 0, unidad: it.unidad || 'unidad', nombre: it.ingrediente };
            newConsumo[key].cant += parseFloat(it.cantidad) || 0;
          }
        });
        const keys = new Set([...Object.keys(oldConsumo), ...Object.keys(newConsumo)]);
        const stockSnap = await col('cocina_stock').get();
        const stockByName = {};
        const allStock = [];
        stockSnap.docs.forEach(d => {
          const dd = d.data();
          const k = String(dd.ingrediente || '').trim().toUpperCase();
          const entry = { ref: d.ref, key: d.id, data: dd };
          if (!stockByName[k]) stockByName[k] = [];
          stockByName[k].push(entry);
          allStock.push(entry);
        });
        const ajustes = {};
        for (const key of keys) {
          const nc = newConsumo[key];
          const oc = oldConsumo[key];
          const nombre = (nc && nc.nombre) || (oc && oc.nombre) || key;
          const deltaCant = (nc ? nc.cant : 0) - (oc ? oc.cant : 0);
          if (!deltaCant || isNaN(deltaCant)) continue;
          const uni = (nc && nc.unidad) || (oc && oc.unidad) || 'unidad';
          let matches = stockByName[key] || [];
          if (!matches.length) matches = matchStockFuzzy(nombre, allStock);
          if (!matches.length) continue;
          const m = matches[0];
          const stockCant = parseFloat(m.data.cantidad) || 0;
          const conv = cocinaAjustar(deltaCant, uni, m.data.unidad || 'unidad');
          if (conv === null || conv === undefined) continue;
          const nuevaCant = Math.max(0, Math.round((stockCant - conv) * 100) / 100);
          if (!ajustes[m.key]) ajustes[m.key] = { ref: m.ref, nuevaCant };
        }
        const sBatch = db.batch();
        let ajustados = 0;
        for (const id of Object.keys(ajustes)) {
          sBatch.update(ajustes[id].ref, { cantidad: ajustes[id].nuevaCant, updated_at: new Date().toISOString() });
          ajustados++;
        }
        if (ajustados) await sBatch.commit();
      } catch (e) {
        console.error('Error descontando stock de cocina:', e.message);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Conversión de unidades para descuento de stock de cocina (peso y volumen)
function cocinaAjustar(cant, fromUnit, toUnit) {
  const u1 = normalizeUnit(fromUnit);
  const u2 = normalizeUnit(toUnit);
  if (u1 === u2) return parseFloat(cant) || 0;
  const peso = { 'kg': 1000, 'gramos': 1, 'gr': 1, 'onzas': 28.3495 };
  const vol = { 'lt': 1000, 'ml': 1 };
  if (peso[u1] && peso[u2]) return (parseFloat(cant) || 0) * peso[u1] / peso[u2];
  if (vol[u1] && vol[u2]) return (parseFloat(cant) || 0) * vol[u1] / vol[u2];
  return null;
}

// --- COCINA: Recetas ---
app.get('/api/cocina/recetas', async (req, res) => {
  try {
    const [recSnap, ingSnap] = await Promise.all([
      col('cocina_recetas').orderBy('nombre').get(),
      col('cocina_receta_ingredientes').orderBy('id').get(),
    ]);
    const ingByRec = {};
    ingSnap.docs.forEach(idoc => {
      const ing = { id: Number(idoc.id), ...idoc.data() };
      const rid = ing.receta_id;
      if (!ingByRec[rid]) ingByRec[rid] = [];
      ingByRec[rid].push(ing);
    });
    const result = recSnap.docs.map(d => {
      const r = { id: Number(d.id), ...d.data() };
      r.ingredientes = ingByRec[r.id] || [];
      return r;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cocina/recetas', async (req, res) => {
  try {
    const { nombre, categoria } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const n = String(nombre).trim();
    const norm = s => String(s || '').trim().toUpperCase().replace(/[\s-]+/g, ' ');
    const all = await col('cocina_recetas').get();
    // Evitar duplicados por nombre normalizado
    const existente = all.docs.find(d => norm(d.data().nombre) === norm(n));
    if (existente) return res.json({ id: Number(existente.id) || null, nombre: existente.data().nombre, existente: true });
    const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    await col('cocina_recetas').doc(String(nextId)).set({
      id: nextId, nombre: n, categoria: categoria || 'Platos',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    res.json({ id: nextId, nombre: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cocina/recetas/:id', async (req, res) => {
  try {
    const { nombre, categoria } = req.body;
    await col('cocina_recetas').doc(req.params.id).update({
      nombre, categoria: categoria || 'Platos', updated_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cocina/recetas/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ingSnap = await col('cocina_receta_ingredientes').where('receta_id', '==', Number(id)).get();
    const batch = db.batch();
    ingSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(col('cocina_recetas').doc(id));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cocina/recetas/:id/with-ingredientes', async (req, res) => {
  try {
    const { nombre, categoria, ingredientes } = req.body;
    const id = req.params.id;
    await col('cocina_recetas').doc(id).update({
      nombre, categoria: categoria || 'Platos', updated_at: new Date().toISOString()
    });
    const oldSnap = await col('cocina_receta_ingredientes').where('receta_id', '==', Number(id)).get();
    const batch = db.batch();
    oldSnap.docs.forEach(d => batch.delete(d.ref));
    if (ingredientes && ingredientes.length) {
      const all = await col('cocina_receta_ingredientes').get();
      let maxId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) : 0;
      for (const ing of ingredientes) {
        maxId++;
        const ref = col('cocina_receta_ingredientes').doc(String(maxId));
        batch.set(ref, { id: maxId, receta_id: Number(id), ingrediente: ing.ingrediente, cantidad: ing.cantidad || 0, unidad: normalizeUnit(ing.unidad) });
      }
    }
    await batch.commit();
    // Asegurar que los ingredientes existan en la BASE DE DATOS UNIFICADA
    // (si un ingrediente nuevo no está en STOCKS/BARRA/COCINA, se agrega automáticamente sin duplicar)
    if (ingredientes && ingredientes.length) {
      await Promise.all(ingredientes.map(ing => ensureIngredienteEnBaseUnificada(ing.ingrediente, ing.unidad)));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verifica si un nombre ya existe en la base de datos unificada (cualquier zona)
async function ingredienteExisteEnBaseUnificada(nombre) {
  const key = normNombre(nombre);
  if (!key) return true;
  const [stocks, barra, cocina] = await Promise.all([
    col('stock_precios').get(), col('barra_precios').get(), col('cocina_precios').get()
  ]);
  return [stocks, barra, cocina].some(snap => snap.docs.some(d =>
    normNombre(String(d.data().nombre || d.data().ingrediente || '')) === key));
}

// Asegura que el ingrediente esté en la base unificada: si ya existe NO se duplica;
// si no existe se crea en COCINA (cocina_stock + cocina_precios)
async function ensureIngredienteEnBaseUnificada(ingrediente, unidad) {
  const nombre = String(ingrediente || '').trim();
  if (!nombre) return;
  if (await ingredienteExisteEnBaseUnificada(nombre)) return;
  await ensureIngredienteCocinaStock(ingrediente, unidad);
}

async function ensureIngredienteCocinaStock(ingrediente, unidad) {
  const nombre = String(ingrediente || '').trim();
  if (!nombre) return;
  const key = nombre.toUpperCase();
  const snap = await col('cocina_stock').get();
  let found = null;
  snap.docs.forEach(d => { if (String(d.data().ingrediente || '').toUpperCase() === key) found = d; });
  if (!found) {
    const all = await col('cocina_stock').get();
    const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    await col('cocina_stock').doc(String(nextId)).set({
      id: nextId, ingrediente: nombre, cantidad: 0, unidad: normalizeUnit(unidad),
      familia: 'SIN CLASIFICAR', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
  }
  await ensureIngredienteCocinaPrecios(ingrediente, unidad);
}

async function ensureIngredienteCocinaPrecios(ingrediente, unidad) {
  const nombre = String(ingrediente || '').trim();
  if (!nombre) return;
  const key = nombre.toUpperCase();
  const snap = await col('cocina_precios').get();
  let found = null;
  snap.docs.forEach(d => { if (String(d.data().ingrediente || '').toUpperCase() === key) found = d; });
  if (found) return;
  const all = await col('cocina_precios').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('cocina_precios').doc(String(nextId)).set({
    id: nextId, ingrediente: nombre, precio: 0, unidad: normalizeUnit(unidad),
    precio_compra: 0, unidad_compra: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
}

// --- COCINA: Base de Datos (precios) ---
app.get('/api/cocina/precios', async (req, res) => {
  try {
    const snap = await col('cocina_precios').orderBy('ingrediente').get();
    res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cocina/precios', async (req, res) => {
  try {
    const { ingrediente, precio, unidad, precio_compra, unidad_compra } = req.body;
    if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
    const all = await col('cocina_precios').get();
    const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    await col('cocina_precios').doc(String(nextId)).set({
      id: nextId, ingrediente: String(ingrediente).trim(), precio: parseFloat(precio) || 0, unidad: normalizeUnit(unidad),
      precio_compra: parseFloat(precio_compra) || 0, unidad_compra: String(unidad_compra || ''),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    await ensureIngredienteCocinaStock(ingrediente, unidad);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cocina/precios/:id', async (req, res) => {
  try {
    const { precio, precio_compra, unidad_compra, ingrediente, unidad } = req.body;
    const upd = { updated_at: new Date().toISOString() };
    if (precio !== undefined) upd.precio = parseFloat(precio) || 0;
    if (precio_compra !== undefined) upd.precio_compra = parseFloat(precio_compra) || 0;
    if (unidad_compra !== undefined) upd.unidad_compra = String(unidad_compra || '');
    if (ingrediente !== undefined) upd.ingrediente = String(ingrediente).trim();
    if (unidad !== undefined) upd.unidad = normalizeUnit(unidad);
    await col('cocina_precios').doc(req.params.id).update(upd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cocina/precios/:id', async (req, res) => {
  try {
    await col('cocina_precios').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STOCKS: Base de Datos (precios compra/venta) ---
app.get('/api/stock/precios', async (req, res) => {
  try {
    const snap = await col('stock_precios').orderBy('nombre').get();
    res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nombres únicos de items de STOCKS/ALMACENES (fuente para la base de datos, sin duplicados)
app.get('/api/stock/precios/items', async (req, res) => {
  try {
    const snap = await col('inventario').get();
    const seen = new Set();
    const names = [];
    snap.docs.forEach(d => {
      const n = String(d.data().nombre || '').trim();
      const k = n.toUpperCase();
      if (n && !seen.has(k)) { seen.add(k); names.push(n); }
    });
    names.sort((a, b) => a.localeCompare(b));
    res.json(names);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stock/precios', async (req, res) => {
  try {
    const { nombre, unidad, precio, unidad_venta, precio_venta } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const all = await col('stock_precios').get();
    const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    await col('stock_precios').doc(String(nextId)).set({
      id: nextId, nombre: String(nombre).trim(), unidad: String(unidad || 'unidad'),
      precio: parseFloat(precio) || 0, unidad_venta: String(unidad_venta || 'unidad'),
      precio_venta: parseFloat(precio_venta) || 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/stock/precios/:id', async (req, res) => {
  try {
    const { nombre, unidad, precio, unidad_venta, precio_venta } = req.body;
    const upd = { updated_at: new Date().toISOString() };
    if (nombre !== undefined) upd.nombre = String(nombre).trim();
    if (unidad !== undefined) upd.unidad = String(unidad || 'unidad');
    if (precio !== undefined) upd.precio = parseFloat(precio) || 0;
    if (unidad_venta !== undefined) upd.unidad_venta = String(unidad_venta || 'unidad');
    if (precio_venta !== undefined) upd.precio_venta = parseFloat(precio_venta) || 0;
    await col('stock_precios').doc(req.params.id).update(upd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/stock/precios/:id', async (req, res) => {
  try {
    await col('stock_precios').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- BASE DE DATOS UNIFICADA (STOCKS + BARRA + COCINA) ---
app.get('/api/basedatos/unificada', async (req, res) => {
  try {
    const [stocks, barra, cocina, unificada] = await Promise.all([
      col('stock_precios').get(),
      col('barra_precios').get(),
      col('cocina_precios').get(),
      col('base_unificada').get(),
    ]);
    const out = [];
    stocks.docs.forEach(d => {
      const x = d.data();
      out.push({
        id: Number(d.id), origen: 'stock', zona: 'STOCKS',
        nombre: String(x.nombre || '').trim().toUpperCase(), categoria: '',
        unidad_compra: x.unidad || '', precio_compra: x.precio || 0,
        unidad_venta: x.unidad_venta || '', precio_venta: x.precio_venta || 0,
      });
    });
    barra.docs.forEach(d => {
      const x = d.data();
      out.push({
        id: Number(d.id), origen: 'barra', zona: 'BARRA',
        nombre: String(x.ingrediente || '').trim().toUpperCase(), categoria: '',
        unidad_compra: x.unidad_compra || '', precio_compra: x.precio_compra || 0,
        unidad_venta: x.unidad || '', precio_venta: x.precio || 0,
      });
    });
    cocina.docs.forEach(d => {
      const x = d.data();
      out.push({
        id: Number(d.id), origen: 'cocina', zona: 'COCINA',
        nombre: String(x.ingrediente || '').trim().toUpperCase(), categoria: '',
        unidad_compra: x.unidad_compra || '', precio_compra: x.precio_compra || 0,
        unidad_venta: x.unidad || '', precio_venta: x.precio || 0,
      });
    });
    unificada.docs.forEach(d => {
      const x = d.data();
      out.push({
        id: Number(d.id), origen: 'unificada', zona: 'BASE',
        nombre: String(x.nombre || '').trim().toUpperCase(),
        categoria: String(x.categoria || '').trim().toUpperCase(),
        unidad_compra: x.unidad_compra || '', precio_compra: x.precio_compra || 0,
        unidad_venta: x.unidad_venta || '', precio_venta: x.precio_venta || 0,
      });
    });
    out.sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- BASE DE DATOS UNIFICADA: AGREGAR un nuevo item (con categoría) ---
app.post('/api/basedatos/agregar', async (req, res) => {
  try {
    const { nombre, categoria, unidad_compra, precio_compra, unidad_venta, precio_venta } = req.body;
    const nombreClean = String(nombre || '').trim();
    if (!nombreClean) return res.status(400).json({ error: 'Nombre requerido' });
    const key = normNombre(nombreClean);
    // Si ya existe en cualquier zona de la base unificada, no duplicar
    const [stocks, barra, cocina, unif] = await Promise.all([
      col('stock_precios').get(), col('barra_precios').get(), col('cocina_precios').get(), col('base_unificada').get()
    ]);
    const existe = [stocks, barra, cocina, unif].some(snap => snap.docs.some(d =>
      normNombre(String(d.data().nombre || d.data().ingrediente || '')) === key));
    if (existe) return res.json({ ok: false, error: 'Ya existe un item con ese nombre en la base de datos unificada' });
    const all = await col('base_unificada').get();
    const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    await col('base_unificada').doc(String(nextId)).set({
      id: nextId, nombre: nombreClean,
      categoria: String(categoria || '').trim().toUpperCase() || 'COCINA',
      unidad_compra: String(unidad_compra || 'unidad'),
      precio_compra: parseFloat(precio_compra) || 0,
      unidad_venta: String(unidad_venta || 'unidad'),
      precio_venta: parseFloat(precio_venta) || 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- BASE DE DATOS UNIFICADA: editar un item agregado manualmente ---
app.put('/api/basedatos/items/:id', async (req, res) => {
  try {
    const { nombre, categoria, unidad_compra, precio_compra, unidad_venta, precio_venta } = req.body;
    const upd = { updated_at: new Date().toISOString() };
    if (nombre !== undefined) upd.nombre = String(nombre).trim();
    if (categoria !== undefined) upd.categoria = String(categoria || '').trim().toUpperCase();
    if (unidad_compra !== undefined) upd.unidad_compra = String(unidad_compra);
    if (precio_compra !== undefined) upd.precio_compra = parseFloat(precio_compra) || 0;
    if (unidad_venta !== undefined) upd.unidad_venta = String(unidad_venta);
    if (precio_venta !== undefined) upd.precio_venta = parseFloat(precio_venta) || 0;
    await col('base_unificada').doc(String(req.params.id)).update(upd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- BASE DE DATOS UNIFICADA: RENOMBRAR un item y propagarlo por toda la app ---
const COLS_RENOMBRAR = [
  { col: 'inventario', campo: 'nombre' },
  { col: 'items', campo: 'nombre' },
  { col: 'stock_precios', campo: 'nombre' },
  { col: 'barra_precios', campo: 'ingrediente' },
  { col: 'barra_stock', campo: 'ingrediente' },
  { col: 'barra_stock_diario', campo: 'ingrediente' },
  { col: 'barra_movimientos', campo: 'ingrediente' },
  { col: 'cocina_precios', campo: 'ingrediente' },
  { col: 'cocina_stock', campo: 'ingrediente' },
  { col: 'cocina_ventas', campo: 'nombre' },
  { col: 'receta_ingredientes', campo: 'ingrediente' },
  { col: 'ventas', campo: 'nombre' },
  { col: 'base_unificada', campo: 'nombre' },
];
const normNombre = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

async function renombrarEnTodaLaApp(anterior, nuevo) {
  const oldN = normNombre(anterior);
  let docs = 0;
  for (const cfg of COLS_RENOMBRAR) {
    const snap = await col(cfg.col).get();
    let batch = db.batch();
    let ops = 0;
    for (const d of snap.docs) {
      const v = String(d.data()[cfg.campo] || '');
      if (normNombre(v) === oldN && v !== nuevo) {
        batch.update(d.ref, { [cfg.campo]: nuevo, updated_at: new Date().toISOString() });
        ops++; docs++;
        if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
    }
    if (ops) await batch.commit();
  }
  return docs;
}

app.post('/api/basedatos/renombrar', async (req, res) => {
  try {
    const { origen, id, nombre_anterior, nombre_nuevo, unidad_compra, precio_compra, unidad_venta, precio_venta } = req.body;
    if (!origen || !id || !nombre_anterior || !nombre_nuevo) {
      return res.status(400).json({ error: 'origen, id, nombre_anterior y nombre_nuevo son requeridos' });
    }
    const nuevo = String(nombre_nuevo).trim();
    const anterior = String(nombre_anterior).trim();
    const now = new Date().toISOString();

    // 1) Actualizar el item origen (la base de datos de su zona)
    if (origen === 'stock') {
      const upd = { nombre: nuevo, updated_at: now };
      if (unidad_compra !== undefined) upd.unidad = unidad_compra;
      if (precio_compra !== undefined) upd.precio = precio_compra || 0;
      if (unidad_venta !== undefined) upd.unidad_venta = unidad_venta;
      if (precio_venta !== undefined) upd.precio_venta = precio_venta || 0;
      await col('stock_precios').doc(String(id)).update(upd);
    } else if (origen === 'barra') {
      const upd = { ingrediente: nuevo, updated_at: now };
      if (unidad_compra !== undefined) upd.unidad_compra = unidad_compra;
      if (precio_compra !== undefined) upd.precio_compra = precio_compra || 0;
      if (unidad_venta !== undefined) upd.unidad = unidad_venta;
      if (precio_venta !== undefined) upd.precio = precio_venta || 0;
      await col('barra_precios').doc(String(id)).update(upd);
    } else if (origen === 'unificada') {
      const upd = { nombre: nuevo, updated_at: now };
      if (unidad_compra !== undefined) upd.unidad_compra = unidad_compra;
      if (precio_compra !== undefined) upd.precio_compra = precio_compra || 0;
      if (unidad_venta !== undefined) upd.unidad_venta = unidad_venta;
      if (precio_venta !== undefined) upd.precio_venta = precio_venta || 0;
      await col('base_unificada').doc(String(id)).update(upd);
    } else {
      const upd = { ingrediente: nuevo, updated_at: now };
      if (unidad_compra !== undefined) upd.unidad_compra = unidad_compra;
      if (precio_compra !== undefined) upd.precio_compra = precio_compra || 0;
      if (unidad_venta !== undefined) upd.unidad = unidad_venta;
      if (precio_venta !== undefined) upd.precio = precio_venta || 0;
      await col('cocina_precios').doc(String(id)).update(upd);
    }

    // 2) Propagar el nuevo nombre por toda la app (STOCKS, BARRA, COCINA, recetas, ventas)
    const renombrados = await renombrarEnTodaLaApp(anterior, nuevo);

    // 3) Actualizar el emparejamiento del EXCEL de ventas (valores que apuntaban al nombre anterior)
    const mDoc = await col('config').doc('ventas_import_match').get();
    if (mDoc.exists) {
      const match = mDoc.data().match || {};
      let cambio = false;
      Object.keys(match).forEach(k => {
        if (normNombre(match[k]) === normNombre(anterior) && match[k] !== nuevo) { match[k] = nuevo; cambio = true; }
      });
      if (cambio) await col('config').doc('ventas_import_match').set({ match, updated_at: now });
    }

    res.json({ ok: true, renombrados });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- BARRA PRECIOS ---
app.get('/api/barra/precios', async (req, res) => {
  const snap = await col('barra_precios').orderBy('ingrediente').get();
  res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
});

app.post('/api/barra/precios', async (req, res) => {
  const { ingrediente, precio, unidad, precio_compra, unidad_compra, equiv_ml, equiv_gr } = req.body;
  if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
  const all = await col('barra_precios').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  const uni = normalizeUnit(unidad);
  const parsed = uni === 'unidad' ? parseEquivFromName(ingrediente) : {};
  await col('barra_precios').doc(String(nextId)).set({
    id: nextId, ingrediente, precio: precio || 0, unidad: uni,
    precio_compra: precio_compra || 0, unidad_compra: unidad_compra || '',
    equiv_ml: parsed.equiv_ml || 0, equiv_gr: parsed.equiv_gr || 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.put('/api/barra/precios/:id', async (req, res) => {
  const { precio, precio_compra, unidad_compra, ingrediente, unidad } = req.body;
  const updateData = { updated_at: new Date().toISOString() };
  if (precio !== undefined) updateData.precio = precio;
  if (precio_compra !== undefined) updateData.precio_compra = precio_compra;
  if (unidad_compra !== undefined) updateData.unidad_compra = unidad_compra;
  if (unidad !== undefined) updateData.unidad = normalizeUnit(unidad);
  if (ingrediente !== undefined) {
    updateData.ingrediente = ingrediente;
    const curUnit = updateData.unidad || undefined;
    if (!curUnit || curUnit === 'unidad') {
      const parsed = parseEquivFromName(ingrediente);
      if (parsed.equiv_ml) updateData.equiv_ml = parsed.equiv_ml;
      if (parsed.equiv_gr) updateData.equiv_gr = parsed.equiv_gr;
    }
  } else if (unidad !== undefined && normalizeUnit(unidad) !== 'unidad') {
    updateData.equiv_ml = 0;
    updateData.equiv_gr = 0;
  }
  await col('barra_precios').doc(req.params.id).update(updateData);
  res.json({ ok: true });
});

app.delete('/api/barra/precios/:id', async (req, res) => {
  await col('barra_precios').doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- BARRA MOVIMIENTOS (INGRESOS / VENTAS / BAJAS) ---
app.get('/api/barra/movimientos', authMiddleware, async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin, tipo } = req.query;
    if (!tipo) return res.json([]);
    let snap;
    if (fecha_inicio && fecha_fin) {
      if (fecha_inicio > fecha_fin) [fecha_inicio, fecha_fin] = [fecha_fin, fecha_inicio];
      snap = await col('barra_movimientos').where('fecha', '>=', fecha_inicio).where('fecha', '<=', fecha_fin).where('tipo', '==', tipo).get();
    } else if (fecha) {
      snap = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', tipo).get();
    } else {
      return res.json([]);
    }
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Conversión a onzas (misma regla que el frontend: 750ml = 25 onzas, 30ml/onza) ---
function botellaParaMl(nombre) {
  const t = String(nombre || '').toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(ml|cc|l|lt)\b/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return (m[2] === 'ml' || m[2] === 'cc') ? v : v * 1000;
}

function aOnzas(cant, unidad, nombre) {
  const u = normalizeUnit(unidad);
  const c = parseFloat(cant) || 0;
  if (u === 'onzas') return c;
  if (u === 'ml') return c / 30;
  if (u === 'lt') return (c * 1000) / 30;
  if (u === 'gramos') return c / 28.3495;
  if (u === 'kg') return (c * 1000) / 28.3495;
  if (u === 'unidad' || u === 'botella') {
    const ml = botellaParaMl(nombre);
    return ml ? (c * ml) / 30 : null;
  }
  return null;
}

function desdeOnzas(onzas, unidad, nombre) {
  const u = normalizeUnit(unidad);
  const oz = parseFloat(onzas) || 0;
  if (u === 'onzas') return oz;
  if (u === 'ml') return oz * 30;
  if (u === 'lt') return (oz * 30) / 1000;
  if (u === 'gramos') return oz * 28.3495;
  if (u === 'kg') return (oz * 28.3495) / 1000;
  if (u === 'unidad' || u === 'botella') {
    const ml = botellaParaMl(nombre);
    return ml ? (oz * 30) / ml : null;
  }
  return null;
}

// --- Emparejamiento flexible por palabras clave ---
function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/)
    .filter(w => w.length > 1 && !['x', 'de', 'y', 'el', 'la', 'los', 'las', 'con', 'por', 'para', 'del', 'al', 'lt', 'ml', 'cc', 'oz', 'gr', 'kg', 'bot', 'botella', 'bote'].includes(w) && !/^\d/.test(w));
}

function matchStockFuzzy(nombre, stockItems) {
  const ingTok = tokens(nombre);
  if (!ingTok.length) return [];
  const scored = [];
  stockItems.forEach(si => {
    const st = tokens(si.data.ingrediente || si.ingrediente || '');
    if (!st.length) return;
    // Todas las palabras del ingrediente deben estar en el nombre del stock
    if (!ingTok.every(w => st.includes(w))) return;
    scored.push({ item: si, score: ingTok.length / Math.max(1, st.length) });
  });
  scored.sort((a, b) => b.score - a.score || (Number(a.item.id) || 0) - (Number(b.item.id) || 0));
  return scored;
}

// Consumir copas de un item "- COPA" desde los STOCKS (almacenes), con prioridad de
// almacén (Refrigerador Chica Vinos Abajo = 2, luego Almacén General Abajo = 4) y
// conversión automática de BOTELLA -> COPA (1 botella = 5 copas) si no hay copas disponibles.
async function consumirCopaDesdeStocks(fecha, nombre, copas, savedBy, destino) {
  if (!fecha || !copas || copas <= 0) return;
  const base = String(nombre).replace(/ - COPA$/i, '');
  const botNombre = base + ' - BOTELLA';
  const prioridad = [2, 4];
  const invSnap = await col('inventario').get();
  const copaInv = invSnap.docs
    .filter(d => String(d.data().nombre || '').trim().toUpperCase() === String(nombre).trim().toUpperCase())
    .sort((a, b) => {
      const pa = prioridad.indexOf(Number(a.data().almacen_id));
      const pb = prioridad.indexOf(Number(b.data().almacen_id));
      return (pa === -1 ? 10 : pa) - (pb === -1 ? 10 : pb);
    });
  if (!copaInv.length) return;
  const diaSnap = await col('inventario_diario').where('fecha', '==', fecha).get();
  const dayDocs = {};
  diaSnap.docs.forEach(d => { dayDocs[d.id] = d.data(); });
  let restante = copas;
  const registros = [];
  for (const inv of copaInv) {
    if (restante <= 0) break;
    const al = Number(inv.data().almacen_id);
    const item = Number(inv.data().item_id);
    const diaId = fecha + '_' + al + '_' + item;
    const dp = dayDocs[diaId] || {};
    const disp = (dp.stock_apertura || 0) + (dp.stock_ingreso || 0) - (dp.salida_almacen || 0) - (dp.total_ventas || 0) - (dp.falta_almacen || 0) - (dp.stock_baja || 0);
    if (disp >= restante) {
      registros.push({ item_id: item, almacen_id: al, salida_almacen: (dp.salida_almacen || 0) + restante, destino_salida: destino || '' });
      restante = 0;
    } else {
      const botInv = invSnap.docs.find(dd => Number(dd.data().almacen_id) === al && String(dd.data().nombre || '').trim().toUpperCase() === botNombre.trim().toUpperCase());
      const dbot = botInv ? (dayDocs[fecha + '_' + al + '_' + Number(botInv.data().item_id)] || {}) : null;
      const dispBot = dbot ? (dbot.stock_apertura || 0) + (dbot.stock_ingreso || 0) - (dbot.salida_almacen || 0) - (dbot.total_ventas || 0) - (dbot.falta_almacen || 0) - (dbot.stock_baja || 0) : 0;
      const botellasNecesarias = Math.ceil((restante - disp) / 5);
      const aAbrir = botInv ? Math.min(botellasNecesarias, Math.max(0, dispBot)) : 0;
      if (aAbrir > 0) {
        const copasGanadas = aAbrir * 5;
        const nuevoIngreso = (dp.stock_ingreso || 0) + copasGanadas;
        const origen = (Array.isArray(dp.ingreso_origen) ? dp.ingreso_origen.filter(o => o.tipo !== 'conversion').map(o => ({ tipo: o.tipo, almacen_id: o.almacen_id, cantidad: o.cantidad })) : []);
        origen.push({ tipo: 'conversion', cantidad: copasGanadas });
        registros.push({ item_id: item, almacen_id: al, stock_ingreso: nuevoIngreso, salida_almacen: (dp.salida_almacen || 0) + restante, ingreso_origen: origen, destino_salida: destino || '' });
        // La botella abierta es una CONVERSION a copas (1 botella = 5 copas): destino COPAS
        registros.push({ item_id: Number(botInv.data().item_id), almacen_id: al, salida_almacen: (dbot.salida_almacen || 0) + aAbrir, destino_salida: 'COPAS' });
        restante = 0;
      } else if (disp > 0) {
        registros.push({ item_id: item, almacen_id: al, salida_almacen: (dp.salida_almacen || 0) + disp, destino_salida: destino || '' });
        restante -= disp;
      }
    }
  }
  if (registros.length) await guardarDiaInterno(fecha, registros, savedBy);
}

app.post('/api/barra/movimientos', authMiddleware, async (req, res) => {
  try {
    const { fecha, tipo, items } = req.body;
    if (!fecha || !tipo || !items) return res.status(400).json({ error: 'fecha, tipo e items requeridos' });

    const batch = db.batch();
    // Consulta única: movimientos existentes (se usan para consumo anterior y para borrar)
    const existing = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', tipo).get();

    // Consumo anterior de ventas (para que el descuento de stock sea idempotente al re-guardar)
    let oldConsumo = {};
    if (tipo === 'ventas') {
      existing.docs.forEach(d => {
        const dd = d.data();
        if (dd.es_receta === false) {
          const key = String(dd.ingrediente || '').trim().toUpperCase();
          if (!key) return;
          if (!oldConsumo[key]) oldConsumo[key] = { cant: 0, unidad: dd.unidad || 'onzas', nombre: dd.ingrediente };
          oldConsumo[key].cant += parseFloat(dd.cantidad) || 0;
        }
      });
    }

    // Delete existing movements for this fecha+tipo
    existing.docs.forEach(d => batch.delete(d.ref));
    // Insert new movements
    for (const item of items) {
      if (!item.cantidad || item.cantidad <= 0) continue;
      const ref = col('barra_movimientos').doc();
      const doc = {
        fecha, tipo, ingrediente: item.ingrediente,
        cantidad: item.cantidad, unidad: item.unidad || 'unidad',
        saved_by: req.user?.name || req.user?.email || 'unknown',
        created_at: new Date().toISOString()
      };
      if (item.es_receta !== undefined) doc.es_receta = item.es_receta;
      if (item.receta) doc.receta = item.receta;
      if (item.origen) doc.origen = String(item.origen);
      batch.set(ref, doc);
    }
    await batch.commit();

    // Descontar consumo de ventas del stock de barra (best-effort: nunca bloquea el guardado)
    if (tipo === 'ventas') {
      try {
        const newConsumo = {};
        items.forEach(it => {
          if (it.es_receta === false) {
            const key = String(it.ingrediente || '').trim().toUpperCase();
            if (!key) return;
            if (!newConsumo[key]) newConsumo[key] = { cant: 0, unidad: it.unidad || 'onzas', nombre: it.ingrediente, receta: it.receta };
            newConsumo[key].cant += parseFloat(it.cantidad) || 0;
          }
        });
        const keys = new Set([...Object.keys(oldConsumo), ...Object.keys(newConsumo)]);
        const stockSnap = await col('barra_stock').get();
        const stockByName = {};
        const allStock = [];
        stockSnap.docs.forEach(d => {
          const dd = d.data();
          const k = String(dd.ingrediente || '').trim().toUpperCase();
          const entry = { ref: d.ref, key: d.id, data: dd };
          if (!stockByName[k]) stockByName[k] = [];
          stockByName[k].push(entry);
          allStock.push(entry);
        });
        // Acumular el descuento por item de stock (evita doble escritura del mismo doc en el batch)
        const ajustes = {};
        const onzasStock = (dd) => aOnzas(dd.cantidad, dd.unidad, dd.ingrediente);
        for (const key of keys) {
          const nc = newConsumo[key];
          const oc = oldConsumo[key];
          const nombre = (nc && nc.nombre) || (oc && oc.nombre) || key;
          // Items "- COPA": el stock se jala de los STOCKS (almacenes), con conversión BOTELLA->COPA
          if (/ - COPA$/i.test(nombre)) {
            const copas = Math.max(0, (nc ? nc.cant : 0) - (oc ? oc.cant : 0));
            if (copas > 0) await consumirCopaDesdeStocks(fecha, nombre, copas, savedBy, (nc && nc.receta) || (oc && oc.receta));
            continue;
          }
          const deltaOz = aOnzas(nc ? nc.cant : 0, nc ? nc.unidad : 'onzas', nombre) - aOnzas(oc ? oc.cant : 0, oc ? oc.unidad : 'onzas', nombre);
          if (!deltaOz || isNaN(deltaOz)) continue;

          // 1) Candidatos con el MISMO nombre (en todos los muebles)
          const exactos = (stockByName[key] || []).slice();
          let pool = exactos.filter(e => onzasStock(e.data) > 0);
          // 2) Si no hay exactos con stock, buscar OTRAS presentaciones del mismo producto (fuzzy) en todos los muebles
          if (!pool.length) {
            const alternos = matchStockFuzzy(nombre, allStock)
              .map(m => m.item)
              .filter(ent => String(ent.data.ingrediente || '').trim().toUpperCase() !== key && onzasStock(ent.data) > 0);
            pool = alternos.length ? alternos : (exactos.length ? exactos : alternos);
          }
          if (!pool.length) continue;

          // 3) Repartir el consumo entre los que tienen stock; el resto va al primero (permite negativo
          //    solo si no hubo stock suficiente en ninguna presentación/mueble)
          let restante = deltaOz;
          for (const e of pool) {
            if (Math.abs(restante) < 0.0001) break;
            const oz = onzasStock(e.data);
            const aDescontar = restante > 0 ? Math.min(oz, restante) : Math.max(-oz, restante);
            if (!ajustes[e.key]) ajustes[e.key] = { ref: e.ref, deltaOz: 0 };
            ajustes[e.key].deltaOz += aDescontar;
            restante -= aDescontar;
          }
          if (Math.abs(restante) > 0.0001 && pool.length) {
            const e = pool[0];
            if (!ajustes[e.key]) ajustes[e.key] = { ref: e.ref, deltaOz: 0 };
            ajustes[e.key].deltaOz += restante;
          }
        }
        // Aplicar los ajustes (una sola escritura por documento)
        const sBatch = db.batch();
        let ajustados = 0;
        for (const id of Object.keys(ajustes)) {
          const aj = ajustes[id];
          const stockDoc = allStock.find(s => s.key === id);
          if (!stockDoc) continue;
          const ozItem = aOnzas(stockDoc.data.cantidad, stockDoc.data.unidad, stockDoc.data.ingrediente);
          if (ozItem === null || isNaN(ozItem)) continue;
          const nuevoOz = ozItem - aj.deltaOz;
          const nuevaCant = Math.round(desdeOnzas(nuevoOz, stockDoc.data.unidad, stockDoc.data.ingrediente) * 100) / 100;
          sBatch.update(aj.ref, { cantidad: nuevaCant, updated_at: new Date().toISOString() });
          ajustados++;
        }
        if (ajustados) await sBatch.commit();
      } catch (e) {
        console.error('Error descontando stock de ventas:', e.message);
      }
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Consumo de ventas que NO tiene item de stock registrado (para la sección informativa)
app.get('/api/barra/consumo-no-registrado', async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const fecha = req.query.fecha || hoy;
    // Fuente de stock: hoy -> barra_stock; fecha pasada -> snapshot diario
    let stockDocs = [];
    if (fecha && fecha !== hoy) {
      const snap = await col('barra_stock_diario').where('fecha', '==', fecha).get();
      stockDocs = snap.docs.map(d => d.data());
    } else {
      const snap = await col('barra_stock').get();
      stockDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    // Consumo de ventas de la fecha
    const movSnap = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', 'ventas').get();
    const consumo = {};
    movSnap.docs.forEach(d => {
      const a = d.data();
      if (a.es_receta === false) {
        const key = String(a.ingrediente || '').trim().toUpperCase();
        if (!key) return;
        if (!consumo[key]) consumo[key] = { cant: 0, unidad: a.unidad || 'onzas', nombre: a.ingrediente };
        consumo[key].cant += parseFloat(a.cantidad) || 0;
      }
    });
    const stockItems = stockDocs.map((s, i) => ({ id: i, data: s }));
    const noRegistrados = [];
    for (const key of Object.keys(consumo)) {
      const c = consumo[key];
      const exact = stockDocs.some(s => String(s.ingrediente || '').trim().toUpperCase() === key);
      const fuzzy = !exact ? matchStockFuzzy(c.nombre, stockItems) : [];
      if (!exact && !fuzzy.length) {
        noRegistrados.push({ ingrediente: c.nombre, cantidad: c.cant, unidad: c.unidad });
      }
    }
    res.json({ fecha, noRegistrados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/reportes/diferencias', async (req, res) => {
  let fechaInicio = req.query.fecha_inicio;
  let fechaFin = req.query.fecha_fin;
  if (!fechaInicio || !fechaFin) {
    const fecha = req.query.fecha;
    if (!fecha) return res.json([]);
    fechaInicio = fechaFin = fecha;
  }
  if (fechaInicio > fechaFin) [fechaInicio, fechaFin] = [fechaFin, fechaInicio];
  const [almsSnap, allInvSnap, allDiasSnap] = await Promise.all([
    col('almacenes').orderBy('orden').get(),
    col('inventario').get(),
    col('inventario_diario')
      .where('fecha', '>=', fechaInicio)
      .where('fecha', '<=', fechaFin)
      .get(),
  ]);
  const invByAl = {};
  allInvSnap.docs.forEach(d => {
    const inv = d.data();
    if (!invByAl[inv.almacen_id]) invByAl[inv.almacen_id] = [];
    invByAl[inv.almacen_id].push(inv);
  });
  // Aggregate across date range per (almacen_id, item_id)
  const agg = {};
  allDiasSnap.docs.forEach(d => {
    const dd = d.data();
    const key = dd.almacen_id + '_' + dd.item_id;
    if (!agg[key]) {
      agg[key] = {
        almacen_id: dd.almacen_id,
        item_id: dd.item_id,
        stock_apertura: dd.stock_apertura ?? 0,
        stock_ingreso: 0, salida_almacen: 0, total_ventas: 0, falta_almacen: 0, stock_baja: 0,
        firstFecha: dd.fecha,
      };
    }
    agg[key].stock_ingreso += dd.stock_ingreso ?? 0;
    agg[key].salida_almacen += dd.salida_almacen ?? 0;
    agg[key].total_ventas += dd.total_ventas ?? 0;
    agg[key].falta_almacen += dd.falta_almacen ?? 0;
    agg[key].stock_baja += dd.stock_baja ?? 0;
    // keep first day's stock_apertura (opening stock at start of range)
  });
  const result = [];
  for (const alDoc of almsSnap.docs) {
    const alId = Number(alDoc.id);
    for (const inv of (invByAl[alId] || [])) {
      const key = alId + '_' + inv.item_id;
      const a = agg[key];
      const apertura = a ? a.stock_apertura : 0;
      const ingreso = a ? a.stock_ingreso : 0;
      const salida = a ? a.salida_almacen : 0;
      const ventas = a ? a.total_ventas : 0;
      const falta = a ? a.falta_almacen : 0;
      const baja = a ? a.stock_baja : 0;
      const cierre = apertura + ingreso - salida - ventas - falta - baja;
      const minima = inv.cantidad_minima || 0;
      const diferencia = cierre - minima;
      result.push({
        nombre: inv.nombre,
        almacen_id: alId,
        almacen_nombre: alDoc.data().nombre,
        stock_apertura: apertura,
        stock_ingreso: ingreso,
        salida_almacen: salida,
        total_ventas: ventas,
        falta_almacen: falta,
        stock_baja: baja,
        stock_cierre: Math.round(cierre * 100) / 100,
        cantidad_minima: minima,
        diferencia: Math.round(diferencia * 100) / 100,
      });
    }
  }
  res.json(result);
});

// --- ACCIONES en REPORTES: items con FALTA por día (para poder convertirlos) ---
app.get('/api/reportes/faltantes', async (req, res) => {
  try {
    let fechaInicio = req.query.fecha_inicio;
    let fechaFin = req.query.fecha_fin;
    if (!fechaInicio || !fechaFin) return res.json([]);
    if (fechaInicio > fechaFin) [fechaInicio, fechaFin] = [fechaFin, fechaInicio];
    const [almsSnap, invSnap, diasSnap] = await Promise.all([
      col('almacenes').get(),
      col('inventario').get(),
      col('inventario_diario').where('fecha', '>=', fechaInicio).where('fecha', '<=', fechaFin).get(),
    ]);
    const alNombre = {};
    almsSnap.docs.forEach(d => { alNombre[Number(d.id)] = d.data().nombre; });
    const invByKey = {};
    invSnap.docs.forEach(d => { const a = d.data(); invByKey[Number(a.almacen_id) + '_' + Number(a.item_id)] = a; });
    const out = [];
    diasSnap.docs.forEach(d => {
      const a = d.data();
      const f = a.falta_almacen || 0;
      if (f > 0) {
        const inv = invByKey[Number(a.almacen_id) + '_' + Number(a.item_id)];
        out.push({
          fecha: a.fecha,
          almacen_id: Number(a.almacen_id),
          almacen_nombre: alNombre[Number(a.almacen_id)] || 'Almacén ' + a.almacen_id,
          item_id: Number(a.item_id),
          nombre: inv ? inv.nombre : String(a.item_id),
          falta: f,
        });
      }
    });
    out.sort((x, y) => String(y.fecha).localeCompare(String(x.fecha)));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ACCION en REPORTES: convertir FALTA en SALIDA A COCINA (registrada el dia real) ---
app.post('/api/reportes/accion/salida-cocina', async (req, res) => {
  try {
    const { fecha_falta, fecha_salida, item_id, almacen_id, cantidad, saved_by } = req.body;
    if (!fecha_falta || !fecha_salida || !item_id || !almacen_id || !(Number(cantidad) > 0)) {
      return res.status(400).json({ error: 'fecha_falta, fecha_salida, item_id, almacen_id y cantidad son requeridos' });
    }
    const savedBy = saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
    const al = Number(almacen_id);
    const item = Number(item_id);
    const redondear = n => Math.round(n * 100) / 100;

    const diaSalidaId = docId('invdiario', fecha_salida, al, item);
    const diaFaltaId = docId('invdiario', fecha_falta, al, item);
    const [diaSalidaSnap, diaFaltaSnap] = await Promise.all([
      col('inventario_diario').doc(diaSalidaId).get(),
      col('inventario_diario').doc(diaFaltaId).get(),
    ]);
    const curSalida = diaSalidaSnap.exists ? (diaSalidaSnap.data().salida_almacen || 0) : 0;
    const curFalta = diaFaltaSnap.exists ? (diaFaltaSnap.data().falta_almacen || 0) : 0;
    const aMover = redondear(Math.min(Number(cantidad), curFalta));
    if (aMover <= 0) return res.status(400).json({ error: 'El item no tiene falta en la fecha indicada' });

    // Apertura para el día real de salida si aún no tiene registro diario
    let stockApertura = null;
    if (!diaSalidaSnap.exists) {
      let prevF = prevWorkingDay(fecha_salida);
      for (let i = 0; i < 8; i++) {
        const p = await col('inventario_diario').doc(docId('invdiario', prevF, al, item)).get();
        if (p.exists) { stockApertura = p.data().stock_cierre ?? 0; break; }
        prevF = prevWorkingDay(prevF);
      }
      if (stockApertura === null) {
        const invSnap = await col('inventario').get();
        const inv = invSnap.docs.find(d => Number(d.data().item_id) === item && Number(d.data().almacen_id) === al);
        stockApertura = inv ? (inv.data().stock_apertura || 0) : 0;
      }
    }

    // 1) Registrar la salida a COCINA en el día real
    const regSalida = {
      item_id: item, almacen_id: al,
      salida_almacen: redondear(curSalida + aMover),
      destino_salida: 'cocina',
    };
    if (stockApertura !== null) regSalida.stock_apertura = stockApertura;
    await guardarDiaInterno(fecha_salida, [regSalida], savedBy);

    // 2) Quitar la falta del día donde se detectó
    await guardarDiaInterno(fecha_falta, [{
      item_id: item, almacen_id: al,
      falta_almacen: redondear(curFalta - aMover),
    }], savedBy);

    res.json({ ok: true, movido: aMover, nueva_falta: redondear(curFalta - aMover) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ACCION en REPORTES: convertir FALTA en DAR DE BAJA (se registra en STOCK/BAJAS) ---
app.post('/api/reportes/accion/baja', async (req, res) => {
  try {
    const { fecha, item_id, almacen_id, cantidad, saved_by } = req.body;
    if (!fecha || !item_id || !almacen_id || !(Number(cantidad) > 0)) {
      return res.status(400).json({ error: 'fecha, item_id, almacen_id y cantidad son requeridos' });
    }
    const savedBy = saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
    const al = Number(almacen_id);
    const item = Number(item_id);
    const redondear = n => Math.round(n * 100) / 100;
    const diaId = docId('invdiario', fecha, al, item);
    const diaSnap = await col('inventario_diario').doc(diaId).get();
    const x = diaSnap.exists ? diaSnap.data() : {};
    const curFalta = x.falta_almacen || 0;
    const aMover = redondear(Math.min(Number(cantidad), curFalta));
    if (aMover <= 0) return res.status(400).json({ error: 'El item no tiene falta en la fecha indicada' });
    const reg = {
      item_id: item, almacen_id: al,
      stock_baja: redondear((x.stock_baja || 0) + aMover),
      nota_baja: x.nota_baja ? (x.nota_baja + '; BAJA POR FALTA') : 'BAJA POR FALTA',
      falta_almacen: redondear(curFalta - aMover),
    };
    await guardarDiaInterno(fecha, [reg], savedBy);
    res.json({ ok: true, movido: aMover, nueva_falta: redondear(curFalta - aMover) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ACCION en REPORTES: convertir FALTA en OBSERVACION (cuarentena).
// --- El item queda en observación; usarlo como venta es MANUAL (accion "usar-venta"). ---
app.post('/api/reportes/accion/observacion', async (req, res) => {
  try {
    const { fecha, item_id, almacen_id, cantidad, saved_by } = req.body;
    if (!fecha || !item_id || !almacen_id || !(Number(cantidad) > 0)) {
      return res.status(400).json({ error: 'fecha, item_id, almacen_id y cantidad son requeridos' });
    }
    const savedBy = saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
    const al = Number(almacen_id);
    const item = Number(item_id);
    const redondear = n => Math.round(n * 100) / 100;
    const diaId = docId('invdiario', fecha, al, item);
    const diaSnap = await col('inventario_diario').doc(diaId).get();
    const x = diaSnap.exists ? diaSnap.data() : {};
    const curFalta = x.falta_almacen || 0;
    const aMover = redondear(Math.min(Number(cantidad), curFalta));
    if (aMover <= 0) return res.status(400).json({ error: 'El item no tiene falta en la fecha indicada' });
    const nuevoObservado = redondear((x.stock_observado || 0) + aMover);
    await guardarDiaInterno(fecha, [{
      item_id: item, almacen_id: al,
      falta_almacen: redondear(curFalta - aMover),
      stock_observado: nuevoObservado,
    }], savedBy);
    res.json({ ok: true, movido: aMover, stock_observado: nuevoObservado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- CUARENTENA: lista de items en observación (almacén + fecha + cantidad) ---
app.get('/api/reportes/cuarentena', async (req, res) => {
  try {
    const [almsSnap, invSnap, diasSnap] = await Promise.all([
      col('almacenes').get(),
      col('inventario').get(),
      col('inventario_diario').where('stock_observado', '>', 0).get(),
    ]);
    const alNombre = {};
    almsSnap.docs.forEach(d => { alNombre[Number(d.id)] = d.data().nombre; });
    const invByKey = {};
    invSnap.docs.forEach(d => { const a = d.data(); invByKey[Number(a.almacen_id) + '_' + Number(a.item_id)] = a; });
    const out = [];
    diasSnap.docs.forEach(d => {
      const a = d.data();
      const obs = a.stock_observado || 0;
      if (obs > 0) {
        const inv = invByKey[Number(a.almacen_id) + '_' + Number(a.item_id)];
        out.push({
          fecha: a.fecha,
          almacen_id: Number(a.almacen_id),
          almacen_nombre: alNombre[Number(a.almacen_id)] || 'Almacén ' + a.almacen_id,
          item_id: Number(a.item_id),
          nombre: inv ? inv.nombre : String(a.item_id),
          cantidad: obs,
        });
      }
    });
    out.sort((x, y) => String(y.fecha).localeCompare(String(x.fecha)));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ACCION en REPORTES: USAR COMO VENTA (manual) un item en observación ---
app.post('/api/reportes/accion/usar-venta', async (req, res) => {
  try {
    const { fecha_observacion, fecha_venta, item_id, almacen_id, cantidad, saved_by } = req.body;
    if (!fecha_observacion || !fecha_venta || !item_id || !almacen_id || !(Number(cantidad) > 0)) {
      return res.status(400).json({ error: 'fecha_observacion, fecha_venta, item_id, almacen_id y cantidad son requeridos' });
    }
    const savedBy = saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
    const al = Number(almacen_id);
    const item = Number(item_id);
    const redondear = n => Math.round(n * 100) / 100;

    const diaObsId = docId('invdiario', fecha_observacion, al, item);
    const obsSnap = await col('inventario_diario').doc(diaObsId).get();
    const curObs = obsSnap.exists ? (obsSnap.data().stock_observado || 0) : 0;
    const aMover = redondear(Math.min(Number(cantidad), curObs));
    if (aMover <= 0) return res.status(400).json({ error: 'El item no tiene stock en observación en la fecha indicada' });

    // 1) Liberar la observación
    await guardarDiaInterno(fecha_observacion, [{
      item_id: item, almacen_id: al,
      stock_observado: redondear(curObs - aMover),
    }], savedBy);

    // 2) Registrar la venta en la fecha indicada
    const diaVentaId = docId('invdiario', fecha_venta, al, item);
    const ventaSnap = await col('inventario_diario').doc(diaVentaId).get();
    const curVentas = ventaSnap.exists ? (ventaSnap.data().total_ventas || 0) : 0;
    let stockApertura = null;
    if (!ventaSnap.exists) {
      let prevF = prevWorkingDay(fecha_venta);
      for (let i = 0; i < 8; i++) {
        const p = await col('inventario_diario').doc(docId('invdiario', prevF, al, item)).get();
        if (p.exists) { stockApertura = p.data().stock_cierre ?? 0; break; }
        prevF = prevWorkingDay(prevF);
      }
      if (stockApertura === null) {
        const invSnap = await col('inventario').get();
        const inv = invSnap.docs.find(dd => Number(dd.data().item_id) === item && Number(dd.data().almacen_id) === al);
        stockApertura = inv ? (inv.data().stock_apertura || 0) : 0;
      }
    }
    const regVenta = { item_id: item, almacen_id: al, total_ventas: redondear(curVentas + aMover) };
    if (stockApertura !== null) regVenta.stock_apertura = stockApertura;
    await guardarDiaInterno(fecha_venta, [regVenta], savedBy);

    res.json({ ok: true, movido: aMover });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ACCION en CUARENTENA: SACAR de cuarentena y devolver a REPORTES como FALTA ---
app.post('/api/reportes/accion/sacar-cuarentena', async (req, res) => {
  try {
    const { fecha, item_id, almacen_id, cantidad, saved_by } = req.body;
    if (!fecha || !item_id || !almacen_id || !(Number(cantidad) > 0)) {
      return res.status(400).json({ error: 'fecha, item_id, almacen_id y cantidad son requeridos' });
    }
    const savedBy = saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
    const al = Number(almacen_id);
    const item = Number(item_id);
    const redondear = n => Math.round(n * 100) / 100;

    const diaId = docId('invdiario', fecha, al, item);
    const diaSnap = await col('inventario_diario').doc(diaId).get();
    const x = diaSnap.exists ? diaSnap.data() : {};
    const curObs = x.stock_observado || 0;
    const aMover = redondear(Math.min(Number(cantidad), curObs));
    if (aMover <= 0) return res.status(400).json({ error: 'El item no tiene stock en observación en la fecha indicada' });

    // Liberar de cuarentena y devolver como FALTA (vuelve a REPORTES/FALTANTES)
    await guardarDiaInterno(fecha, [{
      item_id: item, almacen_id: al,
      stock_observado: redondear(curObs - aMover),
      falta_almacen: redondear((x.falta_almacen || 0) + aMover),
    }], savedBy);

    res.json({ ok: true, movido: aMover });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AUTH CHECK ---
app.get('/api/check-auth', authMiddleware, (req, res) => {
  res.json({ ok: true, name: req.user.name || null, email: req.user.email });
});

// --- SET DISPLAY NAME (one-time use per user) ---
app.post('/api/setup/display-name', authMiddleware, async (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName) return res.status(400).json({ error: 'displayName requerido' });
    await admin.auth().updateUser(req.user.uid, { displayName });
    res.json({ ok: true, displayName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- List registered users ---
app.get('/api/auth/users', authMiddleware, async (req, res) => {
  try {
    const list = await admin.auth().listUsers(1000);
    const users = list.users.map(u => ({
      uid: u.uid,
      email: u.email,
      displayName: u.displayName || null,
    }));
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function normalizeUnit(u) {
  if (!u) return 'unidad';
  const lower = u.trim().toLowerCase();
  const map = { 'oz': 'onzas', 'onz': 'onzas', 'und': 'unidad', 'unidades': 'unidad', 'gr': 'gramos', 'gramo': 'gramos' };
  return map[lower] || lower;
}

function getUnitToMl(unit) {
  const map = { 'ml': 1, 'lt': 1000, 'onzas': 29.5735, 'gotas': 0.05 };
  return map[normalizeUnit(unit)] || 0;
}

function getUnitToGr(unit) {
  const map = { 'gramos': 1, 'kg': 1000, 'onzas': 28.3495 };
  return map[normalizeUnit(unit)] || 0;
}

function parseEquivFromName(name) {
  if (!name) return {};
  const m = name.match(/x\s*(\d+(?:\.\d+)?)\s*(L|LT|LTS|ML|KG|GR|G|OZ|ONZAS?|LITRO|LITROS|KILO|KILOS|GRAMO|GRAMOS)\b/i);
  if (!m) return {};
  const qty = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (['l', 'lt', 'lts', 'litro', 'litros'].includes(u)) return { equiv_ml: qty * 1000 };
  if (['ml'].includes(u)) return { equiv_ml: qty };
  if (['kg', 'kilo', 'kilos'].includes(u)) return { equiv_gr: qty * 1000 };
  if (['gr', 'g', 'gramo', 'gramos'].includes(u)) return { equiv_gr: qty };
  if (['oz', 'onza', 'onzas'].includes(u)) return { equiv_ml: qty * 29.5735 };
  return {};
}

function calcularCosto(cantidad, unidadReceta, precioItem, unidadItem, equivMl, equivGr, nombreItem) {
  unidadReceta = normalizeUnit(unidadReceta);
  unidadItem = normalizeUnit(unidadItem);
  if (!unidadReceta || !unidadItem) return { costo: (cantidad || 0) * (precioItem || 0), converted: false };
  if (unidadReceta === unidadItem) return { costo: (cantidad || 0) * (precioItem || 0), converted: false };
  if (unidadReceta === 'unidad') return { costo: (cantidad || 0) * (precioItem || 0), converted: false };

  if (unidadItem === 'unidad') {
    if (!equivMl && !equivGr && nombreItem) {
      const parsed = parseEquivFromName(nombreItem);
      equivMl = parsed.equiv_ml;
      equivGr = parsed.equiv_gr;
    }
  } else {
    equivMl = 0;
    equivGr = 0;
  }

  if (equivMl || getUnitToMl(unidadItem)) {
    const mlReceta = (cantidad || 0) * getUnitToMl(unidadReceta);
    const mlItem = equivMl || getUnitToMl(unidadItem);
    if (mlReceta > 0 && mlItem > 0) return { costo: (mlReceta / mlItem) * (precioItem || 0), converted: true };
  }

  if (equivGr || getUnitToGr(unidadItem)) {
    const grReceta = (cantidad || 0) * getUnitToGr(unidadReceta);
    const grItem = equivGr || getUnitToGr(unidadItem);
    if (grReceta > 0 && grItem > 0) return { costo: (grReceta / grItem) * (precioItem || 0), converted: true };
  }

  return { costo: (cantidad || 0) * (precioItem || 0), converted: false };
}

// --- Normalize units across all collections ---
app.post('/api/migrate/normalize-units', authMiddleware, async (req, res) => {
  try {
    const collections = ['receta_ingredientes', 'barra_stock', 'barra_precios'];
    let total = 0;
    for (const collName of collections) {
      const snap = await col(collName).get();
      const batch = db.batch();
      let count = 0;
      snap.docs.forEach(d => {
        const data = d.data();
        const original = data.unidad || 'unidad';
        const normalized = normalizeUnit(original);
        if (original !== normalized) {
          batch.update(d.ref, { unidad: normalized });
          count++;
        }
      });
      if (count > 0) await batch.commit();
      total += count;
    }
    res.json({ ok: true, updated: total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Import RECETAS BASE from spreadsheet data ---
const recetasBase = [
  { nombre: 'JARABE DE GOMA X 2 LT - 66 ONZ', ingredientes: [
    { ingrediente: 'Azucar blanca', cantidad: 1250, unidad: 'gr' },
    { ingrediente: 'bidon de agua x 20lt', cantidad: 1, unidad: 'lt' },
  ]},
  { nombre: 'JARABE DE SANDIA X 750 ML', ingredientes: [
    { ingrediente: 'Sandia', cantidad: 500, unidad: 'gr' },
    { ingrediente: 'azucar blanca', cantidad: 500, unidad: 'gr' },
  ]},
  { nombre: 'MIEL CURCUMA - 20 COCTELES', ingredientes: [
    { ingrediente: 'Curcuma (15und)', cantidad: 200, unidad: 'gr' },
    { ingrediente: 'miel de abeja x ml', cantidad: 750, unidad: 'ml' },
  ]},
  { nombre: 'ESPUMA DE GENGIBRE - 4 COCTELES', ingredientes: [
    { ingrediente: 'Piña', cantidad: 250, unidad: 'gr' },
    { ingrediente: 'gengibre', cantidad: 20, unidad: 'gr' },
    { ingrediente: 'huevo', cantidad: 1, unidad: 'und' },
    { ingrediente: 'limon', cantidad: 1, unidad: 'und' },
  ]},
  { nombre: 'PURE DE MORA 1KG - 4 BOLOS(1 BOLO - 5 ONZ)', ingredientes: [
    { ingrediente: 'Mora', cantidad: 1000, unidad: 'gr' },
  ]},
  { nombre: 'FALERNUM 66 ONZ', ingredientes: [
    { ingrediente: 'Jarabe de goma', cantidad: 1, unidad: 'und' },
    { ingrediente: 'canela,limon,anis estrella, clavo de olor', cantidad: 1, unidad: 'und' },
  ]},
  { nombre: 'ESFERA DE HIELO(6 UND)', ingredientes: [
    { ingrediente: 'Agua', cantidad: 700, unidad: 'ml' },
    { ingrediente: 'Flor de jamaica', cantidad: 100, unidad: 'gr' },
    { ingrediente: 'Campari', cantidad: 300, unidad: 'ml' },
    { ingrediente: 'Falernum', cantidad: 1, unidad: 'onz' },
  ]},
  { nombre: 'SIROP PIÑA Y CRANBERY 13 COCTELES', ingredientes: [
    { ingrediente: 'jarabe de goma', cantidad: 200, unidad: 'ml' },
    { ingrediente: 'líquido marrasquino', cantidad: 200, unidad: 'ml' },
  ]},
  { nombre: 'INFUSCION DE PISCO FRESA Y ANIS 1.5 lt', ingredientes: [
    { ingrediente: 'pisco', cantidad: 1.5, unidad: 'lt' },
    { ingrediente: 'fresa', cantidad: 1000, unidad: 'gr' },
    { ingrediente: 'anis estrella', cantidad: 3, unidad: 'gr' },
  ]},
  { nombre: 'MACERADO DE MAIZ MORADO x 2lt', ingredientes: [
    { ingrediente: 'PISCO QUEBRANTA PEDRO MANUEL X 4LT', cantidad: 2000, unidad: 'lt' },
    { ingrediente: 'maíz morado', cantidad: 1500, unidad: 'gr' },
    { ingrediente: 'cáscara de piña', cantidad: 250, unidad: 'gr' },
    { ingrediente: 'especias', cantidad: 5, unidad: 'gr' },
    { ingrediente: 'manzana verde', cantidad: 1, unidad: 'und' },
    { ingrediente: 'maracuya', cantidad: 1, unidad: 'und' },
  ]},
  { nombre: 'ESPUMA DE PIÑA Y CANELA 4 COCTELES', ingredientes: [
    { ingrediente: 'piña', cantidad: 250, unidad: 'gr' },
    { ingrediente: 'canela entera', cantidad: 2, unidad: 'gr' },
    { ingrediente: 'PISCO QUEBRANTA PEDRO MANUEL X 4LT', cantidad: 1, unidad: 'onz' },
    { ingrediente: 'zumo de limon', cantidad: 0.5, unidad: 'onz' },
    { ingrediente: 'huevo', cantidad: 1, unidad: 'und' },
  ]},
  { nombre: 'SIROP DE MAIZ MORADO 700 ml', ingredientes: [
    { ingrediente: 'maíz morado', cantidad: 500, unidad: 'gr' },
    { ingrediente: 'cáscara de piña', cantidad: 250, unidad: 'gr' },
    { ingrediente: 'especias', cantidad: 5, unidad: 'gr' },
    { ingrediente: 'manzana verde', cantidad: 1, unidad: 'und' },
    { ingrediente: 'maracuya', cantidad: 1, unidad: 'und' },
    { ingrediente: 'azucar blanca', cantidad: 500, unidad: 'gr' },
  ]},
  { nombre: 'ESPUMA DE MENTA Y HIERBA LUISA - 4 COCTELES', ingredientes: [
    { ingrediente: 'piña', cantidad: 250, unidad: 'gr' },
    { ingrediente: 'menta', cantidad: 2, unidad: 'gr' },
    { ingrediente: 'hierba luisa', cantidad: 2, unidad: 'gr' },
    { ingrediente: 'Pisco Quebranta Pedro manuel x 4lt', cantidad: 1, unidad: 'onz' },
    { ingrediente: 'zumo de limon', cantidad: 0.5, unidad: 'onz' },
    { ingrediente: 'huevo', cantidad: 1, unidad: 'und' },
  ]},
  { nombre: 'JARABE DEMERARA X 750 ML', ingredientes: [
    { ingrediente: 'agua', cantidad: 500, unidad: 'lt' },
    { ingrediente: 'azucar rubia', cantidad: 500, unidad: 'gr' },
  ]},
  { nombre: 'ZUMO DE MARACUYA X UND - 90 ML', ingredientes: [
    { ingrediente: 'maracuya', cantidad: 3, unidad: 'onz' },
  ]},
  { nombre: 'ZUMO DE NARANJA X UND', ingredientes: [
    { ingrediente: 'naranja', cantidad: 1, unidad: 'und' },
  ]},
  { nombre: 'ZUMO DE LIMON X UND', ingredientes: [
    { ingrediente: 'limon', cantidad: 2, unidad: 'und' },
  ]},
  { nombre: 'MANGO CIRUELO 5 BOLOS - 5 onzas x bolo', ingredientes: [
    { ingrediente: 'mango ciruelo', cantidad: 1000, unidad: 'gr' },
  ]},
];

app.post('/api/migrate/import-recetas-base', authMiddleware, async (req, res) => {
  try {
    const existing = await col('recetas').where('categoria', '==', 'RECETAS BASE').get();
    if (!existing.empty) {
      return res.json({ ok: true, message: 'Ya importado', count: existing.size });
    }
    const allRec = await col('recetas').get();
    const allIng = await col('receta_ingredientes').get();
    let nextRecId = allRec.docs.length > 0 ? Math.max(...allRec.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    let nextIngId = allIng.docs.length > 0 ? Math.max(...allIng.docs.map(d => Number(d.id) || 0)) + 1 : 1;
    const batch = db.batch();
    let recCount = 0;
    let ingCount = 0;
    for (const rec of recetasBase) {
      const recId = nextRecId++;
      const ref = col('recetas').doc(String(recId));
      batch.set(ref, {
        id: recId, nombre: rec.nombre, categoria: 'RECETAS BASE',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
      recCount++;
      for (const ing of rec.ingredientes) {
        const ingId = nextIngId++;
        batch.set(col('receta_ingredientes').doc(String(ingId)), {
          id: ingId, receta_id: recId,
          ingrediente: ing.ingrediente,
          cantidad: ing.cantidad,
          unidad: normalizeUnit(ing.unidad),
        });
        ingCount++;
      }
    }
    await batch.commit();
    res.json({ ok: true, recetas: recCount, ingredientes: ingCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Unify duplicate ingredient names in barra_precios and receta_ingredientes ---
app.post('/api/migrate/unify-ingredientes', authMiddleware, async (req, res) => {
  try {
    let updatedRecetas = 0, deletedPrecios = 0, mergedCount = 0;

    // Phase 1: Special merges (different names that mean the same thing)
    const specialMerges = [
      { oldName: 'ALBAHAHA X KG', newName: 'albahaca x kg', newUnit: 'kg' },
      { oldName: 'Angostura', newName: 'amargo de angostura x 75ml' },
      { oldName: 'amargo de angostura', newName: 'amargo de angostura x 75ml' },
      { oldName: 'sal, pimienta', newName: 'sal y pimienta' },
      { oldName: 'tabasco', newName: 'tabasco x 60 ml' },
      // Case-only normalizations (oldName will be deleted after merging)
      { oldName: 'Jarabe de goma', newName: 'jarabe de goma' },
      { oldName: 'Zumo de maracuya', newName: 'zumo de maracuya' },
      { oldName: 'Zumo de naranja', newName: 'zumo de naranja' },
      { oldName: 'Clara', newName: 'clara' },
      { oldName: 'Ron blanco', newName: 'ron blanco' },
      { oldName: 'Pisco', newName: 'pisco' },
      { oldName: 'Piña', newName: 'piña' },
    ];

    // First pass: update receta_ingredientes and barra_stock to use newName
    for (const ch of specialMerges) {
      const ingSnap = await col('receta_ingredientes').where('ingrediente', '==', ch.oldName).get();
      if (ingSnap.docs.length > 0) {
        const batch = db.batch();
        ingSnap.docs.forEach(d => batch.update(d.ref, { ingrediente: ch.newName }));
        await batch.commit();
        updatedRecetas += ingSnap.docs.length;
      }
      // Also update barra_stock if needed
      const stockSnap = await col('barra_stock').where('ingrediente', '==', ch.oldName).get();
      if (stockSnap.docs.length > 0) {
        const batch = db.batch();
        stockSnap.docs.forEach(d => batch.update(d.ref, { ingrediente: ch.newName }));
        await batch.commit();
      }
      // Delete the old barra_precios entry (oldName)
      const precSnap = await col('barra_precios').where('ingrediente', '==', ch.oldName).get();
      if (precSnap.docs.length > 0) {
        const batch = db.batch();
        // Transfer precio if newName doesn't have a price
        const newSnap = await col('barra_precios').where('ingrediente', '==', ch.newName).get();
        if (!newSnap.empty && precSnap.docs[0].data().precio > 0 && !newSnap.docs[0].data().precio) {
          batch.update(newSnap.docs[0].ref, { precio: precSnap.docs[0].data().precio });
        }
        precSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deletedPrecios += precSnap.docs.length;
      }
    }

    // Phase 2: Bulk lowercase ALL barra_precios names and merge exact lowercase duplicates
    const allPrec = await col('barra_precios').get();
    const byLower = {};
    const renameMap = {}; // oldName → lowerName for receta updates

    allPrec.docs.forEach(d => {
      const data = d.data();
      const key = data.ingrediente.toLowerCase().trim();
      if (!byLower[key]) byLower[key] = [];
      byLower[key].push({ id: d.id, ref: d.ref, ...data });
    });

    // Step 2a: Build batch for barra_precios only (lowercase + deletes)
    const precBatch = db.batch();
    let precOps = 0;

    for (const [lowerName, items] of Object.entries(byLower)) {
      if (items.length === 1) {
        const item = items[0];
        if (item.ingrediente !== lowerName) {
          precBatch.update(item.ref, { ingrediente: lowerName });
          precOps++;
        }
        if (item.ingrediente !== lowerName) renameMap[item.ingrediente] = lowerName;
      } else {
        // Multiple items with same lowercase name: keep one with precio > 0, or the first
        const withPrice = items.filter(i => (i.precio || 0) > 0);
        const keeper = withPrice.length > 0 ? withPrice[0] : items[0];
        const toDelete = items.filter(i => i.id !== keeper.id);
        const bestUnit = items.reduce((best, item) => {
          if (item.unidad && item.unidad !== 'unidad' && item.unidad !== lowerName) return item.unidad;
          return best;
        }, keeper.unidad || 'unidad');
        precBatch.update(keeper.ref, { ingrediente: lowerName, unidad: normalizeUnit(bestUnit), updated_at: new Date().toISOString() });
        precOps++;
        toDelete.forEach(item => { precBatch.delete(item.ref); deletedPrecios++; });
        if (keeper.ingrediente !== lowerName) renameMap[keeper.ingrediente] = lowerName;
        toDelete.forEach(item => { if (item.ingrediente !== lowerName) renameMap[item.ingrediente] = lowerName; });
      }
    }

    // Commit precBatch FIRST (before any receta queries)
    if (precOps > 0) await precBatch.commit();
    const lowerCount = precOps;

    // Step 2b: Now update receta_ingredientes for all renamed items
    for (const [oldName, newName] of Object.entries(renameMap)) {
      const riSnap = await col('receta_ingredientes').where('ingrediente', '==', oldName).get();
      if (riSnap.docs.length > 0) {
        const batch = db.batch();
        riSnap.docs.forEach(d => batch.update(d.ref, { ingrediente: newName }));
        await batch.commit();
        updatedRecetas += riSnap.docs.length;
      }
    }

    // Phase 3: Lowercase all receta_ingredientes names (any remaining uppercase variants)
    const allRI = await col('receta_ingredientes').get();
    const riBatch = db.batch();
    let riCount = 0;
    allRI.docs.forEach(d => {
      const data = d.data();
      const lower = data.ingrediente.trim();
      if (lower !== data.ingrediente) {
        riBatch.update(d.ref, { ingrediente: lower });
        riCount++;
      }
    });
    // Also lowercase barra_stock
    const allStock = await col('barra_stock').get();
    const stockBatch = db.batch();
    let stockCount = 0;
    allStock.docs.forEach(d => {
      const data = d.data();
      const lower = data.ingrediente.trim().toLowerCase();
      if (lower !== data.ingrediente) {
        stockBatch.update(d.ref, { ingrediente: lower, updated_at: new Date().toISOString() });
        stockCount++;
      }
    });
    if (riCount > 0) await riBatch.commit();
    if (stockCount > 0) await stockBatch.commit();

    mergedCount = deletedPrecios;

    res.json({ ok: true, updatedRecetas, deletedPrecios, mergedCount, lowercasedPrecios: lowerCount, lowercasedRecetas: riCount, lowercasedStock: stockCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Fix: recipe ingredients that don't match barra_precios (case variants + deleted items) ---
app.post('/api/migrate/fix-receta-ingredientes', authMiddleware, async (req, res) => {
  try {
    // Build lookup of canonical names in barra_precios
    const precSnap = await col('barra_precios').get();
    const canonical = {};
    precSnap.docs.forEach(d => { canonical[d.data().ingrediente] = true; });

    // Define replacements: oldName → newName
    const replacements = {
      // Items the user deleted from barra_precios
      'bidon de agua x 20lt': 'agua',
      'bidon de agua x 20 lt': 'agua',
      // Case variants (recipes have mixed case, barra_precios has lowercase)
      'Pisco Quebranta Pedro manuel x 4lt': 'pisco quebranta pedro manuel x 4lt',
      'Mora': 'mora',
      'Cherry brandi': 'cherry brandi',
      'Dry': 'dry',
      'Limon': 'limon',
      'Menta': 'menta',
      'Zumo de limon': 'zumo de limon',
      'Leche evaporada': 'leche evaporada',
      'Jarabe hoja de coca': 'jarabe hoja de coca',
      'HIERBA LUISA': 'hierba luisa',
      'Campari': 'campari',
      'Falernum': 'falernum',
      'PLATANOS BANANITOS': 'platanos bananitos',
      'Jarabe de Sandia': 'jarabe de sandia',
      'CANELA': 'canela',
      'AGUA TONICA': 'agua tonica',
      'ANIS ESTRELLA': 'anis estrella',
    };

    let updatedRecetas = 0;
    let deletedPrecios = 0;

    for (const [oldName, newName] of Object.entries(replacements)) {
      // Update receta_ingredientes
      const riSnap = await col('receta_ingredientes').where('ingrediente', '==', oldName).get();
      if (riSnap.docs.length > 0) {
        const batch = db.batch();
        riSnap.docs.forEach(d => batch.update(d.ref, { ingrediente: newName }));
        await batch.commit();
        updatedRecetas += riSnap.docs.length;
      }
      // Delete the old entry from barra_precios if it exists
      const oldPrec = await col('barra_precios').where('ingrediente', '==', oldName).get();
      if (oldPrec.docs.length > 0) {
        const batch = db.batch();
        oldPrec.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deletedPrecios += oldPrec.docs.length;
      }
    }

    // Also delete the lowercase bidon items from barra_precios if they still exist
    for (const name of ['bidon de agua x 20lt', 'bidon de agua x 20 lt']) {
      const snap = await col('barra_precios').where('ingrediente', '==', name).get();
      if (snap.docs.length > 0) {
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deletedPrecios += snap.docs.length;
      }
    }

    res.json({ ok: true, recetas_actualizadas: updatedRecetas, precios_eliminados: deletedPrecios });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Sync all recipe ingredients to barra_precios ---
app.post('/api/migrate/sync-ingredientes-to-precios', authMiddleware, async (req, res) => {
  try {
    const ingSnap = await col('receta_ingredientes').get();
    const seen = {};
    let added = 0;
    for (const d of ingSnap.docs) {
      const ing = d.data();
      const key = ing.ingrediente.toLowerCase().trim();
      if (seen[key]) continue;
      seen[key] = true;
      const result = await ensureIngredienteInPrecios(ing.ingrediente, ing.unidad);
      if (result) added++;
    }
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Auto-fill equiv_ml/equiv_gr from item names ---
app.post('/api/migrate/parse-equiv', authMiddleware, async (req, res) => {
  try {
    const snap = await col('barra_precios').get();
    const batch = db.batch();
    let count = 0;
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.unidad === 'unidad' && !data.equiv_ml && !data.equiv_gr) {
        const parsed = parseEquivFromName(data.ingrediente);
        if (parsed.equiv_ml || parsed.equiv_gr) {
          batch.update(d.ref, { ...parsed, updated_at: new Date().toISOString() });
          count++;
        }
      }
    });
    if (count > 0) await batch.commit();
    res.json({ ok: true, actualizados: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Rename MANTGRAS → MONTGRASS in inventario and inventario_diario ---
app.post('/api/migrate/rename-mantgras', authMiddleware, async (req, res) => {
  try {
    const invSnap = await col('inventario').get();
    const batch = db.batch();
    let count = 0;
    invSnap.docs.forEach(d => {
      const name = d.data().nombre || '';
      if (name.startsWith('MANTGRAS')) {
        batch.update(d.ref, { nombre: name.replace(/^MANTGRAS/, 'MONTGRASS'), updated_at: new Date().toISOString() });
        count++;
      }
    });
    const diaSnap = await col('inventario_diario').get();
    const diaBatch = db.batch();
    let diaCount = 0;
    diaSnap.docs.forEach(d => {
      const name = d.data().nombre || '';
      if (name.startsWith('MANTGRAS')) {
        diaBatch.update(d.ref, { nombre: name.replace(/^MANTGRAS/, 'MONTGRASS'), updated_at: new Date().toISOString() });
        diaCount++;
      }
    });
    if (count > 0) await batch.commit();
    if (diaCount > 0) await diaBatch.commit();
    res.json({ ok: true, inventario: count, diario: diaCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Fix specific item name in STOCK DECORATIVO ENTRADA ---
app.post('/api/migrate/fix-montgrass-name', authMiddleware, async (req, res) => {
  try {
    const invSnap = await col('inventario').get();
    const batch = db.batch();
    let count = 0;
    invSnap.docs.forEach(d => {
      const name = d.data().nombre || '';
      if (name === 'MONTGRASS DE VINE RESERVA CABERNET' || name === 'MANTGRAS DE VINE RESERVA CABERNET') {
        batch.update(d.ref, { nombre: 'MONTGRASS DE VINE RESERVE CARBERNET SAUVIGNON 2023', updated_at: new Date().toISOString() });
        count++;
      }
    });
    const diaSnap = await col('inventario_diario').get();
    const diaBatch = db.batch();
    let diaCount = 0;
    diaSnap.docs.forEach(d => {
      const name = d.data().nombre || '';
      if (name === 'MONTGRASS DE VINE RESERVA CABERNET' || name === 'MANTGRAS DE VINE RESERVA CABERNET') {
        diaBatch.update(d.ref, { nombre: 'MONTGRASS DE VINE RESERVE CARBERNET SAUVIGNON 2023', updated_at: new Date().toISOString() });
        diaCount++;
      }
    });
    if (count > 0) await batch.commit();
    if (diaCount > 0) await diaBatch.commit();
    res.json({ ok: true, inventario: count, diario: diaCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Reporte de Vinos (no auth — public) ---
app.get('/api/reportes/vinos', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
    const [invSnap, diaSnap, almSnap] = await Promise.all([
      col('inventario').get(),
      col('inventario_diario').where('fecha', '==', fecha).get(),
      col('almacenes').get(),
    ]);

    // Build warehouse name map
    const almacenes = {};
    almSnap.docs.forEach(d => { almacenes[Number(d.id)] = d.data().nombre; });

    const vinosRegex = /MONTGRAS|FAUSTINO|LA CELIA|LUIGI BOSCA|CAROLINA RESERVA|SAUVIGNON|CHARDONAY|ALBARIÑO|PROTOS|MALBEC|CABERNET|MERLOT|CARMENERE|CRIANZA|BRUT|CHAMPAGNE|TINTO|PRADOREY|CRODERO|ESCORIHUELA|MALAJUNTA|MALJUNTA|MONTGRASS|GOUTTE.*ARGENT|PINOT.*NOIR|PINOT/i;

    // Build dia map: key = "item_id_almacen_id"
    const diaMap = {};
    diaSnap.docs.forEach(d => {
      const dd = d.data();
      diaMap[dd.item_id + '_' + dd.almacen_id] = dd;
    });

    const vinos = {};
    invSnap.docs.forEach(d => {
      const inv = d.data();
      const match = vinosRegex.test(inv.nombre) || (inv.categoria && /vinos/i.test(inv.categoria));
      if (!match) return;
      const key = inv.nombre.trim();
      if (!vinos[key]) vinos[key] = { nombre: inv.nombre, total: 0, almacenes: {} };
      const dia = diaMap[inv.item_id + '_' + inv.almacen_id] || {};
      const cantidad = dia.stock_cierre ?? dia.stock_apertura ?? inv.stock_apertura ?? 0;
      vinos[key].total += cantidad;
      const alName = almacenes[inv.almacen_id] || ('Almacén ' + inv.almacen_id);
      vinos[key].almacenes[alName] = (vinos[key].almacenes[alName] || 0) + cantidad;
    });

    const items = Object.values(vinos).sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json({ ok: true, fecha, totalItems: items.length, totalStock: items.reduce((s, i) => s + i.total, 0), items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Agregar item a un almacén (crea el item si no existe) ---
app.post('/api/inventario/agregar-item', authMiddleware, async (req, res) => {
  try {
    const { nombre, almacen_id, cantidad, nota } = req.body;
    if (!nombre || !almacen_id) return res.status(400).json({ error: 'Nombre y almacén requeridos' });

    const invSnap = await col('inventario').where('almacen_id', '==', almacen_id).get();
    const existing = invSnap.docs.find(d => d.data().nombre.toLowerCase().trim() === nombre.toLowerCase().trim());

    let item_id;
    if (existing) {
      item_id = existing.data().item_id;
    } else {
      const allInv = await col('inventario').get();
      let maxId = 0;
      allInv.docs.forEach(d => { const id = d.data().item_id || 0; if (id > maxId) maxId = id; });
      item_id = maxId + 1;
      const docIdStr = docId('inventario', item_id, almacen_id);
      await col('inventario').doc(docIdStr).set({
        item_id, almacen_id, nombre, categoria: req.body.categoria || '',
        stock_apertura: 0, cantidad_minima: 0
      });
    }

    const d = new Date();
    const fecha = String(req.body.fecha || '').trim() || (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    const diaDocId = docId('invdiario', fecha, almacen_id, item_id);
    const diaSnap = await col('inventario_diario').doc(diaDocId).get();
    if (diaSnap.exists) {
      const data = diaSnap.data();
      await col('inventario_diario').doc(diaDocId).update({
        stock_ingreso: (data.stock_ingreso || 0) + cantidad,
        stock_cierre: (data.stock_cierre || 0) + cantidad,
        updated_at: new Date().toISOString(), saved_by: req.user.displayName || req.user.email
      });
    } else {
      await col('inventario_diario').doc(diaDocId).set({
        fecha, item_id, almacen_id,
        stock_apertura: 0, stock_ingreso: cantidad, salida_almacen: 0,
        total_ventas: 0, falta_almacen: 0, stock_baja: 0,
        stock_cierre: cantidad, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), saved_by: req.user.displayName || req.user.email
      });
    }
    delete _cache['con_inv_' + fecha];

    res.json({ ok: true, item_id, nombre, almacen_id });
  } catch (e) {    res.status(500).json({ error: e.message });
  }
});

// --- Edit item in almacén ---
app.put('/api/inventario/:item_id/:almacen_id', authMiddleware, async (req, res) => {
  try {
    const { item_id, almacen_id } = req.params;
    const { nombre, categoria } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const docIdStr = docId('inventario', Number(item_id), Number(almacen_id));
    await col('inventario').doc(docIdStr).update({
      nombre, categoria: categoria || '', updated_at: new Date().toISOString()
    });
    // Also update inventario_diario for all dates
    const diaSnap = await col('inventario_diario')
      .where('item_id', '==', Number(item_id))
      .where('almacen_id', '==', Number(almacen_id)).get();
    const batch = db.batch();
    diaSnap.docs.forEach(d => batch.update(d.ref, { nombre, updated_at: new Date().toISOString() }));
    if (diaSnap.docs.length > 0) await batch.commit();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Delete item from almacén ---
app.delete('/api/inventario/:item_id/:almacen_id', authMiddleware, async (req, res) => {
  try {
    const { item_id, almacen_id } = req.params;
    const docIdStr = docId('inventario', Number(item_id), Number(almacen_id));
    await col('inventario').doc(docIdStr).delete();
    // Delete all inventario_diario for this item
    const diaSnap = await col('inventario_diario')
      .where('item_id', '==', Number(item_id))
      .where('almacen_id', '==', Number(almacen_id)).get();
    const batch = db.batch();
    diaSnap.docs.forEach(d => batch.delete(d.ref));
    if (diaSnap.docs.length > 0) await batch.commit();
    const hoy = new Date().toISOString().split('T')[0];
    delete _cache['con_inv_' + hoy];
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- COSTOS: planillas, servicios y gastos operativos ---
app.get('/api/costos', authMiddleware, async (req, res) => {
  try {
    const { fecha, tipo, mes } = req.query;
    // Single-field query avoids needing a composite index; filter/sort in memory
    let query = col('costos');
    if (fecha) {
      query = query.where('fecha', '==', fecha);
    } else if (mes && /^\d{4}-\d{2}$/.test(mes)) {
      const [y, m] = mes.split('-').map(Number);
      const inicio = mes + '-01';
      const fin = m === 12 ? (y + 1) + '-01-01' : y + '-' + String(m + 1).padStart(2, '0') + '-01';
      query = query.where('fecha', '>=', inicio).where('fecha', '<', fin);
    }
    const snap = await query.get();
    let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (tipo) docs = docs.filter(c => c.tipo === String(tipo).toLowerCase());
    docs.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/costos', authMiddleware, async (req, res) => {
  try {
    const { fecha, tipo, concepto, monto, servicio, planilla } = req.body;
    if (!fecha || !tipo || monto === undefined) return res.status(400).json({ error: 'fecha, tipo y monto requeridos' });
    const ref = col('costos').doc();
    await ref.set({
      id: ref.id,
      fecha,
      tipo: String(tipo).toLowerCase(),
      servicio: servicio ? String(servicio).toLowerCase() : '',
      planilla: planilla ? String(planilla).toLowerCase() : '',
      concepto: (concepto || '').toString().trim(),
      monto: Math.round((parseFloat(monto) || 0) * 100) / 100,
      saved_by: req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    res.json({ ok: true, id: ref.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/costos/:id', authMiddleware, async (req, res) => {
  try {
    await col('costos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/costos/reemplazar', authMiddleware, async (req, res) => {
  try {
    const { fecha, grupos } = req.body;
    if (!fecha || !Array.isArray(grupos) || !grupos.length) return res.status(400).json({ error: 'fecha y grupos requeridos' });
    const gruposNorm = grupos.map(g => ({
      tipo: String(g.tipo).toLowerCase(),
      campoSub: String(g.campoSub || ''),
      campos: (g.campos || []).map(c => ({
        valor: String(c.valor || '').toUpperCase(),
        concepto: String(c.concepto || '').trim(),
        monto: (c.monto === null || c.monto === undefined || String(c.monto).trim() === '') ? null : Math.round((parseFloat(c.monto) || 0) * 100) / 100
      }))
    }));
    const byTipo = {};
    gruposNorm.forEach(g => { byTipo[g.tipo] = g; });
    const all = await col('costos').where('fecha', '==', fecha).get();
    const batch = db.batch();
    let eliminados = 0, creados = 0;
    all.docs.forEach(d => {
      const data = d.data();
      const tipo = String(data.tipo || '').toLowerCase();
      const g = byTipo[tipo];
      if (!g) return;
      const valorDoc = g.campoSub ? String(data[g.campoSub] || '').toUpperCase() : '';
      const conceptoDoc = String(data.concepto || '').toUpperCase();
      const match = g.campos.find(c => (valorDoc && valorDoc === c.valor) || (conceptoDoc && conceptoDoc === c.valor));
      if (match) { batch.delete(d.ref); eliminados++; }
    });
    gruposNorm.forEach(g => {
      g.campos.forEach(c => {
        if (c.monto === null || c.monto === undefined) return;
        const ref = col('costos').doc();
        const data = {
          id: ref.id,
          fecha,
          tipo: g.tipo,
          concepto: c.concepto,
          monto: c.monto,
          saved_by: req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (g.campoSub) data[g.campoSub] = c.valor.toLowerCase();
        batch.set(ref, data);
        creados++;
      });
    });
    await batch.commit();
    res.json({ ok: true, eliminados, creados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- SERVICIOS: títulos de categorías dinámicos ---
app.get('/api/servicios/titulos', authMiddleware, async (req, res) => {
  try {
    const doc = await col('config').doc('servicios_titulos').get();
    if (doc.exists) {
      res.json({ titulos: doc.data().titulos || [] });
    } else {
      const defaultPestana = PESTANAS_DEFAULT.find(p => p.id === 'servicios');
      res.json({ titulos: defaultPestana ? defaultPestana.titulos : [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/servicios/titulos', authMiddleware, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim().toUpperCase();
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const doc = await col('config').doc('servicios_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    if (!titulos.some(t => t.toUpperCase() === nombre)) titulos.push(nombre);
    await col('config').doc('servicios_titulos').set({ titulos, updated_at: new Date().toISOString() });
    res.json({ ok: true, titulos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/servicios/titulos', authMiddleware, async (req, res) => {
  try {
    const viejo = String(req.body.viejo || '').trim();
    const nuevo = String(req.body.nuevo || '').trim().toUpperCase();
    if (!viejo || !nuevo) return res.status(400).json({ error: 'viejo y nuevo requeridos' });
    const doc = await col('config').doc('servicios_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    const idx = titulos.findIndex(t => t.toUpperCase() === viejo.toUpperCase());
    if (idx === -1) return res.status(404).json({ error: 'Campo no encontrado' });
    if (titulos.some(t => t.toUpperCase() === nuevo && t !== titulos[idx])) {
      return res.status(400).json({ error: 'Ya existe un campo con ese nombre' });
    }
    titulos[idx] = nuevo;
    await col('config').doc('servicios_titulos').set({ titulos, updated_at: new Date().toISOString() });
    const snap = await col('costos').where('tipo', '==', 'servicio').where('servicio', '==', viejo.toLowerCase()).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { servicio: nuevo.toLowerCase(), updated_at: new Date().toISOString() }));
    if (snap.size) await batch.commit();
    res.json({ ok: true, titulos, actualizados: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- GASTOS: títulos de categorías dinámicos ---
app.get('/api/gastos/titulos', authMiddleware, async (req, res) => {
  try {
    const doc = await col('config').doc('gastos_titulos').get();
    if (doc.exists) {
      res.json({ titulos: doc.data().titulos || [] });
    } else {
      const defaultPestana = PESTANAS_DEFAULT.find(p => p.id === 'gastos');
      res.json({ titulos: defaultPestana ? defaultPestana.titulos : [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gastos/titulos', authMiddleware, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim().toUpperCase();
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const doc = await col('config').doc('gastos_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    if (!titulos.some(t => t.toUpperCase() === nombre)) titulos.push(nombre);
    await col('config').doc('gastos_titulos').set({ titulos, updated_at: new Date().toISOString() });
    res.json({ ok: true, titulos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/gastos/titulos', authMiddleware, async (req, res) => {
  try {
    const viejo = String(req.body.viejo || '').trim();
    const nuevo = String(req.body.nuevo || '').trim().toUpperCase();
    if (!viejo || !nuevo) return res.status(400).json({ error: 'viejo y nuevo requeridos' });
    const doc = await col('config').doc('gastos_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    const idx = titulos.findIndex(t => t.toUpperCase() === viejo.toUpperCase());
    if (idx === -1) return res.status(404).json({ error: 'Campo no encontrado' });
    if (titulos.some(t => t.toUpperCase() === nuevo && t !== titulos[idx])) {
      return res.status(400).json({ error: 'Ya existe un campo con ese nombre' });
    }
    titulos[idx] = nuevo;
    await col('config').doc('gastos_titulos').set({ titulos, updated_at: new Date().toISOString() });
    const snap = await col('costos').where('tipo', '==', 'gastos').where('gasto', '==', viejo.toLowerCase()).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { gasto: nuevo.toLowerCase(), updated_at: new Date().toISOString() }));
    if (snap.size) await batch.commit();
    res.json({ ok: true, titulos, actualizados: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- PLANILLAS: títulos de categorías dinámicos ---
app.get('/api/planillas/titulos', authMiddleware, async (req, res) => {
  try {
    const doc = await col('config').doc('planillas_titulos').get();
    if (doc.exists) {
      res.json({ titulos: doc.data().titulos || [] });
    } else {
      const defaultPestana = PESTANAS_DEFAULT.find(p => p.id === 'planillas');
      res.json({ titulos: defaultPestana ? defaultPestana.titulos : [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/planillas/titulos', authMiddleware, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim().toUpperCase();
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const doc = await col('config').doc('planillas_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    if (!titulos.some(t => t.toUpperCase() === nombre)) titulos.push(nombre);
    await col('config').doc('planillas_titulos').set({ titulos, updated_at: new Date().toISOString() });
    res.json({ ok: true, titulos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/planillas/titulos', authMiddleware, async (req, res) => {
  try {
    const viejo = String(req.body.viejo || '').trim();
    const nuevo = String(req.body.nuevo || '').trim().toUpperCase();
    if (!viejo || !nuevo) return res.status(400).json({ error: 'viejo y nuevo requeridos' });
    const doc = await col('config').doc('planillas_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    const idx = titulos.findIndex(t => t.toUpperCase() === viejo.toUpperCase());
    if (idx === -1) return res.status(404).json({ error: 'Campo no encontrado' });
    if (titulos.some(t => t.toUpperCase() === nuevo && t !== titulos[idx])) {
      return res.status(400).json({ error: 'Ya existe un campo con ese nombre' });
    }
    titulos[idx] = nuevo;
    await col('config').doc('planillas_titulos').set({ titulos, updated_at: new Date().toISOString() });
    // Renombrar los registros de costos que usaban el nombre viejo
    const snap = await col('costos').where('tipo', '==', 'planillas').where('planilla', '==', viejo.toLowerCase()).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { planilla: nuevo.toLowerCase(), updated_at: new Date().toISOString() }));
    if (snap.size) await batch.commit();
    res.json({ ok: true, titulos, actualizados: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- COSTOS: endpoints genéricos para títulos de pestañas dinámicas ---
app.get('/api/:prefix/titulos', authMiddleware, async (req, res) => {
  try {
    const { prefix } = req.params;
    const doc = await col('config').doc(prefix + '_titulos').get();
    if (doc.exists) {
      res.json({ titulos: doc.data().titulos || [] });
    } else {
      const defaultPestana = PESTANAS_DEFAULT.find(p => p.id === prefix);
      res.json({ titulos: defaultPestana ? defaultPestana.titulos : [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/:prefix/titulos', authMiddleware, async (req, res) => {
  try {
    const { prefix } = req.params;
    const nombre = String(req.body.nombre || '').trim().toUpperCase();
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const doc = await col('config').doc(prefix + '_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    if (!titulos.some(t => t.toUpperCase() === nombre)) titulos.push(nombre);
    await col('config').doc(prefix + '_titulos').set({ titulos, updated_at: new Date().toISOString() });
    res.json({ ok: true, titulos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/:prefix/titulos', authMiddleware, async (req, res) => {
  try {
    const { prefix } = req.params;
    const viejo = String(req.body.viejo || '').trim();
    const nuevo = String(req.body.nuevo || '').trim().toUpperCase();
    if (!viejo || !nuevo) return res.status(400).json({ error: 'viejo y nuevo requeridos' });
    const doc = await col('config').doc(prefix + '_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    const idx = titulos.findIndex(t => t.toUpperCase() === viejo.toUpperCase());
    if (idx === -1) return res.status(404).json({ error: 'Campo no encontrado' });
    if (titulos.some(t => t.toUpperCase() === nuevo && t !== titulos[idx])) {
      return res.status(400).json({ error: 'Ya existe un campo con ese nombre' });
    }
    titulos[idx] = nuevo;
    await col('config').doc(prefix + '_titulos').set({ titulos, updated_at: new Date().toISOString() });
    res.json({ ok: true, titulos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/:prefix/titulos', authMiddleware, async (req, res) => {
  try {
    const { prefix } = req.params;
    const nombre = String(req.body.nombre || req.query.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const doc = await col('config').doc(prefix + '_titulos').get();
    let titulos = doc.exists ? (doc.data().titulos || []) : [];
    const idx = titulos.findIndex(t => t.toUpperCase() === nombre.toUpperCase());
    if (idx === -1) return res.status(404).json({ error: 'Campo no encontrado' });
    titulos.splice(idx, 1);
    await col('config').doc(prefix + '_titulos').set({ titulos, updated_at: new Date().toISOString() });
    // Eliminar registros de costos asociados al campo
    const pestana = PESTANAS_DEFAULT.find(p => p.id === prefix);
    const tipo = pestana ? pestana.tipo : prefix;
    const campo = pestana ? pestana.campoSub : prefix;
    const snap = await col('costos').where('tipo', '==', tipo).where(campo, '==', nombre.toLowerCase()).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    if (snap.size) await batch.commit();
    res.json({ ok: true, titulos, eliminados: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- COSTOS: pestañas dinámicas ---
const PESTANAS_DEFAULT = [
  { id: 'planillas', label: 'Planillas', tipo: 'planillas', campoSub: 'planilla', campoTexto: 'nombre', colLabel: 'Nombre', phTexto: 'Nombre del trabajador', editableTitulos: true, titulosDoc: 'planillas_titulos', titulos: ['MESEROS', 'COCINEROS', 'ADMINISTRACION', 'LIMPIEZA'] },
  { id: 'servicios', label: 'Servicios', tipo: 'servicio', campoSub: 'servicio', campoTexto: 'concepto', colLabel: 'Concepto', phTexto: 'Descripción (ej. Recibo N° 123)', editableTitulos: true, titulosDoc: 'servicios_titulos', titulos: ['ALQUILER', 'AGUA', 'LUZ', 'INTERNET', 'GAS', 'LIMPIEZA'] },
  { id: 'gastos', label: 'Gastos Operativos', tipo: 'gastos', campoSub: 'gasto', campoTexto: 'concepto', colLabel: 'Concepto', phTexto: 'Descripción del gasto', editableTitulos: true, titulosDoc: 'gastos_titulos', titulos: ['SEGURIDAD', 'LIMPIEZA', 'MANTENIMIENTO', 'TRANSPORTE', 'OTROS'] }
];

app.get('/api/costos/pestanas', authMiddleware, async (req, res) => {
  try {
    const doc = await col('config').doc('costos_pestanas').get();
    const pestanas = doc.exists ? (doc.data().pestanas || PESTANAS_DEFAULT) : PESTANAS_DEFAULT;
    res.json({ pestanas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/costos/pestanas', authMiddleware, async (req, res) => {
  try {
    const label = String(req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Nombre requerido' });
    const id = label.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const doc = await col('config').doc('costos_pestanas').get();
    let pestanas = doc.exists ? (doc.data().pestanas || [...PESTANAS_DEFAULT]) : [...PESTANAS_DEFAULT];
    if (pestanas.some(p => p.id === id)) return res.status(400).json({ error: 'Ya existe una pestaña con ese nombre' });
    const titulosDoc = id + '_titulos';
    const newTab = {
      id, label: label.toUpperCase(), tipo: id, campoSub: id, campoTexto: 'concepto',
      colLabel: 'Concepto', phTexto: 'Descripción', editableTitulos: true, titulosDoc
    };
    pestanas.push(newTab);
    await col('config').doc('costos_pestanas').set({ pestanas, updated_at: new Date().toISOString() });
    await col('config').doc(titulosDoc).set({ titulos: [], updated_at: new Date().toISOString() });
    res.json({ ok: true, pestanas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/costos/pestanas/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const nuevoLabel = String(req.body.label || '').trim();
    if (!nuevoLabel) return res.status(400).json({ error: 'Nombre requerido' });
    const doc = await col('config').doc('costos_pestanas').get();
    let pestanas = doc.exists ? (doc.data().pestanas || [...PESTANAS_DEFAULT]) : [...PESTANAS_DEFAULT];
    const idx = pestanas.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Pestaña no encontrada' });
    pestanas[idx].label = nuevoLabel.toUpperCase();
    await col('config').doc('costos_pestanas').set({ pestanas, updated_at: new Date().toISOString() });
    res.json({ ok: true, pestanas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/costos/pestanas/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await col('config').doc('costos_pestanas').get();
    let pestanas = doc.exists ? (doc.data().pestanas || [...PESTANAS_DEFAULT]) : [...PESTANAS_DEFAULT];
    pestanas = pestanas.filter(p => p.id !== id);
    await col('config').doc('costos_pestanas').set({ pestanas, updated_at: new Date().toISOString() });
    res.json({ ok: true, pestanas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
