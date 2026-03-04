// backend/server.js (SaaS multi-farmacia por slug en login)
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const ExcelJS = require("exceljs");

const app = express();

// =========================
// CONFIG
// =========================
app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, "db.sqlite");
const db = new sqlite3.Database(DB_PATH);

const JWT_SECRET = process.env.JWT_SECRET || "cambia_esto_por_algo_mas_largo_y_secreto";

// ✅ SERVIR FRONTEND
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));

// =========================
// FETCH (para Node < 18)
// =========================
const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// =========================
// LIBRETRANSLATE
// =========================
const LIBRETRANSLATE_URL =
  process.env.LIBRETRANSLATE_URL || "https://translate.argosopentech.com/translate";
const LIBRETRANSLATE_API_KEY = process.env.LIBRETRANSLATE_API_KEY || "";

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
function normQuery(s) {
  return cleanText(stripAccents(String(s || "")).toLowerCase());
}

async function translateSafe(text, sourceLang, targetLang) {
  const t = cleanText(text);
  if (!t) return "";

  const MAX_CHARS = 4500;
  const input = t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;

  try {
    const body = { q: input, source: sourceLang, target: targetLang, format: "text" };
    if (LIBRETRANSLATE_API_KEY) body.api_key = LIBRETRANSLATE_API_KEY;

    const r = await fetchFn(LIBRETRANSLATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) return input;
    const out = await r.json().catch(() => null);
    const translated = cleanText(out?.translatedText || "");
    return translated || input;
  } catch {
    return input;
  }
}

async function translateToEs(text, sourceLang = "en") {
  return translateSafe(text, sourceLang, "es");
}
async function translateEsToEn(text) {
  return translateSafe(text, "es", "en");
}

// =========================
// Helpers sqlite -> promises
// =========================
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

// =========================
// Auth middleware
// =========================
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autorizado" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
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

