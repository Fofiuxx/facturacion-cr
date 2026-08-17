# POS para restaurante — Costa Rica v4.4

**Estado:** diseño
**Base:** hereda todo el núcleo fiscal de [01-diseno.md](./01-diseno.md)
**Supuestos:** servicio a mesa · pantalla táctil (tablet o monitor POS) · un local
**Fecha:** 2026-08-05

---

## 1. La decisión arquitectónica central

El sistema tiene dos mitades que **no se mezclan nunca**:

```
┌─────────────────────────────┐   ┌──────────────────────────┐
│  Vertical: restaurante      │   │  Núcleo: fiscal          │
│  salones, mesas, órdenes,   │──▶│  comprobantes, clave,    │
│  turnos, cocina             │   │  firma, envío, XSD 4.4   │
│                             │   │                          │
│  MUTABLE, rápido, táctil    │   │  INMUTABLE, auditable    │
└─────────────────────────────┘   └──────────────────────────┘
```

**La orden no es un comprobante.** Una orden se abre, se le agregan platos, se cambia, se anula un ítem, se divide. Es mutable por naturaleza — así trabaja un restaurante. El comprobante nace solo al cobrar, y en ese instante entra al mundo inmutable de la regla 2 del doc 01.

Esta separación es lo que resuelve la tensión entre "el POS tiene que ser flexible" y "la factura es intocable". También es lo que hace que el núcleo siga sirviendo para cualquier otro giro: `packages/hacienda` no sabe que existen las mesas.

```
apps/
├── api/          # núcleo: comprobantes, receptores, productos
├── pos/          # vertical restaurante (React, táctil)
└── admin/        # back-office (React, escritorio)
packages/
├── hacienda/     # fiscal puro, sin dependencias
└── shared/
```

---

## 1b. Multi-dispositivo: el estado vive en el servidor

El salonero toma en el teléfono y se cobra en la computadora de caja. Eso no es una preferencia de interfaz, es un requisito de arquitectura, y descarta de entrada guardar el estado en el dispositivo.

**La orden vive en el servidor. Los dispositivos son vistas.**

```
teléfono (salonero) ─┐
tableta  (salonero) ─┼─▶ API + WebSocket ─▶ Postgres
PC       (caja)     ─┤
PC       (admin)    ─┘
```

### Roles por dispositivo

| Rol | Dispositivo | Ventanas | Acción final |
|---|---|---|---|
| **Salonero** | teléfono, tableta | Salón, Express, Pedido | *Pasar a caja* |
| **Caja** | computadora | + Pago | *Cobrar* e imprimir |
| **Administración** | computadora | + Menú y reportes | — |

La consecuencia de diseño más importante: **el salonero no cobra.** Su botón principal no dice "Cobrar" sino "Pasar a caja", que marca la mesa como *pide la cuenta* y la pinta en ámbar en todas las pantallas. El cobro, la impresión y la factura viven en la caja, que es donde está la impresora térmica y el certificado.

Eso además resuelve por sí solo el problema de la impresora: no hace falta imprimir desde el teléfono.

### Sincronización

- **WebSocket desde el servidor**, no polling. Un salón lleno con seis tablets preguntando cada dos segundos es tráfico inútil y latencia visible.
- **El servidor es la única fuente de verdad.** El dispositivo no decide nada que otro dispositivo deba respetar; manda la intención y recibe el estado.
- **Concurrencia real:** dos saloneros pueden tocar la misma mesa. Las operaciones sobre la comanda deben ser incrementales (*agregar una línea*, *quitar una unidad*), nunca "guardar la comanda completa", porque lo segundo pisa el trabajo del otro. Versión por orden y rechazo con recarga si viene desactualizada.
- **Caso a manejar explícitamente:** que la caja cobre una orden mientras el salonero la tiene abierta. Su pantalla debe volver al salón con un aviso, no quedarse mostrando una orden que ya no existe.

### Offline: el servidor va en el local

**Decisión: el servidor corre en el restaurante, no en la nube.** Es lo que vuelve el problema del offline manejable.

