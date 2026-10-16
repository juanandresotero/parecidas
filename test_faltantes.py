"""Prueba de "falta el dato": si una propiedad no trae un dato que el filtro pide (cochera, estado, padrón,
gastos, precio), NO se descarta: se muestra con un cartel que dice qué dato falta.

Pedido de Juan 2026-10-16. Uso: python test_faltantes.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva
from test_padron import BASE

CASA = "{ slug: 'y', estado_pub: 'active', operacion: 'sale', tipo: 'casa', m2_homog: 120, m2_padron: 0, precio_usd: 100000, dorm: 3, banos: 1, cochera: false, estado: 'usada', gastos_usd: 50 }"


def f(page, extra):
    return "Object.assign({}, %s, %s)" % (BASE, extra)


def caso_precio_que_falta_pasa_y_se_marca(page):
    r = page.evaluate("""() => { var c = %s; c.precio_usd = null; var f = %s;
        return [pasa(c, f, null), faltantes(c, f)]; }""" % (CASA, f(page, "{ precioMaxUsd: 150000 }")))
    assert r[0] is True and r[1] == ["precio"], f"sin precio: tiene que pasar y marcar 'precio'. Dio {r}"


def caso_cochera_estado_gastos_padron(page):
    r = page.evaluate("""() => { var c = %s; c.cochera = null; c.estado = ''; c.gastos_usd = null; var f = %s;
        return [pasa(c, f, null), faltantes(c, f)]; }""" % (CASA, f(page, "{ cochera: 'si', estado: 'usada', gastosMaxUsd: 100, padronMin: 300 }")))
    assert r[0] is True, "con datos que faltan tiene que pasar igual"
    assert sorted(r[1]) == ["cochera", "estado", "gastos comunes", "padrón"], f"marca los 4 que faltan: {r[1]}"


def caso_datos_completos_no_marcan(page):
    r = page.evaluate("""() => { var c = %s; c.m2_padron = 400; var f = %s;
        return faltantes(c, f); }""" % (CASA, f(page, "{ cochera: 'no', estado: 'usada', gastosMaxUsd: 100, padronMin: 300, precioMaxUsd: 150000 }")))
    assert r == [], f"nada falta: {r}"


def caso_sin_filtros_no_marca(page):
    r = page.evaluate("""() => { var c = %s; c.cochera = null; c.m2_padron = 0; c.gastos_usd = null; c.estado = '';
        return faltantes(c, %s); }""" % (CASA, BASE))
    assert r == [], f"sin filtros no hay nada que marcar: {r}"


def caso_apto_con_superficie_no_falta_padron(page):
    r = page.evaluate("""() => { var c = %s; c.tipo = 'departamento_estandar'; c.m2_homog = 64;
        return faltantes(c, %s); }""" % (CASA, f(page, "{ padronMin: 50 }")))
    assert r == [], f"un apto con superficie no 'falta' padrón: {r}"


def caso_la_tarjeta_muestra_el_cartel(page):
    page.evaluate("""() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
        SELBARRIOS = ['Pocitos', 'Punta Carretas']; renderChips(); setSeg('f-coch', 'si'); buscar(); }""")
    slug = page.evaluate("RENDER_RES[0].slug")
    page.evaluate("(s) => { BY_SLUG[s].cochera = null; buscar(); }", slug)
    txt = page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0]; return o ? o.card.textContent : null; }""", slug)
    assert txt and "Falta dato" in txt and "cochera" in txt, f"la tarjeta tiene que decir qué dato falta: {txt}"


CASOS = [caso_precio_que_falta_pasa_y_se_marca, caso_cochera_estado_gastos_padron, caso_datos_completos_no_marcan,
         caso_sin_filtros_no_marca, caso_apto_con_superficie_no_falta_padron, caso_la_tarjeta_muestra_el_cartel]


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
