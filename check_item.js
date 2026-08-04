const init = require('sql.js');
const fs = require('fs');
init().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('sirena.db'));
  const r = db.exec("SELECT id, nombre FROM items WHERE nombre LIKE '%BUTANO%'");
  console.log('GAS BUTANO:', JSON.stringify(r[0]?.values));
  if (r[0]?.values?.length) {
    const itemId = r[0].values[0][0];
    const r2 = db.exec("SELECT fecha, almacen_id, stock_apertura, stock_cierre FROM inventario_diario WHERE item_id=" + itemId + " AND fecha='2026-07-06'");
    console.log('July 6 data for item ' + itemId + ':', JSON.stringify(r2[0]?.values));
  }
  db.close();
});
