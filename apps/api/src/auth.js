"use strict";

// Autenticación por PIN. En un POS nadie escribe una contraseña larga en una
// tablet con fila de gente, así que el PIN es la única opción usable — pero
// 4 dígitos son 10.000 combinaciones, así que el bloqueo por intentos no es
// opcional: es lo único que lo hace seguro.

const crypto = require("node:crypto");
const { uno, todos, correr } = require("./db");

const MAX_FALLIDOS = 5;
const BLOQUEO_MS = 60 * 1000;
const SESION_MS = 12 * 60 * 60 * 1000;   // un turno largo

/** scrypt: lento a propósito, para que probar PINes cueste. */
function hashear(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}:${h}`;
}

function verificar(pin, guardado) {
  if (!guardado) return false;
  const [salt, h] = guardado.split(":");
  const calc = crypto.scryptSync(String(pin), salt, 32);
  const esperado = Buffer.from(h, "hex");
  // Comparación en tiempo constante: comparar con === filtra por el tiempo.
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}

/** Para la pantalla de login: nombres y roles, nunca hashes. */
const listar = () =>
  todos("SELECT id, nombre, rol FROM usuario WHERE activo = 1 ORDER BY rol, nombre");

function entrar(usuarioId, pin, dispositivo) {
  const u = uno("SELECT * FROM usuario WHERE id = ? AND activo = 1", usuarioId);
  // Mismo mensaje si el usuario no existe o el PIN está mal: no se le dice a
  // nadie cuáles usuarios son válidos.
  const generico = new Error("Usuario o PIN incorrecto");
  if (!u) throw generico;

  if (u.bloqueado_hasta && u.bloqueado_hasta > Date.now()) {
    const seg = Math.ceil((u.bloqueado_hasta - Date.now()) / 1000);
    throw new Error(`Demasiados intentos. Esperá ${seg} segundos`);
  }

  if (!verificar(pin, u.pin_hash)) {
    const fallidos = u.fallidos + 1;
    const bloquear = fallidos >= MAX_FALLIDOS;
    correr(
      "UPDATE usuario SET fallidos = ?, bloqueado_hasta = ? WHERE id = ?",
      bloquear ? 0 : fallidos, bloquear ? Date.now() + BLOQUEO_MS : null, u.id
    );
    if (bloquear) throw new Error("Demasiados intentos. Esperá 60 segundos");
    throw generico;
  }

  correr("UPDATE usuario SET fallidos = 0, bloqueado_hasta = NULL WHERE id = ?", u.id);

  const token = crypto.randomBytes(32).toString("hex");
  correr(
    "INSERT INTO sesion (token, usuario_id, creada_en, vence_en, dispositivo) VALUES (?,?,?,?,?)",
    token, u.id, Date.now(), Date.now() + SESION_MS, dispositivo ?? null
  );
  return { token, usuario: { id: u.id, nombre: u.nombre, rol: u.rol } };
}

function salir(token) {
  correr("DELETE FROM sesion WHERE token = ?", token);
}

/** Devuelve el usuario de la sesión, o null. Limpia las vencidas de paso. */
function sesion(token) {
  if (!token) return null;
  correr("DELETE FROM sesion WHERE vence_en < ?", Date.now());
  const s = uno(
    `SELECT u.id, u.nombre, u.rol FROM sesion s
       JOIN usuario u ON u.id = s.usuario_id
      WHERE s.token = ? AND s.vence_en > ? AND u.activo = 1`,
    token, Date.now()
  );
  return s ?? null;
}

// Qué puede hacer cada rol. Lo que no está listado, nadie.
const SERVICIO = ["salonero", "caja", "admin"];
const TODOS = ["salonero", "cocina", "caja", "admin"];
const PERMISOS = {
  "GET /menu": SERVICIO,
  "GET /estado": TODOS,
  "GET /yo": TODOS,
  "POST /logout": TODOS,

  // Cocina prepara; no toma pedidos ni cobra.
  "GET /cocina": ["cocina", "caja", "admin"],
  "POST /cocina/lista": ["cocina", "caja", "admin"],
  "POST /ordenes/cocina": SERVICIO,

  "POST /ordenes": SERVICIO,
  "POST /lineas": SERVICIO,
  "POST /lineas/quitar": SERVICIO,
  "POST /ordenes/cuenta": SERVICIO,
  "POST /ordenes/mover": SERVICIO,
  "POST /ordenes/anular": SERVICIO,  // con líneas se restringe dentro del endpoint
  "POST /cobrar": ["caja", "admin"], // el salonero no cobra
  "GET /padron": ["caja", "admin"],  // solo quien factura consulta el padrón
  "GET /receptores": ["caja", "admin"],
  "GET /turno": ["caja", "admin"],
  "POST /turno/abrir": ["caja", "admin"],
  "POST /turno/cerrar": ["caja", "admin"],
  "GET /comprobantes": ["admin"],
  "GET /reportes": ["admin"],

  // Anular una venta ya cobrada emite un documento fiscal: no es del salonero.
  "POST /notas-credito": ["admin"],
  "POST /transmitir": ["admin"],

  // Quien vende no define qué se vende ni a qué precio.
  "GET /cabys": ["admin"],
  "GET /productos": ["admin"],
  "POST /productos": ["admin"],
  "POST /productos/activo": ["admin"],
  "POST /productos/borrar": ["admin"],
  "GET /usuarios/todos": ["admin"],
  "POST /usuarios": ["admin"],
  "POST /usuarios/activo": ["admin"],
  "GET /certificado": ["admin"],
  "GET /respaldos": ["admin"],
  "POST /respaldos": ["admin"],
  "POST /respaldos/verificar": ["admin"],
};

const puede = (rol, ruta) => (PERMISOS[ruta] ?? []).includes(rol);

module.exports = { hashear, verificar, listar, entrar, salir, sesion, puede, PERMISOS };
