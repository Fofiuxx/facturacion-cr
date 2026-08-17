"use strict";

// Firma XAdES-EPES sobre el XML del comprobante.
//
// Este es el punto de mayor riesgo técnico del proyecto: el perfil EPES exige
// una política de firma declarada y la canonicalización C14N tiene que quedar
// exacta. Cualquier reserialización del XML DESPUÉS de firmar invalida la firma:
// lo que se transmite es el string que sale de aquí, sin reformatear.

const forge = require("node-forge");
const xadesjs = require("xadesjs");
const xmldom = require("@xmldom/xmldom");
const xpath = require("xpath");

const { DOMParser, XMLSerializer } = xmldom;

// En Node hay que registrar el DOM y XPath a mano: xadesjs asume navegador.
xadesjs.setNodeDependencies({
  XMLSerializer: xmldom.XMLSerializer,
  DOMParser: xmldom.DOMParser,
  DOMImplementation: xmldom.DOMImplementation,
  xpath,
});
xadesjs.Application.setEngine("NodeJS", globalThis.crypto);

// PENDIENTE DE VERIFICAR: identificador y digest de la política de firma vigente
// para la 4.4. Sale de la resolución oficial, no se puede inventar.
const POLITICA = {
  identifier: "https://www.hacienda.go.cr/ATV/ComprobanteElectronico/docs/esquemas/2016/v4.2/ResolucionComprobantesElectronicosDGT-R-48-2016.pdf",
  hash: "V8lVVNGDCPen6VELRD1Ja8HARFk=", // SHA-1 en base64, tal como lo publica la resolución
};

/** Abre el .p12 y devuelve la llave privada (PKCS#8 DER) y el certificado (DER). */
function abrirP12(p12Buffer, pin) {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer.toString("binary")));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, pin);

  let privateKey = null;
  let certificate = null;

  for (const safeContents of p12.safeContents) {
    for (const bag of safeContents.safeBags) {
      if (bag.key && !privateKey) privateKey = bag.key;
      if (bag.cert && !certificate) certificate = bag.cert;
    }
  }
  if (!privateKey) throw new Error("El .p12 no trae llave privada, o el PIN es incorrecto");
  if (!certificate) throw new Error("El .p12 no trae certificado");

  const pkcs8 = forge.asn1
    .toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(privateKey)))
    .getBytes();
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();

  return {
    pkcs8: Buffer.from(pkcs8, "binary"),
    certDer: Buffer.from(certDer, "binary"),
    certificate,
  };
}

async function firmar(xml, { p12, pin }) {
  const { pkcs8, certDer, certificate } = abrirP12(p12, pin);

  const algoritmo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await globalThis.crypto.subtle.importKey("pkcs8", pkcs8, algoritmo, false, ["sign"]);

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const signed = new xadesjs.SignedXml();

  await signed.Sign(
    algoritmo,
    key,
    doc,
    {
      references: [
        { id: "r-id-1", hash: "SHA-256", transforms: ["enveloped"], uri: "" },
      ],
      policy: {
        hash: "SHA-1",
        identifier: { qualifier: "OIDAsURI", value: POLITICA.identifier },
      },
      signingCertificate: certDer.toString("base64"),
      x509: [certDer.toString("base64")],
      signerRole: { claimed: ["emisor"] },
      productionPlace: { country: "Costa Rica" },
    }
  );

  // Enveloped: la firma se cuelga de la raíz del documento original.
  doc.documentElement.appendChild(signed.GetXml());

  return {
    xml: new XMLSerializer().serializeToString(doc),
    certificado: {
      sujeto: certificate.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(", "),
      vence: certificate.validity.notAfter,
    },
  };
}

async function verificar(xmlFirmado) {
  const doc = new DOMParser().parseFromString(xmlFirmado, "application/xml");
  const nodo = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")[0];
  if (!nodo) throw new Error("El XML no trae nodo Signature");

  const signed = new xadesjs.SignedXml(doc);
  signed.LoadXml(nodo);
  return signed.Verify();
}

module.exports = { firmar, verificar, abrirP12, POLITICA };
