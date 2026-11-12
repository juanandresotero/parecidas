"""Prueba del DORADO de los cuadros de análisis (Juan 2026-11-12): "¿Está bien de precio?" y "¿Cuánto se puede
alquilar?" quedan en dorado (novedad) durante 24 horas desde la PRIMERA vez que se ven; después, normales.

Uso: python test_dorado.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

CON_LINK = """() => { var c = DATA.filter(function (x) { if (x.operacion !== 'sale' || x.moneda !== 'USD' || x.estado_pub !== 'active' || tipoCat(x.tipo) !== 'apto' || !x.m2_homog) return false;
    return analisisMercado(x) && estimarAlquiler(x) && !estimarAlquiler(x).pocos; })[0];
    limpiarTodo(); rellenar(c); buscar(); }"""
DORADOS = "['precio-mercado', 'alquiler-estim'].map(function (id) { return document.getElementById(id).classList.contains('nuevo-caja'); })"


def caso_dorado_la_primera_vez(page):
    page.evaluate("localStorage.removeItem('parecidas_nv_analisis-desde')")
    page.evaluate(CON_LINK)
    assert page.evaluate(DORADOS) == [True, True], "los dos cuadros en dorado la primera vez"
    desde = page.evaluate("Number(localStorage.getItem('parecidas_nv_analisis-desde'))")
    assert desde > 0, "se anota cuándo se vio por primera vez"


def caso_sigue_dorado_dentro_de_las_24_horas(page):
    page.evaluate("localStorage.setItem('parecidas_nv_analisis-desde', String(Date.now() - 23 * 3600000))")
    page.evaluate(CON_LINK)
    assert page.evaluate(DORADOS) == [True, True], "a las 23 horas sigue en dorado"


def caso_despues_de_24_horas_vuelve_a_lo_normal(page):
    page.evaluate("localStorage.setItem('parecidas_nv_analisis-desde', String(Date.now() - 25 * 3600000))")
    page.evaluate(CON_LINK)
    assert page.evaluate(DORADOS) == [False, False], "pasadas las 24 horas, normales"


def caso_no_se_anota_si_no_se_vio(page):
    page.evaluate("localStorage.removeItem('parecidas_nv_analisis-desde')")
    page.evaluate("() => { limpiarTodo(); setSeg('f-oper', 'sale'); buscar(); }")   # sin link: no hay cuadros
    assert page.evaluate("localStorage.getItem('parecidas_nv_analisis-desde')") is None, "el reloj arranca recién cuando se ven"


CASOS = [caso_dorado_la_primera_vez, caso_sigue_dorado_dentro_de_las_24_horas, caso_despues_de_24_horas_vuelve_a_lo_normal,
         caso_no_se_anota_si_no_se_vio]


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
