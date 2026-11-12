"""Robot diario: baja las propiedades de RE/MAX (todo Uruguay, todas las oficinas), entra al
detalle de cada una y arma un archivo liviano (listings.json) con TODO precalculado
para que la web app del celu filtre parecidas al instante.

Precalcula, con la MISMA cuenta que Auto-Meta (homogeneización v2 validada con Juan):
- m2_homog: superficie homogeneizada = construido + semicubierto·0,4 + descubierto·coef
- m2_padron: el terreno del padrón (dimensionLand)
- cochera (sí/no) y estado (usada / a_estrenar), que solo viven en el detalle.

Sin secretos: la API de RE/MAX es pública. Amable: pausa corta entre pedidos.
Uso:  python build_listings.py            (todo Uruguay, todas las oficinas, ~3500, tarda)
      LIMIT=25 python build_listings.py   (prueba rápida con 25)
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request

# "Con renta" = vendida CON inquilino adentro (OCUPACIÓN real), no potencial de renta.
# Se lee de título + descripción. Señales específicas para NO marcar "ideal para renta",
# "rentabilidad", "genera renta", "desocupada", "se alquila" (que son potencial/oferta).
RENTA_POS_RE = re.compile(
    r"(con renta|c/ ?renta|rentad[oa]s?|arrendad[oa]s?|ya alquilad|tiene renta|"
    r"(actualmente|se encuentra|esta) alquilad|alquilad[oa]s? (hasta|desde|por|en|actualmente)|"
    r"(todos|ambos|ambas|locales?|unidades?|apartamentos?)\W+(comerciales?\W+)?alquilad|"
    r"\(alquilad|con inquilin|contrato de alquiler vigente)", re.I)


def _sin_acentos(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


# Hectáreas en el texto → m² (1 ha = 10.000). Entiende "3Ha", "5 has", "2 hectáreas".
# (?![a-z]) evita agarrar "3 hab" (habitaciones).
def _hectareas_m2(texto: str):
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(hectareas?|has?)(?![a-z])", _sin_acentos(texto))
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    return round(n * 10000) if n > 0 else None
# Cochera: RE/MAX carga mal parkingSpaces (muchos ponen 0 teniendo cochera). Se
# refuerza con el texto ("lo positivo gana"), cuidando el "sin cochera/garaje".
COCHERA_RE = re.compile(r"(cochera|garaj|garage|\bgge\b)", re.I)
SIN_COCHERA_RE = re.compile(r"sin\s+(cochera|garaj|garage)", re.I)


# "con renta" en sentido marketing (invertir/vivir con renta = potencial, no ocupada).
RENTA_MKT_RE = re.compile(r"(vivir|invertir|inversion|ideal|oportunidad|posibilidad|opcion)"
                          r"(\W+\w+){0,2}\W+con renta")
# Señal FUERTE de ocupación real (si está, gana aunque haya marketing cerca).
RENTA_FUERTE_RE = re.compile(r"alquilad|arrendad|rentad[oa]|con inquilin|contrato de alquiler|tiene renta")
# Título en sentido marketing (para no marcar un "con renta" de título que igual es potencial).
_TITULO_MKT_RE = re.compile(r"(ideal|invertir|inversion|vivir|oportunidad|para renta|posibilidad|opcion)")


def _tiene_renta(texto: str, titulo: str = "") -> bool:
    t = _sin_acentos(texto or "")
    tit = _sin_acentos(titulo or "")
    # "con renta" en el TÍTULO = señal DURA (RE/MAX lo pone cuando la vende ALQUILADA), salvo que
    # el título mismo sea marketing. No la apaga el supresor global (antes se perdían esas ventas).
    if ("con renta" in tit) and not _TITULO_MKT_RE.search(tit):
        return True
    if not RENTA_POS_RE.search(t):
        return False
    # Si la única señal es "con renta" en sentido marketing y no hay ocupación real, no marcar.
    if RENTA_MKT_RE.search(t) and not RENTA_FUERTE_RE.search(t):
        return False
    return True


# Menciones de cochera que NO son de la propiedad (auditoría 2026-11-11): "posibilidad de alquilar cochera",
# "cocheras disponibles desde USD…", "hoy funciona como cochera", "cochera opcional / aparte"…
COCHERA_AJENA_RE = re.compile(
    r"posibilidad\s+de\s+(?:alquilar|comprar|adquirir|tener|agregar)?\s*(?:una\s+)?(?:cochera|garaj|garage)"
    r"|(?:cochera|garaj|garage)(?:e|es|s)?\s+(?:opcional|disponibles?|aparte|por\s+separado|adicional(?:es)?|con\s+costo|extra|en\s+alquiler|a\s+la\s+venta|en\s+venta)"
    r"|(?:cochera|garaj|garage)(?:e|es|s)?\s+(?:\w+\s+){0,2}desde"
    r"|funciona\s+como\s+(?:cochera|garaj|garage)"
    r"|se\s+(?:vende|alquila)n?\s+(?:la\s+|una\s+)?(?:cochera|garaj|garage)"
    r"|opci[oó]n\s+(?:a|de)\s+(?:cochera|garaj|garage)", re.I)


def _dice_cochera(texto: str) -> bool:
    t = texto or ""
    if SIN_COCHERA_RE.search(t):
        return False
    return bool(COCHERA_RE.search(COCHERA_AJENA_RE.sub(" ", t)))

API = "https://api-ar.redremax.com/remaxweb-uy/api/listings"
LIST_EP = API + "/findAllWithEntrepreneurships"
DET_EP = API + "/findBySlug/"
# Los emprendimientos (obra nueva) tienen OTRA ficha: la de propiedades responde "No se encuentra" (auditoría 2026-11-11).
ENT_DET_EP = "https://api-ar.redremax.com/remaxweb-uy/api/entrepreneurships/findBySlug/"


def url_ficha(it: dict) -> str:
    return (ENT_DET_EP if it.get("entrepreneurship") else DET_EP) + (it.get("slug") or "")
CDN = "https://d1acdg20u0pmxj.cloudfront.net/"
LISTING_URL = "https://www.remax.com.uy/listings/"
PAGE_SIZE = 100


def _http_json(url: str, timeout: float = 30.0):
    req = urllib.request.Request(url, headers={"User-Agent": "parecidas/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _unwrap(d):
    data = d.get("data") if isinstance(d, dict) else d
    if isinstance(data, dict) and "data" in data:
        return data["data"]
    return data


def _get_pagina(page: int) -> list:
    d = _http_json(f"{LIST_EP}?page={page}&pageSize={PAGE_SIZE}&sort=-createdAt")
    data = _unwrap(d)
    return data if isinstance(data, list) else []


def _tel_agente(assoc: dict) -> str:
    """Celular del agente que carga la propiedad (de la ficha, no del associate del
    link compartido). Toma el primario/móvil y lo limpia de espacios."""
    phones = (assoc or {}).get("phones") or []
    prim = (next((p for p in phones if p and (p.get("primary") or p.get("isPrimary"))), None)
            or next((p for p in phones if p and p.get("type") == "mobile"), None)
            or (phones[0] if phones else None))
    val = (prim or {}).get("value") or ""
    return re.sub(r"\s+", "", str(val)) if val else ""


def _barrio(geo):
    return (geo or "").split(",")[0].strip()


def _depto(geo):
    partes = [p.strip() for p in (geo or "").split(",") if p.strip()]
    return partes[-1] if partes else ""


def _foto(photos):
    if not photos:
        return ""
    p0 = photos[0]
    if isinstance(p0, dict):
        raw = p0.get("value") or p0.get("rawValue") or p0.get("url") or ""
    elif isinstance(p0, str):
        raw = p0
    else:
        raw = ""
    if not raw:
        return ""
    # El CDN necesita la extensión: `value` ya trae .jpg; `rawValue` no → se la agrego.
    if not raw.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
        raw += ".jpg"
    return raw if raw.startswith("http") else CDN + raw.lstrip("/")


# ---- Homogeneización de superficie (idéntica a Auto-Meta mercado_metricas) ----
def _coef_descubierto(descub: float, construido: float) -> float:
    if construido <= 0 or descub <= 0:
        return 0.22
    r = descub / construido
    if r <= 1:
        return 0.25
    if r <= 3:
        return 0.22
    if r <= 8:
        return 0.20
    return 0.18


def _homog(cubiertos, totales, terreno, es_apto, semi, descub) -> int:
    """Superficie homogeneizada: construido + semicubierto·0,4 + descubierto·coef.
    - cubiertos = dimensionCovered (construido, el ancla)
    - totales   = dimensionTotalBuilt (para deducir el patio de un apto si no hay real)
    - terreno   = dimensionLand (el padrón/lote, para el patio de una casa)
    - semi/descub = semicubierto/descubierto REALES del detalle (None si no hay)."""
    construido = cubiertos or 0
    semi = semi or 0
    total = totales or 0
    terreno = terreno or 0
    # Patio / jardín / terraza (descubierto): el que cargó el agente; si vino en 0 o vacío (RE/MAX manda 0 cuando
    # no lo completaron), se DEDUCE siempre: apto = total − construido − semi; casa = terreno − construido − semi
    # (Juan 2026-11-12: "si hay un terreno gigante y un construido chico es obvio que hay descubierto"). Esto es
    # solo para ANALIZAR (homogeneizado); los filtros usan los metros reales (m2_cub, m2_padron).
    if descub:
        d = max(0, descub)
    elif es_apto:
        d = max(0, total - construido - semi)
    else:
        d = max(0, terreno - construido - semi) if (terreno > 0 and construido + semi > 0) else 0   # terreno baldío: no hay "patio"
    x = construido + semi * 0.4 + d * _coef_descubierto(d, construido)
    return round(x) if x > 0 else 0


def _usd_rate() -> float | None:
    """Cotización del dólar (UYU por USD) para comparar precios en una sola moneda.
    Best-effort: si falla, se deja en None (los pesos quedan sin convertir)."""
    for url in ("https://uy.dolarapi.com/v1/cotizaciones/usd",
                "https://dolarapi.com/v1/cotizaciones/usd"):
        try:
            d = _http_json(url, timeout=15)
            venta = d.get("venta") or d.get("compra")
            if venta and float(venta) > 0:
                return float(venta)
        except Exception:
            continue
    return None


def _precio_usd(precio, moneda, rate):
    if not precio:
        return None
    if (moneda or "").upper() == "USD":
        return round(precio)
    if rate:
        return round(precio / rate)
    return None


def _fetch_detalle(slug: str):
    try:
        return _unwrap(_http_json(DET_EP + slug, timeout=20))
    except Exception:
        return None


def _fetch_ficha(it: dict):
    """La ficha correcta según sea propiedad común o emprendimiento."""
    try:
        return _unwrap(_http_json(url_ficha(it), timeout=20))
    except Exception:
        return None


def _coords_item(it: dict):
    c = ((it or {}).get("location") or {}).get("coordinates")
    return (c[1], c[0]) if (isinstance(c, list) and len(c) >= 2) else None


# Uruguay (con margen): lo que cae fuera es una ubicación mal cargada (ej. en el mar).
def _en_uruguay(lat, lng) -> bool:
    return lat is not None and lng is not None and -35.2 <= lat <= -30.0 and -58.6 <= lng <= -53.0


def barrios_conocidos() -> dict:
    """Los barrios que conoce la app (window.GRUPOS de barrios.js, agrupados por departamento con "// ---- X ----"):
    {nombre sin acentos: (nombre, departamento)}. Sirve para reconocer en el título un barrio que hoy no tiene
    ninguna propiedad cargada con zona (ej. "Flor de Maroñas")."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "barrios.js"), encoding="utf-8") as f:
            txt = f.read()
    except OSError:
        return {}
    ini = txt.find("window.GRUPOS")
    fin = txt.find("];", ini)
    out, depto = {}, ""
    for linea in txt[ini:fin].splitlines():
        m = re.search(r"//\s*-+\s*([^-]+?)\s*-+", linea)
        if m:
            depto = m.group(1).strip()
            continue
        if linea.strip().startswith("//") or not depto:
            continue
        for nombre in re.findall(r'"([^"]+)"', linea):
            out.setdefault(_sin_acentos(nombre), (nombre, depto))
    return out