Si el servidor estuviera en la nube, un corte de fibra dejaría los teléfonos mudos entre sí y el negocio se detendría. Con el servidor en sitio, perder internet **solo corta a Hacienda**: los dispositivos siguen hablándose por el WiFi del local, se toman pedidos, se cobra y se imprime igual. Lo único que se acumula es la transmisión al fisco.

Eso reduce "offline" de "reescribir la aplicación con service worker e IndexedDB" a "una cola de transmisión con reintentos", que es una fracción del trabajo.

### Tres estados de red, no dos

| Estado | Qué pasa | `situacion` en la clave |
|---|---|---|
| **En línea** | Todo normal | `1` |
| **Sin internet** | Dispositivos se ven entre sí; Hacienda inalcanzable | `3` |
| **Hacienda caído** | Hay internet, la API del fisco no responde | `2` |

Los dos últimos se comportan igual de cara al usuario y se distinguen **solo en el dígito de situación de la clave numérica**. Confundirlos es un error fiscal, no cosmético.

### Reglas

- **La venta nunca se bloquea.** El comprobante se emite, se imprime y se entrega al cliente aunque Hacienda esté fuera de alcance. Es válido: lleva su clave con la situación marcada.
- **Cola con reintentos y backoff.** Al volver la conexión se drena sola, uno por uno, sin intervención. El botón *Transmitir ahora* existe solo para forzarla.
- **La cola tiene que ser visible.** Un contador permanente en la barra: cuántos comprobantes se emitieron y todavía no llegaron al fisco. Si eso queda escondido, el negocio se entera cuando ya acumuló días.
- **Lo que sí exige conexión** es la consulta al padrón para facturas y la búsqueda CABYS. Ambas se resuelven con caché local: los clientes frecuentes y el menú ya están en el servidor del local.

### El papel de la nube

La nube **no es un servidor primario con el local de respaldo**. Ese esquema obliga a sincronización bidireccional con resolución de conflictos, que es de lo más caro y frágil que se puede construir.

**Regla: un solo escritor por tipo de dato.**

| Dato | Escribe | El otro lado |
|---|---|---|
| Órdenes, comprobantes, turnos | **Local** | la nube espeja |
| Menú, precios, usuarios | **Local** (fase 1) | la nube espeja |

Con todo escribiendo en el local, la sincronización va en **una sola dirección** y no hay nada que fusionar. Si más adelante hace falta editar el menú desde fuera del restaurante, la evolución natural es mover la configuración a la nube —no repartir por dirección, sino por tipo de dato— de modo que cada registro conserve un único dueño.

**Lo que aporta la nube:**

- **Respaldo de comprobantes.** La conservación por 5 años es obligación legal; si el equipo del local se pierde, sin respaldo el problema es legal, no técnico.
- **Reportes remotos** para el dueño.
- **Base para varios locales**, si crece.

**Lo que la nube no hace: transmitir a Hacienda.** El local transmite directo. Meter la nube en ese camino solo agrega otro punto de falla.

### Lo que queda fuera del alcance

Que un **teléfono** siga tomando pedidos cuando pierde el WiFi del local es otro problema — ese sí necesita estado en el dispositivo y resolución de conflictos. Con el servidor en sitio, la pregunta pasa a ser la cobertura del WiFi, que se arregla con un repetidor y no con software.

---

## 2. Principios de interfaz

El POS se usa de pie, con prisa, a veces con una bandeja en la otra mano, y lo opera gente con rotación alta que no va a recibir capacitación formal. De ahí salen las reglas:

