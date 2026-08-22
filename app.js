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
// Link corto de RE/MAX (ej: remax.com.uy/940061113-30) = id interno → esta API lo resuelve.
var INT_EP = "https://api-ar.redremax.com/remaxweb-uy/api/listings/findByInternalId/";
var CDN = "https://d1acdg20u0pmxj.cloudfront.net/";

var DATA = [];        // propiedades
var BY_SLUG = {};     // índice slug → propiedad (O(1), se arma al cargar)
var USD_RATE = null;  // UYU por USD (del archivo)
// El archivo de datos NO guarda el link ni el prefijo de la foto (para pesar menos):
// se reconstruyen acá. Compatibles con archivos viejos: si ya viene el link/foto entera,
// se usa tal cual.
var REMAX_LISTING = "https://www.remax.com.uy/listings/";
var FOTO_CDN = "https://d1acdg20u0pmxj.cloudfront.net/";
function linkDe(c) { return (c && c.link) || (c && c.slug ? REMAX_LISTING + c.slug : ""); }
function fotoDe(c) {
  var f = (c && c.foto) || "";
  return !f ? "" : (/^https?:/i.test(f) ? f : FOTO_CDN + f);
}
var $ = function (id) { return document.getElementById(id); };

function norm(s) {
  return (s || "").normalize("NFC").toLowerCase()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n")
    .replace(/\s+/g, " ").trim();   // colapsa espacios dobles (barrios de otros portales)
}
function soloNum(s) {
  // Corta la parte decimal ("80,5" → 80) para que no se convierta en 805; el punto de
  // miles ("1.234.567") se saca igual. Precio/m²/dorm/baños se usan como enteros.
  var t = (s == null ? "" : String(s)).split(",")[0];
  var d = t.replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : null;
}
// Hectáreas en un texto → m² (1 ha = 10.000 m²). Entiende "3Ha", "5 has", "2 hectáreas".
// El lookahead (?![a-z]) evita agarrar "3 hab" (habitaciones) como hectáreas.
function hectareasM2(texto) {
  var m = norm(texto).match(/(\d+(?:[.,]\d+)?)\s*(hectareas?|has?)(?![a-z])/);
  if (!m) return null;
  var n = parseFloat(m[1].replace(",", "."));
  return (n > 0) ? Math.round(n * 10000) : null;
}
// Categorías finas. "Casa" y "Apto" son los grandes; el resto se agrupa bajo "Otros"
// (ver OTROS_CATS), que en la UI se despliega en Terreno/Chacra/Campo/Quinta/Local/…
function tipoCat(t) {
  t = norm(t);
  if (t.indexOf("departamento") >= 0 || t.indexOf("penthouse") >= 0 || t.indexOf("apart") >= 0 || t === "ph") return "apto";   // PH = apartamento
  if (t.indexOf("casa") >= 0) return "casa";
  if (t.indexOf("terreno") >= 0 || t.indexOf("lote") >= 0) return "terreno";
  if (t.indexOf("chacra") >= 0) return "chacra";
  if (t.indexOf("campo") >= 0) return "campo";
  if (t.indexOf("quinta") >= 0) return "quinta";
  if (t.indexOf("local") >= 0) return "local";
  if (t.indexOf("oficina") >= 0) return "oficina";
  if (t.indexOf("deposito") >= 0 || t.indexOf("galpon") >= 0 || t.indexOf("industrial") >= 0) return "deposito";
  if (t.indexOf("cochera") >= 0 || t.indexOf("garaje") >= 0) return "cochera";
  return "otro";   // edificio, hotel, consultorio, fondo de comercio, etc. = "Varios"
}
// Todo lo que NO es casa ni apto = "Otros" (incluye "otro" = Varios).
var OTROS_CATS = ["terreno", "chacra", "campo", "quinta", "local", "oficina", "deposito", "cochera", "otro"];
function esc(s) {   // blinda innerHTML contra caracteres raros en los datos de RE/MAX
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Grupo (lista de barrios normalizados) al que pertenece un barrio. Si no está en
// ningún grupo, el grupo es solo ese barrio.
var GRUPO_IDX = {};
// norm(barrio) → nombre "lindo" de la lista de barrios de RE/MAX (para reconocer un
// barrio válido aunque hoy no haya ninguna propiedad en él en el archivo del día).
var BARRIO_CANON = {};
(function () {
  (window.GRUPOS || []).forEach(function (g) {
    var ng = g.map(norm);
    ng.forEach(function (b) { GRUPO_IDX[b] = ng; });
    g.forEach(function (b) { BARRIO_CANON[norm(b)] = b; });
  });
})();
// APODOS de barrios: cómo los escriben OTROS portales (InfoCasas/ML) → nombre de RE/MAX.
// Solo se usa cuando el nombre no matchea directo. Se puede ampliar cuando aparezca uno
// que no engancha (clave en minúscula sin tildes; el valor tiene que ser un barrio real).
var ALIAS_BARRIO = {
  "pta carretas": "Punta Carretas", "punta carreta": "Punta Carretas",
  "pta gorda": "Punta Gorda",
  "pque batlle": "Parque Batlle", "parque batlle villa dolores": "Parque Batlle",
  "villa dolores": "Parque Batlle",
  "pque rodo": "Parque Rodó", "parque rodo": "Parque Rodó",
  "pocitos nuevo": "Pocitos", "pocitos wtc": "Pocitos", "wtc": "Pocitos",
  "cordon soho": "Cordón", "barrio sur": "Barrio Sur",
  "tres cruces": "Tres Cruces", "la comercial": "La Comercial",
  "prado nueva savona": "Prado", "aguada": "Aguada"
};
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

// Región para NO mezclar ciudades con barrios del mismo nombre (ej. "Centro" está en casi todas):
// Montevideo+Canelones cuentan como UNA sola ("metro", son pegados y comparten zona); cada otro
// departamento, el suyo. Vacío/desconocido = null → no filtra por región (búsqueda a mano).
function regionDe(depto) {
  var d = norm(depto || "");
  if (!d) return null;
  return (d === "montevideo" || d === "canelones") ? "metro" : d;
}
function leerFiltros() {
  // 1 barrio → su grupo (similares). 2+ → solo esos exactos. 0 → da igual.
  var grupo = SELBARRIOS.length === 1 ? grupoDe(SELBARRIOS[0])
            : (SELBARRIOS.length > 1 ? barriosSel() : null);
  var f = {
    operacion: segVal("f-oper"),                 // siempre 'sale' o 'rent'
    tipos: tiposSeleccionados(),                  // casa/apto/otros(expandido) (vacío = cualquiera)
    grupo: grupo,
    region: regionDe((window.__base && window.__base.depto) || ""),   // no mezclar ciudades (Mvd+Can = una)
    // 0 = "da igual" (NO filtra): el 1er toque del "+" cae en 0, y un TOPE de 0 (máx 0 dorms/
    // baños) dejaba 0 resultados en silencio (casi todo tiene 1+). Un MÍNIMO de 0 tampoco debe
    // excluir a los que no tienen el dato. Recién desde 1 filtra de verdad.
    dmin: stepVal("f-dmin") || null,
    dmax: stepVal("f-dmax") || null,
    bmin: stepVal("f-bmin") || null,   // baños (total = baño + toilet)
    bmax: stepVal("f-bmax") || null,
    precioMinUsd: precioAUsd(soloNum($("f-precio-min").value)),
    precioMaxUsd: precioAUsd(soloNum($("f-precio-max").value)),
    cubMin: soloNum($("f-cub-min").value),
    cubMax: soloNum($("f-cub-max").value),
    padronMin: soloNum($("f-padron-min").value),
    padronMax: soloNum($("f-padron-max").value),
    cochera: segVal("f-coch"),
    estado: segVal("f-estado"),
    rentaSel: segMulti("f-renta"),   // ["con"|"multi"|"sin"] (multi-select, OR)
    // Gastos comunes (en pesos): solo aplican al apartamento (ver gastosAplica). Se leen SOLO
    // cuando aplica; si no, el campo está oculto y no debe filtrar escondido (antes tapaba
    // casas y ventas de otros tipos).
    gastosMinUsd: gastosAplica() ? aUsd(soloNum($("f-gastos-min").value), "UYU") : null,
    gastosMaxUsd: gastosAplica() ? aUsd(soloNum($("f-gastos-max").value), "UYU") : null
  };
  // Mín > máx: en vez de dar "0 encontradas" sin explicar, se intercambian (era lo que
  // el usuario quiso: ese rango). Aplica a todos los pares mín/máx.
  [["precioMinUsd", "precioMaxUsd"], ["cubMin", "cubMax"], ["padronMin", "padronMax"],
   ["dmin", "dmax"], ["bmin", "bmax"], ["gastosMinUsd", "gastosMaxUsd"]].forEach(function (p) {
    var a = f[p[0]], b = f[p[1]];
    if (a != null && b != null && a > b) { f[p[0]] = b; f[p[1]] = a; }
  });
  return f;
}
// Tipos elegidos, expandiendo "Otros": sin sub-opción elegida = cualquier otro tipo;
// con sub-opciones = solo esas.
function tiposSeleccionados() {
  var sel = segMulti("f-tipo"), sub = segMulti("f-tipo-otros"), out = [];
  sel.forEach(function (v) { if (v !== "otros") out.push(v); });
  if (sel.indexOf("otros") >= 0) out = out.concat(sub.length ? sub : OTROS_CATS);
  return out;
}
// Muestra el desplegable de "Otros" solo cuando el botón Otros está prendido.
function toggleOtros() {
  $("f-tipo-otros").style.display = segMulti("f-tipo").indexOf("otros") >= 0 ? "" : "none";
}
// Setea el tipo desde un link: casa/apto van directos; el resto = "Otros" (+ su sub-tipo).
function setTipoFino(tc) {
  if (tc === "casa" || tc === "apto") {
    setSegMulti("f-tipo", [tc]); setSegMulti("f-tipo-otros", []);
  } else {
    setSegMulti("f-tipo", ["otros"]);
    setSegMulti("f-tipo-otros", OTROS_CATS.indexOf(tc) >= 0 && tc !== "otro" ? [tc] : []);
  }
  toggleOtros();
}
// Los gastos comunes son un gasto de EDIFICIO: los tiene el apartamento (o PH, que acá cuenta
// como apto), NO una casa — se venda o se alquile. Por eso el campo se muestra y filtra SOLO
// cuando está elegido "Apto" (una casa en alquiler no tiene gastos comunes).
function gastosAplica() {
  return segMulti("f-tipo").indexOf("apto") >= 0;
}
function toggleGastos() {
  $("f-gastos-wrap").style.display = gastosAplica() ? "" : "none";
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
  if (f.tipos.length && f.tipos.indexOf(c._tipoCat || tipoCat(c.tipo)) < 0) return false;
  if (f.grupo && f.grupo.indexOf(c._barrioN != null ? c._barrioN : norm(c.barrio)) < 0) return false;
  // No mezclar ciudades: si la búsqueda arrancó de una propiedad, solo su región (Mvd+Can = una).
  // Dato desconocido (c.depto vacío) NO excluye (indulgente).
  if (f.region && c.depto && regionDe(c.depto) !== f.region) return false;
  // dorm/baños: 0 = "da igual" (no filtra). Con !=null, un TOPE de 0 dejaba 0 resultados.
  if (f.dmin && (c.dorm == null || c.dorm < f.dmin)) return false;
  if (f.dmax && (c.dorm == null || c.dorm > f.dmax)) return false;
  if (f.bmin && (c.banos == null || c.banos < f.bmin)) return false;
  if (f.bmax && (c.banos == null || c.banos > f.bmax)) return false;
  if (f.precioMinUsd != null && (c.precio_usd == null || c.precio_usd < f.precioMinUsd)) return false;
  if (f.precioMaxUsd != null && (c.precio_usd == null || c.precio_usd > f.precioMaxUsd)) return false;
  if (f.cubMin != null && (c.m2_homog == null || c.m2_homog < f.cubMin)) return false;
  if (f.cubMax != null && (c.m2_homog == null || c.m2_homog > f.cubMax)) return false;
  // Padrón desconocido (0 = el robot no lo pudo leer) NO excluye; solo compara si hay valor real.
  if (f.padronMin != null && c.m2_padron && c.m2_padron < f.padronMin) return false;
  if (f.padronMax != null && c.m2_padron && c.m2_padron > f.padronMax) return false;
  // Cochera / Estado: dato DESCONOCIDO (null / "") NO excluye — solo si el valor conocido
  // contradice el filtro. Antes tiraba 78 props activas sin ese dato cargado, y como estado y
  // cochera se autocompletan al pegar un link, pegaba en casi toda búsqueda (indulgente, como gastos).
  if (f.cochera === "si" && c.cochera === false) return false;
  if (f.cochera === "no" && c.cochera === true) return false;
  if (f.estado && c.estado && c.estado !== f.estado) return false;
  // Renta / varias unidades (multi-select, OR): la propiedad pasa si cumple ALGUNA de
  // las opciones elegidas. Nada elegido = no filtra (da igual).
  if (f.rentaSel && f.rentaSel.length) {
    var okR = false;
    if (f.rentaSel.indexOf("con") >= 0 && c.renta === true) okR = true;
    if (f.rentaSel.indexOf("sin") >= 0 && c.renta === false) okR = true;
    if (f.rentaSel.indexOf("multi") >= 0 && c.multiunidad === true) okR = true;
    if (!okR) return false;
  }
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
  if (ref.barrios.length) p += w[1] * (ref.barrios.indexOf(c._barrioN != null ? c._barrioN : norm(c.barrio)) >= 0 ? 0 : 0.5);
  if (ref.tipos && ref.tipos.length && ref.tipos.indexOf(c._tipoCat || tipoCat(c.tipo)) < 0) p += w[2];
  if (ref.precio_usd && c.precio_usd)
    p += w[3] * Math.min(1, Math.abs(c.precio_usd - ref.precio_usd) / ref.precio_usd);
  if (ref.dorm != null && c.dorm != null)
    p += w[4] * Math.min(1, Math.abs(c.dorm - ref.dorm) / 3);
  if (ref.cochera != null && c.cochera != null && c.cochera !== ref.cochera) p += w[5];
  if (ref.estado && c.estado && c.estado !== ref.estado) p += w[6];
  return p;
}

function propPorSlug(slug) { return BY_SLUG[slug] || null; }
function filtrar(f, ref, slugActual) {
  var res = DATA.filter(function (c) { return pasa(c, f, slugActual); });
  // Se calcula el puntaje UNA sola vez por propiedad (antes el sort lo recomputaba
  // O(n·log n) veces). Los desempates quedan idénticos: 1º más nueva, 2º más barata.
  var dec = res.map(function (c) { return { c: c, p: puntaje(c, ref) }; });
  dec.sort(function (a, b) {
    var d = a.p - b.p;
    if (Math.abs(d) > 1e-9) return d;
    var va = a.c.visto_desde || "", vb = b.c.visto_desde || "";
    if (va !== vb) return va < vb ? 1 : -1;                          // fecha mayor (más nueva) arriba
    return (a.c.precio_usd || 1e12) - (b.c.precio_usd || 1e12);     // último desempate: más barata
  });
  return dec.map(function (x) { return x.c; });
}
// Se muestran TODAS las que cumplen el filtro (ordenadas por más parecida). Hay un tope
// alto solo por las dudas (búsquedas sin casi filtros); en la práctica los filtros duros
// dejan pocas. Antes era 10 y Juan quería ver todas.
var TOPE_RESULTADOS = 300;
function buscar() {
  toggleGastos();   // asegura que el campo de gastos comunes esté visible si es un apto
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
var RENDER_RES = []; // últimas parecidas dibujadas (para saber cuáles están ⭐ en campañas)
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
  var n = listaEnviar().length;
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
// ¿La búsqueda abierta es una campaña? (ahí conviven casilla ☑️ + valoración ⭐).
function esCampActiva() { var b = busquedaActiva(); return !!(b && b.campana); }
// Parecidas dibujadas marcadas como ⭐ "Para enviar" (para la campaña).
function estrellasCards() {
  var b = busquedaActiva(); if (!b) return [];
  return RENDER_RES.filter(function (c) { return valDe(b, c.slug) === "a_enviar"; });
}
// Qué se manda al tocar Enviar/Copiar: lo tildado ☑️; si no hay nada tildado y es una
// campaña, se mandan las ⭐ (pedido de Juan: las dos cosas, independientes).
function listaEnviar() { return SEL.length ? SEL : (esCampActiva() ? estrellasCards() : SEL); }
function textoSeleccionadas() {
  return listaEnviar().map(function (c, i) {
    return (i + 1) + ". " + resumen(c) + "\n" + linkAssoc(linkDe(c));
  }).join("\n\n");
}
// Enviar por WhatsApp: si hay cliente con número → abre su chat; si no → WhatsApp
// para elegir contacto. Y suma 1 en enviadas (marca las propiedades como enviadas).
function enviarSeleccionadas() {
  var lista = listaEnviar();
  if (!lista.length) return;
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
      lista.forEach(function (c) {
        if (bb.enviadas.indexOf(c.slug) < 0) bb.enviadas.push(c.slug);
        bb.estados[c.slug] = "enviada";           // queda marcada como enviada
      });
      bb.tandas = (bb.tandas || 0) + 1;
      bb.ultimoContacto = new Date().toISOString();      // enviar = contacto de hoy
      guardarBusquedas(arr); renderBadge(); buscar();   // refresca la lista (marca 📤)
    }
  }
}

