"""Comprueba que la búsqueda de parecidas da resultados sensatos con datos REALES.
Espeja la lógica de app.js. Elige una propiedad de ejemplo y muestra sus parecidas.
Uso: python validate_search.py"""
from __future__ import annotations

import json
import unicodedata

GRUPOS = [
    ["Punta Carretas", "Pocitos", "Pocitos Nuevo", "Villa Biarritz", "Trouville", "Golf"],
    ["Carrasco", "Carrasco Norte", "Punta Gorda", "San Rafael"],
    ["Malvin", "Buceo", "Parque Batlle", "Villa Dolores"],
    ["Centro", "Cordon", "Parque Rodo", "Barrio Sur", "Palermo", "Ciudad Vieja", "Tres Cruces"],
    ["Prado", "Atahualpa", "Aguada", "Reducto", "Jacinto Vera", "La Figurita", "Bella Vista", "Capurro"],
    ["La Blanqueada", "Larranaga", "La Comercial", "Villa Munoz", "Goes", "Brazo Oriental"],
    ["Union", "Villa Espanola", "Malvin Norte", "Maronas", "Flor de Maronas", "Jardines del Hipodromo", "Bella Italia", "Ituzaingo", "Mercado Modelo"],
    ["La Teja", "Belvedere", "Nuevo Paris", "Sayago", "Penarol", "Colon", "Lavalleja", "Conciliacion", "Cerro", "Paso de la Arena", "La Paloma"],
    ["Piedras Blancas", "Manga", "Cerrito de la Victoria", "Las Acacias", "Casavalle", "Punta de Rieles", "Villa Garcia", "Lezica", "Melilla"],
    ["Solymar", "Lagomar", "El Pinar", "Shangrila", "Lomas de Solymar", "San Jose de Carrasco", "Medanos de Solymar", "Colinas de Solymar"],
    ["Salinas", "Marindia", "Atlantida", "Parque del Plata", "La Floresta", "Costa Azul", "Bello Horizonte", "San Luis", "Neptunia", "Pinamar", "Villa Argentina"],
    ["Las Piedras", "La Paz", "Progreso"],
    ["Pando", "Barros Blancos", "Joaquin Suarez", "Toledo", "Sauce"],
    ["Canelones", "Santa Lucia", "San Ramon", "Los Cerrillos", "Tala"],
]


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower().strip()


GRUPO_IDX = {}
for g in GRUPOS:
    ng = [norm(b) for b in g]
    for b in ng:
        GRUPO_IDX[b] = ng


def grupo_de(barrio):
    n = norm(barrio)
    return GRUPO_IDX.get(n, [n]) if n else None


def tipo_cat(t):
    t = norm(t)
    if "departamento" in t or "penthouse" in t or "apart" in t:
        return "apto"
    if "casa" in t:
        return "casa"
    if "terreno" in t or "lote" in t:
        return "terreno"
    return "otro"


def cerca(v, o):
    return v and o and o * 0.75 <= v <= o * 1.25


def pasa(c, f, slug_actual):
    if slug_actual and c.get("slug") == slug_actual:
        return False
    if f["operacion"] and c["operacion"] != f["operacion"]:
        return False
    if f["tipo"] and tipo_cat(c["tipo"]) != f["tipo"]:
        return False
    if f["grupo"] and norm(c["barrio"]) not in f["grupo"]:
        return False
    if f["dmin"] is not None and (c["dorm"] is None or c["dorm"] < f["dmin"]):
        return False
    if f["dmax"] is not None and (c["dorm"] is None or c["dorm"] > f["dmax"]):
        return False
    if f["precioUsd"] is not None and (c.get("precio_usd") is None or c["precio_usd"] > f["precioUsd"] * 1.15):
        return False
    if f["cub"] is not None and not cerca(c.get("m2_homog"), f["cub"]):
        return False
    if f["padron"] is not None and not cerca(c.get("m2_padron"), f["padron"]):
        return False
    if f["cochera"] == "si" and c.get("cochera") is not True:
        return False
    if f["cochera"] == "no" and c.get("cochera") is not False:
        return False
    if f["estado"] and c.get("estado") != f["estado"]:
        return False
    return True


def main():
    d = json.load(open("listings.json", encoding="utf-8"))
    data = d["listings"]
    print(f"Cargadas {len(data)} · dólar {d.get('usd_rate')}")
    # Ejemplo: un apto de Pocitos en venta con 2 dorm y precio conocido
    base = next((x for x in data if norm(x["barrio"]) == "pocitos"
                 and tipo_cat(x["tipo"]) == "apto" and x["operacion"] == "sale"
                 and x["dorm"] == 2 and x.get("precio_usd")), None)
    if not base:
        print("No encontré una propiedad de ejemplo.")
        return
    print("\n=== PROPIEDAD BASE ===")
    print(f"{base['barrio']} · apto · {base['dorm']}d · USD {base['precio_usd']} · "
          f"{base['m2_homog']}m² · cochera={base.get('cochera')} · {base['link']}")
    f = {"operacion": "sale", "tipo": "apto", "grupo": grupo_de(base["barrio"]),
         "dmin": 2, "dmax": 2, "precioUsd": base["precio_usd"],
         "cub": base["m2_homog"], "padron": None, "cochera": "", "estado": ""}
    res = [c for c in data if pasa(c, f, base["slug"])]

    def punt(c):
        p = 0.0
        if f["cub"] and c.get("m2_homog"):
            p += abs(c["m2_homog"] - f["cub"]) / f["cub"]
        if f["precioUsd"] and c.get("precio_usd"):
            p += abs(c["precio_usd"] - f["precioUsd"]) / f["precioUsd"]
        return p
    res.sort(key=punt)
    print(f"\n=== {len(res)} PARECIDAS (top 8) ===")
    for c in res[:8]:
        print(f"{c['barrio'][:16]:16} USD {c['precio_usd']:>7} · {c['m2_homog']:>3}m² · "
              f"{c['dorm']}d · coch={c.get('cochera')}")


if __name__ == "__main__":
    main()
