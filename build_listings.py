"""Robot diario: baja las propiedades de RE/MAX (Montevideo + Canelones), entra al
detalle de cada una y arma un archivo liviano (listings.json) con TODO precalculado
para que la web app del celu filtre parecidas al instante.

Precalcula, con la MISMA cuenta que Auto-Meta (homogeneización v2 validada con Juan):
- m2_homog: superficie homogeneizada = construido + semicubierto·0,4 + descubierto·coef
- m2_padron: el terreno del padrón (dimensionLand)
- cochera (sí/no) y estado (usada / a_estrenar), que solo viven en el detalle.

Sin secretos: la API de RE/MAX es pública. Amable: pausa corta entre pedidos.
Uso:  python build_listings.py            (todo Mvd+Canelones, ~2500, tarda)
      LIMIT=25 python build_listings.py   (prueba rápida con 25)
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
import urllib.request

# "Con renta" (vendida con inquilino) no es un campo de RE/MAX: viene en el título
# ("con renta", "renta 6%", "rentado", "alquilada", "ocupada"…).
RENTA_RE = re.compile(r"(renta|rentad|alquilad|ocupad)", re.I)
# Cochera: RE/MAX carga mal parkingSpaces (muchos ponen 0 teniendo cochera). Se
# refuerza con el texto ("lo positivo gana"), cuidando el "sin cochera/garaje".
COCHERA_RE = re.compile(r"(cochera|garaj|garage|\bgge\b)", re.I)
SIN_COCHERA_RE = re.compile(r"sin\s+(cochera|garaj|garage)", re.I)


def _tiene_renta(titulo: str) -> bool:
    return bool(RENTA_RE.search(titulo or ""))


def _dice_cochera(texto: str) -> bool:
    t = texto or ""
    return bool(COCHERA_RE.search(t)) and not SIN_COCHERA_RE.search(t)

API = "https://api-ar.redremax.com/remaxweb-uy/api/listings"
LIST_EP = API + "/findAllWithEntrepreneurships"
DET_EP = API + "/findBySlug/"
CDN = "https://d1acdg20u0pmxj.cloudfront.net/"
LISTING_URL = "https://www.remax.com.uy/listings/"
PAGE_SIZE = 100
DEPTOS_OK = {"montevideo", "canelones"}


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
    if es_apto:
        d = max(0, descub) if descub is not None else max(0, total - construido - semi)
    elif descub is not None:
        d = max(0, descub)
    elif terreno >= construido + semi and terreno > 0:
        d = terreno - construido - semi
    else:
        d = 0
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
    "regimen de p.h.", "regimen ph",
]

_MULTI_POSITIVAS = [
    # "X principal" (implica que existe otra)
    "casa principal", "casa princial", "vivienda principal", "unidad principal",
    "apartamento principal", "apto principal", "depto principal", "propiedad principal",
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
    # categóricos
    "vivienda multifamiliar", "viviendas multifamiliares", "multifamiliar",
    "bifamiliar", "trifamiliar", "doble vivienda", "triple vivienda", "complejo de casas",
    "unidades independientes", "viviendas independientes", "casas independientes",
    "totalmente independientes",
    # idiomáticos uruguayos
    "casa al frente y al fondo", "casa adelante y atras", "casa adelante y casa atras",
    "frente y fondo",
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
_MULTI_COMBO_A = ["casa al frente", "casa adelante", "casa de adelante", "vivienda al frente"]
_MULTI_COMBO_B = ["apto al fondo", "apartamento al fondo", "casa al fondo", "casita al fondo",
                  "monoambiente al fondo", "unidad al fondo", "segunda unidad", "unidad trasera",
                  "segunda casa", "apartamento trasero", "casa trasera"]

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
    if any(a in t for a in _MULTI_COMBO_A) and any(b in t for b in _MULTI_COMBO_B):
        return True                         # combinación frente + otra-unidad
    return False


def _fila(it: dict, det: dict | None, rate: float | None = None) -> dict:
    tipo = (it.get("type") or {}).get("value") or ""
    es_apto = tipo.startswith("departamento") or tipo == "ph" or "penthouse" in tipo
    slug = it.get("slug") or ""
    src = det or it   # el detalle es más completo; si falló, uso el listón
    cubiertos = src.get("dimensionCovered")
    totales = src.get("dimensionTotalBuilt")
    terreno = src.get("dimensionLand")
    semi = det.get("dimensionSemicovered") if det else None
    descub = det.get("dimensionUncovered") if det else None
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
    return {
        "id": it.get("id"),
        "slug": slug,
        "link": LISTING_URL + slug if slug else "",
        "titulo": it.get("title") or "",
        "tipo": tipo,
        "operacion": (it.get("operation") or {}).get("value") or "",
        "precio": it.get("price"),
        "moneda": (it.get("currency") or {}).get("value") or "",
        "precio_usd": _precio_usd(it.get("price"),
                                  (it.get("currency") or {}).get("value"), rate),
        "dorm": it.get("bedrooms"),
        "banos": banos_tot,   # baños + toilet (total)
        "multiunidad": es_multiunidad(texto),   # varias viviendas en un mismo padrón
        "m2_homog": _homog(cubiertos, totales, terreno, es_apto, semi, descub),
        "m2_padron": round(terreno) if terreno else 0,   # el terreno del padrón
        "barrio": _barrio(it.get("geoLabel")),
        "depto": _depto(it.get("geoLabel")),
        "direccion": (det.get("displayAddress") if det else "") or "",
        "foto": _foto(it.get("photos")),
        "agente_id": (it.get("associate") or {}).get("id") or "",
        "agente": (it.get("associate") or {}).get("name") or "",
        "agente_tel": _tel_agente(it.get("associate") or {}),
        "estado": "a_estrenar" if a_estrenar else ("usada" if det else ""),
        # Estado de publicación: active | reserved | negotiation. Solo 'active' se
        # ofrece como parecida (reservada/en negociación NO están habilitadas).
        "estado_pub": (it.get("listingStatus") or {}).get("value") or "active",
        "renta": _tiene_renta(it.get("title") or ""),   # vendida con inquilino
        "cochera": cochera,          # True/False, o None si no se pudo leer el detalle
        # Gastos comunes (expensas): casi siempre en pesos. Solo si > 0.
        "gastos": gastos,
        "gastos_moneda": exp_cur if gastos else "",
        "gastos_usd": _precio_usd(gastos, exp_cur, rate),
        "detalle_ok": det is not None,
    }


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
    print("Bajando el listón…", file=sys.stderr)
    listado = bajar_listado()
    mvd_can = [it for it in listado
               if _depto(it.get("geoLabel")).lower() in DEPTOS_OK]
    print(f"Listón: {len(listado)} total, {len(mvd_can)} en Mvd+Canelones",
          file=sys.stderr)
    if limite:
        mvd_can = mvd_can[:limite]
        print(f"(prueba: solo {len(mvd_can)})", file=sys.stderr)
    rate = _usd_rate()
    print(f"Dólar: {rate}", file=sys.stderr)
    filas, fallidos = [], 0
    for i, it in enumerate(mvd_can, 1):
        det = _fetch_detalle(it.get("slug") or "")
        if det is None:
            fallidos += 1
        filas.append(_fila(it, det, rate))
        if i % 100 == 0:
            print(f"  detalle {i}/{len(mvd_can)} (fallidos {fallidos})",
                  file=sys.stderr)
        time.sleep(0.25)   # amable con la API
    out = {"listings": filas, "usd_rate": rate, "total": len(filas)}
    with open("listings.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"OK: {len(filas)} propiedades ({fallidos} sin detalle) -> listings.json")


if __name__ == "__main__":
    main()