// =========================
// SaaS Tenant helpers
// =========================
function slugify(s) {
  return cleanText(String(s || ""))
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// De frontend mandaremos header: X-Tenant-Slug
function tenantFromHeader(req) {
  const slug = cleanText(req.headers["x-tenant-slug"] || "");
  return slug ? slugify(slug) : "";
}

// Verifica que el token pertenezca al tenant del header
async function requireTenant(req, res, next) {
  const slug = tenantFromHeader(req);
  if (!slug) return res.status(400).json({ error: "Falta X-Tenant-Slug" });

  const t = await get(`SELECT * FROM tenants WHERE slug=? AND status='active'`, [slug]);
  if (!t) return res.status(404).json({ error: "Farmacia no encontrada o inactiva" });

  // superadmin (global) puede operar sin tenant_id
  if (req.user?.role === "superadmin") {
    req.tenant = t;
    return next();
  }

  // usuarios normales deben coincidir con tenant
  if (!req.user?.tenant_id || Number(req.user.tenant_id) !== Number(t.id)) {
    return res.status(403).json({ error: "Tenant no autorizado para este usuario" });
  }

  req.tenant = t;
  next();
}

// =========================
// Utils
// =========================
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

// =========================
// Auditoría
// =========================
async function audit(req, action, entity, entity_id, metadata = {}) {
  try {
    const tenant_id = req.tenant?.id ?? null;
    const user_id = req.user?.id ?? null;
    await run(
      `INSERT INTO audit_log(tenant_id,user_id,action,entity,entity_id,metadata,created_at)
       VALUES(?,?,?,?,?,?,?)`,
      [
        tenant_id,
        user_id,
        String(action),
        String(entity),
        entity_id != null ? String(entity_id) : null,
        JSON.stringify(metadata || {}),
        isoNow(),
      ]
    );
  } catch (e) {
    console.error("audit error:", e?.message || e);
  }
}

// =========================
// INIT DB (SaaS)
// =========================
async function init() {
  // tenants
  await run(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);

  // users (agregamos tenant_id y role superadmin)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  // products
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      lab TEXT DEFAULT '',
      location TEXT DEFAULT '',
      stock INTEGER NOT NULL DEFAULT 0,
      buy_price REAL NOT NULL DEFAULT 0,
      sell_price REAL NOT NULL DEFAULT 0,
      expiry_date TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, code),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  // sales
  await run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      date TEXT NOT NULL,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL,
      seller_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (seller_user_id) REFERENCES users(id)
    )
  `);

  // sale_items
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

  // audit log
  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Si vienes de tu DB anterior (ya creada), aseguramos columnas mínimas
  await ensureColumn("users", "tenant_id", "INTEGER");
  await ensureColumn("users", "created_at", "TEXT");
  await ensureColumn("products", "tenant_id", "INTEGER");
  await ensureColumn("products", "location", "TEXT DEFAULT ''");
  await ensureColumn("sales", "tenant_id", "INTEGER");
  await ensureColumn("sales", "created_at", "TEXT");

  // tenant default
  let t = await get(`SELECT * FROM tenants WHERE slug=?`, ["default"]);
  if (!t) {
    await run(`INSERT INTO tenants(name,slug,status,created_at) VALUES(?,?,?,?)`, [
      "Farmacia Default",
      "default",
      "active",
      isoNow(),
    ]);
    t = await get(`SELECT * FROM tenants WHERE slug=?`, ["default"]);
    console.log("✅ Tenant creado: default");
  }

  // Asignar tenant_id a data vieja (si había null)
  await run(`UPDATE users SET tenant_id=? WHERE tenant_id IS NULL AND role != 'superadmin'`, [t.id]);
  await run(`UPDATE products SET tenant_id=? WHERE tenant_id IS NULL`, [t.id]);
  await run(`UPDATE sales SET tenant_id=? WHERE tenant_id IS NULL`, [t.id]);

  // superadmin global (NO tenant)
  const sa = await get(`SELECT * FROM users WHERE username=?`, ["superadmin"]);
  if (!sa) {
    const hash = bcrypt.hashSync("superadmin123", 10);
    await run(`INSERT INTO users(tenant_id, username, password_hash, role, created_at) VALUES(?,?,?,?,?)`, [
      null,
      "superadmin",
      hash,
      "superadmin",
      isoNow(),
    ]);
    console.log("✅ Superadmin: superadmin / superadmin123");
  }

  // admin default si no existe (para el tenant default)
  const adminUser = await get(`SELECT * FROM users WHERE username=?`, ["admin"]);
  if (!adminUser) {
    const hash = bcrypt.hashSync("admin123", 10);
    await run(`INSERT INTO users(tenant_id, username, password_hash, role, created_at) VALUES(?,?,?,?,?)`, [
      t.id,
      "admin",
      hash,
      "admin",
      isoNow(),
    ]);
    console.log("✅ Admin default: admin / admin123 (tenant default)");
  }

  console.log("✅ DB lista:", DB_PATH);
}

// =========================
// RUTAS BÁSICAS (FRONT)
// =========================
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "login.html")));
app.get("/login", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "login.html")));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "dashboard.html")));

// =========================
// AUTH (login pide tenant_slug)
// =========================
app.post("/api/login", async (req, res) => {
  const { username, password, tenant_slug } = req.body || {};
  const u = cleanText(username);
  const p = cleanText(password);
  const slug = slugify(tenant_slug);

  if (!u || !p) return res.status(400).json({ error: "Faltan datos" });

  // superadmin no requiere tenant
  if (u === "superadmin") {
    const user = await get(`SELECT * FROM users WHERE username=?`, [u]);
    if (!user) return res.status(401).json({ error: "Credenciales inválidas" });

    const ok = bcrypt.compareSync(p, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, tenant_id: null },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    return res.json({ token, user: { id: user.id, username: user.username, role: user.role, tenant_id: null } });
  }

  if (!slug) return res.status(400).json({ error: "Falta farmacia (tenant_slug)" });

  const tenant = await get(`SELECT * FROM tenants WHERE slug=? AND status='active'`, [slug]);
  if (!tenant) return res.status(404).json({ error: "Farmacia no encontrada o inactiva" });

  const user = await get(`SELECT * FROM users WHERE username=? AND tenant_id=?`, [u, tenant.id]);
  if (!user) return res.status(401).json({ error: "Credenciales inválidas" });

  const ok = bcrypt.compareSync(p, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, tenant_id: tenant.id },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, tenant_id: tenant.id },
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
  });
});

// =========================
// TENANTS (solo superadmin)
// =========================
app.post("/api/tenants", auth, requireRole("superadmin"), async (req, res) => {
  const { name, slug } = req.body || {};
  const n = cleanText(name);
  const s = slugify(slug || name);

  if (!n) return res.status(400).json({ error: "Falta name" });
  if (!s) return res.status(400).json({ error: "Falta slug" });

  try {
    const r = await run(`INSERT INTO tenants(name,slug,status,created_at) VALUES(?,?,?,?)`, [
      n, s, "active", isoNow(),
    ]);
    const t = await get(`SELECT * FROM tenants WHERE id=?`, [r.id]);

    // crear admin base de esa farmacia (opcional, pero útil)
    const adminPass = "admin123"; // cámbialo por uno random si quieres
    const hash = bcrypt.hashSync(adminPass, 10);
    const adminUser = `${s}_admin`;
    await run(`INSERT INTO users(tenant_id, username, password_hash, role, created_at) VALUES(?,?,?,?,?)`, [
      t.id, adminUser, hash, "admin", isoNow(),
    ]);

    res.json({ tenant: t, created_admin: { username: adminUser, password: adminPass } });
  } catch (e) {
    res.status(400).json({ error: "No se pudo crear tenant (¿slug repetido?)" });
  }
});

app.get("/api/tenants", auth, requireRole("superadmin"), async (_req, res) => {
  const rows = await all(`SELECT id,name,slug,status,created_at FROM tenants ORDER BY id DESC`);
  res.json(rows);
});

// =========================
// USERS (ADMIN por tenant)
// =========================
app.get("/api/users", auth, requireRole("admin", "superadmin"), requireTenant, async (req, res) => {
  // superadmin puede listar usuarios del tenant (si manda header)
  const rows = await all(
    `SELECT id, username, role, tenant_id FROM users WHERE tenant_id=? ORDER BY id ASC`,
    [req.tenant.id]
  );
  res.json(rows);
});

app.post("/api/users", auth, requireRole("admin", "superadmin"), requireTenant, async (req, res) => {
  const { username, password, role } = req.body || {};
  const u = cleanText(username);
  const p = cleanText(password);
  const r = cleanText(role);

  if (!u || !p || !r) return res.status(400).json({ error: "Faltan datos" });
  if (!["admin", "cajero"].includes(r)) return res.status(400).json({ error: "Rol inválido" });
  if (p.length < 4) return res.status(400).json({ error: "Contraseña muy corta" });

  try {
    const hash = bcrypt.hashSync(p, 10);
    const rr = await run(
      `INSERT INTO users(tenant_id, username, password_hash, role, created_at) VALUES(?,?,?,?,?)`,
      [req.tenant.id, u, hash, r, isoNow()]
    );
    const created = await get(`SELECT id, username, role, tenant_id FROM users WHERE id=?`, [rr.id]);

    await audit(req, "USER_CREATE", "user", rr.id, { username: u, role: r });

    res.json(created);
  } catch {
    res.status(400).json({ error: "No se pudo crear (¿usuario repetido?)" });
  }
});

app.delete("/api/users/:id", auth, requireRole("admin", "superadmin"), requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "ID inválido" });

  // no borrar a sí mismo
  if (req.user.id === id) return res.status(400).json({ error: "No puedes eliminar tu propio usuario" });

  const user = await get(`SELECT id, username, role, tenant_id FROM users WHERE id=?`, [id]);
  if (!user || Number(user.tenant_id) !== Number(req.tenant.id)) {
    return res.status(404).json({ error: "Usuario no encontrado" });
  }

  if (user.role === "admin") {
    const admins = await get(`SELECT COUNT(*) as c FROM users WHERE role='admin' AND tenant_id=?`, [req.tenant.id]);
    if ((admins?.c || 0) <= 1) return res.status(400).json({ error: "No puedes eliminar el último admin" });
  }

  await run(`DELETE FROM users WHERE id=?`, [id]);
  await audit(req, "USER_DELETE", "user", id, { username: user.username, role: user.role });

  res.json({ ok: true });
});

// =========================
// PRODUCTS (por tenant)
// =========================
app.get("/api/products", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  const q = cleanText(req.query.search);

  if (!q) {
    const rows = await all(`SELECT * FROM products WHERE tenant_id=? ORDER BY name ASC`, [req.tenant.id]);
    return res.json(rows);
  }

  const like = `%${q}%`;
  const rows = await all(
    `SELECT * FROM products
     WHERE tenant_id=? AND (name LIKE ? OR code LIKE ?)
     ORDER BY name ASC`,
    [req.tenant.id, like, like]
  );
  res.json(rows);
});

app.post("/api/products", auth, requireRole("admin", "superadmin"), requireTenant, async (req, res) => {
  const {
    code, name, lab = "", location = "", stock = 0, buy_price = 0, sell_price = 0, expiry_date = null,
  } = req.body || {};

  if (!code || !name) return res.status(400).json({ error: "Faltan code o name" });

  try {
    const r = await run(
      `INSERT INTO products(tenant_id,code,name,lab,location,stock,buy_price,sell_price,expiry_date,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.tenant.id,
        cleanText(code),
        cleanText(name),
        cleanText(lab),
        cleanText(location),
        Number(stock),
        Number(buy_price),
        Number(sell_price),
        expiry_date || null,
        isoNow(),
        isoNow(),
      ]
    );

    const p = await get(`SELECT * FROM products WHERE id=?`, [r.id]);
    await audit(req, "PRODUCT_CREATE", "product", r.id, { code: p.code, name: p.name });

    res.json(p);
  } catch {
    return res.status(400).json({ error: "No se pudo crear (¿código repetido en esta farmacia?)" });
  }
});