def rescatar_sin_zona(listado: list, props_uy: list, traer_ficha, coords_de, extra_barrios: dict | None = None) -> list:
    """RE/MAX a veces publica propiedades SIN zona (geoLabel vacío). Se rescatan por sus COORDENADAS, en todo
    el país (antes solo Montevideo + Canelones → se perdían las de Colonia, Lavalleja, Rocha…):
    - departamento = el de la propiedad CON zona más cercana;
    - barrio = el nombre de barrio de ESE departamento que aparezca en el título (el más largo: "Flor de Maroñas"
      gana a "Maroñas"; nunca un nombre que en realidad es un departamento); si no hay, el de la propiedad más
      cercana si está a menos de ~2 km; si no, queda sin barrio (pero con departamento y ubicación)."""
    deptos = {_sin_acentos(_depto(it.get("geoLabel"))) for it in props_uy}
    barrios = {}
    for it in props_uy:
        bn = _sin_acentos(_barrio(it.get("geoLabel")))
        if bn and bn not in deptos and bn not in barrios:
            barrios[bn] = it.get("geoLabel")
    for bn, (nombre, dep) in (extra_barrios or {}).items():   # los que conoce la app, aunque hoy no haya ninguno
        if bn and bn not in deptos and bn not in barrios:
            barrios[bn] = nombre + ", , " + dep
    puntos = [(c, it.get("geoLabel")) for it in props_uy for c in [coords_de(it)] if c]
    rescatadas = []
    for it in listado:
        if (it.get("geoLabel") or "").strip():
            continue
        c = coords_de(it)
        if not c:
            det = traer_ficha(it.get("slug") or "")
            cc = ((det or {}).get("location") or {}).get("coordinates")
            c = (cc[1], cc[0]) if (isinstance(cc, list) and len(cc) >= 2) else None
        if not c or not _en_uruguay(c[0], c[1]) or not puntos:
            continue
        lat, lng = c
        cerca = min(puntos, key=lambda q: (q[0][0] - lat) ** 2 + (q[0][1] - lng) ** 2)
        dep = _depto(cerca[1])
        depn, tn = _sin_acentos(dep), _sin_acentos(it.get("title") or "")
        gl = next((barrios[bn] for bn in sorted(barrios, key=len, reverse=True)
                   if _sin_acentos(_depto(barrios[bn])) == depn and re.search(r"\b" + re.escape(bn) + r"\b", tn)), None)
        if not gl:
            d2 = (cerca[0][0] - lat) ** 2 + (cerca[0][1] - lng) ** 2
            bcerca = _sin_acentos(_barrio(cerca[1]))
            gl = cerca[1] if (d2 <= 0.02 ** 2 and bcerca and bcerca not in deptos) else ", , " + dep
        it["geoLabel"] = gl
        rescatadas.append(it)
    return rescatadas


