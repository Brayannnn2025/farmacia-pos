// app.js
const API = "http://localhost:3000";

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
  return isAdmin() ? "admin_productos.html" : "pos.html";
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
      // si no tiene permiso, lo mandamos a su home
      location.href = homeForRole();
    }
  }
}

// Mostrar/ocultar elementos por rol usando data-role
// Ej: <a data-role="admin">...</a> o <div data-role="admin,cajero">
function applyRoleVisibility() {
  const r = role();
  document.querySelectorAll("[data-role]").forEach(el => {
    const allowed = (el.getAttribute("data-role") || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.length === 0) return;
    el.style.display = allowed.includes(r) ? "" : "none";
  });

  // (opcional) mostrar rol en la UI si existe un span#roleTag
  const tag = document.getElementById("roleTag");
  if (tag) tag.textContent = r ? r.toUpperCase() : "";
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };

  // Si mandas body JSON, metemos Content-Type
  if (opts.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const t = token();
  if (t) headers["Authorization"] = "Bearer " + t;

  const res = await fetch(API + path, { ...opts, headers });

  // Parse seguro (por si viene texto)
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  location.href = "login.html";
}

function money(n) {
  return (Number(n) || 0).toFixed(2);
}
