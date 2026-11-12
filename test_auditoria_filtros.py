"""AUDITORÍA DE FILTROS: la app tiene que encontrar el 100% de las propiedades que cumplen los filtros (y ninguna
que no los cumpla), en CADA filtro y en sus COMBINACIONES. Y el robot de avisos (worker/motor.js) tiene que
decidir exactamente lo mismo.

Cómo: un "verificador" escrito acá en Python, aparte de la app, que aplica las reglas acordadas con Juan sobre
los datos reales (listings.json). Para cada combinación: se maneja el FORMULARIO de la app (botones, casilleros,
barrios) como lo haría una persona, se lee lo que la app considera que cumple, y se compara propiedad por
propiedad con el verificador. Combinaciones: cada filtro solo (por operación), todos los pares de filtros, y
cientos de combinaciones al azar (semilla fija = siempre las mismas).

Pedido de Juan 2026-11-11: "que chequee filtro por filtro y sus distintas combinaciones así no ignoramos nada".
Uso: python test_auditoria_filtros.py
"""
from __future__ import annotations

import itertools
import json
import os
import random
import subprocess
import sys
import unicodedata

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva, CARPETA

# ----------------------------------------------------------------------------------------------------------
# REGLAS (lo acordado con Juan), escritas aparte de la app
# ----------------------------------------------------------------------------------------------------------
_ACENTOS = str.maketrans({"á": "a", "à": "a", "ä": "a", "é": "e", "è": "e", "ë": "e", "í": "i", "ì": "i", "ï": "i",
                          "ó": "o", "ò": "o", "ö": "o", "ú": "u", "ù": "u", "ü": "u", "ñ": "n"})


def norm(s):
    s = unicodedata.normalize("NFC", s or "").lower().translate(_ACENTOS)
    return " ".join(s.split())


def tipo_cat(t):
    t = norm(t)
    if "departamento" in t or "penthouse" in t or "apart" in t or t == "ph":
        return "apto"
    for clave, cat in (("casa", "casa"), ("terreno", "terreno"), ("lote", "terreno"), ("chacra", "chacra"),
                       ("campo", "campo"), ("quinta", "quinta"), ("local", "local"), ("oficina", "oficina"),
                       ("deposito", "deposito"), ("galpon", "deposito"), ("industrial", "deposito"),
                       ("cochera", "cochera"), ("garaje", "cochera")):
        if clave in t:
            return cat
    return "otro"


OTROS = ["terreno", "chacra", "campo", "quinta", "local", "oficina", "deposito", "cochera", "otro"]


def a_usd(monto, moneda, rate):
    if not monto:
        return None
    if moneda == "USD":
        return round(monto)
    return round(monto / rate) if rate else None


def rango(cfg, a, b):
    x, y = cfg.get(a), cfg.get(b)
    if x is not None and y is not None and x > y:
        x, y = y, x
    return x, y


def metros_totales(c):
    if c.get("m2_padron"):
        return c["m2_padron"]
    return (c.get("m2_total") or c.get("m2_homog") or 0) if tipo_cat(c.get("tipo")) == "apto" else 0


