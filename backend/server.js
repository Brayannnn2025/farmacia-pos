const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();

// =========================
// CONFIG
// =========================
app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, "db.sqlite");
const db = new sqlite3.Database(DB_PATH);

// ✅ En producción real va en .env
const JWT_SECRET = "cambia_esto_por_algo_mas_largo_y_secreto";

// ✅ SERVIR FRONTEND
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));

// =========================
// FETCH (para Node < 18)
// =========================
// Node 18+ ya trae fetch global.
// Si tu Node es < 18, habilitamos fetch con node-fetch (import dinámico).
// NOTA: Si luego te sale "fetch is not defined", instala en EC2:
//   cd backend && npm i node-fetch
const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Helpers sqlite -> promises
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Auth middleware
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autorizado" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // {id, username, role}
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const r = req.user?.role;
    if (!roles.includes(r)) return res.status(403).json({ error: "No permitido" });
    next();
  };
}

// Utils
function isoNow() {
  return new Date().toISOString();
}

function isExpired(expiry_date) {
  if (!expiry_date) return false;
  const d = new Date(expiry_date + "T00:00:00");
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const e0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return e0 < t0;
}

async function ensureColumn(table, column, typeSql) {
  const cols = await all(`PRAGMA table_info(${table})`);
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
    console.log(`✅ Migración: agregado ${table}.${column}`);
  }
}

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin'
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      lab TEXT DEFAULT '',
      stock INTEGER NOT NULL DEFAULT 0,
      buy_price REAL NOT NULL DEFAULT 0,
      sell_price REAL NOT NULL DEFAULT 0,
      expiry_date TEXT DEFAULT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL,
      seller_user_id INTEGER,
      FOREIGN KEY (seller_user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      price_unit REAL NOT NULL,
      subtotal REAL NOT NULL,
      FOREIGN KEY (sale_id) REFERENCES sales(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  // Migraciones
  await ensureColumn("products", "location", "TEXT DEFAULT ''");

  // Crear admin por defecto si no existe
  const admin = await get(`SELECT * FROM users WHERE username=?`, ["admin"]);
  if (!admin) {
    const hash = bcrypt.hashSync("admin123", 10);
    await run(`INSERT INTO users(username, password_hash, role) VALUES(?,?,?)`, [
      "admin",
      hash,
      "admin",
    ]);
    console.log("✅ Usuario creado: admin / admin123");
  }

  console.log("✅ DB lista:", DB_PATH);
}

// =========================
// RUTAS BASICAS
// =========================
app.get("/health", (_, res) => res.json({ ok: true }));

// Root = login
app.get("/", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "login.html")));
app.get("/login", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "login.html")));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "dashboard.html")));

// =========================
// AUTH
// =========================
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Faltan datos" });

  const user = await get(`SELECT * FROM users WHERE username=?`, [username]);
  if (!user) return res.status(401).json({ error: "Credenciales inválidas" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// =========================
// USERS (ADMIN)
// =========================
app.get("/api/users", auth, requireRole("admin"), async (_req, res) => {
  const rows = await all(`SELECT id, username, role FROM users ORDER BY id ASC`);
  res.json(rows);
});

app.post("/api/users", auth, requireRole("admin"), async (req, res) => {
  const { username, password, role } = req.body || {};
  const u = String(username || "").trim();
  const p = String(password || "").trim();
  const r = String(role || "").trim();

  if (!u || !p || !r) return res.status(400).json({ error: "Faltan datos" });
  if (!["admin", "cajero"].includes(r)) return res.status(400).json({ error: "Rol inválido" });
  if (p.length < 4) return res.status(400).json({ error: "Contraseña muy corta" });

  try {
    const hash = bcrypt.hashSync(p, 10);
    const rr = await run(`INSERT INTO users(username,password_hash,role) VALUES(?,?,?)`, [u, hash, r]);
    const created = await get(`SELECT id, username, role FROM users WHERE id=?`, [rr.id]);
    res.json(created);
  } catch {
    res.status(400).json({ error: "No se pudo crear (¿usuario repetido?)" });
  }
});

app.delete("/api/users/:id", auth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "ID inválido" });

  if (req.user.id === id) return res.status(400).json({ error: "No puedes eliminar tu propio usuario" });

  const user = await get(`SELECT id, username, role FROM users WHERE id=?`, [id]);
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

  if (user.role === "admin") {
    const admins = await get(`SELECT COUNT(*) as c FROM users WHERE role='admin'`);
    if ((admins?.c || 0) <= 1) return res.status(400).json({ error: "No puedes eliminar el último admin" });
  }

  await run(`DELETE FROM users WHERE id=?`, [id]);
  res.json({ ok: true });
});

