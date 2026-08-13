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
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    // --- Avisos con la app cerrada (push) ---
    // Guardar/actualizar la suscripción del celu + qué propiedades vigilar.
    if (url.searchParams.get("sub")) {
      if (!env || !env.SUBS) return json({ error: "push no configurado" }, 501);
      try {
        const body = await request.json();
        if (!body || !body.endpoint) return json({ error: "falta endpoint" }, 400);
        const id = await hashId(body.endpoint);
        const prev = (await env.SUBS.get("sub:" + id, "json")) || {};
        const rec = {
          endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth,
          campanas: Array.isArray(body.campanas) ? body.campanas : [],
          seen: prev.seen || {}, pending: prev.pending || [], updated: Date.now(),
        };
        await env.SUBS.put("sub:" + id, JSON.stringify(rec));
        return json({ ok: true }, 200);
      } catch (e) { return json({ error: "sub: " + (e && e.message || e) }, 400); }
    }
    // El Service Worker pregunta "¿qué aviso muestro?" (el push llega vacío).
    if (url.searchParams.get("pending")) {
      if (!env || !env.SUBS) return json({ avisos: [] });
      const ep = url.searchParams.get("ep");
      if (!ep) return json({ avisos: [] });
      const id = await hashId(ep);
      const rec = await env.SUBS.get("sub:" + id, "json");
      const avisos = (rec && rec.pending) || [];
      if (rec && avisos.length) { rec.pending = []; await env.SUBS.put("sub:" + id, JSON.stringify(rec)); }
      return json({ avisos });
    }
    // Cotización del dólar del día (uy.dolarapi bloquea el pedido directo del navegador).
    if (url.searchParams.get("dolar")) {
      try {
        const r = await fetch("https://uy.dolarapi.com/v1/cotizaciones/usd", {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
            "Accept": "application/json" },
          cf: { cacheTtl: 3600 },
        });
        const j = await r.json();
        const rate = Number(j.venta || j.compra) || null;
        return json({ ok: true, rate }, 200);
      } catch (e) { return json({ error: "dolar: " + (e && e.message || e) }, 502); }
    }
    const target = url.searchParams.get("url");
    if (!target) return json({ error: "Falta ?url=<link>" }, 400);
    let host;
    try { host = new URL(target).hostname.toLowerCase(); }
    catch { return json({ error: "URL inválida" }, 400); }

    try {
      let data;
      if (/infocasas\./i.test(host)) {
        data = parseInfoCasas(await fetchHtml(target));
      } else if (/mercadolibre\.|mlibre\./i.test(host) || /\bMLU-/.test(target)) {
        data = parseMercadoLibre(await fetchHtml(target, UA_ML));   // disfraz de bot
        // Si aún así no salió nada, ML cambió algo → avisar claro.
        if (data.precio == null && data.dorm == null &&
            data.m2_construidos == null && data.m2_totales == null)
          return json({ error: "MercadoLibre bloqueó la lectura automática (anti-robot). Copiá los datos a mano." }, 200);
      }
      else return json({ error: "Portal no soportado (solo InfoCasas y MercadoLibre)" }, 422);
      return json({ ok: true, fuente: host, ...data }, 200);
    } catch (e) {
      return json({ error: "No pude leer la página: " + (e && e.message || e) }, 502);
    }
  },

  // Robotito que se despierta solo (cron): revisa las propiedades en campaña y, si
  // alguna cambió de estado, deja el aviso pronto y le dispara la notificación al celu.
  async scheduled(event, env, ctx) {
    if (!env || !env.SUBS) return;
    const list = await env.SUBS.list({ prefix: "sub:" });
    for (const k of list.keys) {
      const rec = await env.SUBS.get(k.name, "json");
      if (!rec) continue;
      let dirty = false;
      const nuevos = [];
      for (const c of (rec.campanas || [])) {
        const est = await estadoRemax(c.slug);
        if (est == null) continue;                 // error de red: no toco nada
        const prev = rec.seen[c.slug];
        if (prev !== est) { rec.seen[c.slug] = est; dirty = true; }
        if (prev === undefined) continue;          // primera vez: solo registrar, no avisar
        if (est !== prev && est !== "active") {
          nuevos.push({
            titulo: "📣 Propiedad en campaña",
            cuerpo: (c.dir || "Una propiedad") + " → " + etqEstado(est),
            url: "./", tag: "camp-" + c.slug,
          });
        }
      }
      if (nuevos.length) {
        rec.pending = (rec.pending || []).concat(nuevos); dirty = true;
      }
      if (dirty) await env.SUBS.put(k.name, JSON.stringify(rec));
      if (nuevos.length) {
        const st = await enviarPush(rec, env);
        if (st === 404 || st === 410) await env.SUBS.delete(k.name);   // suscripción vencida
      }
    }
  },
};