1. **Una sola acción primaria por pantalla.** Un botón lleno de color, nunca dos. El resto es texto o borde.
2. **Objetivos táctiles de 64px mínimo**, 44px en el peor caso. Un tile de producto que se falla dos veces cuesta más que una pantalla "elegante".
3. **Máximo 6 categorías planas.** Sin menús anidados, sin acordeones, sin "ver más".
4. **Sin fotos de producto.** El personal busca por nombre. Las imágenes bajan la densidad útil y no aportan.
5. **Un solo número grande por pantalla:** el total. Impuestos en gris pequeño.
6. **El estado fiscal se traduce a lenguaje humano.** El salonero ve "Enviada" o "Pendiente", nunca `ACEPTADO_PARCIAL` ni códigos de Hacienda.
7. **Las acciones destructivas se esconden.** Anular un ítem va detrás de un swipe o un long-press con confirmación, nunca una "X" al lado de cada línea.
8. **Nunca un spinner bloqueante.** El envío a Hacienda es de fondo. Si el salonero espera a Hacienda para cobrar, el diseño falló.
9. **Modo oscuro real.** Los locales bajan luces en la noche; una pantalla blanca a las 9pm es hostil.

---

## 3. Pantallas

Cuatro. Si aparece una quinta, hay que justificarla.

| # | Pantalla | Propósito | Regla |
|---|---|---|---|
| 1 | **Salón** | Mapa de mesas con estado y tiempo abierto | De un vistazo: qué mesa lleva 40 min sin pedir |
| 2 | **Express** | Órdenes para llevar, sin mesa | No ocupa salón ni lleva servicio 10% |
| 3 | **Pedido** | Categorías + productos + comanda | Donde se vive el 80% del turno |
| 4 | **Cobro** | Medios de pago, propina, datos de factura | Una sola pantalla, sin pasos. Solo en caja |

El back-office vive aparte, en escritorio, y el salonero nunca lo ve:

| Pantalla | Propósito |
|---|---|
| **Menú** | Productos, precios y clasificación CABYS |
| **Cierre de caja** | Arqueo del turno: esperado contra contado |
| **Reportes** | Ventas del día, IVA por tarifa, medios de pago |
| **Comprobantes** | Estado ante Hacienda, clave numérica, reintentos |
| **Ajustes** | Certificado digital y usuarios con sus roles |

### Por qué el back-office es un rol aparte

No es comodidad, es control. Si el cajero puede cambiar precios, puede bajar el precio de un plato, cobrarlo y volver a subirlo, sin dejar rastro. Separar **quién vende** de **quién define qué se vende** es una medida contra fraude interno. Lo mismo aplica a los reintentos ante Hacienda y a las anulaciones de comprobantes ya emitidos: no pueden estar al alcance de nadie en medio de un turno.

### El comprobante como registro

Cobrar no puede limitarse a cerrar la mesa: tiene que **crear un comprobante persistente** con su consecutivo, su clave numérica de 50 dígitos, el snapshot de líneas y su estado ante Hacienda. Sin ese registro no hay arqueo, ni reportes, ni cola de reintentos — las tres pantallas de arriba dependen de él. Es la frontera de inmutabilidad de la regla 2 del doc 01, materializada.

### Flujo del pedido

```
Salón ──abrir mesa──▶ Pedido ──enviar a cocina──▶ Pedido (abierto)
                         │                            │
                         └──────── cobrar ────────────┘
                                     ▼
                                   Cobro ──▶ Comprobante (inmutable) ──▶ [cola Hacienda]
                                              │
                                              └──▶ impresión térmica inmediata
```

La impresión ocurre **antes** de la respuesta de Hacienda. El cliente no espera al fisco.

---

## 4. Modelo de datos — delta sobre el doc 01

Todo lo del doc 01 se mantiene. Se agrega el vertical:

```prisma
model Salon {
  id       String  @id @default(uuid())
  nombre   String  // "Terraza", "Interior"
  mesas    Mesa[]
}

model Mesa {
  id        String     @id @default(uuid())
  salonId   String
  numero    String
  capacidad Int
  ordenes   Orden[]
  @@unique([salonId, numero])
}

// MUTABLE. No es un documento fiscal.
model Orden {
  id           String       @id @default(uuid())
  mesaId       String?      // null = para llevar / express
  turnoId      String
  meseroId     String
  comensales   Int?
  estado       EstadoOrden  @default(ABIERTA)
  abiertaEn    DateTime     @default(now())
  cerradaEn    DateTime?

  lineas       OrdenLinea[]
  comprobantes Comprobante[] // varios si se dividió la cuenta

  @@index([turnoId, estado])
}

model OrdenLinea {
  id            String   @id @default(uuid())
  ordenId       String
  productoId    String
  cantidad      Decimal  @db.Decimal(18, 5)
  precioUnitario Decimal @db.Decimal(18, 5) // congelado al agregar
  notas         String?  // "sin cebolla", "término medio"
  enviadaCocinaEn DateTime?
  anuladaEn     DateTime?
  anuladaPor    String?
  motivoAnulacion String?
}

// Arqueo de caja
model Turno {
  id            String    @id @default(uuid())
  terminalId    String
  usuarioId     String
  abiertoEn     DateTime  @default(now())
  cerradoEn     DateTime?
  montoApertura Decimal   @db.Decimal(18, 5)
  montoDeclarado Decimal? @db.Decimal(18, 5) // lo que el cajero contó
  montoEsperado  Decimal? @db.Decimal(18, 5) // lo que dice el sistema
  ordenes       Orden[]
}

// Surtidos 4.4 — solo para paquetes armados de origen
model Surtido {
  id          String            @id @default(uuid())
  productoId  String            @unique
  componentes SurtidoComponente[]
}

model SurtidoComponente {
  id          String  @id @default(uuid())
  surtidoId   String
  codigoCabys String
  detalle     String
  cantidad    Decimal @db.Decimal(18, 5)
  montoTotal  Decimal @db.Decimal(18, 5)
}

enum EstadoOrden { ABIERTA ENVIADA_COCINA CERRADA ANULADA }
```

Añadido a `Comprobante`: `ordenId String?` y `propina Decimal?`.

---

## 5. Deltas fiscales frente al doc 01

### 5.1 El Tiquete Electrónico manda

En un restaurante el 90% de las ventas son TE al consumidor final, sin datos de receptor. La FE es la excepción — el cliente que pide factura a nombre de su empresa. Consecuencias:

- El flujo por defecto en Cobro es **TE**, con "¿Necesita factura?" como opción secundaria.
- Si el cliente pide factura, hacen falta cédula, nombre, correo y **código de actividad económica** (nuevo obligatorio en 4.4). Ese último campo sería fricción insoportable en el mostrador si se pidiera a mano.

**La solución es el padrón de Hacienda.** Existe un endpoint público que resuelve el problema:

```
GET https://api.hacienda.go.cr/fe/ae?identificacion=3101123456
```

Devuelve nombre, tipo de identificación, régimen, situación tributaria y **las actividades económicas** del contribuyente. Con eso, el cajero digita la cédula y lo único que decide es cuál actividad aplica cuando el cliente tiene varias.

Reglas de implementación:

- **La consulta va desde el backend, nunca desde el POS.** Hacienda limita por tasa y responde 429; hay que cachear en servidor por identificación y reintentar con backoff. Un salón lleno consultando en paralelo desde diez tablets se auto-bloquea.
- **Guardar el receptor como cliente frecuente.** La segunda factura al mismo cliente debe ser de un toque, sin consulta.
- **Salida manual obligatoria.** Turistas y no contribuyentes no están en el padrón; la 4.4 agregó justamente los tipos "extranjero no domiciliado" y "no contribuyente" para ese caso. El formulario tiene que permitir capturarlos a mano.
- **El receptor no tiene por qué ser una empresa.** Cualquier persona puede pedir factura — un asalariado que necesita el comprobante para un reembolso tiene el mismo derecho. Un cliente puede estar en el padrón y aun así **no tener ninguna actividad económica registrada**. El formulario no puede exigir actividad como campo universal; debe tratar ese caso como consumidor final.

> **Punto abierto que hay que cerrar antes de programar el XML.** La 4.4 volvió obligatorio el código de actividad del receptor en los comprobantes que lo identifican, pero las fuentes secundarias consultadas no aclaran qué se envía cuando el receptor no tiene ninguna: si el campo se omite, si existe un código genérico, o si el tipo de identificación "no contribuyente" exime del campo. Resolver contra el XSD oficial de la resolución MH-DGT-RES-0027-2024.
- La 4.4 permite **hasta cuatro correos** por receptor.