// =========================
// PRODUCTS
// =========================
app.get("/api/products", auth, async (req, res) => {
  const q = (req.query.search || "").trim();
  if (!q) {
    const rows = await all(`SELECT * FROM products ORDER BY name ASC`);
    return res.json(rows);
  }
  const rows = await all(
    `SELECT * FROM products WHERE name LIKE ? OR code LIKE ? ORDER BY name ASC`,
    [`%${q}%`, `%${q}%`]
  );
  res.json(rows);
});

app.post("/api/products", auth, requireRole("admin"), async (req, res) => {
  const {
    code, name, lab = "", location = "",
    stock = 0, buy_price = 0, sell_price = 0,
    expiry_date = null
  } = req.body || {};

  if (!code || !name) return res.status(400).json({ error: "Faltan code o name" });

  try {
    const r = await run(
      `INSERT INTO products(code,name,lab,location,stock,buy_price,sell_price,expiry_date)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        String(code).trim(),
        String(name).trim(),
        String(lab || "").trim(),
        String(location || "").trim(),
        Number(stock), Number(buy_price), Number(sell_price),
        expiry_date || null
      ]
    );
    const p = await get(`SELECT * FROM products WHERE id=?`, [r.id]);
    res.json(p);
  } catch {
    return res.status(400).json({ error: "No se pudo crear (¿código repetido?)" });
  }
});

app.put("/api/products/:id", auth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const {
    code, name, lab = "", location = "",
    stock = 0, buy_price = 0, sell_price = 0,
    expiry_date = null
  } = req.body || {};

  if (!code || !name) return res.status(400).json({ error: "Faltan code o name" });

  try {
    await run(
      `UPDATE products
       SET code=?, name=?, lab=?, location=?, stock=?, buy_price=?, sell_price=?, expiry_date=?
       WHERE id=?`,
      [
        String(code).trim(),
        String(name).trim(),
        String(lab || "").trim(),
        String(location || "").trim(),
        Number(stock), Number(buy_price), Number(sell_price),
        expiry_date || null,
        id
      ]
    );
    const p = await get(`SELECT * FROM products WHERE id=?`, [id]);
    res.json(p);
  } catch {
    return res.status(400).json({ error: "No se pudo actualizar (¿código repetido?)" });
  }
});

app.delete("/api/products/:id", auth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  await run(`DELETE FROM products WHERE id=?`, [id]);
  res.json({ ok: true });
});

// =========================
// SALES
// =========================
app.post("/api/sales", auth, requireRole("admin", "cajero"), async (req, res) => {
  const { items, payment_method = "efectivo" } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Carrito vacío" });
  }

  let total = 0;

  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.qty);
    if (!pid || qty <= 0) return res.status(400).json({ error: "Item inválido" });

    const p = await get(`SELECT * FROM products WHERE id=?`, [pid]);
    if (!p) return res.status(400).json({ error: "Producto no existe" });

    if (p.expiry_date && isExpired(p.expiry_date)) {
      return res.status(400).json({ error: `Producto vencido: ${p.name} (${p.expiry_date})` });
    }

    if (p.stock < qty) return res.status(400).json({ error: `Stock insuficiente: ${p.name}` });

    const price_unit = Number(it.price_unit ?? p.sell_price);
    total += price_unit * qty;
  }

  const iso = isoNow();
  const saleR = await run(
    `INSERT INTO sales(date,total,payment_method,seller_user_id) VALUES(?,?,?,?)`,
    [iso, total, payment_method, req.user.id]
  );
  const sale_id = saleR.id;

  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.qty);

    const p = await get(`SELECT * FROM products WHERE id=?`, [pid]);
    const price_unit = Number(it.price_unit ?? p.sell_price);
    const subtotal = price_unit * qty;

    await run(
      `INSERT INTO sale_items(sale_id,product_id,qty,price_unit,subtotal) VALUES(?,?,?,?,?)`,
      [sale_id, pid, qty, price_unit, subtotal]
    );
    await run(`UPDATE products SET stock = stock - ? WHERE id=?`, [qty, pid]);
  }

  const sale = await get(`SELECT * FROM sales WHERE id=?`, [sale_id]);
  const saleItems = await all(
    `SELECT si.*, p.name, p.code
     FROM sale_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.sale_id=?`,
    [sale_id]
  );

  res.json({ sale, items: saleItems });
});

app.get("/api/sales", auth, requireRole("admin", "cajero"), async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const from = (req.query.from || "").trim();
  const to = (req.query.to || "").trim();

  let sql = `SELECT id, date, total, payment_method FROM sales`;
  const params = [];

  if (from && to) {
    sql += ` WHERE substr(date,1,10) BETWEEN ? AND ?`;
    params.push(from, to);
  } else if (from) {
    sql += ` WHERE substr(date,1,10) >= ?`;
    params.push(from);
  } else if (to) {
    sql += ` WHERE substr(date,1,10) <= ?`;
    params.push(to);
  }

  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);

  const rows = await all(sql, params);
  res.json(rows);
});

app.get("/api/sales/:id", auth, requireRole("admin", "cajero"), async (req, res) => {
  const id = Number(req.params.id);

  const sale = await get(
    `SELECT id, date, total, payment_method FROM sales WHERE id=?`,
    [id]
  );
  if (!sale) return res.status(404).json({ error: "Venta no encontrada" });

  const items = await all(
    `SELECT si.product_id, p.code, p.name, si.qty, si.price_unit,
            (si.qty * si.price_unit) AS subtotal
     FROM sale_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ?`,
    [id]
  );

  res.json({ sale, items });
});

// =========================
// ALERTAS / DASHBOARD
// =========================

// Productos que vencen en N días
app.get("/api/alerts/expiring", auth, requireRole("admin", "cajero"), async (req, res) => {
  const days = Math.max(0, Number(req.query.days || 30));
  const rows = await all(
    `
    SELECT id, code, name, stock, expiry_date, location
    FROM products
    WHERE expiry_date IS NOT NULL AND expiry_date != ''
      AND julianday(expiry_date) - julianday(date('now')) <= ?
    ORDER BY date(expiry_date) ASC
    `,
    [String(days)]
  );
  res.json({ days, count: rows.length, items: rows });
});

// Stock bajo (compat: min / threshold)
app.get("/api/alerts/low-stock", auth, requireRole("admin", "cajero"), async (req, res) => {
  const threshold = Math.max(0, Number(req.query.min ?? req.query.threshold ?? 5));
  const rows = await all(
    `SELECT id, code, name, stock, location, expiry_date
     FROM products
     WHERE stock <= ?
     ORDER BY stock ASC, name ASC`,
    [threshold]
  );
  res.json({ threshold, count: rows.length, items: rows });
});

// Resumen del día (ventas hoy)
app.get("/api/dashboard/today", auth, requireRole("admin", "cajero"), async (_req, res) => {
  const row = await get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total
     FROM sales
     WHERE substr(date,1,10) = date('now')`
  );
  res.json({
    date: new Date().toISOString().slice(0, 10),
    count: Number(row?.count || 0),
    total: Number(row?.total || 0),
  });
});

// ✅ Resumen general (tarjetas del dashboard) (compat: low / threshold)
app.get("/api/dashboard/summary", auth, requireRole("admin", "cajero"), async (req, res) => {
  const low = Math.max(0, Number(req.query.low ?? req.query.threshold ?? 5));
  const days = Math.max(0, Number(req.query.days ?? 30));

  const today = await get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total
     FROM sales
     WHERE substr(date,1,10) = date('now')`
  );

  const lowRow = await get(`SELECT COUNT(*) AS c FROM products WHERE stock <= ?`, [low]);

  const expRow = await get(
    `SELECT COUNT(*) AS c
     FROM products
     WHERE expiry_date IS NOT NULL AND expiry_date != ''
       AND julianday(expiry_date) - julianday(date('now')) <= ?`,
    [String(days)]
  );

  res.json({
    today: { count: Number(today?.count || 0), total: Number(today?.total || 0) },
    low_stock: { low, count: Number(lowRow?.c || 0) },
    expiring: { days, count: Number(expRow?.c || 0) },
  });
});

// ===============================
// INFORMACIÓN FARMACÉUTICA (OpenFDA)
// Visible para admin y cajero
// GET /api/drug-info?name=paracetamol
// ===============================
app.get("/api/drug-info", auth, requireRole("admin", "cajero"), async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Falta name" });

    // Buscar por nombre comercial o genérico
    const q = encodeURIComponent(`openfda.brand_name:"${name}" OR openfda.generic_name:"${name}"`);
    const url = `https://api.fda.gov/drug/label.json?search=${q}&limit=1`;

    const r = await fetchFn(url);
    const data = await r.json();

    if (!data.results || data.results.length === 0) {
      return res.json({ found: false, query: name, source: "openfda" });
    }

    const d = data.results[0];

    const pick = (x) => (Array.isArray(x) ? (x[0] || "") : (x || ""));
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const out = {
      found: true,
      query: name,
      brand_name: pick(d.openfda?.brand_name) || name,
      generic_name: pick(d.openfda?.generic_name) || "",
      active_ingredient: clean(pick(d.active_ingredient) || pick(d.openfda?.substance_name) || ""),
      indications: clean(pick(d.indications_and_usage) || ""),
      dosage: clean(pick(d.dosage_and_administration) || ""),
      warnings: clean(pick(d.warnings) || pick(d.boxed_warning) || ""),
      contraindications: clean(pick(d.contraindications) || ""),
      interactions: clean(pick(d.drug_interactions) || ""),
      pregnancy: clean(pick(d.pregnancy) || pick(d.pregnancy_or_breast_feeding) || ""),
      storage: clean(pick(d.storage_and_handling) || ""),
      source: "openfda"
    };

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error consultando OpenFDA" });
  }
});