# ------------------------- HISTORIAL (Juan 2026-11-11) -------------------------
# Las reservadas / en negociación son precios casi cerrados, y las que DEJAN DE PUBLICARSE estando así son, casi
# seguro, una venta o alquiler concretado: el dato más valioso para el análisis de mercado. Se guardan en
# historial.json (aparte de listings.json, para que la app arranque liviana) y la información crece con el tiempo.
CAMPOS_HISTORIAL = ("operacion", "tipo", "barrio", "depto", "direccion", "lat", "lng", "estado_pub", "precio", "moneda",
                    "precio_usd", "periodo", "gastos_usd", "m2_homog", "m2_cub", "m2_total", "m2_padron", "dorm", "banos",
                    "cochera", "estado", "renta", "multiunidad")
DIAS_HISTORIAL = 3 * 365


def _para_historial(f: dict) -> dict:
    return {k: f.get(k) for k in CAMPOS_HISTORIAL}


def actualizar_historial(prev: dict, filas: list, hoy: str) -> dict:
    """- reservada / en negociación → se guarda (o actualiza) con `desde` (1ª vez) y `visto` (última vez);
    - vuelve a estar DISPONIBLE → se borra (la reserva se cayó: ese precio no se concretó);
    - deja de publicarse estando reservada / en negociación → `cerrada` = hoy (venta o alquiler concretado);
    - más de 3 años desde la última vez vista → se descarta."""
    hist = {k: dict(v) for k, v in (prev or {}).items()}
    vistos = {f.get("slug"): f for f in filas if f.get("slug")}
    for slug, f in vistos.items():
        if f.get("estado_pub") in ("reserved", "negotiation"):
            h = hist.get(slug, {})
            desde = h.get("desde") or hoy
            al_reservar = h.get("precio_al_reservar") if "precio_al_reservar" in h else f.get("precio_usd")
            h.update(_para_historial(f))
            h["desde"], h["visto"], h["precio_al_reservar"] = desde, hoy, al_reservar   # si baja negociando, queda
            h.pop("cerrada", None)
            hist[slug] = h
        elif slug in hist:
            del hist[slug]
    corte = (datetime.date.fromisoformat(hoy) - datetime.timedelta(days=DIAS_HISTORIAL)).isoformat()
    for slug in list(hist):
        h = hist[slug]
        if slug not in vistos and not h.get("cerrada"):
            h["cerrada"] = hoy
        if (h.get("visto") or h.get("desde") or hoy) < corte:
            del hist[slug]
    return hist


