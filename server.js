const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const DB_PATH = path.join(__dirname, 'sirena.db');
let db;

function saveDB() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  if (/^\s*(SELECT|WITH)/i.test(sql)) {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  stmt.bind(params);
  stmt.step();
  stmt.free();
  saveDB();
  return { changes: db.getRowsModified() };
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  saveDB();
}

function exec(sql) {
  db.exec(sql);
  saveDB();
}

async function start() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  exec('PRAGMA foreign_keys = ON;');
  try { exec('ALTER TABLE almacenes ADD COLUMN orden INTEGER DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario ADD COLUMN stock_apertura REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario ADD COLUMN salida_almacen REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario ADD COLUMN total_ventas REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario ADD COLUMN stock_cierre REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario_diario ADD COLUMN stock_ingreso REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario ADD COLUMN cantidad_minima REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario_diario ADD COLUMN falta_almacen REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE inventario ADD COLUMN fecha_apertura TEXT DEFAULT NULL;'); } catch(e) {}
  try { exec('ALTER TABLE inventario ADD COLUMN precio REAL DEFAULT 0;'); } catch(e) {}
  try { exec('ALTER TABLE recetas ADD COLUMN categoria TEXT DEFAULT \'Clásicos\';'); } catch(e) {}
  exec(`
    CREATE TABLE IF NOT EXISTS inventario_diario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      almacen_id INTEGER NOT NULL,
      stock_apertura REAL DEFAULT 0,
      stock_ingreso REAL DEFAULT 0,
      salida_almacen REAL DEFAULT 0,
      total_ventas REAL DEFAULT 0,
      stock_cierre REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (almacen_id) REFERENCES almacenes(id) ON DELETE CASCADE,
      UNIQUE(fecha, item_id, almacen_id)
    );
  `);
  exec(`
    CREATE TABLE IF NOT EXISTS almacenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      descripcion TEXT DEFAULT '',
      orden INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      descripcion TEXT DEFAULT '',
      sku TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS inventario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      almacen_id INTEGER NOT NULL,
      cantidad REAL NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (almacen_id) REFERENCES almacenes(id) ON DELETE CASCADE,
      UNIQUE(item_id, almacen_id)
    );
    CREATE TABLE IF NOT EXISTS movimientos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      almacen_id INTEGER NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('entrada', 'salida')),
      cantidad REAL NOT NULL,
      nota TEXT DEFAULT '',
      fecha TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (almacen_id) REFERENCES almacenes(id) ON DELETE CASCADE
    );
  `);
  exec(`
    CREATE TABLE IF NOT EXISTS recetas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS receta_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receta_id INTEGER NOT NULL,
      ingrediente TEXT NOT NULL,
      cantidad REAL DEFAULT 0,
      unidad TEXT DEFAULT 'unidad',
      FOREIGN KEY (receta_id) REFERENCES recetas(id) ON DELETE CASCADE
    );
  `);
  exec(`
    CREATE TABLE IF NOT EXISTS barra_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingrediente TEXT NOT NULL,
      cantidad REAL DEFAULT 0,
      unidad TEXT DEFAULT 'unidad',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  exec(`
    CREATE TABLE IF NOT EXISTS barra_precios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingrediente TEXT NOT NULL,
      unidad TEXT DEFAULT 'unidad',
      precio REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  // Migrate existing barra_stock items to barra_precios if empty
  try {
    const preciosExistentes = query('SELECT COUNT(*) as c FROM barra_precios');
    if (preciosExistentes[0].c === 0) {
      const stockItems = query('SELECT ingrediente, unidad FROM barra_stock');
      for (const s of stockItems) {
        run('INSERT INTO barra_precios (ingrediente, unidad) VALUES (?, ?)', [s.ingrediente, s.unidad]);
      }
    }
  } catch(e) {}

  function copiarCierreAApertura() {
    const hoy = new Date();
    let ayer = new Date(hoy.getTime() - 86400000);
    while (ayer.getDay() === 2) ayer = new Date(ayer.getTime() - 86400000); // skip Tue (closed)
    const hoyStr = hoy.toISOString().split('T')[0];
    const ayerStr = ayer.toISOString().split('T')[0];

    const existentes = query('SELECT COUNT(*) as cnt FROM inventario_diario WHERE fecha = ?', [hoyStr]);
    if (existentes[0].cnt > 0) return;

    const records = query('SELECT * FROM inventario_diario WHERE fecha = ?', [ayerStr]);
    if (records.length === 0) {
      const items = query(`SELECT i.id as item_id, inv.almacen_id, COALESCE(inv.stock_cierre, 0) as sc
                           FROM inventario inv JOIN items i ON i.id = inv.item_id`);
      for (const it of items) {
        run(`INSERT INTO inventario_diario (fecha, item_id, almacen_id, stock_apertura)
             VALUES (?, ?, ?, ?) ON CONFLICT(fecha, item_id, almacen_id) DO NOTHING`,
          [hoyStr, it.item_id, it.almacen_id, it.sc]);
      }
      return;
    }

    for (const r of records) {
      run(`INSERT INTO inventario_diario (fecha, item_id, almacen_id, stock_apertura)
           VALUES (?, ?, ?, ?) ON CONFLICT(fecha, item_id, almacen_id) DO NOTHING`,
        [hoyStr, r.item_id, r.almacen_id, r.stock_cierre ?? r.stock_apertura ?? 0]);
    }
  }

  copiarCierreAApertura();
  cron.schedule('0 0 * * *', copiarCierreAApertura);

  const app = express();
  const PORT = 4000;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.get('/', (req, res) => res.render('index'));

  app.get('/api/almacenes', (req, res) => {
    res.json(query('SELECT * FROM almacenes ORDER BY orden, nombre'));
  });

  app.post('/api/almacenes', (req, res) => {
    const { nombre, descripcion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    run('INSERT INTO almacenes (nombre, descripcion) VALUES (?, ?)', [nombre, descripcion || '']);
    const rows = query('SELECT id FROM almacenes ORDER BY id DESC LIMIT 1');
    res.json({ id: rows[0]?.id });
  });

  app.put('/api/almacenes/:id', (req, res) => {
    const { nombre, descripcion, orden } = req.body;
    const tieneOrden = orden !== undefined;
    const sql = tieneOrden
      ? "UPDATE almacenes SET nombre = ?, descripcion = ?, orden = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      : "UPDATE almacenes SET nombre = ?, descripcion = ?, updated_at = datetime('now','localtime') WHERE id = ?";
    const params = tieneOrden ? [nombre, descripcion || '', orden, req.params.id] : [nombre, descripcion || '', req.params.id];
    run(sql, params);
    res.json({ ok: true });
  });

  app.delete('/api/almacenes/:id', (req, res) => {
    run('DELETE FROM almacenes WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.get('/api/almacenes/con-inventario', (req, res) => {
    const { fecha } = req.query;
    const almacenes = query('SELECT * FROM almacenes ORDER BY orden, nombre');
    const result = almacenes.map(a => {
      let items = query(`SELECT i.id, i.nombre, inv.id as inv_id, inv.cantidad_minima, inv.fecha_apertura
                         FROM inventario inv JOIN items i ON i.id = inv.item_id
                         WHERE inv.almacen_id = ? ORDER BY i.nombre`, [a.id]);
      if (fecha) {
        const diariosRaw = query(`SELECT item_id, stock_apertura, stock_ingreso, salida_almacen, total_ventas, falta_almacen,
               (COALESCE(stock_apertura,0)+COALESCE(stock_ingreso,0)-COALESCE(salida_almacen,0)-COALESCE(total_ventas,0)-COALESCE(falta_almacen,0)) as stock_cierre
               FROM inventario_diario WHERE almacen_id = ? AND fecha = ?`,
              [a.id, fecha]);
        const diarios = {};
        diariosRaw.forEach(d => { diarios[d.item_id] = d; });
        items = items.map(it => {
          const d = diarios[it.id];
          return {
            ...it,
            stock_apertura: d ? d.stock_apertura : 0,
            stock_ingreso: d ? d.stock_ingreso : 0,
            salida_almacen: d ? d.salida_almacen : 0,
            total_ventas: d ? d.total_ventas : 0,
            falta_almacen: d ? d.falta_almacen : 0,
            stock_cierre: d ? d.stock_cierre : 0,
          };
        });
      } else {
        items = items.map(it => ({
          ...it,
          stock_apertura: 0,
          stock_ingreso: 0,
          salida_almacen: 0,
          total_ventas: 0,
          stock_cierre: 0,
        }));
      }
      return { ...a, items };
    });
    res.json(result);
  });

  app.put('/api/inventario/minimos', (req, res) => {
    const { items, botellas } = req.body;
    if (items && items.length) {
      const stmt = db.prepare('UPDATE inventario SET cantidad_minima = ? WHERE id = ?');
      items.forEach(({ id, cantidad_minima }) => {
        stmt.bind([cantidad_minima ?? 0, id]);
        stmt.step();
        stmt.reset();
      });
      stmt.free();
    }
    if (botellas && botellas.length) {
      const stmt = db.prepare('UPDATE inventario SET fecha_apertura = ? WHERE item_id = ? AND almacen_id = ?');
      botellas.forEach(({ item_id, almacen_id, fecha_apertura }) => {
        stmt.bind([fecha_apertura || null, item_id, almacen_id]);
        stmt.step();
        stmt.reset();
      });
      stmt.free();
    }
    saveDB();
    res.json({ ok: true });
  });

  app.get('/api/precios', (req, res) => {
    const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
    const rows = query(`SELECT i.id as item_id, i.nombre as item, inv.almacen_id, a.nombre as almacen,
                               COALESCE(inv.precio,0) as precio,
                               COALESCE((SELECT COALESCE(stock_apertura,0)+COALESCE(stock_ingreso,0)-COALESCE(salida_almacen,0)-COALESCE(total_ventas,0)-COALESCE(falta_almacen,0)
                                         FROM inventario_diario WHERE item_id = i.id AND almacen_id = inv.almacen_id AND fecha = ?),0) as stock_cierre
                        FROM inventario inv
                        JOIN items i ON i.id = inv.item_id
                        JOIN almacenes a ON a.id = inv.almacen_id
                        ORDER BY a.orden, a.nombre, i.nombre`, [fecha]);
    const agrupados = {};
    rows.forEach(r => {
      if (!agrupados[r.almacen_id]) agrupados[r.almacen_id] = { almacen_id: r.almacen_id, almacen: r.almacen, items: [] };
      agrupados[r.almacen_id].items.push({ item_id: r.item_id, item: r.item, precio: r.precio, stock_cierre: r.stock_cierre });
    });
    res.json(Object.values(agrupados));
  });

  app.put('/api/precios', (req, res) => {
    const { items } = req.body;
    if (items && items.length) {
      const stmt = db.prepare('UPDATE inventario SET precio = ? WHERE item_id = ? AND almacen_id = ?');
      items.forEach(({ item_id, almacen_id, precio }) => {
        stmt.bind([precio ?? 0, item_id, almacen_id]);
        stmt.step();
        stmt.reset();
      });
      stmt.free();
      saveDB();
    }
    res.json({ ok: true });
  });

  app.get('/api/items', (req, res) => {
    res.json(query('SELECT * FROM items ORDER BY nombre'));
  });

  app.post('/api/items', (req, res) => {
    const { nombre, descripcion, sku } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    run('INSERT INTO items (nombre, descripcion, sku) VALUES (?, ?, ?)', [nombre, descripcion || '', sku || null]);
    const rows = query('SELECT id FROM items ORDER BY id DESC LIMIT 1');
    res.json({ id: rows[0]?.id });
  });

  app.put('/api/items/:id', (req, res) => {
    const { nombre, descripcion, sku } = req.body;
    run("UPDATE items SET nombre = ?, descripcion = ?, sku = ?, updated_at = datetime('now','localtime') WHERE id = ?",
      [nombre, descripcion || '', sku || null, req.params.id]);
    res.json({ ok: true });
  });

  app.delete('/api/items/:id', (req, res) => {
    run('DELETE FROM items WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.get('/api/inventario', (req, res) => {
    const { almacen_id } = req.query;
    let sql = `SELECT i.id, i.nombre as item_nombre, i.sku,
                      inv.cantidad, inv.almacen_id, a.nombre as almacen_nombre
               FROM inventario inv JOIN items i ON i.id = inv.item_id
               JOIN almacenes a ON a.id = inv.almacen_id`;
    const params = [];
    if (almacen_id) { sql += ' WHERE inv.almacen_id = ?'; params.push(almacen_id); }
    sql += ' ORDER BY a.nombre, i.nombre';
    res.json(query(sql, params));
  });

  app.post('/api/inventario/ajustar', (req, res) => {
    const { item_id, almacen_id, cantidad, nota } = req.body;
    if (!item_id || !almacen_id || cantidad === undefined)
      return res.status(400).json({ error: 'item_id, almacen_id y cantidad requeridos' });

    const existing = query('SELECT cantidad FROM inventario WHERE item_id = ? AND almacen_id = ?', [item_id, almacen_id]);
    const current = existing[0]?.cantidad || 0;
    const diff = cantidad - current;
    const tipo = diff >= 0 ? 'entrada' : 'salida';

    run(`INSERT INTO inventario (item_id, almacen_id, cantidad, updated_at) VALUES (?, ?, ?, datetime('now','localtime'))
         ON CONFLICT(item_id, almacen_id) DO UPDATE SET cantidad = excluded.cantidad, updated_at = excluded.updated_at`,
      [item_id, almacen_id, cantidad]);
    run('INSERT INTO movimientos (item_id, almacen_id, tipo, cantidad, nota) VALUES (?, ?, ?, ?, ?)',
      [item_id, almacen_id, tipo, Math.abs(diff), nota || `Ajuste a ${cantidad}`]);
    res.json({ ok: true });
  });

  app.delete('/api/inventario/:id', (req, res) => {
    run('DELETE FROM inventario WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.put('/api/inventario/:id', (req, res) => {
    const { stock_apertura, salida_almacen, total_ventas, stock_cierre } = req.body;
    run(`UPDATE inventario SET stock_apertura = ?, salida_almacen = ?, total_ventas = ?, stock_cierre = ?,
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [stock_apertura, salida_almacen, total_ventas, stock_cierre, req.params.id]);
    res.json({ ok: true });
  });

  app.post('/api/almacenes/guardar-dia', (req, res) => {
    const { fecha, registros } = req.body;
    if (!fecha || !registros || !registros.length)
      return res.status(400).json({ error: 'fecha y registros requeridos' });

    for (const r of registros) {
      run(`INSERT INTO inventario_diario (fecha, item_id, almacen_id, stock_apertura, stock_ingreso, salida_almacen, total_ventas, falta_almacen, stock_cierre, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(fecha, item_id, almacen_id) DO UPDATE SET
          stock_apertura = excluded.stock_apertura,
          stock_ingreso = excluded.stock_ingreso,
          salida_almacen = excluded.salida_almacen,
          total_ventas = excluded.total_ventas,
          falta_almacen = excluded.falta_almacen,
          stock_cierre = excluded.stock_cierre,
          updated_at = excluded.updated_at`,
        [fecha, r.item_id, r.almacen_id, r.stock_apertura, r.stock_ingreso ?? 0, r.salida_almacen, r.total_ventas, r.falta_almacen ?? 0, r.stock_cierre]);
    }
    // propagate cierre to next working day's apertura
    const nextDate = new Date(fecha);
    nextDate.setDate(nextDate.getDate() + 1);
    while (nextDate.getDay() === 2) nextDate.setDate(nextDate.getDate() + 1); // skip Tue (closed)
    const nextStr = nextDate.toISOString().split('T')[0];
    for (const r of registros) {
      run(`INSERT INTO inventario_diario (fecha, item_id, almacen_id, stock_apertura)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(fecha, item_id, almacen_id) DO UPDATE SET
             stock_apertura = excluded.stock_apertura`,
        [nextStr, r.item_id, r.almacen_id, r.stock_cierre ?? r.stock_apertura ?? 0]);
    }
    res.json({ ok: true });
  });

  app.get('/api/fechas-disponibles', (req, res) => {
    const rows = query('SELECT DISTINCT fecha FROM inventario_diario ORDER BY fecha DESC');
    res.json(rows.map(r => r.fecha));
  });

  app.get('/api/diario/:fecha', (req, res) => {
    res.json(query('SELECT * FROM inventario_diario WHERE fecha = ? ORDER BY almacen_id, item_id', [req.params.fecha]));
  });

  app.post('/api/movimientos/entrada', (req, res) => {
    const { item_id, almacen_id, cantidad, nota } = req.body;
    if (!item_id || !almacen_id || !cantidad)
      return res.status(400).json({ error: 'item_id, almacen_id y cantidad requeridos' });

    run(`INSERT INTO inventario (item_id, almacen_id, cantidad, updated_at) VALUES (?, ?, ?, datetime('now','localtime'))
         ON CONFLICT(item_id, almacen_id) DO UPDATE SET cantidad = cantidad + ?, updated_at = datetime('now','localtime')`,
      [item_id, almacen_id, cantidad, cantidad]);
    run('INSERT INTO movimientos (item_id, almacen_id, tipo, cantidad, nota) VALUES (?, ?, ?, ?, ?)',
      [item_id, almacen_id, 'entrada', cantidad, nota || '']);
    res.json({ ok: true });
  });

  app.post('/api/movimientos/salida', (req, res) => {
    const { item_id, almacen_id, cantidad, nota } = req.body;
    if (!item_id || !almacen_id || !cantidad)
      return res.status(400).json({ error: 'item_id, almacen_id y cantidad requeridos' });

    const inv = query('SELECT cantidad FROM inventario WHERE item_id = ? AND almacen_id = ?', [item_id, almacen_id]);
    if (!inv[0] || inv[0].cantidad < cantidad)
      return res.status(400).json({ error: 'Stock insuficiente' });

    run("UPDATE inventario SET cantidad = cantidad - ?, updated_at = datetime('now','localtime') WHERE item_id = ? AND almacen_id = ?",
      [cantidad, item_id, almacen_id]);
    run('INSERT INTO movimientos (item_id, almacen_id, tipo, cantidad, nota) VALUES (?, ?, ?, ?, ?)',
      [item_id, almacen_id, 'salida', cantidad, nota || '']);
    res.json({ ok: true });
  });

  app.get('/api/movimientos', (req, res) => {
    const { item_id, almacen_id, desde, hasta } = req.query;
    let sql = `SELECT m.*, i.nombre as item_nombre, a.nombre as almacen_nombre
               FROM movimientos m JOIN items i ON i.id = m.item_id
               JOIN almacenes a ON a.id = m.almacen_id WHERE 1=1`;
    const params = [];
    if (item_id) { sql += ' AND m.item_id = ?'; params.push(item_id); }
    if (almacen_id) { sql += ' AND m.almacen_id = ?'; params.push(almacen_id); }
    if (desde) { sql += ' AND m.fecha >= ?'; params.push(desde); }
    if (hasta) { sql += ' AND m.fecha <= ?'; params.push(hasta); }
    sql += ' ORDER BY m.fecha DESC LIMIT 500';
    res.json(query(sql, params));
  });

  app.get('/api/reportes/resumen', (req, res) => {
    res.json(query(`SELECT a.id, a.nombre, COUNT(DISTINCT inv.item_id) as total_items
                     FROM almacenes a LEFT JOIN inventario inv ON inv.almacen_id = a.id
                     GROUP BY a.id ORDER BY a.nombre`));
  });

  app.get('/api/reportes/diferencias', (req, res) => {
    const fecha = req.query.fecha;
    if (!fecha) return res.json([]);
    res.json(query(`SELECT dd.item_id, i.nombre, dd.almacen_id, a.nombre as almacen_nombre,
                           dd.stock_apertura, dd.stock_ingreso, dd.salida_almacen, dd.total_ventas, dd.falta_almacen,
                           (COALESCE(dd.stock_apertura,0) + COALESCE(dd.stock_ingreso,0) - COALESCE(dd.salida_almacen,0) - COALESCE(dd.total_ventas,0) - COALESCE(dd.falta_almacen,0)) as stock_cierre,
                           (COALESCE(dd.stock_ingreso,0) - COALESCE(dd.salida_almacen,0) - COALESCE(dd.total_ventas,0) - COALESCE(dd.falta_almacen,0)) as diferencia
                    FROM inventario_diario dd
                    JOIN items i ON i.id = dd.item_id
                    JOIN almacenes a ON a.id = dd.almacen_id
                     WHERE dd.fecha = ? AND ((COALESCE(dd.stock_ingreso,0) - COALESCE(dd.salida_almacen,0) - COALESCE(dd.total_ventas,0) - COALESCE(dd.falta_almacen,0)) != 0 OR COALESCE(dd.falta_almacen,0) != 0)
                    ORDER BY a.nombre, i.nombre`, [fecha]));
  });

  app.get('/api/reportes/movimientos-por-fecha', (req, res) => {
    const { desde, hasta } = req.query;
    let sql = `SELECT DATE(m.fecha) as dia, m.tipo, SUM(m.cantidad) as total, COUNT(*) as num_movimientos
               FROM movimientos m WHERE 1=1`;
    const params = [];
    if (desde) { sql += ' AND m.fecha >= ?'; params.push(desde); }
    if (hasta) { sql += ' AND m.fecha <= ?'; params.push(hasta); }
    sql += ' GROUP BY dia, m.tipo ORDER BY dia DESC LIMIT 60';
    res.json(query(sql, params));
  });

  // --- BARRA: Recetas ---
  app.get('/api/recetas', (req, res) => {
    const recetas = query('SELECT * FROM recetas ORDER BY categoria, nombre');
    const precios = query('SELECT * FROM barra_precios');
    const result = recetas.map(r => {
      const ingredientes = query('SELECT * FROM receta_ingredientes WHERE receta_id = ? ORDER BY id', [r.id]);
      let costoTotal = 0;
      const ingredientesConPrecio = ingredientes.map(ing => {
        const match = precios.find(p => p.ingrediente.toLowerCase() === ing.ingrediente.toLowerCase());
        const precioUnidad = match ? match.precio : 0;
        const costo = (ing.cantidad || 0) * precioUnidad;
        costoTotal += costo;
        return { ...ing, precioUnidad, costo, precioMatch: !!match };
      });
      return { ...r, ingredientes: ingredientesConPrecio, costoTotal };
    });
    res.json(result);
  });

  app.post('/api/recetas', (req, res) => {
    const { nombre, categoria } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    run('INSERT INTO recetas (nombre, categoria) VALUES (?, ?)', [nombre, categoria || 'Clásicos']);
    const rows = query('SELECT id FROM recetas ORDER BY id DESC LIMIT 1');
    res.json({ id: rows[0]?.id });
  });

  app.put('/api/recetas/:id', (req, res) => {
    const { nombre, categoria } = req.body;
    run('UPDATE recetas SET nombre = ?, categoria = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [nombre, categoria || 'Clásicos', req.params.id]);
    res.json({ ok: true });
  });

  app.delete('/api/recetas/:id', (req, res) => {
    run('DELETE FROM receta_ingredientes WHERE receta_id = ?', [req.params.id]);
    run('DELETE FROM recetas WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.post('/api/recetas/:id/ingredientes', (req, res) => {
    const { ingrediente, cantidad, unidad } = req.body;
    run('INSERT INTO receta_ingredientes (receta_id, ingrediente, cantidad, unidad) VALUES (?, ?, ?, ?)',
      [req.params.id, ingrediente, cantidad || 0, unidad || 'unidad']);
    res.json({ ok: true });
  });

  app.put('/api/receta-ingredientes/:id', (req, res) => {
    const { ingrediente, cantidad, unidad } = req.body;
    run('UPDATE receta_ingredientes SET ingrediente = ?, cantidad = ?, unidad = ? WHERE id = ?',
      [ingrediente, cantidad || 0, unidad || 'unidad', req.params.id]);
    res.json({ ok: true });
  });

  app.delete('/api/receta-ingredientes/:id', (req, res) => {
    run('DELETE FROM receta_ingredientes WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.put('/api/recetas/:id/with-ingredientes', (req, res) => {
    const { nombre, categoria, ingredientes } = req.body;
    const id = req.params.id;
    run('UPDATE recetas SET nombre = ?, categoria = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
      [nombre, categoria || 'Clásicos', id]);
    run('DELETE FROM receta_ingredientes WHERE receta_id = ?', [id]);
    if (ingredientes && ingredientes.length) {
      const stmt = db.prepare('INSERT INTO receta_ingredientes (receta_id, ingrediente, cantidad, unidad) VALUES (?, ?, ?, ?)');
      ingredientes.forEach(ing => {
        stmt.bind([id, ing.ingrediente, ing.cantidad || 0, ing.unidad || 'unidad']);
        stmt.step();
        stmt.reset();
      });
      stmt.free();
      saveDB();
    }
    res.json({ ok: true });
  });

  // --- BARRA: Stock ---
  app.get('/api/barra/stock', (req, res) => {
    res.json(query('SELECT * FROM barra_stock ORDER BY ingrediente'));
  });

  app.post('/api/barra/stock', (req, res) => {
    const { ingrediente, cantidad, unidad } = req.body;
    if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
    run('INSERT INTO barra_stock (ingrediente, cantidad, unidad) VALUES (?, ?, ?)',
      [ingrediente, cantidad || 0, unidad || 'unidad']);
    res.json({ ok: true });
  });

  app.put('/api/barra/stock/:id', (req, res) => {
    const { cantidad } = req.body;
    run('UPDATE barra_stock SET cantidad = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
      [cantidad ?? 0, req.params.id]);
    res.json({ ok: true });
  });

  app.delete('/api/barra/stock/:id', (req, res) => {
    run('DELETE FROM barra_stock WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // --- BARRA: Base de Datos (precios) ---
  app.get('/api/barra/precios', (req, res) => {
    res.json(query('SELECT * FROM barra_precios ORDER BY ingrediente'));
  });

  app.post('/api/barra/precios', (req, res) => {
    const { ingrediente, unidad, precio } = req.body;
    if (!ingrediente) return res.status(400).json({ error: 'Nombre requerido' });
    run('INSERT INTO barra_precios (ingrediente, unidad, precio) VALUES (?, ?, ?)',
      [ingrediente, unidad || 'unidad', precio ?? 0]);
    res.json({ ok: true });
  });

  app.put('/api/barra/precios/:id', (req, res) => {
    const { precio } = req.body;
    run('UPDATE barra_precios SET precio = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
      [precio ?? 0, req.params.id]);
    res.json({ ok: true });
  });

  app.delete('/api/barra/precios/:id', (req, res) => {
    run('DELETE FROM barra_precios WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.listen(PORT, () => {
    console.log(`Sirena corriendo en http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Error al iniciar:', err);
  process.exit(1);
});
