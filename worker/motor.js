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
          busquedas: mergeBusquedas(prev.busquedas, body.busquedas),
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
    // Prueba: manda un aviso al instante a este celu (para confirmar que llega).
    if (url.searchParams.get("testpush")) {
      if (!env || !env.SUBS) return json({ error: "push no configurado" }, 501);
      const ep = url.searchParams.get("ep");
      if (!ep) return json({ error: "falta ep" }, 400);
      const id = await hashId(ep);
      const rec = await env.SUBS.get("sub:" + id, "json");
      if (!rec) return json({ error: "no suscripto" }, 404);
      rec.pending = (rec.pending || []).concat([{
        titulo: "✅ Prueba de aviso",
        cuerpo: "¡Los avisos de Parecidas funcionan!", url: "./", tag: "prueba",
      }]);
      await env.SUBS.put("sub:" + id, JSON.stringify(rec));
      const st = await enviarPush(rec, env);
      return json({ ok: st === 201 || st === 200, status: st }, 200);
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

  // Robotito que se despierta solo (cron): revisa (1) las propiedades en campaña y
  // (2) las parecidas nuevas de cada cliente. Si hay novedad, dispara la notificación.
  async scheduled(event, env, ctx) {
    if (!env || !env.SUBS) return;
    // El archivo del día (una sola vez para todos): para detectar parecidas nuevas.
    let listings = null;
    try {
      const lr = await fetch("https://juanandresotero.github.io/parecidas/listings.json");
      const ld = await lr.json();
      listings = ld && ld.listings ? ld.listings : null;
    } catch (e) { listings = null; }

    const list = await env.SUBS.list({ prefix: "sub:" });
    for (const k of list.keys) {
      const rec = await env.SUBS.get(k.name, "json");
      if (!rec) continue;
      let dirty = false;
      const nuevos = [];
      // (1) Campaña: estado de la propiedad en RE/MAX.
      for (const c of (rec.campanas || [])) {
        const info = await estadoRemax(c.slug);
        if (info == null) continue;                // error de red: no toco nada
        const est = info.estado;
        const prev = rec.seen[c.slug];
        if (prev !== est) { rec.seen[c.slug] = est; dirty = true; }
        // Bajó de precio (aunque la propiedad siga activa). Primera vez: solo registra.
        if (!rec.precios) rec.precios = {};
        const pp = rec.precios[c.slug];
        if (info.precio != null) {
          if (pp && pp.moneda === info.moneda && info.precio < pp.precio) {
            nuevos.push({
              titulo: "💸 Bajó de precio",
              cuerpo: (c.dir || "Una propiedad") + ": de " + fmtPrecio(pp.precio, info.moneda) +
                      " a " + fmtPrecio(info.precio, info.moneda),
              url: "./", tag: "precio-" + c.slug,
            });
          }
          if (!pp || pp.precio !== info.precio || pp.moneda !== info.moneda) {
            rec.precios[c.slug] = { precio: info.precio, moneda: info.moneda }; dirty = true;
          }
        }
        if (prev === undefined) continue;          // primera vez: solo registrar el estado
        if (est !== prev && est !== "active") {
          nuevos.push({
            titulo: "📣 Propiedad en campaña",
            cuerpo: (c.dir || "Una propiedad") + " → " + etqEstado(est),
            url: "./", tag: "camp-" + c.slug,
          });
        }
      }
      // (2) Parecidas nuevas por cliente (mismo filtro que la app).
      if (listings) {
        for (const b of (rec.busquedas || [])) {
          if (!b || !b.filtro) continue;
          const seen = new Set(b.seen || []);
          let nuevas = 0;
          for (const c of listings) {
            if (!pasa(c, b.filtro, b.slugActual)) continue;
            if (!seen.has(c.slug)) { seen.add(c.slug); nuevas++; }
          }
          if (nuevas > 0) {
            b.seen = Array.from(seen); dirty = true;
            nuevos.push({
              titulo: "🔎 Parecidas nuevas",
              cuerpo: nuevas + (nuevas === 1 ? " nueva" : " nuevas") + " para " + (b.nombre || "un cliente"),
              url: "./", tag: "busq-" + b.id,
            });
          }
        }
      }
      if (nuevos.length) { rec.pending = (rec.pending || []).concat(nuevos); dirty = true; }
      if (dirty) await env.SUBS.put(k.name, JSON.stringify(rec));
      if (nuevos.length) {
        const st = await enviarPush(rec, env);
        if (st === 404 || st === 410) await env.SUBS.delete(k.name);   // suscripción vencida
      }
    }
  },
};

