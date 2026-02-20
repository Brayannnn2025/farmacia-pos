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

  // 80mm por defecto. Si tu impresora es 58mm cambia aquí:
  const PAPER = "80mm"; // "58mm"

  const ticketCSS = `
    @page { size: ${PAPER} auto; margin: 0; }
    html, body { margin: 0; padding: 0; }
    body { width: ${PAPER}; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

    .t80{ width:80mm; padding:8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; color:#000; }
    .t58{ width:58mm; padding:8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; color:#000; }

    .t-center{text-align:center}
    .t-right{text-align:right}
    .t-title{ font-size:18px; font-weight:900; letter-spacing:.5px; }
    .t-sub{ font-size:11px; margin-top:3px; }
    .t-muted{ color:#111; opacity:.85; font-size:11px }
    .t-bold{ font-weight:900; }
    .t-hr{ border-top:1px dashed #000; margin:8px 0; }
    .t-row{ display:flex; justify-content:space-between; gap:10px; font-size:12px; }
    .t-cols{ display:flex; gap:6px; font-size:11px; margin-bottom:6px; }
    .t-line{ display:flex; gap:6px; font-size:12px; margin:2px 0; }
    .w-name{ flex: 1 1 auto; min-width:0; }
    .w-qty{ width:10mm; }
    .w-sub{ width:18mm; }
    .t-name{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  `;

  // OJO: usa outerHTML para no perder el wrapper del ticket
  const html = ticket.outerHTML;

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
        <style>${ticketCSS}</style>
      </head>
      <body>${html}</body>
    </html>
  `);
  w.document.close();
  w.focus();

  setTimeout(() => w.print(), 200);
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
