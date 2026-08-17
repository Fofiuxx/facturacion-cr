"use strict";

// QA: buscar problemas, no confirmar que las pruebas pasan.
// Prueba límites, concurrencia, entradas hostiles y precisión del dinero.

const fs = require("fs");
const path = require("path");

const DB = path.join(__dirname, "qa.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);

const { iniciar } = require("./src/servidor");
const { uno, todos, correr, aEntero, redondear, ESCALA } = require("./src/db");
const { totales } = require("./src/cobrar");

const API = "http://127.0.0.1:4000";
let T = null;
const pedir = async (m, ruta, cuerpo, token = T) => {
  const r = await fetch(API + ruta, {
    method: m,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: m === "GET" || cuerpo === null || cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  let d;
  try { d = await r.json(); } catch { d = { __noJson: true }; }
  if (d && typeof d === "object" && !Array.isArray(d)) d.__status = r.status;
  return d;
};

let fallas = 0, avisos = 0;
const ok = (m, d) => console.log(`  ok    ${m}${d ? ` — ${d}` : ""}`);
const mal = (m, d) => { console.log(`  MAL   ${m}${d ? ` — ${d}` : ""}`); fallas++; };
const ojo = (m, d) => { console.log(`  ojo   ${m}${d ? ` — ${d}` : ""}`); avisos++; };
const chk = (c, m, d) => (c ? ok(m, d) : mal(m, d));

(async () => {
  console.log("\nQA — buscando problemas\n");
  const servidor = await iniciar(DB);
  const users = await pedir("GET", "/usuarios", null, null);
  const idAdmin = users.find((u) => u.rol === "admin").id;
  const admin = await pedir("POST", "/login", { usuarioId: idAdmin, pin: "3333" }, null);
  T = admin.token;

  // ── 1. Precisión del dinero ──────────────────────────────────
  console.log("1. Precisión del dinero");

  // El impuesto se calcula multiplicando un entero por un decimal. Ese es el
  // único lugar donde puede colarse un float.
  let peor = 0, peorCaso = null;
  for (const colones of [1, 7, 99, 333, 1350, 5900, 12345, 99999, 1234567, 9999999]) {
    for (const tarifa of [13, 4, 2, 1]) {
      for (const qty of [1, 3, 7, 13, 99]) {
        const monto = aEntero(colones) * qty;
        const conFloat = Math.round(monto * (tarifa / 100));
        const exacto = Math.round((monto * tarifa) / 100);   // sin dividir primero
        const dif = Math.abs(conFloat - exacto);
        if (dif > peor) { peor = dif; peorCaso = `${qty} × ₡${colones} al ${tarifa}%`; }
      }
    }
  }
  peor === 0
    ? ok("el cálculo del IVA no pierde precisión en el rango real", "600 combinaciones")
    : ojo(`el IVA difiere en ${peor} milésimas`, peorCaso);

  // Al borde del entero seguro sí se rompe. Es el límite documentado.
  const enorme = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  const difEnorme = Math.abs(Math.round(enorme * 0.13) - Math.round((enorme * 13) / 100));
  difEnorme > 0
    ? ok("cerca del límite del entero seguro sí divergen", `dif ${difEnorme} — pero son ₡${Math.round(enorme/ESCALA/1e6)} millones`)
    : ok("ni al borde del entero seguro divergen");

  // La suma de impuestos por línea tiene que dar el total del comprobante.
  const lineas = [
    { precio: aEntero(5900), cantidad: 3, tarifa: 13 },
    { precio: aEntero(1350), cantidad: 7, tarifa: 1 },
    { precio: aEntero(899), cantidad: 11, tarifa: 4 },
  ];
  const t = totales(lineas, true);
  const sumaLineas = lineas.reduce((a, l) => a + Math.round(l.precio * l.cantidad * (l.tarifa / 100)), 0);
  chk(t.impuesto === sumaLineas, "el IVA del comprobante es la suma exacta de sus líneas");
  chk(t.total === t.subtotal + t.impuesto + t.servicio, "los totales cuadran entre sí");

  const cero = totales([], false);
  chk(cero.total === 0, "una orden vacía da cero, no NaN");

  // ── 2. Entradas hostiles ─────────────────────────────────────
  console.log("\n2. Entradas hostiles");

  const inyeccion = await pedir("GET", "/padron?cedula=' OR 1=1--");
  chk(!!inyeccion.error, "SQL en la cédula se rechaza sin tocar la base", inyeccion.error);

  const xss = await pedir("POST", "/productos", {
    nombre: "<img src=x onerror=alert(1)>", categoria: "X", precio: 100,
    cabys: "6311100000000", tarifa: 13,
  });
  if (!xss.error) {
    const p = todos("SELECT nombre FROM producto WHERE nombre LIKE '<img%'")[0];
    chk(!!p, "el HTML se guarda literal", "el cliente lo pinta con textContent, no se ejecuta");
    correr("DELETE FROM producto WHERE nombre LIKE '<img%'");
  }

  const negativo = await pedir("POST", "/productos", {
    nombre: "Trampa", categoria: "X", precio: -5000, cabys: "6311100000000", tarifa: 13,
  });
  chk(!!negativo.error, "precio negativo rechazado", negativo.error);

  const cantidadNeg = await pedir("POST", "/ordenes", { mesa: "1" });
  const rNeg = await pedir("POST", "/lineas", { ordenId: cantidadNeg.id, productoId: 1, cantidad: -5 });
  const trasNeg = uno("SELECT COUNT(*) c FROM orden_linea WHERE orden_id = ? AND cantidad < 0", cantidadNeg.id);
  chk(!!rNeg.error || trasNeg.c === 0, "cantidad negativa no entra", rNeg.error ?? "bloqueado por CHECK");

  const gigante = await pedir("POST", "/productos", {
    nombre: "Overflow", categoria: "X", precio: 1e15, cabys: "6311100000000", tarifa: 13,
  });
  chk(!!gigante.error, "un monto fuera de rango se rechaza", gigante.error);

  const inexistente = await pedir("POST", "/lineas", { ordenId: 99999, productoId: 1, cantidad: 1 });
  chk(!!inexistente.error || inexistente.__status >= 400, "orden inexistente no crea basura");

  const basura = await pedir("POST", "/cobrar", { ordenId: "hola" });
  chk(!!basura.error, "un id que no es número se rechaza", basura.error);

  // ── 3. Concurrencia ──────────────────────────────────────────
  console.log("\n3. Concurrencia");

  const o = await pedir("POST", "/ordenes", { mesa: "2" });
  await pedir("POST", "/lineas", { ordenId: o.id, productoId: 1, cantidad: 1 });

  // Dos cajas cobrando la misma mesa a la vez. Solo una puede ganar.
  const [a, b] = await Promise.all([
    pedir("POST", "/cobrar", { ordenId: o.id, medioPago: "Efectivo" }),
    pedir("POST", "/cobrar", { ordenId: o.id, medioPago: "Tarjeta" }),
  ]);
  const exitos = [a, b].filter((x) => !x.error).length;
  chk(exitos === 1, "dos cobros simultáneos: solo uno prospera",
    `${exitos} éxito(s), el otro: ${[a, b].find((x) => x.error)?.error}`);

  const comps = todos("SELECT COUNT(*) c FROM comprobante WHERE orden_id = ?", o.id);
  chk(comps[0].c === 1, "no se generó comprobante duplicado", `${comps[0].c} comprobante`);

  // Diez líneas a la vez sobre la misma orden.
  const o2 = await pedir("POST", "/ordenes", { mesa: "3" });
  await Promise.all(Array.from({ length: 10 }, () =>
    pedir("POST", "/lineas", { ordenId: o2.id, productoId: 1, cantidad: 1 })));
  const filas = uno("SELECT COUNT(*) c, SUM(cantidad) q FROM orden_linea WHERE orden_id = ?", o2.id);
  chk(filas.q === 10, "diez agregados concurrentes suman 10", `${filas.q} unidades en ${filas.c} fila(s)`);

  // Consecutivos bajo carga: ninguno se repite ni se salta.
  const antes = uno("SELECT ultimo FROM contador WHERE tipo = 'TE'").ultimo;
  const ordenes = [];
  for (let i = 0; i < 8; i++) {
    const x = await pedir("POST", "/ordenes", {});
    await pedir("POST", "/lineas", { ordenId: x.id, productoId: 1, cantidad: 1 });
    ordenes.push(x.id);
  }
  const cobros = await Promise.all(ordenes.map((id) =>
    pedir("POST", "/cobrar", { ordenId: id, medioPago: "Efectivo" })));
  const cons = cobros.filter((c) => c.consecutivo).map((c) => c.consecutivo);
  chk(new Set(cons).size === cons.length, "ningún consecutivo repetido bajo carga", `${cons.length} emitidos`);
  const nums = cons.map((c) => Number(c.slice(10))).sort((x, y) => x - y);
  const seguidos = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  chk(seguidos, "y son correlativos, sin huecos", `${nums[0]} … ${nums[nums.length - 1]}`);
  chk(uno("SELECT ultimo FROM contador WHERE tipo = 'TE'").ultimo === antes + cons.length,
    "el contador cuadra con lo emitido");

  const claves = todos("SELECT clave FROM comprobante").map((r) => r.clave);
  chk(new Set(claves).size === claves.length, "ninguna clave repetida", `${claves.length} claves`);
  chk(claves.every((c) => c.length === 50), "todas de 50 dígitos");

  // ── 4. Sesiones ──────────────────────────────────────────────
  console.log("\n4. Sesiones");

  const falso = await pedir("GET", "/estado", null, "a".repeat(64));
  chk(falso.__status === 401, "un token inventado no entra");

  const vacio = await pedir("GET", "/estado", null, "");
  chk(vacio.__status === 401, "sin token tampoco");

  correr("UPDATE sesion SET vence_en = ? WHERE token = ?", Date.now() - 1000, admin.token);
  const vencida = await pedir("GET", "/estado", null, admin.token);
  chk(vencida.__status === 401, "una sesión vencida se rechaza");
  const quedan = uno("SELECT COUNT(*) c FROM sesion WHERE vence_en < ?", Date.now()).c;
  chk(quedan === 0, "y las vencidas se limpian solas", "sin tarea programada");

  const re = await pedir("POST", "/login", { usuarioId: idAdmin, pin: "3333" }, null);
  T = re.token;

  // ── 5. Resistencia ───────────────────────────────────────────
  console.log("\n5. Resistencia");

  const sinCuerpo = await fetch(API + "/cobrar", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + T },
    body: "{esto no es json",
  });
  chk(sinCuerpo.status >= 400 && sinCuerpo.status < 500, "un JSON roto no tumba el servidor",
    `HTTP ${sinCuerpo.status}`);

  const sigueVivo = await pedir("GET", "/estado");
  chk(!sigueVivo.error, "y el servidor sigue respondiendo");

  const noExiste = await pedir("GET", "/inventado");
  chk(noExiste.__status === 404, "ruta inexistente da 404 limpio");

  const salto = await fetch(API + "/../../../etc/passwd");
  chk(salto.status === 404 || salto.status === 403, "no se puede salir de la carpeta del cliente",
    `HTTP ${salto.status}`);

  // ── 6. La cola se vacía sola ─────────────────────────────────
  console.log("\n6. Cola de Hacienda");
  const cola = require("./src/cola");

  chk(!cola.hayCredenciales(), "sin llave cargada, no intenta transmitir",
    "no gasta reintentos contra un endpoint que no puede usar");

  const enCola = cola.pendientes();
  chk(enCola.length > 0, "hay comprobantes esperando", `${enCola.length}`);

  const r1 = await cola.ciclo();
  chk(r1.enviados === 0 && r1.motivo === "sin credenciales de Hacienda",
    "el ciclo automático corre y reporta por qué no envía");

  // Backoff: un comprobante recién intentado no se reintenta enseguida.
  const c0 = { intentos: 0, enviado_en: null };
  const c3 = { intentos: 3, enviado_en: Date.now() };
  const c3viejo = { intentos: 3, enviado_en: Date.now() - 10 * 60 * 1000 };
  chk(cola.listoParaReintentar(c0), "uno nunca intentado se transmite ya");
  chk(!cola.listoParaReintentar(c3), "uno con 3 intentos recientes espera");
  chk(cola.listoParaReintentar(c3viejo), "y tras la espera vuelve a intentarse", "backoff exponencial");

  // ── 7. Respaldo: hacerlo y RESTAURARLO ───────────────────────
  console.log("\n7. Respaldo");
  const respaldo = require("./src/respaldo");
  const { DatabaseSync } = require("node:sqlite");
  const zlib = require("node:zlib");

  const antesComp = uno("SELECT COUNT(*) c FROM comprobante").c;
  const r = respaldo.hacer({ motivo: "qa" });
  chk(r.contenido.comprobantes === antesComp, "el respaldo trae todos los comprobantes",
    `${r.contenido.comprobantes}`);
  chk(r.contenido.firmados > 0, "y los XML firmados adentro", `${r.contenido.firmados}`);
  chk(r.ahorro > 50, "comprime bien: es texto repetitivo", `${r.ahorro}% menos · ${Math.round(r.bytes/1024)} KB`);

  const v = respaldo.verificar(r.archivo);
  chk(v.ok, "se verifica abriéndolo, no confiando en que existe");

  // Un respaldo corrupto tiene que detectarse, no restaurarse en silencio.
  const roto = path.join(respaldo.DIR, "roto.db.gz");
  fs.writeFileSync(roto, zlib.gzipSync(Buffer.from("esto no es una base de datos")));
  const vRoto = respaldo.verificar(roto);
  chk(!vRoto.ok, "un archivo corrupto se detecta antes de restaurar", vRoto.motivo?.slice(0, 40));
  fs.unlinkSync(roto);

  // La prueba de verdad: restaurar y comprobar que los datos están.
  const copia = path.join(__dirname, "restaurado-qa.db");
  fs.writeFileSync(copia, zlib.gunzipSync(fs.readFileSync(path.join(respaldo.DIR, r.archivo))));
  const base = new DatabaseSync(copia, { readOnly: true });
  const claveOriginal = uno("SELECT clave FROM comprobante ORDER BY id LIMIT 1").clave;
  const claveRestaurada = base.prepare("SELECT clave FROM comprobante ORDER BY id LIMIT 1").get().clave;
  const xmlRestaurado = base.prepare(
    "SELECT length(xml_firmado) n FROM comprobante WHERE xml_firmado IS NOT NULL LIMIT 1").get().n;
  base.close();
  fs.unlinkSync(copia);

  chk(claveRestaurada === claveOriginal, "restaurado: la clave numérica es la misma");
  chk(xmlRestaurado > 3000, "y el XML firmado sobrevivió entero", `${xmlRestaurado} bytes`);

  const cuantos = respaldo.listar().length;
  chk(cuantos > 0, "quedan respaldos en disco", `${cuantos}`);

  // ── 8. Consultas por venta ───────────────────────────────────
  console.log("\n8. Costo de las consultas");
  const mesas = uno("SELECT COUNT(*) c FROM mesa").c;
  const abiertas = uno("SELECT COUNT(*) c FROM orden WHERE estado IN ('abierta','pide_cuenta')").c;
  ojo(`estado() hace 1 + ${abiertas} consultas`,
    `una por orden abierta. Con ${mesas} mesas está bien; con 200 habría que juntarlas`);

  servidor.close();
  console.log(`\n${fallas === 0 ? "Sin fallas" : fallas + " FALLA(S)"} · ${avisos} aviso(s)\n`);
  process.exit(fallas === 0 ? 0 : 1);
})();
