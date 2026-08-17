# Sistema de Facturación Electrónica — Costa Rica v4.4

**Estado:** diseño, previo a implementación
**Alcance:** facturación básica, un contribuyente, con emisión electrónica ante Hacienda
**Fecha:** 2026-08-05

---

## 1. Alcance

**Dentro:**

- Catálogo de clientes (receptores) y de productos/servicios con código CABYS
- Emisión de Factura Electrónica (FE), Tiquete Electrónico (TE), Nota de Crédito (NC) y Nota de Débito (ND)
- Recibo Electrónico de Pago (REP) — nuevo y **obligatorio** en 4.4 para crédito con diferimiento de IVA y para cobros al Estado
- Firma XAdES-EPES, envío a Hacienda, consulta de estado y reintentos
- Entrega al receptor (XML firmado + respuesta de Hacienda + PDF) por correo
- Registro de pagos y estado de cobro de cada factura
- Reportes básicos: ventas por período, IVA repercutido, cuentas por cobrar

**Fuera (por ahora, pero el modelo no debe estorbarlo):**

- Inventario y compras
- Multi-empresa / SaaS
- Aceptación/rechazo de comprobantes recibidos de proveedores (Mensaje Receptor)
- Contabilidad de partida doble

---

## 2. Stack

| Capa | Elección | Razón |
|---|---|---|
| Backend | Node 22 + TypeScript + **NestJS** | Mucha lógica de dominio y trabajo en background; los módulos y la DI de Nest evitan que esto se vuelva una bola de barro |
| DB | **PostgreSQL 16** + Prisma | Transacciones ACID reales y `NUMERIC` exacto. Innegociable |
| Cola | **BullMQ** + Redis | El envío a Hacienda es asíncrono y falla; necesita reintentos con backoff |
| Frontend | React 19 + TypeScript + Vite | — |
| Datos en cliente | TanStack Query | Cache e invalidación sin escribir un reducer por pantalla |
| Formularios | React Hook Form + Zod | Los formularios de factura son grandes y con validación cruzada |
| Validación compartida | Zod en `packages/shared` | El mismo esquema valida en el cliente y en el servidor |
| PDF | Puppeteer, server-side | El PDF es un documento legal; no se genera en el navegador del usuario |
| Firma XML | `xadesjs` / `node-forge`, o binario Java auxiliar | Ver §7 — es el punto de mayor riesgo técnico |
| Auth | JWT propio + Argon2 | Alcance pequeño; no vale la pena un IdP externo todavía |

### Estructura del repo

```
facturacion-cr/
├── apps/
│   ├── api/          # NestJS
│   └── web/          # React + Vite
├── packages/
│   ├── shared/       # tipos + esquemas Zod compartidos
│   └── hacienda/     # TODO lo fiscal, aislado y sin dependencias del resto
└── docker-compose.yml   # postgres + redis
```

`packages/hacienda` **no importa nada** de `apps/api`. Recibe objetos planos y devuelve XML/respuestas. Así se puede testear contra los XSD oficiales sin levantar la aplicación, y cuando salga la v4.5 se toca un solo paquete.

---

## 3. Reglas de dominio no negociables

Estas cinco definen el modelo de datos. Retrofitearlas después es carísimo.

1. **Nada de coma flotante.** Dos representaciones válidas: `NUMERIC(18,5)` en Postgres, o **entero escalado ×10⁵**. El corte vertical usa la segunda ([apps/api](../apps/api/README.md)) porque es exacta en cualquier motor y hace imposible que se cuele un float por descuido. Hacienda acepta hasta 5 decimales. El redondeo se aplica una sola vez, en el punto definido por la regla de cálculo del XML, nunca de forma incidental.

2. **Una factura emitida es inmutable.** No hay `UPDATE` sobre la factura ni sobre sus líneas después de la emisión. Se corrige con Nota de Crédito (anula o rebaja) o Nota de Débito (aumenta). El endpoint `DELETE /facturas/:id` no existe.

