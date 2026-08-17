"use strict";

// Cliente del POS. No guarda estado propio: todo viene del servidor del local.
// Lo único local es qué ventana está viendo este dispositivo.

const S = {
  vista: "salon",
  token: sessionStorage.getItem("token") || null,
  yo: null,                 // el rol sale de acá, no del dispositivo
  candidato: null,          // usuario elegido en la pantalla de ingreso
  pin: "",
  errorLogin: null,
  usuarios: [],
  ordenId: null,
  cat: null,
  pago: "Efectivo",
  receptor: null,       // null = tiquete; con datos = factura
  frecuentes: [],
  busca: "",
  hallado: null,
  manual: false,
  panel: null,
  motivo: null,
  verComanda: false,
  aviso: null,
  conectado: false,
  menu: [],
  estado: { mesas: [], ordenes: [], cola: 0 },
  comprobantes: [],
  turno: null,
  reportes: null,
  productos: [],
  cocina: [],
  usuariosTodos: [],
  certificado: null,
  editando: null,
  editandoUsuario: null,
  anulando: null,
};

const MOTIVOS = ["Cliente se retiró", "Error al tomar la orden", "Producto agotado", "Orden duplicada"];
const ROLES = [
  { id: "salonero", txt: "Salonero", vistas: ["salon", "express", "pedido"] },
  { id: "cocina", txt: "Cocina", vistas: ["cocina"] },
  { id: "caja", txt: "Caja", vistas: ["salon", "express", "pedido", "pago", "cocina"] },
  { id: "admin", txt: "Administración",
    vistas: ["salon", "express", "pedido", "pago", "cocina", "comprobantes", "cierre", "reportes", "menu", "ajustes"] },
];
const VISTAS = [
  { id: "salon", lab: "Salón" }, { id: "express", lab: "Express" },
  { id: "pedido", lab: "Pedido" }, { id: "pago", lab: "Pago" },
  { id: "cocina", lab: "Cocina" },
];
const ADMIN = [
  { id: "comprobantes", lab: "Comprobantes" }, { id: "cierre", lab: "Cierre" },
  { id: "reportes", lab: "Reportes" }, { id: "menu", lab: "Menú" }, { id: "ajustes", lab: "Ajustes" },
];

