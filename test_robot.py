"""Pruebas del ROBOT de datos (build_listings.py) — los errores que encontró la auditoría del 2026-11-11.
No toca internet: propiedades de ejemplo armadas a mano con la misma forma que manda RE/MAX.

Uso: python test_robot.py
"""
from __future__ import annotations

import sys

import build_listings as R


def item(**kw):
    base = {"slug": "x", "type": {"value": "casa"}, "operation": {"value": "sale"}, "price": 150000,
            "currency": {"value": "USD"}, "bedrooms": 3, "bathrooms": 2, "geoLabel": "Pocitos, Montevideo, Montevideo",
            "photos": [], "associate": {}, "listingStatus": {"value": "active"}, "title": "Casa linda", "entrepreneurship": False}
    base.update(kw)
    return base


def ficha(**kw):
    base = {"dimensionCovered": 100, "dimensionTotalBuilt": 120, "dimensionLand": 300, "dimensionSemicovered": 0,
            "dimensionUncovered": 0, "parkingSpaces": 0, "toilets": 0, "description": "", "displayAddress": "Lecocq 1500",
            "location": {"coordinates": [-56.15, -34.91]}, "conditions": []}
    base.update(kw)
    return base


# ---------------- 1 y 2: rescate de las que vienen sin zona ----------------
ZONAS = [item(slug="a", geoLabel="Santa Ana, Colonia, Colonia"), item(slug="b", geoLabel="Maroñas, Montevideo, Montevideo"),
         item(slug="c", geoLabel="Flor de Maroñas, Montevideo, Montevideo"), item(slug="d", geoLabel="Canelones, Canelones, Canelones"),
         item(slug="e", geoLabel="Montes, Canelones, Canelones"), item(slug="f", geoLabel="Villa Serrana, Lavalleja, Lavalleja")]
COORDS = {"a": (-34.4, -57.9), "b": (-34.85, -56.15), "c": (-34.845, -56.14), "d": (-34.52, -56.28), "e": (-34.5, -55.56),
          "f": (-34.32, -54.98)}


def coords_de(prop):
    return COORDS.get(prop.get("slug"))


def rescatar(sin_zona, fichas):
    listado = ZONAS + sin_zona
    return R.rescatar_sin_zona(listado, list(ZONAS), lambda slug: fichas.get(slug), coords_de)


def caso_rescata_propiedades_de_todo_el_pais():
    nuevas = [item(slug="col", geoLabel="", title="Casa 2 dormitorios en Santa Ana"),
              item(slug="lav", geoLabel="", title="Campo en Villa Serrana vertientes")]
    fichas = {"col": {"location": {"coordinates": [-57.89, -34.41]}}, "lav": {"location": {"coordinates": [-54.99, -34.33]}}}
    res = {it["slug"]: it["geoLabel"] for it in rescatar(nuevas, fichas)}
    assert "col" in res and R._depto(res["col"]) == "Colonia" and R._barrio(res["col"]) == "Santa Ana", f"Colonia: {res}"
    assert "lav" in res and R._depto(res["lav"]) == "Lavalleja", f"Lavalleja: {res}"


def caso_no_rescata_lo_que_cae_fuera_de_uruguay():
    nuevas = [item(slug="mar", geoLabel="", title="Casa en Neptunia")]
    res = rescatar(nuevas, {"mar": {"location": {"coordinates": [-52.4, -41.7]}}})
    assert not any(it["slug"] == "mar" for it in res), "coordenadas en el mar: no se rescata"


def caso_elige_el_barrio_mas_largo_y_no_un_departamento():
    nuevas = [item(slug="fm", geoLabel="", title="Venta casa 3 dormitorios garage en Flor de Maroñas"),
              item(slug="mo", geoLabel="", title="Casa en venta 3 dormitorios en Montes Canelones")]
    fichas = {"fm": {"location": {"coordinates": [-56.14, -34.846]}}, "mo": {"location": {"coordinates": [-55.56, -34.5]}}}
    res = {it["slug"]: it["geoLabel"] for it in rescatar(nuevas, fichas)}
    assert R._barrio(res["fm"]) == "Flor de Maroñas", f"Flor de Maroñas, no Maroñas: {res['fm']}"
    assert R._barrio(res["mo"]) == "Montes", f"Montes, no Canelones (que es el departamento): {res['mo']}"


