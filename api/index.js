const admin = require('firebase-admin');
const express = require('express');
const path = require('path');

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
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,3).join('; ') });
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
  res.render('index');
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
  const result = almsSnap.docs.map(alDoc => {
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
      stock_cierre: Math.round(cierre * 100) / 100,
        cantidad_minima: inv.cantidad_minima || 0,
        fecha_apertura: inv.fecha_apertura || '',
        saved_by: dia.saved_by || null,
        updated_at: dia.updated_at || null,
      };
    });
    return { id: alId, nombre: alDoc.data().nombre, items };
  });
  res.json(result);
});

// --- GUARDAR DÍA ---
app.post('/api/almacenes/guardar-dia', async (req, res) => {
  const { fecha, registros } = req.body;
  if (!fecha || !registros) return res.status(400).json({ error: 'fecha y registros requeridos' });
  const savedBy = req.body.saved_by || (req.user ? (req.user.name || req.user.email || req.user.uid) : 'unknown');
  const batch = db.batch();
  for (const r of registros) {
    const id = docId('invdiario', fecha, r.almacen_id, r.item_id);
    const apertura = parseFloat(r.stock_apertura) || 0;
    const ingreso = parseFloat(r.stock_ingreso) || 0;
    const salida = parseFloat(r.salida_almacen) || 0;
    const ventas = parseFloat(r.total_ventas) || 0;
    const falta = parseFloat(r.falta_almacen) || 0;
    const baja = parseFloat(r.stock_baja) || 0;
    const notaBaja = r.nota_baja || '';
    const cierre = apertura + ingreso - salida - ventas - falta - baja;
    const ref = col('inventario_diario').doc(id);
    batch.set(ref, {
      fecha,
      item_id: Number(r.item_id),
      almacen_id: Number(r.almacen_id),
      stock_apertura: apertura,
      stock_ingreso: ingreso,
      salida_almacen: salida,
      total_ventas: ventas,
      falta_almacen: falta,
      stock_baja: baja,
      nota_baja: notaBaja,
      stock_cierre: Math.round(cierre * 100) / 100,
      updated_at: new Date().toISOString(),
      saved_by: savedBy,
    }, { merge: true });
    // Update permanent stock_apertura in inventario
    const invId = docId('inventario', r.item_id, r.almacen_id);
    const invRef = col('inventario').doc(invId);
    batch.set(invRef, {
      stock_apertura: apertura,
    }, { merge: true });
  }
  await batch.commit();
  delete _cache['inv_diario_' + fecha];

  // Propagation: copy cierre to next working day's apertura (parallel reads)
  try {
    const nextDay = getNextWorkingDay(fecha);
    const oldSnap = await col('inventario_diario').where('fecha', '==', fecha).get();
    const nextDocs = await Promise.all(oldSnap.docs.map(doc => {
      const d = doc.data();
      const nextId = docId('invdiario', nextDay, d.almacen_id, d.item_id);
      return col('inventario_diario').doc(nextId).get().then(snap => ({ d, exists: snap.exists, snap }));
    }));
    const nextBatch = db.batch();
    let hasChanges = false;
    for (const { d, exists, snap } of nextDocs) {
      const nextRef = col('inventario_diario').doc(docId('invdiario', nextDay, d.almacen_id, d.item_id));
      const apertura = d.stock_cierre ?? 0;
      if (exists) {
        const existing = snap.data();
        const ingreso = existing.stock_ingreso ?? 0;
        const salida = existing.salida_almacen ?? 0;
        const ventas = existing.total_ventas ?? 0;
        const falta = existing.falta_almacen ?? 0;
        const baja = existing.stock_baja ?? 0;
        const cierre = apertura + ingreso - salida - ventas - falta - baja;
        const updateData = {
          stock_apertura: apertura,
          stock_cierre: Math.round(cierre * 100) / 100,
          updated_at: new Date().toISOString(),
        };
        // preserve nota_baja if it exists
        if (existing.nota_baja) {
          updateData.nota_baja = existing.nota_baja;
        }
        nextBatch.update(nextRef, updateData);
        hasChanges = true;
      } else {
        nextBatch.set(nextRef, {
          fecha: nextDay,
          item_id: d.item_id,
          almacen_id: d.almacen_id,
          stock_apertura: apertura,
          stock_ingreso: 0,
          salida_almacen: 0,
          total_ventas: 0,
          falta_almacen: 0,
          stock_baja: 0,
          stock_cierre: apertura,
          updated_at: new Date().toISOString(),
        });
        hasChanges = true;
      }
    }
    if (hasChanges) await nextBatch.commit();
  } catch (e) {
    console.error('Propagation error:', e.message);
  }

  res.json({ ok: true });
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
      const costo = (ing.cantidad || 0) * precioUnidad;
      costoTotal += costo;
      return { ...ing, precioUnidad, costo, precioMatch: !!match };
    });
    return { ...r, ingredientes: ingredientesConPrecio, costoTotal };
  });
  res.json(result);
});

