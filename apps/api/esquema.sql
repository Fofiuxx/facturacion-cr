-- Base de datos del local. Sigue las reglas de docs/01-diseno.md.
--
-- DINERO: entero escalado x100000 (5 decimales, los que acepta Hacienda).
-- Nunca REAL. Exacto en cualquier motor, imposible que se cuele un float.
-- Límite seguro por valor: ~CRC 90.071.992.547.
--
-- FECHAS: enteros en milisegundos epoch. Sin ambigüedad de zona horaria.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────── Emisor y estructura fiscal

CREATE TABLE IF NOT EXISTS emisor (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  nombre              TEXT NOT NULL,
  nombre_comercial    TEXT,
  tipo_identificacion TEXT NOT NULL,
  identificacion      TEXT NOT NULL,
  codigo_actividad    TEXT NOT NULL,
  provincia           TEXT,
  canton              TEXT,
  distrito            TEXT,
  otras_senas         TEXT,
  telefono            TEXT,
  correo              TEXT NOT NULL,
  ambiente            TEXT NOT NULL DEFAULT 'sandbox'
                      CHECK (ambiente IN ('sandbox','produccion'))
);

CREATE TABLE IF NOT EXISTS sucursal (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,          -- 3 dígitos del consecutivo
  nombre TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursal(id),
  codigo      TEXT NOT NULL,            -- 5 dígitos del consecutivo
  nombre      TEXT NOT NULL,
  UNIQUE (sucursal_id, codigo)
);

-- Regla 3: el consecutivo no puede tener huecos ni repetirse.
-- Un contador por (sucursal, terminal, tipo). Nunca AUTOINCREMENT: las
-- secuencias no hacen rollback y dejarían huecos en la numeración fiscal.
CREATE TABLE IF NOT EXISTS contador (
  sucursal TEXT NOT NULL,
  terminal TEXT NOT NULL,
  tipo     TEXT NOT NULL,
  ultimo   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sucursal, terminal, tipo)
);

-- La llave criptográfica. El .p12 NUNCA en texto plano ni en el repositorio.
-- Se guarda cifrado con una clave que vive fuera de la base.
CREATE TABLE IF NOT EXISTS certificado (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  p12_cifrado  BLOB,
  pin_cifrado  BLOB,
  usuario_api  TEXT,
  clave_cifrada BLOB,
  emitido_en   INTEGER,
  vence_en     INTEGER NOT NULL,        -- vencen a los 2 años; alertar a 30 días
  ambiente     TEXT NOT NULL DEFAULT 'sandbox'
);

-- ─────────────────────────────── Personas

CREATE TABLE IF NOT EXISTS usuario (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre   TEXT NOT NULL,
  rol      TEXT NOT NULL CHECK (rol IN ('salonero','cocina','caja','admin')),
  pin_hash TEXT,                        -- scrypt: "salt:hash". Nunca el PIN en claro.
  fallidos INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta INTEGER,              -- 4 dígitos son 10.000 combinaciones:
  activo   INTEGER NOT NULL DEFAULT 1   -- sin bloqueo, se prueban en segundos
);

-- El rol sale de aquí, no del dispositivo. La tablet no es de nadie.
CREATE TABLE IF NOT EXISTS sesion (
  token      TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuario(id),
  creada_en  INTEGER NOT NULL,
  vence_en   INTEGER NOT NULL,
  dispositivo TEXT
);

CREATE INDEX IF NOT EXISTS ix_sesion_usuario ON sesion(usuario_id);

-- Receptor de factura. Puede no tener actividad económica: cualquier persona
-- puede pedir factura, tenga o no negocio.
CREATE TABLE IF NOT EXISTS receptor (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_identificacion TEXT NOT NULL,    -- 4.4 suma 05 extranjero, 06 no contribuyente
  identificacion      TEXT NOT NULL UNIQUE,
  nombre              TEXT NOT NULL,
  codigo_actividad    TEXT,             -- NULL = consumidor final
  correo              TEXT NOT NULL,
  telefono            TEXT,
  visto_en            INTEGER           -- para ordenar los frecuentes
);

-- Caché del padrón de Hacienda. La consulta va desde el servidor, nunca desde
-- el POS: Hacienda limita por tasa y diez tablets en paralelo se auto-bloquean.
CREATE TABLE IF NOT EXISTS padron (
  identificacion TEXT PRIMARY KEY,
  nombre         TEXT NOT NULL,
  tipo           TEXT,
  actividades    TEXT NOT NULL,        -- JSON [{codigo, descripcion}]
  consultado_en  INTEGER NOT NULL,
  origen         TEXT NOT NULL         -- hacienda | local
);