### 5.1b Cómo se elige el CABYS

Mismo servicio, otro endpoint:

```
GET https://api.hacienda.go.cr/fe/cabys?q=arroz          # por descripción, mínimo 3 caracteres
GET https://api.hacienda.go.cr/fe/cabys?codigo=0112100000000   # por código exacto
```

**Regla de diseño: la tarifa se deriva del CABYS por defecto; corregirla es un acto deliberado.** El catálogo pasa de veinte mil códigos y cada uno trae su tarifa, pero **esa tarifa es de referencia**: la responsabilidad de aplicar la correcta es del contribuyente, no del catálogo. El formulario no puede ofrecer un campo de tarifa suelto al lado del código —eso permite crear productos incoherentes por descuido— pero tampoco puede impedir la corrección. La solución es derivar, mostrar de dónde salió, y exigir un gesto explícito para cambiarla, dejando visible que quedó ajustada.

### Cómo se determina el código de cada producto

- **La fuente oficial es el BCCR**, no Hacienda: `bccr.fi.cr` → Indicadores Económicos → Catálogo de Bienes y Servicios. Hay buscador en línea, Excel descargable e instructivo de búsqueda.
- **El catálogo es jerárquico.** Arranca en unos diez grupos grandes y baja por niveles hasta los 13 dígitos. Conviene buscar por categoría general y afinar, no adivinar el código completo.
- **Se clasifica lo que se vende, no los ingredientes.** Un casado no es "arroz + frijoles + pollo": es un servicio de comida preparada. El mismo arroz lleva código distinto en bolsa que servido en un plato, y por eso lleva tarifa distinta.
- **Buscar por lo que la cosa es, no por su marca.** El catálogo no conoce marcas comerciales.
- **Es trabajo del contador, una vez.** Se hace al cargar el menú y se revisa cuando el menú cambia; no es tarea diaria del negocio. Un código mal puesto significa IVA mal cobrado, con exposición fiscal y un comprobante que el cliente no puede usar para crédito.

Consecuencia en el POS: **el IVA se calcula por línea, no por comanda.** Una soda que vende casados al 13% y arroz a granel al 1% en la misma cuenta necesita las dos tarifas en el mismo comprobante. El modelo del doc 01 ya lo contempla —`impuestos` va en `LineaComprobante`, no en el encabezado— pero conviene tenerlo presente al construir el XML.

Nota sobre exoneraciones: son **por transacción**, no por producto. Un cliente con autorización de exoneración exonera esa venta concreta; el producto conserva su tarifa. Por eso la exoneración vive en la línea del comprobante y no en la ficha del producto.
- El roadmap del doc 01 se invierte: **TE primero, FE después**.

### 5.2 Servicio 10%

Por Ley 4946 va en el nodo **OtrosCargos**, etiquetado "Impuesto de servicio 10%". Suma al total pero **no es ingreso del negocio** — se distribuye entre el personal. En el modelo cae en `totalOtrosCargos`, que ya existe.

Configuración necesaria: activable/desactivable por local, y por orden (algunas mesas no lo llevan, y para llevar normalmente no aplica).

> **Pendiente de confirmar con contador:** la base imponible del IVA cuando hay servicio 10% — si el 13% se calcula sobre el subtotal de productos o sobre subtotal + servicio. También el tratamiento de la propina voluntaria, que es distinta del servicio de ley. No avanzar la lógica de cálculo hasta tener esto por escrito.

### 5.3 Surtidos (combos)

La 4.4 introduce el nodo `DetalleSurtido`. Reglas:

- El desglose es **obligatorio solo si los componentes tienen tarifas de IVA distintas**. Si todo el combo va al 13%, no hace falta.
- Aplica a paquetes **armados de origen**. Un combo que el restaurante arma con productos que ya viven por separado en su menú **no es un surtido fiscal**: se factura como productos individuales con el descuento aplicado.

Para un restaurante típico casi todo va al 13%, así que en la práctica el nodo se usa poco. Pero el modelo lo contempla porque un combo con producto exento adentro (cierta canasta básica) obliga al desglose.