# ---------------- 3: emprendimientos ----------------
EMP = {"title": "The Corner", "description": "Edificio con cocheras disponibles para comprar", "displayAddress": "Ruta 10 (20000), Zona La Barra, Maldonado, Uruguay",
       "location": {"type": "Point", "coordinates": [-54.86, -34.91]}, "minBedrooms": 1, "maxBedrooms": 2, "minBathrooms": 1, "maxBathrooms": 2,
       "minToiletrooms": 0, "maxToiletrooms": 1, "minPrice": 259740.0, "maxPrice": 632700.0, "minCurrency": {"value": "USD"},
       "maxCurrency": {"value": "USD"}, "minParkingSpaces": 0, "maxParkingSpaces": 1, "minDimensionCovered": 60.0, "maxDimensionCovered": 108.0,
       "minDimensionSemicovered": 10.0, "maxDimensionSemicovered": 20.0, "minDimensionUncovered": 0, "maxDimensionUncovered": 0}


def caso_emprendimiento_usa_su_propia_ficha():
    assert R.url_ficha(item(slug="the-corner", entrepreneurship=True)).endswith("/entrepreneurships/findBySlug/the-corner")
    assert R.url_ficha(item(slug="casa-x")).endswith("/listings/findBySlug/casa-x")


def caso_emprendimiento_guarda_rangos():
    it = item(slug="the-corner", entrepreneurship=True, type={"value": "departamento_estandar"}, price=0, bedrooms=0, bathrooms=0)
    f = R._fila(it, EMP, 41.25)
    assert (f["dorm"], f["dorm_max"]) == (1, 2), f"dormitorios 1 a 2: {f['dorm']}, {f.get('dorm_max')}"
    assert (f["banos"], f["banos_max"]) == (1, 3), f"baños 1 a 3 (con toilette): {f['banos']}, {f.get('banos_max')}"
    assert (f["precio_usd"], f["precio_max_usd"]) == (259740, 632700), f"precio desde/hasta: {f['precio_usd']}, {f.get('precio_max_usd')}"
    assert f["direccion"].startswith("Ruta 10"), f"dirección: {f['direccion']}"
    assert f["cochera"] is True, "alguna unidad tiene cochera"
    assert f["estado"] == "a_estrenar" and f["detalle_ok"] is True
    assert f["m2_homog"] and f["m2_homog_max"] and f["m2_homog"] < f["m2_homog_max"], f"m² desde/hasta: {f['m2_homog']}, {f.get('m2_homog_max')}"


def caso_propiedad_comun_sin_rangos():
    f = R._fila(item(), ficha(), 41.25)
    assert f.get("dorm_max") is None and f.get("precio_max_usd") is None and f.get("banos_max") is None


# ---------------- 4: período de los temporarios ----------------
def caso_temporario_guarda_el_periodo():
    f = R._fila(item(operation={"value": "temporal"}), ficha(billingFrequency={"id": 6, "value": "fortnightly"}), 41.25)
    assert f["periodo"] == "fortnightly", f"período: {f.get('periodo')}"
    f2 = R._fila(item(operation={"value": "rent"}), ficha(billingFrequency=None), 41.25)
    assert f2["periodo"] is None


# ---------------- 5: hectáreas ----------------
def caso_hectareas_no_se_aplican_a_apartamentos():
    f = R._fila(item(type={"value": "departamento_penthouse"}, title="Penthouse en Veramansa, 15 hectáreas de parque"),
                ficha(dimensionLand=0, description="Complejo de 15 hectáreas"), 41.25)
    assert f["m2_padron"] == 0, f"un apto no se queda con las hectáreas del complejo: {f['m2_padron']}"