3. **El consecutivo no puede tener huecos ni repetirse.** Se asigna con un contador en tabla propia bajo `SELECT ... FOR UPDATE`, dentro de la misma transacción que crea la factura. **Nunca** con `AUTO_INCREMENT`/`SERIAL`: las secuencias de Postgres no hacen rollback y dejarían huecos.

4. **La clave numérica es la clave de idempotencia.** 50 dígitos, generada una sola vez y persistida antes de cualquier intento de envío. Un reintento reusa la misma clave; nunca se regenera. Esto es lo que evita facturar dos veces cuando la red se cae a medio camino.

5. **El XML firmado y la respuesta de Hacienda son la fuente de verdad legal**, no las filas de la base de datos. Se guardan tal cual, sin reformatear (reformatear rompe la firma), y se conservan 5 años.

---

## 4. Modelo de datos

Prisma, abreviado. Omito timestamps de auditoría, que van en todas las tablas.

```prisma
// ─── Emisor: el contribuyente que usa el sistema ───
model Emisor {
  id                String   @id @default(uuid())
  nombre            String
  nombreComercial   String?
  tipoIdentificacion String  // 01 física, 02 jurídica, 03 DIMEX, 04 NITE
  identificacion    String
  codigoActividad   String   // actividad económica principal
  provincia         String
  canton            String
  distrito          String
  otrasSenas        String
  telefono          String?
  correo            String
  ambiente          Ambiente // SANDBOX | PRODUCCION

  sucursales        Sucursal[]
  certificado       Certificado?
}

// Determina los primeros 8 dígitos del consecutivo (3 sucursal + 5 terminal)
model Sucursal {
  id            String     @id @default(uuid())
  emisorId      String
  codigo        String     // "001"
  nombre        String
  terminales    Terminal[]
  @@unique([emisorId, codigo])
}

model Terminal {
  id           String      @id @default(uuid())
  sucursalId   String
  codigo       String      // "00001"
  contadores   Contador[]
  @@unique([sucursalId, codigo])
}

// Regla 3: un contador por (terminal, tipo de documento)
model Contador {
  id           String       @id @default(uuid())
  terminalId   String
  tipoDocumento TipoDocumento
  ultimoValor  BigInt       @default(0)
  @@unique([terminalId, tipoDocumento])
}

// Credencial de firma. El .p12 NUNCA en el repo ni en texto plano.
model Certificado {
  id             String   @id @default(uuid())
  emisorId       String   @unique
  p12Cifrado     Bytes    // AES-256-GCM con clave de KMS/env
  pinCifrado     Bytes
  usuarioApi     String   // usuario del IdP de Hacienda
  passwordCifrado Bytes
  venceEn        DateTime // alertar 30 días antes: si vence, se para la facturación
}

// ─── Receptor: el cliente ───
model Receptor {
  id                 String  @id @default(uuid())
  emisorId           String
  tipoIdentificacion String? // 4.4 añade "extranjero no domiciliado" y "no contribuyente"
  identificacion     String?
  nombre             String
  codigoActividad    String? // NUEVO en 4.4: actividad económica del receptor
  identificacionExtranjero String?
  correo             String?
  telefono           String?
  // dirección: opcional en TE, requerida en FE
  provincia String?  canton String?  distrito String?  otrasSenas String?

  @@index([emisorId, identificacion])
}

// ─── Producto ───
model Producto {
  id            String   @id @default(uuid())
  emisorId      String
  codigoInterno String
  codigoCabys   String   // 13 dígitos, obligatorio, determina la tarifa de IVA
  detalle       String
  unidadMedida  String
  precioUnitario Decimal @db.Decimal(18, 5)
  tarifaIvaCodigo String // 01 exento, 08 13%, etc.
  activo        Boolean  @default(true)

  @@unique([emisorId, codigoInterno])
}

// ─── Comprobante: FE, TE, NC, ND, REP ───
model Comprobante {
  id             String        @id @default(uuid())
  emisorId       String
  tipoDocumento  TipoDocumento
  clave          String        @unique  // 50 dígitos — regla 4
  consecutivo    String        @unique  // 20 dígitos — regla 3
  fechaEmision   DateTime                // con offset; Hacienda la valida contra su reloj
  situacion      Situacion     @default(NORMAL) // 1 normal, 2 contingencia, 3 sin internet

  receptorId     String?       // null en TE al consumidor final
  receptorSnapshot Json        // regla 2: datos congelados al emitir

  condicionVenta String        // 01 contado, 02 crédito, ... 4.4 añade arrendamientos
  plazoCreditoDias Int?        // 4.4: solo días, ya no meses
  medioPago      Json          // 4.4: array; incluye SINPE Móvil y plataformas digitales

  moneda         String        @default("CRC")
  tipoCambio     Decimal?      @db.Decimal(18, 5)

  // Totales — todos derivados de las líneas, persistidos porque son inmutables
  totalServGravados   Decimal @db.Decimal(18, 5)
  totalServExentos    Decimal @db.Decimal(18, 5)
  totalMercGravadas   Decimal @db.Decimal(18, 5)
  totalMercExentas    Decimal @db.Decimal(18, 5)
  totalDescuentos     Decimal @db.Decimal(18, 5)
  totalVenta          Decimal @db.Decimal(18, 5)
  totalVentaNeta      Decimal @db.Decimal(18, 5)
  totalImpuesto       Decimal @db.Decimal(18, 5)
  totalOtrosCargos    Decimal @db.Decimal(18, 5)
  totalComprobante    Decimal @db.Decimal(18, 5)

  estado         EstadoComprobante @default(BORRADOR)

  // Referencia: NC/ND/REP apuntan al comprobante que corrigen o cobran
  referenciaId   String?
  referencia     Comprobante?  @relation("Referencias", fields: [referenciaId], references: [id])
  derivados      Comprobante[] @relation("Referencias")

  lineas         LineaComprobante[]
  envio          EnvioHacienda?
  pagos          Pago[]

  @@index([emisorId, fechaEmision])
  @@index([estado])
}

model LineaComprobante {
  id             String  @id @default(uuid())
  comprobanteId  String
  numeroLinea    Int
  codigoCabys    String
  codigoInterno  String?
  cantidad       Decimal @db.Decimal(18, 5)
  unidadMedida   String
  detalle        String
  precioUnitario Decimal @db.Decimal(18, 5)
  montoTotal     Decimal @db.Decimal(18, 5)  // cantidad * precioUnitario
  descuentos     Json    // 4.4: cada descuento lleva código de un catálogo de 10
  subtotal       Decimal @db.Decimal(18, 5)
  impuestos      Json    // [{codigo, codigoTarifa, tarifa, monto, exoneracion?}]
  impuestoNeto   Decimal @db.Decimal(18, 5)
  montoTotalLinea Decimal @db.Decimal(18, 5)

  @@unique([comprobanteId, numeroLinea])
}

// ─── El diálogo con Hacienda ───
model EnvioHacienda {
  id             String   @id @default(uuid())
  comprobanteId  String   @unique
  xmlFirmadoUri  String   // ruta a S3/disco — no va en la DB
  respuestaXmlUri String? // el "Mensaje de Hacienda", también legalmente requerido
  estadoHacienda EstadoHacienda @default(PENDIENTE)
  intentos       Int      @default(0)
  ultimoError    String?
  enviadoEn      DateTime?
  resueltoEn     DateTime?
  entregadoAlReceptorEn DateTime?
}

model Pago {
  id            String   @id @default(uuid())
  comprobanteId String
  fecha         DateTime
  monto         Decimal  @db.Decimal(18, 5)
  medioPago     String
  referencia    String?
  repId         String?  // el REP emitido por este pago, si aplicaba
}

enum TipoDocumento { FE TE NC ND FEC FEE REP }
enum EstadoComprobante { BORRADOR EMITIDO ACEPTADO RECHAZADO ANULADO }
enum EstadoHacienda { PENDIENTE FIRMADO ENVIADO RECIBIDO ACEPTADO ACEPTADO_PARCIAL RECHAZADO ERROR }
enum Situacion { NORMAL CONTINGENCIA SIN_INTERNET }
enum Ambiente { SANDBOX PRODUCCION }
```

