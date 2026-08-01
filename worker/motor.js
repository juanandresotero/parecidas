// Motorcito de Parecidas — Cloudflare Worker (gratis, SIN llave).
// El celu no puede leer otros sitios (traba del navegador = CORS). Este motorcito,
// que corre en internet, baja la página de InfoCasas o MercadoLibre y devuelve los
// datos ya masticados, con permiso para que la app los use (CORS *).
//
// Uso:  GET https://<tu-worker>.workers.dev/?url=<link de la propiedad>
// Devuelve JSON normalizado:
//   { ok, fuente, tipo, operacion:'sale'|'rent', precio, moneda:'USD'|'UYU',
//     dorm, m2_construidos, m2_totales, cochera, estado:'usada'|'a_estrenar'|'', renta }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return json({ error: "Falta ?url=<link>" }, 400);
    let host;
    try { host = new URL(target).hostname.toLowerCase(); }
    catch { return json({ error: "URL inválida" }, 400); }

    try {
      const html = await fetchHtml(target);
      let data;
      if (/infocasas\./i.test(host)) data = parseInfoCasas(html);
      else if (/mercadolibre\.|mlibre\./i.test(host) || /\bMLU-/.test(target)) data = parseMercadoLibre(html);
      else return json({ error: "Portal no soportado (solo InfoCasas y MercadoLibre)" }, 422);
      return json({ ok: true, fuente: host, ...data }, 200);
    } catch (e) {
      return json({ error: "No pude leer la página: " + (e && e.message || e) }, 502);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

// Bajar el HTML haciéndonos pasar por un navegador de verdad (así la ficha directa pasa).
async function fetchHtml(target) {
  const r = await fetch(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-UY,es;q=0.9,en;q=0.8",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Dest": "document",
      "Upgrade-Insecure-Requests": "1",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

// ------------------------------ Utilidades ------------------------------
const RENTA_RE = /(renta|rentad|alquilad|ocupad)/i;
const SIN_COCHERA_RE = /sin\s+(cochera|garaj|garage)/i;
const COCHERA_RE = /(cochera|garaj|garage|\bgge\b)/i;

// Número uruguayo: "120.000" = ciento veinte mil; "1.234,5" = mil doscientos...
function numUY(s) {
  if (s == null) return null;
  const t = String(s).replace(/[^\d.,]/g, "");
  if (!t) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return isNaN(n) ? null : n;
}

function textoPlano(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
}

// Busca "Etiqueta … 123" en el texto de la ficha técnica y devuelve el número.
function specNum(texto, etiqueta) {
  const re = new RegExp(etiqueta + "\\s*:?\\s*([0-9][0-9.,]*)", "i");
  const m = texto.match(re);
  return m ? numUY(m[1]) : null;
}

function estadoDe(texto, antiguedad) {
  if (antiguedad === 0) return "a_estrenar";
  if (/\ba\s+estrenar\b|\bnuevo\b|\bestrenar\b|en\s+construcci/i.test(texto)) return "a_estrenar";
  if (/\busad/i.test(texto)) return "usada";
  if (antiguedad != null) return "usada";
  return "";
}

function cocheraDe(texto, cocheras) {
  if (cocheras != null) return cocheras > 0;
  if (SIN_COCHERA_RE.test(texto)) return false;
  if (COCHERA_RE.test(texto)) return true;
  return null;
}

// ------------------------------ MercadoLibre ------------------------------
// Precio/moneda del JSON-LD (limpio). Resto de la ficha técnica del texto.
function parseMercadoLibre(html) {
  const out = {
    tipo: "", operacion: "sale", precio: null, moneda: "USD", dorm: null,
    m2_construidos: null, m2_totales: null, cochera: null, estado: "", renta: false,
  };
  const texto = textoPlano(html);
  const titulo = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";

  // JSON-LD: precio, moneda, nombre (tipo)
  const lds = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const bloque of lds) {
    const raw = bloque.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
    let j; try { j = JSON.parse(raw); } catch { continue; }
    for (const node of Array.isArray(j) ? j : [j]) {
      const offers = node && (node.offers || (node.mainEntity && node.mainEntity.offers));
      if (offers) {
        const o = Array.isArray(offers) ? offers[0] : offers;
        if (o && o.price && out.precio == null) out.precio = numUY(o.price);
        if (o && o.priceCurrency) out.moneda = o.priceCurrency === "UYU" ? "UYU" : "USD";
      }
      if (node && node.name && !out.tipo) out.tipo = node.name;
    }
  }
  if (!out.tipo) out.tipo = titulo;

  // Operación (Venta / Alquiler) del título o del texto
  out.operacion = /\balquiler\b|\balquila\b|\barrienda\b/i.test(titulo + " " + texto.slice(0, 400))
    ? "rent" : "sale";

  // Ficha técnica (andes-table): pares "Etiqueta 123"
  const totales = specNum(texto, "Superficie total");
  const cub = specNum(texto, "Superficie cubierta") ||
    specNum(texto, "Superficie construida") || specNum(texto, "Área privada") ||
    specNum(texto, "Area privada");
  out.m2_totales = totales;
  out.m2_construidos = cub || totales;
  out.dorm = specNum(texto, "Dormitorios") || specNum(texto, "Habitaciones");
  const cocheras = specNum(texto, "Cocheras") != null ? specNum(texto, "Cocheras")
    : specNum(texto, "Estacionamientos");
  out.cochera = cocheraDe(texto, cocheras);
  const antig = specNum(texto, "Antigüedad") != null ? specNum(texto, "Antigüedad")
    : specNum(texto, "Antiguedad");
  out.estado = estadoDe(texto, antig);
  out.renta = RENTA_RE.test(titulo);
  return out;
}

// ------------------------------ InfoCasas ------------------------------
// Los datos vienen en un JSON embebido (__NEXT_DATA__). Como la estructura exacta
// puede variar, buscamos el nodo de la propiedad recorriendo el árbol, y sacamos
// cada campo probando varios nombres posibles. Si algo falta, queda en null y se
// completa a mano en la app.
function parseInfoCasas(html) {
  const out = {
    tipo: "", operacion: "sale", precio: null, moneda: "USD", dorm: null,
    m2_construidos: null, m2_totales: null, cochera: null, estado: "", renta: false,
  };
  const texto = textoPlano(html);
  const titulo = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";

  let root = null;
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (m) { try { root = JSON.parse(m[1]); } catch { root = null; } }

  const nodo = root ? buscarPropiedad(root) : null;
  if (nodo) {
    out.precio = numUY(pick(nodo, ["priceUsd", "price", "amount", "value"])) ||
      numUY(pickDeep(nodo, ["price", "amount"]));
    const monRaw = String(pick(nodo, ["currency", "currencySymbol"]) ||
      pickDeep(nodo, ["currency", "name"]) || "").toUpperCase();
    out.moneda = /U\$|USD|DOLAR/.test(monRaw) ? "USD" : (/\$|UYU|PESO/.test(monRaw) ? "UYU" : "USD");
    out.dorm = toInt(pick(nodo, ["bedrooms", "rooms", "dormitorios", "roomsAmount"]));
    out.m2_construidos = numUY(pick(nodo, ["m2Built", "builtSurface", "coveredSurface", "mts2", "m2"]));
    out.m2_totales = numUY(pick(nodo, ["m2Terrain", "landSurface", "totalSurface", "m2Total"]));
    const gar = pick(nodo, ["hasGarage", "garage", "garages", "parking", "parkingSpaces"]);
    out.cochera = (gar === true || (typeof gar === "number" && gar > 0)) ? true
      : (gar === false || gar === 0) ? false : cocheraDe(texto, null);
    out.tipo = String(pick(nodo, ["propertyType", "property_type", "type"]) ||
      pickDeep(nodo, ["property_type", "name"]) || titulo);
    const op = String(pick(nodo, ["operationType", "operation_type", "operation"]) ||
      pickDeep(nodo, ["operation_type", "name"]) || "").toLowerCase();
    out.operacion = /alqui|arrend|rent/.test(op) ? "rent" : "sale";
    // Estado SOLO del campo del nodo (escanear toda la página da falsos "a estrenar").
    const est = String(pick(nodo, ["construction_state_name", "constructionState", "condition"]) || "");
    out.estado = estadoDe(est, null);
  }

  // Respaldo por texto si el JSON no trajo lo básico (0 cuenta como "no vino").
  if (!out.m2_totales) out.m2_totales = specNum(texto, "Superficie del terreno") || specNum(texto, "Terreno");
  if (!out.m2_construidos) out.m2_construidos = specNum(texto, "Superficie edificada") || specNum(texto, "Edificado") || null;
  if (!out.dorm) out.dorm = specNum(texto, "Dormitorios") || specNum(texto, "Habitaciones");
  if (out.cochera == null) out.cochera = cocheraDe(texto, null);
  if (!out.tipo) out.tipo = titulo;
  if (out.operacion === "sale" && /\balquiler\b|\balquila\b/i.test(titulo)) out.operacion = "rent";
  out.renta = RENTA_RE.test(titulo);
  return out;
}

// Recorre el árbol y devuelve el primer objeto que "parece" una propiedad.
function buscarPropiedad(root) {
  const vistos = new Set();
  const cola = [root];
  while (cola.length) {
    const x = cola.shift();
    if (!x || typeof x !== "object" || vistos.has(x)) continue;
    vistos.add(x);
    const keys = Object.keys(x);
    const tieneM2 = keys.some((k) => /m2|surface|superficie|terrain|built/i.test(k));
    const tienePrecio = keys.some((k) => /price|precio|amount/i.test(k));
    const tieneDorm = keys.some((k) => /bedroom|dormitor|rooms/i.test(k));
    if (tienePrecio && (tieneM2 || tieneDorm)) return x;
    for (const k of keys) {
      const v = x[k];
      if (v && typeof v === "object") cola.push(v);
    }
  }
  return null;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "" && typeof v !== "object") return v;   // valores simples
  }
  return null;
}
// Busca {padre:{hijo:valor}} en el nodo (un nivel).
function pickDeep(obj, [padre, hijo]) {
  const p = obj[padre];
  return p && typeof p === "object" ? p[hijo] : null;
}
function toInt(v) { const n = numUY(v); return n == null ? null : Math.round(n); }

// Solo para poder probar los parsers fuera del Worker (Cloudflare usa el default).
export { parseMercadoLibre, parseInfoCasas };
