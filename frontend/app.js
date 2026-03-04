// app.js (SaaS por tenant slug en login)

const API = `${location.protocol}//${location.host}`;

function $(id) { return document.getElementById(id); }

function token() { return localStorage.getItem("token"); }

function getUser() {
  try { return JSON.parse(localStorage.getItem("user") || "null"); }
  catch { return null; }
}
function setUser(u) { localStorage.setItem("user", JSON.stringify(u)); }

function getTenantSlug() { return localStorage.getItem("tenant_slug") || ""; }
function setTenantSlug(slug) { localStorage.setItem("tenant_slug", String(slug || "").trim()); }

function role() {
  const u = getUser();
  return (u && u.role) ? u.role : null;
}

function isAdmin() { return role() === "admin"; }
function isCashier() { return role() === "cajero"; }
function isSuperadmin() { return role() === "superadmin"; }

function homeForRole() {
  if (isSuperadmin()) return "login.html"; // superadmin no usa POS normal (luego le hacemos panel)
  return isAdmin() ? "dashboard.html" : "pos.html";
}

function requireAuth(allowedRoles = null) {
  if (!token()) { location.href = "login.html"; return; }

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    const r = role();
    if (!allowedRoles.includes(r)) location.href = homeForRole();
  }

  // si no es superadmin, debe existir tenant_slug
  if (!isSuperadmin() && !getTenantSlug()) {
    location.href = "login.html";
  }
}

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
// API JSON (SaaS)
// =======================
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };

  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const t = token();
  if (t) headers["Authorization"] = "Bearer " + t;

  // ✅ SaaS header
  if (!isSuperadmin()) {
    const slug = getTenantSlug();
    if (slug) headers["X-Tenant-Slug"] = slug;
  }

  const res = await fetch(API + path, { ...opts, headers });

  if (res.status === 401) {
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
// DESCARGA XLSX
// =======================
async function downloadXlsx(endpoint, filename = "reporte.xlsx") {
  const t = token();
  if (!t) { location.href = "login.html"; return; }

  const headers = { Authorization: "Bearer " + t };

  if (!isSuperadmin()) {
    const slug = getTenantSlug();
    if (slug) headers["X-Tenant-Slug"] = slug;
  }

  const res = await fetch(API + endpoint, { method: "GET", headers });

  if (res.status === 401) { logout(); throw new Error("No autorizado. Vuelve a iniciar sesión."); }
  if (!res.ok) {
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

async function downloadExcel(endpoint, filename) {
  return downloadXlsx(endpoint, filename);
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("tenant_slug");
  location.href = "login.html";
}

function money(n) {
  return (Number(n) || 0).toFixed(2);
}