### Nota sobre `receptorSnapshot` y los totales

Ambos son desnormalización deliberada. Si el cliente cambia de dirección en 2027, la factura de 2026 debe seguir mostrando la dirección de 2026 — es un documento legal. Lo mismo con los totales: se calculan una vez, se validan contra el XML firmado y se congelan.

---

## 5. Máquina de estados

```
BORRADOR ──emitir──> EMITIDO ──firmar+enviar──> [cola] ──> ACEPTADO
   │                    │                                     │
   │                    └──> RECHAZADO (corregir y reemitir)   │
   └── editable                                                │
       y borrable                          nota de crédito ────┴──> ANULADO
```

Solo `BORRADOR` es editable. El paso `BORRADOR → EMITIDO` es la frontera de inmutabilidad: dentro de una transacción se asigna consecutivo, se genera la clave, se congelan totales y snapshot. A partir de ahí, solo lectura.

`RECHAZADO` es incómodo: el comprobante existe y consumió un consecutivo, pero no tiene validez fiscal. **No se reutiliza el consecutivo.** Se corrige el error y se emite uno nuevo, dejando el rechazado en el registro con su motivo.

---

## 6. El flujo con Hacienda

Asíncrono en dos tiempos. Esta es la parte que más se subestima.

```
1. Emitir (transacción DB)
   ├─ lock del contador → consecutivo (20 díg.)
   ├─ generar clave (50 díg.)
   ├─ congelar totales + snapshot
   └─ encolar job                       ← commit aquí

2. Job: construir XML → validar contra XSD → firmar XAdES-EPES
3. Job: POST /recepcion  → HTTP 202 = "recibido", NO "aceptado"
4. Job: polling GET /recepcion/{clave} con backoff hasta estado final
5. Job: guardar respuesta + enviar XML/PDF/respuesta al receptor por correo
```

