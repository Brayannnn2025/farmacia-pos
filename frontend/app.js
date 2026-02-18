// app.js

// ✅ API dinámico: usa el mismo host/puerto donde abriste la web
// Ej: si abres http://35.171.xxx.xxx:3000/login.html
// entonces API = http://35.171.xxx.xxx:3000
const API = `${location.protocol}//${location.host}`;

// Helper DOM (NO redeclarar $ en otros .js)
function $(id) { return document.getElementById(id); }

// Auth storage
function token() { return localStorage.getItem("token"); }

function getUser() {
  try { return JSON.parse(localStorage.getItem("user") || "null"); }
  catch { return null; }
}

function setUser(u) {
  localStorage.setItem("user", JSON.stringify(u));
}

function role() {
  const u = getUser();
  return (u && u.role) ? u.role : null; // "admin" | "cajero"
}

function isAdmin() { return role() === "admin"; }
function isCashier() { return role() === "cajero"; }

// A qué página mandarlo según rol
function homeForRole() {
  return isAdmin() ? "dashboard.html" : "pos.html";
}

// Requiere login (y opcionalmente roles permitidos)
function requireAuth(allowedRoles = null) {
  if (!token()) {
    location.href = "login.html";
    return;
  }
  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    const r = role();
    if (!allowedRoles.includes(r)) {
      location.href = homeForRole();
    }
  }
}

// Mostrar/ocultar elementos por rol usando data-role
function applyRoleVisibility() {
  const r = role();
  document.querySelectorAll("[data-role]").forEach(el => {
    const allowed = (el.getAttribute("data-role") || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.length === 0) return;
    el.style.display = allowed.includes(r) ? "" : "none";
  });

  const tag = document.getElementById("roleTag");
  if (tag) tag.textContent = r ? r.toUpperCase() : "";
}

// =======================
// API JSON (NORMAL)
// =======================
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };

  // Si mandas body JSON, metemos Content-Type
  if (opts.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const t = token();
  if (t) headers["Authorization"] = "Bearer " + t;

  const res = await fetch(API + path, { ...opts, headers });

  // Si expiró el token -> forzamos logout suave
  if (res.status === 401) {
    // no redirigimos si estás en login
    if (!location.pathname.endsWith("login.html")) logout();
    throw new Error("No autorizado. Vuelve a iniciar sesión.");
  }

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

// =======================
// DESCARGA EXCEL (XLSX) ✅
// =======================
// Úsalo así:
// await downloadXlsx("/api/export/inventory.xlsx", "inventario.xlsx");
// await downloadXlsx(`/api/export/sales.xlsx?from=2026-02-01&to=2026-02-18`, "ventas.xlsx");
async function downloadXlsx(endpoint, filename = "reporte.xlsx") {
  const t = token();
  if (!t) {
    location.href = "login.html";
    return;
  }

  const res = await fetch(API + endpoint, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + t
    }
  });

  if (res.status === 401) {
    logout();
    throw new Error("No autorizado. Vuelve a iniciar sesión.");
  }

  if (!res.ok) {
    // intentamos leer error como texto
    const txt = await res.text().catch(() => "");
    throw new Error(`No se pudo descargar el Excel (HTTP ${res.status}). ${txt}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// (Compatibilidad) si ya llamabas downloadExcel(...) en tu código viejo
// ahora internamente usa downloadXlsx
async function downloadExcel(endpoint, filename) {
  return downloadXlsx(endpoint, filename);
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  location.href = "login.html";
}

function money(n) {
  return (Number(n) || 0).toFixed(2);
}
