"use strict";

// API del local. Corre en el servidor del restaurante, no en la nube.
// Es el único que escribe (ver docs/02-restaurante.md).

const http = require("http");
const { WebSocketServer } = require("ws");
const { abrir, semilla, uno, todos, correr, enTransaccion, redondear, aEntero, turnoAbierto } = require("./db");
const { cobrar, notaCredito, totales } = require("./cobrar");
const cabys = require("./cabys");
const cola = require("./cola");
const respaldo = require("./respaldo");

const PUERTO = 4000;
const AGENTE = process.env.AGENTE_IMPRESION || "http://127.0.0.1:9100";

let wss;

/** Empuja el estado a todos los dispositivos. Sin polling. */
function difundir(evento, datos) {
  if (!wss) return;
  const msg = JSON.stringify({ evento, datos, t: Date.now() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

function estado() {
  const ordenes = todos(
    `SELECT o.*, m.numero AS mesa_numero
       FROM orden o LEFT JOIN mesa m ON m.id = o.mesa_id
      WHERE o.estado IN ('abierta','pide_cuenta') ORDER BY o.id`);
  return {
    mesas: todos(
      `SELECT m.id, m.numero, m.capacidad, s.nombre AS salon,
              (SELECT o.id FROM orden o
                WHERE o.mesa_id = m.id AND o.estado IN ('abierta','pide_cuenta')) AS orden_id
         FROM mesa m JOIN salon s ON s.id = m.salon_id
        WHERE m.activa = 1 ORDER BY m.id`),
    ordenes: ordenes.map((o) => {
      const lineas = todos("SELECT * FROM orden_linea WHERE orden_id = ?", o.id);
      const enCocina = lineas.filter((l) => l.enviada_cocina_en !== null).length;
      // Mismo cálculo que el cobro. Tenerlo duplicado es cómo el total que ve
      // el salonero termina distinto del que se cobra.
      const t = totales(lineas, o.mesa_id !== null);
      return {
        id: o.id, mesaId: o.mesa_id, mesa: o.mesa_numero, estado: o.estado,
        abiertaEn: o.abierta_en, enCocina,
        lineas: lineas.map((l) => ({
          nombre: l.nombre, cantidad: l.cantidad, precio: redondear(l.precio),
          enCocina: l.enviada_cocina_en !== null, lista: l.lista_en !== null,
        })),
        total: redondear(t.total),
      };
    }),
    cola: uno("SELECT COUNT(*) c FROM comprobante WHERE estado_hacienda = 'pendiente'").c,
  };
}

/**
 * Cuentas del turno. Un solo lugar: tener este cálculo repetido en el arqueo
 * y en la consulta fue exactamente lo que hizo que divergieran.
 *
 * Una nota de crédito NO es una venta: es plata que salió de la caja. Resta.
 */
function cuentasTurno(t) {
  const filas = todos(
    `SELECT medio_pago, tipo, SUM(total) tot, COUNT(*) n FROM comprobante
      WHERE turno_id = ? AND estado_hacienda <> 'rechazado'
      GROUP BY medio_pago, tipo`, t.id);

  const porMedio = new Map();
  let vendido = 0, devuelto = 0, efectivoNeto = 0;

  for (const f of filas) {
    const signo = f.tipo === "NC" ? -1 : 1;
    const neto = signo * f.tot;
    if (signo < 0) devuelto += f.tot; else vendido += f.tot;
    if (f.medio_pago === "Efectivo") efectivoNeto += neto;
    const a = porMedio.get(f.medio_pago) ?? { medio: f.medio_pago, total: 0, n: 0 };
    a.total += neto; a.n += f.n;
    porMedio.set(f.medio_pago, a);
  }

  return {
    porMedio: [...porMedio.values()],
    vendido, devuelto,
    esperado: t.monto_apertura + efectivoNeto,
  };
}

async function imprimir(comp) {
  const emisor = uno("SELECT * FROM emisor WHERE id = 1");
  const cuerpo = {
    emisor: {
      nombre: emisor.nombre,
      identificacion: emisor.identificacion,
      direccion: "San José, Costa Rica",
    },
    comprobante: {
      tipo: comp.tipo, cons: comp.consecutivo, clave: comp.clave, sit: comp.situacion,
      anula: comp.anula ?? null, motivo: comp.motivoNota ?? null,
      titulo: comp.titulo, fecha: comp.fecha, medio: comp.medio_pago,
      receptor: comp.receptor_snapshot ? JSON.parse(comp.receptor_snapshot) : null,
      sub: comp.montos.subtotal, iva: comp.montos.impuesto,
      svc: comp.montos.servicio, total: comp.montos.total,
      lineas: todos(
        "SELECT * FROM comprobante_linea WHERE comprobante_id = ? ORDER BY numero_linea", comp.id
      ).map((l) => ({
        nombre: l.nombre, precio: redondear(l.precio), qty: l.cantidad, iva: l.tarifa,
      })),
    },
  };
  const r = await fetch(`${AGENTE}/imprimir`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(4000),
  });
  return r.json();
}

const auth = require("./auth");
const padron = require("./padron");
const ABIERTAS = ["GET /usuarios", "POST /login"];

const rutas = {
  // Nombres y roles nada más: sirve para pintar la pantalla de ingreso.
  "GET /usuarios": () => auth.listar(),

  "POST /login": (b) => auth.entrar(b.usuarioId, b.pin, b.dispositivo),

  "POST /logout": (b) => { auth.salir(b.token); return { ok: true }; },

  "GET /yo": (b) => b.__yo,

  "GET /menu": () => todos("SELECT * FROM producto WHERE activo = 1 ORDER BY categoria, nombre")
    .map((p) => ({ id: p.id, nombre: p.nombre, categoria: p.categoria, precio: redondear(p.precio), cabys: p.cabys, tarifa: p.tarifa })),

  "GET /estado": () => estado(),

  "POST /ordenes": (body) => {
    const turno = turnoAbierto();
    if (!turno) throw new Error("No hay turno de caja abierto");

    let mesaId = null;
    let express = null;
    if (body.mesa) {
      const m = uno("SELECT id FROM mesa WHERE numero = ?", String(body.mesa));
      if (!m) throw new Error(`La mesa ${body.mesa} no existe`);
      mesaId = m.id;
    } else {
      // Numeración de express propia, para que el salonero las distinga.
      express = (uno("SELECT COALESCE(MAX(numero_express),0) n FROM orden").n ?? 0) + 1;
    }

    const r = correr(
      `INSERT INTO orden (mesa_id, numero_express, turno_id, usuario_id, comensales, abierta_en)
       VALUES (?,?,?,?,?,?)`,
      mesaId, express, turno.id, body.__yo.id, body.comensales ?? null, Date.now()
    );
    difundir("orden.abierta", estado());
    return { id: Number(r.lastInsertRowid), mesaId, express };
  },

  "POST /lineas": (body) => {
    const p = uno("SELECT * FROM producto WHERE id = ?", body.productoId);
    if (!p) throw new Error("Producto inexistente");
    const n = body.cantidad ?? 1;

    // Si ya está en la comanda al mismo precio, se suma la cantidad. Doce
    // refrescos en doce renglones no los lee nadie.
    // Distinto precio = renglón aparte: el precio se congela al agregar y
    // cambiarlo en el menú no debe tocar lo ya pedido.
    const ya = uno(
      `SELECT * FROM orden_linea
        WHERE orden_id = ? AND producto_id = ? AND precio = ? AND notas IS NULL`,
      body.ordenId, p.id, p.precio);

    if (ya) correr("UPDATE orden_linea SET cantidad = cantidad + ? WHERE id = ?", n, ya.id);
    else correr(
      `INSERT INTO orden_linea (orden_id, producto_id, nombre, precio, tarifa, cabys, cantidad, notas)
       VALUES (?,?,?,?,?,?,?,?)`,
      body.ordenId, p.id, p.nombre, p.precio, p.tarifa, p.cabys, n, body.notas ?? null
    );
    difundir("orden.cambiada", estado());
    return { ok: true };
  },

  "POST /lineas/quitar": (body) => {
    const l = uno(
      `SELECT * FROM orden_linea WHERE orden_id = ? AND producto_id = ?
        ORDER BY id DESC LIMIT 1`, body.ordenId, body.productoId);
    if (!l) throw new Error("Esa línea no está en la comanda");
    if (l.cantidad > 1) correr("UPDATE orden_linea SET cantidad = cantidad - 1 WHERE id = ?", l.id);
    else correr("DELETE FROM orden_linea WHERE id = ?", l.id);
    difundir("orden.cambiada", estado());
    return { ok: true };
  },

  // El salonero no cobra: marca la mesa y la caja la ve en ámbar.
  "POST /ordenes/cuenta": (body) => {
    const o = uno("SELECT * FROM orden WHERE id = ?", body.ordenId);
    if (!o) throw new Error("La orden no existe");
    const nuevo = o.estado === "pide_cuenta" ? "abierta" : "pide_cuenta";
    correr("UPDATE orden SET estado = ? WHERE id = ?", nuevo, body.ordenId);
    difundir("orden.cambiada", estado());
    return { estado: nuevo };
  },

  // Mover a otra mesa, o juntar dos cuentas si la destino está ocupada.
  "POST /ordenes/mover": (body) => enTransaccion(() => {
    const o = uno("SELECT * FROM orden WHERE id = ?", body.ordenId);
    if (!o) throw new Error("La orden no existe");
    if (o.estado === "cobrada") throw new Error("Una orden cobrada no se mueve");

    let destinoId = null;
    if (body.mesa) {
      const m = uno("SELECT id FROM mesa WHERE numero = ?", String(body.mesa));
      if (!m) throw new Error(`La mesa ${body.mesa} no existe`);
      destinoId = m.id;
    }

    const ocupada = destinoId
      ? uno(`SELECT * FROM orden WHERE mesa_id = ? AND estado IN ('abierta','pide_cuenta') AND id <> ?`,
            destinoId, o.id)
      : null;

    if (ocupada) {
      // Juntar: las líneas se mudan y la orden vacía se cierra.
      correr("UPDATE orden_linea SET orden_id = ? WHERE orden_id = ?", ocupada.id, o.id);
      correr("UPDATE orden SET estado = 'anulada', cerrada_en = ?, motivo_anulacion = ? WHERE id = ?",
        Date.now(), `Juntada con la orden ${ocupada.id}`, o.id);
      difundir("orden.cambiada", estado());
      return { juntada: true, ordenId: ocupada.id };
    }

    const express = destinoId ? null
      : (o.numero_express ?? (uno("SELECT COALESCE(MAX(numero_express),0) n FROM orden").n + 1));
    correr("UPDATE orden SET mesa_id = ?, numero_express = ?, estado = 'abierta' WHERE id = ?",
      destinoId, express, o.id);
    difundir("orden.cambiada", estado());
    return { juntada: false, ordenId: o.id };
  }),

  // Anular una orden abierta no toca a Hacienda: todavía no hay comprobante.
  "POST /ordenes/anular": (body) => {
    const o = uno("SELECT * FROM orden WHERE id = ?", body.ordenId);
    if (!o) throw new Error("La orden no existe");
    if (o.estado === "cobrada") throw new Error("Ya cobrada: hay que emitir nota de crédito");
    const n = uno("SELECT COUNT(*) c FROM orden_linea WHERE orden_id = ?", body.ordenId).c;
    if (n > 0 && !body.motivo) throw new Error("Una orden con líneas necesita motivo de anulación");

    // Anular comida ya cargada es merma, y es un patrón clásico de robo
    // interno. El salonero puede cerrar una mesa vacía; con líneas, no.
    if (n > 0 && body.__yo.rol === "salonero") {
      throw new Error("Una orden con líneas solo la anula caja o administración");
    }

    correr(
      `UPDATE orden SET estado = 'anulada', cerrada_en = ?, motivo_anulacion = ?, anulada_por = ?
        WHERE id = ?`,
      Date.now(), body.motivo ?? "Orden vacía", body.__yo.id, body.ordenId
    );
    difundir("orden.cambiada", estado());
    return { ok: true, lineas: n };
  },

  "GET /padron": async (b) => padron.consultar(b.cedula),

  // Clientes frecuentes: la segunda factura al mismo cliente es de un toque.
  "GET /receptores": () =>
    todos(`SELECT tipo_identificacion tipo, identificacion, nombre, codigo_actividad actCod, correo
             FROM receptor ORDER BY visto_en DESC LIMIT 6`),

  "GET /comprobantes": () =>
    todos(`SELECT id, tipo, consecutivo, clave, situacion, titulo, fecha, medio_pago,
                  subtotal, impuesto, servicio, total, estado_hacienda, ultimo_error
             FROM comprobante ORDER BY id DESC LIMIT 50`)
      .map((c) => ({
        ...c,
        subtotal: redondear(c.subtotal), impuesto: redondear(c.impuesto),
        servicio: redondear(c.servicio), total: redondear(c.total),
      })),

  "GET /turno": () => {
    const t = turnoAbierto();
    if (!t) return { abierto: false };
    const c = cuentasTurno(t);
    return {
      abierto: true,
      usuario: uno("SELECT nombre FROM usuario WHERE id = ?", t.usuario_id)?.nombre,
      desde: t.abierto_en,
      apertura: redondear(t.monto_apertura),
      porMedio: c.porMedio.map((x) => ({ medio: x.medio, total: redondear(x.total), n: x.n })),
      vendido: redondear(c.vendido),
      devuelto: redondear(c.devuelto),
      esperado: redondear(c.esperado),
    };
  },

  "GET /reportes": () => {
    // Las notas de crédito restan en todos los reportes: no son ventas.
    const SIGNO = "CASE WHEN c.tipo = 'NC' THEN -1 ELSE 1 END";
    const porTarifa = todos(
      `SELECT cl.tarifa, SUM(${SIGNO} * cl.impuesto) imp, SUM(${SIGNO} * cl.subtotal) base
         FROM comprobante_linea cl JOIN comprobante c ON c.id = cl.comprobante_id
        WHERE c.estado_hacienda <> 'rechazado'
        GROUP BY cl.tarifa HAVING base <> 0 ORDER BY cl.tarifa DESC`);
    const top = todos(
      `SELECT cl.nombre, SUM(${SIGNO} * cl.cantidad) qty, SUM(${SIGNO} * cl.subtotal) tot
         FROM comprobante_linea cl JOIN comprobante c ON c.id = cl.comprobante_id
        WHERE c.estado_hacienda <> 'rechazado'
        GROUP BY cl.nombre HAVING tot > 0 ORDER BY tot DESC LIMIT 6`);
    const tot = uno(
      `SELECT COUNT(*) n,
              COALESCE(SUM(CASE WHEN c.tipo='NC' THEN -1 ELSE 1 END * total),0) t,
              COALESCE(SUM(CASE WHEN c.tipo='NC' THEN -1 ELSE 1 END * impuesto),0) iva,
              COALESCE(SUM(CASE WHEN c.tipo='NC' THEN -1 ELSE 1 END * servicio),0) svc
         FROM comprobante c WHERE estado_hacienda <> 'rechazado'`);
    return {
      comprobantes: tot.n,
      facturado: redondear(tot.t),
      iva: redondear(tot.iva),
      servicio: redondear(tot.svc),
      promedio: tot.n ? redondear(tot.t / tot.n) : 0,
      porTarifa: porTarifa.map((r) => ({ tarifa: r.tarifa, impuesto: redondear(r.imp), base: redondear(r.base) })),
      top: top.map((r) => ({ nombre: r.nombre, cantidad: r.qty, total: redondear(r.tot) })),
    };
  },

  // ── Cocina ──
  // El salonero decide cuándo mandar. Si cada plato saliera al agregarlo, la
  // cocina empezaría el primero mientras el mesero sigue tomando la orden.
  "POST /ordenes/cocina": (b) => {
    const n = uno(
      `SELECT COUNT(*) c FROM orden_linea WHERE orden_id = ? AND enviada_cocina_en IS NULL`,
      b.ordenId).c;
    if (!n) throw new Error("No hay nada nuevo que mandar a cocina");
    correr(
      `UPDATE orden_linea SET enviada_cocina_en = ?
        WHERE orden_id = ? AND enviada_cocina_en IS NULL`, Date.now(), b.ordenId);
    difundir("cocina.nueva", estado());
    return { enviadas: n };
  },

  "GET /cocina": () => {
    const filas = todos(
      `SELECT l.id, l.orden_id, l.nombre, l.cantidad, l.notas, l.enviada_cocina_en,
              o.mesa_id, o.numero_express, m.numero AS mesa
         FROM orden_linea l
         JOIN orden o ON o.id = l.orden_id
    LEFT JOIN mesa m ON m.id = o.mesa_id
        WHERE l.enviada_cocina_en IS NOT NULL AND l.lista_en IS NULL
          AND o.estado IN ('abierta','pide_cuenta')
        ORDER BY l.enviada_cocina_en, l.id`);

    const porOrden = new Map();
    for (const f of filas) {
      const k = f.orden_id;
      if (!porOrden.has(k)) {
        porOrden.set(k, {
          ordenId: k,
          titulo: f.mesa ? `Mesa ${f.mesa}` : `Express #${f.numero_express ?? k}`,
          esMesa: f.mesa_id !== null,
          desde: f.enviada_cocina_en,
          lineas: [],
        });
      }
      const o = porOrden.get(k);
      o.desde = Math.min(o.desde, f.enviada_cocina_en);
      o.lineas.push({ id: f.id, nombre: f.nombre, cantidad: f.cantidad, notas: f.notas });
    }
    // Lo que lleva más tiempo esperando va primero. Es todo el punto.
    return [...porOrden.values()].sort((a, b2) => a.desde - b2.desde);
  },

  "POST /cocina/lista": (b) => {
    if (b.lineaId) {
      correr("UPDATE orden_linea SET lista_en = ? WHERE id = ? AND lista_en IS NULL",
        Date.now(), b.lineaId);
    } else if (b.ordenId) {
      correr(
        `UPDATE orden_linea SET lista_en = ?
          WHERE orden_id = ? AND enviada_cocina_en IS NOT NULL AND lista_en IS NULL`,
        Date.now(), b.ordenId);
    } else throw new Error("Falta indicar qué está listo");
    difundir("cocina.lista", estado());
    return { ok: true };
  },

  "GET /cabys": (b) => cabys.buscar(b.q),

  // ── Menú: solo administración toca precios y clasificación ──
  "GET /productos": () =>
    todos("SELECT * FROM producto ORDER BY activo DESC, categoria, nombre").map((p) => ({
      ...p, precio: redondear(p.precio),
    })),

  "POST /productos": (b) => {
    if (!b.nombre?.trim()) throw new Error("Escribí el nombre del producto");
    if (!b.categoria?.trim()) throw new Error("Escribí una categoría");
    if (!(Number(b.precio) > 0)) throw new Error("El precio tiene que ser mayor que cero");
    if (!/^\d{13}$/.test(b.cabys ?? "")) throw new Error("El CABYS lleva 13 dígitos");

    const campos = [b.nombre.trim(), b.categoria.trim(), aEntero(b.precio), b.cabys,
                    Number(b.tarifa), b.codigoTarifa ?? "08", b.tarifaAjustada ? 1 : 0];
    if (b.id) {
      correr(
        `UPDATE producto SET nombre=?, categoria=?, precio=?, cabys=?, tarifa=?,
                codigo_tarifa=?, tarifa_ajustada=? WHERE id=?`, ...campos, b.id);
    } else {
      correr(
        `INSERT INTO producto (nombre, categoria, precio, cabys, tarifa, codigo_tarifa, tarifa_ajustada)
         VALUES (?,?,?,?,?,?,?)`, ...campos);
    }
    difundir("menu.cambiado", estado());
    return { ok: true };
  },

  // Desactivar, no borrar: el producto sigue vivo en los comprobantes viejos.
  "POST /productos/activo": (b) => {
    correr("UPDATE producto SET activo = ? WHERE id = ?", b.activo ? 1 : 0, b.id);
    difundir("menu.cambiado", estado());
    return { ok: true };
  },

  "POST /productos/borrar": (b) => {
    const usado = uno(
      `SELECT 1 x FROM orden_linea WHERE producto_id = ? LIMIT 1`, b.id);
    if (usado) throw new Error("Ya se vendió: desactivalo en vez de borrarlo");
    correr("DELETE FROM producto WHERE id = ?", b.id);
    difundir("menu.cambiado", estado());
    return { ok: true };
  },

  // ── Turno ──
  "POST /turno/abrir": (b) => {
    if (turnoAbierto()) throw new Error("Ya hay un turno abierto");
    correr(
      `INSERT INTO turno (terminal_id, usuario_id, abierto_en, monto_apertura) VALUES (1,?,?,?)`,
      b.__yo.id, Date.now(), aEntero(b.apertura ?? 50000));
    difundir("turno.abierto", estado());
    return { ok: true };
  },

  "POST /turno/cerrar": (b) => {
    const t = turnoAbierto();
    if (!t) throw new Error("No hay turno abierto");
    if (b.declarado === undefined || b.declarado === null || b.declarado === "")
      throw new Error("Contá el efectivo y anotá el monto antes de cerrar");

    const esperado = cuentasTurno(t).esperado;
    const declarado = aEntero(b.declarado);

    correr(
      "UPDATE turno SET cerrado_en = ?, monto_declarado = ?, monto_esperado = ? WHERE id = ?",
      Date.now(), declarado, esperado, t.id);
    difundir("turno.cerrado", estado());
    return {
      esperado: redondear(esperado), declarado: redondear(declarado),
      diferencia: redondear(declarado - esperado),
    };
  },

  // ── Nota de crédito: la única forma de anular una venta ya cobrada ──
  "POST /notas-credito": async (b) => {
    const nc = await notaCredito(b.comprobanteId, { motivo: b.motivo, usuarioId: b.__yo.id });

    // El cliente se lleva constancia de la devolución, igual que del cobro.
    let impresion = null;
    try { impresion = await imprimir(nc); }
    catch (e) { impresion = { ok: false, error: e.message }; }

    difundir("comprobante.anulado", estado());
    return {
      consecutivo: nc.consecutivo, clave: nc.clave, anula: nc.anula,
      montos: nc.montos, impresion,
    };
  },

  // ── Cola de Hacienda ──
  // Mismo camino que el reintento automático: forzar solo salta la espera.
  "POST /transmitir": async () => {
    const r = await cola.ciclo({ forzar: true });
    difundir("cola.intento", estado());
    return {
      enviados: r.enviados, encolados: r.revisados,
      detalle: r.revisados === 0 ? "No hay nada en cola"
        : r.enviados > 0 ? `${r.enviados} transmitidos`
        : `${r.revisados} en cola · ${r.motivo}`,
    };
  },

  // ── Usuarios ──
  "GET /usuarios/todos": () =>
    todos("SELECT id, nombre, rol, activo FROM usuario ORDER BY activo DESC, nombre"),

  "POST /usuarios": (b) => {
    if (!b.nombre?.trim()) throw new Error("Escribí el nombre de la persona");
    if (!["salonero", "caja", "admin"].includes(b.rol)) throw new Error("Rol inválido");
    if (b.pin && !/^\d{4}$/.test(b.pin)) throw new Error("El PIN lleva 4 dígitos");

    if (b.id) {
      correr("UPDATE usuario SET nombre = ?, rol = ? WHERE id = ?", b.nombre.trim(), b.rol, b.id);
      if (b.pin) correr("UPDATE usuario SET pin_hash = ?, fallidos = 0, bloqueado_hasta = NULL WHERE id = ?",
        auth.hashear(b.pin), b.id);
    } else {
      if (!b.pin) throw new Error("Un usuario nuevo necesita PIN");
      correr("INSERT INTO usuario (nombre, rol, pin_hash) VALUES (?,?,?)",
        b.nombre.trim(), b.rol, auth.hashear(b.pin));
    }
    return { ok: true };
  },

  "POST /usuarios/activo": (b) => {
    if (b.id === b.__yo.id) throw new Error("No podés desactivarte a vos mismo");
    correr("UPDATE usuario SET activo = ? WHERE id = ?", b.activo ? 1 : 0, b.id);
    if (!b.activo) correr("DELETE FROM sesion WHERE usuario_id = ?", b.id);
    return { ok: true };
  },

  "GET /respaldos": () => ({
    carpeta: respaldo.DIR,
    lista: respaldo.listar().slice(0, 10).map((r) => ({
      archivo: r.archivo, kb: Math.round(r.bytes / 1024), fecha: r.fecha,
    })),
  }),

  "POST /respaldos": () => respaldo.hacer({ motivo: "manual" }),

  // Verificar es abrir el archivo y contar. Un respaldo que nunca se abrió
  // no es un respaldo, es un archivo.
  "POST /respaldos/verificar": (b) => {
    const r = respaldo.verificar(b.archivo);
    if (!r.ok) throw new Error(`Ese respaldo no sirve: ${r.motivo}`);
    return { ok: true, contenido: r.contenido };
  },

  "GET /certificado": () => {
    const c = uno("SELECT * FROM certificado WHERE id = 1");
    return {
      ambiente: c.ambiente,
      venceEn: c.vence_en,
      dias: Math.round((c.vence_en - Date.now()) / 86400000),
      cargado: !!c.p12_cifrado,
    };
  },

  "POST /cobrar": async (body) => {
    const comp = await cobrar(body.ordenId, {
      medioPago: body.medioPago,
      receptor: body.receptor ?? null,
      situacion: body.situacion ?? "normal",
    });

    let impresion = null;
    try {
      impresion = await imprimir(comp);
    } catch (e) {
      // La venta no se cae porque la impresora falle. Queda reimprimible.
      impresion = { ok: false, error: e.message };
    }

    difundir("orden.cobrada", estado());
    return {
      consecutivo: comp.consecutivo,
      clave: comp.clave,
      situacion: comp.situacion,
      montos: comp.montos,
      firmado: comp.xml_firmado.length,
      impresion,
    };
  },
};

const CLIENTE = require("path").join(__dirname, "..", "..", "pos");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function servirEstatico(ruta, res) {
  const fs = require("fs");
  const path = require("path");

  // La autoridad certificadora, para instalarla en cada tablet. Es pública por
  // definición: es el certificado, no la llave.
  if (ruta === "/ca.crt") {
    try {
      const ca = fs.readFileSync(path.join(CERTS, "ca.crt"));
      res.writeHead(200, {
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": 'attachment; filename="pos-local-ca.crt"',
      });
      return res.end(ca);
    } catch {
      return res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        .end("No hay certificados. Corré: node certificados.js");
    }
  }

  const rel = ruta === "/" ? "index.html" : ruta.replace(/^\/+/, "");
  const archivo = path.join(CLIENTE, rel);
  // Nunca salir de la carpeta del cliente.
  if (!archivo.startsWith(CLIENTE)) return res.writeHead(403).end("no");
  fs.readFile(archivo, (e, datos) => {
    if (e) return res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      .end("No existe. ¿Corriste esto desde apps/api?");
    res.writeHead(200, { "content-type": TIPOS[path.extname(archivo)] ?? "application/octet-stream" });
    res.end(datos);
  });
}

function servidor() {
  const s = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    let cuerpo = "";
    for await (const c of req) cuerpo += c;

    const ruta = req.url.split("?")[0];
    const clave = `${req.method} ${ruta}`;
    const fn = rutas[clave];

    // Sin ruta de API: se sirve el cliente. El POS y la API viven en el mismo
    // proceso, en la máquina del local.
    if (!fn && req.method === "GET") return servirEstatico(ruta, res);

    if (!fn) return res.writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "ruta no encontrada" }));

    const json = (codigo, datos) =>
      res.writeHead(codigo, { "content-type": "application/json" }).end(JSON.stringify(datos));

    try {
      const body = cuerpo ? JSON.parse(cuerpo) : {};
      // Los GET traen sus parámetros en la URL.
      for (const [k, v] of new URL(req.url, "http://x").searchParams) body[k] = v;

      // Todo pasa por sesión menos entrar y ver quién puede entrar.
      if (!ABIERTAS.includes(clave)) {
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        const yo = auth.sesion(token);
        if (!yo) return json(401, { error: "Sesión vencida o inexistente" });
        if (!auth.puede(yo.rol, clave)) {
          return json(403, { error: `Un ${yo.rol} no puede hacer esto` });
        }
        body.__yo = yo;
      }

      json(200, await fn(body));
    } catch (e) {
      json(400, { error: e.message });
    }
  });

  // El WebSocket también exige sesión: si no, cualquiera en el WiFi del local
  // vería pasar las comandas y los montos.
  wss = new WebSocketServer({ noServer: true });
  s.on("upgrade", (req, socket, head) => {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    if (!auth.sesion(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (c) => wss.emit("connection", c, req));
  });
  wss.on("connection", (c) => c.send(JSON.stringify({ evento: "estado", datos: estado() })));
  return s;
}