-- Caché del catálogo CABYS. Son más de 20.000 códigos: no se descarga entero,
-- se cachea lo que el negocio realmente usa.
CREATE TABLE IF NOT EXISTS cabys (
  codigo        TEXT PRIMARY KEY,
  descripcion   TEXT NOT NULL,
  tarifa        INTEGER NOT NULL,
  consultado_en INTEGER NOT NULL
);

-- ─────────────────────────────── Salón

CREATE TABLE IF NOT EXISTS salon (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesa (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id  INTEGER NOT NULL REFERENCES salon(id),
  numero    TEXT NOT NULL,
  capacidad INTEGER NOT NULL DEFAULT 4,
  activa    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (salon_id, numero)
);

-- ─────────────────────────────── Catálogo

CREATE TABLE IF NOT EXISTS producto (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_interno TEXT,
  nombre        TEXT NOT NULL,
  categoria     TEXT NOT NULL,
  precio        INTEGER NOT NULL CHECK (precio > 0),
  cabys         TEXT NOT NULL CHECK (length(cabys) = 13),
  tarifa        INTEGER NOT NULL,       -- 13, 4, 2, 1, 0
  codigo_tarifa TEXT NOT NULL,
  tarifa_ajustada INTEGER NOT NULL DEFAULT 0,  -- 1 si difiere del catálogo CABYS
  unidad_medida TEXT NOT NULL DEFAULT 'Unid',
  activo        INTEGER NOT NULL DEFAULT 1
);

-- ─────────────────────────────── Turno de caja

CREATE TABLE IF NOT EXISTS turno (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id     INTEGER NOT NULL REFERENCES terminal(id),
  usuario_id      INTEGER NOT NULL REFERENCES usuario(id),
  abierto_en      INTEGER NOT NULL,
  cerrado_en      INTEGER,
  monto_apertura  INTEGER NOT NULL,
  monto_declarado INTEGER,              -- lo que el cajero contó
  monto_esperado  INTEGER               -- lo que dice el sistema
);

CREATE INDEX IF NOT EXISTS ix_turno_abierto ON turno(cerrado_en);

-- ─────────────────────────────── Orden: MUTABLE, no es documento fiscal

CREATE TABLE IF NOT EXISTS orden (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mesa_id     INTEGER REFERENCES mesa(id),   -- NULL = express, para llevar
  numero_express INTEGER,
  turno_id    INTEGER REFERENCES turno(id),
  usuario_id  INTEGER REFERENCES usuario(id),
  comensales  INTEGER,
  estado      TEXT NOT NULL DEFAULT 'abierta'
              CHECK (estado IN ('abierta','pide_cuenta','cobrada','anulada')),
  abierta_en  INTEGER NOT NULL,
  cerrada_en  INTEGER,
  motivo_anulacion TEXT,
  anulada_por INTEGER REFERENCES usuario(id)
);

CREATE INDEX IF NOT EXISTS ix_orden_estado ON orden(estado);
CREATE INDEX IF NOT EXISTS ix_orden_mesa ON orden(mesa_id, estado);

CREATE TABLE IF NOT EXISTS orden_linea (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orden_id    INTEGER NOT NULL REFERENCES orden(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES producto(id),
  nombre      TEXT NOT NULL,            -- congelado al agregar
  precio      INTEGER NOT NULL,         -- congelado al agregar
  tarifa      INTEGER NOT NULL,
  cabys       TEXT NOT NULL,
  cantidad    INTEGER NOT NULL CHECK (cantidad > 0),
  notas       TEXT,                     -- "sin cebolla"
  enviada_cocina_en INTEGER,            -- NULL = todavía no fue a cocina
  lista_en    INTEGER                   -- la cocina avisó que ya está
);

CREATE INDEX IF NOT EXISTS ix_linea_cocina
  ON orden_linea(enviada_cocina_en) WHERE lista_en IS NULL;

CREATE INDEX IF NOT EXISTS ix_linea_orden ON orden_linea(orden_id);

-- ─────────────────────────────── Comprobante: INMUTABLE

CREATE TABLE IF NOT EXISTS comprobante (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo        TEXT NOT NULL CHECK (tipo IN ('TE','FE','NC','ND','REP')),
  consecutivo TEXT NOT NULL UNIQUE,
  clave       TEXT NOT NULL UNIQUE CHECK (length(clave) = 50),
  situacion   TEXT NOT NULL CHECK (situacion IN ('1','2','3')),
  orden_id    INTEGER REFERENCES orden(id),
  turno_id    INTEGER REFERENCES turno(id),
  receptor_id INTEGER REFERENCES receptor(id),
  referencia_id INTEGER REFERENCES comprobante(id),  -- NC/ND apuntan al original
  titulo      TEXT NOT NULL,
  fecha       INTEGER NOT NULL,
  medio_pago  TEXT NOT NULL,
  subtotal    INTEGER NOT NULL,
  impuesto    INTEGER NOT NULL,
  servicio    INTEGER NOT NULL DEFAULT 0,
  propina     INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL,
  receptor_snapshot TEXT,               -- congelado: la factura no cambia si el cliente sí
  xml_firmado TEXT,                     -- lo que se transmite, sin reformatear
  respuesta_hacienda TEXT,              -- el "Mensaje de Hacienda"
  estado_hacienda TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado_hacienda IN ('pendiente','enviando','aceptado','aceptado_parcial','rechazado','error')),
  intentos    INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  enviado_en  INTEGER,
  resuelto_en INTEGER,
  entregado_en INTEGER
);

CREATE INDEX IF NOT EXISTS ix_comp_estado ON comprobante(estado_hacienda);
CREATE INDEX IF NOT EXISTS ix_comp_fecha ON comprobante(fecha);
CREATE INDEX IF NOT EXISTS ix_comp_turno ON comprobante(turno_id);

-- Normalizada, no JSON: los reportes por producto y por tarifa la necesitan.
CREATE TABLE IF NOT EXISTS comprobante_linea (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  comprobante_id INTEGER NOT NULL REFERENCES comprobante(id),
  numero_linea  INTEGER NOT NULL,
  cabys         TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  cantidad      INTEGER NOT NULL,
  precio        INTEGER NOT NULL,
  subtotal      INTEGER NOT NULL,
  tarifa        INTEGER NOT NULL,
  impuesto      INTEGER NOT NULL,
  total_linea   INTEGER NOT NULL,
  UNIQUE (comprobante_id, numero_linea)
);

CREATE INDEX IF NOT EXISTS ix_cl_comp ON comprobante_linea(comprobante_id);

CREATE TABLE IF NOT EXISTS pago (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  comprobante_id INTEGER NOT NULL REFERENCES comprobante(id),
  fecha          INTEGER NOT NULL,
  monto          INTEGER NOT NULL,
  medio          TEXT NOT NULL,
  referencia     TEXT,
  rep_id         INTEGER REFERENCES comprobante(id)  -- el REP emitido por este pago
);

-- ─────────────────────────────── Regla 2 a nivel de motor
-- Que la base rechace lo que el código no debería intentar.

CREATE TRIGGER IF NOT EXISTS comprobante_no_se_borra
BEFORE DELETE ON comprobante
BEGIN
  SELECT RAISE(ABORT, 'Un comprobante no se borra: se anula con nota de credito');
END;

CREATE TRIGGER IF NOT EXISTS comprobante_inmutable
BEFORE UPDATE ON comprobante
WHEN OLD.clave <> NEW.clave
  OR OLD.consecutivo <> NEW.consecutivo
  OR OLD.total <> NEW.total
  OR OLD.subtotal <> NEW.subtotal
  OR OLD.impuesto <> NEW.impuesto
  OR OLD.fecha <> NEW.fecha
BEGIN
  SELECT RAISE(ABORT, 'Un comprobante emitido es inmutable');
END;

CREATE TRIGGER IF NOT EXISTS linea_comprobante_no_se_toca
BEFORE UPDATE ON comprobante_linea
BEGIN
  SELECT RAISE(ABORT, 'Las lineas de un comprobante emitido son inmutables');
END;

CREATE TRIGGER IF NOT EXISTS linea_comprobante_no_se_borra
BEFORE DELETE ON comprobante_linea
BEGIN
  SELECT RAISE(ABORT, 'Las lineas de un comprobante emitido no se borran');
END;

-- Una mesa no puede tener dos órdenes abiertas a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS ix_una_orden_por_mesa
  ON orden(mesa_id) WHERE estado IN ('abierta','pide_cuenta') AND mesa_id IS NOT NULL;
