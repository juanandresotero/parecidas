"use strict";
// Buscador de parecidas — toda la lógica corre en el celu. Lee listings.json
// (que arma el robot 1 vez por día) y filtra. Sin servidor.

// Associate editable (cada usuario pone el suyo en Ajustes). Guardado en el celu.
// OJO: si el usuario lo BORRÓ a propósito (guardó ""), hay que respetar el vacío y NO
// volver al de Juan. Por eso distingo "no configurado" (null) de "vacío a propósito" ("").
var ASSOCIATE = "940041154";
try {
  var _assocGuardado = localStorage.getItem("parecidas_associate");
  if (_assocGuardado !== null) ASSOCIATE = _assocGuardado;   // "" incluido = sin contacto
} catch (e) {}
// Motorcito (Cloudflare Worker) que lee InfoCasas / MercadoLibre. Ya publicado y
// prendido por defecto; cada usuario puede poner el suyo en Ajustes (lo pisa).
var MOTOR_URL = "https://parecidas-motor.cualcaxsiempre.workers.dev";
try { MOTOR_URL = localStorage.getItem("parecidas_motor") || MOTOR_URL; } catch (e) {}
var DET_EP = "https://api-ar.redremax.com/remaxweb-uy/api/listings/findBySlug/";
var CDN = "https://d1acdg20u0pmxj.cloudfront.net/";

var DATA = [];        // propiedades
var USD_RATE = null;  // UYU por USD (del archivo)
var $ = function (id) { return document.getElementById(id); };

