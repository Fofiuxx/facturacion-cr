"use strict";

// El cobro: donde la orden mutable se convierte en comprobante inmutable.
// Es la frontera del diseño y todo lo delicado pasa aquí.

const path = require("path");
const { enTransaccion, uno, todos, correr, redondear, turnoAbierto } = require("./db");
const { clave, consecutivo } = require(path.join(__dirname, "..", "..", "..", "packages", "hacienda", "src", "clave"));
const { tiquete } = require(path.join(__dirname, "..", "..", "..", "packages", "hacienda", "src", "xml"));
const { firmar } = require(path.join(__dirname, "..", "..", "..", "packages", "hacienda", "src", "firmar"));

const SUCURSAL = "001";
const TERMINAL = "00001";

/**
 * Regla 3: consecutivo sin huecos ni repetidos.
 * Se toma dentro de la misma transacción que crea el comprobante. Si algo
 * falla después, el rollback devuelve el contador — cosa que una secuencia
 * de la base NO haría.
 */
function siguienteConsecutivo(tipo) {
  correr(
    `INSERT INTO contador (sucursal, terminal, tipo, ultimo) VALUES (?, ?, ?, 0)
     ON CONFLICT (sucursal, terminal, tipo) DO NOTHING`,
    SUCURSAL, TERMINAL, tipo
  );
  correr(
    `UPDATE contador SET ultimo = ultimo + 1
      WHERE sucursal = ? AND terminal = ? AND tipo = ?`,
    SUCURSAL, TERMINAL, tipo
  );
  const { ultimo } = uno(
    `SELECT ultimo FROM contador WHERE sucursal = ? AND terminal = ? AND tipo = ?`,
    SUCURSAL, TERMINAL, tipo
  );
  return { secuencia: ultimo, cadena: consecutivo({ tipo, secuencia: ultimo }) };
}

/** Los totales se calculan por línea: cada una lleva su propia tarifa. */
function totales(lineas, llevaServicio) {
  let subtotal = 0;
  let impuesto = 0;
  for (const l of lineas) {
    const monto = l.precio * l.cantidad;
    subtotal += monto;
    impuesto += Math.round(monto * (l.tarifa / 100));
  }
  const servicio = llevaServicio ? Math.round(subtotal * 0.1) : 0;
  return { subtotal, impuesto, servicio, total: subtotal + impuesto + servicio };
}

/**
 * Cobra una orden. Devuelve el comprobante ya firmado.
 * @param {object} opts.receptor  null = tiquete, objeto = factura
 * @param {string} opts.situacion normal | contingencia | sinInternet
 */
