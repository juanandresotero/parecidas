"use strict";
// Buscador de parecidas — toda la lógica corre en el celu. Lee listings.json
// (que arma el robot 1 vez por día) y filtra. Sin servidor.

var ASSOCIATE = "940041154";
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
function stepVal(id) {
  var t = $(id).querySelector("span").textContent;
  return t === "—" ? null : parseInt(t, 10);
}
function setStep(id, v) {
  $(id).querySelector("span").textContent = (v == null) ? "—" : v;
}

function leerFiltros() {
  var precioMonto = soloNum($("f-precio").value);
  // 1 barrio → su grupo (similares). 2+ → solo esos exactos. 0 → da igual.
  var grupo = SELBARRIOS.length === 1 ? grupoDe(SELBARRIOS[0])
            : (SELBARRIOS.length > 1 ? barriosSel() : null);
  return {
    operacion: segVal("f-oper"),
    tipo: segVal("f-tipo"),
    grupo: grupo,
    dmin: stepVal("f-dmin"),
    dmax: stepVal("f-dmax"),
    precioUsd: precioMonto ? aUsd(precioMonto, monedaDe($("f-precio").value)) : null,
    cub: soloNum($("f-cub").value),
    padron: soloNum($("f-padron").value),
    cochera: segVal("f-coch"),
    estado: segVal("f-estado"),
    renta: segVal("f-renta")
  };
}
function monedaDe(txt) {
  var t = (txt || "").toLowerCase();
  if (t.indexOf("u$") >= 0 || t.indexOf("usd") >= 0 || t.indexOf("dol") >= 0) return "USD";
  if (t.indexOf("$u") >= 0 || t.indexOf("uyu") >= 0 || t.indexOf("peso") >= 0) return "UYU";
  return "USD"; // por defecto, dólares (lo más común en venta)
}
function aUsd(monto, moneda) {
  if (!monto) return null;
  if ((moneda || "USD") === "USD") return Math.round(monto);
  return USD_RATE ? Math.round(monto / USD_RATE) : null;
}

