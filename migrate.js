const admin = require('firebase-admin');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Load service account
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8'));

if (admin.apps.length === 0) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const DB_PATH = path.join(__dirname, 'sirena.db');

async function migrate() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('No sirena.db found. Skipping migration.');
    return;
  }
  const SQL = await initSqlJs();
  const sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));

  // Migrate almacenes
  console.log('Migrating almacenes...');
  const alms = sqlDb.exec('SELECT * FROM almacenes ORDER BY id');
  for (const row of alms[0]?.values || []) {
    await db.collection('almacenes').doc(String(row[0])).set({
      nombre: row[1], descripcion: row[2] || '',
      created_at: row[3] || '', updated_at: row[4] || '', orden: row[5] || 0
    });
  }
  console.log('  Done: ' + (alms[0]?.values?.length || 0) + ' almacenes');

  // Migrate items
  console.log('Migrating items...');
  const items = sqlDb.exec('SELECT * FROM items ORDER BY id');
  for (const row of items[0]?.values || []) {
    await db.collection('items').doc(String(row[0])).set({
      nombre: row[1], descripcion: row[2] || '', sku: row[3] || '',
      created_at: row[4] || '', updated_at: row[5] || ''
    });
  }
  console.log('  Done: ' + (items[0]?.values?.length || 0) + ' items');

  // Migrate inventario
  console.log('Migrating inventario...');
  const inv = sqlDb.exec('SELECT * FROM inventario ORDER BY id');
  for (const row of inv[0]?.values || []) {
    const id = row[1] + '_' + row[2]; // item_id_almacen_id
    await db.collection('inventario').doc(id).set({
      item_id: row[1], almacen_id: row[2],
      nombre: row[7] || '', categoria: row[8] || '',
      cantidad_minima: row[11] || 0, stock_apertura: row[9] || 0,
      fecha_apertura: row[12] || '', precio: row[13] || 0,
      falta_almacen: row[10] || 0,
    });
  }
  console.log('  Done: ' + (inv[0]?.values?.length || 0) + ' registros');

  // Migrate inventario_diario
  console.log('Migrating inventario_diario...');
  const diario = sqlDb.exec('SELECT * FROM inventario_diario ORDER BY id');
  let dCount = 0;
  for (const row of diario[0]?.values || []) {
    const id = row[1] + '_' + row[3] + '_' + row[2]; // fecha_almacen_id_item_id
    await db.collection('inventario_diario').doc(id).set({
      fecha: row[1], item_id: row[2], almacen_id: row[3],
      stock_apertura: row[4] || 0, salida_almacen: row[5] || 0,
      total_ventas: row[6] || 0, stock_cierre: row[7] || 0,
      stock_ingreso: row[10] || 0, falta_almacen: row[11] || 0,
      created_at: row[8] || '', updated_at: row[9] || ''
    });
    dCount++;
    if (dCount % 100 === 0) process.stdout.write('.');
  }
  console.log('\n  Done: ' + dCount + ' registros');

  // Migrate recetas
  console.log('Migrating recetas...');
  const recetas = sqlDb.exec('SELECT * FROM recetas ORDER BY id');
  for (const row of recetas[0]?.values || []) {
    await db.collection('recetas').doc(String(row[0])).set({
      nombre: row[1], categoria: row[4] || 'Clásicos',
      created_at: row[2] || '', updated_at: row[3] || ''
    });
  }
  console.log('  Done: ' + (recetas[0]?.values?.length || 0) + ' recetas');

  // Migrate receta_ingredientes
  console.log('Migrating receta_ingredientes...');
  const ingrs = sqlDb.exec('SELECT * FROM receta_ingredientes ORDER BY id');
  for (const row of ingrs[0]?.values || []) {
    await db.collection('receta_ingredientes').doc(String(row[0])).set({
      id: row[0], receta_id: row[1],
      ingrediente: row[2], cantidad: row[3] || 0, unidad: row[4] || 'unidad'
    });
  }
  console.log('  Done: ' + (ingrs[0]?.values?.length || 0) + ' ingredientes');

  // Migrate barra_stock
  console.log('Migrating barra_stock...');
  const bstock = sqlDb.exec('SELECT * FROM barra_stock ORDER BY id');
  for (const row of bstock[0]?.values || []) {
    await db.collection('barra_stock').doc(String(row[0])).set({
      id: row[0], ingrediente: row[1], cantidad: row[2] || 0,
      unidad: row[3] || 'unidad', created_at: row[4] || '', updated_at: row[5] || ''
    });
  }
  console.log('  Done: ' + (bstock[0]?.values?.length || 0) + ' items');

  // Migrate barra_precios
  console.log('Migrating barra_precios...');
  const bprecios = sqlDb.exec('SELECT * FROM barra_precios ORDER BY id');
  for (const row of bprecios[0]?.values || []) {
    await db.collection('barra_precios').doc(String(row[0])).set({
      id: row[0], ingrediente: row[1], unidad: row[2] || 'unidad',
      precio: row[3] || 0, created_at: row[4] || '', updated_at: row[5] || ''
    });
  }
  console.log('  Done: ' + (bprecios[0]?.values?.length || 0) + ' items');

  sqlDb.close();
  console.log('\nMigración completada exitosamente.');
}

migrate().catch(err => { console.error('Migration error:', err); process.exit(1); });
