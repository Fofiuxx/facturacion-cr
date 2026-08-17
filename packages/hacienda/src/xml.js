"use strict";

// Tiquete electrónico mínimo. El objetivo de este archivo NO es producir un XML
// válido ante Hacienda: es tener un documento con la forma correcta para probar
// la firma. La estructura completa sale del XSD oficial de la 4.4.
//
// PENDIENTE DE VERIFICAR CONTRA EL XSD:
//   - el namespace exacto de la versión 4.4
//   - el orden y la obligatoriedad de cada nodo
//   - ProveedorSistemas (identificación del software, nuevo en 4.4)

const NS_TE = "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Hacienda acepta hasta 5 decimales. Nunca usar coma flotante para acumular. */
const num = (n) => n.toFixed(5);

function fechaISO(d) {
  const p = (v) => String(v).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sig = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sig}${oh}:${om}`
  );
}

function tiquete({ clave, consecutivo, fecha = new Date(), emisor, lineas }) {
  let servGravados = 0;
  let impuestoTotal = 0;

  const detalle = lineas
    .map((l, i) => {
      const montoTotal = l.cantidad * l.precioUnitario;
      const subtotal = montoTotal;
      const impuesto = subtotal * (l.tarifa / 100);
      servGravados += subtotal;
      impuestoTotal += impuesto;

      return `    <LineaDetalle>
      <NumeroLinea>${i + 1}</NumeroLinea>
      <CodigoCABYS>${esc(l.cabys)}</CodigoCABYS>
      <Cantidad>${num(l.cantidad)}</Cantidad>
      <UnidadMedida>${esc(l.unidad ?? "Unid")}</UnidadMedida>
      <Detalle>${esc(l.detalle)}</Detalle>
      <PrecioUnitario>${num(l.precioUnitario)}</PrecioUnitario>
      <MontoTotal>${num(montoTotal)}</MontoTotal>
      <SubTotal>${num(subtotal)}</SubTotal>
      <Impuesto>
        <Codigo>01</Codigo>
        <CodigoTarifaIVA>${esc(l.codigoTarifa)}</CodigoTarifaIVA>
        <Tarifa>${num(l.tarifa)}</Tarifa>
        <Monto>${num(impuesto)}</Monto>
      </Impuesto>
      <ImpuestoNeto>${num(impuesto)}</ImpuestoNeto>
      <MontoTotalLinea>${num(subtotal + impuesto)}</MontoTotalLinea>
    </LineaDetalle>`;
    })
    .join("\n");

  const total = servGravados + impuestoTotal;

  return `<?xml version="1.0" encoding="UTF-8"?>
<TiqueteElectronico xmlns="${NS_TE}">
  <Clave>${clave}</Clave>
  <CodigoActividadEmisor>${esc(emisor.codigoActividad)}</CodigoActividadEmisor>
  <NumeroConsecutivo>${consecutivo}</NumeroConsecutivo>
  <FechaEmision>${fechaISO(fecha)}</FechaEmision>
  <Emisor>
    <Nombre>${esc(emisor.nombre)}</Nombre>
    <Identificacion>
      <Tipo>${esc(emisor.tipoIdentificacion)}</Tipo>
      <Numero>${esc(emisor.identificacion)}</Numero>
    </Identificacion>
    <CorreoElectronico>${esc(emisor.correo)}</CorreoElectronico>
  </Emisor>
  <CondicionVenta>01</CondicionVenta>
  <DetalleServicio>
${detalle}
  </DetalleServicio>
  <ResumenFactura>
    <CodigoTipoMoneda>
      <CodigoMoneda>CRC</CodigoMoneda>
      <TipoCambio>1.00000</TipoCambio>
    </CodigoTipoMoneda>
    <TotalServGravados>${num(servGravados)}</TotalServGravados>
    <TotalGravado>${num(servGravados)}</TotalGravado>
    <TotalVenta>${num(servGravados)}</TotalVenta>
    <TotalVentaNeta>${num(servGravados)}</TotalVentaNeta>
    <TotalDesgloseImpuesto>
      <Codigo>01</Codigo>
      <TotalMontoImpuesto>${num(impuestoTotal)}</TotalMontoImpuesto>
    </TotalDesgloseImpuesto>
    <TotalImpuesto>${num(impuestoTotal)}</TotalImpuesto>
    <TotalComprobante>${num(total)}</TotalComprobante>
  </ResumenFactura>
</TiqueteElectronico>`;
}

module.exports = { tiquete, NS_TE, fechaISO };
