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
  const snap = await cached('almacenes', 60000, () => col('almacenes').orderBy('orden').get());
  const almacenes = snap.docs.map(d => ({ id: Number(d.id), ...d.data() }));
  res.json(almacenes);
});

app.get('/api/almacenes/con-inventario', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.json([]);
  const [almsSnap, allItemsSnap] = await Promise.all([
    cached('almacenes', 60000, () => col('almacenes').orderBy('orden').get()),
    cached('inventario', 60000, () => col('inventario').get()),
  ]);
  const itemsByAl = {};
  allItemsSnap.docs.forEach(d => {
    const inv = d.data();
    const alId = inv.almacen_id;
    if (!itemsByAl[alId]) itemsByAl[alId] = [];
    itemsByAl[alId].push(inv);
  });
  let allDiasSnap = { docs: [] };
  if (fecha) {
    allDiasSnap = await cached('inv_diario_' + fecha, 30000, () => col('inventario_diario').where('fecha', '==', fecha).get());
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
    const items = invItems.map(inv => {
      const dia = diaMap[inv.item_id] || {};
      const apertura = dia.stock_apertura ?? inv.stock_apertura ?? 0;
      const ingreso = dia.stock_ingreso ?? 0;
      const salida = dia.salida_almacen ?? 0;
      const ventas = dia.total_ventas ?? 0;
      const falta = dia.falta_almacen ?? inv.falta_almacen ?? 0;
      const cierre = apertura + ingreso - salida - ventas - falta;
      return {
        id: inv.item_id,
        nombre: inv.nombre,
        categoria: inv.categoria || '',
        stock_apertura: apertura,
        stock_ingreso: ingreso,
        salida_almacen: salida,
        total_ventas: ventas,
        falta_almacen: falta,
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
    const cierre = apertura + ingreso - salida - ventas - falta;
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

  // Invalidate cache so next GET sees fresh saved_by / updated_at
  delete _cache['inv_diario_' + fecha];

  res.json({ ok: true });

  // Async propagation (respond first, propagate in background)
  try {
    const nextDay = getNextWorkingDay(fecha);
    const oldSnap = await col('inventario_diario').where('fecha', '==', fecha).get();
    const nextDocs = await Promise.all(oldSnap.docs.map(doc => {
      const d = doc.data();
      const nextId = docId('invdiario', nextDay, d.almacen_id, d.item_id);
      return col('inventario_diario').doc(nextId).get().then(snap => ({ d, exists: snap.exists }));
    }));
    const nextBatch = db.batch();
    let hasChanges = false;
    for (const { d, exists } of nextDocs) {
      if (!exists) {
        nextBatch.set(col('inventario_diario').doc(docId('invdiario', nextDay, d.almacen_id, d.item_id)), {
          fecha: nextDay,
          item_id: d.item_id,
          almacen_id: d.almacen_id,
          stock_apertura: d.stock_cierre ?? 0,
          stock_ingreso: 0,
          salida_almacen: 0,
          total_ventas: 0,
          falta_almacen: 0,
          stock_cierre: d.stock_cierre ?? 0,
          updated_at: new Date().toISOString(),
        });
        hasChanges = true;
      }
    }
    if (hasChanges) await nextBatch.commit();
  } catch (e) {
    console.error('Async propagation error:', e.message);
  }
});

function getNextWorkingDay(fecha) {
  const d = new Date(fecha + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 2) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// --- MINIMOS ---
app.put('/api/inventario/minimos', async (req, res) => {
  const { minimos, botellas } = req.body;
  const batch = db.batch();
  if (minimos) {
    for (const m of minimos) {
      const id = docId('inventario', m.item_id, m.almacen_id);
      const ref = col('inventario').doc(id);
      batch.update(ref, { cantidad_minima: parseFloat(m.cantidad_minima) || 0 });
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
});

// --- PRECIOS ---
app.get('/api/precios', async (req, res) => {
  const fecha = req.query.fecha;
  const [almsSnap, allInvSnap, allDiasSnap] = await Promise.all([
    cached('almacenes', 60000, () => col('almacenes').orderBy('orden').get()),
    cached('inventario', 60000, () => col('inventario').get()),
    fecha ? cached('inv_diario_' + fecha, 30000, () => col('inventario_diario').where('fecha', '==', fecha).get()) : Promise.resolve({ docs: [] }),
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
      const cierre = (dia.stock_apertura ?? inv.stock_apertura ?? 0) + (dia.stock_ingreso ?? 0) - (dia.salida_almacen ?? 0) - (dia.total_ventas ?? 0) - (dia.falta_almacen ?? 0);
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
    batch.update(ref, { precio: parseFloat(p.precio) || 0 });
  }
  await batch.commit();
  res.json({ ok: true });
});

// --- RECETAS ---
app.get('/api/recetas', async (req, res) => {
  const [recSnap, precSnap, ingSnap] = await Promise.all([
    cached('recetas', 60000, () => col('recetas').orderBy('categoria').orderBy('nombre').get()),
    cached('barra_precios', 60000, () => col('barra_precios').orderBy('ingrediente').get()),
    cached('receta_ingredientes', 60000, () => col('receta_ingredientes').orderBy('id').get()),
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
    ingrediente, cantidad: cantidad || 0, unidad: unidad || 'unidad'
  });
  res.json({ ok: true });
});

app.put('/api/receta-ingredientes/:id', async (req, res) => {
  const { ingrediente, cantidad, unidad } = req.body;
  await col('receta_ingredientes').doc(req.params.id).update({
    ingrediente, cantidad: cantidad || 0, unidad: unidad || 'unidad'
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
      batch.set(ref, { id: maxId, receta_id: Number(id), ingrediente: ing.ingrediente, cantidad: ing.cantidad || 0, unidad: ing.unidad || 'unidad' });
    }
  }
  await batch.commit();
  res.json({ ok: true });
});

// --- BARRA STOCK ---
app.get('/api/barra/stock', async (req, res) => {
  const snap = await cached('barra_stock', 60000, () => col('barra_stock').orderBy('ingrediente').get());
  res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
});

app.post('/api/barra/stock', async (req, res) => {
  const { ingrediente, cantidad, unidad } = req.body;
  if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
  const all = await col('barra_stock').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('barra_stock').doc(String(nextId)).set({
    id: nextId, ingrediente, cantidad: cantidad || 0, unidad: unidad || 'unidad',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.put('/api/barra/stock/:id', async (req, res) => {
  const { cantidad, ingrediente, unidad } = req.body;
  const upd = { updated_at: new Date().toISOString() };
  if (cantidad !== undefined) upd.cantidad = cantidad;
  if (ingrediente) upd.ingrediente = ingrediente;
  if (unidad) upd.unidad = unidad;
  await col('barra_stock').doc(req.params.id).update(upd);
  res.json({ ok: true });
});

app.delete('/api/barra/stock/:id', async (req, res) => {
  await col('barra_stock').doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- BARRA PRECIOS ---
app.get('/api/barra/precios', async (req, res) => {
  const snap = await cached('barra_precios', 60000, () => col('barra_precios').orderBy('ingrediente').get());
  res.json(snap.docs.map(d => ({ id: Number(d.id), ...d.data() })));
});

app.post('/api/barra/precios', async (req, res) => {
  const { ingrediente, precio, unidad } = req.body;
  if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
  const all = await col('barra_precios').get();
  const nextId = all.docs.length > 0 ? Math.max(...all.docs.map(d => Number(d.id) || 0)) + 1 : 1;
  await col('barra_precios').doc(String(nextId)).set({
    id: nextId, ingrediente, precio: precio || 0, unidad: unidad || 'unidad',
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

// --- REPORTES ---
app.get('/api/reportes/diferencias', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.json([]);
  const [almsSnap, allInvSnap, allDiasSnap] = await Promise.all([
    cached('almacenes', 60000, () => col('almacenes').orderBy('orden').get()),
    cached('inventario', 60000, () => col('inventario').get()),
    cached('inv_diario_' + fecha, 30000, () => col('inventario_diario').where('fecha', '==', fecha).get()),
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
      const cierre = apertura + ingreso - salida - ventas - falta;
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

// --- Cron-like propagation on startup ---
// On Vercel, we can't run cron jobs the same way. Will handle via guardar-dia.

module.exports = app;