// Junta las búsquedas nuevas con lo que ya sabía el robotito (para no re-avisar lo visto).
function mergeBusquedas(prev, incoming) {
  prev = Array.isArray(prev) ? prev : [];
  const byId = {}; prev.forEach((x) => { byId[x.id] = x; });
  return (Array.isArray(incoming) ? incoming : []).map((nb) => {
    const old = byId[nb.id];
    const base = old ? (old.seen || []) : (nb.vistas || []);   // 1ª vez: baseline = lo ya visto
    const seen = Array.from(new Set(base.concat(nb.vistas || [])));
    return {
      id: nb.id, nombre: nb.nombre || "un cliente",
      filtro: nb.filtro || null, slugActual: nb.slugActual || null, seen,
    };
  });
}

// ---- Filtro (idéntico al de la app; el filtro viene ya masticado con USD y grupo) ----
function norm(s) {
  return (s || "").normalize("NFC").toLowerCase()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n").trim();
}
// Igual que el tipoCat de la app (categorías finas), para que los avisos de "parecidas
// nuevas" del robotito cuadren con lo que filtra la app.
function tipoCat(t) {
  t = norm(t);
  if (t.indexOf("departamento") >= 0 || t.indexOf("penthouse") >= 0 || t.indexOf("apart") >= 0 || t === "ph") return "apto";
  if (t.indexOf("casa") >= 0) return "casa";
  if (t.indexOf("terreno") >= 0 || t.indexOf("lote") >= 0) return "terreno";
  if (t.indexOf("chacra") >= 0) return "chacra";
  if (t.indexOf("campo") >= 0) return "campo";
  if (t.indexOf("quinta") >= 0) return "quinta";
  if (t.indexOf("local") >= 0) return "local";
  if (t.indexOf("oficina") >= 0) return "oficina";
  if (t.indexOf("deposito") >= 0 || t.indexOf("galpon") >= 0 || t.indexOf("industrial") >= 0) return "deposito";
  return "otro";
}
function pasa(c, f, slugActual) {
  if (slugActual && c.slug === slugActual) return false;
  if (c.estado_pub && c.estado_pub !== "active") return false;
  if (f.operacion && c.operacion !== f.operacion) return false;
  if (f.tipos && f.tipos.length && f.tipos.indexOf(tipoCat(c.tipo)) < 0) return false;
  if (f.grupo && f.grupo.indexOf(norm(c.barrio)) < 0) return false;
  if (f.dmin != null && (c.dorm == null || c.dorm < f.dmin)) return false;
  if (f.dmax != null && (c.dorm == null || c.dorm > f.dmax)) return false;
  if (f.bmin != null && (c.banos == null || c.banos < f.bmin)) return false;
  if (f.bmax != null && (c.banos == null || c.banos > f.bmax)) return false;
  if (f.precioMinUsd != null && (c.precio_usd == null || c.precio_usd < f.precioMinUsd)) return false;
  if (f.precioMaxUsd != null && (c.precio_usd == null || c.precio_usd > f.precioMaxUsd)) return false;
  if (f.cubMin != null && (c.m2_homog == null || c.m2_homog < f.cubMin)) return false;
  if (f.cubMax != null && (c.m2_homog == null || c.m2_homog > f.cubMax)) return false;
  if (f.padronMin != null && (c.m2_padron == null || c.m2_padron < f.padronMin)) return false;
  if (f.padronMax != null && (c.m2_padron == null || c.m2_padron > f.padronMax)) return false;
  if (f.cochera === "si" && c.cochera !== true) return false;
  if (f.cochera === "no" && c.cochera !== false) return false;
  if (f.estado && c.estado !== f.estado) return false;
  // Renta / varias unidades (multi-select, OR). Nada elegido = no filtra.
  if (f.rentaSel && f.rentaSel.length) {
    var okR = false;
    if (f.rentaSel.indexOf("con") >= 0 && c.renta === true) okR = true;
    if (f.rentaSel.indexOf("sin") >= 0 && c.renta === false) okR = true;
    if (f.rentaSel.indexOf("multi") >= 0 && c.multiunidad === true) okR = true;
    if (!okR) return false;
  }
  if (f.gastosMinUsd != null && c.gastos_usd != null && c.gastos_usd < f.gastosMinUsd) return false;
  if (f.gastosMaxUsd != null && c.gastos_usd != null && c.gastos_usd > f.gastosMaxUsd) return false;
  return true;
}

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
    if (det && det.slug) {
      return {
        estado: (det.listingStatus || {}).value || "active",
        precio: typeof det.price === "number" ? det.price : null,
        moneda: (det.currency || {}).value || "",
      };
    }
    // data null: distinguir "borrada de verdad" de un hipo pasajero. RE/MAX manda un
    // mensaje explícito ("No se encuentra propiedad con slug…") SOLO cuando ya no existe.
    // Sin ese mensaje (respuesta rara/vacía), devolvemos null = no tocar, no falsa alarma.
    const msg = String((d && d.message) || "");
    if (d && d.data === null && /no se encuentra propiedad/i.test(msg)) {
      return { estado: "baja", precio: null, moneda: "" };
    }
    return null;
  } catch (e) { return null; }
}
function fmtPrecio(n, moneda) {
  const s = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return ((moneda || "").toUpperCase() === "UYU" ? "$U " : "USD ") + s;
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
  const headers = {
    "User-Agent": ua || UA_NAVEGADOR,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-UY,es;q=0.9,en;q=0.8",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Dest": "document",
    "Upgrade-Insecure-Requests": "1",
  };
  // Hasta 2 intentos: ML a veces tira 429/503 al bot (rate-limit pasajero).
  for (let intento = 0; intento < 2; intento++) {
    const r = await fetch(target, { headers, cf: { cacheTtl: 0 } });
    if (r.ok) return await r.text();
    if (intento === 0 && (r.status === 429 || r.status === 503)) {
      await new Promise((res) => setTimeout(res, 500));
      continue;
    }
    throw new Error("HTTP " + r.status);
  }
}

