"""Prueba del ANÁLISIS DE MERCADO al traer un link (Juan 2026-11-11: "que haga un análisis comparativo de mercado
para saber si está en buen precio, mal precio o en el promedio, igual a lo que hace Auto-Meta en Recomendadas").
Mismas reglas que el medidor de Auto-Meta (campanas/mercado_metricas.py indicador_precio_m2):
- comparables: mismo barrio (+ departamento), operación, tipo (casa / apto / penthouse aparte), usado vs a estrenar,
  MISMO PORTE por tramos de m² homogeneizado (<43, 43–70, 70–95 ±33%, 95–200 ±25%, 200–300 ±20%, >300 ±17%),
  priorizando mismos dormitorios (después ±1, después cualquiera); solo disponibles; nunca ella misma.
- ajustes: cochera (venta + Montevideo: 30k/25k/12k/20k según barrio); zona INVE ("INVE" o "Calle <número>" en
  Mvd/Canelones) fuera, salvo que la evaluada también lo sea.
- veredicto: US$/m² vs MEDIANA → ±8% "en precio", más = caro, menos = buen precio; ±25% = "muy".

Uso: python test_mercado.py
"""
from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva


def prop(slug, precio, m2, **kw):
    p = {"slug": slug, "estado_pub": "active", "operacion": "sale", "tipo": "departamento_estandar", "barrio": "Pocitos",
         "depto": "Montevideo", "precio": precio, "moneda": "USD", "precio_usd": precio, "m2_homog": m2, "dorm": 2,
         "cochera": False, "estado": "usada", "direccion": "Benito Blanco 1000"}
    p.update(kw)
    return p


BASE = prop("base", 200000, 100)   # 2.000 US$/m²
COMPS = [prop("c%d" % i, 180000, 100) for i in range(5)]   # 1.800 US$/m² → la base está +11% → caro


def analizar(page, base, lista):
    return page.evaluate("([b, l]) => analisisMercado(b, l)", [base, lista])


def caso_veredicto_caro(page):
    r = analizar(page, BASE, COMPS)
    assert r and r["n"] == 5 and r["pct"] == 11 and r["nivel"] == "caro" and not r["fuerte"], f"+11% = caro: {r}"
    assert r["valor"] == 2000 and r["ref"] == 1800


def caso_veredicto_en_precio_y_buen_precio(page):
    assert analizar(page, prop("b", 185000, 100), COMPS)["nivel"] == "justo", "+3% = en precio"
    r = analizar(page, prop("b", 120000, 100), COMPS)
    assert r["nivel"] == "barato" and r["fuerte"], f"-33% = muy buen precio: {r}"


def caso_solo_comparables_que_corresponden(page):
    malos = [prop("otro-barrio", 100000, 100, barrio="Cordón"), prop("otro-depto", 100000, 100, depto="Maldonado"),
             prop("grande", 100000, 200), prop("nuevo", 100000, 100, estado="a_estrenar"),
             prop("casa", 100000, 100, tipo="casa"),
             prop("alquiler", 1000, 100, operacion="rent"), prop("base", 100000, 100), prop("penthouse", 100000, 100, tipo="departamento_penthouse"),
             prop("pesos", 8000000, 100, moneda="UYU", precio_usd=194000)]
    r = analizar(page, BASE, COMPS + malos)
    assert r["n"] == 5 and r["ref"] == 1800, f"solo los 5 correctos (barrio, depto, porte, estado, disponible, tipo, operación, no ella): {r}"


