"use strict";

// Agente local de impresión.
//
// El POS es web y un navegador no puede hablar ESC/POS. Este proceso corre en
// la máquina de caja, escucha en localhost y es el único que toca la impresora.
// Es la pieza que resuelve el riesgo 0b del diseño.
//
//   node agente.js                          -> escribe a archivo (pruebas)
//   node agente.js --destino tcp://10.0.0.50:9100
//   node agente.js --destino printer://POS-80
//
// El POS le pega así:
//   fetch("http://127.0.0.1:9100/imprimir", { method:"POST", body: JSON.stringify({...}) })

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { render } = require("./src/tiquete");

const PUERTO = 9100;
const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : def;
};
const DESTINO = arg("--destino", "file://./impresiones");

function enviar(bytes) {
  if (DESTINO.startsWith("tcp://")) {
    const [host, puerto] = DESTINO.slice(6).split(":");
    return new Promise((res, rej) => {
      const s = net.createConnection({ host, port: Number(puerto) || 9100 }, () => {
        s.end(bytes, () => res(`enviado a ${host}`));
      });
      s.setTimeout(5000, () => { s.destroy(); rej(new Error("la impresora no respondió")); });
      s.on("error", rej);
    });
  }

  if (DESTINO.startsWith("printer://")) {
    // Windows: se copia crudo al recurso compartido de la impresora.
    const nombre = DESTINO.slice(10);
    const tmp = path.join(process.env.TEMP || ".", `tiquete-${Date.now()}.bin`);
    fs.writeFileSync(tmp, bytes);
    return new Promise((res, rej) => {
      execFile("cmd", ["/c", "copy", "/b", tmp, `\\\\localhost\\${nombre}`], (e) => {
        fs.unlink(tmp, () => {});
        e ? rej(e) : res(`enviado a la impresora ${nombre}`);
      });
    });
  }

  const dir = DESTINO.replace("file://", "");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `tiquete-${Date.now()}.bin`);
  fs.writeFileSync(f, bytes);
  return Promise.resolve(`guardado en ${f}`);
}

const servidor = http.createServer((req, res) => {
  // Solo desde la propia máquina: el agente nunca se expone a la red.
  const ip = req.socket.remoteAddress || "";
  if (!ip.includes("127.0.0.1") && !ip.includes("::1")) {
    res.writeHead(403).end("solo local");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  if (req.url === "/estado") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, destino: DESTINO }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/imprimir") {
    res.writeHead(404).end("no existe");
    return;
  }

  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", async () => {
    try {
      const { comprobante, emisor, ancho } = JSON.parse(cuerpo);
      const bytes = render(comprobante, { emisor, ancho: ancho || 48 }).build();
      const detalle = await enviar(bytes);
      console.log(`  ${comprobante.cons}  ${detalle}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: bytes.length, detalle }));
    } catch (e) {
      console.error(`  error: ${e.message}`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

servidor.listen(PUERTO, "127.0.0.1", () => {
  console.log(`\nAgente de impresión en http://127.0.0.1:${PUERTO}`);
  console.log(`Destino: ${DESTINO}\n`);
});
