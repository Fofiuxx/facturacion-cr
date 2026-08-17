# packages/impresion

Genera el tiquete en ESC/POS y lo manda a la impresora térmica. Corre en la máquina de caja, no en el POS.

```bash
node probar.js                 # arma un tiquete y lo muestra en consola
node agente.js                 # levanta el agente (guarda a archivo)
node agente.js --destino tcp://10.0.0.50:9100
node agente.js --destino printer://POS-80
```

---

## Resultado de la fase 0b

**El tiquete ESC/POS se arma bien desde Node y el agente local funciona.** Era el segundo riesgo del proyecto y queda acotado.

| | |
|---|---|
| Flujo de bytes | init, codepage, corte de papel |
| Acentos | CP858: `é` → `0x82`, `ñ` → `0xA4`, no `?` |
| Ancho | ninguna línea pasa de 48 columnas en 80mm |
| QR | con la clave numérica, para que el cliente verifique |
| Agente HTTP | recibe JSON, devuelve bytes generados |

Falta lo único que no se puede simular: **verlo salir de una impresora real.**

## Por qué hace falta un agente

Un navegador no puede hablar ESC/POS. `window.print()` manda al driver del sistema, que renderiza como página — no sirve para una térmica de 80mm que espera comandos crudos.

La salida es este proceso pequeño en la máquina de caja: escucha en `127.0.0.1:9100`, recibe el comprobante en JSON y es el único que toca la impresora.

```
POS (navegador)  ──HTTP──▶  agente local  ──ESC/POS──▶  impresora
```

Encaja con la decisión de roles: **solo la caja imprime**, así que el agente va en una sola máquina. Los teléfonos de los saloneros no necesitan nada.

**El agente solo acepta conexiones desde `127.0.0.1`.** No se expone a la red: si lo hiciera, cualquiera en el WiFi del local podría imprimir.

## Tres destinos

| Destino | Cuándo |
|---|---|
| `file://` | pruebas, sin impresora |
| `tcp://ip:9100` | impresora de red — el más común y el más estable |
| `printer://nombre` | recurso compartido de Windows |

## Detalles que cuestan si se descubren tarde

**El codepage.** Las térmicas no hablan UTF-8. Hay que seleccionar la tabla (`ESC t 19` = PC858) y traducir cada acento a su byte. Sin eso, `Café` sale como `Caf?`. Lo que no está en la tabla se degrada quitando la tilde, nunca a `?`.

**El ancho es en columnas, no en píxeles.** 48 caracteres a fuente A en 80mm, 32 en 58mm. Los nombres largos se parten por palabras: si no, la impresora corta a media palabra.

**La vista previa tiene que decodificar de vuelta.** Al principio la mostraba como latin1 y salía `Escaz£` — la previsualización mentía sobre lo que iba a imprimirse. Peor que no tenerla.

## Pendiente

- Probarlo en una impresora real (marca y modelo definen si el QR sale y si el codepage es 19)
- Cajón de dinero: se abre con `ESC p` por el mismo puerto
- Reimpresión de un comprobante ya emitido
- Instalarlo como servicio de Windows para que arranque solo

## Archivos

```
src/escpos.js   comandos ESC/POS y codificación CP858
src/tiquete.js  render del comprobante
agente.js       servidor local de impresión
probar.js       la prueba de la fase 0b
```
