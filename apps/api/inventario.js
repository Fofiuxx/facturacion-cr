"use strict";

// Muestra qué quedó creado en la base. Útil para revisar el esquema de un vistazo.

const fs = require("fs");
const path = require("path");
const { abrir, semilla, todos, uno, redondear } = require("./src/db");

const DB = path.join(__dirname, "datos.db");
const nueva = !fs.existsSync(DB);
abrir(DB);
semilla();

const objetos = (tipo) =>
  todos(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`, tipo)
    .map((r) => r.name);

const tablas = objetos("table");
const triggers = objetos("trigger");
const indices = objetos("index");

console.log(`\nBase de datos: ${DB}${nueva ? "  (recién creada)" : ""}\n`);

console.log(`Tablas (${tablas.length})`);
for (const t of tablas) {
  const filas = uno(`SELECT COUNT(*) c FROM ${t}`).c;
  const cols = todos(`PRAGMA table_info(${t})`).length;
  console.log(`  ${t.padEnd(20)} ${String(cols).padStart(2)} columnas   ${String(filas).padStart(3)} filas`);
}

console.log(`\nReglas del diseño puestas en el motor (${triggers.length})`);
for (const t of triggers) console.log(`  ${t}`);

console.log(`\nÍndices: ${indices.length}`);

const e = uno("SELECT * FROM emisor WHERE id = 1");
const c = uno("SELECT * FROM certificado WHERE id = 1");
const tu = uno("SELECT * FROM turno WHERE cerrado_en IS NULL");
console.log(`\nEmisor      ${e.nombre} · ced. ${e.identificacion} · ambiente ${e.ambiente}`);
console.log(`Certificado vence en ${Math.round((c.vence_en - Date.now()) / 86400000)} días`);
console.log(`Turno       ${tu ? `abierto con ₡${redondear(tu.monto_apertura).toLocaleString("es-CR")} de fondo` : "cerrado"}`);
console.log(`Mesas       ${uno("SELECT COUNT(*) c FROM mesa").c} en ${uno("SELECT COUNT(*) c FROM salon").c} salones`);
console.log(`Menú        ${uno("SELECT COUNT(*) c FROM producto WHERE activo = 1").c} productos activos\n`);