def sin_repetidos(filas: list) -> list:
    """RE/MAX a veces tiene 2 avisos con la MISMA dirección web (slug): se deja el primero."""
    vistos, out = set(), []
    for f in filas:
        if f.get("slug") in vistos:
            continue
        vistos.add(f.get("slug"))
        out.append(f)
    return out


# ------------------------- Detector de MULTI-UNIDAD (varias viviendas en un padrón) ---
# Conocimiento destilado del proyecto SerchJAO (validado contra avisos reales de MELI/
# InfoCasas). El orden IMPORTA: exclusiones primero (PH + edificio nuevo), después las
# señales positivas. Cada lista es una prueba que salió mal y se corrigió — no tocar sin
# medir contra avisos reales. Ver CONOCIMIENTO_MULTIUNIDAD_PADRON.md.

def _norm_multi(texto: str) -> str:
    """Minúsculas, sin tildes, números en letra→cifra, y separa cifra pegada a letra."""
    t = (texto or "").lower()
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")   # quita tildes
    nums = {"dos": "2", "tres": "3", "cuatro": "4", "cinco": "5", "seis": "6",
            "siete": "7", "ocho": "8", "nueve": "9"}
    t = re.sub(r"\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b",
               lambda m: nums[m.group(1)], t)
    t = re.sub(r"([2-9])([a-z])", r"\1 \2", t)                     # "2casas" -> "2 casas"
    return t

_MULTI_EXCLUIR = [
    # edificio nuevo / desarrollo
    "vivienda promovida", "viviendas promovidas",
    "ley 18.795", "ley n 18.795", "ley n18.795",
    "fideicomiso de construc", "fideicomiso construc",
    "amparado por la ley", "amparada por la ley", "amparado por proyecto de ley",
    "exoneracion de itp", "exoneracion del itp",
    "exoneracion de irpf", "exoneracion del irpf", "exoneracion de iva",
    "amenities", "ammenities",
    "apartamentos por piso", "apartamentos por pisos", "aptos por piso",
    "unidades por piso", "unidades por pisos",
    "cuenta con unidades", "unidades disponibles", "apartamentos disponibles",
    "totalidad del edificio", "edificio cuenta con", "el proyecto cuenta",
    "este desarrollo", "este proyecto",
    "entrega estimada", "entrega prevista", "entrega 202",
    "obra nueva", "en pozo", "venta en pozo", "preventa",
    "comercializamos la totalidad",
    # propiedad horizontal (descarta siempre)
    "regimen de propiedad horizontal", "bajo regimen de propiedad horizontal",
    "bajo propiedad horizontal", "en propiedad horizontal",
    "regimen de p.h.", "regimen ph", "regimen de ph", "propiedad horizontal",
    # falsos positivos verificados: la propiedad es UNA dentro de un conjunto, o "eran 2
    # y ahora es 1". El número ("4 casas") describe OTRAS unidades del complejo, no lo que
    # se vende. (Exclusiones corren PRIMERO, así ganan al patrón numérico.)
    "casas agrupadas", "complejo que cuenta", "predio compartido",
    "fueron unificadas", "unificadas en", "la ofrecida es", "propiedad ofrecida es la",
    "otras 2 casas", "otras 3 casas", "otras 4 casas", "otras 5 casas", "otras 6 casas",
]

_MULTI_POSITIVAS = [
    # OJO: "X principal" (casa/vivienda principal) NO va acá — en RE/MAX se usa para
    # describir LA construcción principal, no una segunda vivienda (80% falsos medidos).
    # Se movió a _MULTI_COMBO_A: solo cuenta si además hay "al fondo/segunda/trasera".
    # "la otra X" / "el otro X"
    "la otra casa", "la otra casita", "la otra vivienda", "la otra unidad",
    "la otra propiedad", "la otra finca", "el otro apartamento", "el otro apto",
    "el otro depto", "el otro monoambiente", "el otro local",
    # "X con/mas/+/y Y"
    "casa con apartamento", "casa con apto", "casa con depto", "casa con departamento",
    "casa con monoambiente",
    "casa mas apartamento", "casa mas apto", "casa mas depto", "casa mas monoambiente",
    "casa mas casita",
    "casa + apartamento", "casa + apto", "casa + depto",
    "casa y apartamento", "casa y apto", "casa y depto", "casa y monoambiente",
    "casa y casita",
    "casa con apartamentos", "casa con aptos", "casa con deptos", "casa con departamentos",
    "casa con monoambientes",
    "casa mas apartamentos", "casa + aptos", "casa y aptos",
    # padrón / terreno explícito (NO "padron unico" — ver documento)
    "mismo padron", "un mismo padron", "en el mismo padron", "en un mismo padron",
    "un solo padron",
    "mismo terreno", "en el mismo terreno", "en un mismo terreno",
    # categóricos ("complejo de casas" SACADO: en RE/MAX = barrio privado, comprás UNA)
    "vivienda multifamiliar", "viviendas multifamiliares", "multifamiliar",
    "bifamiliar", "trifamiliar", "doble vivienda", "triple vivienda",
    "unidades independientes", "viviendas independientes", "casas independientes",
    "propiedades independientes", "totalmente independientes",
    # apto/apartamento/monoambiente/vivienda "al fondo" (sueltos): los avisos reales dicen
    # "casa de 3 dorm y apartamento al fondo" sin decir "casa al frente". "casa al fondo"
    # NO va suelta (hay 1 falso: "esta casa al fondo ofrece…") → queda solo en combo.
    "apto al fondo", "apartamento al fondo", "monoambiente al fondo", "vivienda al fondo",
    # idiomáticos uruguayos ("frente y fondo" SOLO = ruido: jardín/patio/terreno al
    # frente y fondo. Medido en RE/MAX: ~90% falsos. Queda el inequívoco "casa al ...").
    "casa al frente y al fondo", "casa adelante y atras", "casa adelante y casa atras",
    # rentas múltiples (números ya en cifra)
    "2 rentas", "3 rentas", "4 rentas",
    "ideal 2 rentas", "ideal 3 rentas", "ideal 4 rentas",
    "ideal para 2 rentas", "ideal para 3 rentas", "ideal para 4 rentas",
    "para 2 rentas", "para 3 rentas", "para 4 rentas",
    # familias
    "2 familias", "3 familias", "4 familias",
    "para 2 familias", "para 3 familias", "para 4 familias",
]

