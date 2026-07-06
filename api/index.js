const admin = require('firebase-admin');
const express = require('express');
const path = require('path');

// Load service account: from env (Vercel) or local file (development)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
}

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Auth middleware
async function authMiddleware(req, res, next) {
  if (req.path === '/login.html' || req.path === '/app.js' || req.path === '/style.css') return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const token = authHeader.split('Bearer ')[1];
    await admin.auth().verifyIdToken(token);
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

// --- ALMACENES ---
app.get('/api/almacenes', async (req, res) => {
  const snap = await col('almacenes').orderBy('orden').get();
  const almacenes = snap.docs.map(d => ({ id: Number(d.id), ...d.data() }));
  res.json(almacenes);
});

app.get('/api/almacenes/con-inventario', async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.json([]);
  const almsSnap = await col('almacenes').orderBy('orden').get();
  const result = [];
  for (const alDoc of almsSnap.docs) {
    const alId = Number(alDoc.id);
    const itemsSnap = await col('inventario').where('almacen_id', '==', alId).get();
    const diasSnap = await col('inventario_diario')
      .where('fecha', '==', fecha)
      .where('almacen_id', '==', alId)
      .get();
    const diaMap = {};
    diasSnap.docs.forEach(d => {
      const dData = d.data();
      diaMap[dData.item_id] = dData;
    });
    const items = itemsSnap.docs.map(d => {
      const inv = d.data();
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
      };
    });
    result.push({ id: alId, nombre: alDoc.data().nombre, items });
  }
  res.json(result);
});

// --- GUARDAR DÍA ---
app.put('/api/inventario/guardar-dia', async (req, res) => {
  const { fecha, registros } = req.body;
  if (!fecha || !registros) return res.status(400).json({ error: 'fecha y registros requeridos' });
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
    }, { merge: true });
    // Update permanent stock_apertura in inventario
    const invId = docId('inventario', r.almacen_id, r.item_id);
    const invRef = col('inventario').doc(invId);
    batch.set(invRef, {
      stock_apertura: apertura,
    }, { merge: true });
  }
  await batch.commit();

  // Propagation: copy cierre to next working day's apertura
  const nextDay = getNextWorkingDay(fecha);
  const oldSnap = await col('inventario_diario').where('fecha', '==', fecha).get();
  const nextBatch = db.batch();
  let hasChanges = false;
  for (const doc of oldSnap.docs) {
    const d = doc.data();
    const nextId = docId('invdiario', nextDay, d.almacen_id, d.item_id);
    const nextRef = col('inventario_diario').doc(nextId);
    const nextDoc = await nextRef.get();
    if (!nextDoc.exists) {
      nextBatch.set(nextRef, {
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

  res.json({ ok: true });
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
      const id = docId('inventario', m.almacen_id, m.item_id);
      const ref = col('inventario').doc(id);
      batch.update(ref, { cantidad_minima: parseFloat(m.cantidad_minima) || 0 });
    }
  }
  if (botellas) {
    for (const b of botellas) {
      const id = docId('inventario', b.almacen_id, b.item_id);
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
  const almsSnap = await col('almacenes').orderBy('orden').get();
  const result = [];
  for (const alDoc of almsSnap.docs) {
    const alId = Number(alDoc.id);
    const invSnap = await col('inventario').where('almacen_id', '==', alId).get();
    const items = [];
    let stockMap = {};
    if (fecha) {
      const diaSnap = await col('inventario_diario')
        .where('fecha', '==', fecha)
        .where('almacen_id', '==', alId)
        .get();
      diaSnap.docs.forEach(d => {
        const d2 = d.data();
        stockMap[d2.item_id] = d2;
      });
    }
    for (const d of invSnap.docs) {
      const inv = d.data();
      const dia = stockMap[inv.item_id] || {};
      const cierre = (dia.stock_apertura ?? inv.stock_apertura ?? 0) + (dia.stock_ingreso ?? 0) - (dia.salida_almacen ?? 0) - (dia.total_ventas ?? 0) - (dia.falta_almacen ?? 0);
      items.push({
        id: inv.item_id,
        nombre: inv.nombre,
        precio: inv.precio || 0,
        stock_cierre: Math.round(cierre * 100) / 100,
      });
    }
    result.push({ id: alId, nombre: alDoc.data().nombre, items });
  }
  res.json(result);
});

app.put('/api/precios', async (req, res) => {
  const { precios } = req.body;
  if (!precios) return res.status(400).json({ error: 'precios requerido' });
  const batch = db.batch();
  for (const p of precios) {
    const id = docId('inventario', p.almacen_id, p.item_id);
    const ref = col('inventario').doc(id);
    batch.update(ref, { precio: parseFloat(p.precio) || 0 });
  }
  await batch.commit();
  res.json({ ok: true });
});

// --- RECETAS ---
app.get('/api/recetas', async (req, res) => {
  const recSnap = await col('recetas').orderBy('categoria').orderBy('nombre').get();
  const precSnap = await col('barra_precios').get();
  const precios = precSnap.docs.map(d => d.data());
  const result = [];
  for (const d of recSnap.docs) {
    const r = { id: Number(d.id), ...d.data() };
    const ingSnap = await col('receta_ingredientes').where('receta_id', '==', r.id).orderBy('id').get();
    const ingredientes = ingSnap.docs.map(idoc => ({ id: Number(idoc.id), ...idoc.data() }));
    let costoTotal = 0;
    const ingredientesConPrecio = ingredientes.map(ing => {
      const match = precios.find(p => p.ingrediente && p.ingrediente.toLowerCase() === ing.ingrediente.toLowerCase());
      const precioUnidad = match ? (match.precio || 0) : 0;
      const costo = (ing.cantidad || 0) * precioUnidad;
      costoTotal += costo;
      return { ...ing, precioUnidad, costo, precioMatch: !!match };
    });
    result.push({ ...r, ingredientes: ingredientesConPrecio, costoTotal });
  }
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
  const snap = await col('barra_stock').orderBy('ingrediente').get();
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
  const snap = await col('barra_precios').orderBy('ingrediente').get();
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
  const almsSnap = await col('almacenes').orderBy('orden').get();
  const result = [];
  for (const alDoc of almsSnap.docs) {
    const alId = Number(alDoc.id);
    const invSnap = await col('inventario').where('almacen_id', '==', alId).get();
    const diaSnap = await col('inventario_diario')
      .where('fecha', '==', fecha)
      .where('almacen_id', '==', alId)
      .get();
    const diaMap = {};
    diaSnap.docs.forEach(d => { const dd = d.data(); diaMap[dd.item_id] = dd; });
    for (const d of invSnap.docs) {
      const inv = d.data();
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
  res.json({ ok: true });
});

// --- Cron-like propagation on startup ---
// On Vercel, we can't run cron jobs the same way. Will handle via guardar-dia.

module.exports = app;
