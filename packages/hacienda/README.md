# packages/hacienda

Núcleo fiscal, sin dependencias del resto de la aplicación. Recibe objetos planos y devuelve XML.

```bash
node probar.js
```

---

## Resultado de la fase 0

**La firma XAdES-EPES es viable en Node. No hace falta un servicio auxiliar en Java.**

Era el riesgo número uno del proyecto ([01-diseno.md §7](../../docs/01-diseno.md)) y queda descartado. Probado con `xadesjs` 2.6.8 sobre Node 24 y un certificado autofirmado; la llave de Hacienda solo hace falta para transmitir, no para firmar.

Lo que la prueba comprueba:

| | |
|---|---|
| Consecutivo de 20 dígitos | sucursal + terminal + tipo + secuencia |
| Clave de 50 dígitos | con el dígito de situación en la posición 42 |
| IVA por línea | dos tarifas en el mismo comprobante (13% y 1%) |
| Firma XAdES-EPES | con política de firma declarada |
| Verificación | la firma valida contra el documento |
| Sensibilidad | alterar un dígito del XML invalida la firma |

### Lo que costó hacerlo andar

`xadesjs` asume navegador. En Node hay que registrarle el DOM y XPath a mano antes de usarlo, o falla con `Node dependency not found: DOMParser`:

```js
xadesjs.setNodeDependencies({
  XMLSerializer: xmldom.XMLSerializer,
  DOMParser: xmldom.DOMParser,
  DOMImplementation: xmldom.DOMImplementation,
  xpath,
});
xadesjs.Application.setEngine("NodeJS", globalThis.crypto);
```

No está en la documentación principal del paquete. Es la única fricción real que apareció.

### Regla que no se puede romper

**Lo que se transmite es exactamente el string que sale de `firmar()`.** Cualquier reserialización posterior —un `JSON.parse`, un formateador, un ORM que lo guarde y lo lea— cambia la canonicalización e invalida la firma. La prueba 5 lo demuestra: alterar un solo dígito la rompe.

---

## Lo que el XML todavía NO tiene

`src/xml.js` genera un tiquete con la forma correcta para probar la firma. **No es un XML válido ante Hacienda.** Falta, como mínimo:

- **`InformacionReferencia`** en las notas de crédito. La NC existe en la base con su `referencia_id`, se imprime bien y revierte los montos, pero **el XML no declara qué comprobante anula**. Hacienda la rechazaría.
- **`ProveedorSistemas`** — identificación del software emisor, nuevo y obligatorio en 4.4.
- Los nodos de la factura electrónica: `Receptor`, `OtrosCargos` para el servicio 10%, `DetalleSurtido` para combos.

Nada de esto se puede escribir desde fuentes secundarias: sale del XSD.

## Pendiente de verificar contra el XSD oficial

Nada de esto se puede resolver desde fuentes secundarias. Sale del anexo técnico de la resolución **MH-DGT-RES-0027-2024**:

- **La política de firma vigente para 4.4.** El `POLITICA` en `src/firmar.js` apunta a la resolución de 2016 con su digest SHA-1. Casi seguro cambió.
- **El namespace exacto** de la versión 4.4 y el orden obligatorio de cada nodo.
- **La versión de XAdES**: la firma sale con `SigningCertificate` (XAdES 1.3.2). Si Hacienda exige `SigningCertificateV2`, hay que ajustar.
- **`ProveedorSistemas`** — identificación del software emisor, nuevo y obligatorio en 4.4. No está en el XML de prueba.
- **Actividad económica del receptor** cuando el receptor no tiene ninguna.

## Pendiente de trámite

La llave criptográfica y las credenciales del sandbox se generan gratis en **TRIBU-CR** (`ovitribucr.hacienda.go.cr`), que reemplazó a ATV en octubre de 2025. Con eso se cierra la fase 0: reemplazar `llave-prueba.p12` por la real y hacer el POST a recepción.

## Archivos

```
src/clave.js    clave numérica y consecutivo
src/xml.js      tiquete electrónico mínimo
src/firmar.js   XAdES-EPES: firmar y verificar
probar.js       la prueba de la fase 0
```

`llave-prueba.p12`, `test-key.pem` y `test-cert.pem` son de prueba y autofirmados. **Ninguna llave real debe entrar a este repositorio.**