_MULTI_NUM_OK = {"casas", "casitas"}   # patrón "N <sustantivo>" solo con casas/casitas
_MULTI_COMBO_A = ["casa al frente", "casa adelante", "casa de adelante", "vivienda al frente",
                  "casa principal", "casa princial", "vivienda principal", "propiedad principal",
                  "unidad principal"]
_MULTI_COMBO_B = ["apto al fondo", "apartamento al fondo", "casa al fondo", "casita al fondo",
                  "monoambiente al fondo", "unidad al fondo", "segunda unidad", "unidad trasera",
                  "segunda casa", "apartamento trasero", "casa trasera"]
# Segunda vivienda pegada con "+" o "mas" (casa + apto, casa mas monoambiente). Corren DESPUÉS de
# las exclusiones, así los edificios/PH no entran. Medido: recupera ~15 reales, 0 falsos positivos.
_MULTI_POS_RX = [
    re.compile(r"\bmas\s+(aptos?|apartamentos?|monoambientes?|casita)\b"),
    re.compile(r"\+\s*(aptos?|apartamentos?|monoambientes?|casita)\b"),
]
# Bloques de renta numéricos ("casa + 4 apartamentos", "venta 3 apartamentos", "opcion 2 viviendas",
# "padron unico con 7 unidades"). Exigen SUSTANTIVO tras el número (si no, agarran m²/dormitorios).
_MULTI_NUM_RX = [
    re.compile(r"\bcasa\s+\+\s*[2-9]?\s*(apartamentos?|aptos?)\b"),
    re.compile(r"\bcasa\b[^.]{0,15}\bmas\s+[2-9]\s+(apartamentos?|aptos?)\b"),
    re.compile(r"\bopcion\s+[2-9]\s+(viviendas|casas|apartamentos?|aptos?)\b"),
    re.compile(r"\bventa\s+(de\s+)?[2-9]\s+apartamentos?\b"),
    re.compile(r"\bpadron unico\s+(con|de)\s+[2-9]\s+(unidades|viviendas|apartamentos?|aptos?|casas)\b"),
]

def es_multiunidad(texto: str):
    """True/False si el aviso describe varias viviendas en un mismo padrón. None si no
    hay texto que leer (no descartar: el robot re-lee mañana)."""
    t = _norm_multi(texto)
    if not t.strip():
        return None
    for ex in _MULTI_EXCLUIR:               # exclusiones PRIMERO
        if ex in t:
            return False
    for p in _MULTI_POSITIVAS:              # frases positivas fuertes
        if p in t:
            return True
    for m in re.finditer(r"\b([2-9])\s+([a-z]+)\b", t):   # patrón numérico restringido
        if m.group(2) in _MULTI_NUM_OK:
            return True
    for rx in _MULTI_POS_RX:                # "casa + apto" / "casa mas monoambiente"
        if rx.search(t):
            return True
    for rx in _MULTI_NUM_RX:                # "casa + 4 apartamentos", "padron unico con 7 unidades"
        if rx.search(t):
            return True
    if any(a in t for a in _MULTI_COMBO_A) and any(b in t for b in _MULTI_COMBO_B):
        return True                         # combinación frente + otra-unidad
    return False


# Terreno de un COMPLEJO/condominio: el padrón es de todo el conjunto, no de la unidad (ej. 1 dorm de 53 m² con
# "812 m² de terreno"). Si el texto lo dice y el terreno es más de 8 veces lo construido → dato dudoso (vacío).
COMPLEJO_RE = re.compile(r"\b(complejo|condominio)\b", re.I)


def _m2(x):
    """m² prolijos: entero si es redondo, si no con 1 decimal; None si no hay dato."""
    if not x or x <= 0:
        return None
    return int(x) if float(x).is_integer() else round(x, 1)