function norm(s) {
  return (s || "").normalize("NFC").toLowerCase()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n").trim();
}
function soloNum(s) {
  var d = (s == null ? "" : String(s)).replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : null;
}
function tipoCat(t) {
  t = norm(t);
  if (t.indexOf("departamento") >= 0 || t.indexOf("penthouse") >= 0 || t.indexOf("apart") >= 0 || t === "ph") return "apto";   // PH = apartamento
  if (t.indexOf("casa") >= 0) return "casa";
  if (t.indexOf("terreno") >= 0 || t.indexOf("lote") >= 0) return "terreno";
  return "otro";
}
function esc(s) {   // blinda innerHTML contra caracteres raros en los datos de RE/MAX
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Grupo (lista de barrios normalizados) al que pertenece un barrio. Si no está en
// ningún grupo, el grupo es solo ese barrio.
var GRUPO_IDX = {};
(function () {
  (window.GRUPOS || []).forEach(function (g) {
    var ng = g.map(norm);
    ng.forEach(function (b) { GRUPO_IDX[b] = ng; });
  });
})();
function grupoDe(barrio) {
  var n = norm(barrio);
  if (!n) return null;
  return GRUPO_IDX[n] || [n];
}

// ---- Homogeneización (idéntica al robot / Auto-Meta), para links en vivo ----
function coefDescub(descub, construido) {
  if (construido <= 0 || descub <= 0) return 0.22;
  var r = descub / construido;
  if (r <= 1) return 0.25;
  if (r <= 3) return 0.22;
  if (r <= 8) return 0.20;
  return 0.18;
}
function homog(cub, tot, terr, esApto, semi, descub) {
  var construido = cub || 0, s = semi || 0, total = tot || 0, terreno = terr || 0, d;
  if (esApto) d = (descub != null) ? Math.max(0, descub) : Math.max(0, total - construido - s);
  else if (descub != null) d = Math.max(0, descub);
  else if (terreno >= construido + s && terreno > 0) d = terreno - construido - s;
  else d = 0;
  var x = construido + s * 0.4 + d * coefDescub(d, construido);
  return x > 0 ? Math.round(x) : 0;
}

// -------------------- Leer los controles del formulario --------------------
function segVal(id) {
  var b = $(id).querySelector('[aria-pressed="true"]');
  return b ? b.getAttribute("data-v") : "";
}
function setSeg(id, val) {
  $(id).querySelectorAll("button").forEach(function (b) {
    b.setAttribute("aria-pressed", b.getAttribute("data-v") === (val || "") ? "true" : "false");
  });
}
function segMulti(id) {   // varios botones prendidos → array de valores
  var out = [];
  $(id).querySelectorAll('button[aria-pressed="true"]').forEach(function (b) {
    var v = b.getAttribute("data-v"); if (v) out.push(v);
  });
  return out;
}
function setSegMulti(id, arr) {
  $(id).querySelectorAll("button").forEach(function (b) {
    b.setAttribute("aria-pressed", arr.indexOf(b.getAttribute("data-v")) >= 0 ? "true" : "false");
  });
}
function stepVal(id) {
  var t = $(id).querySelector("span").textContent;
  return t === "—" ? null : parseInt(t, 10);
}
function setStep(id, v) {
  $(id).querySelector("span").textContent = (v == null) ? "—" : v;
}

function leerFiltros() {
  // 1 barrio → su grupo (similares). 2+ → solo esos exactos. 0 → da igual.
  var grupo = SELBARRIOS.length === 1 ? grupoDe(SELBARRIOS[0])
            : (SELBARRIOS.length > 1 ? barriosSel() : null);
  return {
    operacion: segVal("f-oper"),                 // siempre 'sale' o 'rent'
    tipos: segMulti("f-tipo"),                    // casa/apto/terreno (vacío = cualquiera)
    grupo: grupo,
    dmin: stepVal("f-dmin"),
    dmax: stepVal("f-dmax"),
    precioMinUsd: precioAUsd(soloNum($("f-precio-min").value)),
    precioMaxUsd: precioAUsd(soloNum($("f-precio-max").value)),
    cubMin: soloNum($("f-cub-min").value),
    cubMax: soloNum($("f-cub-max").value),
    padronMin: soloNum($("f-padron-min").value),
    padronMax: soloNum($("f-padron-max").value),
    cochera: segVal("f-coch"),
    estado: segVal("f-estado"),
    renta: segVal("f-renta"),
    // Gastos comunes (solo alquiler): se ingresan en pesos.
    gastosMinUsd: aUsd(soloNum($("f-gastos-min").value), "UYU"),
    gastosMaxUsd: aUsd(soloNum($("f-gastos-max").value), "UYU")
  };
}
// Mostrar el campo de gastos comunes solo cuando es Alquiler.
function toggleGastos() {
  $("f-gastos-wrap").style.display = segVal("f-oper") === "rent" ? "" : "none";
}
function aUsd(monto, moneda) {
  if (!monto) return null;
  if ((moneda || "USD") === "USD") return Math.round(monto);
  return USD_RATE ? Math.round(monto / USD_RATE) : null;
}
// Precio a USD según la MONEDA elegida (selector f-moneda). Todo se compara en USD.
function precioAUsd(monto) {
  if (!monto) return null;
  return aUsd(monto, segVal("f-moneda") || "USD");
}

// -------------------------- El filtro en sí --------------------------
function pasa(c, f, slugActual) {
  if (slugActual && c.slug === slugActual) return false;            // no me devuelvo a mí mismo
  if (c.estado_pub && c.estado_pub !== "active") return false;      // reservada/negociación: no se ofrece
  if (f.operacion && c.operacion !== f.operacion) return false;
  if (f.tipos.length && f.tipos.indexOf(tipoCat(c.tipo)) < 0) return false;
  if (f.grupo && f.grupo.indexOf(norm(c.barrio)) < 0) return false;
  if (f.dmin != null && (c.dorm == null || c.dorm < f.dmin)) return false;
  if (f.dmax != null && (c.dorm == null || c.dorm > f.dmax)) return false;
  if (f.precioMinUsd != null && (c.precio_usd == null || c.precio_usd < f.precioMinUsd)) return false;
  if (f.precioMaxUsd != null && (c.precio_usd == null || c.precio_usd > f.precioMaxUsd)) return false;
  if (f.cubMin != null && (c.m2_homog == null || c.m2_homog < f.cubMin)) return false;
  if (f.cubMax != null && (c.m2_homog == null || c.m2_homog > f.cubMax)) return false;
  if (f.padronMin != null && (c.m2_padron == null || c.m2_padron < f.padronMin)) return false;
  if (f.padronMax != null && (c.m2_padron == null || c.m2_padron > f.padronMax)) return false;
  if (f.cochera === "si" && c.cochera !== true) return false;
  if (f.cochera === "no" && c.cochera !== false) return false;
  if (f.estado && c.estado !== f.estado) return false;
  if (f.renta === "con" && c.renta !== true) return false;
  if (f.renta === "sin" && c.renta !== false) return false;
  // Gastos comunes: si la propiedad no tiene el dato, NO la excluyo (indulgente).
  if (f.gastosMinUsd != null && c.gastos_usd != null && c.gastos_usd < f.gastosMinUsd) return false;
  if (f.gastosMaxUsd != null && c.gastos_usd != null && c.gastos_usd > f.gastosMaxUsd) return false;
  return true;
}
// Referencia para ordenar "más parecida": la propiedad del link (window.__base),
// o si no hay link, lo que esté cargado en los filtros.
function refDeBusqueda() {
  var f = leerFiltros();
  var b = window.__base;
  var dorm = b ? b.dorm : ((f.dmin != null && f.dmax != null) ? Math.round((f.dmin + f.dmax) / 2)
           : (f.dmin != null ? f.dmin : f.dmax));
  var precioUsd = b ? b.precio_usd
    : (f.precioMinUsd != null && f.precioMaxUsd != null ? Math.round((f.precioMinUsd + f.precioMaxUsd) / 2)
       : (f.precioMaxUsd != null ? f.precioMaxUsd : f.precioMinUsd));
  return {
    operacion: b ? b.operacion : f.operacion,
    tipos: b ? [tipoCat(b.tipo)] : f.tipos,
    barrios: barriosSel(),                     // barrios elegidos (normalizados)
    precio_usd: precioUsd,
    dorm: dorm,
    cochera: b ? b.cochera : (f.cochera === "si" ? true : (f.cochera === "no" ? false : null)),
    estado: b ? b.estado : f.estado
  };
}
// Puntaje por PRIORIDAD (más chico = más parecida). Pesos decrecientes según el
// orden que pidió Juan: 1)venta/alquiler 2)ubicación 3)tipo 4)precio 5)dorm
// 6)cochera 7)usado/a estrenar.
function puntaje(c, ref) {
  var w = [64, 32, 16, 8, 4, 2, 1], p = 0;
  if (ref.operacion && c.operacion !== ref.operacion) p += w[0];
  if (ref.barrios.length) p += w[1] * (ref.barrios.indexOf(norm(c.barrio)) >= 0 ? 0 : 0.5);
  if (ref.tipos && ref.tipos.length && ref.tipos.indexOf(tipoCat(c.tipo)) < 0) p += w[2];
  if (ref.precio_usd && c.precio_usd)
    p += w[3] * Math.min(1, Math.abs(c.precio_usd - ref.precio_usd) / ref.precio_usd);
  if (ref.dorm != null && c.dorm != null)
    p += w[4] * Math.min(1, Math.abs(c.dorm - ref.dorm) / 3);
  if (ref.cochera != null && c.cochera != null && c.cochera !== ref.cochera) p += w[5];
  if (ref.estado && c.estado && c.estado !== ref.estado) p += w[6];
  return p;
}

function propPorSlug(slug) {
  for (var i = 0; i < DATA.length; i++) if (DATA[i].slug === slug) return DATA[i];
  return null;
}
function filtrar(f, ref, slugActual) {
  var res = DATA.filter(function (c) { return pasa(c, f, slugActual); });
  res.sort(function (a, b) {
    var d = puntaje(a, ref) - puntaje(b, ref);
    if (Math.abs(d) > 1e-9) return d;
    return (a.precio_usd || 1e12) - (b.precio_usd || 1e12);   // desempate: más barata
  });
  return res;
}
// Las MEJORES 10 (tope). Los filtros NO son flexibles: se aflojan SOLO si hay
// menos de 2 exactas, para no dejarte casi sin nada (de menor a mayor prioridad,
// avisando cuál). Si hay 3 exactas → muestra 3; si hay 40 → las 10 más parecidas.
var TOPE_RESULTADOS = 10;
function buscar() {
  var f = leerFiltros();
  var ref = refDeBusqueda();
  var slugActual = window.__slugActual || null;
  // Respeta TODOS los filtros al 100%: NO afloja nada. Las mejores 10.
  var res = filtrar(f, ref, slugActual);
  var lista = res.slice(0, TOPE_RESULTADOS);
  var fuera = {}, yaNoEntra = {};
  var b = busquedaActiva();
  if (b) {
    // Re-buscar: lo que estaba antes y ya no coincide → 🚫 "ya no entra en el filtro".
    reconciliarDescartes(res, b).forEach(function (slug) {
      var prop = propPorSlug(slug);
      if (prop) { yaNoEntra[slug] = 1; lista.push(prop); }
    });
    // Fase C — PRESERVAR: lo marcado a favor (⭐/💚/📤) no se pierde aunque no cumpla.
    if (b.estados) {
      var ya = {}; lista.forEach(function (c) { ya[c.slug] = 1; });
      var aFavor = { a_enviar: 1, favorita: 1, enviada: 1 };
      Object.keys(b.estados).forEach(function (slug) {
        if (!aFavor[b.estados[slug]] || ya[slug]) return;
        var prop = propPorSlug(slug);
        if (!prop) return;
        if (!pasa(prop, f, slugActual)) fuera[slug] = 1;   // ya no cumple → fuera de criterios
        lista.push(prop);
      });
    }
  }
  render(lista, res.length, [], fuera, yaNoEntra);
  guardarEstadoActual();   // recordar lo que se está viendo (sobrevive a recargar)
}
// Al re-buscar: las que estaban en la vista anterior y ya no coinciden pasan a
// "descartada por filtro" (🚫). Las favoritas NO se tocan (se preservan).
function reconciliarDescartes(res, b) {
  var nuevos = res.map(function (c) { return c.slug; });
  if (!window.__ultimaVista) { window.__ultimaVista = nuevos; return []; }
  var enNuevo = {}; nuevos.forEach(function (s) { enNuevo[s] = 1; });
  var arr = cargarBusquedas();
  var bb = arr.filter(function (x) { return x.id === b.id; })[0];
  var dropped = [];
  if (bb) {
    bb.estados = bb.estados || {};
    var aFavor = { a_enviar: 1, favorita: 1, enviada: 1 };
    var cambio = false;
    window.__ultimaVista.forEach(function (slug) {
      if (enNuevo[slug] || aFavor[bb.estados[slug]]) return;
      bb.estados[slug] = "descartada_filtro";
      dropped.push(slug); cambio = true;
    });
    if (cambio) guardarBusquedas(arr);
  }
  window.__ultimaVista = nuevos;
  return dropped;
}

// -------------------------- Dibujar resultados --------------------------
function fmtPrecio(c) {
  if (!c.precio) return "Consultar";
  var s = new Intl.NumberFormat("es-UY").format(Math.round(c.precio));
  return esc(c.moneda || "USD") + " " + s;
}
function porque(c, f) {
  var b = [];
  if (f.grupo) b.push(barriosSel().indexOf(norm(c.barrio)) >= 0 ? "mismo barrio" : "mismo grupo");
  var base = window.__base;
  if (base && base.m2_homog && c.m2_homog) {
    var dif = Math.round((c.m2_homog - base.m2_homog) / base.m2_homog * 100);
    b.push((dif >= 0 ? "+" : "") + dif + "% m²");
  }
  return b.join(" · ");
}
function linkAssoc(link) {
  // Sin código de associate → link limpio (no sale el contacto de nadie).
  if (!ASSOCIATE) return link;
  return link + (link.indexOf("?") >= 0 ? "&" : "?") + "associate=" + ASSOCIATE;
}

// Precio en "k": desde 10k va entero (corta para abajo); abajo de 10k, 1 decimal.
// U$S para dólares, $ para pesos. Ej: 180.000→"U$S 180 k", 35.500→"$ 35 k", 1.100→"U$S 1.1 k".
function fmtK(precio, moneda) {
  if (!precio) return "";
  var sym = (String(moneda).toUpperCase() === "UYU" || moneda === "$") ? "$" : "U$S";
  var k = precio / 1000;
  var num = k >= 10 ? String(Math.floor(k)) : String(Math.round(k * 10) / 10);
  return sym + " " + num + " k";
}
// Resumen corto del título: Operación · tipo · (dorm o m²) · precio.
// Terreno usa m² totales (padrón); casa/apto usan dormitorios.
function resumen(c) {
  var oper = c.operacion === "rent" ? "Alquiler" : "Venta";
  var t = tipoCat(c.tipo);
  var tipoTxt = t === "apto" ? "apto" : (t === "casa" ? "casa" : (t === "terreno" ? "terreno" : "propiedad"));
  var med;
  if (t === "terreno") med = c.m2_padron ? c.m2_padron + " m²" : (c.m2_homog ? c.m2_homog + " m²" : "");
  else med = (c.dorm != null) ? c.dorm + " dorm" : (c.m2_homog ? c.m2_homog + " m²" : "");
  return [oper, tipoTxt, med, fmtK(c.precio, c.moneda)].filter(Boolean).join(" · ");
}
// Título de la tarjeta: operación · tipo · dorm (o m² si terreno) · barrio · precio.
function resumenCard(c) {
  var oper = c.operacion === "rent" ? "Alquiler" : "Venta";
  var t = tipoCat(c.tipo);
  var tipoTxt = t === "apto" ? "apto" : (t === "casa" ? "casa" : (t === "terreno" ? "terreno" : "propiedad"));
  var med = t === "terreno" ? (c.m2_padron ? c.m2_padron + " m²" : "")
                            : (c.dorm != null ? c.dorm + " dorm" : "");
  return [oper, tipoTxt, med, c.barrio || "", fmtK(c.precio, c.moneda)].filter(Boolean).join(" · ");
}

var SEL = [];      // propiedades tildadas, EN ORDEN de tildado (para numerar 1,2,3)
var CARDS = [];    // {slug, numEl, card} de lo dibujado, para renumerar en pantalla
function idxSel(slug) { for (var i = 0; i < SEL.length; i++) if (SEL[i].slug === slug) return i; return -1; }
function renumerar() {
  CARDS.forEach(function (o) {
    var i = idxSel(o.slug);
    if (i >= 0) { o.numEl.textContent = i + 1; o.numEl.style.display = ""; o.card.classList.add("sel"); }
    else { o.numEl.style.display = "none"; o.card.classList.remove("sel"); }
  });
  actualizarMulticopy();
}
function actualizarMulticopy() {
  var n = SEL.length;
  $("multibar").style.display = n ? "flex" : "none";
  $("btn-multienviar").textContent = "📲 Enviar (" + n + ")";
  $("btn-multicopy").textContent = "📋 Copiar (" + n + ")";
}
// Cliente activo = la búsqueda guardada que está abierta (si hay). Da su teléfono
// y permite marcar enviadas.
function busquedaActiva() {
  if (!window.__busquedaActiva) return null;
  var arr = cargarBusquedas();
  return arr.filter(function (x) { return x.id === window.__busquedaActiva; })[0] || null;
}
function textoSeleccionadas() {
  return SEL.map(function (c, i) {
    return (i + 1) + ". " + resumen(c) + "\n" + linkAssoc(c.link);
  }).join("\n\n");
}
// Enviar por WhatsApp: si hay cliente con número → abre su chat; si no → WhatsApp
// para elegir contacto. Y suma 1 en enviadas (marca las propiedades como enviadas).
function enviarSeleccionadas() {
  if (!SEL.length) return;
  var texto = textoSeleccionadas();
  var b = busquedaActiva();
  var wa = b ? waLink(b.tel) : null;
  var url = (wa ? wa + "?text=" : "https://wa.me/?text=") + encodeURIComponent(texto);
  window.open(url, "_blank");                 // abrir WhatsApp PRIMERO (gesto del usuario)
  if (b) {                                    // marca enviadas + cuenta la tanda
    var arr = cargarBusquedas();
    var bb = arr.filter(function (x) { return x.id === b.id; })[0];
    if (bb) {
      bb.enviadas = bb.enviadas || [];
      bb.estados = bb.estados || {};
      SEL.forEach(function (c) {
        if (bb.enviadas.indexOf(c.slug) < 0) bb.enviadas.push(c.slug);
        bb.estados[c.slug] = "enviada";           // queda marcada como enviada
      });
      bb.tandas = (bb.tandas || 0) + 1;
      bb.ultimoContacto = new Date().toISOString();      // enviar = contacto de hoy
      guardarBusquedas(arr); renderBadge(); buscar();   // refresca la lista (marca 📤)
    }
  }
}

function render(res, total, aflojados, fuera, yaNoEntra) {
  fuera = fuera || {}; yaNoEntra = yaNoEntra || {};
  var f = leerFiltros();
  var monBusq = (segVal("f-moneda") || "USD").toLowerCase();   // para avisar conversión de dólar
  SEL = []; CARDS = []; actualizarMulticopy();
  $("resultados").style.display = "";
  // Si la búsqueda ya está guardada (cliente activo), no ofrezco "Guardar" de nuevo;
  // pero si cambiaste algo, muestro "Guardar cambios".
  $("btn-guardar-busq").style.display = window.__busquedaActiva ? "none" : "";
  $("btn-guardar-cambios").style.display = (window.__busquedaActiva && filtrosCambiaron()) ? "" : "none";
  var cont = $("cards");
  if (!total) {
    $("cuenta").textContent = "0 encontradas";
    cont.innerHTML = '<div class="vacio">No hay parecidas con esos filtros. Probá aflojar alguno (dejalo vacío / “Da igual”).</div>';
    return;
  }
  var txt = (total > res.length)                   // se aplicó el tope de 10
    ? "las " + res.length + " más parecidas (de " + total + ")"
    : total + (total === 1 ? " encontrada" : " encontradas");
  if (aflojados && aflojados.length) txt += " · amplié: " + aflojados.join(", ");
  $("cuenta").textContent = txt;
  cont.innerHTML = "";
  // Con cliente activo (búsqueda guardada abierta): reordeno por estado
  // (sin valorar y lo bueno arriba, descartes al fondo). Sin cliente: como siempre.
  var bAct = busquedaActiva();
  if (bAct) res = res.slice().sort(function (a, b) {
    return VAL_ESTADOS[valDe(bAct, a.slug)].orden - VAL_ESTADOS[valDe(bAct, b.slug)].orden;
  });
  res.forEach(function (c) {                       // ya viene cortado al tope
    var card = document.createElement("div");
    card.className = "card";
    if (bAct) card.classList.add("val-" + valDe(bAct, c.slug));
    if (fuera[c.slug]) card.classList.add("fuera");
    // Columna izquierda: número (cuando está tildada) + tilde para seleccionar
    var col = document.createElement("div"); col.className = "card-col";
    var num = document.createElement("span"); num.className = "card-num"; num.style.display = "none";
    col.appendChild(num);
    if (bAct) {
      // Con cliente: la ⭐ "Para enviar" ES la selección (sin casillero).
      if (valDe(bAct, c.slug) === "a_enviar") SEL.push(c);
    } else {
      // Sin cliente: casillero para seleccionar y copiar.
      var chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "card-check";
      chk.setAttribute("aria-label", "Seleccionar");
      chk.onchange = function () {
        var i = idxSel(c.slug);
        if (chk.checked && i < 0) SEL.push(c);
        else if (!chk.checked && i >= 0) SEL.splice(i, 1);
        renumerar();
      };
      col.appendChild(chk);
    }
    card.appendChild(col);
    CARDS.push({ slug: c.slug, numEl: num, card: card });
    var foto = c.foto ? '<img class="foto" src="' + esc(c.foto) + '" alt="" loading="lazy">'
                      : '<div class="foto ph">🏠</div>';
    var chips = [];
    if (c.m2_homog) chips.push(c.m2_homog + " m²");
    if (c.cochera === true) chips.push("🚗 cochera");
    if (c.estado === "a_estrenar") chips.push("a estrenar");
    if (c.renta === true) chips.push("con renta");
    // Aviso del dólar SOLO si esta propiedad está en otra moneda que la buscada (hubo conversión).
    var convChip = (USD_RATE && c.moneda && c.moneda.toLowerCase() !== monBusq)
      ? '<span class="chip conv">💱 al dólar ' + esc(String(USD_RATE).replace(".", ",")) + '</span>' : "";
    var link = document.createElement("a");
    link.className = "card-link"; link.href = c.link; link.target = "_blank"; link.rel = "noopener";
    link.style.cssText = "display:flex;gap:11px;flex:1;min-width:0;align-items:center";
    link.innerHTML = foto +
      '<div class="info">' +
        '<div class="titulo-card">' + esc(resumenCard(c)) + '</div>' +
        (fuera[c.slug] ? '<span class="fuera-tag">⚠ fuera de criterios</span>' : "") +
        (yaNoEntra[c.slug] ? '<span class="fuera-tag">🚫 ya no entra en el filtro</span>' : "") +
        '<div class="chips">' + chips.map(function (x) { return '<span class="chip">' + x + '</span>'; }).join("") + convChip + '</div>' +
        (porque(c, f) ? '<span class="porque">' + porque(c, f) + '</span>' : "") +
      '</div>';
    card.appendChild(link);
    if (bAct) {
      var vb = document.createElement("button");
      vb.className = "val-btn"; vb.textContent = VAL_ESTADOS[valDe(bAct, c.slug)].icono;
      vb.title = "Valorar para este cliente";
      vb.onclick = function () { abrirValPicker(c.slug); };
      card.appendChild(vb);
    }
    cont.appendChild(card);
  });
  renumerar();
}

function copiarTexto(texto, btn, vuelve) {
  var done = function () {
    btn.classList.add("ok"); btn.textContent = "✓";
    setTimeout(function () { btn.classList.remove("ok"); btn.textContent = vuelve; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(texto).then(done, function () { prompt("Copiá:", texto); });
  else prompt("Copiá:", texto);
}
function copiarSeleccionadas() {
  if (!SEL.length) return;
  copiarTexto(textoSeleccionadas(), $("btn-multicopy"), "📋 Copiar (" + SEL.length + ")");
}

// -------------------------- Traer datos de un link --------------------------
function slugDeLink(link) {
  var m = (link || "").match(/\/listings\/([^/?#]+)/);
  if (m) return m[1];
  var t = (link || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  var parts = t.split("/");
  return parts.length ? parts[parts.length - 1] : "";
}
function setRango(id, val) {   // llena mín/máx con ±25% del valor del link
  if (val) {
    $(id + "-min").value = fmtMiles(String(Math.round(val * 0.75)));
    $(id + "-max").value = fmtMiles(String(Math.round(val * 1.25)));
  } else { $(id + "-min").value = ""; $(id + "-max").value = ""; }
}
function rellenar(c) {
  setSeg("f-oper", c.operacion === "rent" ? "rent" : "sale");
  setSeg("f-moneda", (c.moneda || "").toUpperCase() === "UYU" ? "UYU" : "USD");
  var tc = tipoCat(c.tipo);
  setSegMulti("f-tipo", tc === "otro" ? [] : [tc]);
  // precio: sin mínimo (más barato sirve), máximo +15%. m²: ±25%.
  $("f-precio-min").value = "";
  $("f-precio-max").value = c.precio ? fmtMiles(String(Math.round(c.precio * 1.15))) : "";
  setRango("f-cub", c.m2_homog);
  setRango("f-padron", tc === "apto" ? 0 : c.m2_padron);   // aptos: sin padrón (RE/MAX no lo usa)
  SELBARRIOS = c.barrio ? [c.barrio] : [];   // 1 barrio → busca similares (su grupo)
  $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", c.dorm != null ? c.dorm : null);
  setStep("f-dmax", c.dorm != null ? c.dorm : null);
  setSeg("f-coch", c.cochera === true ? "si" : (c.cochera === false ? "no" : ""));
  setSeg("f-estado", c.estado || "");
  // Regla de Juan: si el link tiene renta → parecidas con renta; si no → sin renta.
  setSeg("f-renta", c.renta ? "con" : "sin");
  window.__slugActual = c.slug || null;
  window.__base = c;                       // referencia para ordenar "más parecida"
  mostrarAgente(c);
}
// Llena el formulario con lo que trajo el motorcito (InfoCasas / MercadoLibre).
// El barrio NO se autocompleta: los nombres de esos portales no coinciden con los
// de RE/MAX, así que Juan lo agrega a mano si quiere filtrar por zona.
function rellenarExterno(d) {
  setSeg("f-oper", d.operacion === "rent" ? "rent" : "sale");
  setSeg("f-moneda", (d.moneda || "").toUpperCase() === "UYU" ? "UYU" : "USD");
  var tc = tipoCat(d.tipo || "");
  setSegMulti("f-tipo", tc === "otro" ? [] : [tc]);
  $("f-precio-min").value = "";
  $("f-precio-max").value = d.precio ? fmtMiles(String(Math.round(d.precio * 1.15))) : "";
  setRango("f-cub", d.m2_construidos);
  setRango("f-padron", tc === "apto" ? 0 : d.m2_totales);   // aptos: sin padrón (RE/MAX no lo usa)
  // Barrio: si el del portal coincide con uno de RE/MAX, lo cargo (1 barrio = su grupo).
  SELBARRIOS = [];
  if (d.barrio) {
    var match = BARRIOS_ALL.filter(function (b) { return norm(b) === norm(d.barrio); })[0];
    if (match) SELBARRIOS = [match];
  }
  $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", d.dorm != null ? d.dorm : null);
  setStep("f-dmax", d.dorm != null ? d.dorm : null);
  setSeg("f-coch", d.cochera === true ? "si" : (d.cochera === false ? "no" : ""));
  setSeg("f-estado", d.estado || "");
  setSeg("f-renta", d.renta ? "con" : "sin");
  window.__slugActual = null;                      // no es de RE/MAX: no me excluyo
  var precioUsd = d.moneda === "UYU"
    ? (USD_RATE && d.precio ? Math.round(d.precio / USD_RATE) : null)
    : (d.precio ? Math.round(d.precio) : null);
  window.__base = {                                // referencia para ordenar "más parecida"
    operacion: d.operacion === "rent" ? "rent" : "sale", tipo: d.tipo || "",
    precio_usd: precioUsd, dorm: d.dorm, cochera: d.cochera, estado: d.estado,
    m2_homog: d.m2_construidos || null, barrio: ""
  };
  mostrarAgente(null);   // InfoCasas/MercadoLibre: no tenemos el agente de RE/MAX
}
function etiquetaEstadoPub(e) {
  return e === "reserved" ? "Reservada" : (e === "negotiation" ? "En negociación" : "");
}
// Teléfono del agente que carga la propiedad (viene de la ficha, NO del ?associate=
// que uno agrega al compartir). Se saca el celular primario y se limpia de espacios.
function telAgente(assoc) {
  var phones = (assoc && assoc.phones) || [];
  var prim = phones.filter(function (p) { return p && (p.primary || p.isPrimary); })[0]
          || phones.filter(function (p) { return p && (p.type === "mobile"); })[0]
          || phones[0];
  return prim && prim.value ? String(prim.value).replace(/\s+/g, "") : "";
}
// Muestra (o esconde) el botón "Copiar contacto del agente". El contacto SIEMPRE sale
// de la propiedad (por el slug), así que ignora el associate del link → nunca da el
// número de quien lo comparte.
function mostrarAgente(c) {
  var btn = $("btn-agente");
  var nombre = (c && c.agente || "").trim();
  var tel = (c && c.agente_tel || "").trim();
  if (nombre || tel) {
    window.__agente = { nombre: nombre, tel: tel };
    var etq = "📇 Copiar contacto" + (nombre ? ": " + nombre : " del agente");
    btn.textContent = etq;
    btn.dataset.vuelve = etq;
    btn.classList.toggle("nuevo", !novedadVista("agente-btn"));   // amarillo hasta el 1er toque
    btn.style.display = "";
  } else {
    window.__agente = null;
    btn.style.display = "none";
  }
}
function fromDetalle(det, slug) {
  var tipo = (det.type || {}).value || "";
  var esApto = norm(tipo).indexOf("departamento") >= 0;
  var park = det.parkingSpaces;
  var conds = (det.conditions || []).map(function (x) { return norm(x && x.value); });
  var aEstrenar = conds.some(function (c) { return c.indexOf("estrenar") >= 0 || c.indexOf("construccion") >= 0; });
  return {
    slug: slug,
    link: "https://www.remax.com.uy/listings/" + slug,
    tipo: tipo,
    operacion: (det.operation || {}).value || "",
    precio: det.price, moneda: (det.currency || {}).value || "",
    precio_usd: (det.currency || {}).value === "USD" ? (det.price ? Math.round(det.price) : null)
              : (USD_RATE && det.price ? Math.round(det.price / USD_RATE) : null),
    dorm: det.bedrooms,
    direccion: det.displayAddress || "",
    barrio: (det.geoLabel || "").split(",")[0].trim(),
    m2_homog: homog(det.dimensionCovered, det.dimensionTotalBuilt, det.dimensionLand, esApto, det.dimensionSemicovered, det.dimensionUncovered),
    m2_padron: Math.round(det.dimensionLand || 0),
    cochera: (park != null) ? (park > 0) : null,
    estado: aEstrenar ? "a_estrenar" : "usada",
    estado_pub: (det.listingStatus || {}).value || "active",
    renta: /(renta|rentad|alquilad|ocupad)/i.test(det.title || ""),
    agente: (det.associate || {}).name || "",
    agente_tel: telAgente(det.associate)
  };
}
function traer() {
  var link = $("link").value.trim();
  var hint = $("hint");
  mostrarAgente(null);   // se reesconde; lo vuelven a mostrar rellenar/fromDetalle si hay agente
  if (!link) { hint.textContent = "Pegá un link, o completá los datos a mano abajo."; return; }
  var esRemax = /remax\.com\.uy/i.test(link);
  var slug = slugDeLink(link);
  // 1) ¿está en el archivo del día? (lo más rápido)
  var enArchivo = DATA.filter(function (c) { return c.slug === slug; })[0];
  if (enArchivo) { rellenar(enArchivo); hint.innerHTML = avisoTraido(); return; }
  if (!esRemax) {
    var esOtroPortal = /(infocasas\.|mercadolibre\.|mlibre\.)/i.test(link) || /\bMLU-/.test(link);
    if (MOTOR_URL && esOtroPortal) {
      hint.textContent = "Leyendo la propiedad…";
      fetch(MOTOR_URL + (MOTOR_URL.indexOf("?") >= 0 ? "&" : "?") + "url=" + encodeURIComponent(link))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.error) { hint.innerHTML = "⚠️ " + esc(d.error) + " <b>Completá los datos a mano</b> y buscá igual."; return; }
          if (!d || (d.precio == null && d.dorm == null && d.m2_construidos == null))
            throw new Error("vacío");
          rellenarExterno(d);
          hint.innerHTML = "✓ Datos traídos de <b>" + esc(d.fuente || "el portal") +
            "</b>. Revisá (y agregá el barrio si querés) y tocá <b>Buscar parecidas</b>.";
        })
        .catch(function () {
          hint.innerHTML = "No pude leer del todo ese link. <b>Completá lo que falte a mano</b> y buscá igual.";
        });
      return;
    }
    hint.innerHTML = esOtroPortal
      ? "⚠️ Para leer InfoCasas/MercadoLibre falta prender el motorcito en <b>⚙️ Ajustes</b>. Por ahora, <b>completá a mano</b> y buscá igual."
      : "⚠️ Ese link no es de RE/MAX: no puedo leerlo solo. <b>Completá los datos a mano</b> y buscá igual.";
    return;
  }
  // 2) link de RE/MAX no incluido (muy nueva): lo busco en vivo
  hint.textContent = "Buscando la propiedad en RE/MAX…";
  fetch(DET_EP + slug).then(function (r) { return r.json(); }).then(function (d) {
    var det = d && d.data ? (d.data.data || d.data) : d;
    if (!det || !det.slug) throw new Error("no");
    rellenar(fromDetalle(det, det.slug));
    hint.innerHTML = avisoTraido();
  }).catch(function () {
    hint.innerHTML = "No pude leer ese link. <b>Completá los datos a mano</b> y buscá igual.";
  });
}

function avisoTraido() {
  var b = window.__base;
  if (b && b.estado_pub && b.estado_pub !== "active")
    return "⚠️ Esta propiedad está <b>" + etiquetaEstadoPub(b.estado_pub) +
           "</b> (no habilitada para ofrecer). Igual podés buscar parecidas.";
  return "✓ Datos traídos. Revisá y tocá <b>Buscar parecidas</b>.";
}

// -------------------------- Formato de miles en los campos --------------------------
function fmtMiles(digits) {                       // "100000" -> "100.000"
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function attachMiles(id, conPrefijo) {
  var el = $(id);
  el.addEventListener("input", function () {
    if (conPrefijo) {                             // precio: conserva "USD " si lo hay
      var pref = (el.value.match(/^[^\d]*/) || [""])[0];
      var dig = el.value.replace(/\D/g, "");
      el.value = dig ? pref + fmtMiles(dig) : pref;
    } else {
      el.value = fmtMiles(el.value.replace(/\D/g, ""));
    }
  });
}

// -------------------------- Barrios (multi-select con sugerencias) --------------------------
// 1 barrio = busca en su GRUPO (similares). 2+ barrios = SOLO esos exactos. Máx 10.
var BARRIOS_ALL = [];     // todos los barrios reales (para sugerir)
var SELBARRIOS = [];      // barrios elegidos (nombres para mostrar)

function cap(x) { return x.replace(/\b\w/g, function (m) { return m.toUpperCase(); }); }
function barriosSel() { return SELBARRIOS.map(norm); }

function renderChips() {
  var cont = $("barrio-chips"); cont.innerHTML = "";
  SELBARRIOS.forEach(function (nm) {
    var chip = document.createElement("span"); chip.className = "barrio-chip";
    chip.appendChild(document.createTextNode(nm));
    var x = document.createElement("button"); x.type = "button"; x.textContent = "✕";
    x.setAttribute("aria-label", "Sacar"); x.onclick = function () { delBarrio(nm); };
    chip.appendChild(x); cont.appendChild(chip);
  });
}
function addBarrio(nm) {
  if (SELBARRIOS.length >= 10) return;
  if (barriosSel().indexOf(norm(nm)) >= 0) return;
  SELBARRIOS.push(nm);
  renderChips(); pintarGrupo();
  $("f-barrio").value = ""; cerrarSug(); $("f-barrio").focus();
}
function delBarrio(nm) {
  SELBARRIOS = SELBARRIOS.filter(function (x) { return norm(x) !== norm(nm); });
  renderChips(); pintarGrupo();
}
function mostrarSug() {
  var q = norm($("f-barrio").value);
  if (!q) { cerrarSug(); return; }
  var ya = barriosSel();
  var m = BARRIOS_ALL.filter(function (b) { return norm(b).indexOf(q) >= 0 && ya.indexOf(norm(b)) < 0; }).slice(0, 8);
  if (!m.length) { cerrarSug(); return; }
  var list = document.createElement("div"); list.className = "barrio-sug-list";
  m.forEach(function (b) {
    var it = document.createElement("div"); it.className = "barrio-sug-item"; it.textContent = b;
    it.onmousedown = function (e) { e.preventDefault(); addBarrio(b); };
    list.appendChild(it);
  });
  var cont = $("barrio-sug"); cont.innerHTML = ""; cont.appendChild(list);
}
function cerrarSug() { $("barrio-sug").innerHTML = ""; }
function primeraSug() {
  var q = norm($("f-barrio").value); if (!q) return null;
  var ya = barriosSel();
  return BARRIOS_ALL.filter(function (b) { return norm(b).indexOf(q) >= 0 && ya.indexOf(norm(b)) < 0; })[0] || null;
}
function pintarGrupo() {
  var el = $("f-grupo");
  if (!SELBARRIOS.length) { el.textContent = ""; return; }
  if (SELBARRIOS.length === 1) {
    var g = grupoDe(SELBARRIOS[0]);
    el.textContent = (g && g.length > 1)
      ? "Busca similares: " + g.map(cap).slice(0, 6).join(" · ") + (g.length > 6 ? "…" : "")
      : "Solo este barrio";
  } else {
    el.textContent = "Solo estos " + SELBARRIOS.length + " barrios (exacto)";
  }
}

// -------------------------- Búsquedas guardadas --------------------------
// Todo vive en el celu (localStorage). Cada búsqueda guarda: nombre + celular del
// cliente, una foto del formulario (para reabrirla) y el filtro (para contar
// cuántas parecidas NUEVAS aparecieron desde la última vez que la miró.
var BUSQ_KEY = "parecidas_busquedas";
function cargarBusquedas() {
  try { return JSON.parse(localStorage.getItem(BUSQ_KEY) || "[]"); } catch (e) { return []; }
}
function guardarBusquedas(arr) {
  try { localStorage.setItem(BUSQ_KEY, JSON.stringify(arr)); } catch (e) {}
}

// Foto del formulario tal cual está, para poder reabrir la búsqueda idéntica.
function snapshotForm() {
  return {
    link: $("link").value,
    oper: segVal("f-oper"), moneda: segVal("f-moneda"), tipos: segMulti("f-tipo"),
    precioMin: $("f-precio-min").value, precioMax: $("f-precio-max").value,
    cubMin: $("f-cub-min").value, cubMax: $("f-cub-max").value,
    padronMin: $("f-padron-min").value, padronMax: $("f-padron-max").value,
    gastosMin: $("f-gastos-min").value, gastosMax: $("f-gastos-max").value,
    barrios: SELBARRIOS.slice(),
    dmin: stepVal("f-dmin"), dmax: stepVal("f-dmax"),
    coch: segVal("f-coch"), estado: segVal("f-estado"), renta: segVal("f-renta"),
    base: window.__base || null, slugActual: window.__slugActual || null
  };
}
function restoreForm(s) {
  $("link").value = s.link || "";
  setSeg("f-oper", s.oper || "sale");
  setSeg("f-moneda", s.moneda || (s.oper === "rent" ? "UYU" : "USD"));
  setSegMulti("f-tipo", s.tipos || []);
  $("f-precio-min").value = s.precioMin || ""; $("f-precio-max").value = s.precioMax || "";
  $("f-cub-min").value = s.cubMin || ""; $("f-cub-max").value = s.cubMax || "";
  $("f-padron-min").value = s.padronMin || ""; $("f-padron-max").value = s.padronMax || "";
  $("f-gastos-min").value = s.gastosMin || ""; $("f-gastos-max").value = s.gastosMax || "";
  toggleGastos();
  SELBARRIOS = (s.barrios || []).slice(); $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", s.dmin != null ? s.dmin : null);
  setStep("f-dmax", s.dmax != null ? s.dmax : null);
  setSeg("f-coch", s.coch || ""); setSeg("f-estado", s.estado || ""); setSeg("f-renta", s.renta || "");
  window.__base = s.base || null; window.__slugActual = s.slugActual || null;
}

// Las parecidas que hoy cumplen el filtro guardado (mismas reglas que la búsqueda).
function matchesDe(b) {
  return DATA.filter(function (c) { return pasa(c, b.filtro, b.slugActual); });
}
// Cuántas de esas NO estaban la última vez que Juan miró esta búsqueda.
function nuevasDe(b) {
  var visto = {}; (b.vistas || []).forEach(function (s) { visto[s] = 1; });
  var n = 0;
  matchesDe(b).forEach(function (c) { if (!visto[c.slug]) n++; });
  return n;
}
function totalNuevas() {
  return cargarBusquedas().reduce(function (a, b) { return a + nuevasDe(b); }, 0);
}

// Número del cliente → link de WhatsApp (arma el 598… de Uruguay).
function waLink(tel) {
  var d = (tel || "").replace(/[^\d]/g, "");
  if (!d) return null;
  if (d.charAt(0) === "0") d = "598" + d.slice(1);          // 099… → 59899…
  else if (d.indexOf("598") !== 0 && (d.length === 8 || d.length === 9)) d = "598" + d;
  return "https://wa.me/" + d;
}

function guardarBusquedaActual(nombre, tel, direccion, campana) {
  var f = leerFiltros();
  var slugActual = window.__slugActual || null;
  var matches = DATA.filter(function (c) { return pasa(c, f, slugActual); });
  var esCamp = !!(campana && slugActual);   // campaña solo si vino de un link de RE/MAX
  var b = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
    nombre: nombre, tel: tel, direccion: direccion || "", creada: new Date().toISOString(),
    form: snapshotForm(), filtro: f, slugActual: slugActual,
    vistas: matches.map(function (c) { return c.slug; }),   // lo que ya vio hoy
    campana: esCamp, campSlug: esCamp ? slugActual : null, campEstado: "", campAck: ""
  };
  // Si hay seleccionadas al guardar: esas quedan PENDIENTES (⏳) y el resto de las
  // que estaban en la lista, DESCARTADAS (🔴 descarte_1). (Enviada se marca al Enviar.)
  if (SEL.length) {
    b.estados = {};
    var sel = {};
    SEL.forEach(function (c) { sel[c.slug] = 1; b.estados[c.slug] = "pendiente"; });
    CARDS.forEach(function (o) { if (!sel[o.slug]) b.estados[o.slug] = "descarte_1"; });
  }
  var arr = cargarBusquedas(); arr.unshift(b); guardarBusquedas(arr);
  window.__busquedaActiva = b.id;   // el cliente recién guardado queda activo
  if (esCamp) chequearCampanas();   // arranca la vigilancia de esa propiedad ya
}

// ¿El formulario actual difiere de lo guardado en el cliente activo?
function filtrosCambiaron() {
  var b = busquedaActiva();
  if (!b) return false;
  return JSON.stringify(snapshotForm()) !== JSON.stringify(b.form || {});
}
// Guardar los filtros/form actuales dentro del cliente activo (y refrescar su baseline).
function guardarFiltrosEnCliente() {
  var b = busquedaActiva();
  if (!b) return;
  var arr = cargarBusquedas();
  var bb = arr.filter(function (x) { return x.id === b.id; })[0];
  if (!bb) return;
  bb.form = snapshotForm();
  bb.filtro = leerFiltros();
  bb.slugActual = window.__slugActual || null;
  bb.vistas = DATA.filter(function (c) { return pasa(c, bb.filtro, bb.slugActual); })
    .map(function (c) { return c.slug; });
  guardarBusquedas(arr);
}
// Antes de salir de un cliente con filtros cambiados: preguntar si guardarlos.
function salirDeCliente(luego) {
  if (filtrosCambiaron() &&
      confirm("Cambiaste los filtros de este cliente. ¿Guardar los nuevos filtros?"))
    guardarFiltrosEnCliente();
  luego();
}

function abrirBusqueda(id) {
  // Si venías de otro cliente con filtros cambiados, ofrecer guardarlos.
  if (window.__busquedaActiva && window.__busquedaActiva !== id && filtrosCambiaron() &&
      confirm("Cambiaste los filtros del cliente anterior. ¿Guardarlos antes de salir?"))
    guardarFiltrosEnCliente();
  var arr = cargarBusquedas();
  var b = null;
  arr.forEach(function (x) { if (x.id === id) b = x; });
  if (!b) return;
  restoreForm(b.form);
  window.__busquedaActiva = b.id;                               // cliente activo (para Enviar)
  window.__ultimaVista = null;                                  // baseline nuevo (no descarta al abrir)
  b.vistas = matchesDe(b).map(function (c) { return c.slug; });  // marca como visto → apaga el numerito
  guardarBusquedas(arr);
  cerrarOverlay("busquedas");
  buscar();
  renderBadge();
  $("resultados").scrollIntoView({ behavior: "smooth", block: "start" });
}

function borrarBusqueda(id) {
  var arr = cargarBusquedas().filter(function (x) { return x.id !== id; });
  guardarBusquedas(arr); renderBusquedas(); renderBadge();
}

function renderBusquedas() {
  var cont = $("busq-lista");
  var arr = cargarBusquedas();
  if (!arr.length) {
    cont.innerHTML = '<div class="vacio">Todavía no guardaste ninguna búsqueda.<br>Buscá parecidas y tocá “Guardar esta búsqueda”.</div>';
    return;
  }
  cont.innerHTML = "";
  arr.forEach(function (b) {
    var nuevas = nuevasDe(b);
    var item = document.createElement("div"); item.className = "busq-item";
    var info = document.createElement("div"); info.className = "bi-info";
    var nom = document.createElement("div"); nom.className = "bi-nom bi-clic";
    nom.textContent = b.nombre || "Sin nombre";
    nom.title = "Notas del cliente";
    nom.onclick = function () { abrirClienteEditor(b.id); };
    info.appendChild(nom);
    if (b.direccion) {
      var dirEl = document.createElement("div"); dirEl.className = "bi-sub";
      dirEl.textContent = "📍 " + b.direccion;
      info.appendChild(dirEl);
    }
    var sub = document.createElement("div"); sub.className = "bi-sub";
    var wa = waLink(b.tel);
    if (b.tel && wa) {
      var a = document.createElement("a");
      a.className = "bi-tel"; a.href = wa; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "💬 " + b.tel;
      sub.appendChild(a);
    } else { sub.textContent = matchesDe(b).length + " parecidas"; }
    var env = (b.enviadas || []).length;
    if (env) sub.appendChild(document.createTextNode("  ·  📤 " + env + " enviada" + (env === 1 ? "" : "s")));
    info.appendChild(sub);
    var c = textoContacto(b);
    var cont2 = document.createElement("div");
    cont2.className = "bi-contacto";
    cont2.textContent = "💬 Últ. contacto: " + c.txt;
    info.appendChild(cont2);
    if (b.recordarAt) {                              // aviso según el temporizador
      var r = recordatorioTexto(b);
      var rec = document.createElement("div");
      rec.className = "bi-contacto" + (r.due ? " tarde" : "");
      rec.textContent = r.txt;
      info.appendChild(rec);
    }
    if (b.notas) {
      var np = document.createElement("div"); np.className = "bi-nota";
      np.textContent = "📝 " + b.notas;
      info.appendChild(np);
    }
    if (b.campana) {
      var alerta = campEnAlerta(b);
      var cp = document.createElement("div");
      cp.className = "bi-camp " + (alerta ? "alerta" : "ok");
      cp.textContent = alerta ? ("⚠️ En campaña — " + etqCampana(b.campEstado))
                              : "📣 En campaña — publicada";
      info.appendChild(cp);
    }
    item.appendChild(info);
    if (nuevas > 0) {
      var badge = document.createElement("span"); badge.className = "bi-nuevas";
      badge.textContent = "+" + nuevas + " nueva" + (nuevas === 1 ? "" : "s");
      item.appendChild(badge);
    }
    var edit = document.createElement("button");
    edit.className = "bi-edit" + (novedadVista("lapiz") ? "" : " nuevo");
    edit.textContent = "✎"; edit.title = "Notas y recordatorio";
    edit.setAttribute("aria-label", "Notas y recordatorio");
    edit.onclick = function () { abrirClienteEditor(b.id); };
    item.appendChild(edit);
    var abrir = document.createElement("button"); abrir.className = "bi-btn";
    abrir.textContent = "Abrir"; abrir.onclick = function () { abrirBusqueda(b.id); };
    item.appendChild(abrir);
    var del = document.createElement("button"); del.className = "bi-del";
    del.textContent = "🗑"; del.title = "Borrar"; del.setAttribute("aria-label", "Borrar");
    del.onclick = function () {
      if (confirm("¿Borrar la búsqueda de " + (b.nombre || "este cliente") + "?")) borrarBusqueda(b.id);
    };
    item.appendChild(del);
    cont.appendChild(item);
  });
}

// El numerito rojo en el 🔖 de arriba = total de nuevas en todas las búsquedas.
function renderBadge() {
  var n = totalNuevas() + campAlertasNuevas().length, el = $("busq-badge");
  if (n > 0) { el.textContent = n > 99 ? "99+" : n; el.style.display = ""; }
  else el.style.display = "none";
  // Numerito (silencioso) en el ícono de la app instalada. Se refresca al abrir la app.
  try {
    if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch (e) {}
}

// -------------------------- Campañas: vigilar propiedades publicitadas --------------------------
// Vigila SOLO al abrir la app (sin servidor no hay aviso con la app cerrada). Si una
// propiedad que Juan publicita pasa a reservada / en negociación / se baja, avisa.
function etqCampana(est) {
  return est === "reserved" ? "Reservada"
    : est === "negotiation" ? "En negociación"
    : est === "baja" ? "Ya no está publicada"
    : est === "finished" ? "Finalizada / vendida"
    : "Cambió de estado";
}
function estadoCampanaDe(d) {
  var det = d && d.data ? (d.data.data || d.data) : null;
  if (!det || !det.slug) return "baja";                 // data null = ya no publicada
  return (det.listingStatus || {}).value || "active";
}
function campEnAlerta(b) { return b.campana && b.campEstado && b.campEstado !== "active"; }
function campAlertas() { return cargarBusquedas().filter(campEnAlerta); }
// Avisos que Juan todavía NO reconoció con "Entendido" (los que cuentan para el numerito).
function campAlertasNuevas() {
  return campAlertas().filter(function (b) { return b.campEstado !== b.campAck; });
}
// Chequea en vivo el estado de cada propiedad en campaña; al terminar, repinta los avisos.
function chequearCampanas() {
  var arr = cargarBusquedas();
  var pend = arr.filter(function (b) { return b.campana && (b.campSlug || b.slugActual); });
  if (!pend.length) { pintarBanner(); return; }
  var falta = pend.length;
  var fin = function () {
    if (--falta > 0) return;
    guardarBusquedas(arr);
    pintarBanner(); renderBadge();
    if ($("busquedas").style.display === "flex") renderBusquedas();
  };
  pend.forEach(function (b) {
    var slug = b.campSlug || b.slugActual;
    fetch(DET_EP + slug).then(function (r) { return r.json(); })
      .then(function (d) { b.campEstado = estadoCampanaDe(d); fin(); })
      .catch(function () { fin(); });   // error de red: dejo el estado conocido como estaba
  });
}
// Cartel rojo arriba (solo con avisos que todavía no reconoció).
function pintarBanner() {
  var al = campAlertasNuevas();
  var box = $("camp-banner");
  if (!al.length) { box.style.display = "none"; return; }
  var lista = $("cb-lista"); lista.innerHTML = "";
  al.forEach(function (b) {
    var d = document.createElement("div"); d.className = "cb-item";
    var quien = b.direccion || b.nombre || "Una propiedad";
    d.innerHTML = "📣 " + esc(quien) + " → <b>" + esc(etqCampana(b.campEstado)) + "</b>";
    lista.appendChild(d);
  });
  box.style.display = "";
}
// "Entendido": deja de insistir con ESTE estado (pero el ⚠️ sigue en el menú 🔖).
function ackCampanas() {
  var arr = cargarBusquedas();
  arr.forEach(function (b) { if (campEnAlerta(b)) b.campAck = b.campEstado; });
  guardarBusquedas(arr);
  pintarBanner(); renderBadge();
}

// -------------------------- Avisos con la app cerrada (push, gratis vía Cloudflare) --------------------------
// Llave PÚBLICA (no es secreto): identifica que el aviso viene de TU robotito.
var VAPID_PUBLIC = "BAxadZ2Doxe6UjrVtNi5E29AlBvGacELm2Lxuv-CVwdVKem4ZnRAyn0ULCA2-GvhrUmADw_exSksOnbOsDolTWc";
function urlB64ToUint8(base64) {
  var pad = "=".repeat((4 - base64.length % 4) % 4);
  var b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  var raw = atob(b64), arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
// Las propiedades en campaña que el robotito tiene que vigilar (con la app cerrada).
function slugsEnCampana() {
  return cargarBusquedas()
    .filter(function (b) { return b.campana && (b.campSlug || b.slugActual); })
    .map(function (b) { return { slug: b.campSlug || b.slugActual, dir: b.direccion || b.nombre || "" }; });
}
function pushSoportado() {
  return ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
}
// Pide permiso (si corresponde), suscribe el celu y le manda al robotito qué vigilar.
async function activarAvisos(pedirPermiso) {
  if (!pushSoportado() || !MOTOR_URL) return false;
  try {
    var perm = Notification.permission;
    if (perm === "default" && pedirPermiso) perm = await Notification.requestPermission();
    if (perm !== "granted") return false;
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC)
    });
    await sincronizarPush(sub);
    return true;
  } catch (e) { return false; }
}
// Manda la suscripción + la lista de lo que hay que vigilar. Sin permiso concedido, no hace nada.
async function sincronizarPush(sub) {
  if (!pushSoportado() || !MOTOR_URL || Notification.permission !== "granted") return;
  try {
    if (!sub) {
      var reg = await navigator.serviceWorker.ready;
      sub = await reg.pushManager.getSubscription();
    }
    if (!sub) return;
    var j = sub.toJSON();
    await fetch(MOTOR_URL + (MOTOR_URL.indexOf("?") >= 0 ? "&" : "?") + "sub=1", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        p256dh: j.keys && j.keys.p256dh, auth: j.keys && j.keys.auth,
        campanas: slugsEnCampana()
      })
    });
  } catch (e) {}
}
function pintarEstadoAvisos() {
  var el = $("avisos-estado"); if (!el) return;
  if (!pushSoportado()) { el.textContent = "Este celu/navegador no soporta avisos."; return; }
  var p = Notification.permission;
  el.textContent = p === "granted" ? "✓ Avisos activados (te llegan con la app cerrada)."
    : p === "denied" ? "Los avisos están bloqueados en este celu. Activalos en los ajustes del navegador."
    : "Los avisos están apagados.";
}

function abrirOverlay(id) { $(id).style.display = "flex"; }
function cerrarOverlay(id) { $(id).style.display = "none"; }

// -------------------------- Novedades (cartel 1 vez + resaltado amarillo) --------------------------
function novedadVista(k) { try { return localStorage.getItem("parecidas_nv_" + k) === "1"; } catch (e) { return true; } }
function marcarNovedad(k) { try { localStorage.setItem("parecidas_nv_" + k, "1"); } catch (e) {} }
function pintarMarcaNueva() {
  $("marca").classList.toggle("nuevo", !novedadVista("marca"));
}

// -------------------------- Recordar la vista (sobrevive a recargar) --------------------------
var ESTADO_KEY = "parecidas_estado";
function guardarEstadoActual() {
  try {
    localStorage.setItem(ESTADO_KEY, JSON.stringify({
      form: snapshotForm(), busquedaActiva: window.__busquedaActiva || null
    }));
  } catch (e) {}
}
function restaurarEstado() {
  var est;
  try { est = JSON.parse(localStorage.getItem(ESTADO_KEY) || "null"); } catch (e) { est = null; }
  if (!est || !est.form) return;
  restoreForm(est.form);
  window.__busquedaActiva = est.busquedaActiva || null;
  buscar();
}
// Tocar "Parecidas" = borrar lo que se está viendo (form + resultados + memoria).
function limpiarTodo() {
  try { localStorage.removeItem(ESTADO_KEY); } catch (e) {}
  $("link").value = "";
  setSeg("f-oper", "sale"); setSeg("f-moneda", "USD"); setSegMulti("f-tipo", []);
  ["f-precio-min", "f-precio-max", "f-cub-min", "f-cub-max", "f-padron-min", "f-padron-max",
   "f-gastos-min", "f-gastos-max"]
    .forEach(function (id) { $(id).value = ""; });
  SELBARRIOS = []; $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", null); setStep("f-dmax", null);
  setSeg("f-coch", ""); setSeg("f-estado", ""); setSeg("f-renta", ""); toggleGastos();
  window.__base = null; window.__slugActual = null; window.__busquedaActiva = null;
  window.__ultimaVista = null;
  SEL = []; CARDS = []; actualizarMulticopy();
  $("cards").innerHTML = ""; $("resultados").style.display = "none"; $("hint").innerHTML = "";
  mostrarAgente(null);
}

// -------------------------- Notas + recordatorio por cliente --------------------------
function diasDesde(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
// "Hace N días" desde el ÚLTIMO ENVÍO real (Enviar por WhatsApp o "Le escribí hoy").
// Si nunca le mandó nada, lo dice claro (no cuenta desde que se creó la búsqueda).
function textoContacto(b) {
  var d = diasDesde(b.ultimoContacto);
  if (d == null) return { txt: "sin enviarle todavía", tarde: false };
  if (d <= 0) return { txt: "hoy", tarde: false };
  return { txt: "hace " + d + (d === 1 ? " día" : " días"), tarde: false };
}
var __clienteEdit = null;
function abrirClienteEditor(id) {
  var b = cargarBusquedas().filter(function (x) { return x.id === id; })[0];
  if (!b) return;
  marcarNovedad("lapiz");   // ya la usó → deja de estar en amarillo
  __clienteEdit = id;
  $("ce-nombre").textContent = b.nombre || "Cliente";
  $("ce-notas").value = b.notas || "";
  $("ce-recdias").value = "";
  pintarContactoCE(b);
  pintarRecordatorioCE(b);
  pintarCampanaCE(b);
  abrirOverlay("cliente-editor");
}
// Estado de la campaña + botón para prender/apagar la vigilancia de ESA propiedad.
function pintarCampanaCE(b) {
  var btn = $("btn-ce-campana"), est = $("ce-camp-estado");
  var slug = b.campSlug || b.slugActual;
  if (!slug) { btn.style.display = "none"; est.textContent = ""; est.className = "ce-contacto"; return; }
  if (b.campana) {
    var alerta = campEnAlerta(b);
    est.textContent = alerta ? ("📣 En campaña — ⚠️ " + etqCampana(b.campEstado))
                             : "📣 En campaña — publicada";
    est.className = "ce-contacto" + (alerta ? " tarde" : "");
    btn.textContent = "📣 Ya no hago campaña de esta propiedad";
  } else {
    est.textContent = ""; est.className = "ce-contacto";
    btn.textContent = "📣 Marcar: estoy en campaña de esta propiedad";
  }
  btn.style.display = "";
}
function toggleCampanaCE() {
  if (!__clienteEdit) return;
  var arr = cargarBusquedas();
  var b = arr.filter(function (x) { return x.id === __clienteEdit; })[0];
  if (!b) return;
  var slug = b.campSlug || b.slugActual;
  if (!slug) return;
  if (b.campana) { b.campana = false; }
  else { b.campana = true; b.campSlug = slug; b.campEstado = ""; b.campAck = ""; }
  guardarBusquedas(arr);
  pintarCampanaCE(b); renderBadge();
  if (b.campana) { chequearCampanas(); activarAvisos(true); }
  else sincronizarPush();   // sacó la campaña: actualiza la lista que vigila el robotito
}
function pintarContactoCE(b) {
  var c = textoContacto(b);
  $("ce-contacto").textContent = "Último contacto: " + c.txt;
  $("ce-contacto").className = "ce-contacto" + (c.tarde ? " tarde" : "");
}
function guardarNotasCliente() {
  if (!__clienteEdit) return;
  var arr = cargarBusquedas();
  var b = arr.filter(function (x) { return x.id === __clienteEdit; })[0];
  if (b) { b.notas = ($("ce-notas").value || "").trim(); guardarBusquedas(arr); }
}
function marcarContactado() {
  if (!__clienteEdit) return;
  var arr = cargarBusquedas();
  var b = arr.filter(function (x) { return x.id === __clienteEdit; })[0];
  if (b) { b.ultimoContacto = new Date().toISOString(); guardarBusquedas(arr); pintarContactoCE(b); }
}
// Temporizador de recordatorio (lo setea Juan por cliente). due = ya llegó la fecha.
function recordatorioTexto(b) {
  if (!b || !b.recordarAt) return { none: true, due: false, txt: "" };
  var d = diasDesde(b.recordarAt);           // >=0 = ya llegó/pasó
  var fe = new Date(b.recordarAt);
  var f = ("0" + fe.getDate()).slice(-2) + "/" + ("0" + (fe.getMonth() + 1)).slice(-2);
  if (d >= 0) return { due: true, txt: "⏰ Recordatorio vencido (era " + f + ")" };
  return { due: false, txt: "⏰ Recordar el " + f + " (en " + (-d) + (d === -1 ? " día" : " días") + ")" };
}
function pintarRecordatorioCE(b) {
  var r = recordatorioTexto(b);
  $("ce-recordatorio").textContent = r.none ? "Sin recordatorio." : r.txt;
  $("ce-recordatorio").className = "ce-recordatorio" + (r.due ? " due" : "");
}
function setRecordatorio(dias) {
  if (!__clienteEdit) return;
  var arr = cargarBusquedas();
  var b = arr.filter(function (x) { return x.id === __clienteEdit; })[0];
  if (!b) return;
  if (dias == null) delete b.recordarAt;
  else b.recordarAt = new Date(Date.now() + dias * 86400000).toISOString();
  guardarBusquedas(arr); pintarRecordatorioCE(b);
}

// -------------------------- Valoraciones (por cliente) --------------------------
// El estado es POR CLIENTE (vive dentro de la búsqueda guardada). Orden en la lista:
// menor arriba (sin valorar y lo bueno arriba, descartes al fondo).
var VAL_ESTADOS = {
  sin_valorar: { orden: 1, icono: "⚪", label: "Sin valorar" },
  a_enviar:    { orden: 2, icono: "⭐", label: "Para enviar" },
  favorita:    { orden: 3, icono: "💚", label: "Le gustó al cliente" },
  enviada:     { orden: 4, icono: "📤", label: "Enviada" },
  pendiente:   { orden: 5, icono: "⏳", label: "Pendiente / revisar" },
  descartada_filtro: { orden: 5.5, icono: "🚫", label: "Ya no entra en el filtro" },
  descarte_1:  { orden: 6, icono: "🔴", label: "No me gustó" },
  descarte_2:  { orden: 7, icono: "🔴🔴", label: "La descartó (por la foto)" },
  descarte_3:  { orden: 8, icono: "🔴🔴🔴", label: "La descartó (tras la visita)" }
};
var VAL_ORDEN = ["sin_valorar", "a_enviar", "favorita", "enviada", "pendiente",
                 "descartada_filtro", "descarte_1", "descarte_2", "descarte_3"];

function valDe(busq, slug) { return (busq && busq.estados && busq.estados[slug]) || "sin_valorar"; }
function setVal(slug, clave) {
  var b = busquedaActiva(); if (!b) return;
  var arr = cargarBusquedas();
  var bb = arr.filter(function (x) { return x.id === b.id; })[0]; if (!bb) return;
  bb.estados = bb.estados || {};
  if (clave === "sin_valorar") delete bb.estados[slug]; else bb.estados[slug] = clave;
  guardarBusquedas(arr);
}
// Menú para elegir el estado de una propiedad (solo con cliente activo).
function abrirValPicker(slug) {
  var b = busquedaActiva(); if (!b) return;
  var actual = valDe(b, slug);
  var cont = $("val-lista"); cont.innerHTML = "";
  VAL_ORDEN.forEach(function (clave) {
    var e = VAL_ESTADOS[clave];
    var it = document.createElement("button");
    it.className = "val-opt" + (clave === actual ? " sel" : "");
    it.innerHTML = '<span class="val-ic">' + e.icono + "</span> " + esc(e.label);
    it.onclick = function () { setVal(slug, clave); cerrarOverlay("val-picker"); buscar(); };
    cont.appendChild(it);
  });
  abrirOverlay("val-picker");
}

// -------------------------- Botón Instalar (Android/Chrome) --------------------------
// Chrome ya no muestra un botón grande solo: capturamos su evento y mostramos el nuestro.
var deferredInstall = null;
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault();
  deferredInstall = e;
  var b = $("btn-instalar"); if (b) b.style.display = "";
});
window.addEventListener("appinstalled", function () {
  deferredInstall = null;
  var b = $("btn-instalar"); if (b) b.style.display = "none";
});