// -------------------------- Estimador de alquiler --------------------------
// "¿Cuánto se puede alquilar la propiedad del link?" Usa los ALQUILERES parecidos del pool
// (mismo tipo/región, barrio exacto→zona si hay pocos, dorms ±1, m² homogeneizado ±25%).
// La franja NO es un ±% inventado: sale de la DISPERSIÓN REAL — percentil 25-75 del precio
// por m² de los comparables, × los m² de la propiedad. El número del medio (mediana) es la
// estimación principal. Validado leave-one-out contra 243 alquileres reales (ancho real ≈ ±14%,
// por eso el ±5% mentía). Solo aparece si hay una propiedad de referencia (link pegado).
function estimarAlquiler(base) {
  if (!base || !base.m2_homog) return null;
  var bt = tipoCat(base.tipo), bd = base.dorm, bm = base.m2_homog;
  var br = regionDe(base.depto), bb = norm(base.barrio), bg = grupoDe(base.barrio);
  function comps(mismoBarrio) {
    return DATA.filter(function (c) {
      if (c.operacion !== "rent" || !c.precio_usd || !c.m2_homog) return false;
      if (c.estado_pub && c.estado_pub !== "active") return false;      // reservada/negociación no
      if (tipoCat(c.tipo) !== bt) return false;
      if (br && c.depto && regionDe(c.depto) !== br) return false;      // no mezclar ciudades
      var cb = norm(c.barrio);
      if (mismoBarrio) { if (cb !== bb) return false; }
      else if (bg && bg.indexOf(cb) < 0) return false;                 // afloja: mismo grupo/zona
      if (bd != null && c.dorm != null && Math.abs(c.dorm - bd) > 1) return false;
      if (Math.abs(c.m2_homog - bm) / bm > 0.25) return false;         // m² ±25%
      return true;
    });
  }
  var lista = comps(true), zona = "el mismo barrio";
  if (lista.length < 5) { lista = comps(false); zona = "la zona"; }    // pocos exactos → amplío
  if (lista.length < 3) return { pocos: true, n: lista.length };        // muy pocos: no estimo
  var xm2 = lista.map(function (c) { return c.precio_usd / c.m2_homog; })
                 .sort(function (a, b) { return a - b; });
  function pctl(q) {
    var i = (xm2.length - 1) * q, lo = Math.floor(i), hi = Math.min(lo + 1, xm2.length - 1);
    return xm2[lo] + (xm2[hi] - xm2[lo]) * (i - lo);
  }
  return {
    n: lista.length, zona: zona,
    midUsd: Math.round(pctl(0.5) * bm),
    loUsd: Math.round(pctl(0.25) * bm),
    hiUsd: Math.round(pctl(0.75) * bm)
  };
}
function renderEstimAlquiler() {
  var el = $("alquiler-estim");
  if (!el) return;
  var e = estimarAlquiler(window.__base);
  if (!e) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  if (e.pocos) {
    el.innerHTML = '<div class="ea-tit">💰 Cuánto se puede alquilar</div>' +
      '<div class="ea-nota">Todavía no hay suficientes alquileres parecidos en la zona para estimar' +
      (e.n ? " (solo " + e.n + ")" : "") + '.</div>';
    return;
  }
  var money = function (usd) {
    return USD_RATE ? "$ " + fmtMiles(String(Math.round(usd * USD_RATE)))
                    : "U$S " + fmtMiles(String(usd));
  };
  var subUsd = USD_RATE ? ' <span class="ea-usd">· U$S ' + fmtMiles(String(e.midUsd)) + '</span>' : '';
  el.innerHTML =
    '<div class="ea-tit">💰 ¿Cuánto se puede alquilar? <span class="ea-est">estimado</span></div>' +
    '<div class="ea-mid">' + money(e.midUsd) + ' <span class="ea-mes">/ mes</span>' + subUsd + '</div>' +
    '<div class="ea-rango">Rango típico: ' + money(e.loUsd) + ' – ' + money(e.hiUsd) + '</div>' +
    '<div class="ea-nota">Según <b>' + e.n + '</b> alquileres parecidos en ' + e.zona + '.' +
    (e.zona === "la zona"
      ? ' <b class="ea-warn">Pocos en el barrio exacto; tomalo como referencia gruesa.</b>' : '') +
    '</div>';
}
function render(res, total, aflojados, fuera, yaNoEntra) {
  fuera = fuera || {}; yaNoEntra = yaNoEntra || {};
  var f = leerFiltros();
  var monBusq = (segVal("f-moneda") || "USD").toLowerCase();   // para avisar conversión de dólar
  SEL = []; CARDS = []; RENDER_RES = []; actualizarMulticopy();
  $("resultados").style.display = "";
  renderEstimAlquiler();   // "¿cuánto se alquila?" al final (el div va después de #cards) — con o sin resultados
  // Si la búsqueda ya está guardada (cliente activo), no ofrezco "Guardar" de nuevo;
  // pero si cambiaste algo, muestro "Guardar cambios".
  $("btn-guardar-busq").style.display = window.__busquedaActiva ? "none" : "";
  $("btn-guardar-cambios").style.display = (window.__busquedaActiva && filtrosCambiaron()) ? "" : "none";
  var cont = $("cards");
  if (!total) {
    $("cuenta").textContent = "0 encontradas";
    cont.innerHTML = '<div class="vacio">No hay parecidas con esos filtros. Probá aflojar alguno (dejalo vacío / “Da igual”).</div>';
    $("btn-mapa").style.display = "none";
    return;
  }
  // Botón del mapa: solo si al menos una parecida tiene ubicación (coordenadas).
  $("btn-mapa").style.display = res.some(function (c) { return c.lat != null; }) ? "" : "none";
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
  RENDER_RES = res;               // guardo lo dibujado (para saber las ⭐ de una campaña)
  actualizarMulticopy();          // refresca el contador (por si hay ⭐ y nada tildado)
  res.forEach(function (c) {                       // ya viene cortado al tope
    var card = document.createElement("div");
    card.className = "card";
    if (bAct) card.classList.add("val-" + valDe(bAct, c.slug));
    if (fuera[c.slug]) card.classList.add("fuera");
    // Columna izquierda: número (cuando está tildada) + tilde para seleccionar
    var col = document.createElement("div"); col.className = "card-col";
    var num = document.createElement("span"); num.className = "card-num"; num.style.display = "none";
    col.appendChild(num);
    // En una CAMPAÑA conviven las dos cosas (pedido de Juan): la valoración ⭐ para el
    // seguimiento Y la casillita ☑️ para elegir y enviar rápido. Se manda lo tildado;
    // si no tildaste nada, se mandan las ⭐ (ver listaEnviar()).
    var esCamp = bAct && bAct.campana;
    if (bAct && !esCamp) {
      // Cliente normal (no campaña): la ⭐ "Para enviar" ES la selección (sin casillero).
      if (valDe(bAct, c.slug) === "a_enviar") SEL.push(c);
    } else {
      // Sin cliente, o campaña: casillero para seleccionar y copiar/enviar.
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
    var _fu = fotoDe(c);
    var foto = _fu ? '<img class="foto" src="' + esc(_fu) + '" alt="" loading="lazy">'
                   : '<div class="foto ph">🏠</div>';
    var chips = [];
    if (c.m2_homog) chips.push(c.m2_homog + " m²");
    if (c.cochera === true) chips.push("🚗 cochera");
    if (c.estado === "a_estrenar") chips.push("a estrenar");
    if (c.renta === true) chips.push("con renta");
    // Aviso del dólar SOLO si esta propiedad está en otra moneda que la buscada (hubo conversión).
    var convChip = (USD_RATE && c.moneda && c.moneda.toLowerCase() !== monBusq)
      ? '<span class="chip conv">💱 al dólar ' + esc(String(USD_RATE).replace(".", ",")) + '</span>' : "";
    // Cartel "subida hace N días" (solo si el robot registró cuándo apareció y es reciente).
    var diasSubida = "";
    if (c.visto_desde) {
      var _dv = diasDesde(c.visto_desde);
      if (_dv >= 0 && _dv <= 30) {
        var _t = _dv === 0 ? "Subida hoy" : (_dv === 1 ? "Subida ayer" : "Subida hace " + _dv + " días");
        diasSubida = '<span class="subida-tag">🆕 ' + _t + '</span>';
      }
    }
    var link = document.createElement("a");
    link.className = "card-link"; link.href = linkDe(c); link.target = "_blank"; link.rel = "noopener";
    link.style.cssText = "display:flex;gap:11px;flex:1;min-width:0;align-items:center";
    link.innerHTML = foto +
      '<div class="info">' +
        '<div class="titulo-card">' + esc(resumenCard(c)) + '</div>' +
        diasSubida +
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
// Ubicación (coordenadas) de la propiedad de una búsqueda guardada: primero las que se
// guardaron con la búsqueda; si no, las de la propiedad en el archivo del día (BY_SLUG).
function ubicacionDe(b) {
  if (b && b.lat != null && b.lng != null) return { lat: b.lat, lng: b.lng };
  var p = b && BY_SLUG[b.slugActual || b.campSlug];
  if (p && p.lat != null && p.lng != null) return { lat: p.lat, lng: p.lng };
  // Sin slug (búsqueda guardada a mano): la busco por DIRECCIÓN en el listado (coords
  // exactas de RE/MAX). Cubre las propiedades activas guardadas sin pegar el link.
  if (b && b.direccion) {
    var nd = norm(b.direccion);
    var m = DATA.filter(function (c) { return c.lat != null && c.direccion && norm(c.direccion) === nd; })[0];
    if (m) return { lat: m.lat, lng: m.lng };
  }
  return null;
}
function mapsLink(u) { return "https://www.google.com/maps?q=" + u.lat + "," + u.lng; }
// Guarda las coords en las búsquedas viejas (que se guardaron antes de esta función),
// mientras la propiedad siga en el listado del día. Así sobreviven si después se reserva.
function backfillUbicaciones() {
  var arr = cargarBusquedas(), cambio = false;
  arr.forEach(function (b) {
    if ((b.lat == null || b.lng == null)) {
      var p = BY_SLUG[b.slugActual || b.campSlug];
      if (p && p.lat != null && p.lng != null) { b.lat = p.lat; b.lng = p.lng; cambio = true; }
    }
  });
  if (cambio) guardarBusquedas(arr);
}
// Copia un link de Google Maps con las coordenadas (al pegarlo en WhatsApp muestra el
// mapita). NO usa el texto de la dirección (que a veces sale con ceros de más). Si no hay
// coords guardadas (la prop ya salió del listado), las busca EN VIVO en RE/MAX por slug.
function copiarUbicacion(b, btn) {
  var u = ubicacionDe(b);
  if (u) { copiarTexto(mapsLink(u), btn, "📍"); return; }
  if (btn) btn.textContent = "…";
  var guardar = function (lat, lng) {
    var arr = cargarBusquedas(), bb = arr.filter(function (x) { return x.id === b.id; })[0];
    if (bb) { bb.lat = lat; bb.lng = lng; guardarBusquedas(arr); }   // guardo para la próxima
    copiarTexto(mapsLink({ lat: lat, lng: lng }), btn, "📍");
  };
  var fallar = function () { if (btn) btn.textContent = "📍"; alert("No pude encontrar la ubicación de esta propiedad."); };
  // Último recurso: geocodificar la dirección con OpenStreetMap → coords aproximadas.
  var porDireccion = function () {
    if (!b.direccion) { fallar(); return; }
    fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
          encodeURIComponent(b.direccion + ", Montevideo, Uruguay"))
      .then(function (r) { return r.json(); })
      .then(function (a) { if (a && a[0]) guardar(parseFloat(a[0].lat), parseFloat(a[0].lon)); else fallar(); })
      .catch(function () { if (btn) btn.textContent = "📍"; alert("No pude traer la ubicación. Revisá la conexión."); });
  };
  var slug = b && (b.slugActual || b.campSlug);
  if (slug) {   // de RE/MAX: coords exactas por slug
    fetch(DET_EP + encodeURIComponent(slug)).then(function (r) { return r.json(); })
      .then(function (d) {
        var det = d && d.data ? (d.data.data || d.data) : null;
        var lc = det && det.location && det.location.coordinates;
        if (lc && lc.length >= 2) guardar(lc[1], lc[0]); else porDireccion();
      })
      .catch(porDireccion);
  } else porDireccion();
}
function copiarSeleccionadas() {
  var n = listaEnviar().length;
  if (!n) return;
  copiarTexto(textoSeleccionadas(), $("btn-multicopy"), "📋 Copiar (" + n + ")");
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
  setTipoFino(tc);
  toggleGastos();   // si el link es un apto, mostrar gastos comunes (ya con el tipo puesto)
  // precio: sin mínimo (más barato sirve), máximo +15%. m²: ±25%.
  $("f-precio-min").value = "";
  $("f-precio-max").value = c.precio ? fmtMiles(String(Math.round(c.precio * 1.15))) : "";
  setRango("f-cub", c.m2_homog);
  setRango("f-padron", tc === "apto" ? 0 : c.m2_padron);   // aptos: sin padrón (RE/MAX no lo usa)
  SELBARRIOS = c.barrio ? [c.barrio] : [];   // 1 barrio → busca similares (su grupo)
  $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", c.dorm != null ? c.dorm : null);
  setStep("f-dmax", c.dorm != null ? c.dorm : null);
  setStep("f-bmin", c.banos != null ? c.banos : null);
  setStep("f-bmax", c.banos != null ? c.banos : null);
  setSeg("f-coch", c.cochera === true ? "si" : (c.cochera === false ? "no" : ""));
  setSeg("f-estado", c.estado || "");
  // Regla de Juan: si el link tiene renta → parecidas con renta; si no → sin renta.
  setSegMulti("f-renta", [c.renta ? "con" : "sin"]);
  window.__slugActual = c.slug || null;
  window.__base = c;                       // referencia para ordenar "más parecida" y mi link
  mostrarAgente(c);
  mostrarMiLink(c);
}
// Llena el formulario con lo que trajo el motorcito (InfoCasas / MercadoLibre).
// El barrio NO se autocompleta: los nombres de esos portales no coinciden con los
// de RE/MAX, así que Juan lo agrega a mano si quiere filtrar por zona.
function rellenarExterno(d) {
  setSeg("f-oper", d.operacion === "rent" ? "rent" : "sale");
  setSeg("f-moneda", (d.moneda || "").toUpperCase() === "UYU" ? "UYU" : "USD");
  var tc = tipoCat(d.tipo || "");
  setTipoFino(tc);
  toggleGastos();   // si el link es un apto, mostrar gastos comunes (ya con el tipo puesto)
  $("f-precio-min").value = "";
  $("f-precio-max").value = d.precio ? fmtMiles(String(Math.round(d.precio * 1.15))) : "";
  setRango("f-cub", d.m2_construidos);
  setRango("f-padron", tc === "apto" ? 0 : d.m2_totales);   // aptos: sin padrón (RE/MAX no lo usa)
  // Barrio: si el del portal coincide con un barrio de RE/MAX, lo cargo (1 barrio = su
  // grupo). Match contra los barrios del día Y contra la lista completa de RE/MAX
  // (BARRIO_CANON), así reconoce barrios válidos aunque hoy no haya props en ellos.
  SELBARRIOS = [];
  if (d.barrio) {
    var nb = norm(d.barrio);
    var match = BARRIOS_ALL.filter(function (b) { return norm(b) === nb; })[0]
             || BARRIO_CANON[nb]
             || ALIAS_BARRIO[nb];    // apodo de otro portal → nombre de RE/MAX
    if (match) SELBARRIOS = [match];
  }
  $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", d.dorm != null ? d.dorm : null);
  setStep("f-dmax", d.dorm != null ? d.dorm : null);
  setSeg("f-coch", d.cochera === true ? "si" : (d.cochera === false ? "no" : ""));
  setSeg("f-estado", d.estado || "");
  setSegMulti("f-renta", [d.renta ? "con" : "sin"]);
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
  mostrarMiLink(null);   // ...ni associate (el link con contacto es solo para RE/MAX)
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
// Botón "Copiar mi link + dirección": deja en el portapapeles el link de la propiedad CON el
// associate de Juan (así el cliente que entra por ese link queda a su nombre) + la dirección
// escrita. Solo para propiedades de RE/MAX (el associate no aplica a InfoCasas/MercadoLibre).
// Vive en el encabezado de la búsqueda —NO en la lista de guardadas— y aparece igual al abrir
// un cliente guardado (comparte el mismo lugar que el contacto del agente).
function mostrarMiLink(c) {
  var btn = $("btn-mi-link");
  if (!btn) return;
  var link = linkDe(c);
  var esRemax = !!link && link.indexOf("remax") >= 0;
  if (c && esRemax) {
    window.__miLinkProp = c;
    btn.textContent = "📋 Copiar mi link + dirección";
    btn.dataset.vuelve = "📋 Copiar mi link + dirección";
    btn.style.display = "";
  } else {
    window.__miLinkProp = null;
    btn.style.display = "none";
  }
}
function copiarMiLink() {
  var c = window.__miLinkProp;
  if (!c) return;
  var dir = (c.direccion || "").trim();
  var texto = (dir ? dir + "\n" : "") + linkAssoc(linkDe(c));
  copiarTexto(texto, $("btn-mi-link"),
    $("btn-mi-link").dataset.vuelve || "📋 Copiar mi link + dirección");
}
// Detección de renta consistente con el robot (título como señal dura + POS sobre título+desc,
// con supresor de marketing), para links EN VIVO que no están en el archivo del día. Antes acá
// se leía con un regex crudo solo del título (sobre/sub-detectaba y sesgaba toda la búsqueda).
var _RENTA_POS = /(con renta|c\/ ?renta|rentad[oa]s?|arrendad[oa]s?|ya alquilad|tiene renta|(actualmente|se encuentra|esta) alquilad|alquilad[oa]s? (hasta|desde|por|en|actualmente)|(todos|ambos|ambas|locales?|unidades?|apartamentos?)\W+(comerciales?\W+)?alquilad|\(alquilad|con inquilin|contrato de alquiler vigente)/;
var _RENTA_MKT = /(vivir|invertir|inversion|ideal|oportunidad|posibilidad|opcion)(\W+\w+){0,2}\W+con renta/;
var _RENTA_FUERTE = /alquilad|arrendad|rentad[oa]|con inquilin|contrato de alquiler|tiene renta/;
var _TITULO_MKT = /(ideal|invertir|inversion|vivir|oportunidad|para renta|posibilidad|opcion)/;
function rentaDeTexto(titulo, desc) {
  var tit = norm(titulo || ""), t = norm((titulo || "") + " " + (desc || ""));
  if (tit.indexOf("con renta") >= 0 && !_TITULO_MKT.test(tit)) return true;
  if (!_RENTA_POS.test(t)) return false;
  if (_RENTA_MKT.test(t) && !_RENTA_FUERTE.test(t)) return false;
  return true;
}
function fromDetalle(det, slug) {
  var tipo = (det.type || {}).value || "";
  var nt = norm(tipo);
  var esApto = nt.indexOf("departamento") >= 0 || nt === "ph" || nt.indexOf("penthouse") >= 0;
  var park = det.parkingSpaces;
  var conds = (det.conditions || []).map(function (x) { return norm(x && x.value); });
  var aEstrenar = conds.some(function (c) { return c.indexOf("estrenar") >= 0 || c.indexOf("construccion") >= 0; });
  // Coordenadas del mapa (RE/MAX: location.coordinates = [lng, lat]).
  var _lc = (det.location && det.location.coordinates) || null;
  // Superficie del padrón: RE/MAX INFLA la de los campos (ej. "3 ha" → dimensionLand
  // 300.000.000 m², basura). Si el texto dice hectáreas y el dato es 0 o absurdo, uso las
  // hectáreas del texto (× 10.000).
  var _land = Math.round(det.dimensionLand || 0);
  var _haM2 = hectareasM2((det.title || "") + " " + (det.description || ""));
  if (_haM2 && (_land <= 0 || _land > 5000000)) _land = _haM2;
  return {
    slug: slug,
    link: "https://www.remax.com.uy/listings/" + slug,
    lat: (_lc && _lc.length >= 2) ? _lc[1] : null,
    lng: (_lc && _lc.length >= 2) ? _lc[0] : null,
    tipo: tipo,
    operacion: (det.operation || {}).value || "",
    precio: det.price, moneda: (det.currency || {}).value || "",
    precio_usd: (det.currency || {}).value === "USD" ? (det.price ? Math.round(det.price) : null)
              : (USD_RATE && det.price ? Math.round(det.price / USD_RATE) : null),
    dorm: det.bedrooms,
    // Baños totales = baños + toilet (igual que el robot). El endpoint de detalle trae
    // bathrooms/toilets; si faltan los dos, queda null (no inventa un baño).
    banos: (det.bathrooms != null || det.toilets != null)
           ? ((det.bathrooms || 0) + (det.toilets || 0)) : null,
    direccion: det.displayAddress || "",
    // El barrio del DETALLE está en geo.label (NO en geoLabel, que solo existe en el
    // listado). Sin esto el barrio quedaba vacío en links en vivo (cortos/nuevos) y se
    // perdía el filtro de zona. Verificado contra la API real.
    barrio: ((det.geo || {}).label || "").split(",")[0].trim(),
    // Departamento = último tramo del geo.label (para la región: no mezclar ciudades).
    depto: (((det.geo || {}).label || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean).pop()) || "",
    m2_homog: homog(det.dimensionCovered, det.dimensionTotalBuilt, det.dimensionLand, esApto, det.dimensionSemicovered, det.dimensionUncovered),
    m2_padron: _land,
    cochera: (park != null) ? (park > 0) : null,
    estado: aEstrenar ? "a_estrenar" : "usada",
    estado_pub: (det.listingStatus || {}).value || "active",
    renta: rentaDeTexto(det.title, det.description),
    agente: (det.associate || {}).name || "",
    agente_tel: telAgente(det.associate)
  };
}
function traer() {
  var link = $("link").value.trim();
  var hint = $("hint");
  mostrarAgente(null);   // se reesconde; lo vuelven a mostrar rellenar/fromDetalle si hay agente
  mostrarMiLink(null);
  if (!link) { hint.textContent = "Pegá un link, o completá los datos a mano abajo."; return; }
  var esRemax = /remax\.com\.uy/i.test(link);
  var slug = slugDeLink(link);
  // Link corto de RE/MAX: el último tramo es el id interno (ej: 940061113-30), no un slug.
  var esIdInterno = esRemax && /^\d+-\d+$/.test(slug);
  // 1) ¿está en el archivo del día? (lo más rápido; solo si ya es un slug de texto)
  if (!esIdInterno) {
    var enArchivo = BY_SLUG[slug];
    if (enArchivo) { rellenar(enArchivo); hint.innerHTML = avisoTraido(); return; }
  }
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
  // 2) link de RE/MAX no incluido (o link corto): lo busco en vivo. El corto va por id
  //    interno; el largo, por slug. Los dos devuelven la ficha completa (con su slug real).
  hint.textContent = "Buscando la propiedad en RE/MAX…";
  var ep = esIdInterno ? (INT_EP + encodeURIComponent(slug)) : (DET_EP + slug);
  fetch(ep).then(function (r) { return r.json(); }).then(function (d) {
    var det = d && d.data ? (d.data.data || d.data) : d;
    if (!det || !det.slug) throw new Error("no");
    rellenar(fromDetalle(det, det.slug));   // usa el slug REAL de la ficha
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
// Migración 1 sola vez: las búsquedas guardadas ANTES del filtro renta-multi tenían
// `b.filtro.renta` ("con"/"sin") en vez de `b.filtro.rentaSel` []. Sin esto, pasa()
// ignora la renta en esas búsquedas → matchesDe/contadores/vigilancia cuentan de más.
function migrarBusquedas() {
  var arr = cargarBusquedas(), cambio = false;
  arr.forEach(function (b) {
    if (b.filtro && b.filtro.rentaSel == null) {
      b.filtro.rentaSel = b.filtro.renta ? [b.filtro.renta] : [];
      delete b.filtro.renta;
      cambio = true;
    }
  });
  if (cambio) guardarBusquedas(arr);
}

// Foto del formulario tal cual está, para poder reabrir la búsqueda idéntica.
function snapshotForm() {
  return {
    link: $("link").value,
    oper: segVal("f-oper"), moneda: segVal("f-moneda"), tipos: segMulti("f-tipo"),
    tiposOtros: segMulti("f-tipo-otros"),
    precioMin: $("f-precio-min").value, precioMax: $("f-precio-max").value,
    cubMin: $("f-cub-min").value, cubMax: $("f-cub-max").value,
    padronMin: $("f-padron-min").value, padronMax: $("f-padron-max").value,
    gastosMin: $("f-gastos-min").value, gastosMax: $("f-gastos-max").value,
    barrios: SELBARRIOS.slice(),
    dmin: stepVal("f-dmin") || null, dmax: stepVal("f-dmax") || null,
    bmin: stepVal("f-bmin") || null, bmax: stepVal("f-bmax") || null,
    coch: segVal("f-coch"), estado: segVal("f-estado"), rentaSel: segMulti("f-renta"),
    base: window.__base || null, slugActual: window.__slugActual || null
  };
}
function restoreForm(s) {
  $("link").value = s.link || "";
  setSeg("f-oper", s.oper || "sale");
  setSeg("f-moneda", s.moneda || (s.oper === "rent" ? "UYU" : "USD"));
  setSegMulti("f-tipo", s.tipos || []);
  setSegMulti("f-tipo-otros", s.tiposOtros || []); toggleOtros();
  $("f-precio-min").value = s.precioMin || ""; $("f-precio-max").value = s.precioMax || "";
  $("f-cub-min").value = s.cubMin || ""; $("f-cub-max").value = s.cubMax || "";
  $("f-padron-min").value = s.padronMin || ""; $("f-padron-max").value = s.padronMax || "";
  $("f-gastos-min").value = s.gastosMin || ""; $("f-gastos-max").value = s.gastosMax || "";
  toggleGastos();
  SELBARRIOS = (s.barrios || []).slice(); $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", s.dmin != null ? s.dmin : null);
  setStep("f-dmax", s.dmax != null ? s.dmax : null);
  setStep("f-bmin", s.bmin != null ? s.bmin : null);
  setStep("f-bmax", s.bmax != null ? s.bmax : null);
  setSeg("f-coch", s.coch || ""); setSeg("f-estado", s.estado || "");
  setSegMulti("f-renta", s.rentaSel || (s.renta ? [s.renta] : []));   // migra búsquedas viejas (s.renta string)
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
  // Coordenadas de la propiedad (para el botón "Copiar ubicación"): del link en vivo
  // (window.__base) o del archivo del día (BY_SLUG). Se guardan para que sobrevivan
  // aunque la propiedad se reserve y salga del listado.
  var _pb = window.__base || (slugActual ? BY_SLUG[slugActual] : null) || {};
  var b = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
    nombre: nombre, tel: tel, direccion: direccion || "", creada: new Date().toISOString(),
    form: snapshotForm(), filtro: f, slugActual: slugActual,
    lat: _pb.lat != null ? _pb.lat : null, lng: _pb.lng != null ? _pb.lng : null,
    vistas: matches.map(function (c) { return c.slug; }),   // lo que ya vio hoy
    campana: esCamp, campSlug: esCamp ? slugActual : null, campEstado: "", campAck: "",
    campHuella: esCamp ? huellaDe(_pb, _pb.visto_desde) : null
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
  window.__formBaseline = snapshotFiltros();   // recién guardado → sin cambios pendientes
  if (esCamp) chequearCampanas();   // arranca la vigilancia de esa propiedad ya
}

// Foto comparable del formulario: SOLO los filtros que Juan edita. Se sacan los campos
// derivados del link (base/slugActual), que se recalculan al re-dibujar y darían falsos
// "cambios". La valoración NO está acá (no es un filtro) → tocarla nunca marca cambio.
function snapshotFiltros() {
  var s = snapshotForm();
  delete s.base; delete s.slugActual;
  return JSON.stringify(s);
}
// ¿El formulario actual difiere de la foto de cuando se abrió/guardó el cliente?
// Compara contra __formBaseline (foto tomada al abrir), NO contra la foto guardada vieja:
// así las búsquedas guardadas antes de agregar filtros nuevos NO marcan "cambió" al abrir.
function filtrosCambiaron() {
  if (!busquedaActiva() || window.__formBaseline == null) return false;
  return snapshotFiltros() !== window.__formBaseline;
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
  window.__formBaseline = snapshotFiltros();   // recién guardado → ya no hay "cambios"
}
// Diálogo de 3 opciones: Guardar / Salir sin guardar / Cancelar. Llama a cb con
// "guardar" | "salir" | "cancelar". Cancelar = no hace nada (se queda donde está).
function preguntarGuardar(cb) {
  var ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;" +
    "display:flex;align-items:center;justify-content:center;padding:20px";
  var box = document.createElement("div");
  box.style.cssText = "background:#fff;color:#12203a;max-width:340px;width:100%;" +
    "border-radius:16px;padding:20px;box-shadow:0 12px 44px rgba(0,0,0,.32)";
  box.innerHTML = '<div style="font-weight:700;font-size:17px;margin-bottom:6px">Cambiaste los filtros</div>' +
    '<div style="color:#5a6b86;font-size:15px;margin-bottom:16px">¿Guardar los nuevos filtros de este cliente antes de salir?</div>';
  var fila = document.createElement("div");
  fila.style.cssText = "display:flex;flex-direction:column;gap:8px";
  function boton(txt, resp, estilo) {
    var b = document.createElement("button");
    b.textContent = txt;
    b.style.cssText = "padding:12px;border-radius:11px;border:0;font-size:15px;" +
      "font-weight:600;cursor:pointer;" + estilo;
    b.onclick = function () { if (ov.parentNode) document.body.removeChild(ov); cb(resp); };
    return b;
  }
  fila.appendChild(boton("💾 Guardar", "guardar", "background:#2563eb;color:#fff"));
  fila.appendChild(boton("Salir sin guardar", "salir", "background:#eef2f7;color:#12203a"));
  fila.appendChild(boton("Cancelar", "cancelar", "background:transparent;color:#5a6b86"));
  box.appendChild(fila); ov.appendChild(box);
  ov.addEventListener("click", function (e) {
    if (e.target === ov) { document.body.removeChild(ov); cb("cancelar"); }
  });
  document.body.appendChild(ov);
}
// Antes de salir de un cliente con filtros cambiados: preguntar si guardarlos (3 opciones).
function salirDeCliente(luego) {
  if (!filtrosCambiaron()) { luego(); return; }
  preguntarGuardar(function (resp) {
    if (resp === "cancelar") return;               // se queda donde está
    if (resp === "guardar") guardarFiltrosEnCliente();
    luego();                                        // guardar o salir → sale
  });
}

function abrirBusqueda(id) {
  var seguir = function () {
    var arr = cargarBusquedas();
    var b = null;
    arr.forEach(function (x) { if (x.id === id) b = x; });
    if (!b) return;
    restoreForm(b.form);
    window.__busquedaActiva = b.id;                               // cliente activo (para Enviar)
    window.__formBaseline = snapshotFiltros();                    // foto base: recién abierto = sin cambios
    window.__ultimaVista = null;                                  // baseline nuevo (no descarta al abrir)
    b.vistas = matchesDe(b).map(function (c) { return c.slug; });  // marca como visto → apaga el numerito
    if (b.recordarAt) b.recordAck = b.recordarAt;                 // lo abrió → apaga el destello del reloj
    guardarBusquedas(arr);
    cerrarOverlay("busquedas");
    buscar();
    // Contacto del agente también al abrir un cliente guardado: de la propiedad guardada
    // (window.__base) o, si no lo trae, del archivo del día por su slug. Antes solo se
    // mostraba al pegar el link fresco, no al reabrir el cliente.
    var _pAg = window.__base;
    if ((!_pAg || (!_pAg.agente && !_pAg.agente_tel)) && (b.slugActual || b.campSlug))
      _pAg = BY_SLUG[b.slugActual || b.campSlug] || _pAg;
    mostrarAgente(_pAg);
    mostrarMiLink(_pAg);
    renderBadge();
    sincronizarPush();   // ya viste esta búsqueda → el robotito no te re-avisa lo mismo
    $("resultados").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Si venías de otro cliente con filtros cambiados, ofrecer guardarlos (3 opciones).
  if (window.__busquedaActiva && window.__busquedaActiva !== id && filtrosCambiaron()) {
    preguntarGuardar(function (resp) {
      if (resp === "cancelar") return;                 // no abre la otra, se queda
      if (resp === "guardar") guardarFiltrosEnCliente();
      seguir();
    });
  } else {
    seguir();
  }
}

function borrarBusqueda(id) {
  var arr = cargarBusquedas().filter(function (x) { return x.id !== id; });
  guardarBusquedas(arr); renderBusquedas(); renderBadge();
  sincronizarPush();   // el robotito deja de vigilar la que borraste
}

// La foto de la propiedad en campaña (para el avatar de la ficha): la busca en DATA por
// slug. Si ya no está publicada (reservada/baja → sale del listado), devuelve null.
function fotoCampana(b) {
  var slug = b && (b.campSlug || b.slugActual);
  if (!slug) return null;
  var p = BY_SLUG[slug];
  return p ? (fotoDe(p) || null) : null;
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
    var item = document.createElement("div"); item.className = "busq-item";
    if (recordatorioVencidoSinAbrir(b)) item.className += " flash-reloj";   // destella hasta abrirlo

    // Una sola pasada por ficha: antes matchesDe(b) escaneaba las ~2800 propiedades
    // DOS veces por ficha (nuevas + sin evaluar). Ahora se recorre una vez y se sacan
    // los dos números. Resultado idéntico.
    var _m = matchesDe(b), _visto = {};
    (b.vistas || []).forEach(function (s) { _visto[s] = 1; });
    var nuev = 0, sinEval = 0;
    _m.forEach(function (c) {
      if (!_visto[c.slug]) nuev++;
      if (valDe(b, c.slug) === "sin_valorar") sinEval++;
    });

    // Avatar SOLO si está en campaña: la foto de la propiedad que publicita.
    if (b.campana) {
      var foto = fotoCampana(b);
      var av = document.createElement("div"); av.className = "bi-avatar";
      if (foto) { av.style.backgroundImage = "url('" + foto + "')"; }
      else { av.className += " sinfoto"; av.textContent = "📣"; }
      item.appendChild(av);
    }

    // Info (tocar en cualquier lado de acá = abre la búsqueda).
    var info = document.createElement("div"); info.className = "bi-info bi-clic";
    info.title = "Abrir búsqueda";
    info.onclick = function () { abrirBusqueda(b.id); };

    // Título: el nombre del cliente; si no hay, la dirección.
    var tieneNombre = !!(b.nombre && b.nombre.trim());
    var nom = document.createElement("div"); nom.className = "bi-nom";
    nom.textContent = tieneNombre ? b.nombre : (b.direccion || "Sin nombre");
    info.appendChild(nom);

    // Dirección debajo — SOLO si hay nombre (si no, ya es el título; no repetir).
    if (tieneNombre && b.direccion) {
      var dirEl = document.createElement("div"); dirEl.className = "bi-dir";
      dirEl.textContent = "📍 " + b.direccion;
      info.appendChild(dirEl);
    }

    // Fila de chips: nuevas · campaña · recordatorio · sin evaluar · notas.
    var row = document.createElement("div"); row.className = "bi-row";
    if (nuev > 0) {
      var nb = document.createElement("span"); nb.className = "bi-chip nuevas";
      nb.textContent = "🆕 " + nuev + " nueva" + (nuev === 1 ? "" : "s");
      row.appendChild(nb);
    }
    if (b.campana) {
      var alerta = campEnAlerta(b);
      var cp = document.createElement("span");
      cp.className = "bi-chip " + (alerta ? "alerta" : "camp");
      cp.textContent = alerta ? ("⚠️ " + etqCampana(b.campEstado)) : "📣 En campaña";
      row.appendChild(cp);
    }
    if (campBajaNueva(b)) {
      var bpc = document.createElement("span"); bpc.className = "bi-chip baja";
      bpc.textContent = "💸 Bajó a " + fmtPrecioApp(b.campBajaPrecio.a, b.campBajaPrecio.moneda);
      row.appendChild(bpc);
    }
    if (b.recordarAt) {                              // reloj cortito con lo que falta
      var d = diasDesde(b.recordarAt);
      var rc = document.createElement("span");
      rc.className = "bi-chip reloj" + (d >= 0 ? " tarde" : "");
      rc.textContent = d >= 0 ? "⏰ vencido" : ("⏰ " + (-d) + (d === -1 ? " día" : " días"));
      row.appendChild(rc);
    }
    // Sin evaluar (el círculo gris): parecidas que cumplen el filtro y siguen sin valorar
    // (ya calculado arriba en la pasada única).
    if (sinEval > 0) {
      var pe = document.createElement("span"); pe.className = "bi-chip pend";
      var dot = document.createElement("span"); dot.className = "bi-dot"; pe.appendChild(dot);
      pe.appendChild(document.createTextNode(" " + sinEval + " sin evaluar"));
      row.appendChild(pe);
    }
    // Notas: solo un 📝 para verlas (sin número).
    if (b.notas) {
      var nt = document.createElement("span"); nt.className = "bi-vernotas";
      nt.textContent = "📝"; nt.title = "Ver notas";
      nt.onclick = function (e) { e.stopPropagation(); abrirClienteEditor(b.id); };
      row.appendChild(nt);
    }
    if (row.children.length) info.appendChild(row);
    item.appendChild(info);

    // Acciones: (📍 ubicación) + editar + borrar (sin "Abrir" — tocar la ficha ya la abre).
    var acc = document.createElement("div"); acc.className = "bi-acc";
    // 📍 aparece si hay forma de ubicarla: coords, slug de RE/MAX, o dirección. Así también
    // las guardadas a mano (con dirección) y las que salieron del listado tienen el botón.
    if (ubicacionDe(b) || b.slugActual || b.campSlug || b.direccion) {
      var loc = document.createElement("button");
      loc.className = "bi-edit"; loc.textContent = "📍";
      loc.title = "Copiar ubicación (para pegar en WhatsApp)";
      loc.setAttribute("aria-label", "Copiar ubicación");
      loc.onclick = function (e) { e.stopPropagation(); copiarUbicacion(b, loc); };
      acc.appendChild(loc);
    }
    var edit = document.createElement("button");
    edit.className = "bi-edit" + (novedadVista("lapiz") ? "" : " nuevo");
    edit.textContent = "✎"; edit.title = "Notas y recordatorio";
    edit.setAttribute("aria-label", "Notas y recordatorio");
    edit.onclick = function () { abrirClienteEditor(b.id); };
    acc.appendChild(edit);
    var del = document.createElement("button"); del.className = "bi-del";
    del.textContent = "🗑"; del.title = "Borrar"; del.setAttribute("aria-label", "Borrar");
    del.onclick = function () {
      if (confirm("¿Borrar la búsqueda de " + (b.nombre || "este cliente") + "?")) borrarBusqueda(b.id);
    };
    acc.appendChild(del);
    item.appendChild(acc);

    cont.appendChild(item);
  });
}

// El numerito rojo en el 🔖 de arriba = total de nuevas en todas las búsquedas.
function renderBadge() {
  var nuevas = totalNuevas(), alertas = campAlertasNuevas().length + campBajasNuevas().length, el = $("busq-badge");
  // Dentro de la app: el ⚠️ MANDA. Si una propiedad en campaña cambió (reservada /
  // en negociación / ya no publicada), el dibujito es ⚠️ (tapa el número). Si no hay
  // alerta de campaña pero sí parecidas nuevas, va el número. Si no hay nada, se esconde.
  if (alertas > 0) { el.textContent = "⚠️"; el.style.display = ""; }
  else if (nuevas > 0) { el.textContent = nuevas > 99 ? "99+" : nuevas; el.style.display = ""; }
  else el.style.display = "none";
  // En el ícono de la app instalada el sistema SOLO permite un número (no un símbolo),
  // así que ahí va el total de novedades. Se refresca al abrir la app.
  try {
    var total = nuevas + alertas;
    if (total > 0 && navigator.setAppBadge) navigator.setAppBadge(total);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch (e) {}
}

// Cierra las notificaciones que quedaron colgadas en la bandeja del sistema. Si no se
// cierran, el sistema deja el "1" PEGADO en el ícono de la app aunque ya hayas visto la
// novedad adentro. Se llama al abrir la app y al volver a ella (Juan 2026-08-14).
function limpiarNotifsColgadas() {
  try {
    if (navigator.clearAppBadge) navigator.clearAppBadge();   // saca el "1" del ícono ya (renderBadge lo repone si hay algo real)
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg && reg.getNotifications) {
          reg.getNotifications().then(function (ns) {
            ns.forEach(function (n) { n.close(); });
          }).catch(function () {});
        }
      }).catch(function () {});
    }
  } catch (e) {}
}

// -------------------------- Campañas: vigilar propiedades publicitadas --------------------------
// Vigila SOLO al abrir la app (sin servidor no hay aviso con la app cerrada). Si una
// propiedad que Juan publicita pasa a reservada / en negociación / se baja, avisa.
function etqCampana(est) {
  return est === "reserved" ? "Reservada"
    : est === "negotiation" ? "En negociación"
    : est === "baja" ? "Ya no está publicada"
    : est === "republicada" ? "Se republicó (link nuevo)"
    : est === "finished" ? "Finalizada / vendida"
    : "Cambió de estado";
}
function estadoCampanaDe(d) {
  var det = d && d.data ? (d.data.data || d.data) : null;
  if (det && det.slug) return (det.listingStatus || {}).value || "active";
  // data null: "baja" SOLO si RE/MAX confirma que no existe (mensaje explícito). Si es
  // una respuesta rara/vacía (hipo), devuelve null = no cambiar (evita falsa "baja").
  var msg = String((d && d.message) || "");
  if (d && d.data === null && /no se encuentra propiedad/i.test(msg)) return "baja";
  return null;
}
function campEnAlerta(b) { return b.campana && b.campEstado && b.campEstado !== "active"; }
function campAlertas() { return cargarBusquedas().filter(campEnAlerta); }
// Avisos que Juan todavía NO reconoció con "Entendido" (los que cuentan para el numerito).
function campAlertasNuevas() {
  return campAlertas().filter(function (b) { return b.campEstado !== b.campAck; });
}
// Bajó de precio: aviso pendiente si el último "a" no fue reconocido con "Entendido".
function campBajaNueva(b) { return !!(b.campana && b.campBajaPrecio && b.campBajaPrecio.a !== b.campBajaAck); }
function campBajasNuevas() { return cargarBusquedas().filter(campBajaNueva); }
function fmtPrecioApp(n, moneda) {
  var s = new Intl.NumberFormat("es-UY").format(Math.round(n));
  return ((moneda || "").toUpperCase() === "UYU" ? "$U " : "USD ") + s;
}
// --- Huella: reconocer la MISMA propiedad aunque le cambien el link (republicación) ---
// Se guarda al crear la campaña. Si el link viejo desaparece, con la huella buscamos un link
// NUEVO que sea la misma propiedad, en vez de darla por "baja" a ciegas.
function huellaDe(prop, desde) {
  if (!prop) return null;
  return {
    tipo: prop._tipoCat || tipoCat(prop.tipo || ""),
    agente: norm(prop.agente || ""),
    direccionN: norm(prop.direccion || ""),
    m2: prop.m2_homog || null,
    dorm: (prop.dorm != null) ? prop.dorm : null,
    lat: (prop.lat != null) ? prop.lat : null,
    lng: (prop.lng != null) ? prop.lng : null,
    // Desde cuándo la seguimos (fecha). Para APTOS es clave: un link cuya 1ª aparición
    // (visto_desde) es ANTERIOR a esto ya estaba = es OTRA unidad del edificio, no ésta.
    desde: String(desde || new Date().toISOString()).slice(0, 10)
  };
}
// Misma ubicación (mismo punto/edificio): por coordenadas si las hay (~60 m), si no por dirección.
function _mismaUbic(c, h) {
  if (h.lat != null && h.lng != null && c.lat != null && c.lng != null)
    return Math.abs(c.lat - h.lat) < 0.0006 && Math.abs(c.lng - h.lng) < 0.0006;
  return !!h.direccionN && norm(c.direccion || "") === h.direccionN;
}
// Candidatos a ser la misma propiedad: mismo tipo, mismo agente, mismos dormitorios,
// m² parecido (±12%) y misma ubicación.
function _candidatosHuella(h, viejoSlug) {
  return DATA.filter(function (c) {
    if (c.slug === viejoSlug) return false;
    if ((c._tipoCat || tipoCat(c.tipo)) !== h.tipo) return false;
    if (h.agente && norm(c.agente || "") !== h.agente) return false;
    if (h.dorm != null && c.dorm != null && c.dorm !== h.dorm) return false;
    if (h.m2 && c.m2_homog && Math.abs(c.m2_homog - h.m2) / h.m2 > 0.12) return false;
    return _mismaUbic(c, h);
  });
}
// La propiedad republicada (link nuevo) o null si no se puede AFIRMAR. Probado contra los
// datos reales: 0% de falsos positivos en casas y aptos (no confunde unidades del mismo
// edificio ni casas parecidas de la zona del mismo agente).
function buscarRepublicada(b) {
  var h = b.campHuella;
  if (!h || !DATA.length) return null;
  if (!h.agente && !h.m2) return null;   // sin señal fuerte (agente o m²) no arriesgo
  var cs = _candidatosHuella(h, b.campSlug || b.slugActual);
  if (!cs.length) return null;
  // La republicación es un link NUEVO (1ª aparición >= desde que la seguimos) y ÚNICO. Los que
  // "ya estaban" se descartan; si hay más de uno nuevo, no adivino (queda en "ya no está").
  var frescos = cs.filter(function (c) { return c.visto_desde && c.visto_desde >= h.desde; });
  return frescos.length === 1 ? frescos[0] : null;
}
// Chequea en vivo el estado de cada propiedad en campaña; al terminar, repinta los avisos.
function chequearCampanas() {
  var arr = cargarBusquedas();
  var pend = arr.filter(function (b) { return b.campana && (b.campSlug || b.slugActual); });
  if (!pend.length) { pintarBanner(); return; }
  var falta = pend.length;
  var fin = function () {
    if (--falta > 0) return;
    // Releer FRESCO y aplicar SOLO los campos de campaña por id. Así, si el usuario
    // editó algo (nota, recordatorio, valoración, guardó otra búsqueda) mientras
    // esperábamos la red, no se lo pisamos con el 'arr' viejo que retuvimos.
    var fresco = cargarBusquedas();
    pend.forEach(function (b) {
      var f = fresco.filter(function (x) { return x.id === b.id; })[0];
      if (!f) return;
      f.campEstado = b.campEstado;
      f.campPrecio = b.campPrecio; f.campMoneda = b.campMoneda;
      if (b.campPrecioUsd != null) f.campPrecioUsd = b.campPrecioUsd;
      if (b.campHuella) f.campHuella = b.campHuella;
      if (b.campBajaPrecio) f.campBajaPrecio = b.campBajaPrecio;
      if (b.campReSlug) { f.campReSlug = b.campReSlug; f.campRePrecioUsd = b.campRePrecioUsd; }
    });
    guardarBusquedas(fresco);
    pintarBanner(); renderBadge();
    if ($("busquedas").style.display === "flex") renderBusquedas();
  };
  pend.forEach(function (b) {
    var slug = b.campSlug || b.slugActual;
    // Huella para campañas viejas (creadas antes de esto): si sigue en el archivo, la tomo.
    if (!b.campHuella && BY_SLUG[slug]) b.campHuella = huellaDe(BY_SLUG[slug], BY_SLUG[slug].visto_desde);
    fetch(DET_EP + slug).then(function (r) { return r.json(); })
      .then(function (d) {
        var _est = estadoCampanaDe(d);
        if (_est === "baja") {
          // "Desapareció" el link: ¿la REPUBLICARON con otro? (misma huella, link nuevo y único).
          var re = buscarRepublicada(b);
          if (re) {
            b.campEstado = "republicada";
            b.campReSlug = re.slug;
            b.campRePrecioUsd = (re.precio_usd != null) ? re.precio_usd : null;
          } else { b.campEstado = "baja"; }
        } else if (_est) { b.campEstado = _est; }   // ambiguo (null) → no cambio el estado
        // Bajó de precio (aunque siga activa). Primera vez: solo registra, no avisa.
        var det = d && d.data ? (d.data.data || d.data) : null;
        var pr = det && typeof det.price === "number" ? det.price : null;
        var mo = det && det.currency ? (det.currency.value || "") : "";
        if (pr != null) {
          if (b.campPrecio != null && b.campMoneda === mo && pr < b.campPrecio) {
            b.campBajaPrecio = { de: b.campPrecio, a: pr, moneda: mo };
          }
          b.campPrecio = pr; b.campMoneda = mo;
          b.campPrecioUsd = (mo === "USD") ? pr : (USD_RATE ? Math.round(pr / USD_RATE) : (b.campPrecioUsd || null));
        }
        fin();
      })
      .catch(function () { fin(); });   // error de red: dejo lo conocido como estaba
  });
}
// Cartel rojo arriba (solo con avisos que todavía no reconoció).
function pintarBanner() {
  var al = campAlertasNuevas();
  var baj = campBajasNuevas();
  var box = $("camp-banner");
  if (!al.length && !baj.length) { box.style.display = "none"; return; }
  var lista = $("cb-lista"); lista.innerHTML = "";
  al.forEach(function (b) {
    var d = document.createElement("div"); d.className = "cb-item";
    var quien = b.direccion || b.nombre || "Una propiedad";
    if (b.campEstado === "republicada" && b.campReSlug) {
      var masBarata = (b.campRePrecioUsd != null && b.campPrecioUsd != null && b.campRePrecioUsd < b.campPrecioUsd)
        ? " 💸 y más barata" : "";
      d.innerHTML = "🔁 " + esc(quien) + " → <b>parece republicada con otro link</b>" + masBarata +
        ' — <a href="' + esc(REMAX_LISTING + b.campReSlug) + '" target="_blank" rel="noopener">ver el aviso nuevo</a>';
    } else {
      d.innerHTML = "📣 " + esc(quien) + " → <b>" + esc(etqCampana(b.campEstado)) + "</b>";
    }
    lista.appendChild(d);
  });
  baj.forEach(function (b) {
    var d = document.createElement("div"); d.className = "cb-item";
    var quien = b.direccion || b.nombre || "Una propiedad";
    d.innerHTML = "💸 " + esc(quien) + " → <b>bajó a " + esc(fmtPrecioApp(b.campBajaPrecio.a, b.campBajaPrecio.moneda)) + "</b>";
    lista.appendChild(d);
  });
  box.style.display = "";
}
// "Entendido": deja de insistir con ESTE estado (pero el ⚠️ sigue en el menú 🔖).
function ackCampanas() {
  var arr = cargarBusquedas();
  arr.forEach(function (b) {
    if (campEnAlerta(b)) b.campAck = b.campEstado;
    if (b.campBajaPrecio) b.campBajaAck = b.campBajaPrecio.a;   // baja reconocida
  });
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
// Las búsquedas guardadas a vigilar (parecidas nuevas) con la app cerrada. Manda el
// filtro ya masticado + lo ya visto (para que el robotito no re-avise lo mismo).
function busquedasParaVigilar() {
  return cargarBusquedas().map(function (b) {
    return {
      id: b.id, nombre: b.nombre || b.direccion || "un cliente",
      filtro: b.filtro || null, slugActual: b.slugActual || null,
      vistas: (b.vistas || [])
    };
  }).filter(function (x) { return x.filtro; });
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
        campanas: slugsEnCampana(),
        busquedas: busquedasParaVigilar()
      })
    });
  } catch (e) {}
}
function pintarEstadoAvisos() {
  var el = $("avisos-estado"); if (!el) return;
  var btnProbar = $("btn-probar-aviso");
  var btnAct = $("btn-activar-avisos");
  if (!pushSoportado()) {
    el.textContent = "Este celu/navegador no soporta avisos.";
    if (btnProbar) btnProbar.style.display = "none";
    return;
  }
  var p = Notification.permission;
  var activo = p === "granted";
  el.textContent = activo ? "Ya no tenés que volver a activarlo: queda prendido."
    : p === "denied" ? "Los avisos están bloqueados en este celu. Activalos en los ajustes del navegador."
    : "Los avisos están apagados.";
  if (btnAct) {   // el botón muestra claro si ya está activado
    btnAct.textContent = activo ? "✓ Avisos activados" : "Activar avisos";
    btnAct.classList.toggle("btn-activado", activo);
  }
  if (btnProbar) btnProbar.style.display = activo ? "" : "none";
}
// Manda un aviso de prueba a ESTE celu para confirmar que llega de verdad.
async function probarAviso() {
  var el = $("avisos-estado");
  if (Notification.permission !== "granted") { await activarAvisos(true); }
  if (Notification.permission !== "granted") { pintarEstadoAvisos(); return; }
  el.textContent = "Mandando prueba…";
  try {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) { await activarAvisos(true); sub = await reg.pushManager.getSubscription(); }
    if (!sub) { el.textContent = "No pude suscribir este celu."; return; }
    await sincronizarPush(sub);
    var r = await fetch(MOTOR_URL + (MOTOR_URL.indexOf("?") >= 0 ? "&" : "?") +
      "testpush=1&ep=" + encodeURIComponent(sub.endpoint));
    var d = await r.json();
    el.textContent = (d && d.ok) ? "✓ Aviso enviado. Debería aparecerte en unos segundos."
      : "No salió la prueba (código " + ((d && d.status) || "?") + ").";
  } catch (e) { el.textContent = "No pude mandar la prueba."; }
}

