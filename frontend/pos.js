// pos.js
// Requiere app.js (api(), token(), requireAuth(), applyRoleVisibility(), money())

const qs = (id) => document.getElementById(id);

let products = [];
let cart = [];

/* =========================
   Mensajes
========================= */
function setMsg(text = "", isError = true) {
  const m = qs("msg");
  if (!m) return;
  m.style.color = isError ? "#ef4444" : "#16a34a";
  m.textContent = text;
}

/* =========================
   Fechas / Vencimientos
========================= */
function daysTo(expiry) {
  if (!expiry) return null;
  const d = new Date(expiry + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const e0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.ceil((e0 - t0) / (1000 * 60 * 60 * 24));
}

function isExpired(expiry) {
  const d = daysTo(expiry);
  return d !== null && d < 0;
}

function isExpiringSoon(expiry, limitDays = 30) {
  const d = daysTo(expiry);
  return d !== null && d >= 0 && d <= limitDays;
}

/* =========================
   Imágenes (real + fallback)
========================= */

// Placeholder sin internet (SVG data URI)
function placeholderImg(name) {
  const txt = (name || "Producto").toString().slice(0, 22).replace(/[<>&"]/g, "");
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <defs>
      <linearGradient id="g" x1="0" x2="1">
        <stop offset="0" stop-color="#e2e8f0"/>
        <stop offset="1" stop-color="#f8fafc"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="520" cy="120" r="90" fill="#dbeafe"/>
    <rect x="70" y="260" width="500" height="90" rx="18" fill="#ffffff" stroke="#e5e7eb"/>
    <text x="320" y="315" font-family="Arial" font-size="28" font-weight="700" fill="#0f172a" text-anchor="middle">${txt}</text>
    <text x="320" y="355" font-family="Arial" font-size="16" fill="#64748b" text-anchor="middle">Sin imagen</text>
  </svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

// Obtiene URL de imagen desde producto (si existe)
function getProductImg(p) {
  return p.image_url || p.imageUrl || p.img || p.image || "";
}

function stockClass(stock) {
  const s = Number(stock || 0);
  if (s <= 0) return "out";
  if (s <= 5) return "low";
  return "";
}

/* =========================
   Totales
========================= */
function recalc() {
  const total = cart.reduce((acc, it) => acc + it.price_unit * it.qty, 0);
  qs("total").textContent = money(total);
}

/* =========================
   Carrito (con mini imagen)
========================= */
function renderCart() {
  const box = qs("cart");
  box.innerHTML = "";

  if (cart.length === 0) {
    box.innerHTML = `<div class="small">Carrito vacío</div>`;
    recalc();
    return;
  }

  for (const it of cart) {
    const div = document.createElement("div");
    div.className = "item";

    const img = it.img || placeholderImg(it.name);

    div.innerHTML = `
      <div class="thumb">
        <img src="${img}" alt="${(it.name || "Producto").replace(/"/g, "")}"
             onerror="this.src='${placeholderImg(it.name)}'"/>
      </div>

      <div style="min-width:0">
        <div class="name">${it.name}</div>
        <div class="sub">Código: ${it.code} · P.Unit: S/ ${money(it.price_unit)}</div>
      </div>

      <div class="qty">
        <button class="secondary" data-act="minus" type="button">-</button>
        <span class="badge">${it.qty}</span>
        <button class="secondary" data-act="plus" type="button">+</button>
        <button class="danger" data-act="del" type="button">x</button>
      </div>
    `;

    div.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        const act = btn.getAttribute("data-act");
        if (act === "minus") {
          it.qty -= 1;
          if (it.qty <= 0) cart = cart.filter((x) => x.product_id !== it.product_id);
        }
        if (act === "plus") it.qty += 1;
        if (act === "del") cart = cart.filter((x) => x.product_id !== it.product_id);

        renderCart();
      };
    });

    box.appendChild(div);
  }

  recalc();
}

/* =========================
   Agregar al carrito
========================= */
function addToCart(p) {
  if (p.expiry_date && isExpired(p.expiry_date)) {
    setMsg(`❌ Producto vencido: ${p.name} (${p.expiry_date}). No se puede vender.`, true);
    return;
  }

  if (p.expiry_date && isExpiringSoon(p.expiry_date, 30)) {
    const d = daysTo(p.expiry_date);
    setMsg(`⚠️ OJO: "${p.name}" vence en ${d} días (${p.expiry_date}).`, true);
  } else {
    setMsg("", true);
  }

  const found = cart.find((x) => x.product_id === p.id);
  if (found) {
    found.qty += 1;
  } else {
    cart.push({
      product_id: p.id,
      code: p.code,
      name: p.name,
      qty: 1,
      price_unit: Number(p.sell_price || 0),
      img: getProductImg(p) || placeholderImg(p.name),
    });
  }

  renderCart();
}

/* =========================
   MODAL Info Farmacéutica (PRO)
   - Cierra SIEMPRE (botón + click fuera + ESC)
   - Buscador para consultar cualquier medicamento (aunque no esté en inventario)
   - “Resumen en español” (recorta y ordena para lectura)
========================= */
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resumenEs(data) {
  const cut = (s, n = 350) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  };

  return {
    titulo: `${data.brand_name || data.query || ""}${data.generic_name ? ` (${data.generic_name})` : ""}`,
    ingrediente: String(data.active_ingredient || "").trim(),
    indicaciones: cut(data.indications, 320),
    dosis: cut(data.dosage, 280),
    advertencias: cut(data.warnings, 360),
    embarazo: cut(data.pregnancy, 240),
    almacenamiento: cut(data.storage, 240),
  };
}

