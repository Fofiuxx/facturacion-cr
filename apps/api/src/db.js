"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

// Dinero: entero escalado. Toda entrada pasa por aquí y nunca sale un float
// a la base. 5 decimales, los que acepta Hacienda.
const ESCALA = 100000;

const aEntero = (colones) => {
  const n = Math.round(Number(colones) * ESCALA);
  if (!Number.isSafeInteger(n)) throw new Error(`Monto fuera de rango: ${colones}`);
  return n;
};
const aColones = (entero) => entero / ESCALA;
/** Para mostrar e imprimir: colones enteros, que es como se cobra en CR. */
const redondear = (entero) => Math.round(entero / ESCALA);

let db;

function abrir(archivo = path.join(__dirname, "..", "datos.db")) {
  db = new DatabaseSync(archivo);
  db.exec(fs.readFileSync(path.join(__dirname, "..", "esquema.sql"), "utf8"));
  return db;
}

/** Transacción real: si algo falla, no queda nada a medias. */
function enTransaccion(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const uno = (sql, ...p) => db.prepare(sql).get(...p);
const todos = (sql, ...p) => db.prepare(sql).all(...p);
const correr = (sql, ...p) => db.prepare(sql).run(...p);

function semilla() {
  if (uno("SELECT id FROM emisor WHERE id = 1")) return;

  correr(
    `INSERT INTO emisor (id, nombre, nombre_comercial, tipo_identificacion, identificacion,
                         codigo_actividad, provincia, canton, distrito, otras_senas, telefono, correo)
     VALUES (1,?,?,?,?,?,?,?,?,?,?,?)`,
    "Restaurante Prueba S.A.", "Soda La Esquina", "02", "3101456789", "561000",
    "San José", "Escazú", "San Rafael", "200m sur del parque", "2288-0000",
    "facturacion@restaurante.cr"
  );

  // El certificado real se carga cifrado; aquí solo queda la metadata.
  correr(
    `INSERT INTO certificado (id, vence_en, ambiente, emitido_en)
     VALUES (1, ?, 'sandbox', ?)`,
    Date.now() + 730 * 86400000, Date.now()
  );

  correr("INSERT INTO sucursal (codigo, nombre) VALUES ('001','Casa matriz')");
  correr("INSERT INTO terminal (sucursal_id, codigo, nombre) VALUES (1,'00001','Caja principal')");

  // PINes de arranque. En producción se cambian al primer ingreso.
  const { hashear } = require("./auth");
  const usuarios = [
    ["Kevin Mora", "salonero", "1111"],
    ["Marta Chaves", "cocina", "4444"],
    ["Silvia Rojas", "caja", "2222"],
    ["Rafael Núñez", "admin", "3333"],
  ];
  for (const [n, r, pin] of usuarios) {
    correr("INSERT INTO usuario (nombre, rol, pin_hash) VALUES (?,?,?)", n, r, hashear(pin));
  }

  correr("INSERT INTO salon (nombre) VALUES ('Salón principal')");
  correr("INSERT INTO salon (nombre) VALUES ('Terraza')");
  for (const n of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    correr("INSERT INTO mesa (salon_id, numero, capacidad) VALUES (1,?,4)", n);
  }
  for (const n of ["T1", "T2"]) {
    correr("INSERT INTO mesa (salon_id, numero, capacidad) VALUES (2,?,6)", n);
  }

  // Menú de restaurante. Todo al 13%: en un restaurante prácticamente no hay
  // otra tarifa, porque lo que se vende es servicio de comida preparada.
  // La capacidad de manejar tarifas mixtas existe y está probada, pero meterla
  // en el menú de ejemplo daba un restaurante que vendía abarrotes.
  const productos = [
    ["Casado de pollo",   "Platos",  5900, "6311100000000", 13, "08"],
    ["Casado de pescado", "Platos",  7200, "6311100000000", 13, "08"],
    ["Arroz con pollo",   "Platos",  4800, "6311100000000", 13, "08"],
    ["Ceviche",           "Platos",  4500, "6311100000000", 13, "08"],
    ["Chifrijo",          "Platos",  4900, "6311100000000", 13, "08"],
    ["Olla de carne",     "Platos",  6800, "6311100000000", 13, "08"],
    ["Gallo pinto",       "Platos",  3200, "6311100000000", 13, "08"],
    ["Patacones",         "Bocas",   3400, "6311100000000", 13, "08"],
    ["Chicharrones",      "Bocas",   3900, "6311100000000", 13, "08"],
    ["Refresco natural",  "Bebidas", 1500, "6311200000000", 13, "08"],
    ["Café chorreado",    "Bebidas", 1200, "6311200000000", 13, "08"],
    ["Agua embotellada",  "Bebidas",  900, "6311200000000", 13, "08"],
    ["Fresco de cas",     "Bebidas", 1600, "6311200000000", 13, "08"],
    ["Tres leches",       "Postres", 2800, "6311300000000", 13, "08"],
    ["Flan de coco",      "Postres", 2400, "6311300000000", 13, "08"],
    ["Imperial",          "Bar",     2200, "6311200000100", 13, "08"],
    ["Guaro sour",        "Bar",     3500, "6311200000100", 13, "08"],
  ];
  for (const [nombre, cat, precio, cabys, tarifa, ct] of productos) {
    correr(
      `INSERT INTO producto (nombre, categoria, precio, cabys, tarifa, codigo_tarifa)
       VALUES (?,?,?,?,?,?)`,
      nombre, cat, aEntero(precio), cabys, tarifa, ct
    );
  }

  // Turno abierto: sin turno no se puede cobrar ni cuadrar el arqueo.
  correr(
    `INSERT INTO turno (terminal_id, usuario_id, abierto_en, monto_apertura)
     VALUES (1, 2, ?, ?)`,
    Date.now(), aEntero(50000)
  );
}

/** El turno abierto de la caja. Null si nadie abrió. */
const turnoAbierto = () => uno("SELECT * FROM turno WHERE cerrado_en IS NULL ORDER BY id DESC");

module.exports = {
  abrir, enTransaccion, uno, todos, correr, semilla, turnoAbierto,
  aEntero, aColones, redondear, ESCALA,
  get db() { return db; },
};