def caso_usa_reservadas_en_negociacion_y_cerradas(page):
    """Juan 2026-11-11: también las reservadas / en negociación (precio casi cerrado) y las que dejaron de publicarse
    estando así (venta/alquiler concretado) — las 'cerradas' del último año."""
    hoy = page.evaluate("new Date().toISOString().slice(0, 10)")
    viejo = page.evaluate("new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)")
    lista = [prop("a1", 180000, 100), prop("a2", 180000, 100), prop("r1", 170000, 100, estado_pub="reserved"),
             prop("n1", 170000, 100, estado_pub="negotiation"), prop("x1", 160000, 100, estado_pub="reserved", cerrada=hoy),
             prop("x2", 100000, 100, estado_pub="reserved", cerrada=viejo)]
    r = analizar(page, BASE, lista)
    assert r["n"] == 5 and (r["n_disp"], r["n_res"], r["n_cerr"]) == (2, 2, 1),         f"2 disponibles + 2 reservadas/en negociación + 1 cerrada (la de hace más de un año no): {r['n']} {r.get('n_disp')} {r.get('n_res')} {r.get('n_cerr')}"
    assert r["ref"] == 1700, f"mediana de 1.800, 1.800, 1.700, 1.700, 1.600 = 1.700: {r['ref']}"


def caso_prioriza_mismos_dormitorios(page):
    otros = [prop("d3-%d" % i, 100000, 100, dorm=3) for i in range(3)]
    r = analizar(page, BASE, COMPS + otros)
    assert r["n"] == 5 and r["ref"] == 1800, "con mismos dormitorios disponibles, no mezcla otros"
    r2 = analizar(page, BASE, otros)
    assert r2 and r2["n"] == 3, "si no hay de 2 dorm, usa ±1 dorm"


def caso_ajuste_por_cochera(page):
    con = prop("b", 220000, 100, cochera=True)          # Pocitos: cochera vale 30.000 (2.200 vs 2.100 = +5%)
    r = analizar(page, con, COMPS)                      # comparables SIN cochera → +30.000 / 100 m² = +300 US$/m²
    assert r["ref"] == 2100 and r["nivel"] == "justo", f"comparables llevados a 'con cochera': {r}"
    costa = analizar(page, prop("b", 230000, 100, cochera=True, barrio="Solymar", depto="Canelones"),
                     [prop("s%d" % i, 180000, 100, barrio="Solymar", depto="Canelones") for i in range(3)])
    assert costa["ref"] == 1800, "fuera de Montevideo no se ajusta por cochera"


def caso_zona_inve(page):
    inve = [prop("i%d" % i, 90000, 100, direccion="Calle 26 1234") for i in range(3)]
    r = analizar(page, BASE, COMPS + inve)
    assert r["n"] == 5 and r["ref"] == 1800, "zona INVE fuera del promedio"
    r2 = analizar(page, prop("b", 100000, 100, direccion="Calle 125 500"), inve)
    assert r2 and r2["n"] == 3, "si la evaluada también es de esa zona, sí se comparan"


def caso_homogeneizado_de_la_app_igual_al_robot(page):
    """Al pegar un link en vivo la app calcula el homogeneizado sola: misma cuenta que el robot (patio deducido)."""
    r = page.evaluate("[homog(204, 204, 1657, false, 0, 0), homog(97, 111, 388, false, 14, 0), homog(80, 100, 0, true, 0, 0), homog(100, 0, 600, false, 0, 150)]")
    assert r == [495, 164, 85, 133], f"misma cuenta que el robot: {r}"


def caso_huella_de_campana_sobrevive_al_patio(page):
    """Una casa en campaña guardada con el homogeneizado VIEJO (sin patio) se sigue reconociendo si la republican,
    aunque ahora su homogeneizado incluya el patio deducido (2026-11-12)."""
    r = page.evaluate("""() => { var viejo = DATA; var casa = { slug: 'nueva-publicacion', tipo: 'casa', agente: 'Ana Pérez', dorm: 3,
            m2_homog: 495, m2_cub: 204, lat: -34.91, lng: -54.95, direccion: 'X 100', estado_pub: 'active' };
        DATA = [casa];
        var huellaVieja = { tipo: 'casa', agente: norm('Ana Pérez'), direccionN: norm('X 100'), m2: 204, dorm: 3, lat: -34.91, lng: -54.95, desde: '2026-01-01' };
        var huellaNueva = huellaDe(Object.assign({}, casa, { slug: 'vieja' }), '2026-01-01');
        var a = _candidatosHuella(huellaVieja, 'vieja').length, b = _candidatosHuella(huellaNueva, 'vieja').length;
        DATA = viejo; return [a, b]; }""")
    assert r == [1, 1], f"se reconoce con la huella vieja (m² sin patio) y con la nueva: {r}"


