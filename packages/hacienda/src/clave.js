"use strict";

// Clave numérica (50) y consecutivo (20) según la estructura de comprobantes
// electrónicos de Costa Rica. Verificar longitudes y códigos contra el anexo
// oficial de MH-DGT-RES-0027-2024 antes de producción.

const TIPOS = {
  FE: "01", // factura electrónica
  ND: "02",
  NC: "03",
  TE: "04", // tiquete electrónico
  FEC: "08",
  FEE: "09",
  REP: "10", // nuevo en 4.4
};

const SITUACION = { normal: "1", contingencia: "2", sinInternet: "3" };

const pad = (v, n) => String(v).padStart(n, "0");

/** 20 dígitos: sucursal(3) + terminal(5) + tipo(2) + secuencia(10) */
function consecutivo({ sucursal = 1, terminal = 1, tipo, secuencia }) {
  const cod = TIPOS[tipo];
  if (!cod) throw new Error(`Tipo de documento desconocido: ${tipo}`);
  const out = pad(sucursal, 3) + pad(terminal, 5) + cod + pad(secuencia, 10);
  if (out.length !== 20) throw new Error(`Consecutivo con ${out.length} dígitos, deben ser 20`);
  return out;
}

/** 50 dígitos: país(3) + DDMMAA(6) + cédula(12) + consecutivo(20) + situación(1) + seguridad(8) */
function clave({ cedulaEmisor, consecutivo: cons, fecha = new Date(), situacion = "normal", codigoSeguridad }) {
  const sit = SITUACION[situacion];
  if (!sit) throw new Error(`Situación desconocida: ${situacion}`);
  if (cons.length !== 20) throw new Error("El consecutivo debe traer 20 dígitos");

  const f =
    pad(fecha.getDate(), 2) +
    pad(fecha.getMonth() + 1, 2) +
    pad(fecha.getFullYear() % 100, 2);

  const seg = codigoSeguridad ?? pad(Math.floor(Math.random() * 1e8), 8);
  const out = "506" + f + pad(cedulaEmisor, 12) + cons + sit + pad(seg, 8);

  if (out.length !== 50) throw new Error(`Clave con ${out.length} dígitos, deben ser 50`);
  return out;
}

module.exports = { clave, consecutivo, TIPOS, SITUACION };
