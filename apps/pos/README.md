# apps/pos

El cliente. No guarda estado propio: **todo viene del servidor del local.**

Lo sirve la propia API, así que no hay build ni empaquetador:

```bash
node ../../packages/impresion/agente.js    # para que imprima
node ../api/src/servidor.js                # API + cliente en :4000
```

Y se abre en `http://localhost:4000` desde cualquier dispositivo de la red del local.

---

## Qué cambió frente a la maqueta

| `mockups/pos.html` | `apps/pos` |
|---|---|
| Estado en `localStorage` | estado en el servidor |
| Sincroniza entre pestañas | sincroniza entre dispositivos |
| Menú inventado | menú de la base |
| Cobro simulado | comprobante firmado e impreso |
| Simulador de red | conexión real, con reintento |

La maqueta sigue en `mockups/` como referencia de diseño: tiene pantallas que todavía no existen aquí (menú del back-office, ajustes) y el simulador de contingencia.

## Cómo funciona

**Un solo archivo de estado, `S`, y una sola función `pintar()`.** No hay framework ni build. El servidor empuja por WebSocket y el cliente vuelve a pintar.

Lo único que el cliente guarda es **qué ventana está viendo y con qué rol** — en `sessionStorage`, para que dos pestañas del mismo navegador puedan ser dispositivos distintos.

```js
ws.onmessage = (m) => {
  const { datos } = JSON.parse(m.data);
  if (datos) S.estado = datos;
  ...
  pintar();
};
```

## Dos detalles que importan

**Reconexión automática.** Si el servidor del local se reinicia, el POS reintenta cada 2 segundos y el pie muestra el estado. Un salonero no debería tener que recargar nada.

**Si otro dispositivo cobra la orden que tenés abierta**, la pantalla vuelve sola al salón en vez de quedarse mostrando algo que ya no existe:

```js
if (S.ordenId && !orden()) {
  S.ordenId = null;
  if (S.vista === "pedido" || S.vista === "pago") S.vista = "salon";
}
```

## Ingreso

**PIN de 4 dígitos, no contraseña.** Un salonero no va a escribir una contraseña larga en una tablet con fila de gente. Se elige el nombre de una lista —el equipo es chico— y se marca el PIN en un teclado numérico.

Eso trae su propio riesgo: 4 dígitos son 10.000 combinaciones. Por eso **al quinto intento fallido la cuenta se bloquea 60 segundos**. Sin eso el PIN no serviría.

PINes de arranque, para probar: Kevin `1111` (salonero), Silvia `2222` (caja), Rafael `3333` (administración).

**El rol sale de quién ingresó, no del aparato.** La misma tablet es de salonero o de caja según quién esté logueado. La sesión vive en `sessionStorage`: sobrevive recargar la página, no cerrar el navegador.

## Factura electrónica

En Pago, el botón **Necesita factura** abre el formulario del receptor. Se digita la cédula y el resto lo trae el padrón de Hacienda: nombre y actividades económicas. Lo único que decide el cajero es cuál actividad aplica, y solo cuando el cliente tiene más de una.

Tres casos, porque los tres pasan:

- **Cliente frecuente** — aparece como botón; la segunda factura es de un toque.
- **Sin actividad económica** — se factura como consumidor final. Cualquier persona puede pedir factura, tenga o no negocio.
- **Fuera del padrón** — captura manual, con "extranjero no domiciliado" preseleccionado. Es el caso del turista.

El correo es obligatorio: **entregarle el XML firmado y la respuesta de Hacienda es obligación legal**, no cortesía.

Identificadores de prueba: `9101123456` (dos actividades), `995670891` (sin actividad), `911111111` (no existe).

## Cocina

Pantalla propia, con su rol y su PIN. Se lee de lejos y se toca con las manos ocupadas: nada pequeño, tipografía grande, un toque por plato.

**El salonero decide cuándo mandar.** Si cada plato saliera a cocina al agregarlo, la cocina arrancaría el primero mientras el mesero todavía está tomando la orden. Por eso hay un botón *Mandar N a cocina*, y lo que se agrega después se manda aparte sin repetir lo anterior.

**El color no decora, ordena el trabajo:** verde hasta 8 minutos, ámbar hasta 15, rojo después. Y la comanda que lleva más esperando va siempre primero.

Un toque en un plato lo marca listo; el botón de abajo cierra la comanda entera. El salonero se entera al instante, sin preguntar.

**Cocina no ve precios ni cobra.** Solo lo que hay que preparar.

## Back-office

Cinco pantallas, solo para administración:

| | |
|---|---|
| **Comprobantes** | estado ante Hacienda, cola, y anular con nota de crédito |
| **Cierre** | arqueo del turno: esperado contra contado, abrir y cerrar caja |
| **Reportes** | facturado, IVA por tarifa, lo que más se vende |
| **Menú** | productos con buscador CABYS contra el catálogo real |
| **Ajustes** | certificado digital y usuarios con sus roles y PIN |

**El CABYS se busca, no se escribe.** Escribís "ceviche" y el catálogo de Hacienda devuelve el código de 13 dígitos con su tarifa. La tarifa se puede ajustar a mano, pero queda marcada en ámbar: el catálogo es de referencia y la responsabilidad de aplicar la correcta es del contribuyente.

**Desactivar no es borrar.** Un producto desactivado desaparece del POS pero sigue vivo en administración y en los comprobantes viejos. Borrar solo se permite si nunca se vendió.

## Pendiente

- Envío del XML por correo al receptor
- Dividir cuenta y propina
- Transmisión real a Hacienda (falta la llave)