def _fila(it: dict, det: dict | None, rate: float | None = None) -> dict:
    tipo = (it.get("type") or {}).get("value") or ""
    es_apto = tipo.startswith("departamento") or tipo == "ph" or "penthouse" in tipo
    slug = it.get("slug") or ""
    src = det or it   # el detalle es más completo; si falló, uso el listón
    # Coordenadas para el mapa: RE/MAX las da en location.coordinates = [lng, lat] (GeoJSON).
    _loc = src.get("location") if isinstance(src.get("location"), dict) else {}
    _coords = _loc.get("coordinates") if isinstance(_loc.get("coordinates"), list) else None
    _lat = _coords[1] if (_coords and len(_coords) >= 2) else None
    _lng = _coords[0] if (_coords and len(_coords) >= 2) else None
    # Padrón: RE/MAX infla los campos (ej. "3 ha" → dimensionLand 300.000.000 basura). Si
    # el texto dice hectáreas y el dato es 0 o absurdo, uso las hectáreas (× 10.000).
    _terreno = src.get("dimensionLand") or 0
    _padron = round(_terreno) if _terreno else 0
    # Un apto NO tiene padrón propio: las "hectáreas" del texto son del complejo/barrio (auditoría 2026-11-11).
    _ha = None if es_apto else _hectareas_m2((it.get("title") or "") + " " + ((det.get("description") or "") if det else ""))
    # Dato gigante: si coincide con las hectáreas del texto (±10%) es REAL (campo de 948 ha); si no, está inflado.
    if _ha and (_padron <= 0 or (_padron > 5000000 and abs(_padron - _ha) > 0.1 * _ha)):
        _padron = _ha
    cubiertos = src.get("dimensionCovered")
    totales = src.get("dimensionTotalBuilt")
    terreno = src.get("dimensionLand")
    semi = det.get("dimensionSemicovered") if det else None
    descub = det.get("dimensionUncovered") if det else None
    if _padron and cubiertos and _padron > 8 * cubiertos and COMPLEJO_RE.search(
            _sin_acentos((it.get("title") or "") + " " + ((det.get("description") or "") if det else ""))):
        _padron = None   # el terreno es del complejo entero → falta el dato (la app no la descarta)
        terreno = 0      # …y tampoco hay patio propio que sumar al homogeneizado
    conds = [str((c or {}).get("value", "")).lower()
             for c in (det.get("conditions") or [])] if det else []
    a_estrenar = any("estrenar" in c or "construccion" in c for c in conds)
    texto = (it.get("title") or "") + " " + ((det.get("description") or "") if det else "")
    dice_coch = _dice_cochera(texto)
    cochera = None
    if det is not None:
        park = det.get("parkingSpaces")
        cochera = bool(park and park > 0) or dice_coch
    elif dice_coch:
        cochera = True   # sin detalle, pero el texto dice cochera
    exp_price = det.get("expensesPrice") if det else None
    exp_cur_raw = det.get("expensesCurrency") if det else None
    exp_cur = (exp_cur_raw.get("value") if isinstance(exp_cur_raw, dict)
               else (exp_cur_raw or ""))
    gastos = exp_price if (exp_price and exp_price > 0) else None
    # Total de baños = baños + toilet (el toilet cuenta como un baño más). El toilet
    # viene del detalle; sin detalle, usamos solo bathrooms (Juan 2026-08-14).
    _banos = it.get("bathrooms")
    _toilets = det.get("toilets") if det else None
    banos_tot = (((_banos or 0) + (_toilets or 0))
                 if (_banos is not None or _toilets is not None) else None)
    # foto: se guarda SIN el prefijo del CDN (la app lo repone) para achicar el archivo.
    # Si algún día una foto viene de otro host, se guarda entera (la app la usa tal cual).
    _foto_url = _foto(it.get("photos"))
    foto_out = _foto_url[len(CDN):] if _foto_url.startswith(CDN) else _foto_url
    # NOTA: `link` (= remax+slug), `titulo`, `agente_id` e `id` NO se guardan: la app no
    # los usa (el link lo reconstruye del slug). Ahorra ~40% del archivo.
    fila = {
        "slug": slug,
        "tipo": tipo,
        "operacion": (it.get("operation") or {}).get("value") or "",
        "precio": it.get("price"),
        "moneda": (it.get("currency") or {}).get("value") or "",
        "precio_usd": _precio_usd(it.get("price"),
                                  (it.get("currency") or {}).get("value"), rate),
        "dorm": it.get("bedrooms"),
        "banos": banos_tot,   # baños + toilet (total)
        "multiunidad": es_multiunidad(texto),   # varias viviendas en un mismo padrón
        # m² CONSTRUIDOS REALES (cubierto + semicubierto, lo techado): es lo que usan los FILTROS (Juan 2026-11-11).
        # El homogeneizado (con el patio ponderado) queda para ANALIZAR (orden de parecidas, estimador de alquiler).
        "m2_cub": _m2((cubiertos or 0) + (semi or 0)),
        "m2_homog": _homog(cubiertos, totales, terreno, es_apto, semi, descub),
        "m2_total": round(totales, 1) if isinstance(totales, (int, float)) and 0 < totales < 100000 else None,   # superficie total (para el filtro de m² de un apto)
        "m2_padron": _padron,   # el terreno del padrón (hectáreas → m² si RE/MAX lo infló)
        "barrio": _barrio(it.get("geoLabel")),
        "depto": _depto(it.get("geoLabel")),
        "lat": _lat, "lng": _lng,   # para el mapa
        "direccion": (det.get("displayAddress") if det else "") or "",
        "foto": foto_out,
        "agente": (it.get("associate") or {}).get("name") or "",
        "agente_tel": _tel_agente(it.get("associate") or {}),
        # entrepreneurship = emprendimiento/desarrollo (obra nueva) → SIEMPRE a estrenar. Su ficha
        # (findBySlug) FALLA siempre, así que sin esto quedaban con estado "" y el filtro "Usada"
        # los colaba (Juan 2026-08-18). a_estrenar también sale de conditions ("estrenar"/"construccion").
        "estado": "a_estrenar" if (a_estrenar or it.get("entrepreneurship")) else ("usada" if det else ""),
        # Estado de publicación: active | reserved | negotiation. Solo 'active' se
        # ofrece como parecida (reservada/en negociación NO están habilitadas).
        "estado_pub": (it.get("listingStatus") or {}).get("value") or "active",
        "renta": _tiene_renta(texto, it.get("title") or ""),   # vendida con inquilino (título = señal dura)
        "cochera": cochera,          # True/False, o None si no se pudo leer el detalle
        # Gastos comunes (expensas): casi siempre en pesos. Solo si > 0.
        "gastos": gastos,
        "gastos_moneda": exp_cur if gastos else "",
        "gastos_usd": _precio_usd(gastos, exp_cur, rate),
        "detalle_ok": det is not None,
        # Alquiler temporario: por qué período es el precio (daily/weekly/fortnightly/monthly). Sin esto se
        # comparaban USD 100 por día con USD 4.400 por quincena (auditoría 2026-11-11).
        "periodo": ((det or {}).get("billingFrequency") or {}).get("value") if isinstance((det or {}).get("billingFrequency"), dict) else None,
    }
    if det and ("minBedrooms" in det or "minPrice" in det):
        fila.update(_rangos_emprendimiento(det, es_apto, rate, texto))
    _sanear(fila, es_apto, tipo)
    return fila


