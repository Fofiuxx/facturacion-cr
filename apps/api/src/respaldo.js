"use strict";

// Respaldo de la base.
//
// La conservación de comprobantes por 5 años es obligación legal. Sin respaldo,
// un disco quemado no es un problema técnico: es un problema con Hacienda.
//
// Dos reglas que este módulo toma en serio:
//   1. No se copia el archivo con `cp`. En modo WAL eso produce una copia
//      inconsistente que parece funcionar hasta el día que la necesitás.
//      Se usa VACUUM INTO, que hace una instantánea coherente.
//   2. Un respaldo que nunca se restauró no es un respaldo. Cada uno se
//      verifica abriéndolo y contando lo que debería tener.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
// Se accede como `base.db` y no desestructurado: la conexión no existe hasta
// que corre abrir(), así que capturarla al importar da undefined.
const base = require("./db");

const DIR = path.join(__dirname, "..", "respaldos");
const CUANTOS = 14;                    // dos semanas de historia local
const CADA_MS = 6 * 60 * 60 * 1000;    // cuatro veces al día

let reloj = null;

const sello = (d = new Date()) => {
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Lo que un respaldo válido tiene que contener. */
function censo(conexion) {
  const c = (t) => conexion.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return {
    comprobantes: c("comprobante"),
    lineas: c("comprobante_linea"),
    productos: c("producto"),
    usuarios: c("usuario"),
    firmados: conexion.prepare(
      "SELECT COUNT(*) n FROM comprobante WHERE xml_firmado IS NOT NULL").get().n,
  };
}

function hacer({ motivo = "programado" } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const nombre = `${sello()}-${motivo}.db`;
  const crudo = path.join(DIR, nombre);
  if (fs.existsSync(crudo)) fs.unlinkSync(crudo);

  // Instantánea coherente, aunque haya escrituras en curso.
  base.db.exec(`VACUUM INTO '${crudo.replace(/'/g, "''")}'`);

  const esperado = censo(base.db);
  const revision = verificar(crudo, esperado);
  if (!revision.ok) {
    fs.unlinkSync(crudo);
    throw new Error(`El respaldo salió mal: ${revision.motivo}`);
  }

  // El XML comprime muchísimo: es texto repetitivo.
  const gz = crudo + ".gz";
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(crudo), { level: 9 }));
  const antes = fs.statSync(crudo).size;
  const despues = fs.statSync(gz).size;
  fs.unlinkSync(crudo);

  limpiar();
  return {
    archivo: path.basename(gz),
    bytes: despues,
    ahorro: Math.round((1 - despues / antes) * 100),
    contenido: esperado,
  };
}

/** Abre el respaldo de verdad y comprueba que sirve. */
function verificar(archivo, esperado) {
  const ruta = path.isAbsolute(archivo) ? archivo : path.join(DIR, archivo);
  let tmp = ruta;
  let temporal = false;

  try {
    if (ruta.endsWith(".gz")) {
      tmp = ruta.replace(/\.gz$/, ".check");
      fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(ruta)));
      temporal = true;
    }

    const copia = new DatabaseSync(tmp, { readOnly: true });
    try {
      const integridad = copia.prepare("PRAGMA integrity_check").get();
      const valor = Object.values(integridad)[0];
      if (valor !== "ok") return { ok: false, motivo: `integridad: ${valor}` };

      const hay = censo(copia);
      if (esperado) {
        for (const [k, v] of Object.entries(esperado)) {
          if (hay[k] !== v) return { ok: false, motivo: `${k}: esperaba ${v}, hay ${hay[k]}` };
        }
      }
      return { ok: true, contenido: hay };
    } finally { copia.close(); }
  } catch (e) {
    return { ok: false, motivo: e.message };
  } finally {
    if (temporal && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function listar() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith(".db.gz"))
    .map((f) => ({ archivo: f, bytes: fs.statSync(path.join(DIR, f)).size,
                   fecha: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.fecha - a.fecha);
}

/** Se quedan los últimos, para no llenar el disco del local. */
function limpiar() {
  const viejos = listar().slice(CUANTOS);
  for (const v of viejos) fs.unlinkSync(path.join(DIR, v.archivo));
  return viejos.length;
}

function arrancar(alHacer) {
  if (reloj) return;
  const correr = (motivo) => {
    try {
      const r = hacer({ motivo });
      console.log(`  respaldo: ${r.archivo} · ${Math.round(r.bytes / 1024)} KB · ${r.contenido.comprobantes} comprobantes`);
      alHacer?.(r);
    } catch (e) {
      // Un respaldo fallido tiene que gritar, no pasar desapercibido.
      console.error(`  RESPALDO FALLIDO: ${e.message}`);
    }
  };
  correr("arranque");
  reloj = setInterval(() => correr("programado"), CADA_MS);
  reloj.unref?.();
}

function detener() { if (reloj) { clearInterval(reloj); reloj = null; } }

module.exports = { hacer, verificar, listar, limpiar, arrancar, detener, DIR };