// -------------------------- Arranque + eventos --------------------------
function initSegs() {
  ["f-oper", "f-coch", "f-estado", "f-renta", "f-moneda"].forEach(function (id) {   // una sola opción
    $(id).addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      setSeg(id, e.target.getAttribute("data-v"));
    });
  });
  // Al cambiar operación, moneda por defecto: alquiler → pesos, venta → dólares.
  $("f-oper").addEventListener("click", function (e) {
    if (e.target.tagName !== "BUTTON") return;
    setSeg("f-moneda", segVal("f-oper") === "rent" ? "UYU" : "USD");
    toggleGastos();
  });
  // Tipo: varios a la vez (toggle independiente por botón)
  $("f-tipo").addEventListener("click", function (e) {
    if (e.target.tagName !== "BUTTON") return;
    var b = e.target;
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
  });
  ["f-dmin", "f-dmax"].forEach(function (id) {
    $(id).addEventListener("click", function (e) {
      var d = e.target.getAttribute("data-d");
      if (!d) return;
      var v = stepVal(id);
      v = (v == null) ? (d === "1" ? 0 : null) : Math.max(-1, v + parseInt(d, 10));
      setStep(id, v < 0 ? null : v);
    });
  });
  $("f-barrio").addEventListener("input", mostrarSug);
  $("f-barrio").addEventListener("blur", function () { setTimeout(cerrarSug, 150); });
  $("f-barrio").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); var s = primeraSug(); if (s) addBarrio(s); }
  });
  // Si toca el link, ya no está en el contexto de un cliente guardado.
  $("link").addEventListener("input", function () {
    window.__busquedaActiva = null; window.__ultimaVista = null;
    if (!$("link").value.trim()) { window.__base = null; window.__slugActual = null; }
  });
  ["f-precio-min", "f-precio-max", "f-cub-min", "f-cub-max", "f-padron-min", "f-padron-max",
   "f-gastos-min", "f-gastos-max"]
    .forEach(function (id) { attachMiles(id, false); });
  toggleGastos();
  $("btn-traer").addEventListener("click", traer);
  $("btn-buscar").addEventListener("click", buscar);
  $("marca").addEventListener("click", function () {   // tocar 🏠 Parecidas = empezar de cero
    marcarNovedad("marca"); $("marca").classList.remove("nuevo");
    salirDeCliente(limpiarTodo);   // si cambió filtros de un cliente, ofrece guardarlos
  });
  // Cartel de novedades (una sola vez)
  pintarMarcaNueva();
  if (!novedadVista("news")) {
    // Usuario nuevo: ve el cartel completo (el punto del agente ya está adentro),
    // así que doy por vista la novedad del agente para no encimarle dos carteles.
    abrirOverlay("news"); marcarNovedad("news-agente");
  } else if (!novedadVista("news-agente")) {
    abrirOverlay("news-agente");
  }
  var cerrarNews = function () { marcarNovedad("news"); cerrarOverlay("news"); };
  $("btn-news-ok").addEventListener("click", cerrarNews);
  $("btn-news-x").addEventListener("click", cerrarNews);
  $("news").addEventListener("click", function (e) { if (e.target === $("news")) cerrarNews(); });
  var cerrarNewsAgente = function () { marcarNovedad("news-agente"); cerrarOverlay("news-agente"); };
  $("btn-news-agente-ok").addEventListener("click", cerrarNewsAgente);
  $("btn-news-agente-x").addEventListener("click", cerrarNewsAgente);
  $("news-agente").addEventListener("click", function (e) { if (e.target === $("news-agente")) cerrarNewsAgente(); });
  $("btn-agente").addEventListener("click", function () {
    marcarNovedad("agente-btn"); $("btn-agente").classList.remove("nuevo");   // ya lo usó → sale del amarillo
    var a = window.__agente; if (!a) return;
    var texto = [a.nombre, a.tel].filter(Boolean).join(" ");
    copiarTexto(texto, $("btn-agente"),
      $("btn-agente").dataset.vuelve || "📇 Copiar contacto del agente");
  });
  $("btn-multicopy").addEventListener("click", copiarSeleccionadas);
  $("btn-multienviar").addEventListener("click", enviarSeleccionadas);
  // Notas del cliente
  var cerrarCE = function () { guardarNotasCliente(); cerrarOverlay("cliente-editor"); renderBusquedas(); };
  $("btn-ce-cerrar").addEventListener("click", cerrarCE);
  $("btn-ce-guardar").addEventListener("click", cerrarCE);
  $("cliente-editor").addEventListener("click", function (e) { if (e.target === $("cliente-editor")) cerrarCE(); });
  $("btn-ce-contactado").addEventListener("click", marcarContactado);
  $("btn-ce-recponer").addEventListener("click", function () {
    var n = soloNum($("ce-recdias").value);
    if (!n || n < 1) { $("ce-recordatorio").textContent = "Poné un número de días."; return; }
    setRecordatorio(n);
  });
  $("btn-ce-sinrec").addEventListener("click", function () { $("ce-recdias").value = ""; setRecordatorio(null); });
  $("btn-ce-campana").addEventListener("click", toggleCampanaCE);
  $("btn-cb-ok").addEventListener("click", ackCampanas);
  $("btn-cb-ver").addEventListener("click", function () { renderBusquedas(); abrirOverlay("busquedas"); });
  $("btn-instalar").addEventListener("click", function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function () {
      deferredInstall = null; $("btn-instalar").style.display = "none";
    });
  });
  $("btn-val-cerrar").addEventListener("click", function () { cerrarOverlay("val-picker"); });
  $("val-picker").addEventListener("click", function (e) { if (e.target === $("val-picker")) cerrarOverlay("val-picker"); });
  // Ajustes (associate editable)
  $("btn-ajustes").addEventListener("click", function () {
    $("in-associate").value = ASSOCIATE; $("in-motor").value = MOTOR_URL;
    $("ajustes-msg").textContent = "";
    pintarEstadoAvisos();
    $("ajustes").style.display = "flex";
  });
  $("btn-ajustes-cerrar").addEventListener("click", function () { $("ajustes").style.display = "none"; });
  $("ajustes").addEventListener("click", function (e) { if (e.target === $("ajustes")) $("ajustes").style.display = "none"; });
  var guardarAjustes = function () {
    var v = ($("in-associate").value || "").trim();
    ASSOCIATE = v;                                  // vacío = links sin contacto
    try { localStorage.setItem("parecidas_associate", v); } catch (e) {}
    MOTOR_URL = ($("in-motor").value || "").trim().replace(/\/+$/, "");
    try { localStorage.setItem("parecidas_motor", MOTOR_URL); } catch (e) {}
    $("ajustes-msg").textContent = v ? "✓ Guardado" : "✓ Guardado — los links salen sin contacto";
  };
  $("btn-associate-guardar").addEventListener("click", guardarAjustes);
  $("btn-associate-borrar").addEventListener("click", function () {
    $("in-associate").value = "";
    guardarAjustes();
  });
  $("btn-activar-avisos").addEventListener("click", function () {
    $("avisos-estado").textContent = "Pidiendo permiso…";
    activarAvisos(true).then(function (ok) {
      pintarEstadoAvisos();
      if (ok) $("avisos-estado").textContent = "✓ Avisos activados. Te llegan aunque no tengas la app abierta.";
    });
  });

  // Búsquedas guardadas (menú nuevo)
  $("btn-busquedas").addEventListener("click", function () { renderBusquedas(); abrirOverlay("busquedas"); });
  $("btn-busq-cerrar").addEventListener("click", function () { cerrarOverlay("busquedas"); });
  $("busquedas").addEventListener("click", function (e) { if (e.target === $("busquedas")) cerrarOverlay("busquedas"); });
  // Botón "Guardar esta búsqueda" (dentro de los resultados) → pide nombre + celu
  $("btn-guardar-busq").addEventListener("click", function () {
    $("gb-nombre").value = ""; $("gb-tel").value = ""; $("gb-msg").textContent = "";
    // Pregunta de campaña: solo si la búsqueda salió de un link de RE/MAX (hay propiedad que vigilar).
    $("gb-campana").checked = false;
    $("gb-campana-wrap").style.display = window.__slugActual ? "flex" : "none";
    var dir = (window.__base && window.__base.direccion) || "";
    $("gb-dir").value = dir;
    // Si es un link de RE/MAX de archivo (sin dirección cargada), la traigo en vivo.
    if (!dir && window.__slugActual) {
      fetch(DET_EP + window.__slugActual).then(function (r) { return r.json(); }).then(function (d) {
        var det = d && d.data ? (d.data.data || d.data) : d;
        var da = det && det.displayAddress;
        if (da && !$("gb-dir").value) $("gb-dir").value = da;
      }).catch(function () {});
    }
    abrirOverlay("guardar-busq"); $("gb-nombre").focus();
  });
  $("btn-guardar-cambios").addEventListener("click", function () {
    guardarFiltrosEnCliente();
    $("hint").innerHTML = "✓ Cambios guardados en el cliente.";
    buscar();   // refresca (el botón se oculta porque ya no hay cambios)
  });
  $("btn-guardar-cerrar").addEventListener("click", function () { cerrarOverlay("guardar-busq"); });
  $("guardar-busq").addEventListener("click", function (e) { if (e.target === $("guardar-busq")) cerrarOverlay("guardar-busq"); });
  $("btn-guardar-ok").addEventListener("click", function () {
    var nombre = ($("gb-nombre").value || "").trim();
    var tel = ($("gb-tel").value || "").trim();
    var dir = ($("gb-dir").value || "").trim();
    if (!nombre) nombre = dir;   // sin nombre pero con dirección → la dirección es el nombre
    if (!nombre) { $("gb-msg").textContent = "Poné un nombre o una dirección para reconocerla."; return; }
    var quiereCamp = $("gb-campana").checked;
    guardarBusquedaActual(nombre, tel, dir, quiereCamp);
    if (quiereCamp && window.__slugActual) activarAvisos(true);   // pide permiso para avisarle
    cerrarOverlay("guardar-busq");
    renderBadge();
    buscar();   // refresca: muestra enviadas 📤 y descartadas 🔴
  });
}

