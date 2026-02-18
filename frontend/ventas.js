// ventas.js (ACTUALIZADO)
// Requiere app.js cargado (api(), token(), money(), logout()).

const qs = (id) => document.getElementById(id);

function setMsg(text = "", isError = false) {
  const m = qs("msg");
  if (!m) return;
  m.textContent = text;
  m.style.color = isError ? "#ef4444" : "#16a34a";
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
    // ✅ KPI hook
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

  // Delegación de eventos para botones "Ver"
  tb.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.onclick = () => openSale(Number(btn.dataset.id));
  });

  // ✅ KPI hook (para que ventas.html actualice Ventas/Total)
  if (window.__afterVentasRender) window.__afterVentasRender();
}

async function loadSales(from, to) {
  try {
    setMsg("Cargando...", false);
    const url = `/api/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`;
    const rows = await api(url);
    renderList(rows);
    setMsg("", false);
  } catch (e) {
    console.error(e);
    setMsg("❌ Error cargando ventas. Revisa consola / token / backend.", true);
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

  qs("meta").textContent = `Venta #${sale.id} · ${fmtDate(sale.date)} · Pago: ${sale.payment_method}`;
  qs("total").textContent = money(Number(sale.total || 0));

  // Tabla items en modal
  qs("items").innerHTML = `
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

  // Ticket oculto para imprimir
  qs("ticketMeta").textContent = `Venta #${sale.id} · ${fmtDate(sale.date)} · Pago: ${sale.payment_method}`;
  qs("ticketTotal").textContent = money(Number(sale.total || 0));
  qs("ticketItems").innerHTML = items
    .map(it => `
      <div style="display:flex;justify-content:space-between;gap:12px;">
        <div>${it.name} <span style="color:#555;">x${it.qty}</span></div>
        <div>S/ ${money(Number(it.subtotal))}</div>
      </div>
    `)
    .join("");
}

async function openSale(id) {
  try {
    setMsg("Cargando detalle...", false);
    const data = await api(`/api/sales/${id}`);
    currentSale = data;
    renderDetail(data);
    openModal();
    setMsg("", false);
  } catch (e) {
    console.error(e);
    setMsg("❌ No se pudo cargar el detalle de la venta.", true);
  }
}

function printTicketFromModal() {
  if (!currentSale) return;

  const ticket = qs("ticket");
  if (!ticket) return setMsg("No se encontró el ticket para imprimir.", true);

  const html = ticket.innerHTML;

  // Popup
  const w = window.open("", "_blank", "width=420,height=700");
  if (!w) {
    setMsg("⚠️ El navegador bloqueó la ventana de impresión. Permite popups y reintenta.", true);
    return;
  }

  w.document.write(`
    <html>
      <head>
        <meta charset="utf-8"/>
        <title>Ticket</title>
        <style>
          body{font-family:Arial;margin:0;padding:0;}
          .small{font-size:12px;color:#555;}
          hr{border:none;border-top:1px solid #ddd;margin:10px 0;}
          h2,h3{margin:0;}
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  w.document.close();
  w.focus();

  // Espera un pelín para asegurar render antes de imprimir
  setTimeout(() => {
    w.print();
    // w.close(); // si quieres que se cierre solo, descomenta
  }, 250);
}

// =======================
// INIT
// =======================
function initVentas() {
  if (!token()) location.href = "login.html";

  const btnLoad = qs("btnLoad");
  const btnToday = qs("btnToday");
  const inpFrom = qs("from");
  const inpTo = qs("to");

  // Si por alguna razón no existen inputs, salimos
  if (!inpFrom || !inpTo || !btnLoad) return;

  // Defaults (si están vacíos)
  const t = todayISO();
  if (!inpFrom.value) inpFrom.value = t;
  if (!inpTo.value) inpTo.value = t;

  // Buscar
  btnLoad.onclick = () => {
    const from = inpFrom.value;
    const to = inpTo.value;
    if (!from || !to) return setMsg("Selecciona fechas válidas.", true);
    loadSales(from, to);
  };

  // Hoy (solo si existe el botón)
  if (btnToday) {
    btnToday.onclick = () => {
      const t = todayISO();
      inpFrom.value = t;
      inpTo.value = t;
      loadSales(t, t);
    };
  }

  // Modal buttons
  const btnClose = qs("btnClose");
  const btnPrint = qs("btnPrint");
  if (btnClose) btnClose.onclick = closeModal;
  if (btnPrint) btnPrint.onclick = printTicketFromModal;

  // Cargar al abrir con el rango actual del HTML
  loadSales(inpFrom.value, inpTo.value);
}

document.addEventListener("DOMContentLoaded", initVentas);
