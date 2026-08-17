"use strict";

// Fase 0b: ¿se puede armar el tiquete ESC/POS desde Node?
// La impresora real no hace falta para responderlo: el flujo de bytes se
// valida aquí y se manda con `node agente.js`.

const fs = require("fs");
const path = require("path");
const { render } = require("./src/tiquete");

const EMISOR = {
  nombre: "RESTAURANTE PRUEBA S.A.",
  nombreComercial: "Soda La Esquina",
  identificacion: "3-101-456789",
  direccion: "San José, Escazú, San Rafael, 200m sur del parque",
  telefono: "2288-0000",
};

const COMPROBANTE = {
  tipo: "TE",
  cons: "00100001040000000042",
  clave: "50606082600310145678900100001040000000042129386851",
  sit: "3", // sin conexión, para ver el aviso de contingencia
  titulo: "Mesa 7",
  fecha: Date.now(),
  medio: "Efectivo",
  receptor: null,
  lineas: [
    { nombre: "Casado de pollo", precio: 5900, qty: 2, iva: 13 },
    { nombre: "Ceviche", precio: 4500, qty: 1, iva: 13 },
    { nombre: "Refresco natural de cas grande", precio: 1500, qty: 3, iva: 13 },
    { nombre: "Bolsa de arroz 1 kg", precio: 1350, qty: 1, iva: 1 },
  ],
};

const sub = COMPROBANTE.lineas.reduce((a, l) => a + l.precio * l.qty, 0);
const iva = COMPROBANTE.lineas.reduce((a, l) => a + l.precio * l.qty * (l.iva / 100), 0);
COMPROBANTE.sub = sub;
COMPROBANTE.iva = iva;
COMPROBANTE.svc = sub * 0.1;
COMPROBANTE.total = sub + iva + COMPROBANTE.svc;

const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FALLA ${m}`); errores++; };
let errores = 0;

console.log("\nFase 0b — tiquete ESC/POS 80mm\n");

const t = render(COMPROBANTE, { emisor: EMISOR, ancho: 48 });
const bytes = t.build();

console.log("1. Flujo de bytes");
bytes.length > 0 ? ok(`${bytes.length} bytes generados`) : fail("no se generó nada");
bytes[0] === 0x1b && bytes[1] === 0x40 ? ok("arranca con ESC @ (init)") : fail("falta el init");
bytes.includes(Buffer.from([0x1d, 0x56])) ? ok("termina con corte de papel") : fail("falta el corte");
bytes.includes(Buffer.from([0x1b, 0x74, 19])) ? ok("codepage PC858 seleccionado") : fail("falta el codepage");
bytes.includes(Buffer.from([0x1d, 0x28, 0x6b])) ? ok("QR con la clave incluido") : fail("falta el QR");

console.log("\n2. Acentos");
const conAcento = require("./src/escpos").codificar("Café con leche ñ");
conAcento.includes(0x82) ? ok("é se codifica como 0x82 (CP858), no como '?'") : fail("acento mal codificado");
conAcento.includes(0xa4) ? ok("ñ se codifica como 0xA4") : fail("eñe mal codificada");

console.log("\n3. Ancho de línea");
const lineas = t.preview().split("\n");
const largas = lineas.filter((l) => l.replace(/\r/g, "").length > 48);
largas.length === 0 ? ok("ninguna línea pasa de 48 columnas") : fail(`${largas.length} línea(s) se salen: ${largas[0]}`);

fs.writeFileSync(path.join(__dirname, "tiquete.bin"), bytes);
fs.writeFileSync(path.join(__dirname, "tiquete.txt"), t.preview());

console.log("\n" + "=".repeat(50));
console.log(t.preview());
console.log("=".repeat(50));

console.log(
  errores === 0
    ? "\nResultado: el tiquete se arma bien. Falta probarlo en una impresora real.\n"
    : `\nResultado: ${errores} problema(s).\n`
);
process.exit(errores === 0 ? 0 : 1);
