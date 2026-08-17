"use strict";

// Fase 0: ¿se puede firmar XAdES-EPES en Node?
// Se prueba con un certificado autofirmado. La llave de Hacienda solo hace falta
// para transmitir, no para responder esta pregunta.

const fs = require("fs");
const path = require("path");
const { clave, consecutivo } = require("./src/clave");
const { tiquete } = require("./src/xml");
const { firmar, verificar } = require("./src/firmar");

const EMISOR = {
  nombre: "Restaurante Prueba S.A.",
  tipoIdentificacion: "02",
  identificacion: "3101456789",
  codigoActividad: "561000",
  correo: "facturacion@restaurante.cr",
};

const LINEAS = [
  { cabys: "6311100000000", detalle: "Casado de pollo", cantidad: 2, precioUnitario: 5900, codigoTarifa: "08", tarifa: 13 },
  { cabys: "0112100000000", detalle: "Bolsa de arroz 1 kg", cantidad: 1, precioUnitario: 1350, codigoTarifa: "02", tarifa: 1 },
];

const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => console.log(`  FALLA ${m}`);

(async () => {
  let errores = 0;
  console.log("\nFase 0 — prototipo de firma XAdES-EPES\n");

  // 1. Identificadores fiscales
  console.log("1. Clave numérica y consecutivo");
  const cons = consecutivo({ tipo: "TE", secuencia: 1 });
  const cl = clave({ cedulaEmisor: EMISOR.identificacion, consecutivo: cons, situacion: "normal" });
  cons.length === 20 ? ok(`consecutivo ${cons} (20 dígitos)`) : (fail("consecutivo"), errores++);
  cl.length === 50 ? ok(`clave ${cl} (50 dígitos)`) : (fail("clave"), errores++);
  const conting = clave({ cedulaEmisor: EMISOR.identificacion, consecutivo: cons, situacion: "contingencia" });
  conting[41] === "2" ? ok("situación 2 en contingencia queda en la posición 42") : (fail("situación"), errores++);

  // 2. XML
  console.log("\n2. XML del tiquete");
  const xml = tiquete({ clave: cl, consecutivo: cons, emisor: EMISOR, lineas: LINEAS });
  xml.includes("<TiqueteElectronico") ? ok("documento generado") : (fail("documento"), errores++);
  // 2 casados a 5900 = 11800 al 13% -> 1534 ; arroz 1350 al 1% -> 13.5
  xml.includes("<TotalImpuesto>1547.50000</TotalImpuesto>")
    ? ok("IVA por línea con dos tarifas: 1534 + 13.5 = 1547.50000")
    : (fail("cálculo de IVA por línea"), errores++);
  fs.writeFileSync(path.join(__dirname, "salida-sin-firmar.xml"), xml);

  // 3. Firma — la pregunta de fondo
  console.log("\n3. Firma XAdES-EPES");
  let firmado;
  try {
    const p12 = fs.readFileSync(path.join(__dirname, "llave-prueba.p12"));
    const r = await firmar(xml, { p12, pin: "1234" });
    firmado = r.xml;
    ok(`certificado abierto: ${r.certificado.sujeto}`);
    ok("firma generada sin errores");
    firmado.includes("SignaturePolicyIdentifier")
      ? ok("perfil EPES: política de firma declarada")
      : (fail("falta SignaturePolicyIdentifier — no es EPES"), errores++);
    firmado.includes("<ds:X509Certificate>") || firmado.includes("X509Certificate")
      ? ok("certificado incluido en KeyInfo")
      : (fail("falta X509Certificate"), errores++);
    fs.writeFileSync(path.join(__dirname, "salida-firmada.xml"), firmado);
  } catch (e) {
    fail(`no se pudo firmar: ${e.message}`);
    errores++;
  }

  // 4. Verificación
  if (firmado) {
    console.log("\n4. Verificación de la firma");
    try {
      const valida = await verificar(firmado);
      valida ? ok("la firma verifica contra el documento") : (fail("la firma NO verifica"), errores++);
    } catch (e) {
      fail(`error al verificar: ${e.message}`);
      errores++;
    }

    console.log("\n5. Sensibilidad a la reserialización");
    try {
      const tocado = firmado.replace("<Clave>" + cl, "<Clave>" + cl.replace(/.$/, "9"));
      const valida = await verificar(tocado);
      !valida
        ? ok("alterar un dígito invalida la firma, como debe ser")
        : (fail("la firma sigue válida tras alterar el XML"), errores++);
    } catch {
      ok("alterar el XML rompe la verificación, como debe ser");
    }
  }

  console.log(
    errores === 0
      ? "\nResultado: XAdES-EPES es viable en Node. No hace falta un servicio en Java.\n"
      : `\nResultado: ${errores} problema(s). Revisar antes de seguir.\n`
  );
  process.exit(errores === 0 ? 0 : 1);
})();
