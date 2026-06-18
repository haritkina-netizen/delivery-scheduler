const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const USE_PG = !!process.env.DATABASE_URL;

// ── Database setup ──────────────────────────────────────────────────────────
let query;

if (USE_PG) {
  // PostgreSQL (Supabase / cloud)
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  query = (sql, params = []) => pool.query(sql, params).then(r => r.rows);

  pool.query(`
    CREATE TABLE IF NOT EXISTS routes (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      driver_name TEXT DEFAULT '',
      driver_phone TEXT DEFAULT '',
      truck_number TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stops (
      id SERIAL PRIMARY KEY,
      route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL DEFAULT 0,
      customer_name TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL,
      lng REAL,
      qty1 REAL DEFAULT 0, qty2 REAL DEFAULT 0, qty3 REAL DEFAULT 0,
      qty4 REAL DEFAULT 0, qty5 REAL DEFAULT 0, qty6 REAL DEFAULT 0,
      price REAL DEFAULT 0,
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'รอส่ง'
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO products (id, name) VALUES
      (1,'อองุ่นขาว'),(2,'ลิ้นจี่'),(3,'แมงลัก'),(4,'ทับทิม'),(5,'กระเจี๊ยบ'),(6,'น้ำชา')
    ON CONFLICT (id) DO NOTHING;
  `).then(() => console.log('PostgreSQL ready')).catch(console.error);

} else {
  // SQLite (local)
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'delivery.db');
  let BetterSqlite3;
  try { BetterSqlite3 = require('better-sqlite3'); } catch(e) { console.error('better-sqlite3 not available. Set DATABASE_URL for PostgreSQL.'); process.exit(1); }
  const db = new BetterSqlite3(DB_PATH);
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
      lat REAL, lng REAL,
      qty1 REAL DEFAULT 0, qty2 REAL DEFAULT 0, qty3 REAL DEFAULT 0,
      qty4 REAL DEFAULT 0, qty5 REAL DEFAULT 0, qty6 REAL DEFAULT 0,
      price REAL DEFAULT 0, note TEXT DEFAULT '', status TEXT DEFAULT 'รอส่ง'
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL
    );
    INSERT OR IGNORE INTO products VALUES
      (1,'อองุ่นขาว'),(2,'ลิ้นจี่'),(3,'แมงลัก'),(4,'ทับทิม'),(5,'กระเจี๊ยบ'),(6,'น้ำชา');
  `);
  query = (sql, params = []) => {
    // Convert $1,$2 → ? for SQLite
    let i = 0;
    const s = sql.replace(/\$\d+/g, () => '?');
    const stmt = db.prepare(s);
    if (/^\s*(insert|update|delete)/i.test(s)) {
      const r = stmt.run(...params);
      return Promise.resolve([{ id: r.lastInsertRowid, changes: r.changes }]);
    }
    return Promise.resolve(stmt.all(...params));
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' };
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method;

  if (m === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(__dirname, 'templates', 'index.html'));
  if (p.startsWith('/static/')) return serveFile(res, path.join(__dirname, p));

  try {
    // Geocode proxy using Photon (Komoot) — works from cloud IPs
    if (p === '/api/geocode' && m === 'GET') {
      const q = url.searchParams.get('q') || '';
      const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=th&bbox=97.3,5.6,105.6,20.5`;
      const https = require('https');
      const raw = await new Promise((resolve, reject) => {
        https.get(photonUrl, { headers: { 'User-Agent': 'delivery-scheduler/1.0' } }, r => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => resolve(body));
        }).on('error', reject);
      });
      // Convert Photon GeoJSON → Nominatim-style array for frontend compatibility
      const geojson = JSON.parse(raw);
      const results = (geojson.features || []).map(f => ({
        display_name: [f.properties.name, f.properties.street, f.properties.city, f.properties.state, 'ประเทศไทย'].filter(Boolean).join(', '),
        name: f.properties.name || f.properties.city || '',
        lat: String(f.geometry.coordinates[1]),
        lon: String(f.geometry.coordinates[0])
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(results));
    }

    // Products
    if (p === '/api/products' && m === 'GET') {
      return send(res, 200, await query('SELECT * FROM products ORDER BY id'));
    }
    if (p === '/api/products' && m === 'PUT') {
      const d = await readBody(req);
      for (const pr of d) await query('UPDATE products SET name=$1 WHERE id=$2', [pr.name, pr.id]);
      return send(res, 200, { ok: true });
    }

    // Routes list
    if (p === '/api/routes' && m === 'GET') {
      return send(res, 200, await query('SELECT * FROM routes ORDER BY date DESC'));
    }

    // Get or create route for date
    if (p === '/api/routes/date' && m === 'GET') {
      const date = url.searchParams.get('date');
      let rows = await query('SELECT * FROM routes WHERE date=$1', [date]);
      if (!rows.length) {
        const ins = await query('INSERT INTO routes (date) VALUES ($1) RETURNING *', [date]);
        rows = USE_PG ? ins : await query('SELECT * FROM routes WHERE date=$1', [date]);
      }
      const route = rows[0];
      const stops = await query('SELECT * FROM stops WHERE route_id=$1 ORDER BY seq,id', [route.id]);
      return send(res, 200, { route, stops });
    }

    // Update route header
    const routeMatch = p.match(/^\/api\/routes\/(\d+)$/);
    if (routeMatch && m === 'PUT') {
      const d = await readBody(req);
      await query('UPDATE routes SET driver_name=$1,driver_phone=$2,truck_number=$3 WHERE id=$4',
        [d.driver_name||'', d.driver_phone||'', d.truck_number||'', routeMatch[1]]);
      return send(res, 200, { ok: true });
    }

    // Create stop
    if (p === '/api/stops' && m === 'POST') {
      const d = await readBody(req);
      const r = await query(
        `INSERT INTO stops (route_id,seq,customer_name,address,lat,lng,qty1,qty2,qty3,qty4,qty5,qty6,price,note,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [d.route_id,d.seq||0,d.customer_name,d.address,d.lat||null,d.lng||null,
         d.qty1||0,d.qty2||0,d.qty3||0,d.qty4||0,d.qty5||0,d.qty6||0,d.price||0,d.note||'',d.status||'รอส่ง']);
      return send(res, 201, { id: r[0].id || r[0].lastInsertRowid });
    }

    const stopMatch = p.match(/^\/api\/stops\/(\d+)$/);

    // Update stop
    if (stopMatch && m === 'PUT') {
      const d = await readBody(req);
      await query(
        `UPDATE stops SET seq=$1,customer_name=$2,address=$3,lat=$4,lng=$5,
         qty1=$6,qty2=$7,qty3=$8,qty4=$9,qty5=$10,qty6=$11,price=$12,note=$13,status=$14 WHERE id=$15`,
        [d.seq||0,d.customer_name,d.address,d.lat||null,d.lng||null,
         d.qty1||0,d.qty2||0,d.qty3||0,d.qty4||0,d.qty5||0,d.qty6||0,d.price||0,d.note||'',d.status||'รอส่ง',
         stopMatch[1]]);
      return send(res, 200, { ok: true });
    }

    // Patch stop (status or coords)
    if (stopMatch && m === 'PATCH') {
      const d = await readBody(req);
      if (d.status !== undefined) await query('UPDATE stops SET status=$1 WHERE id=$2', [d.status, stopMatch[1]]);
      if (d.lat !== undefined) await query('UPDATE stops SET lat=$1,lng=$2 WHERE id=$3', [d.lat, d.lng, stopMatch[1]]);
      if (d.seq !== undefined) await query('UPDATE stops SET seq=$1 WHERE id=$2', [d.seq, stopMatch[1]]);
      return send(res, 200, { ok: true });
    }

    // Delete stop
    if (stopMatch && m === 'DELETE') {
      await query('DELETE FROM stops WHERE id=$1', [stopMatch[1]]);
      return send(res, 200, { ok: true });
    }

    res.writeHead(404); res.end('Not found');
  } catch(e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`✅ http://localhost:${PORT} (${USE_PG ? 'PostgreSQL' : 'SQLite'})`));