app.post('/api/recetas', async (req, res) => {
  const { nombre, categoria } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = col('recetas').doc();
  // We use auto-id but also store a numeric id for compatibility
  const all = await col('recetas').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('recetas').doc(String(nextId)).set({
    nombre, categoria: categoria || 'Clásicos',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  res.json({ id: nextId });
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
  const ref = col('barra_precios').doc(String(nextId));
  await ref.set({
    id: nextId, ingrediente: lower, precio: 0, unidad: normalizeUnit(unidad || 'unidad'),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  return { id: nextId };
}

// --- BARRA STOCK ---
app.get('/api/barra/stock', async (req, res) => {
  const snap = await col('barra_stock').orderBy('ingrediente').get();
  res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
});

app.post('/api/barra/stock', async (req, res) => {
  const { ingrediente, cantidad, unidad } = req.body;
  if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
  const all = await col('barra_stock').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('barra_stock').doc(String(nextId)).set({
    id: nextId, ingrediente, cantidad: cantidad || 0, unidad: normalizeUnit(unidad),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.put('/api/barra/stock/:id', async (req, res) => {
  const { cantidad, ingrediente, unidad } = req.body;
  const upd = { updated_at: new Date().toISOString() };
  if (cantidad !== undefined) upd.cantidad = cantidad;
  if (ingrediente) upd.ingrediente = ingrediente;
  if (unidad) upd.unidad = normalizeUnit(unidad);
  await col('barra_stock').doc(req.params.id).update(upd);
  res.json({ ok: true });
});

app.delete('/api/barra/stock/:id', async (req, res) => {
  await col('barra_stock').doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- BARRA PRECIOS ---
app.get('/api/barra/precios', async (req, res) => {
  const snap = await col('barra_precios').orderBy('ingrediente').get();
  res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
});

app.post('/api/barra/precios', async (req, res) => {
  const { ingrediente, precio, unidad } = req.body;
  if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
  const all = await col('barra_precios').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('barra_precios').doc(String(nextId)).set({
    id: nextId, ingrediente, precio: precio || 0, unidad: normalizeUnit(unidad),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.put('/api/barra/precios/:id', async (req, res) => {
  const { precio } = req.body;
  await col('barra_precios').doc(req.params.id).update({
    precio: precio || 0, updated_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.delete('/api/barra/precios/:id', async (req, res) => {
  await col('barra_precios').doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- BARRA MOVIMIENTOS (INGRESOS / VENTAS / BAJAS) ---
app.get('/api/barra/movimientos', authMiddleware, async (req, res) => {
  try {
    const { fecha, tipo } = req.query;
    if (!fecha || !tipo) return res.json([]);
    const snap = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', tipo).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/barra/movimientos', authMiddleware, async (req, res) => {
  try {
    const { fecha, tipo, items } = req.body;
    if (!fecha || !tipo || !items) return res.status(400).json({ error: 'fecha, tipo e items requeridos' });
    const batch = db.batch();
    // Delete existing movements for this fecha+tipo
    const existing = await col('barra_movimientos').where('fecha', '==', fecha).where('tipo', '==', tipo).get();
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
      batch.set(ref, doc);
    }
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- REPORTES ---
app.get('/api/reportes/diferencias', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.json([]);
  const [almsSnap, allInvSnap, allDiasSnap] = await Promise.all([
    col('almacenes').orderBy('orden').get(),
    col('inventario').get(),
    col('inventario_diario').where('fecha', '==', fecha).get(),
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
  const result = [];
  for (const alDoc of almsSnap.docs) {
    const alId = Number(alDoc.id);
    const diaMap = diasByAl[alId] || {};
    for (const inv of (invByAl[alId] || [])) {
      const dia = diaMap[inv.item_id] || {};
      const apertura = dia.stock_apertura ?? 0;
      const ingreso = dia.stock_ingreso ?? 0;
      const salida = dia.salida_almacen ?? 0;
      const ventas = dia.total_ventas ?? 0;
      const falta = dia.falta_almacen ?? 0;
      const baja = dia.stock_baja ?? 0;
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
        stock_cierre: cierre,
        cantidad_minima: minima,
        diferencia: Math.round(diferencia * 100) / 100,
      });
    }
  }
  res.json(result);
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

// --- Fix: rename Kombucha → Kefir in REFRIGERADOR COCINA 1 ---
app.post('/api/migrate/fix-kefir-names', authMiddleware, async (req, res) => {
  try {
    // Find warehouse "Refrigerador Cocina 1 (Abajo)" (id=1)
    const almsSnap = await col('almacenes').get();
    let targetAlmacen = null;
    almsSnap.docs.forEach(d => {
      if (d.data().nombre && /REFRIGERADOR COCINA 1/i.test(d.data().nombre)) targetAlmacen = Number(d.id);
    });
    if (!targetAlmacen) return res.status(404).json({ error: 'No encontrado' });

    const batch = db.batch();
    const invSnap = await col('inventario').where('almacen_id', '==', targetAlmacen).get();
    let renamed = 0;

    invSnap.docs.forEach(d => {
      const inv = d.data();
      let newName = null;
      if (/^kombucha\s+granadilla$/i.test(inv.nombre)) newName = 'Kefir GRANADILLA';
      else if (/^kombucha\s+jamaica$/i.test(inv.nombre)) newName = 'Kefir JAMAICA';
      else if (/^kombucha\s+citrico$/i.test(inv.nombre)) newName = 'KEFIR CITRICO';
      if (newName) { batch.update(d.ref, { nombre: newName }); renamed++; }
    });

    await batch.commit();
    res.json({ ok: true, renamed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
