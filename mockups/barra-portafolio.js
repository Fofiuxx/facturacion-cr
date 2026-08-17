/**
 * Barra de vuelta al portafolio.
 *
 * Una demo enlazada desde un portafolio es un callejón sin salida si no
 * ofrece cómo volver: quien llega cierra la pestaña y ahí se acabó la
 * visita. Esta barra da la salida y, de paso, deja claro qué se está
 * viendo.
 *
 * Se configura con atributos en la propia etiqueta script:
 *   <script src="barra-portafolio.js"
 *           data-titulo="POS restaurante"
 *           data-nota="Prototipo navegable, datos de ejemplo"></script>
 */

(function () {
  "use strict";

  var PORTAFOLIO = "https://fofiuxx.github.io/portfolio/";
  var guion = document.currentScript;
  var titulo = (guion && guion.dataset.titulo) || document.title;
  var nota = (guion && guion.dataset.nota) || "";

  var estilos = document.createElement("style");
  estilos.textContent = [
    ".barra-portafolio{position:fixed;top:0;left:0;right:0;z-index:9999;",
    "display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;",
    "padding:9px 18px;background:#0d1117;color:#e8edf5;",
    "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;",
    "font-size:13px;line-height:1.4;box-shadow:0 1px 10px rgba(0,0,0,.25)}",
    ".barra-portafolio .bp-volver{display:inline-flex;align-items:center;gap:6px;",
    "color:#e8edf5;text-decoration:none;border:1px solid #2b3648;border-radius:6px;",
    "padding:5px 12px;white-space:nowrap;transition:background .15s,border-color .15s}",
    ".barra-portafolio .bp-volver:hover{background:#1a2231;border-color:#4a5a72}",
    ".barra-portafolio .bp-titulo{font-weight:700}",
    ".barra-portafolio .bp-nota{color:#93a1b5;flex:1;min-width:140px}",
    "html{scroll-padding-top:56px}",
    "@media(max-width:600px){.barra-portafolio .bp-nota{display:none}}",
  ].join("");
  document.head.appendChild(estilos);

  function montar() {
    var barra = document.createElement("div");
    barra.className = "barra-portafolio";

    var volver = document.createElement("a");
    volver.className = "bp-volver";
    volver.href = PORTAFOLIO;
    volver.textContent = "◀  Portafolio";

    var t = document.createElement("span");
    t.className = "bp-titulo";
    t.textContent = titulo;

    barra.appendChild(volver);
    barra.appendChild(t);

    if (nota) {
      var n = document.createElement("span");
      n.className = "bp-nota";
      n.textContent = nota;
      barra.appendChild(n);
    }

    document.body.insertBefore(barra, document.body.firstChild);

    // El alto se mide en vez de fijarlo: si la barra envuelve en dos
    // líneas en una pantalla estrecha, el hueco se ajusta solo.
    var alto = barra.getBoundingClientRect().height;
    var previo = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    document.body.style.paddingTop = previo + alto + "px";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", montar);
  } else {
    montar();
  }
})();