def caso_campo_grande_real_se_respeta():
    f = R._fila(item(type={"value": "campo"}, title="Campo en venta 948 hectáreas"), ficha(dimensionLand=9486470), 41.25)
    assert f["m2_padron"] == 9486470, f"el dato de RE/MAX (948,6 ha) es real: {f['m2_padron']}"
    g = R._fila(item(type={"value": "chacra"}, title="Chacra de 3 hectáreas"), ficha(dimensionLand=300000000), 41.25)
    assert g["m2_padron"] == 30000, f"dato inflado (3 ha → 300.000.000): se usa el texto: {g['m2_padron']}"


# ---------------- 6: cochera por texto ----------------
def caso_cochera_por_texto_sin_falsos_positivos():
    no = ["Posibilidad de alquilar cochera en el edificio", "Cocheras disponibles desde USD 25.000",
          "Hoy funciona como cochera", "Sin cochera", "Cochera opcional", "Se vende cochera aparte"]
    si = ["Garaje para 2 autos", "Casa con cochera techada", "Apartamento con garage", "Incluye cochera"]
    for t in no:
        assert R._dice_cochera(t) is False, f"no es cochera de la propiedad: {t!r}"
    for t in si:
        assert R._dice_cochera(t) is True, f"sí tiene cochera: {t!r}"
    assert R._fila(item(), ficha(parkingSpaces=1, description="Posibilidad de alquilar cochera"), 41.25)["cochera"] is True, "RE/MAX dice 1 lugar: manda"


# ---------------- 8: datos absurdos → "falta dato" ----------------
def caso_datos_absurdos_quedan_como_falta_dato():
    mono = R._fila(item(type={"value": "departamento_monoambiente"}), ficha(dimensionCovered=32780, dimensionTotalBuilt=42990), 41.25)
    assert mono["m2_homog"] is None and mono["m2_total"] is None, f"monoambiente de 32.780 m²: dato roto → vacío ({mono['m2_homog']}, {mono['m2_total']})"
    barato = R._fila(item(price=146.9), ficha(), 41.25)
    assert barato["precio_usd"] is None, "venta a USD 146,9: dato roto → sin precio"
    alq = R._fila(item(operation={"value": "rent"}, price=3), ficha(), 41.25)
    assert alq["precio_usd"] is None, "alquiler de USD 3: dato roto"
    cero = R._fila(item(price=0), ficha(), 41.25)
    assert cero["precio"] is None and cero["precio_usd"] is None, "precio 0 (Consultar) = sin precio"
    mar = R._fila(item(), ficha(location={"coordinates": [-52.4, -41.7]}), 41.25)
    assert mar["lat"] is None and mar["lng"] is None, "coordenadas en el mar: sin ubicación"
    casa0 = R._fila(item(), ficha(dimensionCovered=0, dimensionTotalBuilt=0, dimensionLand=0), 41.25)
    assert casa0["m2_homog"] is None, "casa con todo en 0: falta el dato (no son 0 m²)"
    terr = R._fila(item(type={"value": "terrenos_y_lotes"}), ficha(dimensionCovered=0, dimensionTotalBuilt=0, dimensionLand=500), 41.25)
    assert terr["m2_homog"] == 0, "un terreno sí tiene 0 m² construidos"
    normal = R._fila(item(), ficha(), 41.25)
    assert normal["m2_homog"] and normal["precio_usd"] == 150000 and normal["lat"] is not None, "lo normal no se toca"