app.put("/api/products/:id", auth, requireRole("admin", "superadmin"), requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  const {
    code, name, lab = "", location = "", stock = 0, buy_price = 0, sell_price = 0, expiry_date = null,
  } = req.body || {};

  if (!code || !name) return res.status(400).json({ error: "Faltan code o name" });

  const before = await get(`SELECT * FROM products WHERE id=? AND tenant_id=?`, [id, req.tenant.id]);
  if (!before) return res.status(404).json({ error: "Producto no encontrado" });

  try {
    await run(
      `UPDATE products
       SET code=?, name=?, lab=?, location=?, stock=?, buy_price=?, sell_price=?, expiry_date=?, updated_at=?
       WHERE id=? AND tenant_id=?`,
      [
        cleanText(code),
        cleanText(name),
        cleanText(lab),
        cleanText(location),
        Number(stock),
        Number(buy_price),
        Number(sell_price),
        expiry_date || null,
        isoNow(),
        id,
        req.tenant.id,
      ]
    );

    const p = await get(`SELECT * FROM products WHERE id=?`, [id]);
    await audit(req, "PRODUCT_UPDATE", "product", id, { before, after: p });

    res.json(p);
  } catch {
    return res.status(400).json({ error: "No se pudo actualizar (¿código repetido en esta farmacia?)" });
  }
});

