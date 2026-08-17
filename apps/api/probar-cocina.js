"use strict";

// La comanda llega a cocina, la preparan y avisan.

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const DB = path.join(__dirname, "prueba-cocina.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);

const { iniciar } = require("./src/servidor");
const { uno, correr } = require("./src/db");

const API = "http://127.0.0.1:4000";
const pedir = async (m, ruta, cuerpo, token) => {
  const r = await fetch(API + ruta, {
    method: m,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: m === "GET" || !cuerpo ? undefined : JSON.stringify(cuerpo),
  });
  const d = await r.json();
  if (d && typeof d === "object" && !Array.isArray(d)) d.__status = r.status;
  return d;
};

let errores = 0;
const ok = (m, d) => console.log(`  ok   ${m}${d ? ` — ${d}` : ""}`);
const fail = (m, d) => { console.log(`  FALLA ${m}${d ? ` — ${d}` : ""}`); errores++; };
const chk = (c, m, d) => (c ? ok(m, d) : fail(m, d));

(async () => {
  console.log("\nCocina — la comanda llega para que la preparen\n");
  const servidor = await iniciar(DB);

  const users = await pedir("GET", "/usuarios");
  const quien = (rol) => users.find((u) => u.rol === rol).id;

  const kevin = await pedir("POST", "/login", { usuarioId: quien("salonero"), pin: "1111" });
  const marta = await pedir("POST", "/login", { usuarioId: quien("cocina"), pin: "4444" });
  chk(marta.usuario?.rol === "cocina", "cocina tiene su propio ingreso", marta.usuario?.nombre);

  // La pantalla de cocina no da acceso al resto.
  const menu = await pedir("GET", "/menu", null, marta.token);
  chk(menu.__status === 403, "cocina NO ve el menú ni precios", menu.error);
  const cobra = await pedir("POST", "/cobrar", { ordenId: 1 }, marta.token);
  chk(cobra.__status === 403, "cocina NO cobra", cobra.error);

  console.log("\n1. El salonero toma y manda");
  const o = await pedir("POST", "/ordenes", { mesa: "4" }, kevin.token);
  await pedir("POST", "/lineas", { ordenId: o.id, productoId: 1, cantidad: 2 }, kevin.token);
  await pedir("POST", "/lineas", { ordenId: o.id, productoId: 8, cantidad: 1 }, kevin.token);

  const antes = await pedir("GET", "/cocina", null, marta.token);
  chk(antes.length === 0, "lo que no se mandó, la cocina no lo ve",
    "el mesero sigue tomando la orden");

  const env = await pedir("POST", "/ordenes/cocina", { ordenId: o.id }, kevin.token);
  chk(env.enviadas === 2, "el salonero manda la comanda", `${env.enviadas} líneas`);

  const vacio = await pedir("POST", "/ordenes/cocina", { ordenId: o.id }, kevin.token);
  chk(!!vacio.error, "mandar dos veces no duplica", vacio.error);

  console.log("\n2. La cocina la ve");
  const cocina = await pedir("GET", "/cocina", null, marta.token);
  chk(cocina.length === 1, "aparece una comanda");
  chk(cocina[0].titulo === "Mesa 4", "con su mesa", cocina[0].titulo);
  chk(cocina[0].lineas.length === 2, "y sus dos platos",
    cocina[0].lineas.map((l) => `${l.cantidad} ${l.nombre}`).join(", "));

  // Lo agregado después también llega, sin repetir lo anterior.
  await pedir("POST", "/lineas", { ordenId: o.id, productoId: 10, cantidad: 3 }, kevin.token);
  const env2 = await pedir("POST", "/ordenes/cocina", { ordenId: o.id }, kevin.token);
  chk(env2.enviadas === 1, "un plato agregado después se manda solo", "no reenvía lo ya mandado");
  const cocina2 = await pedir("GET", "/cocina", null, marta.token);
  chk(cocina2[0].lineas.length === 3, "y la comanda crece", `${cocina2[0].lineas.length} platos`);

  console.log("\n3. Orden de llegada");
  const o2 = await pedir("POST", "/ordenes", {}, kevin.token);
  await pedir("POST", "/lineas", { ordenId: o2.id, productoId: 1, cantidad: 1 }, kevin.token);
  await pedir("POST", "/ordenes/cocina", { ordenId: o2.id }, kevin.token);
  const lista = await pedir("GET", "/cocina", null, marta.token);
  chk(lista.length === 2, "dos comandas en cola");
  chk(lista[0].titulo === "Mesa 4", "la más vieja va primero", "lo que lleva más esperando");
  chk(lista[1].esMesa === false, "la express se distingue", lista[1].titulo);

  console.log("\n4. La cocina avisa");
  const ws = new WebSocket("ws://127.0.0.1:4000?token=" + kevin.token);
  const eventos = [];
  ws.on("message", (d) => eventos.push(JSON.parse(d).evento));
  await new Promise((r) => setTimeout(r, 200));

  const unPlato = lista[0].lineas[0];
  await pedir("POST", "/cocina/lista", { lineaId: unPlato.id }, marta.token);
  const tras = await pedir("GET", "/cocina", null, marta.token);
  chk(tras[0].lineas.length === 2, "marcar un plato lo saca de la pantalla", `quedan ${tras[0].lineas.length}`);

  await pedir("POST", "/cocina/lista", { ordenId: lista[0].ordenId }, marta.token);
  const tras2 = await pedir("GET", "/cocina", null, marta.token);
  chk(tras2.length === 1, "marcar la comanda entera la cierra");

  await new Promise((r) => setTimeout(r, 300));
  chk(eventos.includes("cocina.lista"), "el salonero se entera sin preguntar", "por WebSocket");
  ws.close();

  console.log("\n5. Cobrar no depende de la cocina");
  const cobrable = await pedir("POST", "/ordenes/cuenta", { ordenId: o2.id }, kevin.token);
  chk(!cobrable.error, "una orden con platos en cocina se puede pasar a caja",
    "el cliente no espera a que la cocina marque nada");

  servidor.close();
  console.log(errores === 0
    ? "\nResultado: la cocina recibe, prepara y avisa.\n"
    : `\nResultado: ${errores} problema(s).\n`);
  process.exit(errores === 0 ? 0 : 1);
})();