def cumple(c, cfg, ctx):
    """¿La propiedad c cumple la configuración del formulario cfg? (ctx = grupos/zonas/deptos + dólar)"""
    if c.get("estado_pub") and c["estado_pub"] != "active":
        return False
    if c.get("operacion") != cfg["oper"]:
        return False
    tipos = [t for t in cfg["tipos"] if t != "otros"]
    if "otros" in cfg["tipos"]:
        tipos += cfg["otros"] or OTROS
    if tipos and tipo_cat(c.get("tipo")) not in tipos:
        return False
    # lugar: departamentos enteros + zonas + barrios (1 solo barrio = su grupo de parecidos); se suman con "o"
    deptos, zonas, barrios = [], [], []
    for nm in cfg["lugares"]:
        n = norm(nm)
        if n in ctx["deptos"]:
            deptos.append(n)
        elif n in ctx["zonas"]:
            zonas.append(ctx["zonas"][n])
        else:
            barrios.append(n)
    if len(cfg["lugares"]) == 1 and len(barrios) == 1:
        barrios = ctx["grupos"].get(barrios[0], [barrios[0]])
    if deptos or zonas or barrios:
        dn, bn = norm(c.get("depto")), norm(c.get("barrio"))
        if not (dn in deptos or any(z["depto"] == dn and bn in z["barrios"] for z in zonas) or bn in barrios):
            return False
    # dormitorios / baños: 0 o vacío = da igual
    for campo, a, b in (("dorm", "dmin", "dmax"), ("banos", "bmin", "bmax")):
        lo, hi = rango({k: (cfg.get(k) or None) for k in (a, b)}, a, b)
        v = c.get(campo)
        if lo and (v is None or v < lo):
            return False
        if hi and (v is None or v > hi):
            return False
    # precio (en la moneda elegida → dólares). Sin precio publicado: NO se descarta ("Falta dato")
    rate = ctx["rate"]
    lo, hi = rango({"a": a_usd(cfg.get("pmin"), cfg["moneda"], rate), "b": a_usd(cfg.get("pmax"), cfg["moneda"], rate)}, "a", "b")
    p = c.get("precio_usd")
    if p is not None and ((lo is not None and p < lo) or (hi is not None and p > hi)):
        return False
    # m² construidos (homogeneizados): sin dato → no entra si hay filtro
    lo, hi = rango(cfg, "cubmin", "cubmax")
    m = c.get("m2_homog")
    if lo is not None and (m is None or m < lo):
        return False
    if hi is not None and (m is None or m > hi):
        return False
    # m² totales / padrón: apto = su superficie total; casa/terreno sin dato → no se descarta
    lo, hi = rango(cfg, "padmin", "padmax")
    mt = metros_totales(c)
    if mt and ((lo is not None and mt < lo) or (hi is not None and mt > hi)):
        return False
    # cochera / estado: dato desconocido no descarta
    if cfg["coch"] == "si" and c.get("cochera") is False:
        return False
    if cfg["coch"] == "no" and c.get("cochera") is True:
        return False
    if cfg["estado"] and c.get("estado") and c["estado"] != cfg["estado"]:
        return False
    # renta / varias unidades: alguna de las elegidas
    if cfg["renta"]:
        ok = (("con" in cfg["renta"] and c.get("renta") is True) or ("sin" in cfg["renta"] and c.get("renta") is False)
              or ("multi" in cfg["renta"] and c.get("multiunidad") is True))
        if not ok:
            return False
    # gastos comunes (pesos): solo si se eligió Apto; sin dato no descarta
    if "apto" in cfg["tipos"]:
        lo, hi = rango({"a": a_usd(cfg.get("gmin"), "UYU", rate), "b": a_usd(cfg.get("gmax"), "UYU", rate)}, "a", "b")
        g = c.get("gastos_usd")
        if g is not None and ((lo is not None and g < lo) or (hi is not None and g > hi)):
            return False
    return True


# ----------------------------------------------------------------------------------------------------------
# Manejar el formulario de la app como una persona
# ----------------------------------------------------------------------------------------------------------
APLICAR = """(cfg) => {
  limpiarTodo();
  setSeg('f-oper', cfg.oper);
  setSegMulti('f-tipo', cfg.tipos); setSegMulti('f-tipo-otros', cfg.otros); toggleOtros(); toggleGastos();
  SELBARRIOS = cfg.lugares.slice(); renderChips(); pintarGrupo();
  setStep('f-dmin', cfg.dmin); setStep('f-dmax', cfg.dmax); setStep('f-bmin', cfg.bmin); setStep('f-bmax', cfg.bmax);
  setSeg('f-moneda', cfg.moneda);
  var fmt = function (v) { return v == null ? '' : (cfg.conPuntos ? new Intl.NumberFormat('es-UY').format(v) : String(v)); };
  $('f-precio-min').value = fmt(cfg.pmin); $('f-precio-max').value = fmt(cfg.pmax);
  $('f-cub-min').value = fmt(cfg.cubmin); $('f-cub-max').value = fmt(cfg.cubmax);
  $('f-padron-min').value = fmt(cfg.padmin); $('f-padron-max').value = fmt(cfg.padmax);
  $('f-gastos-min').value = fmt(cfg.gmin); $('f-gastos-max').value = fmt(cfg.gmax);
  setSeg('f-coch', cfg.coch); setSeg('f-estado', cfg.estado); setSegMulti('f-renta', cfg.renta);
  var f = leerFiltros();
  var slugs = DATA.filter(function (c) { return pasa(c, f, null); }).map(function (c) { return c.slug; });
  return { f: f, slugs: slugs };
}"""

BASE = {"oper": "sale", "tipos": [], "otros": [], "lugares": [], "dmin": None, "dmax": None, "bmin": None, "bmax": None,
        "moneda": "USD", "pmin": None, "pmax": None, "cubmin": None, "cubmax": None, "padmin": None, "padmax": None,
        "gmin": None, "gmax": None, "coch": "", "estado": "", "renta": [], "conPuntos": False}

