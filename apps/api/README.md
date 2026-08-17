# apps/api

El servidor del local. **Es el único que escribe** — ver [02-restaurante.md](../../docs/02-restaurante.md).

```bash
node inventario.js          # crea la base y muestra qué quedó dentro
node certificados.js        # HTTPS para la red del local (una sola vez)
node probar.js              # corte vertical: cobrar, firmar, imprimir, sincronizar
node probar-admin.js        # menú, caja, notas de crédito, usuarios
node probar-tls.js          # que el HTTPS del local valide de verdad
node qa.js                  # precisión, concurrencia, entradas hostiles
node src/servidor.js        # levanta la API
```

## HTTPS en la red del local

`node certificados.js` crea una autoridad certificadora propia y un certificado de servidor válido para todas las IPs de la máquina. Cuesta **₡0**.

**Por qué no Let's Encrypt:** emite para dominios públicos, y el servidor del local no está en internet a propósito. Para una red cerrada, la salida es una CA propia.

Instalación, una vez por tablet:

1. Abrir `http://<ip>:4000/ca.crt` y agregarlo como autoridad de confianza
2. Usar `https://<ip>:4443` de ahí en adelante

Sin instalar la CA, el navegador rechaza la conexión — que es exactamente lo que debe pasar.

**Por qué importa, más allá del PIN:** los *service workers* solo corren en contexto seguro. Sin HTTPS, la puerta de que las tablets funcionen sin red queda cerrada. Con esto queda abierta.

> `certs/` está fuera del control de versiones. `servidor.key` no sale de esa máquina.
>
> Ojo al probar desde Windows: `curl` usa schannel y valida contra el almacén del sistema, así que `--cacert` da un falso negativo. Por eso la prueba está en Node.

## La base

16 tablas, 4 triggers de inmutabilidad, 9 índices.

| | |
|---|---|
| **Fiscal** | `emisor` `sucursal` `terminal` `contador` `certificado` |
| **Personas** | `usuario` `receptor` |
| **Salón** | `salon` `mesa` |
| **Catálogo** | `producto` |
| **Caja** | `turno` `pago` |
| **Mutable** | `orden` `orden_linea` |
| **Inmutable** | `comprobante` `comprobante_linea` |

Las líneas del comprobante están **normalizadas, no en JSON**: los reportes de IVA por tarifa y de productos más vendidos salen con un `GROUP BY`, no leyendo y parseando cada fila.

Dos restricciones que resuelve el motor y no el código:

- `ix_una_orden_por_mesa` — índice único parcial: **una mesa no puede tener dos órdenes abiertas**.
- `producto.cabys` tiene `CHECK (length(cabys) = 13)` — un código mal no entra.

Para que la impresión funcione, el agente tiene que estar corriendo:

```bash
node ../../packages/impresion/agente.js
```

---

## Qué prueba el corte vertical

Una mesa cobrada de verdad, con todas las piezas conectadas:

```
salonero ──WS──┐
               ├── API ── SQLite ── firma XAdES ── agente ── impresora
caja ─────WS──┘
```

| | |
|---|---|
| Dos dispositivos por WebSocket | se enteran sin preguntar |
| Menú desde la base | 7 productos |
| IVA por línea, dos tarifas | 13% y 1% en la misma cuenta |
| Consecutivo de 20 dígitos | del contador, con bloqueo |
| Clave de 50 dígitos | con el dígito de situación |
| XML firmado | 6.698 bytes, guardado sin reformatear |
| Impresión | 992 bytes al agente |
| Comprobante inmutable | la base rechaza borrarlo y alterarlo |
| Consecutivo sin huecos | el rollback devuelve el contador |
| Doble cobro | rechazado |

## Decisiones que difieren del doc 01

Se tomaron al construir, por falta de Docker en el equipo. Ninguna contradice el diseño; dos lo mejoran.

| Doc 01 | Aquí | Por qué |
|---|---|---|
| Postgres | SQLite (`node:sqlite`) | Sin Docker. El SQL es portable; migrar es cambiar el driver |
| `NUMERIC(18,5)` | **entero escalado ×10⁵** | Honra mejor la regla: exacto en cualquier motor, imposible que se cuele un float |
| NestJS | `node:http` | Corte vertical: menos andamio, más fácil de leer |
| Prisma | SQL a mano | El bloqueo del consecutivo se ve; con ORM se esconde |

**Sobre el dinero:** todo monto entra por `aEntero()` y sale por `redondear()`. Nunca hay un float en la base. Límite por valor: ₡90.071.992.547 — de sobra para un restaurante.

## Lo que el motor impide, no solo el código

Las reglas del diseño están como *triggers*, no como buenas intenciones:

```sql
CREATE TRIGGER comprobante_inmutable_delete BEFORE DELETE ON comprobante
BEGIN SELECT RAISE(ABORT, 'Un comprobante no se borra: se anula con nota de credito'); END;
```

Un `DELETE` o un cambio de monto revientan aunque alguien lo intente desde una consola. Solo se permite mover `estado_hacienda`, que es lo único que legítimamente cambia después de emitir.

## El consecutivo

```js
correr("UPDATE contador SET ultimo = ultimo + 1 WHERE ...");
```

Dentro de la misma transacción que crea el comprobante. Si algo falla después, el rollback **devuelve el contador** — cosa que un `AUTOINCREMENT` no haría, dejando huecos en la numeración fiscal. La prueba lo verifica.