def caso_sin_datos_no_inventa(page):
    assert analizar(page, BASE, []) is None, "sin comparables: nada"
    assert analizar(page, prop("b", 50000, 100, tipo="local"), COMPS) is None, "solo casas y aptos"
    assert analizar(page, prop("b", 8000000, 100, moneda="UYU"), COMPS) is None, "venta: solo en dólares"
    assert analizar(page, prop("b", 200000, None), COMPS) is None, "sin m²: nada"


def caso_alquiler_en_pesos(page):
    base = prop("b", 1200, 60, operacion="rent", moneda="USD", precio_usd=1200)
    comps = [prop("r%d" % i, 1000, 60, operacion="rent", precio_usd=1000) for i in range(4)]
    r = analizar(page, base, comps)
    assert r and r["unidad"].startswith("$U") and r["nivel"] == "caro", f"alquiler se muestra en pesos por m² por mes: {r}"


def caso_se_ve_al_traer_un_link(page):
    """Con una propiedad real del listado: al 'Traer' aparece el bloque con el veredicto y la lista de comparables."""
    slug = page.evaluate("""() => { var c = DATA.filter(function (x) { if (x.operacion !== 'sale' || x.moneda !== 'USD' || x.estado_pub !== 'active' || tipoCat(x.tipo) !== 'apto' || !x.m2_homog) return false;
        var r = analisisMercado(x); return r && r.n >= 3; })[0]; return c && c.slug; }""")
    assert slug, "tiene que haber alguna propiedad real con comparables"
    page.evaluate("(s) => { limpiarTodo(); rellenar(BY_SLUG[s]); buscar(); }", slug)
    page.wait_for_function("document.getElementById('precio-mercado').style.display !== 'none'", timeout=5000)
    txt = page.evaluate("$('precio-mercado').textContent")
    assert "%" in txt and any(w in txt for w in ("CARO", "EN PRECIO", "BUEN PRECIO")), f"veredicto visible: {txt[:200]}"
    n = page.evaluate("analisisMercado(window.__base).n")
    page.evaluate("$('pm-ver').click()")
    filas = page.evaluate("document.querySelectorAll('#pm-lista .pm-fila:not(.pm-excl)').length")
    assert filas == n, f"la lista muestra las {n} comparables: {filas}"
    assert page.evaluate("typeof HIST === 'object'"), "el historial se carga (aunque esté vacío)"
    page.evaluate("limpiarTodo(); buscar()")
    assert page.evaluate("$('precio-mercado').style.display") == "none", "sin link no hay análisis"


CASOS = [caso_veredicto_caro, caso_veredicto_en_precio_y_buen_precio, caso_solo_comparables_que_corresponden,
         caso_usa_reservadas_en_negociacion_y_cerradas,
         caso_prioriza_mismos_dormitorios, caso_ajuste_por_cochera, caso_zona_inve, caso_sin_datos_no_inventa,
         caso_alquiler_en_pesos, caso_se_ve_al_traer_un_link, caso_homogeneizado_de_la_app_igual_al_robot,
         caso_huella_de_campana_sobrevive_al_patio]


def main():
    srv = servir()
    fallos = 0
    with sync_playwright() as p:
        br = p.chromium.launch()
        for caso in CASOS:
            page = pagina_nueva(br)
            try:
                caso(page)
                print("OK   ", caso.__name__)
            except AssertionError as e:
                fallos += 1
                print("FALLA", caso.__name__, "->", str(e)[:300])
            except Exception as e:
                fallos += 1
                print("ERROR", caso.__name__, "->", str(e).splitlines()[0][:250])
            page.context.close()
        br.close()
    srv.shutdown()
    print("\n%d de %d casos OK" % (len(CASOS) - fallos, len(CASOS)))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
