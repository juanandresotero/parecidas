"use strict";
// Buscador de parecidas — toda la lógica corre en el celu. Lee listings.json
// (que arma el robot 1 vez por día) y filtra. Sin servidor.

// Associate editable (cada usuario pone el suyo en Ajustes). Guardado en el celu.
var ASSOCIATE = "940041154";
try { ASSOCIATE = localStorage.getItem("parecidas_associate") || ASSOCIATE; } catch (e) {}
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
    renta: segVal("f-renta")
  };
}
function aUsd(monto, moneda) {
  if (!monto) return null;
  if ((moneda || "USD") === "USD") return Math.round(monto);
  return USD_RATE ? Math.round(monto / USD_RATE) : null;
}
// Precio a USD según la operación: venta = dólares, alquiler = pesos.
function precioAUsd(monto) {
  if (!monto) return null;
  return segVal("f-oper") === "rent" ? aUsd(monto, "UYU") : aUsd(monto, "USD");
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
    ["estado", function () { f.estado = ""; }],                          // 7
    ["cochera", function () { f.cochera = ""; }],                        // 6
    ["dormitorios", function () { f.dmin = null; f.dmax = null; }],      // 5
    ["m²", function () { f.cubMin = null; f.cubMax = null; f.padronMin = null; f.padronMax = null; }],
    ["precio", function () { f.precioMinUsd = null; f.precioMaxUsd = null; }], // 4
    ["tipo", function () { f.tipos = []; }],                             // 3
    ["zona", function () { f.grupo = null; }]                            // 2 (última)
  ];
  var aflojados = [], i = 0;
  while (res.length < 2 && i < pasos.length) {
    aflojados.push(pasos[i][0]); pasos[i][1](); i++;
    res = filtrar(f, ref, slugActual);
  }
  render(res, res.length ? aflojados : []);
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
  return link + (link.indexOf("?") >= 0 ? "&" : "?") + "associate=" + ASSOCIATE;
}

var SEL = {};   // slug -> link de las propiedades tildadas (para copiar juntas)
function actualizarMulticopy() {
  var n = Object.keys(SEL).length;
  var b = $("btn-multicopy");
  b.textContent = "📋 Copiar seleccionadas (" + n + ")";
  b.style.display = n ? "" : "none";
}

function render(res, aflojados) {
  var f = leerFiltros();
  SEL = {}; actualizarMulticopy();
  $("resultados").style.display = "";
  $("cuenta").textContent = res.length + (res.length === 1 ? " encontrada" : " encontradas")
    + (aflojados && aflojados.length ? " · amplié: " + aflojados.join(", ") : "");
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
function setRango(id, val) {   // llena mín/máx con ±25% del valor del link
  if (val) {
    $(id + "-min").value = fmtMiles(String(Math.round(val * 0.75)));
    $(id + "-max").value = fmtMiles(String(Math.round(val * 1.25)));
  } else { $(id + "-min").value = ""; $(id + "-max").value = ""; }
}
function rellenar(c) {
  setSeg("f-oper", c.operacion === "rent" ? "rent" : "sale");
  var tc = tipoCat(c.tipo);
  setSegMulti("f-tipo", tc === "otro" ? [] : [tc]);
  // precio: sin mínimo (más barato sirve), máximo +15%. m²: ±25%.
  $("f-precio-min").value = "";
  $("f-precio-max").value = c.precio ? fmtMiles(String(Math.round(c.precio * 1.15))) : "";
  setRango("f-cub", c.m2_homog);
  setRango("f-padron", c.m2_padron);
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
    oper: segVal("f-oper"), tipos: segMulti("f-tipo"),
    precioMin: $("f-precio-min").value, precioMax: $("f-precio-max").value,
    cubMin: $("f-cub-min").value, cubMax: $("f-cub-max").value,
    padronMin: $("f-padron-min").value, padronMax: $("f-padron-max").value,
    barrios: SELBARRIOS.slice(),
    dmin: stepVal("f-dmin"), dmax: stepVal("f-dmax"),
    coch: segVal("f-coch"), estado: segVal("f-estado"), renta: segVal("f-renta"),
    base: window.__base || null, slugActual: window.__slugActual || null
  };
}
function restoreForm(s) {
  $("link").value = s.link || "";
  setSeg("f-oper", s.oper || "sale");
  setSegMulti("f-tipo", s.tipos || []);
  $("f-precio-min").value = s.precioMin || ""; $("f-precio-max").value = s.precioMax || "";
  $("f-cub-min").value = s.cubMin || ""; $("f-cub-max").value = s.cubMax || "";
  $("f-padron-min").value = s.padronMin || ""; $("f-padron-max").value = s.padronMax || "";
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

function guardarBusquedaActual(nombre, tel) {
  var f = leerFiltros();
  var slugActual = window.__slugActual || null;
  var matches = DATA.filter(function (c) { return pasa(c, f, slugActual); });
  var b = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
    nombre: nombre, tel: tel, creada: new Date().toISOString(),
    form: snapshotForm(), filtro: f, slugActual: slugActual,
    vistas: matches.map(function (c) { return c.slug; })   // lo que ya vio hoy
  };
  var arr = cargarBusquedas(); arr.unshift(b); guardarBusquedas(arr);
}

