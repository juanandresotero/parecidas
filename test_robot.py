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


def caso_usa_la_lista_de_barrios_de_la_app():
    """Si ninguna propiedad de hoy está cargada como 'Flor de Maroñas', igual se reconoce: el robot conoce la lista
    de barrios de la app (barrios.js)."""
    zonas = [z for z in ZONAS if z["slug"] != "c"]          # sin ninguna "Flor de Maroñas" en los datos
    nueva = [item(slug="fm", geoLabel="", title="Venta casa 3 dormitorios en Flor de Maroñas")]
    res = R.rescatar_sin_zona(zonas + nueva, list(zonas), lambda s: {"location": {"coordinates": [-56.14, -34.846]}}, coords_de,
                              R.barrios_conocidos())
    assert res and R._sin_acentos(R._barrio(res[0]["geoLabel"])) == "flor de maronas", f"Flor de Maroñas: {res and res[0]['geoLabel']}"
    assert R._depto(res[0]["geoLabel"]) == "Montevideo"
    bc = R.barrios_conocidos()
    assert bc.get("flor de maronas", (None, None))[1] == "Montevideo" and bc.get("solymar", (None, None))[1] == "Canelones", "barrio → departamento"


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


# ---------------- gastos comunes absurdos → vacíos (Juan 2026-11-11) ----------------
def caso_gastos_absurdos_quedan_vacios():
    def g(op, precio, gastos, moneda):
        f = R._fila(item(operation={"value": op}, price=precio, type={"value": "departamento_estandar"}),
                    ficha(expensesPrice=gastos, expensesCurrency={"value": moneda}), 40.0)
        return f["gastos_usd"]
    assert g("sale", 60000, 4000, "USD") is None, "USD 4.000 por mes en un apto de USD 60.000: absurdo"
    assert g("rent", 1200, 5000, "USD") is None, "gastos de USD 5.000 en un alquiler de USD 1.200: absurdo"
    assert g("sale", 150000, 1, "UYU") is None, "1 peso de gastos: es relleno"
    assert g("sale", 150000, 250, "UYU") is None, "250 pesos: relleno"
    assert g("sale", 1290000, 55000, "UYU") == 1375, "torre de lujo (USD 1,29 millones) con $ 55.000: real"
    assert g("sale", 150000, 6000, "UYU") == 150, "lo normal no se toca"
    assert g("rent", 800, 9000, "UYU") == 225, "alquiler normal no se toca"
    f = R._fila(item(price=60000, type={"value": "departamento_estandar"}), ficha(expensesPrice=4000, expensesCurrency={"value": "USD"}), 40.0)
    assert f["gastos"] is None and f["gastos_moneda"] == "", "sin rastros del dato roto"


# ---------------- historial de reservadas / en negociación / cerradas (Juan 2026-11-11) ----------------
def fila_h(slug, est, precio=150000):
    return {"slug": slug, "estado_pub": est, "operacion": "sale", "tipo": "casa", "barrio": "Pocitos", "depto": "Montevideo",
            "precio": precio, "moneda": "USD", "precio_usd": precio, "m2_homog": 100, "m2_cub": 90, "dorm": 3, "banos": 2,
            "cochera": True, "estado": "usada", "direccion": "Lecocq 1500", "foto": "x.jpg", "agente": "Ana"}


def caso_historial_guarda_las_reservadas():
    h = R.actualizar_historial({}, [fila_h("a", "reserved"), fila_h("b", "negotiation"), fila_h("c", "active")], "2026-11-11")
    assert set(h) == {"a", "b"}, f"se guardan las reservadas y en negociación (no las disponibles): {set(h)}"
    assert h["a"]["desde"] == "2026-11-11" and h["a"]["precio_usd"] == 150000 and h["a"]["m2_homog"] == 100
    assert "foto" not in h["a"] and "agente" not in h["a"], "solo lo necesario para comparar (archivo liviano)"
    for k in ("m2_padron", "m2_total", "gastos_usd", "lat", "lng", "periodo", "renta", "multiunidad"):
        assert k in h["a"], f"dato útil para analizar precios guardado: {k}"
    assert h["a"]["precio_al_reservar"] == 150000
    h = R.actualizar_historial(h, [fila_h("a", "reserved", 145000), fila_h("b", "negotiation")], "2026-11-20")
    assert h["a"]["desde"] == "2026-11-11" and h["a"]["visto"] == "2026-11-20" and h["a"]["precio_usd"] == 145000, "se actualiza, conserva desde cuándo"
    assert h["a"]["precio_al_reservar"] == 150000, "queda el precio con el que se reservó (bajó 5.000 en la negociación)"


def caso_historial_reserva_caida_se_borra():
    h = R.actualizar_historial({}, [fila_h("a", "reserved")], "2026-11-11")
    h = R.actualizar_historial(h, [fila_h("a", "active")], "2026-11-12")
    assert "a" not in h, "volvió a estar disponible: la reserva se cayó, ese precio no se concretó"


