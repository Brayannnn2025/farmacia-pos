// ventas.js (ACTUALIZADO FINAL)
// Requiere app.js cargado (api(), token(), money(), logout()).

const qs = (id) => document.getElementById(id);

function showErr(text = "") {
  const e = qs("msgErr");
  const o = qs("msgOk");
  if (o) o.style.display = "none";
  if (!e) return;
  e.textContent = text;
  e.style.display = text ? "block" : "none";
}

function showOk(text = "") {
  const e = qs("msgErr");
  const o = qs("msgOk");
  if (e) e.style.display = "none";
  if (!o) return;
  o.textContent = text;
  o.style.display = text ? "block" : "none";
  if (text) setTimeout(() => { o.style.display = "none"; }, 2200);
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtDate(iso) {
  // "2026-02-16T09:22:21.123Z" => "2026-02-16 09:22"
  return (iso || "").replace("T", " ").slice(0, 16);
}

// =======================
// LISTADO
// =======================
function renderList(rows) {
  const tb = qs("rows");
  if (!tb) return;

  tb.innerHTML = "";

  if (!rows || rows.length === 0) {
    tb.innerHTML = `<tr><td colspan="5" class="small">No hay ventas en el rango.</td></tr>`;
    if (window.__afterVentasRender) window.__afterVentasRender();
    return;
  }

  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.id}</td>
      <td>${fmtDate(s.date)}</td>
      <td>${s.payment_method}</td>
      <td>S/ ${money(Number(s.total || 0))}</td>
      <td><button class="secondary" data-id="${s.id}">Ver</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.onclick = () => openSale(Number(btn.dataset.id));
  });

  // ✅ KPI hook
  if (window.__afterVentasRender) window.__afterVentasRender();
}

async function loadSales(from, to) {
  try {
    showErr("");
    showOk("Cargando ventas...");
    const url = `/api/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`;
    const rows = await api(url);
    renderList(rows);
    showOk("");
  } catch (e) {
    console.error(e);
    showOk("");
    showErr("❌ Error cargando ventas: " + (e.message || "revisa backend/token"));
  }
}

// =======================
// MODAL DETALLE + TICKET
// =======================
let currentSale = null;

function openModal() {
  const m = qs("modal");
  if (m) m.style.display = "block";
}
function closeModal() {
  const m = qs("modal");
  if (m) m.style.display = "none";
  currentSale = null;
}

function renderDetail(data) {
  const { sale, items } = data;

  const meta = qs("meta");
  const total = qs("total");
  const itemsDiv = qs("items");

  const ticketMeta = qs("ticketMeta");
  const ticketTotal = qs("ticketTotal");
  const ticketItems = qs("ticketItems");

  if (meta) meta.textContent = `Venta #${sale.id} · ${fmtDate(sale.date)} · Pago: ${sale.payment_method}`;
  if (total) total.textContent = money(Number(sale.total || 0));

  // Tabla detalle del modal (se queda igual)
  if (itemsDiv) {
    itemsDiv.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Código</th><th>Producto</th><th>Cant</th><th>P.Unit</th><th>Sub</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(it => `
            <tr>
              <td>${it.code}</td>
              <td>${it.name}</td>
              <td>${it.qty}</td>
              <td>S/ ${money(Number(it.price_unit))}</td>
              <td>S/ ${money(Number(it.subtotal))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  // ===== Ticket térmico =====
  if (ticketMeta) ticketMeta.textContent = `Venta #${sale.id} · ${fmtDate(sale.date)} · Pago: ${sale.payment_method}`;
  if (ticketTotal) ticketTotal.textContent = money(Number(sale.total || 0));

  if (ticketItems) {
    ticketItems.innerHTML = items.map(it => `
      <div class="t-line">
        <div class="w-name t-name">${it.name}</div>
        <div class="w-qty t-right">${it.qty}</div>
        <div class="w-sub t-right">S/ ${money(Number(it.subtotal))}</div>
      </div>
    `).join("");
  }
}


async function openSale(id) {
  try {
    showErr("");
    showOk("Cargando detalle...");
    const data = await api(`/api/sales/${id}`);
    currentSale = data;
    renderDetail(data);
    openModal();
    showOk("");
  } catch (e) {
    console.error(e);
    showOk("");
    showErr("❌ No se pudo cargar el detalle: " + (e.message || ""));
  }
}

function printTicketFromModal() {
  if (!currentSale) return;

  const ticket = qs("ticket");
  if (!ticket) {
    showErr("No se encontró el ticket para imprimir.");
    return;
  }

  const html = ticket.innerHTML;

  const w = window.open("", "_blank", "width=420,height=700");
  if (!w) {
    showErr("⚠️ El navegador bloqueó la impresión. Permite popups y reintenta.");
    return;
  }

  w.document.open();
  w.document.write(`
    <html>
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>Ticket</title>
        <style>
          @page { margin: 0; }
          html,body{ margin:0; padding:0; }
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  w.document.close();
  w.focus();

  setTimeout(() => w.print(), 250);
}


// =======================
// INIT
// =======================
function initVentas() {
  if (!token()) {
    location.href = "login.html";
    return;
  }

  const btnLoad = qs("btnLoad");
  const btnToday = qs("btnToday");
  const inpFrom = qs("from");
  const inpTo = qs("to");

  if (!inpFrom || !inpTo || !btnLoad) return;

  // Defaults
  const t = todayISO();
  if (!inpFrom.value) inpFrom.value = t;
  if (!inpTo.value) inpTo.value = t;

  btnLoad.onclick = () => {
    const from = inpFrom.value;
    const to = inpTo.value;
    if (!from || !to) return showErr("Selecciona fechas válidas.");
    loadSales(from, to);
  };

  if (btnToday) {
    btnToday.onclick = () => {
      const t = todayISO();
      inpFrom.value = t;
      inpTo.value = t;
      loadSales(t, t);
    };
  }

  const btnClose = qs("btnClose");
  const btnPrint = qs("btnPrint");
  if (btnClose) btnClose.onclick = closeModal;
  if (btnPrint) btnPrint.onclick = printTicketFromModal;

  // Cargar al abrir
  loadSales(inpFrom.value, inpTo.value);
}

document.addEventListener("DOMContentLoaded", initVentas);
