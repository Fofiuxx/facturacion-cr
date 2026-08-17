"use strict";

// Verifica que el HTTPS de la red local funcione y que la CA sea necesaria.
// Node valida contra la CA que se le pasa; curl en Windows usa schannel y
// consulta el almacén del sistema, por eso ahí da un falso negativo.

const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const CA = path.join(__dirname, "certs", "ca.crt");
const ip = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))?.address;

const pedir = (opts) =>
  new Promise((res, rej) => {
    const r = https.request({ host: opts.host, port: 4443, path: "/usuarios", method: "GET",
      ca: opts.ca, rejectUnauthorized: true, timeout: 5000 }, (resp) => {
      let d = ""; resp.on("data", (c) => (d += c));
      resp.on("end", () => res({ status: resp.statusCode, cuerpo: d }));
    });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    r.end();
  });

let errores = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FALLA ${m}`); errores++; };

(async () => {
  console.log(`\nHTTPS en la red local — ${ip}\n`);
  const ca = fs.readFileSync(CA);

  try {
    const r = await pedir({ host: ip, ca });
    r.status === 200
      ? ok(`https://${ip}:4443 responde con la CA instalada — ${JSON.parse(r.cuerpo).length} usuarios`)
      : fail(`respondió ${r.status}`);
  } catch (e) { fail(`con la CA debería funcionar: ${e.message}`); }

  try {
    await pedir({ host: ip, ca: undefined });
    fail("sin la CA también funciona — el certificado no está validando nada");
  } catch (e) {
    /self.signed|unable to verify|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(e.message)
      ? ok("sin instalar la CA, el navegador rechaza — es lo correcto")
      : fail(`error inesperado: ${e.message}`);
  }

  try {
    const r = await pedir({ host: "localhost", ca });
    r.status === 200 ? ok("también vale para localhost") : fail("localhost falló");
  } catch (e) { fail(`localhost: ${e.message}`); }

  console.log(errores === 0
    ? "\nResultado: el HTTPS del local funciona. Instalá /ca.crt en cada tablet.\n"
    : `\nResultado: ${errores} problema(s).\n`);
  process.exit(errores === 0 ? 0 : 1);
})();