const CERTS = require("path").join(__dirname, "..", "certs");
const PUERTO_TLS = 4443;

/** Certificados de la red local, si `node certificados.js` ya corrió. */
function tls() {
  const fs = require("fs");
  const path = require("path");
  try {
    return {
      key: fs.readFileSync(path.join(CERTS, "servidor.key")),
      cert: fs.readFileSync(path.join(CERTS, "servidor.crt")),
      ca: fs.readFileSync(path.join(CERTS, "ca.crt")),
    };
  } catch { return null; }
}

function iniciar(archivo) {
  abrir(archivo);
  semilla();
  const s = servidor();

  // HTTPS si hay certificados. El HTTP sigue vivo para poder descargar la CA
  // desde una tablet que todavía no confía en nada.
  const creds = tls();
  if (creds) {
    const https = require("https");
    const seguro = https.createServer({ key: creds.key, cert: creds.cert }, s.listeners("request")[0]);
    seguro.on("upgrade", s.listeners("upgrade")[0]);
    seguro.listen(PUERTO_TLS, "0.0.0.0");
    s.__tls = seguro;
  }

  // La cola se vacía sola. Si dependiera de que alguien entre al back-office,
  // los comprobantes en contingencia se quedarían ahí para siempre.
  cola.arrancar(() => difundir("cola.intento", estado()));
  respaldo.arrancar();

  const cerrar = s.close.bind(s);
  s.close = (cb) => { cola.detener(); respaldo.detener(); s.__tls?.close(); cerrar(cb); };

  return new Promise((res) => s.listen(PUERTO, "0.0.0.0", () => res(s)));
}

module.exports = { iniciar, estado, difundir };

if (require.main === module) {
  iniciar().then((s) => {
    const os = require("os");
    const red = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
      .map((i) => i.address);

    console.log(`\nServidor del local\n`);
    for (const ip of red) console.log(`  http://${ip}:${PUERTO}`);
    if (s.__tls) {
      for (const ip of red) console.log(`  https://${ip}:${PUERTO_TLS}   (instalá /ca.crt en la tablet)`);
    } else {
      console.log(`\n  Sin HTTPS. Para activarlo: node certificados.js`);
    }
    console.log(`\n  Impresión: ${AGENTE}\n`);
  });
}
