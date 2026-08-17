"use strict";

// Corte vertical: una mesa cobrada de verdad, de punta a punta.
// Orden en base de datos -> consecutivo -> comprobante inmutable -> firma
// -> impresión -> los dos dispositivos enterados.

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const DB = path.join(__dirname, "prueba.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);

const { iniciar } = require("./src/servidor");
const { uno, todos, correr, enTransaccion, aEntero } = require("./src/db");
const { siguienteConsecutivo } = require("./src/cobrar");

const API = "http://127.0.0.1:4000";
let TOKEN = null;
const pedir = async (m, ruta, cuerpo, token = TOKEN) => {
  const r = await fetch(API + ruta, {
    method: m,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = await r.json();
  d.__status = r.status;
  return d;
};

let errores = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FALLA ${m}`); errores++; };
const chk = (c, m, d) => (c ? ok(m + (d ? ` — ${d}` : "")) : fail(m + (d ? ` — ${d}` : "")));

(async () => {
  console.log("\nCorte vertical — cobrar una mesa de verdad\n");
  const servidor = await iniciar(DB);

  // --- Nadie entra sin PIN ---
  console.log("0. Ingreso");
  const sinSesion = await pedir("GET", "/menu", null, null);
  chk(sinSesion.__status === 401, "sin sesión no se ve nada", "401");

  const users = await pedir("GET", "/usuarios", null, null);
  chk(users.length > 0 && !("pin_hash" in users[0]),
    "la lista de ingreso no expone hashes", `${users.length} usuarios`);

  // Por rol, no por id: agregar un usuario a la semilla no debe romper esto.
  const quien = (rol) => users.find((u) => u.rol === rol).id;
  const ID_SALONERO = quien("salonero"), ID_CAJA = quien("caja"), ID_ADMIN = quien("admin");

  const malo = await pedir("POST", "/login", { usuarioId: ID_CAJA, pin: "0000" }, null);
  chk(malo.error === "Usuario o PIN incorrecto", "PIN incorrecto rechazado");

  const fantasma = await pedir("POST", "/login", { usuarioId: 999, pin: "1234" }, null);
  chk(fantasma.error === malo.error,
    "usuario inexistente da el mismo mensaje", "no se filtra quién existe");

  // Bloqueo: 4 dígitos son 10.000 combinaciones y se prueban en segundos.
  for (let i = 0; i < 4; i++) await pedir("POST", "/login", { usuarioId: ID_SALONERO, pin: "9999" }, null);
  const cuarto = await pedir("POST", "/login", { usuarioId: ID_SALONERO, pin: "1111" }, null);
  chk(!!cuarto.token, "con 4 fallos el PIN correcto todavía entra", "no castiga al que se equivocó");

  for (let i = 0; i < 5; i++) await pedir("POST", "/login", { usuarioId: ID_SALONERO, pin: "9999" }, null);
  const bloqueado = await pedir("POST", "/login", { usuarioId: ID_SALONERO, pin: "1111" }, null);
  chk(/Demasiados intentos/.test(bloqueado.error ?? ""),
    "al quinto fallo se bloquea, aun con el PIN correcto", bloqueado.error);

  // Se libera el bloqueo para seguir probando: esperar 60s aquí no aporta nada.
  correr("UPDATE usuario SET fallidos = 0, bloqueado_hasta = NULL WHERE id = " + ID_SALONERO);

  const cajera = await pedir("POST", "/login", { usuarioId: ID_CAJA, pin: "2222" }, null);
  chk(!!cajera.token && cajera.usuario.rol === "caja", "la caja entra", cajera.usuario?.nombre);
  TOKEN = cajera.token;

  const jefe = await pedir("POST", "/login", { usuarioId: ID_ADMIN, pin: "3333" }, null);
  chk(jefe.usuario?.rol === "admin", "administración entra", jefe.usuario?.nombre);
  const TOKEN_ADMIN = jefe.token;

  // --- Dos dispositivos escuchando ---
  console.log("\n1. Dos dispositivos conectados");
  const recibidos = { salonero: [], caja: [] };
  const rechazado = await new Promise((res) => {
    const w = new WebSocket("ws://127.0.0.1:4000");
    w.on("error", () => res(true));
    w.on("open", () => { w.close(); res(false); });
  });
  chk(rechazado, "el WebSocket sin token se rechaza", "nadie en el WiFi ve las comandas");

  const conectar = (quien) => new Promise((res) => {
    const w = new WebSocket("ws://127.0.0.1:4000?token=" + TOKEN);
    w.on("message", (d) => recibidos[quien].push(JSON.parse(d).evento));
    w.on("open", () => res(w));
  });
  const salonero = await conectar("salonero");
  const caja = await conectar("caja");
  await new Promise((r) => setTimeout(r, 150));
  chk(recibidos.salonero[0] === "estado" && recibidos.caja[0] === "estado",
    "ambos reciben el estado al conectarse");

  // --- El salonero abre una mesa y carga platos ---
  console.log("\n2. El salonero toma el pedido");
  const menu = await pedir("GET", "/menu");
  chk(menu.length > 0, "menú desde la base de datos", `${menu.length} productos`);

  const casado = menu.find((p) => p.nombre === "Casado de pollo");

  // El menú de un restaurante es todo 13%. Para verificar que el IVA se
  // calcula POR LÍNEA y no sobre el total, hace falta una segunda tarifa:
  // se crea aquí como dato de prueba, no ensuciando el menú de ejemplo.
  correr(
    `INSERT INTO producto (nombre, categoria, precio, cabys, tarifa, codigo_tarifa)
     VALUES ('Pan casero para llevar', 'Para llevar', ?, '2313100000000', 1, '02')`,
    aEntero(1350));
  const reducida = (await pedir("GET", "/menu")).find((p) => p.nombre === "Pan casero para llevar");
  chk(reducida?.tarifa === 1, "producto con tarifa reducida para la prueba", "1%");

  const orden = await pedir("POST", "/ordenes", { mesa: "7", comensales: 4 });
  chk(orden.id > 0, "mesa 7 abierta", `orden ${orden.id}`);

  const dup = await pedir("POST", "/ordenes", { mesa: "7" });
  chk(!!dup.error, "una mesa no puede tener dos órdenes abiertas", "índice único");

  await pedir("POST", "/lineas", { ordenId: orden.id, productoId: casado.id, cantidad: 2 });
  await pedir("POST", "/lineas", { ordenId: orden.id, productoId: reducida.id, cantidad: 1 });

  await new Promise((r) => setTimeout(r, 150));
  chk(recibidos.caja.includes("orden.cambiada"),
    "la caja se entera sin preguntar", "por WebSocket");

  // --- Dinero exacto, dos tarifas ---
  console.log("\n3. Dinero exacto");
  const est = await pedir("GET", "/estado");
  const o = est.ordenes.find((x) => x.id === orden.id);
  // 2 x 5900 = 11800 al 13% -> 1534 ; 1350 al 1% -> 13.5 -> 14
  // servicio 10% sobre 13150 -> 1315 ; total 13150 + 1548 + 1315 = 16013
  chk(o.total === 16013, "IVA por línea con dos tarifas", `total —${o.total}`);

  // --- Cobrar: firma, impresión, inmutabilidad ---
  console.log("\n4. La caja cobra");
  const cobro = await pedir("POST", "/cobrar", { ordenId: orden.id, medioPago: "Efectivo" });
  chk(!cobro.error, "cobro sin errores", cobro.error || "");
  chk(cobro.consecutivo?.length === 20, "consecutivo de 20 dígitos", cobro.consecutivo);
  chk(cobro.clave?.length === 50, "clave de 50 dígitos", cobro.clave);
  chk(cobro.montos?.total === 16013, "el total del comprobante cuadra", `—${cobro.montos?.total}`);
  chk(cobro.firmado > 3000, "XML firmado y guardado", `${cobro.firmado} bytes`);
  chk(cobro.impresion?.ok === true || cobro.impresion?.error,
    "se intentó imprimir", cobro.impresion?.ok ? `${cobro.impresion.bytes} bytes al agente` : "agente apagado (la venta no se cayó)");

  await new Promise((r) => setTimeout(r, 150));
  chk(recibidos.salonero.includes("orden.cobrada"),
    "el salonero ve la mesa liberarse", "sin recargar");

  // --- Reglas del diseño, verificadas contra el motor ---
  console.log("\n5. Reglas del diseño");
  const comp = uno("SELECT * FROM comprobante WHERE clave = ?", cobro.clave);

  try {
    correr("DELETE FROM comprobante WHERE id = ?", comp.id);
    fail("la base dejó borrar un comprobante");
  } catch (e) {
    ok(`no se puede borrar un comprobante — ${e.message.split(":").pop().trim()}`);
  }

  try {
    correr("UPDATE comprobante SET total = 1 WHERE id = ?", comp.id);
    fail("la base dejó cambiarle el total a un comprobante");
  } catch (e) {
    ok(`no se puede alterar el monto — ${e.message.split(":").pop().trim()}`);
  }

  correr("UPDATE comprobante SET estado_hacienda = 'aceptado' WHERE id = ?", comp.id);
  ok("sí se puede mover el estado ante Hacienda");

  try {
    correr("UPDATE comprobante_linea SET cantidad = 99 WHERE comprobante_id = ?", comp.id);
    fail("la base dejó alterar una línea del comprobante");
  } catch (e) {
    ok(`no se pueden alterar las líneas — ${e.message.split(":").pop().trim()}`);
  }

  const lineasComp = todos(
    "SELECT * FROM comprobante_linea WHERE comprobante_id = ? ORDER BY numero_linea", comp.id);
  chk(lineasComp.length === 2, "líneas normalizadas, no JSON", `${lineasComp.length} filas`);
  const porTarifa = todos(
    `SELECT tarifa, SUM(impuesto) imp FROM comprobante_linea
      WHERE comprobante_id = ? GROUP BY tarifa ORDER BY tarifa DESC`, comp.id);
  chk(porTarifa.length === 2, "el reporte de IVA por tarifa sale con un GROUP BY",
    porTarifa.map((r) => `${r.tarifa}%`).join(" y "));

  const pagos = todos("SELECT * FROM pago WHERE comprobante_id = ?", comp.id);
  chk(pagos.length === 1 && pagos[0].monto === comp.total, "el pago quedó registrado");

  // Consecutivo sin huecos: el rollback tiene que devolverlo.
  const antes = uno("SELECT ultimo FROM contador WHERE tipo = 'TE'").ultimo;
  try {
    enTransaccion(() => { siguienteConsecutivo("TE"); throw new Error("falla simulada"); });
  } catch {}
  const despues = uno("SELECT ultimo FROM contador WHERE tipo = 'TE'").ultimo;
  chk(antes === despues, "el consecutivo no deja huecos si la transacción falla",
    `${antes} -> ${despues}`);

  // Cobrar dos veces la misma orden no puede duplicar el comprobante.
  const doble = await pedir("POST", "/cobrar", { ordenId: orden.id });
  chk(!!doble.error, "no se puede cobrar dos veces la misma orden", doble.error);

  // --- Qué puede hacer cada rol ---
  console.log("\n6. Permisos por rol");
  const kevin = await pedir("POST", "/login", { usuarioId: ID_SALONERO, pin: "1111" }, null);
  chk(!!kevin.token, "el salonero entra", kevin.usuario?.nombre);

  if (kevin.token) {
    const t = kevin.token;
    const puede = await pedir("POST", "/ordenes", { mesa: "2" }, t);
    chk(!puede.error, "el salonero puede abrir mesa");

    const cobra = await pedir("POST", "/cobrar", { ordenId: puede.id }, t);
    chk(cobra.__status === 403, "el salonero NO puede cobrar", cobra.error);

    const rep = await pedir("GET", "/reportes", null, t);
    chk(rep.__status === 403, "el salonero NO ve reportes", rep.error);

    await pedir("POST", "/lineas", { ordenId: puede.id, productoId: casado.id, cantidad: 1 }, t);
    const anula = await pedir("POST", "/ordenes/anular",
      { ordenId: puede.id, motivo: "Cliente se retiró" }, t);
    chk(anula.__status === 400 && /caja o administraci/.test(anula.error ?? ""),
      "el salonero NO anula una orden con comida cargada", anula.error);

    const anulaCaja = await pedir("POST", "/ordenes/anular",
      { ordenId: puede.id, motivo: "Cliente se retiró" }, TOKEN);
    chk(!anulaCaja.error, "la caja sí puede anularla", "queda registrado quién fue");
  }

  const repAdmin = await pedir("GET", "/reportes", null, TOKEN_ADMIN);
  chk(!repAdmin.error, "administración sí ve reportes", `—${repAdmin.facturado}`);

  const repCaja = await pedir("GET", "/reportes", null, TOKEN);
  chk(repCaja.__status === 403, "la caja NO ve reportes", repCaja.error);

  await pedir("POST", "/logout", { token: TOKEN });
  const tras = await pedir("GET", "/estado", null, TOKEN);
  chk(tras.__status === 401, "tras salir, el token muere", tras.error);

  salonero.close(); caja.close(); servidor.close();

  console.log(
    errores === 0
      ? "\nResultado: el corte vertical funciona de punta a punta.\n"
      : `\nResultado: ${errores} problema(s).\n`
  );
  process.exit(errores === 0 ? 0 : 1);
})();