**Composición de la clave numérica (50):**
`506` + `DDMMAA` (6) + cédula emisor (12, con ceros) + consecutivo (20) + situación (1) + código de seguridad (8) = 50

**Composición del consecutivo (20):**
sucursal (3) + terminal (5) + tipo documento (2) + secuencia (10) = 20

**Endpoints** (verificar contra la doc oficial antes de codificar):

| | Producción | Sandbox |
|---|---|---|
| API | `https://api.comprobanteselectronicos.go.cr/recepcion/v1/` | `.../recepcion-sandbox/v1/` |
| Token | `https://idp.comprobanteselectronicos.go.cr/auth/realms/rut/protocol/openid-connect/token` | `.../realms/rut-stag/...` |

El token OAuth2 expira en minutos y tiene refresh token. Cachearlo en Redis con margen; no pedir uno por request.

> **Verificar antes de codificar: el portal cambió.** Desde octubre de 2025, ATV fue reemplazado por **TRIBU-CR** (`ovitribucr.hacienda.go.cr`), y ahí se hacen la inscripción como emisor electrónico y la generación de la llave criptográfica. Los endpoints de recepción y del IdP listados arriba son los de la infraestructura anterior; hay que confirmar contra la documentación vigente si siguen siendo los mismos tras la migración. **Este es el primer punto a validar en la fase 0.**