def _rangos_emprendimiento(det: dict, es_apto: bool, rate, texto: str) -> dict:
    """Un emprendimiento ofrece varias unidades: se guardan los RANGOS (dormitorios, baños, precio "desde/hasta",
    m²). La app lo muestra si la búsqueda se superpone con el rango (ej. busca 3 dorm y ofrece 1 a 3)."""
    def num(k):
        v = det.get(k)
        return v if isinstance(v, (int, float)) else None

    def mon(k):
        v = det.get(k)
        return (v.get("value") if isinstance(v, dict) else v) or "USD"

    out = {}
    dmin, dmax = num("minBedrooms"), num("maxBedrooms")
    if dmin is not None:
        out["dorm"] = int(dmin)
        out["dorm_max"] = int(dmax) if (dmax is not None and dmax > dmin) else None
    bmin = (num("minBathrooms") or 0) + (num("minToiletrooms") or 0)
    bmax = (num("maxBathrooms") or 0) + (num("maxToiletrooms") or 0)
    if num("minBathrooms") is not None:
        out["banos"] = int(bmin)
        out["banos_max"] = int(bmax) if bmax > bmin else None
    pmin, pmax = num("minPrice"), num("maxPrice")
    if pmin:
        out["precio"], out["moneda"] = pmin, mon("minCurrency")
        out["precio_usd"] = _precio_usd(pmin, out["moneda"], rate)
        pmx = _precio_usd(pmax, mon("maxCurrency"), rate) if pmax else None
        out["precio_max_usd"] = pmx if (pmx and out["precio_usd"] and pmx > out["precio_usd"]) else None
    h1 = _homog(num("minDimensionCovered"), None, num("minDimensionLand"), es_apto,
                num("minDimensionSemicovered"), num("minDimensionUncovered"))
    h2 = _homog(num("maxDimensionCovered"), None, num("maxDimensionLand"), es_apto,
                num("maxDimensionSemicovered"), num("maxDimensionUncovered"))
    if h1:
        out["m2_homog"] = h1
        out["m2_homog_max"] = h2 if h2 > h1 else None
    c1 = _m2((num("minDimensionCovered") or 0) + (num("minDimensionSemicovered") or 0))
    c2 = _m2((num("maxDimensionCovered") or 0) + (num("maxDimensionSemicovered") or 0))
    if c1:
        out["m2_cub"] = c1
        out["m2_cub_max"] = c2 if (c2 and c2 > c1) else None
    out["cochera"] = bool((num("maxParkingSpaces") or 0) > 0) or _dice_cochera(texto)
    return out


def _sanear(fila: dict, es_apto: bool, tipo: str) -> None:
    """Datos absurdos cargados en RE/MAX → se guardan VACÍOS (la app los muestra como "Falta dato") en vez de
    usarlos como reales (auditoría 2026-11-11: monoambientes de 35.000 m², venta a USD 146, ubicación en el mar)."""
    vivienda = es_apto or tipo.startswith("casa") or tipo == "ph"
    if not fila.get("precio"):
        fila["precio"], fila["precio_usd"] = None, None
    p = fila.get("precio_usd")
    if p is not None and ((fila.get("operacion") == "sale" and p < 3000) or (fila.get("operacion") != "sale" and p < 50)):
        fila["precio_usd"] = None
    m = fila.get("m2_homog")
    if vivienda and (not m or (es_apto and m > 2000) or m > 20000):
        fila["m2_homog"] = None          # una vivienda con 0 m² es un dato que falta; 35.000 m² en un apto, un error
    mc = fila.get("m2_cub")
    if vivienda and (not mc or (es_apto and mc > 2000) or mc > 20000):
        fila["m2_cub"] = None
    if es_apto and (fila.get("m2_total") or 0) > 2000:
        fila["m2_total"] = None
    if not _en_uruguay(fila.get("lat"), fila.get("lng")):
        fila["lat"], fila["lng"] = None, None
    # Gastos comunes absurdos → vacíos (Juan 2026-11-11). Relativos al precio (las torres de lujo tienen gastos
    # altos de verdad): menos de USD 10 = relleno ("1 peso"); en venta, más del 1% del precio POR MES; en
    # alquiler anual, más que el propio alquiler.
    g, p = fila.get("gastos_usd"), fila.get("precio_usd")
    if g is not None and (g < 10 or (p and fila.get("operacion") == "sale" and g > 0.01 * p)
                          or (p and fila.get("operacion") == "rent" and g > p)):
        fila["gastos"], fila["gastos_moneda"], fila["gastos_usd"] = None, "", None