function ensureDrugModal() {
  if (document.getElementById("drugModal")) return;

  const wrap = document.createElement("div");
  wrap.id = "drugModal";
  wrap.style.cssText = `
    display:none;
    position:fixed;
    inset:0;
    background:rgba(0,0,0,.45);
    padding:18px;
    overflow:auto;
    z-index:999999;
  `;

  wrap.innerHTML = `
    <div id="drugModalPanel" style="
      max-width:980px;
      margin:20px auto;
      background:#fff;
      border-radius:16px;
      box-shadow:0 10px 40px rgba(0,0,0,.18);
      overflow:hidden;
    ">
      <div style="
        position:sticky; top:0;
        background:#fff;
        border-bottom:1px solid #e5e7eb;
        padding:14px 16px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        z-index:2;
      ">
        <div style="min-width:0">
          <div style="font-weight:800; font-size:20px;">Información farmacéutica</div>
          <div class="small muted" id="drugMeta" style="margin-top:4px;"></div>
        </div>

        <button id="btnDrugClose" type="button" style="
          padding:10px 14px;
          border:1px solid #cbd5e1;
          background:#fff;
          border-radius:12px;
          cursor:pointer;
          font-weight:700;
        ">Cerrar ✕</button>
      </div>

      <div style="padding:14px 16px; border-bottom:1px solid #eef2f7; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <input id="drugSearchInput" placeholder="Ej: paracetamol, ibuprofeno, amoxicilina..."
          style="flex:1; min-width:240px; padding:12px 12px; border:1px solid #cbd5e1; border-radius:12px; outline:none;" />
        <button id="btnDrugSearch" type="button" style="
          padding:12px 14px;
          border:0;
          background:#0ea5e9;
          color:#fff;
          border-radius:12px;
          cursor:pointer;
          font-weight:800;
        ">Buscar</button>

        <label class="small" style="display:flex; align-items:center; gap:8px; user-select:none;">
          <input id="drugTranslateToggle" type="checkbox" checked />
          Mostrar resumen en español
        </label>
      </div>

      <div id="drugBody" style="padding:14px 16px;">
        <div class="small muted">Escribe un medicamento y presiona <b>Buscar</b>.</div>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  // Cerrar por botón
  document.getElementById("btnDrugClose").onclick = (e) => {
    e.preventDefault();
    closeDrugModal();
  };

  // Cerrar clic fuera del panel (IMPORTANTE: no se rompe el click del botón)
  wrap.addEventListener("click", (e) => {
    const panel = document.getElementById("drugModalPanel");
    if (panel && !panel.contains(e.target)) closeDrugModal();
  });

  // Cerrar con ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrugModal();
  });

  // Buscar por input
  const doSearch = async () => {
    const v = (document.getElementById("drugSearchInput").value || "").trim();
    if (!v) return;
    await showDrugInfo(v);
  };
  document.getElementById("btnDrugSearch").onclick = doSearch;
  document.getElementById("drugSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
}

function openDrugModal() {
  ensureDrugModal();
  const m = document.getElementById("drugModal");
  m.style.display = "block";
  m.style.pointerEvents = "auto";
}

function closeDrugModal() {
  const m = document.getElementById("drugModal");
  if (m) m.style.display = "none";
}

function renderDrugInfo(data) {
  const meta = document.getElementById("drugMeta");
  const body = document.getElementById("drugBody");
  const tgl = document.getElementById("drugTranslateToggle");

  if (!data || !data.found) {
    meta.textContent = "";
    body.innerHTML = `<div class="small">No se encontró información para: <b>${escapeHtml(data?.query || "")}</b></div>`;
    return;
  }

  meta.textContent = `Fuente: ${data.source} · Búsqueda: ${data.query}`;

  const showEs = !!tgl?.checked;
  const es = resumenEs(data);

  const field = (title, value) => {
    const v = String(value || "").trim();
    if (!v) return "";
    return `
      <div style="margin:12px 0;">
        <div class="small muted" style="font-weight:900; margin-bottom:6px;">${escapeHtml(title)}</div>
        <div style="white-space:pre-wrap; line-height:1.5;">${escapeHtml(v)}</div>
      </div>
    `;
  };

  const chips = `
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
      <span style="padding:7px 10px; border-radius:999px; background:#eef2ff; font-weight:900;">
        ${escapeHtml(data.brand_name || data.query || "")}
      </span>
      ${data.generic_name ? `<span style="padding:7px 10px; border-radius:999px; background:#ecfeff; font-weight:800;">
        Genérico: ${escapeHtml(data.generic_name)}
      </span>` : ""}
      ${data.active_ingredient ? `<span style="padding:7px 10px; border-radius:999px; background:#f1f5f9; font-weight:800;">
        Ingrediente: ${escapeHtml(data.active_ingredient)}
      </span>` : ""}
    </div>
  `;

  const esBlock = `
    <div style="margin-top:14px; padding:12px; border:1px solid #e5e7eb; border-radius:14px; background:#f8fafc;">
      <div style="font-weight:900; margin-bottom:8px;">Resumen en español (automático)</div>
      ${field("Indicaciones / Uso", es.indicaciones)}
      ${field("Dosis / Administración", es.dosis)}
      ${field("Advertencias", es.advertencias)}
      ${field("Embarazo / Lactancia", es.embarazo)}
      ${field("Almacenamiento", es.almacenamiento)}
      <div class="small muted">Nota: OpenFDA suele estar en inglés. Este resumen recorta y ordena la info para lectura rápida.</div>
    </div>
  `;

  const originalBlock = `
    <div style="margin-top:14px;">
      <details>
        <summary style="cursor:pointer; font-weight:900;">Ver texto original (OpenFDA - inglés)</summary>
        <div style="margin-top:10px;">
          ${field("Indications / Usage", data.indications)}
          ${field("Dosage / Administration", data.dosage)}
          ${field("Warnings", data.warnings)}
          ${field("Contraindications", data.contraindications)}
          ${field("Interactions", data.interactions)}
          ${field("Pregnancy / Lactation", data.pregnancy)}
          ${field("Storage", data.storage)}
        </div>
      </details>
    </div>
  `;

  body.innerHTML = `
    ${chips}
    ${showEs ? esBlock : ""}
    ${originalBlock}
  `;
}

async function showDrugInfo(name) {
  try {
    openDrugModal();

    // Rellenar input (si viene desde botón del producto)
    const inp = document.getElementById("drugSearchInput");
    if (inp && name) inp.value = name;

    document.getElementById("drugMeta").textContent = "Cargando...";
    document.getElementById("drugBody").innerHTML = `<div class="small muted">Buscando información...</div>`;

    const data = await api(`/api/drug-info?name=${encodeURIComponent(name)}`);

    // Render inicial
    renderDrugInfo(data);

    // Re-render si cambian el toggle sin volver a consultar
    const tgl = document.getElementById("drugTranslateToggle");
    if (tgl && !tgl._bound) {
      tgl._bound = true;
      tgl.addEventListener("change", () => renderDrugInfo(data));
    }
  } catch (e) {
    document.getElementById("drugMeta").textContent = "";
    document.getElementById("drugBody").innerHTML = `<div class="small" style="color:#ef4444;">Error: ${escapeHtml(e.message || "No se pudo consultar")}</div>`;
  }
}

/* =========================
   Render productos (CARDS)
========================= */
function renderProducts() {
  const root = qs("products");
  root.innerHTML = "";

  const q = (qs("search").value || "").trim().toLowerCase();

  const rows = products.filter((p) => {
    if (!q) return true;
    return (p.name || "").toLowerCase().includes(q) || (p.code || "").toLowerCase().includes(q);
  });

  if (rows.length === 0) {
    root.innerHTML = `<div class="small">No hay productos</div>`;
    return;
  }

  for (const p of rows) {
    const d = daysTo(p.expiry_date);

    let venceBadge = "";
    if (d !== null) {
      if (d < 0) venceBadge = `<span class="badge" style="background:#ef4444;color:white;">VENCIDO</span>`;
      else if (d <= 30) venceBadge = `<span class="badge" style="background:#f59e0b;color:white;">${d} días</span>`;
      else venceBadge = `<span class="badge">${d} días</span>`;
    }

    const img = getProductImg(p) || placeholderImg(p.name);

    const card = document.createElement("div");
    card.className = "p-card";

    let ribbon = "";
    if (d !== null) {
      if (d < 0) ribbon = `<span class="badge" style="background:#ef4444;color:white;">VENCIDO</span>`;
      else if (d <= 30) ribbon = `<span class="badge" style="background:#f59e0b;color:white;">POR VENCER</span>`;
    }

    const stCls = stockClass(p.stock);
    const stText = Number(p.stock || 0) <= 0 ? "SIN STOCK" : `Stock: ${p.stock}`;

    card.innerHTML = `
      <div class="p-img">
        <img src="${img}" alt="${(p.name || "Producto").replace(/"/g, "")}"
             onerror="this.src='${placeholderImg(p.name)}'"/>
      </div>
      <div class="p-body">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div class="p-title">${p.name || "Producto"}</div>
          <div>${ribbon}</div>
        </div>

        <div class="p-meta">
          <span>Código: <b>${p.code || "-"}</b></span>
          <span class="p-price">S/ ${money(p.sell_price || 0)}</span>
        </div>

        <div class="small" style="color:#64748b">
          ${p.lab ? `Lab: <b>${p.lab}</b> · ` : ""}
          Ubicación: <b>${p.location || "-"}</b>
          ${p.expiry_date ? ` · Vence: <b>${p.expiry_date}</b> ${venceBadge}` : ""}
        </div>

        <span class="p-stock ${stCls}">${stText}</span>

        <div style="margin-top:8px; display:flex; gap:10px; justify-content:flex-end">
          <button class="secondary" data-act="info" type="button">📚 Info</button>
          <button class="secondary" data-act="add" type="button">Agregar</button>
        </div>
      </div>
    `;

    const stock = Number(p.stock || 0);

    const addAction = () => {
      if (stock <= 0) {
        setMsg(`❌ Sin stock: ${p.name}`, true);
        return;
      }
      addToCart(p);
    };

    const infoBtn = card.querySelector('button[data-act="info"]');
    const addBtn = card.querySelector('button[data-act="add"]');

    infoBtn.onclick = (e) => {
      e.stopPropagation();
      showDrugInfo(p.name || p.code || "");
    };

    addBtn.onclick = (e) => {
      e.stopPropagation();
      addAction();
    };

    // Click en card agrega (pero no si clic fue en botón)
    card.addEventListener("click", (e) => {
      if (e.target && e.target.tagName === "BUTTON") return;
      addAction();
    });

    root.appendChild(card);
  }
}

/* =========================
   Cargar productos
========================= */
async function loadProducts() {
  products = await api("/api/products?search=");
  renderProducts();
}

/* =========================
   Ticket
========================= */
function buildTicket(sale, items) {
  qs("ticketMeta").textContent = `Venta #${sale.id} · ${sale.date.replace("T", " ").slice(0, 16)} · Pago: ${sale.payment_method}`;

  const box = qs("ticketItems");
  box.innerHTML = "";

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "space-between";
    row.innerHTML = `
      <div>${it.name} <span class="small">x${it.qty}</span></div>
      <div>S/ ${money(it.subtotal)}</div>
    `;
    box.appendChild(row);
  }

  qs("ticketTotal").textContent = money(sale.total);
}

