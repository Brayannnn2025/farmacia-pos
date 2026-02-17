// usuarios.js
// Requiere app.js (api(), requireAuth(), money(), etc)

function qs(id){ return document.getElementById(id); }

function setMsg(t=""){
  qs("msg").textContent = t || "";
}

async function loadUsers(){
  const tb = qs("tbody");
  tb.innerHTML = `<tr><td colspan="4" class="small">Cargando...</td></tr>`;

  const users = await api("/api/users");
  tb.innerHTML = "";

  for(const u of users){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.id}</td>
      <td>${u.username}</td>
      <td><span class="badge">${u.role}</span></td>
      <td>
        <button class="danger" data-id="${u.id}" data-user="${u.username}">Eliminar</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  if(users.length === 0){
    tb.innerHTML = `<tr><td colspan="4" class="small">No hay usuarios</td></tr>`;
  }

  // eventos eliminar
  tb.querySelectorAll("button.danger").forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute("data-id");
      const uname = btn.getAttribute("data-user");
      if(!confirm(`¿Eliminar usuario "${uname}"?`)) return;
      try{
        await api(`/api/users/${id}`, { method:"DELETE" });
        await loadUsers();
      }catch(e){
        setMsg(e.message);
      }
    };
  });
}

async function createUser(){
  setMsg("");
  const username = qs("username").value.trim();
  const password = qs("password").value.trim();
  const role = qs("roleSel").value;

  if(!username || !password) {
    setMsg("Completa usuario y contraseña.");
    return;
  }

  try{
    await api("/api/users", {
      method:"POST",
      body: JSON.stringify({ username, password, role })
    });

    qs("username").value = "";
    qs("password").value = "";
    qs("roleSel").value = "cajero";

    await loadUsers();
  }catch(e){
    setMsg(e.message);
  }
}

document.addEventListener("DOMContentLoaded", ()=>{
  qs("btnCreate").onclick = createUser;
  loadUsers();
});