const crc = (n) => "₡" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const mins = (ts) => Math.max(0, Math.round((Date.now() - ts) / 60000));
const rol = () => ROLES.find((r) => r.id === S.yo?.rol) ?? ROLES[0];
const orden = () => S.estado.ordenes.find((o) => o.id === S.ordenId);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(ruta, {
    method: metodo,
    headers: {
      "content-type": "application/json",
      ...(S.token ? { authorization: "Bearer " + S.token } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = await r.json();
  if (r.status === 401) { cerrarSesion(); throw new Error("La sesión venció"); }
  if (d.error) throw new Error(d.error);
  return d;
}

function cerrarSesion() {
  S.token = null; S.yo = null; S.pin = ""; S.candidato = null;
  sessionStorage.removeItem("token");
  if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  pintar();
}

function avisar(txt, mal) {
  S.aviso = { txt, mal };
  pintar();
  setTimeout(() => { S.aviso = null; pintar(); }, 4500);
}

async function accion(fn) {
  try { await fn(); } catch (e) { avisar(e.message, true); }
}

// ───────────────────────────── Ingreso

function vLogin(v) {
  const p = el("div", "panel");
  p.style.maxWidth = "420px";
  p.style.margin = "0 auto";
  p.style.justifyContent = "center";

  if (!S.candidato) {
    p.appendChild(el("h3", null, "¿Quién está en la caja?"));
    p.appendChild(el("p", "vacio", "El rol sale de quién ingresa, no del aparato."));
    const l = el("div", "opts");
    for (const u of S.usuarios) {
      const b = el("button", "opt");
      b.type = "button";
      b.appendChild(el("span", "lab", u.nombre));
      // De ROLES, no de un mapa aparte: repetirlo es cómo se olvidó "cocina".
      b.appendChild(el("span", "sub", ROLES.find((r) => r.id === u.rol)?.txt ?? u.rol));
      b.onclick = () => { S.candidato = u; S.pin = ""; S.errorLogin = null; pintar(); };
      l.appendChild(b);
    }
    p.appendChild(l);
    v.appendChild(p);
    return;
  }

  p.appendChild(el("h3", null, S.candidato.nombre));
  p.appendChild(el("p", "vacio", "Marcá tu PIN de 4 dígitos"));

  const puntos = el("div", "puntos");
  for (let i = 0; i < 4; i++) puntos.appendChild(el("span", "punto" + (i < S.pin.length ? " lleno" : "")));
  p.appendChild(puntos);

  if (S.errorLogin) p.appendChild(el("p", "err-login", S.errorLogin));

  const tec = el("div", "teclado");
  const marcar = (d) => {
    if (S.pin.length >= 4) return;
    S.pin += d;
    pintar();
    if (S.pin.length === 4) setTimeout(intentarEntrar, 120);
  };
  for (const d of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    const b = el("button", "tecla", d);
    b.type = "button"; b.onclick = () => marcar(d);
    tec.appendChild(b);
  }
  const atras = el("button", "tecla tecla-gris", "‹");
  atras.type = "button";
  atras.setAttribute("aria-label", "Volver a elegir usuario");
  atras.onclick = () => { S.candidato = null; S.pin = ""; S.errorLogin = null; pintar(); };
  tec.appendChild(atras);
  const cero = el("button", "tecla", "0");
  cero.type = "button"; cero.onclick = () => marcar("0");
  tec.appendChild(cero);
  const borrar = el("button", "tecla tecla-gris", "⌫");
  borrar.type = "button";
  borrar.setAttribute("aria-label", "Borrar");
  borrar.onclick = () => { S.pin = S.pin.slice(0, -1); S.errorLogin = null; pintar(); };
  tec.appendChild(borrar);
  p.appendChild(tec);
  v.appendChild(p);
}

async function intentarEntrar() {
  try {
    const r = await api("POST", "/login", {
      usuarioId: S.candidato.id, pin: S.pin, dispositivo: navigator.userAgent.slice(0, 60),
    });
    S.token = r.token;
    S.yo = r.usuario;
    sessionStorage.setItem("token", r.token);
    S.pin = ""; S.candidato = null; S.errorLogin = null;
    await arrancarSesion();
  } catch (e) {
    S.errorLogin = e.message;
    S.pin = "";
    pintar();
  }
}

// ── El servidor empuja; el cliente no pregunta ──
function conectar() {
  const ws = new WebSocket(`ws://${location.host}?token=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  ws.onopen = () => { S.conectado = true; pintar(); };
  ws.onclose = () => {
    S.conectado = false; pintar();
    if (S.token) setTimeout(conectar, 2000);   // el local puede reiniciarse; el POS reintenta solo
  };
  ws.onmessage = async (m) => {
    const { evento, datos } = JSON.parse(m.data);
    if (datos) S.estado = datos;

    // La cocina no debería tener que recargar nada nunca.
    if (S.vista === "cocina" && String(evento).startsWith("cocina")) {
      try { S.cocina = await api("GET", "/cocina"); } catch {}
    }
    if (S.ordenId && !orden()) {
      // Otro dispositivo la cobró o la anuló mientras la teníamos abierta.
      S.ordenId = null;
      if (S.vista === "pedido" || S.vista === "pago") S.vista = "salon";
    }
    pintar();
  };
}

// ───────────────────────────── Vistas

function vSalon(v) {
  const bar = el("div", "bar");
  const t = el("div");
  t.appendChild(el("div", "bar-t", "Salón"));
  t.appendChild(el("div", "bar-s", S.turno?.abierto ? `Turno de ${S.turno.usuario}` : "Sin turno abierto"));
  bar.appendChild(t);
  bar.appendChild(el("div", "grow"));
  const ocup = S.estado.ordenes.filter((o) => o.mesaId).length;
  bar.appendChild(el("span", "chip", `${ocup} de ${S.estado.mesas.length} ocupadas`));
  v.appendChild(bar);

  const g = el("div", "mesas");
  for (const m of S.estado.mesas) {
    const o = S.estado.ordenes.find((x) => x.mesaId === m.id);
    const clase = !o ? "libre" : o.estado === "pide_cuenta" ? "cuenta" : "ocupada";
    const b = el("button", "mesa " + clase);
    b.type = "button";
    b.appendChild(el("div", "mesa-n", m.numero));
    const st = el("div", "mesa-st");
    if (o) {
      st.appendChild(el("span", "dot"));
      st.appendChild(el("span", null,
        (o.estado === "pide_cuenta" ? "Pide la cuenta" : "Comiendo") + " · " + mins(o.abiertaEn) + " min"));
    } else st.appendChild(el("span", null, "Libre"));
    b.appendChild(st);
    if (o) b.appendChild(el("div", "mesa-m", crc(o.total)));
    b.onclick = () => accion(async () => {
      let id = o?.id;
      if (!id) ({ id } = await api("POST", "/ordenes", { mesa: m.numero }));
      S.ordenId = id; S.vista = "pedido"; pintar();
    });
    g.appendChild(b);
  }
  v.appendChild(g);
}

function vExpress(v) {
  const abiertas = S.estado.ordenes.filter((o) => !o.mesaId);
  const bar = el("div", "bar");
  const t = el("div");
  t.appendChild(el("div", "bar-t", "Express"));
  t.appendChild(el("div", "bar-s", "Para llevar · no ocupa mesa ni lleva servicio 10%"));
  bar.appendChild(t);
  bar.appendChild(el("div", "grow"));
  bar.appendChild(el("span", "chip", abiertas.length + (abiertas.length === 1 ? " abierta" : " abiertas")));
  v.appendChild(bar);

  const g = el("div", "exps");
  const nb = el("button", "exp exp-nuevo");
  nb.type = "button";
  nb.appendChild(el("div", null, "Nueva orden"));
  nb.appendChild(el("div", "dest-s", "Para llevar"));
  nb.onclick = () => accion(async () => {
    const { id } = await api("POST", "/ordenes", {});
    S.ordenId = id; S.vista = "pedido"; pintar();
  });
  g.appendChild(nb);

  for (const o of abiertas) {
    const b = el("button", "exp");
    b.type = "button";
    b.appendChild(el("div", null, `Express #${o.id}`));
    b.appendChild(el("div", "dest-s", `${o.lineas.length} líneas · ${mins(o.abiertaEn)} min`));
    b.appendChild(el("div", "mesa-m", crc(o.total)));
    b.onclick = () => { S.ordenId = o.id; S.vista = "pedido"; pintar(); };
    g.appendChild(b);
  }
  v.appendChild(g);
}

function vPedido(v) {
  const o = orden();
  if (!o) return vacio(v, "No hay ninguna orden abierta",
    "Elegí una mesa en el salón o arrancá una express.", "Ir al salón", () => { S.vista = "salon"; pintar(); });

  const bar = el("div", "bar");
  const back = el("button", "iconbtn iconbtn-back", "‹");
  back.type = "button";
  back.setAttribute("aria-label", "Volver");
  back.onclick = () => { S.vista = o.mesaId ? "salon" : "express"; S.panel = null; pintar(); };
  bar.appendChild(back);
  const t = el("div");
  t.appendChild(el("div", "bar-t", o.mesa ? `Mesa ${o.mesa}` : `Express #${o.id}`));
  t.appendChild(el("div", "bar-s", (o.mesaId ? "Servicio a mesa" : "Para llevar") + ` · ${mins(o.abiertaEn)} min`));
  bar.appendChild(t);
  bar.appendChild(el("div", "grow"));
  if (o.estado === "pide_cuenta") bar.appendChild(el("span", "chip chip-amber", "Pide la cuenta"));
  const mas = el("button", "iconbtn", "⋯");
  mas.type = "button";
  mas.setAttribute("aria-label", "Opciones de la orden");
  mas.onclick = () => { S.panel = "opciones"; pintar(); };
  bar.appendChild(mas);
  v.appendChild(bar);

  if (S.panel) return pintarPanel(v, o);

  const sp = el("div", "split" + (S.verComanda ? " ver" : ""));
  const izq = el("div", "izq");
  const cats = [...new Set(S.menu.map((p) => p.categoria))];
  if (!cats.includes(S.cat)) S.cat = cats[0];

  const cb = el("div", "cats");
  for (const c of cats) {
    const b = el("button", "cat", c);
    b.type = "button";
    b.setAttribute("aria-pressed", c === S.cat ? "true" : "false");
    b.onclick = () => { S.cat = c; pintar(); };
    cb.appendChild(b);
  }
  izq.appendChild(cb);

  const tb = el("div", "tiles");
  for (const p of S.menu.filter((x) => x.categoria === S.cat)) {
    const b = el("button", "tile");
    b.type = "button";
    b.appendChild(el("span", null, p.nombre));
    b.appendChild(el("span", "tile-p", crc(p.precio)));
    b.onclick = () => accion(() => api("POST", "/lineas", { ordenId: o.id, productoId: p.id, cantidad: 1 }));
    tb.appendChild(b);
  }
  izq.appendChild(tb);

  const mb = el("button", "mbar");
  mb.type = "button";
  mb.disabled = !o.lineas.length;
  const qty = o.lineas.reduce((a, l) => a + l.cantidad, 0);
  mb.appendChild(el("span", null, qty ? `${qty} ítems` : "Comanda vacía"));
  mb.appendChild(el("div", "grow"));
  mb.appendChild(el("span", "n", crc(o.total)));
  mb.onclick = () => { S.verComanda = true; pintar(); };
  izq.appendChild(mb);
  sp.appendChild(izq);

  const der = el("div", "der");
  const lb = el("div", "lineas");
  if (!o.lineas.length) lb.appendChild(el("p", "vacio", "Tocá un plato para empezar."));
  for (const l of o.lineas) {
    const d = el("div", "ln");
    d.appendChild(el("span", "ln-q", String(l.cantidad)));
    d.appendChild(el("span", "ln-d", l.nombre));
    d.appendChild(el("span", "ln-m", crc(l.precio * l.cantidad)));
    const x = el("button", "iconbtn", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Quitar uno de " + l.nombre);
    const prod = S.menu.find((p) => p.nombre === l.nombre);
    x.onclick = () => accion(() => api("POST", "/lineas/quitar", { ordenId: o.id, productoId: prod.id }));
    d.appendChild(x);
    lb.appendChild(d);
  }
  der.appendChild(lb);

  const tot = el("div", "tot");
  tot.appendChild(el("div", "grande")).append(
    Object.assign(el("span", null, "Total")), Object.assign(el("span", "v", crc(o.total))));

  // Mandar a cocina es decisión del salonero: si cada plato saliera al
  // agregarlo, la cocina arrancaría el primero mientras él sigue tomando.
  const sinMandar = o.lineas.length - (o.enCocina ?? 0);
  const cocinar = el("button", "ghost", sinMandar > 0
    ? `Mandar ${sinMandar} a cocina` : "Todo mandado a cocina");
  cocinar.type = "button";
  cocinar.style.width = "100%";
  cocinar.style.marginTop = "10px";
  cocinar.disabled = sinMandar <= 0;
  cocinar.onclick = () => accion(async () => {
    const r = await api("POST", "/ordenes/cocina", { ordenId: o.id });
    avisar(`${r.enviadas} a cocina`);
  });
  tot.appendChild(cocinar);

  const esSalonero = S.yo.rol === "salonero";
  const cta = el("button", "cta cta-ancho",
    esSalonero ? (o.estado === "pide_cuenta" ? "Cancelar la petición" : "Pasar a caja") : "Cobrar");
  cta.type = "button";
  cta.disabled = !o.lineas.length;
  cta.onclick = () => {
    if (!esSalonero) { S.vista = "pago"; pintar(); return; }
    accion(async () => {
      const { estado } = await api("POST", "/ordenes/cuenta", { ordenId: o.id });
      if (estado === "pide_cuenta") { S.vista = o.mesaId ? "salon" : "express"; avisar("Pasó a caja"); }
    });
  };
  tot.appendChild(cta);
  der.appendChild(tot);
  sp.appendChild(der);
  v.appendChild(sp);
}

function pintarPanel(v, o) {
  const p = el("div", "panel");
  if (S.panel === "opciones") {
    p.appendChild(el("h3", null, "Opciones de la orden"));
    p.appendChild(el("p", "vacio", "Todavía no hay comprobante: nada de esto llega a Hacienda."));
    const l = el("div", "opts");
    const mv = el("button", "opt");
    mv.type = "button";
    mv.appendChild(el("span", "lab", o.mesaId ? "Mover a otra mesa" : "Pasar a una mesa"));
    mv.appendChild(el("span", "sub", o.mesaId ? "Cambiar o juntar cuentas" : "Se le cobra el servicio 10%"));
    mv.onclick = () => { S.panel = "mover"; pintar(); };
    l.appendChild(mv);
    const an = el("button", "opt opt-mal");
    an.type = "button";
    an.appendChild(el("span", "lab", "Anular la orden"));
    an.appendChild(el("span", "sub", o.lineas.length ? `${o.lineas.length} líneas · pide motivo` : "Está vacía"));
    an.onclick = () => { S.panel = "anular"; S.motivo = null; pintar(); };
    l.appendChild(an);
    p.appendChild(l);
  } else if (S.panel === "mover") {
    p.appendChild(el("h3", null, "¿A dónde pasa?"));
    const g = el("div", "dests");
    for (const m of S.estado.mesas) {
      if (m.id === o.mesaId) continue;
      const otra = S.estado.ordenes.find((x) => x.mesaId === m.id);
      const b = el("button", "dest");
      b.type = "button";
      b.appendChild(el("div", null, "Mesa " + m.numero));
      b.appendChild(el("div", "dest-s", otra ? `Ocupada · juntar ${crc(otra.total)}` : "Libre"));
      b.onclick = () => accion(async () => {
        const r = await api("POST", "/ordenes/mover", { ordenId: o.id, mesa: m.numero });
        S.ordenId = r.ordenId; S.panel = null;
        avisar(r.juntada ? `Se juntó con la mesa ${m.numero}` : `Movida a la mesa ${m.numero}`);
      });
      g.appendChild(b);
    }
    if (o.mesaId) {
      const b = el("button", "dest");
      b.type = "button";
      b.appendChild(el("div", null, "Express"));
      b.appendChild(el("div", "dest-s", "Quita el servicio 10%"));
      b.onclick = () => accion(async () => {
        await api("POST", "/ordenes/mover", { ordenId: o.id, mesa: null });
        S.panel = null; avisar("Pasó a para llevar");
      });
      g.appendChild(b);
    }
    p.appendChild(g);
  } else if (S.panel === "anular") {
    p.appendChild(el("h3", null, "Anular la orden"));
    if (o.lineas.length) {
      p.appendChild(el("p", "vacio", `Lleva ${crc(o.total)}. Queda el registro de quién anuló y por qué.`));
      const m = el("div", "motivos");
      for (const t of MOTIVOS) {
        const b = el("button", "motivo", t);
        b.type = "button";
        b.setAttribute("aria-pressed", S.motivo === t ? "true" : "false");
        b.onclick = () => { S.motivo = t; pintar(); };
        m.appendChild(b);
      }
      p.appendChild(m);
    }
    const go = el("button", "cta cta-mal", "Anular");
    go.type = "button";
    go.disabled = o.lineas.length > 0 && !S.motivo;
    go.style.alignSelf = "flex-start";
    go.onclick = () => accion(async () => {
      await api("POST", "/ordenes/anular", { ordenId: o.id, motivo: S.motivo });
      S.ordenId = null; S.panel = null; S.vista = o.mesaId ? "salon" : "express";
      avisar("Orden anulada");
    });
    p.appendChild(go);
  }
  const volver = el("button", "ghost", "Volver");
  volver.type = "button";
  volver.style.alignSelf = "flex-start";
  volver.onclick = () => { S.panel = S.panel === "opciones" ? null : "opciones"; pintar(); };
  p.appendChild(volver);
  v.appendChild(p);
}

function vPago(v) {
  const o = orden();
  if (!o || !o.lineas.length) return vacio(v, "Nada que cobrar",
    "Abrí una orden y cargale productos.", "Ir al salón", () => { S.vista = "salon"; pintar(); });

  const bar = el("div", "bar");
  const back = el("button", "iconbtn iconbtn-back", "‹");
  back.type = "button";
  back.onclick = () => { S.vista = "pedido"; S.panel = null; pintar(); };
  bar.appendChild(back);
  bar.appendChild(el("div", "bar-t", `Cobrar ${o.mesa ? "mesa " + o.mesa : "express #" + o.id}`));
  v.appendChild(bar);

  if (S.panel === "receptor") return vReceptor(v);

  const c = el("div", "cobro");
  const top = el("div", "cobro-top");
  top.appendChild(el("span", "bar-s", "Total a cobrar"));
  top.appendChild(el("span", "v", crc(o.total)));
  c.appendChild(top);

  const pg = el("div", "pagos");
  for (const m of ["Efectivo", "Tarjeta", "SINPE Móvil"]) {
    const b = el("button", "pago", m);
    b.type = "button";
    b.setAttribute("aria-pressed", S.pago === m ? "true" : "false");
    b.onclick = () => { S.pago = m; pintar(); };
    pg.appendChild(b);
  }
  c.appendChild(pg);

  const fb = el("button", "ghost", S.receptor ? "Quitar la factura" : "Necesita factura");
  fb.type = "button";
  fb.style.margin = "0 auto";
  fb.onclick = () => {
    if (S.receptor) { S.receptor = null; pintar(); }
    else { S.panel = "receptor"; S.busca = ""; S.hallado = null; S.manual = false; pintar(); }
  };
  c.appendChild(fb);

  if (S.receptor) {
    const s = el("div", "resumen");
    s.appendChild(el("div", "nm", S.receptor.nombre));
    s.appendChild(el("div", "dest-s",
      `${S.receptor.id} · ${S.receptor.actCod ? "act. " + S.receptor.actCod : "consumidor final"}`));
    s.appendChild(el("div", "dest-s", S.receptor.correo));
    const ed = el("button", "ghost", "Cambiar");
    ed.type = "button";
    ed.onclick = () => { S.panel = "receptor"; pintar(); };
    s.appendChild(ed);
    c.appendChild(s);
  }

  const go = el("button", "cta", S.receptor ? "Cobrar y enviar factura" : "Cobrar y entregar tiquete");
  go.type = "button";
  go.style.maxWidth = "360px";
  go.style.margin = "0 auto";
  go.onclick = () => accion(async () => {
    go.disabled = true;
    go.textContent = "Firmando…";
    const r = await api("POST", "/cobrar", {
      ordenId: o.id, medioPago: S.pago, receptor: S.receptor ?? null,
    });
    S.ordenId = null; S.receptor = null; S.vista = "salon";
    avisar(`${r.consecutivo} · ${crc(r.montos.total)} · ${r.impresion?.ok ? "impreso" : "sin impresora"}`);
  });
  c.appendChild(go);
  v.appendChild(c);
}

// ── Datos del receptor: la cédula trae lo demás del padrón de Hacienda ──
function vReceptor(v) {
  const p = el("div", "panel");
  p.appendChild(el("h3", null, "Datos para la factura"));
  p.appendChild(el("p", "vacio",
    "Cualquier persona puede pedir factura, tenga o no actividad económica."));

  if (S.frecuentes?.length) {
    const w = el("div");
    w.appendChild(el("div", "dest-s", "Clientes frecuentes"));
    const g = el("div", "motivos");
    g.style.marginTop = "6px";
    for (const c of S.frecuentes) {
      const b = el("button", "motivo", c.nombre);
      b.type = "button";
      b.onclick = () => { S.receptor = { ...c, id: c.identificacion }; S.panel = null; pintar(); };
      g.appendChild(b);
    }
    w.appendChild(g);
    p.appendChild(w);
  }

  if (!S.manual) {
    const fila = el("div", "busca");
    const inp = el("input");
    inp.type = "text"; inp.inputMode = "numeric"; inp.maxLength = 12;
    inp.placeholder = "Cédula del cliente";
    inp.value = S.busca ?? "";
    inp.setAttribute("aria-label", "Cédula del cliente");
    const bb = el("button", "cta", "Buscar");
    bb.type = "button";
    bb.onclick = () => accion(async () => {
      S.busca = inp.value.replace(/\D/g, "");
      bb.disabled = true; bb.textContent = "Consultando…";
      S.hallado = await api("GET", "/padron?cedula=" + S.busca);
      pintar();
    });
    inp.onkeydown = (e) => { if (e.key === "Enter") bb.onclick(); };
    fila.appendChild(inp); fila.appendChild(bb);
    p.appendChild(fila);

    if (S.hallado?.noEncontrado) {
      p.appendChild(el("p", "err-login",
        `No aparece en el padrón (${S.hallado.origen}). Puede ser extranjero o no contribuyente.`));
      const mb = el("button", "ghost", "Ingresar los datos a mano");
      mb.type = "button"; mb.style.alignSelf = "flex-start";
      mb.onclick = () => { S.manual = true; pintar(); };
      p.appendChild(mb);
    } else if (S.hallado) {
      p.appendChild(fichaPadron(S.hallado));
    }
  } else {
    p.appendChild(formManual());
  }

  const volver = el("button", "ghost", "Cancelar");
  volver.type = "button"; volver.style.alignSelf = "flex-start";
  volver.onclick = () => { S.panel = null; pintar(); };
  p.appendChild(volver);
  v.appendChild(p);
}

function fichaPadron(h) {
  const box = el("div");
  box.style.display = "flex"; box.style.flexDirection = "column"; box.style.gap = "14px";

  const f = el("div", "resumen");
  f.appendChild(el("div", "nm", h.nombre));
  f.appendChild(el("div", "dest-s", `${h.identificacion} · según ${h.origen}`));
  box.appendChild(f);

  const sinAct = !h.actividades?.length;
  let sel = h.actividades?.length === 1 ? h.actividades[0] : null;

  if (sinAct) {
    box.appendChild(el("p", "vacio",
      "Sin actividad económica registrada: se factura como consumidor final."));
  } else {
    box.appendChild(el("div", "dest-s",
      h.actividades.length === 1 ? "Actividad económica" : "Elegí la actividad económica"));
    const l = el("div", "opts");
    const btns = [];
    for (const a of h.actividades) {
      const b = el("button", "opt");
      b.type = "button";
      b.appendChild(el("span", "lab", a.descripcion));
      b.appendChild(el("span", "sub", a.codigo));
      b.setAttribute("aria-pressed", sel === a ? "true" : "false");
      b.onclick = () => {
        sel = a;
        btns.forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        err.textContent = "";
      };
      btns.push(b); l.appendChild(b);
    }
    box.appendChild(l);
  }

  const inp = el("input");
  inp.type = "email"; inp.placeholder = "Correo para enviarle la factura";
  inp.setAttribute("aria-label", "Correo del cliente");
  box.appendChild(inp);
  box.appendChild(el("p", "vacio",
    "Obligatorio: hay que entregarle el XML firmado y la respuesta de Hacienda."));

  const err = el("p", "err-login", "");
  box.appendChild(err);

  const ok = el("button", "cta", "Usar estos datos");
  ok.type = "button"; ok.style.alignSelf = "flex-start";
  ok.onclick = () => {
    const correo = inp.value.trim();
    if (!sinAct && !sel) return (err.textContent = "Elegí la actividad económica.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) return (err.textContent = "Escribí un correo válido.");
    S.receptor = {
      tipo: h.tipo ?? "01", id: h.identificacion, nombre: h.nombre,
      actCod: sel?.codigo ?? null, correo,
    };
    S.panel = null; pintar();
  };
  box.appendChild(ok);
  return box;
}

function formManual() {
  const box = el("div");
  box.style.display = "flex"; box.style.flexDirection = "column"; box.style.gap = "10px";
  const campo = (ph, tipo = "text") => {
    const i = el("input"); i.type = tipo; i.placeholder = ph;
    i.setAttribute("aria-label", ph); box.appendChild(i); return i;
  };
  const sel = el("select");
  for (const [v, t] of [["05", "Extranjero no domiciliado"], ["06", "No contribuyente"],
                        ["01", "Cédula física"], ["02", "Cédula jurídica"], ["03", "DIMEX"]]) {
    const o = el("option", null, t); o.value = v; sel.appendChild(o);
  }
  box.appendChild(sel);
  const id = campo("Identificación"); id.value = S.busca ?? "";
  const nom = campo("Nombre o razón social");
  const act = campo("Código de actividad (si tiene)");
  const correo = campo("Correo", "email");
  const err = el("p", "err-login", "");
  box.appendChild(err);

  const ok = el("button", "cta", "Usar estos datos");
  ok.type = "button"; ok.style.alignSelf = "flex-start";
  ok.onclick = () => {
    const a = act.value.trim();
    if (!id.value.trim()) return (err.textContent = "Escribí la identificación.");
    if (!nom.value.trim()) return (err.textContent = "Escribí el nombre.");
    if (a && !/^\d{6}$/.test(a)) return (err.textContent = "La actividad lleva 6 dígitos, o dejala vacía.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo.value.trim()))
      return (err.textContent = "Escribí un correo válido.");
    S.receptor = { tipo: sel.value, id: id.value.trim(), nombre: nom.value.trim(),
                   actCod: a || null, correo: correo.value.trim() };
    S.panel = null; pintar();
  };
  box.appendChild(ok);

  const volver = el("button", "ghost", "Volver a buscar por cédula");
  volver.type = "button"; volver.style.alignSelf = "flex-start";
  volver.onclick = () => { S.manual = false; S.hallado = null; pintar(); };
  box.appendChild(volver);
  return box;
}

function vComprobantes(v) {
  const bar = el("div", "bar");
  bar.appendChild(el("div", "bar-t", "Comprobantes"));
  bar.appendChild(el("div", "grow"));
  bar.appendChild(el("span", "chip", `${S.estado.cola} en cola`));
  if (S.estado.cola > 0) {
    const tb = el("button", "ghost", "Transmitir ahora");
    tb.type = "button";
    tb.onclick = () => accion(async () => {
      const r = await api("POST", "/transmitir", {});
      avisar(r.detalle, r.enviados === 0);
      S.comprobantes = await api("GET", "/comprobantes"); pintar();
    });
    bar.appendChild(tb);
  }
  v.appendChild(bar);

  const w = el("div", "wrap-tabla");
  const t = el("table", "tabla");
  t.innerHTML = "<thead><tr><th>Consecutivo</th><th>Tipo</th><th>Título</th>" +
    "<th style='text-align:right'>Total</th><th>Hacienda</th><th></th></tr></thead>";
  const tb = el("tbody");

  if (S.anulando) {
    const p = el("div", "panel");
    p.appendChild(el("h3", null, `Anular ${S.anulando.consecutivo}`));
    p.appendChild(el("p", "vacio",
      "El comprobante no se borra ni se edita: se emite una nota de crédito que lo revierte. " +
      "Eso sí es un documento fiscal y va a Hacienda."));
    const m = el("div", "motivos");
    let motivo = null;
    const opciones = ["Devolución del cliente", "Error en el monto", "Error en los datos del cliente", "Venta anulada"];
    const btns = [];
    for (const o of opciones) {
      const b = el("button", "motivo", o);
      b.type = "button";
      b.onclick = () => {
        motivo = o;
        btns.forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
      };
      btns.push(b); m.appendChild(b);
    }
    p.appendChild(m);
    const acc = el("div", "acts");
    acc.style.justifyContent = "flex-start";
    const go = el("button", "cta cta-mal", "Emitir nota de crédito");
    go.type = "button";
    go.onclick = () => accion(async () => {
      if (!motivo) { avisar("Elegí un motivo", true); return; }
      const r = await api("POST", "/notas-credito", { comprobanteId: S.anulando.id, motivo });
      S.anulando = null;
      S.comprobantes = await api("GET", "/comprobantes");
      avisar(`Nota de crédito ${r.consecutivo} · anula ${r.anula}`);
    });
    const ca = el("button", "ghost", "Cancelar");
    ca.type = "button";
    ca.onclick = () => { S.anulando = null; pintar(); };
    acc.appendChild(go); acc.appendChild(ca);
    p.appendChild(acc);
    v.appendChild(p);
  }
  for (const c of S.comprobantes) {
    const tr = el("tr");
    tr.appendChild(el("td", "c", c.consecutivo));
    tr.appendChild(el("td", null, c.tipo === "FE" ? "Factura" : "Tiquete"));
    tr.appendChild(el("td", null, c.titulo));
    tr.appendChild(el("td", "n", crc(c.total)));
    const e = el("td");
    const clase = c.estado_hacienda === "aceptado" ? "est-ok"
      : c.estado_hacienda === "rechazado" ? "est-mal" : "est-espera";
    e.appendChild(el("span", "est " + clase, c.estado_hacienda));
    tr.appendChild(e);

    // Anular una venta ya cobrada: nota de crédito, nunca borrar.
    const acc = el("td");
    if (c.tipo !== "NC" && !/Anulado por NC/.test(c.ultimo_error ?? "")) {
      const nb = el("button", "mini", "Anular");
      nb.type = "button";
      nb.onclick = () => { S.anulando = c; pintar(); };
      acc.appendChild(nb);
    } else if (/Anulado por NC/.test(c.ultimo_error ?? "")) {
      acc.appendChild(el("span", "dest-s", "anulado"));
    }
    tr.appendChild(acc);
    tb.appendChild(tr);
  }
  if (!S.comprobantes.length) {
    const tr = el("tr");
    const td = el("td", "vacio", "Todavía no se ha cobrado nada.");
    td.colSpan = 5;
    tr.appendChild(td); tb.appendChild(tr);
  }
  t.appendChild(tb); w.appendChild(t); v.appendChild(w);
}

function vCierre(v) {
  const bar = el("div", "bar");
  bar.appendChild(el("div", "bar-t", "Cierre de caja"));
  if (S.turno?.abierto) {
    bar.appendChild(el("div", "grow"));
    bar.appendChild(el("span", "chip", `Turno de ${S.turno.usuario}`));
  }
  v.appendChild(bar);

  if (!S.turno?.abierto) {
    return vacio(v, "La caja está cerrada",
      "Abrí el turno con el fondo inicial en efectivo para volver a registrar ventas.",
      "Abrir caja con ₡50.000", () => accion(async () => {
        await api("POST", "/turno/abrir", { apertura: 50000 });
        S.turno = await api("GET", "/turno");
        avisar("Caja abierta"); pintar();
      }));
  }

  const k = el("div", "kpis");
  k.appendChild(kpi("Vendido en el turno", crc(S.turno.vendido)));
  k.appendChild(kpi("Efectivo esperado", crc(S.turno.esperado), "apertura " + crc(S.turno.apertura)));
  v.appendChild(k);

  const w = el("div", "wrap-tabla");
  const t = el("table", "tabla");
  t.innerHTML = "<thead><tr><th>Medio de pago</th><th>Comprobantes</th><th style='text-align:right'>Total</th></tr></thead>";
  const tb = el("tbody");
  for (const m of S.turno.porMedio) {
    const tr = el("tr");
    tr.appendChild(el("td", null, m.medio));
    tr.appendChild(el("td", null, String(m.n)));
    tr.appendChild(el("td", "n", crc(m.total)));
    tb.appendChild(tr);
  }
  t.appendChild(tb); w.appendChild(t); v.appendChild(w);

  // Arqueo: lo que el sistema dice contra lo que el cajero contó.
  const arq = el("div", "panel");
  arq.appendChild(el("div", "dest-s", "Arqueo"));
  const inp = el("input");
  inp.type = "number"; inp.placeholder = "Efectivo contado a mano";
  inp.setAttribute("aria-label", "Efectivo contado");
  arq.appendChild(inp);
  const dif = el("p", "vacio", "Anotá lo que contaste para ver la diferencia.");
  arq.appendChild(dif);
  inp.oninput = () => {
    const d = Number(inp.value);
    if (!inp.value.length || isNaN(d)) { dif.textContent = "Anotá lo que contaste para ver la diferencia."; dif.style.color = ""; return; }
    const x = d - S.turno.esperado;
    dif.textContent = x === 0 ? "Cuadra exacto" : (x > 0 ? "Sobra " : "Falta ") + crc(Math.abs(x));
    dif.style.color = x === 0 ? "var(--jade)" : "var(--clay)";
  };
  const cerrar = el("button", "cta", "Cerrar la caja");
  cerrar.type = "button"; cerrar.style.alignSelf = "flex-start";
  cerrar.onclick = () => accion(async () => {
    const r = await api("POST", "/turno/cerrar", { declarado: Number(inp.value) });
    S.turno = await api("GET", "/turno");
    avisar(`Caja cerrada · ${r.diferencia === 0 ? "cuadró exacto"
      : (r.diferencia > 0 ? "sobró " : "faltó ") + crc(Math.abs(r.diferencia))}`,
      r.diferencia !== 0);
  });
  arq.appendChild(cerrar);
  v.appendChild(arq);
}

function vReportes(v) {
  const bar = el("div", "bar");
  bar.appendChild(el("div", "bar-t", "Reportes"));
  v.appendChild(bar);
  const r = S.reportes;
  if (!r) return vacio(v, "Sin datos todavía", "Cobrá algo para ver los reportes.");
  const k = el("div", "kpis");
  k.appendChild(kpi("Facturado", crc(r.facturado), `${r.comprobantes} comprobantes`));
  k.appendChild(kpi("Ticket promedio", crc(r.promedio)));
  k.appendChild(kpi("IVA repercutido", crc(r.iva)));
  k.appendChild(kpi("Servicio 10%", crc(r.servicio)));
  v.appendChild(k);

  const w = el("div", "wrap-tabla");
  const t = el("table", "tabla");
  t.innerHTML = "<thead><tr><th>Tarifa</th><th style='text-align:right'>Base</th><th style='text-align:right'>IVA</th></tr></thead>";
  const tb = el("tbody");
  for (const x of r.porTarifa) {
    const tr = el("tr");
    tr.appendChild(el("td", null, x.tarifa === 0 ? "Exento" : x.tarifa + "%"));
    tr.appendChild(el("td", "n", crc(x.base)));
    tr.appendChild(el("td", "n", crc(x.impuesto)));
    tb.appendChild(tr);
  }
  t.appendChild(tb); w.appendChild(t); v.appendChild(w);
}

// ── Cocina: lo que hay que preparar, lo más viejo primero ──
function vCocina(v) {
  const bar = el("div", "bar");
  bar.appendChild(el("div", "bar-t", "Cocina"));
  bar.appendChild(el("div", "grow"));
  const n = S.cocina.reduce((a, o) => a + o.lineas.length, 0);
  bar.appendChild(el("span", "chip", n ? `${n} por preparar` : "Todo al día"));
  v.appendChild(bar);

  if (!S.cocina.length) {
    return vacio(v, "Nada pendiente", "Cuando el salonero mande una comanda, aparece acá.");
  }

  const g = el("div", "cocina");
  for (const o of S.cocina) {
    const min = Math.max(0, Math.round((Date.now() - o.desde) / 60000));
    // El color no decora: dice cuál hay que sacar ya.
    const urgencia = min >= 15 ? "tarde" : min >= 8 ? "apura" : "fresca";
    const c = el("div", "comanda " + urgencia);

    const cab = el("div", "comanda-cab");
    cab.appendChild(el("span", "comanda-t", o.titulo));
    cab.appendChild(el("div", "grow"));
    cab.appendChild(el("span", "comanda-min", `${min} min`));
    c.appendChild(cab);

    if (!o.esMesa) c.appendChild(el("div", "comanda-tag", "PARA LLEVAR"));

    const lista = el("div", "comanda-lineas");
    for (const l of o.lineas) {
      const b = el("button", "plato");
      b.type = "button";
      b.appendChild(el("span", "plato-q", `${l.cantidad}`));
      const d = el("span", "plato-d");
      d.appendChild(el("span", null, l.nombre));
      if (l.notas) d.appendChild(el("span", "plato-nota", l.notas));
      b.appendChild(d);
      b.setAttribute("aria-label", `Marcar listo: ${l.cantidad} ${l.nombre}`);
      b.onclick = () => accion(async () => {
        await api("POST", "/cocina/lista", { lineaId: l.id });
        S.cocina = await api("GET", "/cocina"); pintar();
      });
      lista.appendChild(b);
    }
    c.appendChild(lista);

    const todo = el("button", "cta cta-ancho", "Comanda lista");
    todo.type = "button";
    todo.onclick = () => accion(async () => {
      await api("POST", "/cocina/lista", { ordenId: o.ordenId });
      S.cocina = await api("GET", "/cocina");
      avisar(`${o.titulo} lista`); pintar();
    });
    c.appendChild(todo);
    g.appendChild(c);
  }
  v.appendChild(g);
}

// ── Menú: el CABYS se busca, no se escribe ──
function vMenu(v) {
  const bar = el("div", "bar");
  bar.appendChild(el("div", "bar-t", "Menú"));
  bar.appendChild(el("div", "grow"));
  const nb = el("button", "cta", "Agregar producto");
  nb.type = "button";
  nb.onclick = () => { S.editando = { nuevo: true }; pintar(); };
  bar.appendChild(nb);
  v.appendChild(bar);

  if (S.editando) v.appendChild(formProducto());

  const w = el("div", "wrap-tabla");
  const t = el("table", "tabla");
  t.innerHTML = "<thead><tr><th>Producto</th><th>Categoría</th><th>CABYS</th><th>IVA</th>" +
    "<th style='text-align:right'>Precio</th><th></th></tr></thead>";
  const tb = el("tbody");
  for (const p of S.productos) {
    const tr = el("tr");
    if (!p.activo) tr.style.opacity = ".55";
    tr.appendChild(el("td", null, p.nombre + (p.activo ? "" : "  (inactivo)")));
    tr.appendChild(el("td", null, p.categoria));
    tr.appendChild(el("td", "c", p.cabys));
    const iva = el("td", null, (p.tarifa === 0 ? "Exento" : p.tarifa + "%") +
      (p.tarifa_ajustada ? " ·ajustado" : ""));
    if (p.tarifa_ajustada) iva.style.color = "var(--amber)";
    tr.appendChild(iva);
    tr.appendChild(el("td", "n", crc(p.precio)));
    const acc = el("td");
    const box = el("div", "acts");
    const ed = el("button", "mini", "Editar");
    ed.type = "button";
    ed.onclick = () => { S.editando = { ...p }; pintar(); };
    const tg = el("button", "mini", p.activo ? "Desactivar" : "Activar");
    tg.type = "button";
    tg.onclick = () => accion(async () => {
      await api("POST", "/productos/activo", { id: p.id, activo: !p.activo });
      S.productos = await api("GET", "/productos"); S.menu = await api("GET", "/menu"); pintar();
    });
    box.appendChild(ed); box.appendChild(tg);
    acc.appendChild(box); tr.appendChild(acc);
    tb.appendChild(tr);
  }
  t.appendChild(tb); w.appendChild(t); v.appendChild(w);
}

function formProducto() {
  const p = S.editando;
  const box = el("div", "form");
  box.appendChild(el("h3", null, p.nuevo ? "Nuevo producto" : "Editando " + p.nombre));

  const campo = (ph, val = "", tipo = "text") => {
    const i = el("input"); i.type = tipo; i.placeholder = ph; i.value = val ?? "";
    i.setAttribute("aria-label", ph); box.appendChild(i); return i;
  };
  const nom = campo("Nombre", p.nombre);
  const cat = campo("Categoría", p.categoria);
  const pre = campo("Precio en colones", p.precio ?? "", "number");

  box.appendChild(el("div", "dest-s", "Clasificación CABYS"));
  const busca = el("div", "busca");
  const bi = el("input");
  bi.type = "text"; bi.placeholder = "Buscá por descripción: arroz, comidas, bebidas…";
  bi.setAttribute("aria-label", "Buscar CABYS");
  const bb = el("button", "cta", "Buscar");
  bb.type = "button";
  busca.appendChild(bi); busca.appendChild(bb);
  box.appendChild(busca);

  const res = el("div", "opts");
  box.appendChild(res);

  let elegido = p.cabys ? { codigo: p.cabys, descripcion: "(ya clasificado)", tarifa: p.tarifa } : null;
  let ajustada = !!p.tarifa_ajustada;
  const sel = el("div");
  box.appendChild(sel);

  function pintarSel() {
    sel.innerHTML = "";
    if (!elegido) {
      sel.appendChild(el("p", "vacio", "Sin clasificar. De este código sale la tarifa de IVA."));
      return;
    }
    const s = el("div", "resumen");
    s.appendChild(el("div", "c", elegido.codigo));
    s.appendChild(el("div", "nm", elegido.descripcion));
    const tf = el("div", "dest-s", ajustada
      ? `IVA ${elegido.tarifa}% · ajustado a mano`
      : `IVA ${elegido.tarifa}% · según el catálogo`);
    if (ajustada) tf.style.color = "var(--amber)";
    s.appendChild(tf);

    const aj = el("select");
    for (const t of [13, 4, 2, 1, 0]) {
      const o = el("option", null, t === 0 ? "Exento" : t + "%");
      o.value = String(t);
      if (t === elegido.tarifa) o.selected = true;
      aj.appendChild(o);
    }
    aj.onchange = () => {
      const nueva = Number(aj.value);
      ajustada = nueva !== (elegido.tarifaCatalogo ?? elegido.tarifa);
      elegido = { ...elegido, tarifa: nueva };
      pintarSel();
    };
    s.appendChild(aj);
    s.appendChild(el("div", "dest-s",
      "La tarifa del catálogo es de referencia: la responsabilidad de que sea la correcta es del contribuyente."));
    sel.appendChild(s);
  }
  pintarSel();

  bb.onclick = () => accion(async () => {
    bb.disabled = true; bb.textContent = "Buscando…";
    const hits = await api("GET", "/cabys?q=" + encodeURIComponent(bi.value.trim()));
    bb.disabled = false; bb.textContent = "Buscar";
    res.innerHTML = "";
    if (!hits.length) { res.appendChild(el("p", "vacio", "Nada en el catálogo con eso.")); return; }
    for (const h of hits) {
      const b = el("button", "opt");
      b.type = "button";
      b.appendChild(el("span", "lab", h.descripcion));
      b.appendChild(el("span", "sub", `${h.codigo} · IVA ${h.tarifa}% · ${h.origen}`));
      b.onclick = () => {
        elegido = { ...h, tarifaCatalogo: h.tarifa };
        ajustada = false;
        res.innerHTML = "";
        pintarSel();
      };
      res.appendChild(b);
    }
  });

  const err = el("p", "err-login", "");
  box.appendChild(err);
  const acc = el("div", "acts");
  acc.style.justifyContent = "flex-start";
  const gu = el("button", "cta", "Guardar");
  gu.type = "button";
  gu.onclick = () => accion(async () => {
    if (!elegido) { err.textContent = "Elegí la clasificación CABYS."; return; }
    await api("POST", "/productos", {
      id: p.nuevo ? null : p.id, nombre: nom.value, categoria: cat.value,
      precio: Number(pre.value), cabys: elegido.codigo, tarifa: elegido.tarifa,
      codigoTarifa: elegido.tarifa === 13 ? "08" : elegido.tarifa === 1 ? "02" : "01",
      tarifaAjustada: ajustada,
    });
    S.editando = null;
    S.productos = await api("GET", "/productos");
    S.menu = await api("GET", "/menu");
    pintar();
  });
  const ca = el("button", "ghost", "Cancelar");
  ca.type = "button";
  ca.onclick = () => { S.editando = null; pintar(); };
  acc.appendChild(gu); acc.appendChild(ca);
  box.appendChild(acc);
  return box;
}

// ── Ajustes: certificado y quién puede hacer qué ──
function vAjustes(v) {
  const bar = el("div", "bar");
  bar.appendChild(el("div", "bar-t", "Ajustes"));
  v.appendChild(bar);

  const c = S.certificado;
  if (c) {
    const k = el("div", "kpis");
    const cert = kpi("Certificado digital", `${c.dias} días`, "para vencer");
    if (c.dias < 30) { cert.style.background = "var(--amber-soft)"; cert.style.color = "var(--amber)"; }
    k.appendChild(cert);
    k.appendChild(kpi("Ambiente", c.ambiente, c.ambiente === "sandbox" ? "pruebas, sin validez fiscal" : "producción"));
    k.appendChild(kpi("Llave cargada", c.cargado ? "Sí" : "No", c.cargado ? "" : "falta la de TRIBU-CR"));
    v.appendChild(k);
  }

  const bar2 = el("div", "bar");
  bar2.appendChild(el("div", "bar-s", "Usuarios"));
  bar2.appendChild(el("div", "grow"));
  const nb = el("button", "ghost", "Agregar usuario");
  nb.type = "button";
  nb.onclick = () => { S.editandoUsuario = { nuevo: true, rol: "salonero" }; pintar(); };
  bar2.appendChild(nb);
  v.appendChild(bar2);

  if (S.editandoUsuario) v.appendChild(formUsuario());

  const w = el("div", "wrap-tabla");
  const t = el("table", "tabla");
  t.innerHTML = "<thead><tr><th>Persona</th><th>Rol</th><th>Puede</th><th></th></tr></thead>";
  const tb = el("tbody");
  const PUEDE = {
    salonero: "Tomar pedidos", cocina: "Ver y preparar comandas",
    caja: "Tomar y cobrar", admin: "Todo, incluido precios",
  };
  for (const u of S.usuariosTodos) {
    const tr = el("tr");
    if (!u.activo) tr.style.opacity = ".55";
    tr.appendChild(el("td", null, u.nombre + (u.activo ? "" : "  (inactivo)")));
    tr.appendChild(el("td", null, ROLES.find((r) => r.id === u.rol)?.txt ?? u.rol));
    tr.appendChild(el("td", null, PUEDE[u.rol]));
    const acc = el("td");
    const box = el("div", "acts");
    const ed = el("button", "mini", "Editar");
    ed.type = "button";
    ed.onclick = () => { S.editandoUsuario = { ...u }; pintar(); };
    const tg = el("button", "mini", u.activo ? "Desactivar" : "Activar");
    tg.type = "button";
    tg.onclick = () => accion(async () => {
      await api("POST", "/usuarios/activo", { id: u.id, activo: !u.activo });
      S.usuariosTodos = await api("GET", "/usuarios/todos"); pintar();
    });
    box.appendChild(ed); box.appendChild(tg);
    acc.appendChild(box); tr.appendChild(acc);
    tb.appendChild(tr);
  }
  t.appendChild(tb); w.appendChild(t); v.appendChild(w);
}

function formUsuario() {
  const u = S.editandoUsuario;
  const box = el("div", "form");
  box.appendChild(el("h3", null, u.nuevo ? "Nuevo usuario" : "Editando " + u.nombre));
  const nom = el("input");
  nom.type = "text"; nom.placeholder = "Nombre"; nom.value = u.nombre ?? "";
  nom.setAttribute("aria-label", "Nombre");
  box.appendChild(nom);
  const rol = el("select");
  for (const [v2, t] of [["salonero", "Salonero"], ["caja", "Caja"], ["admin", "Administración"]]) {
    const o = el("option", null, t); o.value = v2;
    if (u.rol === v2) o.selected = true;
    rol.appendChild(o);
  }
  box.appendChild(rol);
  const pin = el("input");
  pin.type = "text"; pin.inputMode = "numeric"; pin.maxLength = 4;
  pin.placeholder = u.nuevo ? "PIN de 4 dígitos" : "PIN nuevo (dejalo vacío para no cambiarlo)";
  pin.setAttribute("aria-label", "PIN");
  box.appendChild(pin);
  const err = el("p", "err-login", "");
  box.appendChild(err);

  const acc = el("div", "acts");
  acc.style.justifyContent = "flex-start";
  const gu = el("button", "cta", "Guardar");
  gu.type = "button";
  gu.onclick = () => accion(async () => {
    try {
      await api("POST", "/usuarios", {
        id: u.nuevo ? null : u.id, nombre: nom.value, rol: rol.value, pin: pin.value || null,
      });
    } catch (e) { err.textContent = e.message; return; }
    S.editandoUsuario = null;
    S.usuariosTodos = await api("GET", "/usuarios/todos");
    pintar();
  });
  const ca = el("button", "ghost", "Cancelar");
  ca.type = "button";
  ca.onclick = () => { S.editandoUsuario = null; pintar(); };
  acc.appendChild(gu); acc.appendChild(ca);
  box.appendChild(acc);
  return box;
}

const kpi = (k, val, s) => {
  const b = el("div", "kpi");
  b.appendChild(el("div", "k", k));
  b.appendChild(el("div", "v", val));
  if (s) b.appendChild(el("div", "bar-s", s));
  return b;
};

function vacio(v, titulo, texto, lab, fn) {
  const h = el("div", "hollow");
  h.appendChild(el("h3", null, titulo));
  h.appendChild(el("p", null, texto));
  if (lab) { const b = el("button", "cta", lab); b.type = "button"; b.onclick = fn; h.appendChild(b); }
  v.appendChild(h);
}

// ───────────────────────────── Pintado

function pintarNav() {
  const nav = document.getElementById("nav");
  const r = rol();
  nav.innerHTML = "";
  for (const x of [...VISTAS, ...ADMIN]) {
    if (!r.vistas.includes(x.id)) continue;
    const b = el("button", "navbtn", x.lab);
    b.type = "button";
    b.setAttribute("aria-current", S.vista === x.id ? "true" : "false");
    b.onclick = () => { S.vista = x.id; S.panel = null; refrescarVista(); };
    nav.appendChild(b);
  }
  nav.appendChild(el("div", "grow"));
  const yo = el("button", "chip");
  yo.type = "button";
  yo.textContent = `${S.yo.nombre} · salir`;
  yo.title = "Cerrar sesión";
  yo.onclick = async () => {
    try { await api("POST", "/logout", { token: S.token }); } catch {}
    cerrarSesion();
  };
  nav.appendChild(yo);
}

function pintarPie() {
  const p = document.getElementById("pie");
  p.innerHTML = "";
  const s = el("span", S.conectado ? "vivo" : "muerto");
  s.appendChild(el("span", "dot"));
  p.appendChild(s);
  p.appendChild(el("span", null, S.conectado ? "Conectado al servidor del local" : "Sin conexión con el servidor · reintentando"));
  p.appendChild(el("div", "grow"));
  if (S.estado.cola > 0) p.appendChild(el("span", "chip chip-amber", `${S.estado.cola} por transmitir a Hacienda`));
}

function pintar() {
  const v = document.getElementById("view");
  v.innerHTML = "";

  if (!S.yo) {
    document.getElementById("nav").innerHTML = "";
    document.getElementById("pie").innerHTML = "";
    return vLogin(v);
  }

  // A la primera ventana que el rol sí tenga. Caer siempre en "salon" dejaba
  // a cocina mirando una pantalla que no le corresponde.
  if (!rol().vistas.includes(S.vista)) S.vista = rol().vistas[0];
  pintarNav();
  pintarPie();
  if (S.aviso) {
    const a = el("div", "aviso" + (S.aviso.mal ? " mal" : ""));
    a.appendChild(el("span", null, S.aviso.txt));
    v.appendChild(a);
  }
  ({ salon: vSalon, express: vExpress, pedido: vPedido, pago: vPago, cocina: vCocina,
     comprobantes: vComprobantes, cierre: vCierre, reportes: vReportes,
     menu: vMenu, ajustes: vAjustes }[S.vista] ?? vSalon)(v);
}

async function refrescarVista() {
  S.editando = null; S.editandoUsuario = null; S.anulando = null;
  try {
    if (S.vista === "comprobantes") S.comprobantes = await api("GET", "/comprobantes");
    if (S.vista === "cierre") S.turno = await api("GET", "/turno");
    if (S.vista === "reportes") S.reportes = await api("GET", "/reportes");
    if (S.vista === "cocina") S.cocina = await api("GET", "/cocina");
    if (S.vista === "menu") S.productos = await api("GET", "/productos");
    if (S.vista === "ajustes") {
      S.usuariosTodos = await api("GET", "/usuarios/todos");
      S.certificado = await api("GET", "/certificado");
    }
  } catch (e) { avisar(e.message, true); }
  pintar();
}

async function arrancarSesion() {
  S.vista = rol().vistas[0];
  try {
    S.estado = await api("GET", "/estado");
    if (S.yo.rol === "cocina") {
      S.cocina = await api("GET", "/cocina");
    } else {
      S.menu = await api("GET", "/menu");
      if (S.yo.rol !== "salonero") {
        S.turno = await api("GET", "/turno");
        S.frecuentes = await api("GET", "/receptores");
      }
    }
  } catch (e) { avisar(e.message, true); }
  conectar();
  pintar();
}

(async () => {
  try {
    S.usuarios = await api("GET", "/usuarios");
  } catch (e) {
    document.getElementById("view").textContent = "No se pudo hablar con el servidor del local.";
    return;
  }
  if (S.token) {
    // La sesión sobrevive a recargar la página, no a cerrar el navegador.
    try { S.yo = await api("GET", "/yo"); await arrancarSesion(); return; }
    catch { cerrarSesion(); }
  }
  pintar();
  setInterval(() => { if (S.yo) pintar(); }, 30000);   // refresca los "X min"
})();
