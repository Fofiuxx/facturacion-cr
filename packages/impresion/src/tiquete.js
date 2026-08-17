"use strict";

// Render de un comprobante a ESC/POS. El tiquete es un documento legal:
// lo que sale aquí tiene que cuadrar con el XML que se transmitió.

const { Ticket } = require("./escpos");

const monto = (n) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const fechaHora = (d) => {
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** La clave va en grupos: 50 dígitos seguidos no los lee nadie. */
const agrupar = (clave, n = 10) => (clave.match(new RegExp(`.{1,${n}}`, "g")) ?? []).join(" ");

const SITUACION = {
  "1": null,
  "2": "EMITIDO EN CONTINGENCIA",
  "3": "EMITIDO SIN CONEXION",
};

const TITULO = {
  TE: "TIQUETE ELECTRONICO",
  FE: "FACTURA ELECTRONICA",
  NC: "NOTA DE CREDITO",
  ND: "NOTA DE DEBITO",
  REP: "RECIBO ELECTRONICO DE PAGO",
};

function render(c, { emisor, ancho = 48 } = {}) {
  const t = new Ticket(ancho);
  const esFactura = c.tipo === "FE";
  const esNota = c.tipo === "NC";

  t.alinear("centro").negrita(true).tamano(1, 2);
  t.linea(emisor.nombre);
  t.tamano(1, 1).negrita(false);
  if (emisor.nombreComercial) t.linea(emisor.nombreComercial);
  t.linea(`Ced. ${emisor.identificacion}`);
  t.parrafo(emisor.direccion, ancho);
  if (emisor.telefono) t.linea(`Tel. ${emisor.telefono}`);

  t.linea();
  t.negrita(true).linea(TITULO[c.tipo] ?? "COMPROBANTE ELECTRONICO").negrita(false);
  t.linea(`v4.4  ${c.cons}`);
  if (esNota && c.anula) {
    t.linea();
    t.parrafo(`Anula el comprobante ${c.anula}`, ancho);
    if (c.motivo) t.parrafo(`Motivo: ${c.motivo}`, ancho);
  }

  const aviso = SITUACION[c.sit ?? "1"];
  if (aviso) {
    t.linea();
    t.negrita(true).linea(aviso).negrita(false);
    t.parrafo("Este comprobante es valido. Se transmitira a Hacienda al restablecerse la conexion.", ancho);
  }

  t.alinear("izq").separador();
  t.fila(fechaHora(new Date(c.fecha)), c.titulo);
  if (c.receptor) {
    t.linea();
    t.linea("Cliente:");
    t.parrafo(c.receptor.nombre, ancho);
    t.linea(`Ced. ${c.receptor.id}`);
    if (c.receptor.actCod) t.linea(`Act. economica ${c.receptor.actCod}`);
  }
  t.separador();

  t.linea("Montos en colones");
  t.linea();
  for (const l of c.lineas) {
    t.parrafo(l.nombre, ancho);
    const izq = `  ${l.qty} x ${monto(l.precio)}`;
    const der = `${monto(l.precio * l.qty)}  ${l.iva === 0 ? "E" : l.iva + "%"}`;
    t.fila(izq, der);
  }

  t.separador();
  t.fila("Subtotal", monto(c.sub), ".");
  t.fila("IVA", monto(c.iva), ".");
  if (c.svc > 0) t.fila("Servicio 10%", monto(c.svc), ".");

  t.negrita(true).tamano(1, 2);
  t.fila("TOTAL", monto(c.total));
  t.tamano(1, 1).negrita(false);

  t.linea();
  t.fila("Pago", c.medio);

  t.linea();
  t.alinear("centro").linea("Clave numerica");
  t.tamano(1, 1);
  for (const trozo of agrupar(c.clave, 25).split(" ").reduce((acc, x, i) => {
    const j = Math.floor(i / 1);
    acc[j] = x;
    return acc;
  }, [])) t.linea(trozo);

  t.linea();
  t.qr(c.clave);
  t.linea();
  t.parrafo("Autorizado mediante resolucion MH-DGT-RES-0027-2024", ancho);
  if (c.receptor) t.parrafo(`Enviado a ${c.receptor.correo}`, ancho);
  t.linea("Gracias por su visita");

  t.cortar();
  return t;
}

module.exports = { render, monto, agrupar };