function abrirOverlay(id) { $(id).style.display = "flex"; }
function cerrarOverlay(id) { $(id).style.display = "none"; }

// -------------------------- Novedades (cartel 1 vez + resaltado amarillo) --------------------------
function novedadVista(k) { try { return localStorage.getItem("parecidas_nv_" + k) === "1"; } catch (e) { return true; } }
function marcarNovedad(k) { try { localStorage.setItem("parecidas_nv_" + k, "1"); } catch (e) {} }
// ¿Primera vez ABSOLUTA en la app? = localStorage sin ninguna huella de uso previo.
function esPrimeraVezEnLaApp() {
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i) || "";
      if (k.indexOf("parecidas_") === 0 && k !== "parecidas_nv_iniciado") return false;
    }
    return true;
  } catch (e) { return false; }
}
function pintarMarcaNueva() {
  $("marca").classList.toggle("nuevo", !novedadVista("marca"));
}
// ⚙️ en amarillo hasta que active los avisos (apunta a dónde activarlos). Si ya los
// activó, no hace falta el amarillo.
function pintarAjustesNuevo() {
  var pend = !novedadVista("ajustes-nv") &&
    (!("Notification" in window) || Notification.permission !== "granted");
  $("btn-ajustes").classList.toggle("nuevo", pend);
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
  window.__formBaseline = snapshotFiltros();   // foto base tras recargar: sin cambios falsos
  buscar();
}
// Tocar "Parecidas" = borrar lo que se está viendo (form + resultados + memoria).
function limpiarTodo() {
  try { localStorage.removeItem(ESTADO_KEY); } catch (e) {}
  $("link").value = "";
  setSeg("f-oper", "sale"); setSeg("f-moneda", "USD");
  setSegMulti("f-tipo", []); setSegMulti("f-tipo-otros", []); toggleOtros();
  ["f-precio-min", "f-precio-max", "f-cub-min", "f-cub-max", "f-padron-min", "f-padron-max",
   "f-gastos-min", "f-gastos-max"]
    .forEach(function (id) { $(id).value = ""; });
  SELBARRIOS = []; $("f-barrio").value = ""; renderChips(); pintarGrupo();
  setStep("f-dmin", null); setStep("f-dmax", null);
  setStep("f-bmin", null); setStep("f-bmax", null);
  setSeg("f-coch", ""); setSeg("f-estado", ""); setSegMulti("f-renta", []); toggleGastos();
  window.__base = null; window.__slugActual = null; window.__busquedaActiva = null;
  window.__formBaseline = null;   // sin cliente abierto → no hay "cambios" que preguntar
  window.__ultimaVista = null;
  SEL = []; CARDS = []; RENDER_RES = []; actualizarMulticopy();
  $("cards").innerHTML = ""; $("resultados").style.display = "none"; $("hint").innerHTML = "";
  mostrarAgente(null);
  mostrarMiLink(null);
}

