"use strict";

// Constructor de comandos ESC/POS para impresora térmica de 80mm.
// Un navegador no puede hablar ESC/POS: esto corre en el agente local
// de la máquina de caja, no en el POS.

const ESC = 0x1b;
const GS = 0x1d;

// Epson: 19 = PC858 (multilingüe + €). Incluye los acentos del español.
const CODEPAGE = 19;

// CP858 para lo que usa el español. Lo que no esté aquí se degrada a ASCII
// en vez de imprimir basura.
const MAPA = {
  "á": 0xa0, "é": 0x82, "í": 0xa1, "ó": 0xa2, "ú": 0xa3,
  "Á": 0xb5, "É": 0x90, "Í": 0xd6, "Ó": 0xe0, "Ú": 0xe9,
  "ñ": 0xa4, "Ñ": 0xa5, "ü": 0x81, "Ü": 0x9a,
  "¿": 0xa8, "¡": 0xad, "°": 0xf8, "·": 0xfa,
};

const SIN_TILDE = {
  "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u",
  "Á": "A", "É": "E", "Í": "I", "Ó": "O", "Ú": "U",
  "ñ": "n", "Ñ": "N", "ü": "u", "Ü": "U", "₡": "",
};

function codificar(texto) {
  const out = [];
  for (const ch of String(texto)) {
    const cp = MAPA[ch];
    if (cp !== undefined) { out.push(cp); continue; }
    const code = ch.charCodeAt(0);
    if (code < 128) { out.push(code); continue; }
    for (const c of SIN_TILDE[ch] ?? "?") out.push(c.charCodeAt(0));
  }
  return Buffer.from(out);
}

class Ticket {
  /** @param {number} ancho columnas a fuente A (48 en 80mm, 32 en 58mm) */
  constructor(ancho = 48) {
    this.ancho = ancho;
    this.partes = [];
    this.cmd(ESC, 0x40);          // init
    this.cmd(ESC, 0x74, CODEPAGE); // codepage
  }

  cmd(...bytes) { this.partes.push(Buffer.from(bytes)); return this; }
  raw(buf) { this.partes.push(buf); return this; }

  alinear(donde) {
    return this.cmd(ESC, 0x61, { izq: 0, centro: 1, der: 2 }[donde] ?? 0);
  }
  negrita(on) { return this.cmd(ESC, 0x45, on ? 1 : 0); }

  /** n = 1 normal, 2 doble. Ancho y alto por separado. */
  tamano(w = 1, h = 1) {
    return this.cmd(GS, 0x21, ((w - 1) << 4) | (h - 1));
  }

  texto(t = "") { return this.raw(codificar(t)); }
  linea(t = "") { return this.texto(t).cmd(0x0a); }

  /** Etiqueta a la izquierda, monto a la derecha, puntos de relleno. */
  fila(izq, der, relleno = " ") {
    const l = String(izq), r = String(der);
    const hueco = Math.max(1, this.ancho - l.length - r.length);
    return this.linea(l + relleno.repeat(hueco) + r);
  }

  separador(ch = "-") { return this.linea(ch.repeat(this.ancho)); }

  /** Parte el texto por palabras para que no lo corte la impresora. */
  parrafo(t, ancho = this.ancho) {
    let actual = "";
    for (const palabra of String(t).split(/\s+/)) {
      if (!actual.length) { actual = palabra; continue; }
      if (actual.length + 1 + palabra.length <= ancho) { actual += " " + palabra; continue; }
      this.linea(actual);
      actual = palabra;
    }
    if (actual.length) this.linea(actual);
    return this;
  }

  /** QR con la clave, para que el cliente verifique el comprobante. */
  qr(dato, tamano = 6) {
    const d = Buffer.from(String(dato), "ascii");
    const len = d.length + 3;
    this.cmd(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // modelo 2
    this.cmd(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, tamano);     // tamaño
    this.cmd(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);       // corrección M
    this.cmd(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30);
    this.raw(d);
    this.cmd(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);       // imprimir
    return this;
  }

  avanzar(n = 4) { return this.cmd(ESC, 0x64, n); }
  cortar() { return this.avanzar(4).cmd(GS, 0x56, 0x01); }

  build() { return Buffer.concat(this.partes); }

  /** Vista previa en texto para revisar el diseño sin gastar papel. */
  preview() {
    // Decodifica CP858 de vuelta: si no, los acentos se ven mal y la vista
    // previa engaña sobre lo que va a salir impreso.
    const inverso = Object.fromEntries(Object.entries(MAPA).map(([k, v]) => [v, k]));
    const bytes = this.build();
    let texto = "";
    for (const b of bytes) texto += inverso[b] ?? String.fromCharCode(b);

    return texto
      .replace(/\x1b@|\x1bt./g, "")
      .replace(/\x1ba./g, "")
      .replace(/\x1bE./g, "")
      .replace(/\x1d!./g, "")
      .replace(/\x1bd./g, "")
      .replace(/\x1dV./g, "")
      .replace(/\x1d\(k[\s\S]*?1Q0/g, "[ QR con la clave ]\n");
  }
}

module.exports = { Ticket, codificar, CODEPAGE };
