"use strict";

// Genera un certificado TLS para la red del local. Gratis, con openssl.
//
//   node certificados.js
//
// Crea una autoridad certificadora propia y un certificado de servidor firmado
// por ella, válido para todas las IPs de esta máquina. Después hay que instalar
// ca.crt UNA VEZ en cada tablet y el navegador deja de reclamar.
//
// Por qué no Let's Encrypt: emite para dominios públicos, y el servidor del
// local no está en internet a propósito. Para una red cerrada, CA propia.

const { execFileSync } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "certs");
const DIAS_CA = 3650;      // la CA dura 10 años: instalarla en cada tablet es molesto
const DIAS_SERVIDor = 825; // el máximo que aceptan los navegadores

function ips() {
  const out = new Set(["127.0.0.1"]);
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista ?? []) {
      // Las 169.254.x son de enlace local: no sirven para esto.
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) {
        out.add(i.address);
      }
    }
  }
  return [...out];
}

function openssl(args, entrada) {
  return execFileSync("openssl", args, { input: entrada, stdio: ["pipe", "pipe", "pipe"] });
}

const hostname = os.hostname().toLowerCase();
const direcciones = ips();

fs.mkdirSync(DIR, { recursive: true });

const conf = `
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
C = CR
O = POS del local
CN = ${hostname}
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
${["DNS.1 = localhost", `DNS.2 = ${hostname}`, `DNS.3 = ${hostname}.local`]
  .concat(direcciones.map((ip, n) => `IP.${n + 1} = ${ip}`)).join("\n")}
`.trim();

const confPath = path.join(DIR, "servidor.cnf");
fs.writeFileSync(confPath, conf);

console.log("\nGenerando certificados para la red del local\n");
console.log("  Nombres válidos:");
console.log(`    localhost, ${hostname}, ${hostname}.local`);
for (const ip of direcciones) console.log(`    ${ip}`);

const p = (f) => path.join(DIR, f);

if (!fs.existsSync(p("ca.crt"))) {
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", String(DIAS_CA),
    "-keyout", p("ca.key"), "-out", p("ca.crt"),
    "-subj", "/C=CR/O=POS del local/CN=POS del local - CA"]);
  console.log("\n  ca.crt         autoridad propia (instalar en cada dispositivo)");
} else {
  console.log("\n  ca.crt         ya existía, se reusa");
}

openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes",
  "-keyout", p("servidor.key"), "-out", p("servidor.csr"), "-config", confPath]);

openssl(["x509", "-req", "-in", p("servidor.csr"),
  "-CA", p("ca.crt"), "-CAkey", p("ca.key"), "-CAcreateserial",
  "-out", p("servidor.crt"), "-days", String(DIAS_SERVIDor),
  "-extfile", confPath, "-extensions", "v3"]);

fs.unlinkSync(p("servidor.csr"));

console.log("  servidor.crt   certificado del servidor");
console.log("  servidor.key   llave privada — no sale de esta máquina\n");
console.log("Ahora:");
console.log("  1. node src/servidor.js        → levanta HTTPS además de HTTP");
console.log(`  2. En cada tablet, abrir http://${direcciones.find((d) => d !== "127.0.0.1") ?? "IP"}:4000/ca.crt`);
console.log("     e instalarlo como autoridad de confianza");
console.log(`  3. Usar https://${direcciones.find((d) => d !== "127.0.0.1") ?? "IP"}:4443\n`);