// ------------------------------ Utilidades ------------------------------
const SIN_COCHERA_RE = /sin\s+(cochera|garaj|garage)/i;
const COCHERA_RE = /(cochera|garaj|garage|\bgge\b)/i;

// "Con renta" = vendida CON inquilino adentro (ocupación real), NO potencial de renta.
// Señales de OCUPACIÓN (específicas para no marcar "ideal para renta", "rentabilidad",
// "genera renta", "desocupada", "se alquila"). Mismo criterio que el robot.
function sinAcento(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
const RENTA_POS = /(con renta|c\/ ?renta|rentad[oa]s?|ya alquilad|tiene renta|(actualmente|se encuentra|esta) alquilad|alquilad[oa]s? (hasta|desde|por|en)|con inquilin|contrato de alquiler vigente)/;
// "con renta" de marketing (invertir/vivir con renta = potencial) vs ocupación real.
const RENTA_MKT = /(vivir|invertir|inversion|ideal|oportunidad|posibilidad|opcion)(\W+\w+){0,2}\W+con renta/;
const RENTA_FUERTE = /alquilad|rentad[oa]|con inquilin|contrato de alquiler|tiene renta/;
function tieneRenta(texto) {
  const t = sinAcento(texto);
  if (!RENTA_POS.test(t)) return false;
  if (RENTA_MKT.test(t) && !RENTA_FUERTE.test(t)) return false;   // marketing sin ocupación real
  return true;
}

// Número uruguayo: "120.000" = ciento veinte mil; "1.234,5" = mil doscientos…; "54,5"=54,5.
// Ojo: sin coma, un solo punto con 1-2 dígitos detrás es DECIMAL ("54.5"), no miles.
function numUY(s) {
  if (s == null) return null;
  const t = String(s).replace(/[^\d.,]/g, "");
  if (!t) return null;
  let n;
  if (t.indexOf(",") >= 0) n = Number(t.replace(/\./g, "").replace(",", "."));  // coma decimal
  else n = /^\d+\.\d{1,2}$/.test(t) ? Number(t) : Number(t.replace(/\./g, "")); // 54.5 vs 120.000
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
  if (out.dorm == null) { const md2 = desc.match(/(\d+)\s*dormitorio/i); if (md2) out.dorm = toInt(md2[1]); }
  const head = (titulo.split(/\s[-–]\s/)[0] || "")
    .replace(/^\s*(alquiler|venta)\s+/i, "")
    .replace(/^\s*\S+\s+/, "")                              // saca la palabra del tipo
    .replace(/^\s*\d+\s+dormitorios?\s+/i, "");             // saca "N Dormitorios"
  // Barrio del breadcrumb JSON-LD (limpio, es el último tramo); si no, el recorte del
  // título (respaldo, suele salir sucio porque el vendedor pone el título a mano).
  out.barrio = barrioBreadcrumb(html, true) || head.trim();

  // m² de la descripción, distinguiendo total/terreno de construido/edificado (el vendedor
  // suele poner los dos); si no hay etiqueta, el primer "N m²" como construido (respaldo).
  const mC = desc.match(/(?:constru\w*|edificad\w*|cubiert\w*)[^\d]{0,12}(\d+(?:[.,]\d+)?)\s*m/i);
  const mT = desc.match(/(?:total|terreno)[^\d]{0,12}(\d+(?:[.,]\d+)?)\s*m/i);
  if (mC) out.m2_construidos = numUY(mC[1]);
  if (mT) out.m2_totales = numUY(mT[1]);
  if (out.m2_construidos == null) {
    const m2 = desc.match(/(\d+(?:[.,]\d+)?)\s*m²/i) || desc.match(/(\d+)\s*m2\b/i);
    if (m2) out.m2_construidos = numUY(m2[1]);
  }

  const texto = titulo + " " + desc;
  out.cochera = cocheraDe(texto, null);
  out.estado = estadoDe(texto, null);
  out.renta = tieneRenta(texto);
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
    // Estado del NODO (no de toda la página, que da falsos "a estrenar" de otras props).
    // InfoCasas lo trae en `antiquity` (0 = a estrenar) y `construction_year` (año futuro
    // = pozo). Los campos construction_state_name/condition casi nunca existen.
    const antiguedad = pick(nodo, ["antiquity", "antiguedad"]);
    const anioCon = toInt(pick(nodo, ["construction_year", "constructionYear"]));
    const est = String(pick(nodo, ["construction_state_name", "constructionState", "condition"]) || "");
    out.estado = estadoDe(est, antiguedad != null ? Number(antiguedad) : null);
    // Año de construcción de ESTE año o futuro = obra nueva / pozo → a estrenar.
    if (out.estado !== "a_estrenar" && anioCon && anioCon >= new Date().getFullYear())
      out.estado = "a_estrenar";
    // Renta: título + descripción del NODO (no toda la página). Detector de ocupación.
    const descNodo = String(pick(nodo, ["description", "descripcion", "longDescription"]) || "");
    out.renta = tieneRenta(titulo + " " + descNodo);
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
  out.renta = out.renta || tieneRenta(titulo);   // ya lo pudo marcar el nodo (título+desc)
  out.barrio = barrioInfoCasas(html);
  return out;
}

// Barrio desde el "camino de migas" (breadcrumb JSON-LD): el barrio es el tramo que sigue
// a Montevideo/Canelones. En InfoCasas hay un tramo más después (la propiedad) → NO tomar
// el último. En MercadoLibre el barrio ES el último → permitirUltimo=true.
function barrioBreadcrumb(html, permitirUltimo) {
  var bloques = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (var i = 0; i < bloques.length; i++) {
    var cuerpo = bloques[i].replace(/^[\s\S]*?>/, "").replace(/<\/script>\s*$/i, "");
    var data; try { data = JSON.parse(cuerpo); } catch (e) { continue; }
    var arr = Array.isArray(data) ? data : [data];
    for (var j = 0; j < arr.length; j++) {
      var d = arr[j];
      if (!d || d["@type"] !== "BreadcrumbList" || !Array.isArray(d.itemListElement)) continue;
      var items = d.itemListElement.map(function (e) {
        return String((e && (e.name || (e.item && e.item.name))) || "").trim();
      });
      var tope = permitirUltimo ? items.length - 1 : items.length - 2;
      for (var k = 0; k < items.length; k++) {
        if (/^(montevideo|canelones)$/i.test(items[k]) && k + 1 <= tope && items[k + 1])
          return items[k + 1];
      }
    }
  }
  // Respaldo (InfoCasas): link del breadcrumb /(venta|alquiler)/<tipo>/(mvd|can)/<barrio>.
  var m = html.match(/\/(?:venta|alquiler)\/[^\/"']+\/(?:montevideo|canelones)\/([a-z0-9\-]+)/i);
  if (m && !/^\d/.test(m[1])) return m[1].replace(/-/g, " ").trim();
  return "";
}
function barrioInfoCasas(html) { return barrioBreadcrumb(html, false); }

// Recorre el árbol y devuelve el primer objeto que "parece" una propiedad.
function buscarPropiedad(root) {
  const vistos = new Set();
  const cola = [root];
  while (cola.length) {
    const x = cola.shift();
    if (!x || typeof x !== "object" || vistos.has(x)) continue;
    vistos.add(x);
    const keys = Object.keys(x);
    // Excluir claves de PROMEDIO (avg_price / avg_price_m2 = nodo de estadísticas de la
    // zona, un señuelo que cumpliría la heurística y devolvería precio/m² de la ZONA).
    const noProm = (k) => !/avg|average|promed/i.test(k);
    const tieneM2 = keys.some((k) => /m2|surface|superficie|terrain|built/i.test(k) && noProm(k));
    const tienePrecio = keys.some((k) => /price|precio|amount/i.test(k) && noProm(k));
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