# Valores a probar por cada filtro (incluye bordes: mín > máx, 0, rangos de un solo valor, pesos, etc.)
OPCIONES = {
    "oper": ["sale", "rent", "temporal"],
    "tipos": [([], []), (["casa"], []), (["apto"], []), (["casa", "apto"], []), (["otros"], []),
              (["otros"], ["terreno"]), (["otros"], ["local", "oficina"]), (["apto", "otros"], ["terreno", "chacra"])],
    "lugares": [[], ["Pocitos"], ["Pocitos", "Centro"], ["Montevideo"], ["Canelones", "Pocitos"], ["Ciudad de la Costa"],
                ["Maldonado", "Ciudad de la Costa", "Carrasco"], ["Barros Blancos"], ["Punta del Este"], ["Salto"],
                ["Colinas de Carrasco"], ["Carmel"], ["Cordón", "Parque Rodó", "Palermo"]],
    "dorm": [(None, None), (2, None), (None, 2), (1, 3), (3, 1), (2, 2), (0, None), (5, None)],
    "banos": [(None, None), (1, None), (2, None), (None, 1), (1, 2), (3, None)],
    "precio": [("USD", None, None), ("USD", None, 150000), ("USD", 100000, None), ("USD", 50000, 200000),
               ("USD", 300000, 100000), ("UYU", 2000000, 8000000), ("UYU", None, 40000), ("USD", None, 1500), ("USD", 0, 0)],
    "cub": [(None, None), (50, None), (None, 80), (60, 120), (120, 60), (1, None)],
    "padron": [(None, None), (300, None), (None, 500), (1000, None), (50, 100)],
    "coch": ["", "si", "no"],
    "estado": ["", "usada", "a_estrenar"],
    "renta": [[], ["con"], ["sin"], ["multi"], ["con", "multi"], ["con", "sin", "multi"]],
    "gastos": [(None, None), (None, 8000), (3000, None), (2000, 6000)],
}


def poner(cfg, dim, val):
    cfg = dict(cfg)
    if dim == "oper":
        cfg["oper"] = val
    elif dim == "tipos":
        cfg["tipos"], cfg["otros"] = list(val[0]), list(val[1])
    elif dim == "lugares":
        cfg["lugares"] = list(val)
    elif dim == "dorm":
        cfg["dmin"], cfg["dmax"] = val
    elif dim == "banos":
        cfg["bmin"], cfg["bmax"] = val
    elif dim == "precio":
        cfg["moneda"], cfg["pmin"], cfg["pmax"] = val
    elif dim == "cub":
        cfg["cubmin"], cfg["cubmax"] = val
    elif dim == "padron":
        cfg["padmin"], cfg["padmax"] = val
    elif dim in ("coch", "estado"):
        cfg[dim] = val
    elif dim == "renta":
        cfg["renta"] = list(val)
    elif dim == "gastos":
        cfg["gmin"], cfg["gmax"] = val
        if val != (None, None) and "apto" not in cfg["tipos"]:
            cfg["tipos"] = cfg["tipos"] + ["apto"]   # los gastos solo existen con Apto elegido
    return cfg


def combinaciones():
    out = []
    dims = list(OPCIONES)
    for oper in OPCIONES["oper"]:                      # 1) cada filtro solo, en cada operación
        base = poner(BASE, "oper", oper)
        for dim in dims[1:]:
            for val in OPCIONES[dim]:
                out.append(("solo " + dim, poner(base, dim, val)))
    rnd = random.Random(20261111)
    for d1, d2 in itertools.combinations(dims[1:], 2):  # 2) todos los pares de filtros (valores al azar, 6 por par)
        for _ in range(6):
            cfg = poner(BASE, "oper", rnd.choice(OPCIONES["oper"]))
            cfg = poner(cfg, d1, rnd.choice(OPCIONES[d1]))
            cfg = poner(cfg, d2, rnd.choice(OPCIONES[d2]))
            out.append(("par %s+%s" % (d1, d2), cfg))
    for i in range(400):                               # 3) combinaciones completas al azar
        cfg = dict(BASE)
        for dim in dims:
            if dim == "oper" or rnd.random() < 0.55:
                cfg = poner(cfg, dim, rnd.choice(OPCIONES[dim]))
        cfg["conPuntos"] = rnd.random() < 0.5          # a veces con puntos de miles, como escribe la gente
        out.append(("azar", cfg))
    return out