/* =========================
   Vender
========================= */
async function sell() {
  try {
    if (cart.length === 0) {
      setMsg("Carrito vacío", true);
      return;
    }

    for (const it of cart) {
      const p = products.find((x) => x.id === it.product_id);
      if (!p) continue;
      if (p.stock < it.qty) {
        setMsg(`Stock insuficiente: ${p.name}`, true);
        return;
      }
      if (p.expiry_date && isExpired(p.expiry_date)) {
        setMsg(`Producto vencido: ${p.name}. No se puede vender.`, true);
        return;
      }
    }

    const payment_method = qs("payment").value;

    const r = await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({ items: cart, payment_method }),
    });

    buildTicket(r.sale, r.items);

    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>Ticket</title></head><body>${qs("ticket").innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    w.print();

    cart = [];
    renderCart();
    setMsg("✅ Venta registrada correctamente.", false);

    await loadProducts();
  } catch (e) {
    console.error(e);
    setMsg("❌ " + (e.message || "Error al vender"), true);
  }
}

/* =========================
   Init
========================= */
function initPos() {
  requireAuth(["admin", "cajero"]);
  applyRoleVisibility();

  qs("btnReload").onclick = loadProducts;
  qs("search").oninput = renderProducts;

  qs("btnClear").onclick = () => {
    cart = [];
    renderCart();
    setMsg("", true);
  };

  qs("btnSell").onclick = sell;

  renderCart();
  loadProducts();
}

document.addEventListener("DOMContentLoaded", initPos);