async function cobrar(ordenId, { medioPago = "Efectivo", receptor = null, situacion = "normal" } = {}) {
  const emisor = uno("SELECT * FROM emisor WHERE id = 1");

  // 1. Transacción: consecutivo, clave y congelado. Aquí muere lo mutable.
  const base = enTransaccion(() => {
    const orden = uno(
      `SELECT o.*, m.numero AS mesa_numero
         FROM orden o LEFT JOIN mesa m ON m.id = o.mesa_id
        WHERE o.id = ?`, ordenId);
    if (!orden) throw new Error(`La orden ${ordenId} no existe`);
    if (orden.estado === "cobrada") throw new Error(`La orden ${ordenId} ya está cobrada`);
    if (orden.estado === "anulada") throw new Error(`La orden ${ordenId} está anulada`);

    const lineas = todos("SELECT * FROM orden_linea WHERE orden_id = ? ORDER BY id", ordenId);
    if (!lineas.length) throw new Error("No se puede cobrar una orden sin líneas");

    const turno = turnoAbierto();
    if (!turno) throw new Error("No hay turno de caja abierto");

    // Cliente frecuente: se guarda para que la próxima factura sea de un toque.
    let receptorId = null;
    if (receptor) {
      const ya = uno("SELECT id FROM receptor WHERE identificacion = ?", receptor.id);
      if (ya) {
        receptorId = ya.id;
        correr("UPDATE receptor SET visto_en = ? WHERE id = ?", Date.now(), ya.id);
      } else {
        const r = correr(
          `INSERT INTO receptor (tipo_identificacion, identificacion, nombre,
                                 codigo_actividad, correo, visto_en)
           VALUES (?,?,?,?,?,?)`,
          receptor.tipo ?? "01", receptor.id, receptor.nombre,
          receptor.actCod ?? null, receptor.correo, Date.now()
        );
        receptorId = Number(r.lastInsertRowid);
      }
    }

    const tipo = receptor ? "FE" : "TE";
    const { cadena: cons } = siguienteConsecutivo(tipo);
    const cl = clave({ cedulaEmisor: emisor.identificacion, consecutivo: cons, situacion });

    // El servicio 10% solo aplica a servicio a mesa (Ley 4946).
    const enMesa = orden.mesa_id !== null;
    const t = totales(lineas, enMesa);
    const titulo = enMesa ? `Mesa ${orden.mesa_numero}` : `Express #${orden.numero_express ?? orden.id}`;

    const ins = correr(
      `INSERT INTO comprobante
        (tipo, consecutivo, clave, situacion, orden_id, turno_id, receptor_id, titulo,
         fecha, medio_pago, subtotal, impuesto, servicio, total, receptor_snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tipo, cons, cl, { normal: "1", contingencia: "2", sinInternet: "3" }[situacion],
      ordenId, turno.id, receptorId, titulo, Date.now(), medioPago,
      t.subtotal, t.impuesto, t.servicio, t.total,
      receptor ? JSON.stringify(receptor) : null
    );
    const compId = Number(ins.lastInsertRowid);

    // Líneas normalizadas: los reportes por producto y por tarifa las necesitan.
    lineas.forEach((l, i) => {
      const sub = l.precio * l.cantidad;
      const imp = Math.round(sub * (l.tarifa / 100));
      correr(
        `INSERT INTO comprobante_linea
          (comprobante_id, numero_linea, cabys, nombre, cantidad, precio,
           subtotal, tarifa, impuesto, total_linea)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        compId, i + 1, l.cabys, l.nombre, l.cantidad, l.precio, sub, l.tarifa, imp, sub + imp
      );
    });

    correr(
      `INSERT INTO pago (comprobante_id, fecha, monto, medio) VALUES (?,?,?,?)`,
      compId, Date.now(), t.total, medioPago
    );

    correr("UPDATE orden SET estado = 'cobrada', cerrada_en = ? WHERE id = ?", Date.now(), ordenId);

    return { comp: uno("SELECT * FROM comprobante WHERE id = ?", compId), lineas, emisor, t };
  });

  // 2. Firma. Fuera de la transacción: es lento y no debe sostener el lock.
  //    Si falla, el comprobante queda emitido y pendiente — que es correcto:
  //    el consecutivo ya se consumió y no se puede reusar.
  const xml = tiquete({
    clave: base.comp.clave,
    consecutivo: base.comp.consecutivo,
    emisor: {
      nombre: base.emisor.nombre,
      tipoIdentificacion: base.emisor.tipo_identificacion,
      identificacion: base.emisor.identificacion,
      codigoActividad: base.emisor.codigo_actividad,
      correo: base.emisor.correo,
    },
    lineas: base.lineas.map((l) => ({
      cabys: l.cabys,
      detalle: l.nombre,
      cantidad: l.cantidad,
      precioUnitario: l.precio / 100000,
      codigoTarifa: l.tarifa === 13 ? "08" : l.tarifa === 1 ? "02" : "01",
      tarifa: l.tarifa,
    })),
  });

  const fs = require("fs");
  const p12 = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "packages", "hacienda", "llave-prueba.p12")
  );
  const { xml: firmado } = await firmar(xml, { p12, pin: "1234" });

  // El XML se guarda tal cual sale del firmador. Reformatearlo rompe la firma.
  correr("UPDATE comprobante SET xml_firmado = ? WHERE id = ?", firmado, base.comp.id);

  return {
    ...base.comp,
    xml_firmado: firmado,
    montos: {
      subtotal: redondear(base.t.subtotal),
      impuesto: redondear(base.t.impuesto),
      servicio: redondear(base.t.servicio),
      total: redondear(base.t.total),
    },
  };
}

/**
 * Nota de crédito: la única forma de echar atrás una venta ya cobrada.
 *
 * No se edita ni se borra el comprobante original —es inmutable— sino que se
 * emite otro documento que lo referencia y lo anula. Es la aplicación directa
 * de la regla 2 del diseño.
 */