**Sobre la llave criptográfica:** la emite Hacienda **sin costo** desde el portal, protegida por un PIN de cuatro dígitos que se define al generarla. Hay una llave de pruebas y una de producción. **Vencen a los 2 años** y deben renovarse — de ahí la alerta obligatoria del §7.

**Contingencia:** si Hacienda está caído, se emite igual con `situacion = CONTINGENCIA` y se transmite después. El sistema debe funcionar sin conexión al fisco — no se puede bloquear una venta porque la API esté abajo. Los jobs en cola cubren esto de forma natural.

---

## 7. Riesgos

**~~El principal: la firma XAdES-EPES en Node.~~ RESUELTO.** Ver [packages/hacienda](../packages/hacienda/README.md).

Se prototipó con `xadesjs` 2.6.8 sobre Node 24 y un certificado autofirmado: firma, verifica, y el perfil EPES sale con su política declarada. **No hace falta el microservicio en Java.** La única fricción fue registrar el DOM y XPath a mano con `setNodeDependencies`, que no está en la documentación principal del paquete.

Queda en pie la regla que lo hace frágil: **lo que se transmite es exactamente el string que sale del firmador.** Cualquier reserialización posterior invalida la firma.

**Otros:**

- **CABYS y tarifa de IVA.** Cada línea necesita el código correcto de 13 dígitos; la tarifa se deriva de él. Conviene importar el catálogo oficial completo a una tabla propia con búsqueda por texto, no dejar que el usuario lo escriba a mano.
- **Vencimiento del certificado.** Si expira, la facturación se detiene por completo. Alerta a 30 días y check en el health endpoint.
- **Reloj del servidor.** Hacienda valida `fechaEmision` contra su hora. Deriva de reloj = rechazos. NTP obligatorio.
- **Entrega al receptor es obligación legal**, no una cortesía. Reintentos y registro de entrega.
- **Los detalles a nivel de campo del XSD 4.4 hay que verificarlos contra el anexo oficial** de la resolución MH-DGT-RES-0027-2024. Los 146 cambios están resumidos aquí a grandes rasgos; el XSD manda.

---

## 8. Fases

| Fase | Entregable | Criterio de terminado |
|---|---|---|
| **0** | ~~Prototipo de firma~~ · **hecho** | Firma XAdES-EPES generada y verificada en Node |
| **0.5** | Envío al sandbox | Falta la llave de TRIBU-CR y el XSD oficial 4.4 |
| **1** | ~~Esquema DB + corte vertical~~ · **hecho** | Mesa cobrada, firmada, impresa y sincronizada ([apps/api](../apps/api/README.md)) |
| **2** | API: emisores, receptores, productos, CABYS | CRUD con tests |
| **3** | Emisión FE/TE + cola + polling | Factura real aceptada de punta a punta en sandbox |
| **4** | Frontend: pantalla de emisión, listados, detalle | Se puede facturar sin tocar la API a mano |
| **5** | PDF + envío por correo | Receptor recibe XML + respuesta + PDF |
| **6** | NC/ND, pagos y REP | Anulaciones y crédito con IVA diferido |
| **7** | Reportes y paso a producción | Certificado real, ambiente productivo |

La fase 0 va primero a propósito. Es la que puede cambiar el stack, y es mucho mejor descubrirlo antes de tener 40 pantallas construidas encima.

---

## Fuentes

- [Resolución y cambios 4.4 — DAC Solutions](https://dacsolutionscr.com/cambios-en-la-version-4-4-de-documentos-electronicos-costa-rica/)
- [146 ajustes XML en 4.4 — Facturele](https://www.facturele.com/2025/10/20/ajustes-xml-facturacion-electronica/)
- [Obligatoriedad desde septiembre 2025 — Siempre al Día](https://siemprealdia.co/costa-rica/impuestos/hacienda-confirma-obligatoriedad-de-la-factura-electronica-4-4/)
- [Documentación API del Ministerio de Hacienda](https://api.hacienda.go.cr/docs)