app.delete("/api/products/:id", auth, requireRole("admin", "superadmin"), requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  const p = await get(`SELECT * FROM products WHERE id=? AND tenant_id=?`, [id, req.tenant.id]);
  if (!p) return res.status(404).json({ error: "Producto no encontrado" });

  await run(`DELETE FROM products WHERE id=? AND tenant_id=?`, [id, req.tenant.id]);
  await audit(req, "PRODUCT_DELETE", "product", id, { code: p.code, name: p.name });

  res.json({ ok: true });
});

// =========================
// SALES (por tenant)
// =========================
app.post("/api/sales", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  const { items, payment_method = "efectivo" } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Carrito vacío" });

  let total = 0;

  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.qty);
    if (!pid || qty <= 0) return res.status(400).json({ error: "Item inválido" });

    const p = await get(`SELECT * FROM products WHERE id=? AND tenant_id=?`, [pid, req.tenant.id]);
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
    `INSERT INTO sales(tenant_id,date,total,payment_method,seller_user_id,created_at)
     VALUES(?,?,?,?,?,?)`,
    [req.tenant.id, iso, total, payment_method, req.user.id, isoNow()]
  );

  const sale_id = saleR.id;

  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.qty);

    const p = await get(`SELECT * FROM products WHERE id=? AND tenant_id=?`, [pid, req.tenant.id]);
    const price_unit = Number(it.price_unit ?? p.sell_price);
    const subtotal = price_unit * qty;

    await run(
      `INSERT INTO sale_items(sale_id,product_id,qty,price_unit,subtotal) VALUES(?,?,?,?,?)`,
      [sale_id, pid, qty, price_unit, subtotal]
    );

    await run(`UPDATE products SET stock = stock - ?, updated_at=? WHERE id=? AND tenant_id=?`, [
      qty,
      isoNow(),
      pid,
      req.tenant.id,
    ]);
  }

  const sale = await get(`SELECT * FROM sales WHERE id=? AND tenant_id=?`, [sale_id, req.tenant.id]);
  const saleItems = await all(
    `SELECT si.*, p.name, p.code
     FROM sale_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.sale_id=?`,
    [sale_id]
  );

  await audit(req, "SALE_CREATE", "sale", sale_id, { total, payment_method, items_count: items.length });

  res.json({ sale, items: saleItems });
});

