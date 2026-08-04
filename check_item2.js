const init = require('sql.js');
const fs = require('fs');
init().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('sirena.db'));
  // Check which almacen GAS BUTANO is in
  const r = db.exec("SELECT almacen_id, stock_apertura, stock_cierre FROM inventario_diario WHERE item_id=66 ORDER BY fecha DESC LIMIT 5");
  console.log('GAS BUTANO inv_diario:', JSON.stringify(r[0]?.values));
  // Check inventario collection
  const r2 = db.exec("SELECT almacen_id, stock_apertura FROM inventario WHERE item_id=66");
  console.log('GAS BUTANO inventario:', JSON.stringify(r2[0]?.values));
  db.close();
});
