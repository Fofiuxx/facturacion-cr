"use strict";

// Consulta al padrón de Hacienda.
//
// La 4.4 volvió obligatorio el código de actividad económica del receptor, y
// pedírselo al cliente en el mostrador es inviable: nadie se lo sabe. Esto lo
// resuelve: se digita la cédula y el resto se autocompleta.
//
// LA CONSULTA VA DESDE EL SERVIDOR, NUNCA DESDE EL POS. Hacienda limita por
// tasa y responde 429; diez tablets preguntando en paralelo se auto-bloquean.

const { uno, correr } = require("./db");

const URL_HACIENDA = "https://api.hacienda.go.cr/fe/ae";
const VIGENCIA_MS = 30 * 24 * 3600 * 1000;   // un mes: las actividades casi no cambian
const TIMEOUT_MS = 6000;

// Datos de prueba, para trabajar sin internet.
//
// OJO: las cédulas costarricenses son secuenciales — cualquier número de 9
// dígitos con forma válida PERTENECE A ALGUIEN. Inventar una para pruebas
// significa consultar los datos de una persona real. Por eso estas empiezan
// con 9, que no corresponde a ninguna provincia y Hacienda siempre rechaza.
const LOCAL = {
  "9101123456": { nombre: "Comercializadora de Prueba S.A.", tipo: "02",
    actividades: [{ codigo: "721101", descripcion: "Venta al por mayor de alimentos" },
                  { codigo: "620100", descripcion: "Programación informática" }] },
  "998760543": { nombre: "Bufete de Prueba", tipo: "01",
    actividades: [{ codigo: "691001", descripcion: "Servicios jurídicos" }] },
  // Sin actividad: cualquier persona puede pedir factura, tenga o no negocio.
  "995670891": { nombre: "Persona de Prueba", tipo: "01", actividades: [] },
};

/**
 * Hacienda no lo reconoce. Si es una identificación de prueba, se devuelve el
 * dato sintético para poder trabajar sin usar cédulas de personas reales.
 */
const noHallado = (id) => {
  if (LOCAL[id]) return { identificacion: id, ...LOCAL[id], origen: "datos de prueba" };
  return { identificacion: id, noEncontrado: true, origen: "hacienda" };
};

const guardar = (id, d, origen) => {
  correr(
    `INSERT INTO padron (identificacion, nombre, tipo, actividades, consultado_en, origen)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (identificacion) DO UPDATE SET
       nombre = excluded.nombre, tipo = excluded.tipo,
       actividades = excluded.actividades, consultado_en = excluded.consultado_en,
       origen = excluded.origen`,
    id, d.nombre, d.tipo ?? null, JSON.stringify(d.actividades ?? []), Date.now(), origen
  );
};

async function consultar(cedula) {
  const id = String(cedula ?? "").replace(/\D/g, "");
  if (id.length < 9 || id.length > 12) {
    throw new Error("La cédula lleva entre 9 y 12 dígitos");
  }

  const cache = uno("SELECT * FROM padron WHERE identificacion = ?", id);
  if (cache && Date.now() - cache.consultado_en < VIGENCIA_MS) {
    return {
      identificacion: id, nombre: cache.nombre, tipo: cache.tipo,
      actividades: JSON.parse(cache.actividades), origen: "caché",
    };
  }

  try {
    const r = await fetch(`${URL_HACIENDA}?identificacion=${id}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });

    if (r.status === 429) throw new Error("Hacienda está limitando las consultas. Probá en un momento");
    if (r.status === 404 || r.status === 400) return noHallado(id);
    if (!r.ok) throw new Error(`Hacienda respondió ${r.status}`);

    const d = await r.json();
    const dato = {
      nombre: d.nombre,
      tipo: d.tipoIdentificacion,
      actividades: (d.actividades ?? [])
        .filter((a) => a.estado === "A" || a.estado === undefined)
        .map((a) => ({ codigo: String(a.codigo), descripcion: a.descripcion })),
    };
    if (!dato.nombre) return noHallado(id);

    guardar(id, dato, "hacienda");
    return { identificacion: id, ...dato, origen: "hacienda" };
  } catch (e) {
    // Sin internet o Hacienda caído: se usa lo que haya en caché aunque esté
    // vencido, y si no, el catálogo local. La factura no se puede detener
    // porque el padrón no conteste.
    if (cache) {
      return {
        identificacion: id, nombre: cache.nombre, tipo: cache.tipo,
        actividades: JSON.parse(cache.actividades), origen: "caché vencida",
      };
    }
    if (LOCAL[id]) {
      guardar(id, LOCAL[id], "local");
      return { identificacion: id, ...LOCAL[id], origen: "local" };
    }
    return { identificacion: id, noEncontrado: true, origen: "sin conexión", detalle: e.message };
  }
}

module.exports = { consultar, LOCAL };
