// pos.js
// Requiere app.js (api(), token(), requireAuth(), applyRoleVisibility(), money())

const qs = (id) => document.getElementById(id);

let products = [];
let cart = [];

function setMsg(text = "", isError = true) {
  const m = qs("msg");
  if (!m) return;
  m.style.color = isError ? "#ef4444" : "#16a34a";
  m.textContent = text;
}

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

function recalc() {
  const total = cart.reduce((acc, it) => acc + (it.price_unit * it.qty), 0);
  qs("total").textContent = money(total);
}

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
    div.className = "row";
    div.style.justifyContent = "space-between";
    div.style.alignItems = "center";
    div.style.marginBottom = "8px";

    div.innerHTML = `
      <div style="flex:1">
        <b>${it.name}</b>
        <div class="small">Código: ${it.code} · P.Unit: S/ ${money(it.price_unit)}</div>
      </div>

      <div class="row" style="gap:6px; align-items:center;">
        <button class="secondary" data-act="minus">-</button>
        <span class="badge">${it.qty}</span>
        <button class="secondary" data-act="plus">+</button>
        <button class="danger" data-act="del">x</button>
      </div>
    `;

    div.querySelectorAll("button").forEach(btn => {
      btn.onclick = () => {
        const act = btn.getAttribute("data-act");
        if (act === "minus") {
          it.qty -= 1;
          if (it.qty <= 0) cart = cart.filter(x => x.product_id !== it.product_id);
        }
        if (act === "plus") it.qty += 1;
        if (act === "del") cart = cart.filter(x => x.product_id !== it.product_id);

        renderCart();
      };
    });

    box.appendChild(div);
  }

  recalc();
}

function addToCart(p) {
  // ✅ Bloquear si vencido
  if (p.expiry_date && isExpired(p.expiry_date)) {
    setMsg(`❌ Producto vencido: ${p.name} (${p.expiry_date}). No se puede vender.`, true);
    return;
  }

  // ✅ Aviso si vence pronto
  if (p.expiry_date && isExpiringSoon(p.expiry_date, 30)) {
    const d = daysTo(p.expiry_date);
    setMsg(`⚠️ OJO: "${p.name}" vence en ${d} días (${p.expiry_date}).`, true);
  } else {
    setMsg("", true);
  }

  const found = cart.find(x => x.product_id === p.id);
  if (found) found.qty += 1;
  else {
    cart.push({
      product_id: p.id,
      code: p.code,
      name: p.name,
      qty: 1,
      price_unit: Number(p.sell_price || 0),
    });
  }
  renderCart();
}

function renderProducts() {
  const tb = qs("products");
  tb.innerHTML = "";

  const q = (qs("search").value || "").trim().toLowerCase();
  const rows = products.filter(p => {
    if (!q) return true;
    return (p.name || "").toLowerCase().includes(q) || (p.code || "").toLowerCase().includes(q);
  });

  for (const p of rows) {
    const tr = document.createElement("tr");

    const d = daysTo(p.expiry_date);
    let venceBadge = "";
    if (d !== null) {
      if (d < 0) venceBadge = `<span class="badge" style="background:#ef4444;color:white;">VENCIDO</span>`;
      else if (d <= 30) venceBadge = `<span class="badge" style="background:#f59e0b;color:white;">${d} días</span>`;
      else venceBadge = `<span class="badge">${d} días</span>`;
    }

    tr.innerHTML = `
      <td>${p.code}</td>
      <td>
        <b>${p.name}</b>
        <div class="small">${p.lab || ""}</div>
        <div class="small">
          Ubicación: <b>${p.location || "-"}</b>
          ${p.expiry_date ? ` · Vence: <b>${p.expiry_date}</b> ${venceBadge}` : ""}
        </div>
      </td>
      <td><span class="badge">${p.stock}</span></td>
      <td>S/ ${money(p.sell_price)}</td>
      <td><button class="secondary">Agregar</button></td>
    `;

    // pinta fila si vencido / por vencer
    if (d !== null) {
      if (d < 0) tr.style.background = "rgba(239,68,68,0.10)";
      else if (d <= 30) tr.style.background = "rgba(245,158,11,0.10)";
    }

    tr.querySelector("button").onclick = () => addToCart(p);
    tb.appendChild(tr);
  }

  if (rows.length === 0) {
    tb.innerHTML = `<tr><td colspan="5" class="small">No hay productos</td></tr>`;
  }
}

async function loadProducts() {
  products = await api("/api/products?search=");
  renderProducts();
}

// Ticket html
function buildTicket(sale, items) {
  qs("ticketMeta").textContent =
    `Venta #${sale.id} · ${sale.date.replace("T", " ").slice(0,16)} · Pago: ${sale.payment_method}`;

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

async function sell() {
  try {
    if (cart.length === 0) {
      setMsg("Carrito vacío", true);
      return;
    }

    // validar stock local (rápido)
    for (const it of cart) {
      const p = products.find(x => x.id === it.product_id);
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
      body: JSON.stringify({ items: cart, payment_method })
    });

    // imprimir
    buildTicket(r.sale, r.items);

    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>Ticket</title></head><body>${qs("ticket").innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    w.print();

    // limpiar y recargar
    cart = [];
    renderCart();
    setMsg("✅ Venta registrada correctamente.", false);

    await loadProducts();
  } catch (e) {
    console.error(e);
    setMsg("❌ " + (e.message || "Error al vender"), true);
  }
}

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