// -------------------------- El filtro en sí --------------------------
function cerca(valor, objetivo) { // ±25%
  return valor && objetivo && valor >= objetivo * 0.75 && valor <= objetivo * 1.25;
}
function pasa(c, f, slugActual) {
  if (slugActual && c.slug === slugActual) return false;            // no me devuelvo a mí mismo
  if (c.estado_pub && c.estado_pub !== "active") return false;      // reservada/negociación: no se ofrece
  if (f.operacion && c.operacion !== f.operacion) return false;
  if (f.tipo && tipoCat(c.tipo) !== f.tipo) return false;
  if (f.grupo && f.grupo.indexOf(norm(c.barrio)) < 0) return false;
  if (f.dmin != null && (c.dorm == null || c.dorm < f.dmin)) return false;
  if (f.dmax != null && (c.dorm == null || c.dorm > f.dmax)) return false;
  if (f.precioUsd != null && (c.precio_usd == null || c.precio_usd > f.precioUsd * (f.precioFactor || 1.15))) return false;
  if (f.cub != null && !cerca(c.m2_homog, f.cub)) return false;
  if (f.padron != null && !cerca(c.m2_padron, f.padron)) return false;
  if (f.cochera === "si" && c.cochera !== true) return false;
  if (f.cochera === "no" && c.cochera !== false) return false;
  if (f.estado && c.estado !== f.estado) return false;
  if (f.renta === "con" && c.renta !== true) return false;
  if (f.renta === "sin" && c.renta !== false) return false;
  return true;
}
// Referencia para ordenar "más parecida": la propiedad del link (window.__base),
// o si no hay link, lo que esté cargado en los filtros.
function refDeBusqueda() {
  var f = leerFiltros();
  var b = window.__base;
  var dorm = b ? b.dorm : ((f.dmin != null && f.dmax != null) ? Math.round((f.dmin + f.dmax) / 2)
           : (f.dmin != null ? f.dmin : f.dmax));
  return {
    operacion: b ? b.operacion : f.operacion,
    tipoC: b ? tipoCat(b.tipo) : f.tipo,
    barrios: barriosSel(),                     // barrios elegidos (normalizados)
    precio_usd: b ? b.precio_usd : f.precioUsd,
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
  if (ref.tipoC && tipoCat(c.tipo) !== ref.tipoC) p += w[2];
  if (ref.precio_usd && c.precio_usd)
    p += w[3] * Math.min(1, Math.abs(c.precio_usd - ref.precio_usd) / ref.precio_usd / 0.15);
  if (ref.dorm != null && c.dorm != null)
    p += w[4] * Math.min(1, Math.abs(c.dorm - ref.dorm) / 3);
  if (ref.cochera != null && c.cochera != null && c.cochera !== ref.cochera) p += w[5];
  if (ref.estado && c.estado && c.estado !== ref.estado) p += w[6];
  return p;
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
function buscar() {
  var f = leerFiltros();
  var ref = refDeBusqueda();
  var slugActual = window.__slugActual || null;
  var res = filtrar(f, ref, slugActual);
  // Flexibilidad "mínimo 2": si salen menos de 2, aflojo de MENOR a MAYOR
  // prioridad hasta llegar a 2. NUNCA aflojo venta/alquiler ni muestro reservadas.
  var pasos = [
    function () { f.estado = ""; },                    // 7 usado/a estrenar
    function () { f.cochera = ""; },                   // 6 cochera
    function () { f.dmin = null; f.dmax = null; },     // 5 dormitorios
    function () { f.precioFactor = 1.5; },             // 4 precio hasta +50%
    function () { f.cub = null; f.padron = null; },    // m²
    function () { f.precioUsd = null; },               // 4 sacar precio
    function () { f.tipo = ""; },                      // 3 tipo
    function () { f.grupo = null; }                    // 2 ubicación (última)
  ];
  var aflojado = false, i = 0;
  while (res.length < 2 && i < pasos.length) {
    pasos[i](); i++; aflojado = true;
    res = filtrar(f, ref, slugActual);
  }
  render(res, aflojado && res.length > 0);
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
  if (f.cub && c.m2_homog) {
    var dif = Math.round((c.m2_homog - f.cub) / f.cub * 100);
    b.push((dif >= 0 ? "+" : "") + dif + "% m²");
  }
  return b.join(" · ");
}
function linkAssoc(link) {
  return link + (link.indexOf("?") >= 0 ? "&" : "?") + "associate=" + ASSOCIATE;
}

var SEL = {};   // slug -> link de las propiedades tildadas (para copiar juntas)
function actualizarMulticopy() {
  var n = Object.keys(SEL).length;
  var b = $("btn-multicopy");
  b.textContent = "📋 Copiar seleccionadas (" + n + ")";
  b.style.display = n ? "" : "none";
}

function render(res, aflojado) {
  var f = leerFiltros();
  SEL = {}; actualizarMulticopy();
  $("resultados").style.display = "";
  $("cuenta").textContent = res.length + (res.length === 1 ? " encontrada" : " encontradas")
    + (aflojado ? " · búsqueda ampliada" : "");
  var cont = $("cards");
  if (!res.length) {
    cont.innerHTML = '<div class="vacio">No hay parecidas con esos filtros. Probá aflojar alguno (dejalo vacío / “Da igual”).</div>';
    return;
  }
  cont.innerHTML = "";
  res.forEach(function (c) {                       // TODAS (sin tope)
    var card = document.createElement("div");
    card.className = "card";
    // Tilde para seleccionar y copiar varias juntas
    var chk = document.createElement("input");
    chk.type = "checkbox"; chk.className = "card-check";
    chk.setAttribute("aria-label", "Seleccionar");
    chk.onchange = function () {
      if (chk.checked) SEL[c.slug] = c.link; else delete SEL[c.slug];
      card.classList.toggle("sel", chk.checked);
      actualizarMulticopy();
    };
    card.appendChild(chk);
    var foto = c.foto ? '<img class="foto" src="' + esc(c.foto) + '" alt="" loading="lazy">'
                      : '<div class="foto ph">🏠</div>';
    var chips = [];
    if (c.dorm) chips.push(c.dorm + " dorm");
    if (c.m2_homog) chips.push(c.m2_homog + " m²");
    if (c.cochera === true) chips.push("🚗 cochera");
    if (c.estado === "a_estrenar") chips.push("a estrenar");
    if (c.renta === true) chips.push("con renta");
    var link = document.createElement("a");
    link.className = "card-link"; link.href = c.link; link.target = "_blank"; link.rel = "noopener";
    link.style.cssText = "display:flex;gap:11px;flex:1;min-width:0;align-items:center";
    link.innerHTML = foto +
      '<div class="info">' +
        '<div class="precio">' + fmtPrecio(c) + '</div>' +
        '<div class="barrio">' + esc(c.barrio || "") + '</div>' +
        '<div class="chips">' + chips.map(function (x) { return '<span class="chip">' + x + '</span>'; }).join("") + '</div>' +
        (porque(c, f) ? '<span class="porque">' + porque(c, f) + '</span>' : "") +
      '</div>';
    card.appendChild(link);
    var btn = document.createElement("button");
    btn.className = "copiar"; btn.textContent = "📋";
    btn.title = "Copiar este link";
    btn.onclick = function () { copiarTexto(linkAssoc(c.link), btn, "📋"); };
    card.appendChild(btn);
    cont.appendChild(card);
  });
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
  var links = Object.keys(SEL).map(function (s) { return linkAssoc(SEL[s]); });
  if (!links.length) return;
  var b = $("btn-multicopy"), n = links.length;
  copiarTexto(links.join("\n"), b, "📋 Copiar seleccionadas (" + n + ")");
}

// -------------------------- Traer datos de un link --------------------------
function slugDeLink(link) {
  var m = (link || "").match(/\/listings\/([^/?#]+)/);
  if (m) return m[1];
  var t = (link || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  var parts = t.split("/");
  return parts.length ? parts[parts.length - 1] : "";
}
function rellenar(c) {
  setSeg("f-oper", c.operacion || "");
  setSeg("f-tipo", tipoCat(c.tipo) === "otro" ? "" : tipoCat(c.tipo));
  $("f-precio").value = c.precio ? ((c.moneda || "USD") + " " + new Intl.NumberFormat("es-UY").format(Math.round(c.precio))) : "";
  $("f-cub").value = c.m2_homog || "";
  $("f-padron").value = c.m2_padron || "";
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
}
function etiquetaEstadoPub(e) {
  return e === "reserved" ? "Reservada" : (e === "negotiation" ? "En negociación" : "");
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
    barrio: (det.geoLabel || "").split(",")[0].trim(),
    m2_homog: homog(det.dimensionCovered, det.dimensionTotalBuilt, det.dimensionLand, esApto, det.dimensionSemicovered, det.dimensionUncovered),
    m2_padron: Math.round(det.dimensionLand || 0),
    cochera: (park != null) ? (park > 0) : null,
    estado: aEstrenar ? "a_estrenar" : "usada",
    estado_pub: (det.listingStatus || {}).value || "active",
    renta: /(renta|rentad|alquilad|ocupad)/i.test(det.title || "")
  };
}
function traer() {
  var link = $("link").value.trim();
  var hint = $("hint");
  if (!link) { hint.textContent = "Pegá un link, o completá los datos a mano abajo."; return; }
  var esRemax = /remax\.com\.uy/i.test(link);
  var slug = slugDeLink(link);
  // 1) ¿está en el archivo del día? (lo más rápido)
  var enArchivo = DATA.filter(function (c) { return c.slug === slug; })[0];
  if (enArchivo) { rellenar(enArchivo); hint.innerHTML = avisoTraido(); return; }
  if (!esRemax) {
    hint.innerHTML = "⚠️ Ese link no es de RE/MAX: no puedo leerlo solo. <b>Completá los datos a mano</b> y buscá igual.";
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

// -------------------------- Arranque + eventos --------------------------
function initSegs() {
  ["f-oper", "f-tipo", "f-coch", "f-estado", "f-renta"].forEach(function (id) {
    $(id).addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      setSeg(id, e.target.getAttribute("data-v"));
    });
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
  // Si borra el link, olvido la propiedad base (para no ordenar/excluir con una vieja).
  $("link").addEventListener("input", function () {
    if (!$("link").value.trim()) { window.__base = null; window.__slugActual = null; }
  });
  attachMiles("f-precio", true);
  attachMiles("f-cub", false);
  attachMiles("f-padron", false);
  $("btn-traer").addEventListener("click", traer);
  $("btn-buscar").addEventListener("click", buscar);
  $("btn-multicopy").addEventListener("click", copiarSeleccionadas);
}

function cargar() {
  fetch("listings.json").then(function (r) { return r.json(); }).then(function (d) {
    DATA = d.listings || [];
    USD_RATE = d.usd_rate || null;
    // Lista de barrios reales para el autocompletar (sin repetir, ordenados).
    var vistos = {};
    BARRIOS_ALL = [];
    DATA.forEach(function (c) {
      var b = (c.barrio || "").trim();
      if (b && !vistos[norm(b)]) { vistos[norm(b)] = 1; BARRIOS_ALL.push(b); }
    });
    BARRIOS_ALL.sort(function (a, b) { return norm(a) < norm(b) ? -1 : 1; });
    $("estado").textContent = "";
  }).catch(function () {
    $("estado").textContent = "No pude cargar las propiedades. Revisá la conexión y recargá.";
  });
}

initSegs();
cargar();
