"use strict";

// Cola de transmisión a Hacienda.
//
// Sin esto, un comprobante emitido en contingencia se queda en la base para
// siempre a menos que alguien entre al back-office y toque un botón. Nadie va
// a hacer eso todos los días, y acumular comprobantes sin transmitir es un
// problema fiscal, no un detalle técnico.

const { uno, todos, correr } = require("./db");

const CADA_MS = 30 * 1000;
const BASE_MS = 30 * 1000;       // primer reintento
const TECHO_MS = 30 * 60 * 1000; // no esperar más de media hora
const LOTE = 10;

let reloj = null;
let avisoSinLlave = false;

/** Espera creciente: 30s, 1m, 2m, 4m… hasta media hora. */
function listoParaReintentar(c, ahora = Date.now()) {
  if (!c.enviado_en) return true;
  const espera = Math.min(BASE_MS * 2 ** Math.min(c.intentos, 10), TECHO_MS);
  return ahora - c.enviado_en >= espera;
}

function pendientes() {
  return todos(
    `SELECT id, consecutivo, intentos, enviado_en FROM comprobante
      WHERE estado_hacienda IN ('pendiente','error')
      ORDER BY id LIMIT ?`, LOTE);
}

/** ¿Hay con qué transmitir? Sin llave no tiene sentido intentar. */
function hayCredenciales() {
  const c = uno("SELECT p12_cifrado, usuario_api FROM certificado WHERE id = 1");
  return !!(c && c.p12_cifrado && c.usuario_api);
}

/**
 * Un ciclo. Devuelve qué pasó, para que la prueba y el endpoint manual usen
 * exactamente el mismo camino.
 */
async function ciclo({ forzar = false } = {}) {
  const cola = pendientes();
  if (!cola.length) return { revisados: 0, enviados: 0, motivo: "cola vacía" };

  if (!hayCredenciales()) {
    if (!avisoSinLlave) {
      console.log(`  cola: ${cola.length} comprobante(s) esperando. Falta la llave de TRIBU-CR.`);
      avisoSinLlave = true;
    }
    return { revisados: cola.length, enviados: 0, motivo: "sin credenciales de Hacienda" };
  }

  const ahora = Date.now();
  const toca = forzar ? cola : cola.filter((c) => listoParaReintentar(c, ahora));
  let enviados = 0;

  for (const c of toca) {
    try {
      // FASE 0.5: aquí va el POST real a recepción y luego el polling del
      // estado. Hasta que exista la llave, no hay nada que llamar.
      throw new Error("Transmisión real pendiente: falta la llave de TRIBU-CR");
    } catch (e) {
      correr(
        `UPDATE comprobante SET intentos = intentos + 1, enviado_en = ?,
                estado_hacienda = 'error', ultimo_error = ? WHERE id = ?`,
        ahora, e.message, c.id
      );
    }
  }

  return { revisados: cola.length, tocaban: toca.length, enviados, motivo: "intentado" };
}

function arrancar(alCambiar) {
  if (reloj) return;
  reloj = setInterval(async () => {
    try {
      const r = await ciclo();
      if (r.tocaban > 0 && alCambiar) alCambiar();
    } catch (e) {
      console.error("  cola: error inesperado —", e.message);
    }
  }, CADA_MS);
  reloj.unref?.();  // que no impida cerrar el proceso
}

function detener() {
  if (reloj) { clearInterval(reloj); reloj = null; }
}

module.exports = { ciclo, arrancar, detener, pendientes, listoParaReintentar, hayCredenciales };
