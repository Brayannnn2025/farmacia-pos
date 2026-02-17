// app.js

// ✅ API automática:
// - Si abres desde EC2:  http://35.x.x.x:3000  -> usa esa misma
// - Si abres en tu PC local: http://localhost:3000 -> usa localhost
const API = window.location.origin;

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

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };

  if (opts.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const t = token();
  if (t) headers["Authorization"] = "Bearer " + t;

  // ✅ importante: path debe empezar con "/"
  const url = API + path;

  const res = await fetch(url, { ...opts, headers });

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
