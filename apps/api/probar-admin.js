"use strict";

// Lo que agrega administración: menú con CABYS, turno, nota de crédito,
// usuarios y la cola de Hacienda.

const fs = require("fs");
const path = require("path");

const DB = path.join(__dirname, "prueba-admin.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);

const { iniciar } = require("./src/servidor");
const { uno, todos } = require("./src/db");

const API = "http://127.0.0.1:4000";
let T = null;
const pedir = async (m, ruta, cuerpo, token = T) => {
  const r = await fetch(API + ruta, {
    method: m,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = await r.json();
  if (d && typeof d === "object" && !Array.isArray(d)) d.__status = r.status;
  return d;
};

let errores = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FALLA ${m}`); errores++; };
const chk = (c, m, d) => (c ? ok(m + (d ? ` — ${d}` : "")) : fail(m + (d ? ` — ${d}` : "")));

(async () => {
  console.log("\nAdministración — menú, caja, notas de crédito y usuarios\n");
  const servidor = await iniciar(DB);

  // Por rol, no por id: la semilla puede crecer sin romper las pruebas.
  const users = await pedir("GET", "/usuarios", null, null);
  const quien = (rol) => users.find((u) => u.rol === rol).id;

  const admin = await pedir("POST", "/login", { usuarioId: quien("admin"), pin: "3333" }, null);
  T = admin.token;
  const caja = await pedir("POST", "/login", { usuarioId: quien("caja"), pin: "2222" }, null);

  // ── 1. Menú ──
  console.log("1. Menú y CABYS");
  const hits = await pedir("GET", "/cabys?q=arroz");
  chk(Array.isArray(hits) && hits.length > 0, "el catálogo CABYS responde",
    `${hits.length} resultados desde ${hits[0]?.origen}`);
  const tarifas = [...new Set(hits.map((h) => h.tarifa))];
  chk(tarifas.length > 1, "la misma palabra da tarifas distintas",
    tarifas.map((t) => t + "%").join(" y ") + " — por eso el código no se adivina");

  const corto = await pedir("GET", "/cabys?q=ar");
  chk(!!corto.error, "menos de 3 caracteres no busca", corto.error);

  const malo = await pedir("POST", "/productos", { nombre: "X", categoria: "Y", precio: 100, cabys: "123" });
  chk(!!malo.error, "un CABYS de 3 dígitos se rechaza", malo.error);

  const nuevo = await pedir("POST", "/productos", {
    nombre: "Casado vegetariano", categoria: "Platos", precio: 5400,
    cabys: "6311100000000", tarifa: 13, codigoTarifa: "08",
  });
  chk(!nuevo.error, "producto creado");
  const prods = await pedir("GET", "/productos");
  const creado = prods.find((p) => p.nombre === "Casado vegetariano");
  chk(!!creado, "aparece en el catálogo", `₡${creado?.precio}`);

  const menuPos = await pedir("GET", "/menu", null, caja.token);
  chk(menuPos.some((p) => p.nombre === "Casado vegetariano"), "y en el POS al instante");

  await pedir("POST", "/productos/activo", { id: creado.id, activo: false });
  const menu2 = await pedir("GET", "/menu", null, caja.token);
  chk(!menu2.some((p) => p.nombre === "Casado vegetariano"), "desactivado desaparece del POS");
  chk((await pedir("GET", "/productos")).some((p) => p.nombre === "Casado vegetariano"),
    "pero sigue en administración", "desactivar no es borrar");

  const cajaMenu = await pedir("POST", "/productos", { nombre: "Trampa", categoria: "X", precio: 1, cabys: "6311100000000", tarifa: 13 }, caja.token);
  chk(cajaMenu.__status === 403, "la caja NO puede tocar precios", cajaMenu.error);

  // ── 2. Venta y nota de crédito ──
  console.log("\n2. Nota de crédito");
  const orden = await pedir("POST", "/ordenes", { mesa: "6" });
  await pedir("POST", "/lineas", { ordenId: orden.id, productoId: 1, cantidad: 2 });
  const cobro = await pedir("POST", "/cobrar", { ordenId: orden.id, medioPago: "Efectivo" });
  chk(!cobro.error, "venta cobrada", `${cobro.consecutivo} · ₡${cobro.montos.total}`);

  const comps = await pedir("GET", "/comprobantes");
  const orig = comps[0];

  const nc = await pedir("POST", "/notas-credito", { comprobanteId: orig.id, motivo: "Devolución del cliente" });
  chk(!nc.error, "nota de crédito emitida", nc.consecutivo);
  chk(nc.impresion?.ok === true || !!nc.impresion?.error,
    "se imprime constancia para el cliente",
    nc.impresion?.ok ? `${nc.impresion.bytes} bytes` : "agente apagado");
  chk(nc.consecutivo?.substring(8, 10) === "03", "lleva 03 en el consecutivo", "03 = nota de crédito");
  chk(nc.clave?.length === 50, "con su propia clave de 50 dígitos");
  chk(nc.montos?.total === cobro.montos.total, "revierte el monto exacto", `₡${nc.montos?.total}`);

  const lineasNc = todos(
    `SELECT * FROM comprobante_linea WHERE comprobante_id =
       (SELECT id FROM comprobante WHERE consecutivo = ?)`, nc.consecutivo);
  chk(lineasNc.length > 0, "copia las líneas del original", `${lineasNc.length} líneas`);

  const ref = uno("SELECT referencia_id FROM comprobante WHERE consecutivo = ?", nc.consecutivo);
  chk(ref.referencia_id === orig.id, "referencia al comprobante que anula");

  const dobleNc = await pedir("POST", "/notas-credito", { comprobanteId: orig.id, motivo: "otra vez" });
  chk(!!dobleNc.error, "no se puede anular dos veces", dobleNc.error);

  const sinMotivo = await pedir("POST", "/notas-credito", { comprobanteId: 999 });
  chk(!!sinMotivo.error, "sin motivo no se emite", sinMotivo.error);

  const ncCaja = await pedir("POST", "/notas-credito", { comprobanteId: orig.id, motivo: "x" }, caja.token);
  chk(ncCaja.__status === 403, "la caja NO emite notas de crédito", ncCaja.error);

  // ── 3. Turno ──
  console.log("\n3. Cierre de caja");
  const t1 = await pedir("GET", "/turno");
  chk(t1.abierto, "hay turno abierto", `esperado ₡${t1.esperado}`);
  chk(t1.devuelto === cobro.montos.total,
    "la nota de crédito cuenta como devolución, no como venta", `₡${t1.devuelto} devueltos`);
  chk(t1.esperado === t1.apertura,
    "una venta anulada deja la caja como estaba", `₡${t1.esperado} = fondo de apertura`);

  const sinContar = await pedir("POST", "/turno/cerrar", {});
  chk(!!sinContar.error, "no cierra sin contar el efectivo", sinContar.error);

  const cierre = await pedir("POST", "/turno/cerrar", { declarado: t1.esperado - 2000 });
  chk(cierre.diferencia === -2000, "el arqueo detecta el faltante", `₡${cierre.diferencia}`);
  chk(cierre.esperado === t1.esperado,
    "el arqueo y la consulta dan el mismo número", "un solo cálculo, no dos");

  const t2 = await pedir("GET", "/turno");
  chk(!t2.abierto, "la caja queda cerrada");

  const sinTurno = await pedir("POST", "/ordenes", { mesa: "1" });
  chk(!!sinTurno.error, "sin turno no se abre mesa", sinTurno.error);

  await pedir("POST", "/turno/abrir", { apertura: 50000 });
  chk((await pedir("GET", "/turno")).abierto, "se puede volver a abrir");

  // ── 4. Usuarios ──
  console.log("\n4. Usuarios");
  const pinCorto = await pedir("POST", "/usuarios", { nombre: "Ana", rol: "caja", pin: "12" });
  chk(!!pinCorto.error, "un PIN de 2 dígitos se rechaza", pinCorto.error);

  await pedir("POST", "/usuarios", { nombre: "Ana Vargas", rol: "caja", pin: "4444" });
  const us = await pedir("GET", "/usuarios/todos");
  const ana = us.find((u) => u.nombre === "Ana Vargas");
  chk(!!ana, "usuario creado", `${us.length} en total`);

  const entra = await pedir("POST", "/login", { usuarioId: ana.id, pin: "4444" }, null);
  chk(!!entra.token, "puede ingresar con su PIN", entra.usuario?.rol);

  const yoMismo = await pedir("POST", "/usuarios/activo", { id: quien("admin"), activo: false });
  chk(!!yoMismo.error, "no puede desactivarse a sí mismo", yoMismo.error);

  await pedir("POST", "/usuarios/activo", { id: ana.id, activo: false });
  const tras = await pedir("GET", "/estado", null, entra.token);
  chk(tras.__status === 401, "al desactivarla, su sesión muere", "no espera a que venza");

  // ── 5. Cola de Hacienda ──
  console.log("\n5. Cola de Hacienda");
  const est = await pedir("GET", "/estado");
  chk(est.cola > 0, "hay comprobantes esperando", `${est.cola} en cola`);
  const tx = await pedir("POST", "/transmitir", {});
  chk(tx.enviados === 0 && tx.encolados > 0,
    "el intento queda registrado sin inventar aceptación", tx.detalle);

  servidor.close();
  console.log(errores === 0
    ? "\nResultado: administración completa.\n"
    : `\nResultado: ${errores} problema(s).\n`);
  process.exit(errores === 0 ? 0 : 1);
})();