def caso_historial_marca_cerrada_si_deja_de_publicarse():
    h = R.actualizar_historial({}, [fila_h("a", "reserved"), fila_h("b", "negotiation")], "2026-11-11")
    h = R.actualizar_historial(h, [fila_h("b", "negotiation")], "2026-12-01")
    assert h["a"]["cerrada"] == "2026-12-01", "desapareció estando reservada → cerrada (venta/alquiler concretado)"
    h = R.actualizar_historial(h, [fila_h("b", "negotiation")], "2026-12-05")
    assert h["a"]["cerrada"] == "2026-12-01", "la fecha de cierre no se pisa"
    assert "cerrada" not in h["b"]


def caso_historial_descarta_lo_muy_viejo():
    h = {"viejo": dict(R._para_historial(fila_h("viejo", "reserved")), desde="2022-01-01", visto="2022-02-01", cerrada="2022-02-02")}
    h = R.actualizar_historial(h, [], "2026-11-11")
    assert "viejo" not in h, "más de 3 años: ya no sirve de referencia"


# ---------------- patio deducido para el ANÁLISIS (Juan 2026-11-12) ----------------
def caso_patio_se_deduce_siempre_para_analizar():
    """RE/MAX manda 'descubierto' en 0 cuando el agente no lo completa. Si el terreno (o el total en un apto) da para
    más que lo construido, ese resto ES patio/jardín: la cuenta se hace siempre (solo para analizar, no para filtrar)."""
    pde = R._fila(item(), ficha(dimensionCovered=204, dimensionTotalBuilt=204, dimensionLand=1657, dimensionUncovered=0), 41.25)
    assert pde["m2_homog"] == 495 and pde["m2_cub"] == 204, f"Punta del Este: patio 1.453 ponderado → 495 (filtro sigue 204): {pde['m2_homog']}, {pde['m2_cub']}"
    ph = R._fila(item(), ficha(dimensionCovered=115, dimensionTotalBuilt=115, dimensionLand=495, dimensionUncovered=0), 41.25)
    assert ph["m2_homog"] == 191, f"Playa Hermosa: 115 + 380 ponderado = 191: {ph['m2_homog']}"
    lag = R._fila(item(), ficha(dimensionCovered=97, dimensionSemicovered=14, dimensionTotalBuilt=111, dimensionLand=388, dimensionUncovered=0), 41.25)
    assert lag["m2_homog"] == 164, f"Lagomar: 97 + 14·0,4 + 277 ponderado = 164: {lag['m2_homog']}"
    real = R._fila(item(), ficha(dimensionCovered=100, dimensionLand=600, dimensionUncovered=150), 41.25)
    assert real["m2_homog"] == 100 + round(150 * 0.22), f"si el agente cargó el patio, se usa ese: {real['m2_homog']}"
    pando = R._fila(item(title="Alquiler 1 dormitorio en complejo cerrado"), ficha(dimensionCovered=53, dimensionTotalBuilt=53, dimensionLand=812,
                    dimensionUncovered=0, description="Casa en complejo cerrado"), 41.25)
    assert pando["m2_homog"] == 53, f"complejo: el terreno es de todos, no hay patio propio que sumar: {pando['m2_homog']}"
    terraza = R._fila(item(type={"value": "departamento_estandar"}), ficha(dimensionCovered=80, dimensionTotalBuilt=100, dimensionLand=0, dimensionUncovered=0), 41.25)
    assert terraza["m2_homog"] == 80 + round(20 * 0.25), f"apto: total − construido = terraza/balcón: {terraza['m2_homog']}"
    edificio = R._fila(item(type={"value": "departamento_estandar"}), ficha(dimensionCovered=62, dimensionTotalBuilt=62, dimensionLand=500, dimensionUncovered=0), 41.25)
    assert edificio["m2_homog"] == 62, f"apto con padrón grande (es del edificio entero): el padrón NO suma patio: {edificio['m2_homog']}"


# ---------------- repetidos ----------------
def caso_sin_repetidos():
    filas = [{"slug": "a", "n": 1}, {"slug": "b"}, {"slug": "a", "n": 2}]
    out = R.sin_repetidos(filas)
    assert [f["slug"] for f in out] == ["a", "b"] and out[0]["n"] == 1


CASOS = [caso_usa_la_lista_de_barrios_de_la_app, caso_rescata_propiedades_de_todo_el_pais, caso_no_rescata_lo_que_cae_fuera_de_uruguay,
         caso_elige_el_barrio_mas_largo_y_no_un_departamento, caso_emprendimiento_usa_su_propia_ficha,
         caso_emprendimiento_guarda_rangos, caso_propiedad_comun_sin_rangos, caso_temporario_guarda_el_periodo,
         caso_hectareas_no_se_aplican_a_apartamentos, caso_campo_grande_real_se_respeta,
         caso_cochera_por_texto_sin_falsos_positivos, caso_datos_absurdos_quedan_como_falta_dato, caso_sin_repetidos,
         caso_guarda_los_m2_construidos_reales, caso_padron_de_complejo_es_dato_dudoso, caso_gastos_absurdos_quedan_vacios,
         caso_historial_guarda_las_reservadas, caso_historial_reserva_caida_se_borra,
         caso_historial_marca_cerrada_si_deja_de_publicarse, caso_historial_descarta_lo_muy_viejo,
         caso_patio_se_deduce_siempre_para_analizar]


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