# ----------------------------------------------------------------------------------------------------------
def explicar(c, cfg, ctx):
    campos = ("operacion", "tipo", "depto", "barrio", "dorm", "banos", "precio_usd", "m2_homog", "m2_padron", "m2_total",
              "cochera", "estado", "renta", "multiunidad", "gastos_usd", "estado_pub")
    return {k: c.get(k) for k in campos}


JS_WORKER = r"""
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
const ini = src.indexOf('function norm(s)'), fin = src.indexOf('// ---- Push: helpers ----');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(ini, fin), ctx);
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).listings;
const casos = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = casos.map(f => data.filter(c => ctx.pasa(c, f, null)).map(c => c.slug));
fs.writeFileSync(process.argv[4], JSON.stringify(out));
"""


def main():
    data = json.load(open(os.path.join(CARPETA, "listings.json"), encoding="utf-8"))["listings"]
    srv = servir()
    fallos, revisadas, total_props = [], 0, 0
    filtros_app = []
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = pagina_nueva(br)
        ctx = page.evaluate("""() => ({ grupos: GRUPO_IDX, zonas: ZONA_IDX, deptos: DEPTO_IDX, rate: USD_RATE })""")
        # 0) el verificador y la app clasifican igual cada propiedad (tipo, barrio, depto)
        app_cls = page.evaluate("DATA.map(function (c) { return [c.slug, tipoCat(c.tipo), norm(c.barrio), norm(c.depto)]; })")
        for (slug, tc, bn, dn), c in zip(app_cls, data):
            if (tc, bn, dn) != (tipo_cat(c.get("tipo")), norm(c.get("barrio")), norm(c.get("depto"))):
                fallos.append(("clasificación", slug, {"app": [tc, bn, dn], "regla": [tipo_cat(c.get("tipo")), norm(c.get("barrio")), norm(c.get("depto"))]}))
        casos = combinaciones()
        for nombre, cfg in casos:
            r = page.evaluate(APLICAR, cfg)
            app = set(r["slugs"])
            esperado = {c["slug"] for c in data if cumple(c, cfg, ctx)}
            revisadas += 1
            total_props += len(esperado)
            filtros_app.append(r["f"])
            if app != esperado:
                sobran, faltan = sorted(app - esperado), sorted(esperado - app)
                ej = sobran[:1] or faltan[:1]
                cprop = next(c for c in data if c["slug"] == ej[0])
                fallos.append((nombre, cfg, {"app_de_mas": len(sobran), "app_de_menos": len(faltan), "ejemplo": ej[0],
                                             "dato": explicar(cprop, cfg, ctx), "filtro_app": r["f"]}))
        br.close()
    srv.shutdown()
    # 4) el robot de avisos decide lo mismo que la app, con el mismo filtro guardado
    tmp = os.path.join(CARPETA, "_aud_casos.json"), os.path.join(CARPETA, "_aud_worker.json")
    json.dump(filtros_app, open(tmp[0], "w", encoding="utf-8"))
    out = subprocess.run(["node", "-e", JS_WORKER, os.path.join(CARPETA, "worker", "motor.js"), os.path.join(CARPETA, "listings.json"), tmp[0], tmp[1]],
                         capture_output=True, text=True, timeout=600)
    worker_dif = 0
    if out.returncode != 0:
        fallos.append(("worker", "no corrió", out.stderr[:300]))
    else:
        res_w = json.load(open(tmp[1], encoding="utf-8"))
        for (nombre, cfg), w in zip(casos, res_w):
            esperado = {c["slug"] for c in data if cumple(c, cfg, ctx)}
            if set(w) != esperado:
                worker_dif += 1
                if worker_dif <= 5:
                    fallos.append(("worker " + nombre, cfg, {"de_mas": len(set(w) - esperado), "de_menos": len(esperado - set(w)),
                                                              "ejemplo": (sorted(set(w) ^ esperado) or [""])[0]}))
    for t in tmp:
        try:
            os.remove(t)
        except OSError:
            pass
    print("Combinaciones revisadas: %d (cada una contra las %d propiedades); coincidencias esperadas en total: %d"
          % (revisadas, len(data), total_props))
    print("Robot de avisos: %d combinaciones distintas a la regla" % worker_dif)
    if fallos:
        print("\n%d DIFERENCIAS:" % len(fallos))
        for f in fallos[:40]:
            print(json.dumps(f, ensure_ascii=False, default=str)[:900])
        return 1
    print("\n100% de coincidencia: la app y el robot de avisos encuentran exactamente lo que dicen las reglas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
