"use strict";

// Búsqueda en el catálogo CABYS de Hacienda.
//
// Nadie se sabe códigos de 13 dígitos. Se busca por descripción y el código
// —con su tarifa de IVA— sale del catálogo. Misma regla que el padrón: la
// consulta va desde el servidor y se cachea.
//
// La tarifa que trae el catálogo es DE REFERENCIA. La responsabilidad de
// aplicar la correcta es del contribuyente, así que el producto puede
// guardarla ajustada (ver producto.tarifa_ajustada).

const { uno, correr, todos } = require("./db");

const URL = "https://api.hacienda.go.cr/fe/cabys";
const TIMEOUT_MS = 6000;

// Para trabajar sin internet. Códigos ilustrativos, no del catálogo real.
const LOCAL = [
  ["6311100000000", "Servicio de comidas preparadas en restaurante", 13],
  ["6311200000000", "Servicio de bebidas no alcohólicas en restaurante", 13],
  ["6311200000100", "Servicio de bebidas alcohólicas en restaurante", 13],
  ["6311300000000", "Servicio de postres y repostería", 13],
  ["0112100000000", "Arroz sin elaborar", 1],
  ["0141200000000", "Frijol negro", 1],
  ["2211100000000", "Leche fluida pasteurizada", 1],
  ["2313100000000", "Pan corriente", 1],
  ["3520100000000", "Medicamentos de uso humano", 2],
  ["9312100000000", "Servicios de salud humana privados", 4],
  ["8511100000000", "Servicios de educación preescolar", 0],
];

const guardarCache = (c) =>
  correr(
    `INSERT INTO cabys (codigo, descripcion, tarifa, consultado_en) VALUES (?,?,?,?)
     ON CONFLICT (codigo) DO UPDATE SET descripcion = excluded.descripcion,
       tarifa = excluded.tarifa, consultado_en = excluded.consultado_en`,
    c.codigo, c.descripcion, c.tarifa, Date.now()
  );

const localMatch = (q) =>
  LOCAL.filter(([cod, desc]) =>
    cod.startsWith(q) || desc.toLowerCase().includes(q.toLowerCase())
  ).map(([codigo, descripcion, tarifa]) => ({ codigo, descripcion, tarifa, origen: "datos de prueba" }));

async function buscar(q) {
  const texto = String(q ?? "").trim();
  if (texto.length < 3) throw new Error("Escribí al menos 3 caracteres");

  const esCodigo = /^\d{13}$/.test(texto);
  const url = esCodigo ? `${URL}?codigo=${texto}` : `${URL}?q=${encodeURIComponent(texto)}&top=8`;

  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (r.status === 429) throw new Error("Hacienda está limitando las consultas");
    if (!r.ok) throw new Error(`Hacienda respondió ${r.status}`);

    const d = await r.json();
    const lista = (Array.isArray(d) ? d : d.cabys ?? d.resultado ?? []).map((x) => ({
      codigo: String(x.codigo ?? x.Codigo ?? ""),
      descripcion: x.descripcion ?? x.Descripcion ?? "",
      tarifa: Number(x.impuesto ?? x.Impuesto ?? x.tarifa ?? 13),
    })).filter((x) => x.codigo.length === 13);

    if (!lista.length) {
      const l = localMatch(texto);
      return l.length ? l : [];
    }
    lista.forEach(guardarCache);
    return lista.map((x) => ({ ...x, origen: "hacienda" }));
  } catch (e) {
    // Sin conexión: primero lo que ya se consultó, luego el catálogo de prueba.
    const cache = todos(
      `SELECT codigo, descripcion, tarifa FROM cabys
        WHERE codigo LIKE ? OR lower(descripcion) LIKE ? LIMIT 8`,
      texto + "%", "%" + texto.toLowerCase() + "%"
    );
    if (cache.length) return cache.map((x) => ({ ...x, origen: "caché" }));
    return localMatch(texto);
  }
}

module.exports = { buscar, LOCAL };