async function notaCredito(comprobanteId, { motivo, usuarioId }) {
  if (!motivo) throw new Error("Una nota de crédito necesita motivo");
  const emisor = uno("SELECT * FROM emisor WHERE id = 1");

  const base = enTransaccion(() => {
    const orig = uno("SELECT * FROM comprobante WHERE id = ?", comprobanteId);
    if (!orig) throw new Error("El comprobante no existe");
    if (orig.tipo === "NC") throw new Error("No se le hace nota de crédito a otra nota de crédito");
    const ya = uno("SELECT id FROM comprobante WHERE referencia_id = ? AND tipo = 'NC'", comprobanteId);
    if (ya) throw new Error("Ese comprobante ya fue anulado con una nota de crédito");

    const turno = turnoAbierto();
    if (!turno) throw new Error("No hay turno de caja abierto");

    const { cadena: cons } = siguienteConsecutivo("NC");
    const cl = clave({ cedulaEmisor: emisor.identificacion, consecutivo: cons, situacion: "normal" });

    const ins = correr(
      `INSERT INTO comprobante
        (tipo, consecutivo, clave, situacion, orden_id, turno_id, receptor_id, referencia_id,
         titulo, fecha, medio_pago, subtotal, impuesto, servicio, total, receptor_snapshot)
       VALUES ('NC',?,?,'1',?,?,?,?,?,?,?,?,?,?,?,?)`,
      cons, cl, orig.orden_id, turno.id, orig.receptor_id, orig.id,
      `Anula ${orig.consecutivo}`, Date.now(), orig.medio_pago,
      orig.subtotal, orig.impuesto, orig.servicio, orig.total, orig.receptor_snapshot
    );
    const ncId = Number(ins.lastInsertRowid);

    // Las líneas se copian tal cual: la NC revierte exactamente lo facturado.
    const lineas = todos(
      "SELECT * FROM comprobante_linea WHERE comprobante_id = ? ORDER BY numero_linea", orig.id);
    for (const l of lineas) {
      correr(
        `INSERT INTO comprobante_linea
          (comprobante_id, numero_linea, cabys, nombre, cantidad, precio,
           subtotal, tarifa, impuesto, total_linea)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ncId, l.numero_linea, l.cabys, l.nombre, l.cantidad, l.precio,
        l.subtotal, l.tarifa, l.impuesto, l.total_linea
      );
    }

    correr("UPDATE comprobante SET ultimo_error = ? WHERE id = ?",
      `Anulado por NC ${cons}: ${motivo}`, orig.id);

    return { nc: uno("SELECT * FROM comprobante WHERE id = ?", ncId), lineas, orig };
  });

  // Firma fuera de la transacción, igual que en el cobro.
  const xml = tiquete({
    clave: base.nc.clave,
    consecutivo: base.nc.consecutivo,
    emisor: {
      nombre: emisor.nombre, tipoIdentificacion: emisor.tipo_identificacion,
      identificacion: emisor.identificacion, codigoActividad: emisor.codigo_actividad,
      correo: emisor.correo,
    },
    lineas: base.lineas.map((l) => ({
      cabys: l.cabys, detalle: l.nombre, cantidad: l.cantidad,
      precioUnitario: l.precio / 100000,
      codigoTarifa: l.tarifa === 13 ? "08" : l.tarifa === 1 ? "02" : "01",
      tarifa: l.tarifa,
    })),
  });

  const fs = require("fs");
  const p12 = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "packages", "hacienda", "llave-prueba.p12"));
  const { xml: firmado } = await firmar(xml, { p12, pin: "1234" });
  correr("UPDATE comprobante SET xml_firmado = ? WHERE id = ?", firmado, base.nc.id);

  return {
    ...base.nc,
    anula: base.orig.consecutivo,
    motivoNota: motivo,
    montos: {
      subtotal: redondear(base.nc.subtotal), impuesto: redondear(base.nc.impuesto),
      servicio: redondear(base.nc.servicio), total: redondear(base.nc.total),
    },
  };
}

module.exports = { cobrar, notaCredito, totales, siguienteConsecutivo };