function abrirBusqueda(id) {
  var arr = cargarBusquedas();
  var b = null;
  arr.forEach(function (x) { if (x.id === id) b = x; });
  if (!b) return;
  restoreForm(b.form);
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
    var nom = document.createElement("div"); nom.className = "bi-nom";
    nom.textContent = b.nombre || "Sin nombre";
    info.appendChild(nom);
    var sub = document.createElement("div"); sub.className = "bi-sub";
    var wa = waLink(b.tel);
    if (b.tel && wa) {
      var a = document.createElement("a");
      a.className = "bi-tel"; a.href = wa; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "💬 " + b.tel;
      sub.appendChild(a);
    } else { sub.textContent = matchesDe(b).length + " parecidas"; }
    info.appendChild(sub);
    item.appendChild(info);
    if (nuevas > 0) {
      var badge = document.createElement("span"); badge.className = "bi-nuevas";
      badge.textContent = "+" + nuevas + " nueva" + (nuevas === 1 ? "" : "s");
      item.appendChild(badge);
    }
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
  var n = totalNuevas(), el = $("busq-badge");
  if (n > 0) { el.textContent = n > 99 ? "99+" : n; el.style.display = ""; }
  else el.style.display = "none";
}

function abrirOverlay(id) { $(id).style.display = "flex"; }
function cerrarOverlay(id) { $(id).style.display = "none"; }

// -------------------------- Arranque + eventos --------------------------
function initSegs() {
  ["f-oper", "f-coch", "f-estado", "f-renta"].forEach(function (id) {   // una sola opción
    $(id).addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      setSeg(id, e.target.getAttribute("data-v"));
    });
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
  // Si borra el link, olvido la propiedad base (para no ordenar/excluir con una vieja).
  $("link").addEventListener("input", function () {
    if (!$("link").value.trim()) { window.__base = null; window.__slugActual = null; }
  });
  ["f-precio-min", "f-precio-max", "f-cub-min", "f-cub-max", "f-padron-min", "f-padron-max"]
    .forEach(function (id) { attachMiles(id, false); });
  $("btn-traer").addEventListener("click", traer);
  $("btn-buscar").addEventListener("click", buscar);
  $("btn-multicopy").addEventListener("click", copiarSeleccionadas);
  // Ajustes (associate editable)
  $("btn-ajustes").addEventListener("click", function () {
    $("in-associate").value = ASSOCIATE; $("ajustes-msg").textContent = "";
    $("ajustes").style.display = "flex";
  });
  $("btn-ajustes-cerrar").addEventListener("click", function () { $("ajustes").style.display = "none"; });
  $("ajustes").addEventListener("click", function (e) { if (e.target === $("ajustes")) $("ajustes").style.display = "none"; });
  $("btn-associate-guardar").addEventListener("click", function () {
    var v = ($("in-associate").value || "").trim();
    if (!v) { $("ajustes-msg").textContent = "Poné tu código."; return; }
    ASSOCIATE = v;
    try { localStorage.setItem("parecidas_associate", v); } catch (e) {}
    $("ajustes-msg").textContent = "✓ Guardado";
  });

  // Búsquedas guardadas (menú nuevo)
  $("btn-busquedas").addEventListener("click", function () { renderBusquedas(); abrirOverlay("busquedas"); });
  $("btn-busq-cerrar").addEventListener("click", function () { cerrarOverlay("busquedas"); });
  $("busquedas").addEventListener("click", function (e) { if (e.target === $("busquedas")) cerrarOverlay("busquedas"); });
  // Botón "Guardar esta búsqueda" (dentro de los resultados) → pide nombre + celu
  $("btn-guardar-busq").addEventListener("click", function () {
    $("gb-nombre").value = ""; $("gb-tel").value = ""; $("gb-msg").textContent = "";
    abrirOverlay("guardar-busq"); $("gb-nombre").focus();
  });
  $("btn-guardar-cerrar").addEventListener("click", function () { cerrarOverlay("guardar-busq"); });
  $("guardar-busq").addEventListener("click", function (e) { if (e.target === $("guardar-busq")) cerrarOverlay("guardar-busq"); });
  $("btn-guardar-ok").addEventListener("click", function () {
    var nombre = ($("gb-nombre").value || "").trim();
    var tel = ($("gb-tel").value || "").trim();
    if (!nombre) { $("gb-msg").textContent = "Poné un nombre para reconocerla."; return; }
    guardarBusquedaActual(nombre, tel);
    cerrarOverlay("guardar-busq");
    renderBadge();
  });
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
    renderBadge();   // numerito de parecidas nuevas en el 🔖
  }).catch(function () {
    $("estado").textContent = "No pude cargar las propiedades. Revisá la conexión y recargá.";
  });
}

initSegs();
cargar();