// Dólar del día vía el motor (uy.dolarapi bloquea el pedido directo del navegador).
function actualizarDolar() {
  if (!MOTOR_URL) return;
  fetch(MOTOR_URL + (MOTOR_URL.indexOf("?") >= 0 ? "&" : "?") + "dolar=1")
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.rate && d.rate > 0) USD_RATE = d.rate; })
    .catch(function () {});
}
function cargar() {
  fetch("listings.json").then(function (r) { return r.json(); }).then(function (d) {
    DATA = d.listings || [];
    USD_RATE = d.usd_rate || null;
    actualizarDolar();   // pisa con el dólar del día (fresco) si el motor responde
    // Lista de barrios reales para el autocompletar (sin repetir, ordenados).
    var vistos = {};
    BARRIOS_ALL = [];
    DATA.forEach(function (c) {
      var b = (c.barrio || "").trim();
      if (b && !vistos[norm(b)]) { vistos[norm(b)] = 1; BARRIOS_ALL.push(b); }
    });
    BARRIOS_ALL.sort(function (a, b) { return norm(a) < norm(b) ? -1 : 1; });
    $("estado").textContent = "";
    renderBadge();   // numerito de parecidas nuevas + avisos de campaña en el 🔖
    chequearCampanas();   // vigila las propiedades en campaña (aviso al abrir)
    sincronizarPush();    // si ya dio permiso, actualiza la lista que vigila el robotito
    restaurarEstado();   // vuelve a mostrar lo último que estabas viendo
  }).catch(function () {
    $("estado").textContent = "No pude cargar las propiedades. Revisá la conexión y recargá.";
  });
}

initSegs();
cargar();
