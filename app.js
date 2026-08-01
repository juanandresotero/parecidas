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
  if (t.indexOf("departamento") >= 0 || t.indexOf("penthouse") >= 0 || t.indexOf("apart") >= 0) return "apto";
  if (t.indexOf("casa") >= 0) return "casa";
  if (t.indexOf("terreno") >= 0 || t.indexOf("lote") >= 0) return "terreno";
  return "otro";
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
  var barrio = $("f-barrio").value;
  return {
    operacion: segVal("f-oper"),
    tipo: segVal("f-tipo"),
    grupo: barrio.trim() ? grupoDe(barrio) : null,
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
  if (f.operacion && c.operacion !== f.operacion) return false;
  if (f.tipo && tipoCat(c.tipo) !== f.tipo) return false;
  if (f.grupo && f.grupo.indexOf(norm(c.barrio)) < 0) return false;
  if (f.dmin != null && (c.dorm == null || c.dorm < f.dmin)) return false;
  if (f.dmax != null && (c.dorm == null || c.dorm > f.dmax)) return false;
  if (f.precioUsd != null && (c.precio_usd == null || c.precio_usd > f.precioUsd * 1.15)) return false;
  if (f.cub != null && !cerca(c.m2_homog, f.cub)) return false;
  if (f.padron != null && !cerca(c.m2_padron, f.padron)) return false;
  if (f.cochera === "si" && c.cochera !== true) return false;
  if (f.cochera === "no" && c.cochera !== false) return false;
  if (f.estado && c.estado !== f.estado) return false;
  if (f.renta === "con" && c.renta !== true) return false;
  if (f.renta === "sin" && c.renta !== false) return false;
  return true;
}
function puntaje(c, f) { // más chico = más parecido
  var p = 0;
  if (f.cub && c.m2_homog) p += Math.abs(c.m2_homog - f.cub) / f.cub;
  if (f.precioUsd && c.precio_usd) p += Math.abs(c.precio_usd - f.precioUsd) / f.precioUsd;
  return p;
}

function buscar() {
  var f = leerFiltros();
  var slugActual = window.__slugActual || null;
  var res = DATA.filter(function (c) { return pasa(c, f, slugActual); });
  res.sort(function (a, b) {
    var d = puntaje(a, f) - puntaje(b, f);
    if (Math.abs(d) > 1e-9) return d;
    return (a.precio_usd || 1e12) - (b.precio_usd || 1e12);
  });
  render(res);
}

// -------------------------- Dibujar resultados --------------------------
function fmtPrecio(c) {
  if (!c.precio) return "Consultar";
  var s = new Intl.NumberFormat("es-UY").format(Math.round(c.precio));
  return (c.moneda || "USD") + " " + s;
}
function porque(c, f) {
  var b = [];
  if (f.grupo) b.push(norm(c.barrio) === norm($("f-barrio").value) ? "mismo barrio" : "mismo grupo");
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

function render(res) {
  var f = leerFiltros();
  SEL = {}; actualizarMulticopy();
  $("resultados").style.display = "";
  $("cuenta").textContent = res.length + (res.length === 1 ? " encontrada" : " encontradas");
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
    var foto = c.foto ? '<img class="foto" src="' + c.foto + '" alt="" loading="lazy">'
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
        '<div class="barrio">' + (c.barrio || "") + '</div>' +
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
  $("f-barrio").value = c.barrio || "";
  pintarGrupo();
  setStep("f-dmin", c.dorm != null ? c.dorm : null);
  setStep("f-dmax", c.dorm != null ? c.dorm : null);
  setSeg("f-coch", c.cochera === true ? "si" : (c.cochera === false ? "no" : ""));
  setSeg("f-estado", c.estado || "");
  // Regla de Juan: si el link tiene renta → parecidas con renta; si no → sin renta.
  setSeg("f-renta", c.renta ? "con" : "sin");
  window.__slugActual = c.slug || null;
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
    dorm: det.bedrooms,
    barrio: (det.geoLabel || "").split(",")[0].trim(),
    m2_homog: homog(det.dimensionCovered, det.dimensionTotalBuilt, det.dimensionLand, esApto, det.dimensionSemicovered, det.dimensionUncovered),
    m2_padron: Math.round(det.dimensionLand || 0),
    cochera: (park != null) ? (park > 0) : null,
    estado: aEstrenar ? "a_estrenar" : "usada",
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
  if (enArchivo) { rellenar(enArchivo); hint.innerHTML = "✓ Datos traídos. Revisá y tocá <b>Buscar parecidas</b>."; return; }
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
    hint.innerHTML = "✓ Datos traídos de RE/MAX. Revisá y tocá <b>Buscar parecidas</b>.";
  }).catch(function () {
    hint.innerHTML = "No pude leer ese link. <b>Completá los datos a mano</b> y buscá igual.";
  });
}

// -------------------------- Grupo de barrio en vivo --------------------------
function pintarGrupo() {
  var b = $("f-barrio").value.trim();
  if (!b) { $("f-grupo").textContent = ""; return; }
  var g = grupoDe(b);
  $("f-grupo").textContent = g && g.length > 1
    ? "Grupo: " + g.map(function (x) { return x.replace(/\b\w/g, function (m) { return m.toUpperCase(); }); }).slice(0, 6).join(" · ")
    : "Barrio solo (no está en un grupo)";
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
  $("f-barrio").addEventListener("input", pintarGrupo);
  $("btn-traer").addEventListener("click", traer);
  $("btn-buscar").addEventListener("click", buscar);
  $("btn-multicopy").addEventListener("click", copiarSeleccionadas);
}

function cargar() {
  fetch("listings.json").then(function (r) { return r.json(); }).then(function (d) {
    DATA = d.listings || [];
    USD_RATE = d.usd_rate || null;
    $("estado").textContent = "";
  }).catch(function () {
    $("estado").textContent = "No pude cargar las propiedades. Revisá la conexión y recargá.";
  });
}

initSegs();
cargar();