### 5.4 Contingencia pesa más

Un restaurante no puede dejar de vender porque Hacienda o el internet estén caídos. La cola del doc 01 ya lo cubre, pero aquí es requisito de negocio, no técnico: **el POS debe cobrar e imprimir sin conexión**, marcar `situacion = CONTINGENCIA` y transmitir cuando vuelva.

### 5.5 Impresión

Térmica de 80mm, no PDF A4. El PDF sigue existiendo para el envío por correo cuando se emite FE.

---

## 6. Riesgos propios del vertical

- **La firma XAdES sigue siendo el riesgo #1.** Sin cambios respecto al doc 01: fase 0 antes que nada.
- **~~Impresora térmica desde el navegador.~~ ACOTADO.** Ver [packages/impresion](../packages/impresion/README.md). El agente local funciona: recibe el comprobante por HTTP en `127.0.0.1:9100` y habla ESC/POS con la impresora. Solo va en la máquina de caja, porque solo la caja imprime. Falta verlo salir de una impresora real — la marca define si el QR sale y si el codepage es el 19.
- **Offline real.** "Funciona sin internet" significa IndexedDB, cola local y resolución de conflictos. Es la funcionalidad más cara del proyecto. Decidir pronto si se implementa de verdad o si el alcance es "tolera cortes de minutos" con la caja conectada por cable.
- **Alta rotación de personal.** Si el POS necesita capacitación, no sirve. Métrica de aceptación: un salonero nuevo toma un pedido sin ayuda a los 5 minutos.
- **Código de actividad del receptor** — nuevo en 4.4 y fricción directa en el mostrador cuando piden factura.

---

## 7. Fases

| Fase | Entregable | Terminado cuando |
|---|---|---|
| **0** | ~~Firma XAdES~~ · **hecha** | Firma generada y verificada en Node |
| **0.5** | Envío al sandbox | Falta la llave de TRIBU-CR y el XSD oficial |
| **0b** | ~~Tiquete ESC/POS y agente local~~ · **hecho** | Bytes correctos, agente responde por HTTP |
| **0b.5** | Impresora real | Sale un tiquete de papel de verdad |
| **1** | Núcleo: esquema + `packages/hacienda` (TE) | Genera y valida TE contra el XSD 4.4 |
| **2** | Menú y CABYS en `apps/admin` | Se carga el menú completo con sus códigos |
| **3** | POS: salón, pedido, cobro (efectivo) | Se cobra una mesa y sale el tiquete |
| **4** | Cola Hacienda + estados + reintentos | Tiquete real aceptado de punta a punta |
| **5** | Medios de pago, división de cuenta, propina | Cuenta dividida entre 3 con tarjeta y SINPE |
| **6** | Turnos y cierre de caja | Arqueo cuadra con lo declarado |
| **7** | FE bajo demanda + envío por correo | Cliente que pide factura la recibe |
| **8** | NC (anulaciones) + reportes | Anulación de una venta del día anterior |
| **9** | Producción | Certificado real, ambiente productivo |

Las fases 0 y 0b van primero a propósito: son las dos que pueden obligar a cambiar decisiones técnicas de fondo, y ambas son baratas de probar hoy y carísimas de descubrir con el POS ya construido.

---

## Fuentes

- [Servicio 10% en OtrosCargos (Ley 4946)](https://blog.factun.com/facturacion-electronica/generacion-automatica-calculo-impuesto-servicio-factun)
- [Desglose de combos y descuentos 4.4](https://siemprealdia.co/costa-rica/impuestos/desglose-de-descuentos-y-combos-en-la-factura-electronica/)
- [Nodo DetalleSurtido](https://llbsolutions.com/es/comprobantes-electronicos-v4-4-en-costa-rica-que-debes-saber-sobre-el-nodo-detallesurtido/)
- [Cambios relevantes 4.4 — Deloitte](https://www.deloitte.com/latam/es/services/tax/perspectives/cr-comprobante-electronico-4-4-cinco-cambios-relevantes.html)
- [Documentación API Hacienda](https://api.hacienda.go.cr/docs)