def bajar_listado() -> list:
    todo, page = [], 0
    while page < 200:
        items = _get_pagina(page)
        if not items:
            break
        todo.extend(items)
        if len(items) < PAGE_SIZE:
            break
        page += 1
        time.sleep(0.3)
    return todo


def main():
    limite = int(os.environ.get("LIMIT", "0"))
    dry = bool(os.environ.get("DRY_RUN"))   # prueba: corre todo pero NO escribe archivos
    print("Bajando el listón…", file=sys.stderr)
    listado = bajar_listado()
    # Cobertura NACIONAL: todas las propiedades con zona cargada, de cualquier departamento
    # (todas las oficinas de RE/MAX). Las que vienen sin zona las levanta el rescate (abajo).
    props_uy = [it for it in listado if (it.get("geoLabel") or "").strip()]
    # RESCATE: RE/MAX a veces publica propiedades SIN la zona cargada (geoLabel vacío) →
    # se descartaban aunque sean de Mvd/Can. Pero la UBICACIÓN (coordenadas) SIEMPRE está,
    # porque el agente la pone en el mapa al publicar. Así que uso las coordenadas para
    # decidir si es de Mvd/Can (más confiable que el título). El barrio lo saco del título
    # si nombra uno conocido; si no, queda sin barrio pero CON ubicación (mapa + botón 📍).
    _rescate = rescatar_sin_zona(listado, props_uy, _fetch_detalle, _coords_item, barrios_conocidos())
    props_uy.extend(_rescate)
    _rescatadas = len(_rescate)
    print(f"Listón: {len(listado)} total, {len(props_uy)} con zona (todo Uruguay) "
          f"(rescatadas sin zona, por coordenadas: {_rescatadas})", file=sys.stderr)
    if limite:
        props_uy = props_uy[:limite]
        print(f"(prueba: solo {len(props_uy)})", file=sys.stderr)
    rate = _usd_rate()
    print(f"Dólar: {rate}", file=sys.stderr)
    filas, fallidos = [], 0
    for i, it in enumerate(props_uy, 1):
        det = _fetch_ficha(it)   # emprendimientos: su propia ficha
        if det is None:
            fallidos += 1
        filas.append(_fila(it, det, rate))
        if i % 100 == 0:
            print(f"  detalle {i}/{len(props_uy)} (fallidos {fallidos})",
                  file=sys.stderr)
        time.sleep(0.25)   # amable con la API
    # ⚠️ RED DE SEGURIDAD: si el listado vino sospechosamente chico (un hipo de la API de
    # RE/MAX: responde 200 pero vacío/truncado), NO pisar el listings.json bueno NI borrar
    # el historial de primera_vez.json. Abortamos: mañana reintenta con los datos de ayer
    # intactos. (En modo prueba LIMIT sí puede ser chico a propósito, no aplica.)
    filas = sin_repetidos(filas)
    if not limite and len(filas) < 500:
        sys.exit(f"Listado sospechosamente chico ({len(filas)} props): no piso los archivos, reintenta la próxima corrida")
    # "Subida hace N días": RE/MAX NO publica la fecha de alta, así que el robot registra
    # la PRIMERA vez que ve cada propiedad en `primera_vez.json`. Es preciso DE ACÁ EN
    # ADELANTE: en la 1ª corrida todo queda "preexistente" (visto_desde=None, sin cartel);
    # las que aparezcan en corridas siguientes llevan la fecha real. (Juan 2026-08-14)
    _hoy = datetime.date.today().isoformat()
    try:
        with open("primera_vez.json", encoding="utf-8") as _f:
            _prev = json.load(_f)
    except FileNotFoundError:
        _prev = None                     # no existe = primera corrida (baseline)
    except Exception:
        _prev = {}
    _primera = _prev is None
    _prev = _prev or {}
    _mapa = {}
    for _row in filas:                   # OJO: NO usar '_fila' (choca con la función _fila())
        _slug = _row.get("slug")
        if not _slug:
            _row["visto_desde"] = None
            continue
        if _slug in _prev:
            _fecha = _prev[_slug]        # ya la conocíamos → su fecha original
        elif _primera:
            _fecha = None                # preexistente: no sabemos cuándo se subió
        else:
            _fecha = _hoy                # apareció NUEVA de verdad
        _mapa[_slug] = _fecha
        _row["visto_desde"] = _fecha
    if not dry:
        try:
            with open("primera_vez.json", "w", encoding="utf-8") as _f:
                json.dump(_mapa, _f, ensure_ascii=False)
        except Exception:
            pass

    try:
        with open("historial.json", encoding="utf-8") as _f:
            _hist_prev = json.load(_f)
    except Exception:
        _hist_prev = {}
    historial = actualizar_historial(_hist_prev, filas, _hoy)
    if not dry:
        with open("historial.json", "w", encoding="utf-8") as _f:
            json.dump(historial, _f, ensure_ascii=False)
    print(f"Historial: {sum(1 for h in historial.values() if h.get('cerrada'))} cerradas, "
          f"{sum(1 for h in historial.values() if not h.get('cerrada'))} reservadas/en negociación", file=sys.stderr)

    # `generado_at` = cuándo se armó el archivo. La app avisa si esto quedó viejo (robot caído).
    out = {"listings": filas, "usd_rate": rate, "total": len(filas), "generado_at": _hoy}
    if dry:
        print(f"DRY RUN OK: {len(filas)} propiedades (prueba, no se escribió nada)")
        return
    with open("listings.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"OK: {len(filas)} propiedades ({fallidos} sin detalle) -> listings.json")


if __name__ == "__main__":
    main()