app.get("/api/sales", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const from = cleanText(req.query.from);
  const to = cleanText(req.query.to);

  let sql = `SELECT id, date, total, payment_method FROM sales WHERE tenant_id=?`;
  const params = [req.tenant.id];

  if (from && to) {
    sql += ` AND substr(date,1,10) BETWEEN ? AND ?`;
    params.push(from, to);
  } else if (from) {
    sql += ` AND substr(date,1,10) >= ?`;
    params.push(from);
  } else if (to) {
    sql += ` AND substr(date,1,10) <= ?`;
    params.push(to);
  }

  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);

  const rows = await all(sql, params);
  res.json(rows);
});

app.get("/api/sales/:id", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  const id = Number(req.params.id);

  const sale = await get(
    `SELECT id, date, total, payment_method FROM sales WHERE id=? AND tenant_id=?`,
    [id, req.tenant.id]
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
// ALERTAS / DASHBOARD (por tenant)
// =========================
app.get("/api/alerts/expiring", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  const days = Math.max(0, Number(req.query.days || 30));
  const rows = await all(
    `SELECT id, code, name, stock, expiry_date, location
     FROM products
     WHERE tenant_id=?
       AND expiry_date IS NOT NULL AND expiry_date != ''
       AND julianday(expiry_date) - julianday(date('now')) <= ?
     ORDER BY date(expiry_date) ASC`,
    [req.tenant.id, String(days)]
  );
  res.json({ days, count: rows.length, items: rows });
});

app.get("/api/alerts/low-stock", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  const threshold = Math.max(0, Number(req.query.min ?? req.query.threshold ?? 5));
  const rows = await all(
    `SELECT id, code, name, stock, location, expiry_date
     FROM products
     WHERE tenant_id=? AND stock <= ?
     ORDER BY stock ASC, name ASC`,
    [req.tenant.id, threshold]
  );
  res.json({ threshold, count: rows.length, items: rows });
});

