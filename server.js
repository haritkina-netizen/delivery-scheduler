const http = require('http');
const fs = require('fs');
const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'delivery.db');
const db = new (require('better-sqlite3'))(DB_PATH);

const PORT = process.env.PORT || 5000;

db.exec(`
  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    driver_name TEXT DEFAULT '',
    driver_phone TEXT DEFAULT '',
    truck_number TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    customer_name TEXT NOT NULL,
    address TEXT NOT NULL,
    lat REAL,
    lng REAL,
    qty1 REAL DEFAULT 0,
    qty2 REAL DEFAULT 0,
    qty3 REAL DEFAULT 0,
    qty4 REAL DEFAULT 0,
    qty5 REAL DEFAULT 0,
    qty6 REAL DEFAULT 0,
    price REAL DEFAULT 0,
    note TEXT DEFAULT '',
    status TEXT DEFAULT 'รอส่ง'
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  INSERT OR IGNORE INTO products VALUES (1,'อองุ่นขาว'),(2,'ลิ้นจี่'),(3,'แมงลัก'),(4,'ทับทิม'),(5,'กระเจี๊ยบ'),(6,'น้ำชา');
`);

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw ? JSON.parse(raw) : {});
    });
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' }[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method;

  if (m === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(__dirname, 'templates', 'index.html'));
  if (p.startsWith('/static/')) return serveFile(res, path.join(__dirname, p));

  // Products
  if (p === '/api/products' && m === 'GET') {
    return send(res, 200, db.prepare('SELECT * FROM products ORDER BY id').all());
  }
  if (p === '/api/products' && m === 'PUT') {
    const d = await readBody(req);
    const upd = db.prepare('UPDATE products SET name=? WHERE id=?');
    d.forEach(pr => upd.run(pr.name, pr.id));
    return send(res, 200, { ok: true });
  }

  // Routes list
  if (p === '/api/routes' && m === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    let q = 'SELECT * FROM routes WHERE 1=1';
    const params = [];
    if (from) { q += ' AND date >= ?'; params.push(from); }
    if (to)   { q += ' AND date <= ?'; params.push(to); }
    q += ' ORDER BY date DESC';
    return send(res, 200, db.prepare(q).all(...params));
  }

  // Get or upsert a route for a date
  if (p === '/api/routes/date' && m === 'GET') {
    const date = url.searchParams.get('date');
    let route = db.prepare('SELECT * FROM routes WHERE date=?').get(date);
    if (!route) {
      const r = db.prepare('INSERT INTO routes (date) VALUES (?)').run(date);
      route = db.prepare('SELECT * FROM routes WHERE id=?').get(r.lastInsertRowid);
    }
    const stops = db.prepare('SELECT * FROM stops WHERE route_id=? ORDER BY seq,id').all(route.id);
    return send(res, 200, { route, stops });
  }

  // Update route header
  const routeMatch = p.match(/^\/api\/routes\/(\d+)$/);
  if (routeMatch && m === 'PUT') {
    const d = await readBody(req);
    db.prepare('UPDATE routes SET driver_name=?,driver_phone=?,truck_number=? WHERE id=?')
      .run(d.driver_name||'', d.driver_phone||'', d.truck_number||'', parseInt(routeMatch[1]));
    return send(res, 200, { ok: true });
  }

  // Stops
  if (p === '/api/stops' && m === 'POST') {
    const d = await readBody(req);
    const r = db.prepare(`INSERT INTO stops (route_id,seq,customer_name,address,lat,lng,qty1,qty2,qty3,qty4,qty5,qty6,price,note,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.route_id, d.seq||0, d.customer_name, d.address, d.lat||null, d.lng||null,
        d.qty1||0,d.qty2||0,d.qty3||0,d.qty4||0,d.qty5||0,d.qty6||0, d.price||0, d.note||'', d.status||'รอส่ง');
    return send(res, 201, { id: r.lastInsertRowid });
  }

  const stopMatch = p.match(/^\/api\/stops\/(\d+)$/);
  if (stopMatch && m === 'PUT') {
    const d = await readBody(req);
    db.prepare(`UPDATE stops SET seq=?,customer_name=?,address=?,lat=?,lng=?,qty1=?,qty2=?,qty3=?,qty4=?,qty5=?,qty6=?,price=?,note=?,status=? WHERE id=?`)
      .run(d.seq||0, d.customer_name, d.address, d.lat||null, d.lng||null,
        d.qty1||0,d.qty2||0,d.qty3||0,d.qty4||0,d.qty5||0,d.qty6||0, d.price||0, d.note||'', d.status||'รอส่ง',
        parseInt(stopMatch[1]));
    return send(res, 200, { ok: true });
  }

  if (stopMatch && m === 'PATCH') {
    const d = await readBody(req);
    if (d.status !== undefined) db.prepare('UPDATE stops SET status=? WHERE id=?').run(d.status, parseInt(stopMatch[1]));
    if (d.lat !== undefined) db.prepare('UPDATE stops SET lat=?,lng=? WHERE id=?').run(d.lat, d.lng, parseInt(stopMatch[1]));
    return send(res, 200, { ok: true });
  }

  if (stopMatch && m === 'DELETE') {
    db.prepare('DELETE FROM stops WHERE id=?').run(parseInt(stopMatch[1]));
    return send(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