// ---- Push: helpers ----
function etqEstado(est) {
  return est === "reserved" ? "Reservada"
    : est === "negotiation" ? "En negociación"
    : est === "baja" ? "Ya no está publicada"
    : est === "finished" ? "Finalizada / vendida" : "Cambió de estado";
}
async function estadoRemax(slug) {
  try {
    const r = await fetch("https://api-ar.redremax.com/remaxweb-uy/api/listings/findBySlug/" +
      encodeURIComponent(slug), { headers: { "User-Agent": "parecidas/1.0" } });
    const d = await r.json();
    const det = d && d.data ? (d.data.data || d.data) : null;
    if (!det || !det.slug) return "baja";
    return (det.listingStatus || {}).value || "active";
  } catch (e) { return null; }
}
async function hashId(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64urlBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlObj(obj) { return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj))); }
// Firma VAPID (identifica que el aviso viene de TU robotito). Push SIN cuerpo (vacío):
// solo necesita esta firma, no cifrado → mucho más simple.
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const unsigned = b64urlObj({ typ: "JWT", alg: "ES256" }) + "." +
    b64urlObj({ aud, exp, sub: "mailto:juanandresotero@gmail.com" });
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key,
    new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + b64urlBytes(new Uint8Array(sig));
  return "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC;
}
async function enviarPush(rec, env) {
  try {
    const res = await fetch(rec.endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuth(rec.endpoint, env),
        "TTL": "86400", "Content-Length": "0", "Urgency": "normal",
      },
    });
    return res.status;
  } catch (e) { return 0; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

// Bajar el HTML. UA por defecto = navegador; para ML pasamos un UA de bot de vista
// previa (facebookexternalhit): ML le sirve la ficha completa a esos bots (SEO) y así
// esquivamos su bloqueo anti-robot de la ficha normal.
const UA_NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const UA_ML = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
async function fetchHtml(target, ua) {
  const r = await fetch(target, {
    headers: {
      "User-Agent": ua || UA_NAVEGADOR,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-UY,es;q=0.9,en;q=0.8",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Dest": "document",
      "Upgrade-Insecure-Requests": "1",
    },
    cf: { cacheTtl: 0 },   // sin caché: la clave es la URL y no varía por UA (nos daba páginas viejas)
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
// ML bloquea la ficha para navegadores, pero le sirve el contenido SEO a los bots de
// vista previa (usamos UA de facebookexternalhit). De ahí leemos:
//  - precio/moneda: JSON-LD (offers.price/priceCurrency) + símbolo del título.
//  - operación/tipo/dormitorios/barrio: del og:title ("Alquiler Apartamento 2
//    Dormitorios La Blanqueada - $ 34.000").
//  - m²: del og:description ("Departamento de 54 m²").
function deco(s) {
  return (s || "").replace(/&amp;/g, "&").replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function parseMercadoLibre(html) {
  const out = {
    tipo: "", operacion: "sale", precio: null, moneda: "USD", dorm: null,
    m2_construidos: null, m2_totales: null, cochera: null, estado: "", renta: false, barrio: "",
  };
  const og = (t) => {
    const m = html.match(new RegExp('property=["\']og:' + t + '["\'][^>]*content=["\']([^"\']*)', "i"));
    return m ? deco(m[1]) : "";
  };
  const titulo = og("title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
  const desc = og("description") || "";

  // Precio + moneda del JSON-LD (offers)
  const lds = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const bloque of lds) {
    let j; try { j = JSON.parse(bloque.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "")); } catch { continue; }
    for (const node of Array.isArray(j) ? j : [j]) {
      const offers = node && (node.offers || (node.mainEntity && node.mainEntity.offers));
      if (offers) {
        const o = Array.isArray(offers) ? offers[0] : offers;
        if (o && o.price && out.precio == null) out.precio = numUY(o.price);
        if (o && o.priceCurrency) out.moneda = o.priceCurrency === "UYU" ? "UYU" : "USD";
      }
    }
  }
  // Moneda por el símbolo del título; precio de respaldo si el JSON-LD no lo trajo.
  const priceStr = titulo.split(/\s[-–]\s/).pop() || "";
  if (/U\$S|US\$|USD/i.test(priceStr)) out.moneda = "USD";
  else if (/\$/.test(priceStr)) out.moneda = "UYU";
  if (out.precio == null) { const pm = priceStr.match(/([\d][\d.,]*)/); if (pm) out.precio = numUY(pm[1]); }

  // Del título: "Operación Tipo N Dormitorios Barrio - precio"
  out.operacion = /\balquiler\b|\balquila\b|\barrienda\b/i.test(titulo) ? "rent" : "sale";
  out.tipo = titulo;                                        // la app (tipoCat) lo interpreta
  const md = titulo.match(/(\d+)\s*dormitorio/i); if (md) out.dorm = toInt(md[1]);
  const head = (titulo.split(/\s[-–]\s/)[0] || "")
    .replace(/^\s*(alquiler|venta)\s+/i, "")
    .replace(/^\s*\S+\s+/, "")                              // saca la palabra del tipo
    .replace(/^\s*\d+\s+dormitorios?\s+/i, "");             // saca "N Dormitorios"
  out.barrio = head.trim();

  // m² de la descripción
  const m2 = desc.match(/(\d+(?:[.,]\d+)?)\s*m²/i) || desc.match(/(\d+)\s*m2\b/i);
  if (m2) out.m2_construidos = numUY(m2[1]);

  const texto = titulo + " " + desc;
  out.cochera = cocheraDe(texto, null);
  out.estado = estadoDe(texto, null);
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
    m2_construidos: null, m2_totales: null, cochera: null, estado: "", renta: false, barrio: "",
  };
  const texto = textoPlano(html);
  const titulo = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";

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
  // Si el TÍTULO dice cochera → con cochera (manda el título, pedido de Juan).
  if (cocheraDe(titulo, null) === true) out.cochera = true;
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