// ==================== EXPORT EXCEL ====================
const ExcelJS = require("exceljs");

// Helper: set headers para descarga excel
function setXlsxDownload(res, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

// ✅ A) Exportar Inventario
// GET /api/export/inventory.xlsx
app.get("/api/export/inventory.xlsx", auth, requireRole("admin", "cajero"), async (_req, res) => {
  try {
    const rows = await all(`
      SELECT code, name, lab, location, stock, buy_price, sell_price, expiry_date
      FROM products
      ORDER BY name ASC
    `);

    const wb = new ExcelJS.Workbook();
    wb.creator = "POS Farmacia";
    wb.created = new Date();

    const ws = wb.addWorksheet("Inventario");

    ws.columns = [
      { header: "Código", key: "code", width: 14 },
      { header: "Producto", key: "name", width: 32 },
      { header: "Laboratorio", key: "lab", width: 18 },
      { header: "Ubicación", key: "location", width: 14 },
      { header: "Stock", key: "stock", width: 10 },
      { header: "P. Compra", key: "buy_price", width: 12 },
      { header: "P. Venta", key: "sell_price", width: 12 },
      { header: "Vence", key: "expiry_date", width: 14 },
      { header: "Estado", key: "estado", width: 14 },
    ];

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

    for (const r of rows) {
      let estado = "OK";
      if (r.expiry_date) {
        const d = new Date(r.expiry_date + "T00:00:00");
        if (!isNaN(d.getTime())) {
          const e0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
          const diffDays = Math.ceil((e0 - t0) / (1000 * 60 * 60 * 24));
          if (diffDays < 0) estado = "VENCIDO";
          else if (diffDays <= 30) estado = "POR VENCER";
        }
      }

      ws.addRow({
        code: r.code,
        name: r.name,
        lab: r.lab || "",
        location: r.location || "",
        stock: Number(r.stock || 0),
        buy_price: Number(r.buy_price || 0),
        sell_price: Number(r.sell_price || 0),
        expiry_date: r.expiry_date || "",
        estado,
      });
    }

    ws.getColumn("buy_price").numFmt = '"S/ "0.00';
    ws.getColumn("sell_price").numFmt = '"S/ "0.00';

    ws.autoFilter = { from: "A1", to: "I1" };
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const filename = `inventario_${new Date().toISOString().slice(0, 10)}.xlsx`;
    setXlsxDownload(res, filename);

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo exportar inventario" });
  }
});

// ✅ B) Exportar Ventas por rango
// GET /api/export/sales.xlsx?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get("/api/export/sales.xlsx", auth, requireRole("admin", "cajero"), async (req, res) => {
  try {
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (!from || !to) return res.status(400).json({ error: "Faltan from/to" });

    const sales = await all(
      `
      SELECT id, date, total, payment_method
      FROM sales
      WHERE substr(date,1,10) BETWEEN ? AND ?
      ORDER BY id DESC
      `,
      [from, to]
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "POS Farmacia";
    wb.created = new Date();

    const ws = wb.addWorksheet("Ventas");

    ws.columns = [
      { header: "ID Venta", key: "id", width: 10 },
      { header: "Fecha", key: "date", width: 20 },
      { header: "Pago", key: "payment_method", width: 14 },
      { header: "Total", key: "total", width: 12 },
    ];

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

    for (const s of sales) {
      ws.addRow({
        id: s.id,
        date: String(s.date || "").replace("T", " ").slice(0, 16),
        payment_method: s.payment_method,
        total: Number(s.total || 0),
      });
    }
    ws.getColumn("total").numFmt = '"S/ "0.00';
    ws.autoFilter = { from: "A1", to: "D1" };
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const ws2 = wb.addWorksheet("Detalle");
    ws2.columns = [
      { header: "ID Venta", key: "sale_id", width: 10 },
      { header: "Fecha", key: "sale_date", width: 20 },
      { header: "Código", key: "code", width: 14 },
      { header: "Producto", key: "name", width: 30 },
      { header: "Cant", key: "qty", width: 8 },
      { header: "P.Unit", key: "price_unit", width: 12 },
      { header: "Sub", key: "subtotal", width: 12 },
    ];
    ws2.getRow(1).font = { bold: true };
    ws2.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

    const items = await all(
      `
      SELECT s.id as sale_id, s.date as sale_date, p.code, p.name,
             si.qty, si.price_unit, si.subtotal
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE substr(s.date,1,10) BETWEEN ? AND ?
      ORDER BY s.id DESC
      `,
      [from, to]
    );

    for (const it of items) {
      ws2.addRow({
        sale_id: it.sale_id,
        sale_date: String(it.sale_date || "").replace("T", " ").slice(0, 16),
        code: it.code,
        name: it.name,
        qty: Number(it.qty || 0),
        price_unit: Number(it.price_unit || 0),
        subtotal: Number(it.subtotal || 0),
      });
    }
    ws2.getColumn("price_unit").numFmt = '"S/ "0.00';
    ws2.getColumn("subtotal").numFmt = '"S/ "0.00';
    ws2.autoFilter = { from: "A1", to: "G1" };
    ws2.views = [{ state: "frozen", ySplit: 1 }];

    const filename = `ventas_${from}_a_${to}.xlsx`;
    setXlsxDownload(res, filename);

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo exportar ventas" });
  }
});

// =========================
// START
// =========================
const PORT = 3000;
init().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Backend corriendo en http://0.0.0.0:${PORT}`);
  });
});