// -------------------------- Notas + recordatorio por cliente --------------------------
function diasDesde(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
// Cartel "datos viejos": si el archivo se armó hace más de 3 días, el robot diario
// probablemente esté caído → avisar en la app (el robot corre todos los días).
function avisarDatosViejos(generadoAt) {
  var dias = generadoAt ? diasDesde(generadoAt) : null;
  var el = $("datos-viejos");
  if (!el) return;
  if (dias != null && dias > 3) { $("datos-dias").textContent = dias; el.style.display = ""; }
  else el.style.display = "none";
}
// Fecha de los datos, SIEMPRE visible abajo (así se sabe de cuándo es lo que se está viendo).
// generado_at viene como "AAAA-MM-DD". Se muestra dd/mm/aaaa + "hoy / ayer / hace N días".
function mostrarFechaDatos(generadoAt) {
  var el = $("datos-fecha");
  if (!el) return;
  if (!generadoAt) { el.textContent = ""; return; }
  var p = String(generadoAt).slice(0, 10).split("-");   // ["2026","08","15"]
  var fecha = p.length >= 3 ? (+p[2] + "/" + +p[1] + "/" + p[0]) : String(generadoAt);
  var dias = diasDesde(generadoAt);
  var cuando = dias === 0 ? "hoy" : (dias === 1 ? "ayer"
             : (dias != null && dias > 1 ? "hace " + dias + " días" : ""));
  el.innerHTML = "📅 Datos actualizados: <b>" + fecha + "</b>" + (cuando ? " (" + cuando + ")" : "");
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
  apagarDestelloReloj(id);  // tocar ✎/📝 también cuenta como "lo vio" → apaga el destello
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
  else {
    b.campana = true; b.campSlug = slug; b.campEstado = ""; b.campAck = "";
    var _ph = BY_SLUG[slug] || window.__base || {};
    b.campHuella = huellaDe(_ph, _ph.visto_desde);
  }
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
// El recordatorio venció (llegó/pasó la fecha) y Juan NO abrió el cliente desde entonces:
// mientras esté así, el card destella. Al abrirlo se marca recordAck y deja de destellar.
function recordatorioVencidoSinAbrir(b) {
  return !!(b && b.recordarAt && diasDesde(b.recordarAt) >= 0 && b.recordAck !== b.recordarAt);
}
// Apaga el destello (lo tocó = lo vio). Guarda recordAck = la fecha vencida actual.
function apagarDestelloReloj(id) {
  var arr = cargarBusquedas(), cambio = false;
  arr.forEach(function (x) {
    if (x.id === id && x.recordarAt && x.recordAck !== x.recordarAt) { x.recordAck = x.recordarAt; cambio = true; }
  });
  if (cambio) guardarBusquedas(arr);
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

function valDe(busq, slug) {
  var v = (busq && busq.estados && busq.estados[slug]) || "sin_valorar";
  // Si quedó guardado un estado de una versión vieja que ya no existe, no romper:
  // tratarlo como "sin valorar" (evita que VAL_ESTADOS[v] sea undefined y crashee el render).
  return VAL_ESTADOS[v] ? v : "sin_valorar";
}
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
// -------------------------- Mapa de las parecidas (Leaflet) --------------------------
var MAPA = null;
// Carga Leaflet (CSS + JS) la primera vez que se abre el mapa (no pesa en el arranque).
function cargarLeaflet(cb) {
  if (window.L) { cb(); return; }
  var css = document.createElement("link");
  css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(css);
  var js = document.createElement("script");
  js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  js.onload = cb;
  js.onerror = function () { cerrarMapa(); alert("No pude cargar el mapa. Revisá la conexión."); };
  document.head.appendChild(js);
}
var MAPA_RES = [];   // las parecidas que van al mapa (con coords)
// Filtro del mapa por ESTADO de valoración. Default: solo "sin valorar". Los estados que
// NO están acá (los descartes 🔴) NUNCA se muestran.
var MAPA_VF = { sin_valorar: true, a_enviar: false, enviada: false, favorita: false, pendiente: false };
// Marcador "gota invertida" con el ícono de la valoración adentro (⭐/💚/📤/⏳).
function iconoMapa(emoji) {
  return L.divIcon({
    className: "pin-wrap",
    html: '<div class="pin-gota"><span>' + (emoji || "") + '</span></div>',
    iconSize: [30, 40], iconAnchor: [15, 38], popupAnchor: [0, -36]
  });
}
// Marcador CASA 🏠 para la propiedad del link pegado (la referencia).
function iconoBase() {
  return L.divIcon({
    className: "pin-wrap",
    html: '<div class="pin-gota pin-base"><span>🏠</span></div>',
    iconSize: [38, 50], iconAnchor: [19, 48], popupAnchor: [0, -46]
  });
}
function abrirMapa() {
  // Lo MISMO que se ve en la lista: las que cumplen el filtro + las preservadas
  // (favoritas/⭐ que ya no cumplen pero se muestran). Así el mapa no muestra de menos.
  var f = leerFiltros(), ref = refDeBusqueda();
  var res = filtrar(f, ref, window.__slugActual || null);
  var vistos = {}; res.forEach(function (c) { vistos[c.slug] = 1; });
  (RENDER_RES || []).forEach(function (c) { if (!vistos[c.slug]) { res.push(c); vistos[c.slug] = 1; } });
  MAPA_RES = res.filter(function (c) { return c.lat != null && c.lng != null; });
  if (!MAPA_RES.length) { alert("Estas parecidas todavía no tienen ubicación en el mapa."); return; }
  var b = busquedaActiva();
  $("mapa-valfiltro").style.display = b ? "flex" : "none";   // filtro solo con cliente abierto
  if (b) $("mapa-valfiltro").querySelectorAll(".mv-chip").forEach(function (ch) {
    ch.setAttribute("aria-pressed", MAPA_VF[ch.getAttribute("data-v")] ? "true" : "false");
  });
  $("mapa-overlay").style.display = "flex";
  cargarLeaflet(function () {
    if (!MAPA) {
      MAPA = L.map("mapa");
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(MAPA);
      MAPA._grupo = L.layerGroup().addTo(MAPA);
    }
    pintarMapa();
    setTimeout(function () { MAPA.invalidateSize(); }, 120);   // el mapa arrancó oculto
  });
}
// Dibuja los marcadores según el filtro de valoración. Los que están en el MISMO punto
// (mismo edificio) se separan un poquito para que se vean todos (antes se tapaban).
function pintarMapa() {
  if (!MAPA) return;
  var b = busquedaActiva();
  var lista = MAPA_RES.filter(function (c) {
    if (!b) return true;                       // sin cliente: todas
    return !!MAPA_VF[valDe(b, c.slug)];        // solo los estados prendidos; descartes NUNCA
  });
  MAPA._grupo.clearLayers();
  var pts = [], usados = {};
  lista.forEach(function (c) {
    var lat = c.lat, lng = c.lng, k = lat.toFixed(5) + "," + lng.toFixed(5);
    if (usados[k]) { var n = usados[k]++; lat += (n % 3 - 1) * 0.00012; lng += (Math.floor(n / 3) - 1) * 0.00012; }
    else usados[k] = 1;
    var emoji = b ? (VAL_ESTADOS[valDe(b, c.slug)] || {}).icono : "";
    if (emoji === "⚪") emoji = "";            // "sin valorar": gota vacía (el ⚪ no se vería)
    var precio = fmtK(c.precio, c.moneda);
    var m = L.marker([lat, lng], { icon: iconoMapa(emoji) }).bindPopup(
      '<b>' + esc(resumenCard(c)) + '</b><br>' +
      (precio ? esc(precio) + '<br>' : '') +
      '<a href="' + esc(linkDe(c)) + '" target="_blank" rel="noopener">Ver aviso</a>');
    MAPA._grupo.addLayer(m); pts.push([lat, lng]);
  });
  // La propiedad de referencia (el link pegado / la del cliente): marcador CASA 🏠, siempre
  // visible. Las coordenadas salen de window.__base (link recién pegado) o, si se está
  // viendo un cliente guardado, de las coordenadas guardadas del cliente (b.lat/b.lng): en
  // clientes viejos el __base restaurado no las tenía y la casa no aparecía.
  var base = window.__base;
  var blat = (base && base.lat != null) ? base.lat : (b && b.lat != null ? b.lat : null);
  var blng = (base && base.lng != null) ? base.lng : (b && b.lng != null ? b.lng : null);
  if (blat != null && blng != null) {
    var dirBase = (base && base.direccion) || (b && b.direccion) || "";
    var mb = L.marker([blat, blng], { icon: iconoBase(), zIndexOffset: 1000 })
      .bindPopup('<b>🏠 La propiedad de referencia</b>' + (dirBase ? '<br>' + esc(dirBase) : ''));
    MAPA._grupo.addLayer(mb); pts.push([blat, blng]);
  }
  $("mapa-titulo").textContent = "Parecidas en el mapa (" + lista.length + ")";
  if (pts.length) MAPA.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
}
function cerrarMapa() { $("mapa-overlay").style.display = "none"; }

function initSegs() {
  ["f-oper", "f-coch", "f-estado", "f-moneda"].forEach(function (id) {   // una sola opción
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
  ["f-tipo", "f-tipo-otros", "f-renta"].forEach(function (id) {   // multi-select
    $(id).addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      var b = e.target;
      b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
      if (id === "f-tipo") { toggleOtros(); toggleGastos(); }   // "Otros" + gastos si es apto
    });
  });
  ["f-dmin", "f-dmax", "f-bmin", "f-bmax"].forEach(function (id) {
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
  // PRIMERA vez que alguien abre la app (nunca la usó): no tiene sentido mostrarle novedades
  // de cosas que nunca conoció, ni encadenarle varias ventanitas. Se marca todo como visto
  // → arranca limpio y solo verá las novedades de acá en adelante. El que YA usó la app sí
  // ve las novedades nuevas. (Juan 2026-08-14)
  // Todas las ventanitas de novedades, en orden VIEJA → NUEVA. Al sumar una nueva, va al final.
  var NEWS = ["news", "news-agente", "news-avisos"];
  if (!novedadVista("iniciado")) {
    if (esPrimeraVezEnLaApp()) NEWS.forEach(marcarNovedad);
    marcarNovedad("iniciado");
  }
  pintarMarcaNueva();
  pintarAjustesNuevo();
  // De las novedades pendientes, mostrar SOLO LA ÚLTIMA (la más nueva). Las viejas pendientes
  // se dan por vistas (quedaron superadas): si alguien no entró en varios cambios, no se le
  // encadenan 4 ventanitas — ve solo la última. (Juan 2026-08-15)
  var newsPend = NEWS.filter(function (k) { return !novedadVista(k); });
  if (newsPend.length) {
    newsPend.slice(0, -1).forEach(marcarNovedad);      // las viejas pendientes → dadas por vistas
    abrirOverlay(newsPend[newsPend.length - 1]);        // la más nueva se muestra (se marca al cerrarla)
  }
  var cerrarNews = function () { marcarNovedad("news"); cerrarOverlay("news"); };
  $("btn-news-ok").addEventListener("click", cerrarNews);
  $("btn-news-x").addEventListener("click", cerrarNews);
  $("news").addEventListener("click", function (e) { if (e.target === $("news")) cerrarNews(); });
  var cerrarNewsAgente = function () { marcarNovedad("news-agente"); cerrarOverlay("news-agente"); };
  $("btn-news-agente-ok").addEventListener("click", cerrarNewsAgente);
  $("btn-news-agente-x").addEventListener("click", cerrarNewsAgente);
  $("news-agente").addEventListener("click", function (e) { if (e.target === $("news-agente")) cerrarNewsAgente(); });
  var cerrarNewsAvisos = function () { marcarNovedad("news-avisos"); cerrarOverlay("news-avisos"); };
  $("btn-news-avisos-ok").addEventListener("click", cerrarNewsAvisos);
  $("btn-news-avisos-x").addEventListener("click", cerrarNewsAvisos);
  $("news-avisos").addEventListener("click", function (e) { if (e.target === $("news-avisos")) cerrarNewsAvisos(); });
  $("btn-agente").addEventListener("click", function () {
    marcarNovedad("agente-btn"); $("btn-agente").classList.remove("nuevo");   // ya lo usó → sale del amarillo
    var a = window.__agente; if (!a) return;
    var texto = [a.nombre, a.tel].filter(Boolean).join(" ");
    copiarTexto(texto, $("btn-agente"),
      $("btn-agente").dataset.vuelve || "📇 Copiar contacto del agente");
  });
  $("btn-mi-link").addEventListener("click", copiarMiLink);
  $("btn-multicopy").addEventListener("click", copiarSeleccionadas);
  $("btn-multienviar").addEventListener("click", enviarSeleccionadas);
  $("btn-mapa").addEventListener("click", abrirMapa);
  $("btn-mapa-cerrar").addEventListener("click", cerrarMapa);
  $("mapa-valfiltro").querySelectorAll(".mv-chip").forEach(function (ch) {
    ch.addEventListener("click", function () {
      var k = this.getAttribute("data-v");
      MAPA_VF[k] = !MAPA_VF[k];
      this.setAttribute("aria-pressed", MAPA_VF[k] ? "true" : "false");
      pintarMapa();
    });
  });
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
    // Tick en el botón (suplanta "Poner") para que se vea que la acción se ejecutó.
    var btn = this;
    if (!btn.dataset.vuelve) btn.dataset.vuelve = btn.textContent;   // guarda "Poner"
    btn.classList.add("ok"); btn.textContent = "✓ Puesto";
    setTimeout(function () { btn.classList.remove("ok"); btn.textContent = btn.dataset.vuelve; }, 1400);
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
    marcarNovedad("ajustes-nv"); $("btn-ajustes").classList.remove("nuevo");   // ya la vio
    $("in-associate").value = ASSOCIATE;
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
      if (ok) $("avisos-estado").textContent = "✓ Avisos activados. Probá con el botón de abajo.";
    });
  });
  $("btn-probar-aviso").addEventListener("click", probarAviso);

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
    else sincronizarPush();                                        // sumá la búsqueda a lo que vigila
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
    // Índice por slug (O(1)) + normalizaciones precalculadas (DATA no cambia después):
    // evita recomputar norm()/tipoCat() en cada filtro y en cada comparación del orden.
    // Las props traídas en vivo (fromDetalle/rellenarExterno) no pasan por acá → las
    // funciones caen solas al cálculo directo (fallback).
    BY_SLUG = {};
    DATA.forEach(function (c) {
      BY_SLUG[c.slug] = c;
      c._barrioN = norm(c.barrio || "");
      c._tipoCat = tipoCat(c.tipo || "");
    });
    USD_RATE = d.usd_rate || null;
    backfillUbicaciones();   // guarda las coords en las búsquedas viejas (mientras la prop esté en el listado)
    avisarDatosViejos(d.generado_at);   // cartel si el robot diario dejó de actualizar
    mostrarFechaDatos(d.generado_at);   // fecha de los datos, siempre visible abajo
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
migrarBusquedas();   // normaliza búsquedas viejas (filtro de renta) antes de contar nada
cargar();
// Al abrir la app: cerrar notificaciones colgadas (saca el "1" pegado del ícono).
limpiarNotifsColgadas();
// Al volver a la app (la tenías en segundo plano): idem + repintar el dibujito.
document.addEventListener("visibilitychange", function () {
  if (!document.hidden) { limpiarNotifsColgadas(); renderBadge(); }
});