# ---------------- m² reales (Juan 2026-11-11: los filtros usan metros REALES, no homogeneizados) ----------------
def caso_guarda_los_m2_construidos_reales():
    pde = R._fila(item(), ficha(dimensionCovered=204, dimensionTotalBuilt=204, dimensionLand=1657, dimensionUncovered=0), 41.25)
    assert pde["m2_cub"] == 204, f"casa de Punta del Este: 204 m² construidos reales: {pde.get('m2_cub')}"
    lag = R._fila(item(), ficha(dimensionCovered=97, dimensionSemicovered=14, dimensionTotalBuilt=111, dimensionLand=388), 41.25)
    assert lag["m2_cub"] == 111, f"Lagomar: 97 cubiertos + 14 semicubiertos = 111: {lag.get('m2_cub')}"
    apto = R._fila(item(type={"value": "departamento_estandar"}), ficha(dimensionCovered=62, dimensionSemicovered=4.8, dimensionTotalBuilt=66.8, dimensionLand=0), 41.25)
    assert apto["m2_cub"] == 66.8, f"apto: 62 + 4,8 = 66,8: {apto.get('m2_cub')}"
    vacia = R._fila(item(), ficha(dimensionCovered=0, dimensionSemicovered=0, dimensionTotalBuilt=0, dimensionLand=0), 41.25)
    assert vacia["m2_cub"] is None, "casa sin m²: falta el dato"
    it = item(slug="the-corner", entrepreneurship=True, type={"value": "departamento_estandar"}, price=0, bedrooms=0, bathrooms=0)
    emp = R._fila(it, EMP, 41.25)
    assert (emp["m2_cub"], emp["m2_cub_max"]) == (70, 128), f"emprendimiento: 60+10 a 108+20: {emp.get('m2_cub')}, {emp.get('m2_cub_max')}"


def caso_padron_de_complejo_es_dato_dudoso():
    """Pando: 'alquiler 1 dormitorio en complejo cerrado', 53 m² construidos y 812 de terreno (el del complejo entero)."""
    f = R._fila(item(title="Alquiler 1 dormitorio en complejo cerrado en Pando"),
                ficha(dimensionCovered=53, dimensionLand=812, description="Casa en complejo cerrado"), 41.25)
    assert not f["m2_padron"], f"el terreno es del complejo, no de la unidad → falta el dato: {f['m2_padron']}"
    casa = R._fila(item(title="Casa con gran jardín"), ficha(dimensionCovered=204, dimensionLand=1657), 41.25)
    assert casa["m2_padron"] == 1657, "una casa común con terreno grande se respeta"
    bp = R._fila(item(title="Casa en barrio privado San Rafael"), ficha(dimensionCovered=132, dimensionLand=930), 41.25)
    assert bp["m2_padron"] == 930, "barrio privado: el lote es de la casa"


# ---------------- repetidos ----------------
def caso_sin_repetidos():
    filas = [{"slug": "a", "n": 1}, {"slug": "b"}, {"slug": "a", "n": 2}]
    out = R.sin_repetidos(filas)
    assert [f["slug"] for f in out] == ["a", "b"] and out[0]["n"] == 1


CASOS = [caso_rescata_propiedades_de_todo_el_pais, caso_no_rescata_lo_que_cae_fuera_de_uruguay,
         caso_elige_el_barrio_mas_largo_y_no_un_departamento, caso_emprendimiento_usa_su_propia_ficha,
         caso_emprendimiento_guarda_rangos, caso_propiedad_comun_sin_rangos, caso_temporario_guarda_el_periodo,
         caso_hectareas_no_se_aplican_a_apartamentos, caso_campo_grande_real_se_respeta,
         caso_cochera_por_texto_sin_falsos_positivos, caso_datos_absurdos_quedan_como_falta_dato, caso_sin_repetidos,
         caso_guarda_los_m2_construidos_reales, caso_padron_de_complejo_es_dato_dudoso]


def main():
    fallos = 0
    for caso in CASOS:
        try:
            caso()
            print("OK   ", caso.__name__)
        except AssertionError as e:
            fallos += 1
            print("FALLA", caso.__name__, "->", str(e)[:300])
        except Exception as e:
            fallos += 1
            print("ERROR", caso.__name__, "->", type(e).__name__, str(e)[:250])
    print("\n%d de %d casos OK" % (len(CASOS) - fallos, len(CASOS)))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