## La firma va fuera de la transacción

Firmar es lento y no debe sostener el lock de la base. Si la firma falla, el comprobante queda emitido y pendiente, que es lo correcto: **el consecutivo ya se consumió y no se puede reusar.**

## La venta no se cae por la impresora

Si el agente no responde, el cobro igual se completa y devuelve el error de impresión aparte. El comprobante queda reimprimible.

## Autenticación

Todo endpoint exige sesión menos `GET /usuarios` y `POST /login`. El token va en `Authorization: Bearer`, y **el WebSocket también lo exige** — si no, cualquiera en el WiFi del local vería pasar las comandas y los montos.

Los PINes se guardan con **scrypt** y se comparan en tiempo constante. Nunca en claro.

Tres decisiones de seguridad que valen más que el código que las implementa:

- **Mismo mensaje para usuario inexistente y PIN incorrecto.** Si difieren, se puede enumerar quién trabaja ahí.
- **Bloqueo a los 5 intentos.** Un PIN de 4 dígitos sin bloqueo se rompe en segundos.
- **Un salonero no anula una orden con comida cargada.** Puede cerrar una mesa vacía, pero anular después de servir es merma, y es el patrón clásico de robo interno. Lo hace caja o administración, y queda registrado quién.

Permisos por ruta en `src/auth.js`. Lo que no está listado, nadie puede.

## El padrón de Hacienda

`GET /padron?cedula=` consulta `api.hacienda.go.cr/fe/ae` y trae nombre y actividades económicas. Es lo que hace viable el campo nuevo de la 4.4: nadie se sabe su código de actividad, pero todos se saben su cédula.

**La consulta sale del servidor, nunca del POS**, y se cachea un mes en la tabla `padron`. Hacienda limita por tasa y responde 429; diez tablets preguntando en paralelo se auto-bloquean.

Si Hacienda no responde, se usa la caché aunque esté vencida. **La factura no se detiene porque el padrón no conteste.**

> **Cuidado al probar: las cédulas costarricenses son secuenciales.** Cualquier número de 9 dígitos con forma válida pertenece a una persona real, y consultarlo trae sus datos. Los identificadores de prueba de `src/padron.js` empiezan con 9, que no corresponde a ninguna provincia y Hacienda siempre rechaza.

## La nota de crédito y el dinero

**Anular una venta cobrada no borra ni edita nada.** Se emite una nota de crédito que referencia al original, copia sus líneas y lo revierte. Lleva `03` en el consecutivo y su propia clave de 50 dígitos.

De ahí salió el bug más caro de esta etapa: **la NC se estaba sumando como venta.** El dinero de una devolución *sale* de la caja, no entra. La causa de fondo era que el arqueo y la consulta del turno calculaban el mismo número en dos lugares distintos, y divergieron.

Ahora hay una sola función, `cuentasTurno()`, y la regla queda explícita:

```js
const signo = f.tipo === "NC" ? -1 : 1;
```

Los reportes aplican lo mismo con un `CASE WHEN c.tipo = 'NC' THEN -1 ELSE 1 END`. Una venta anulada deja la caja exactamente como estaba — eso lo verifica la prueba.

## La cola se vacía sola

`src/cola.js` corre cada 30 segundos con **backoff exponencial** —30s, 1m, 2m, 4m… hasta media hora— y no gasta reintentos si no hay llave cargada.

El botón *Transmitir ahora* usa exactamente el mismo camino, solo se salta la espera. Dos rutas distintas para lo mismo es cómo divergen.

**Por qué importa:** sin esto, un comprobante emitido en contingencia se quedaba en la base para siempre a menos que alguien entrara al back-office y tocara un botón. Nadie hace eso todos los días, y acumular comprobantes sin transmitir es un problema fiscal.

## Respaldo

`src/respaldo.js` corre al arrancar y cada 6 horas. Guarda 14 copias y borra las viejas.

Dos reglas que este módulo toma en serio:

- **No se copia el archivo con `cp`.** En modo WAL eso produce una copia inconsistente que parece funcionar hasta el día que la necesitás. Se usa `VACUUM INTO`, que hace una instantánea coherente aunque haya escrituras en curso.
- **Un respaldo que nunca se restauró no es un respaldo.** Cada uno se verifica abriéndolo, corriendo `integrity_check` y contando lo que debería tener. Si no cuadra, se borra y se avisa.

Comprime a un **7% del tamaño** — el XML firmado es texto muy repetitivo.

```bash
node restaurar.js                    # lista los disponibles
node restaurar.js <archivo>          # verifica y restaura
```

Restaurar guarda antes la base actual. Reemplazar sobre una base viva sin red de seguridad es cómo se pierden dos copias en vez de una.

> Falta el respaldo **fuera del local**. Hoy las copias viven en el mismo disco: eso protege de una corrupción, no de un incendio. Ahí entra Cloudflare R2.

## Pendiente

- Transmisión real al sandbox — falta la llave de TRIBU-CR (el hueco está marcado en `cola.js`)
- Envío del XML por correo al receptor
- Dividir cuenta y propina
- Migrar a Postgres cuando haya Docker

## Archivos

```
esquema.sql        DDL con las reglas del diseño y los triggers
src/db.js          conexión, dinero escalado, transacciones
src/cobrar.js      donde lo mutable se vuelve inmutable
src/servidor.js    HTTP + WebSocket
probar.js          el corte vertical
```