app.get("/api/dashboard/summary", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  const low = Math.max(0, Number(req.query.low ?? req.query.threshold ?? 5));
  const days = Math.max(0, Number(req.query.days ?? 30));

  const today = await get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total
     FROM sales
     WHERE tenant_id=? AND substr(date,1,10) = date('now')`,
    [req.tenant.id]
  );

  const lowRow = await get(
    `SELECT COUNT(*) as c FROM products WHERE tenant_id=? AND stock <= ?`,
    [req.tenant.id, low]
  );

  const expRow = await get(
    `SELECT COUNT(*) as c
     FROM products
     WHERE tenant_id=? AND expiry_date IS NOT NULL AND expiry_date != ''
       AND julianday(expiry_date) - julianday(date('now')) <= ?`,
    [req.tenant.id, String(days)]
  );

  res.json({
    today: { count: Number(today?.count || 0), total: Number(today?.total || 0) },
    low_stock: { low, count: Number(lowRow?.c || 0) },
    expiring: { days, count: Number(expRow?.c || 0) },
  });
});

// ===============================
// OpenFDA + LibreTranslate (por tenant)
// ===============================
const DRUG_CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cacheGet(key) {
  const hit = DRUG_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    DRUG_CACHE.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  DRUG_CACHE.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

app.get("/api/drug-info", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  try {
    const rawName = cleanText(req.query.name);
    const lang = cleanText(req.query.lang || "en").toLowerCase();
    if (!rawName) return res.status(400).json({ error: "Falta name" });

    const safeLang = lang === "es" ? "es" : "en";
    const key = `${safeLang}:${normQuery(rawName)}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const pick = (x) => (Array.isArray(x) ? (x[0] || "") : (x || ""));

    async function openFdaFetch(search) {
      const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(search)}&limit=1`;
      const r = await fetchFn(url);
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      if (!data?.results?.length) return null;
      return data.results[0];
    }

    async function searchOpenFDA(term) {
      const t = cleanText(term);
      if (!t) return null;

      const queries = [
        `openfda.brand_name:"${t}" OR openfda.generic_name:"${t}" OR openfda.substance_name:"${t}"`,
        `openfda.brand_name:${t} OR openfda.generic_name:${t} OR openfda.substance_name:${t}`,
        `active_ingredient:"${t}" OR active_ingredient:${t}`,
      ];

      const first = t.split(/\s+/)[0];
      if (first && first !== t) {
        queries.push(
          `openfda.brand_name:"${first}" OR openfda.generic_name:"${first}"`,
          `openfda.brand_name:${first} OR openfda.generic_name:${first}`
        );
      }

      for (const q of queries) {
        const d = await openFdaFetch(q);
        if (d) return { d, usedQuery: q };
      }
      return null;
    }

    const tried = [];
    let foundPack = null;
    let searched_term = rawName;
    let query_translated_from = null;

    tried.push(rawName);
    foundPack = await searchOpenFDA(rawName);

    const noAcc = stripAccents(rawName);
    if (!foundPack && noAcc && noAcc !== rawName) {
      tried.push(noAcc);
      foundPack = await searchOpenFDA(noAcc);
      if (foundPack) searched_term = noAcc;
    }

    if (!foundPack && safeLang === "es") {
      const enTerm = await translateEsToEn(rawName);
      if (enTerm && enTerm.toLowerCase() !== rawName.toLowerCase()) {
        tried.push(enTerm);
        foundPack = await searchOpenFDA(enTerm);
        if (foundPack) {
          searched_term = enTerm;
          query_translated_from = rawName;
        }
      }
    }

    if (!foundPack) {
      const outNF = {
        found: false,
        query: rawName,
        searched_term: rawName,
        query_translated_from: null,
        tried,
        source: "openfda",
        lang: safeLang,
      };
      cacheSet(key, outNF);
      return res.json(outNF);
    }

    const d = foundPack.d;

    const out = {
      found: true,
      query: rawName,
      searched_term,
      query_translated_from,
      brand_name: pick(d.openfda?.brand_name) || rawName,
      generic_name: pick(d.openfda?.generic_name) || "",
      active_ingredient: cleanText(pick(d.active_ingredient) || pick(d.openfda?.substance_name) || ""),
      indications: cleanText(pick(d.indications_and_usage) || ""),
      dosage: cleanText(pick(d.dosage_and_administration) || ""),
      warnings: cleanText(pick(d.warnings) || pick(d.boxed_warning) || ""),
      contraindications: cleanText(pick(d.contraindications) || ""),
      interactions: cleanText(pick(d.drug_interactions) || ""),
      pregnancy: cleanText(pick(d.pregnancy) || pick(d.pregnancy_or_breast_feeding) || ""),
      storage: cleanText(pick(d.storage_and_handling) || ""),
      source: "openfda",
      lang: safeLang,
      translated_by: null,
      translation_ok: null,
      tried,
    };

    if (safeLang === "es") {
      const fieldsToTranslate = ["indications","dosage","warnings","contraindications","interactions","pregnancy","storage"];
      let okAll = true;
      for (const k of fieldsToTranslate) {
        const original = out[k];
        if (!original) continue;
        const tr = await translateToEs(original, "en");
        out[k] = tr;
        if (cleanText(tr) === cleanText(original)) okAll = false;
      }
      out.translated_by = "libretranslate";
      out.translation_ok = okAll;
    }

    cacheSet(key, out);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error consultando OpenFDA/LibreTranslate" });
  }
});

// ==================== EXPORT EXCEL (por tenant) ====================
function setXlsxDownload(res, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

app.get("/api/export/inventory.xlsx", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (_req, res) => {
  try {
    const rows = await all(
      `SELECT code, name, lab, location, stock, buy_price, sell_price, expiry_date
       FROM products
       WHERE tenant_id=?
       ORDER BY name ASC`,
      [res.req.tenant.id]
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "POS Farmacia SaaS";
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

app.get("/api/export/sales.xlsx", auth, requireRole("admin", "cajero", "superadmin"), requireTenant, async (req, res) => {
  try {
    const from = cleanText(req.query.from);
    const to = cleanText(req.query.to);
    if (!from || !to) return res.status(400).json({ error: "Faltan from/to" });

    const tenant_id = req.tenant.id;

    const sales = await all(
      `SELECT id, date, total, payment_method
       FROM sales
       WHERE tenant_id=? AND substr(date,1,10) BETWEEN ? AND ?
       ORDER BY id DESC`,
      [tenant_id, from, to]
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "POS Farmacia SaaS";
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
      `SELECT s.id as sale_id, s.date as sale_date, p.code, p.name, si.qty, si.price_unit, si.subtotal
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       WHERE s.tenant_id=? AND substr(s.date,1,10) BETWEEN ? AND ?
       ORDER BY s.id DESC`,
      [tenant_id, from, to]
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
// AUDIT (solo admin/superadmin)
// =========================
app.get("/api/audit", auth, requireRole("admin", "superadmin"), requireTenant, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const rows = await all(
    `SELECT id, tenant_id, user_id, action, entity, entity_id, metadata, created_at
     FROM audit_log
     WHERE tenant_id=?
     ORDER BY id DESC
     LIMIT ?`,
    [req.tenant.id, limit]
  );
  res.json(rows);
});

// =========================
// START
// =========================
const PORT = Number(process.env.PORT || 3000);

init().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Backend SaaS corriendo en http://0.0.0.0:${PORT}`);
    console.log(`✅ LibreTranslate URL: ${LIBRETRANSLATE_URL}`);
    console.log(`✅ Login SaaS: enviar tenant_slug en /api/login o header X-Tenant-Slug en requests`);
  });
});
