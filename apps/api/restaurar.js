"use strict";

// Restaura un respaldo.
//
//   node restaurar.js                 → lista los disponibles
//   node restaurar.js <archivo>       → verifica y restaura
//
// Antes de reemplazar nada, guarda la base actual con sufijo .antes-de-restaurar.
// Restaurar sobre una base viva sin red de seguridad es cómo se pierden dos
// copias en vez de una.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const respaldo = require("./src/respaldo");

const DESTINO = path.join(__dirname, "datos.db");
const arg = process.argv[2];

const kb = (n) => Math.round(n / 1024).toLocaleString("es-CR") + " KB";

if (!arg) {
  const lista = respaldo.listar();
  console.log(`\nRespaldos en ${respaldo.DIR}\n`);
  if (!lista.length) {
    console.log("  No hay ninguno. Se generan solos al arrancar el servidor.\n");
    process.exit(0);
  }
  for (const r of lista) {
    console.log(`  ${r.archivo.padEnd(34)} ${kb(r.bytes).padStart(10)}   ${new Date(r.fecha).toLocaleString("es-CR")}`);
  }
  console.log(`\nPara restaurar:  node restaurar.js ${lista[0].archivo}\n`);
  process.exit(0);
}

const origen = path.isAbsolute(arg) ? arg : path.join(respaldo.DIR, arg);
if (!fs.existsSync(origen)) {
  console.error(`\nNo existe: ${origen}\n`);
  process.exit(1);
}

console.log(`\nRestaurando ${path.basename(origen)}\n`);

// 1. Verificar ANTES de tocar nada.
const rev = respaldo.verificar(origen);
if (!rev.ok) {
  console.error(`  El respaldo está dañado: ${rev.motivo}`);
  console.error(`  No se tocó la base actual.\n`);
  process.exit(1);
}
console.log(`  verificado: ${rev.contenido.comprobantes} comprobantes, ` +
            `${rev.contenido.firmados} con XML firmado, ${rev.contenido.productos} productos`);

// 2. Guardar lo que hay, por si el respaldo era peor que la realidad.
if (fs.existsSync(DESTINO)) {
  const previo = `${DESTINO}.antes-de-restaurar-${Date.now()}`;
  fs.copyFileSync(DESTINO, previo);
  console.log(`  la base actual quedó en ${path.basename(previo)}`);
}

// 3. Reemplazar. Los archivos -wal y -shm tienen que irse: pertenecen a la
//    base vieja y la corromperían.
for (const sufijo of ["", "-wal", "-shm"]) {
  const f = DESTINO + sufijo;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
fs.writeFileSync(DESTINO, zlib.gunzipSync(fs.readFileSync(origen)));

// 4. Comprobar que lo restaurado abre y trae lo mismo.
const final = respaldo.verificar(DESTINO, rev.contenido);
if (!final.ok) {
  console.error(`\n  Algo salió mal al restaurar: ${final.motivo}\n`);
  process.exit(1);
}

console.log(`  restaurado y verificado\n`);
console.log(`Levantá el servidor:  node src/servidor.js\n`);
