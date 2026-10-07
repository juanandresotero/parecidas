"""Prueba de la operación "Alquiler temporario" (botón Temporario, tarjetas, links) y de su ventanita
de Novedades + resaltado amarillo, en un navegador real con los datos reales.

Pedido de Juan 2026-10-07: hay ~111 temporarios (96 en Maldonado) que antes no se podían buscar nunca.

Uso (necesita Playwright, que está en el .venv del proyecto Meta):
    python test_temporal.py
"""
from __future__ import annotations

import json
import os
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva, PUERTO

CARPETA = os.path.dirname(os.path.abspath(__file__))
LISTINGS = json.load(open(os.path.join(CARPETA, "listings.json"), encoding="utf-8"))["listings"]


def activas(operacion):
    return [x for x in LISTINGS if x["operacion"] == operacion and x.get("estado_pub") in (None, "active")]


def caso_el_boton_temporario_busca_los_temporarios(page):
    r = page.evaluate("""() => { limpiarTodo();
        var b = document.querySelector('#f-oper button[data-v="temporal"]'); if (!b) return null;
        b.click(); var f = leerFiltros();
        return { oper: f.operacion, moneda: segVal('f-moneda'),
                 slugs: DATA.filter(function (c) { return pasa(c, f, null); }).map(function (c) { return c.slug; }) }; }""")
    assert r is not None, "no existe el botón Temporario en Operación"
    assert r["oper"] == "temporal", f"la operación elegida tiene que ser 'temporal' y es {r['oper']}"
    assert r["moneda"] == "USD", f"los temporarios son casi todos en dólares, y la moneda quedó en {r['moneda']}"
    esperado = {x["slug"] for x in activas("temporal")}
    assert set(r["slugs"]) == esperado, f"debe traer los {len(esperado)} temporarios, trajo {len(r['slugs'])}"


def caso_alquiler_comun_no_cambia(page):
    r = page.evaluate("""() => { limpiarTodo(); document.querySelector('#f-oper button[data-v="rent"]').click();
        var f = leerFiltros(); var n = DATA.filter(function (c) { return pasa(c, f, null); });
        return { moneda: segVal('f-moneda'), todasRent: n.every(function (c) { return c.operacion === 'rent'; }), n: n.length }; }""")
    assert r["moneda"] == "UYU" and r["todasRent"] and r["n"] == len(activas("rent")), f"el Alquiler de siempre cambió: {r}"


def caso_la_tarjeta_dice_alquiler_temporario(page):
    slug = activas("temporal")[0]["slug"]
    r = page.evaluate("(s) => [resumen(BY_SLUG[s]), resumenCard(BY_SLUG[s])]", slug)
    assert all(t.startswith("Alquiler temporario") for t in r), f"la tarjeta dice otra cosa: {r}"
    venta = activas("sale")[0]["slug"]
    assert page.evaluate("(s) => resumen(BY_SLUG[s])", venta).startswith("Venta"), "la venta dejó de decir Venta"


def caso_un_link_temporario_carga_temporario(page):
    slug = activas("temporal")[0]["slug"]
    oper = page.evaluate("(s) => { limpiarTodo(); rellenar(BY_SLUG[s]); return segVal('f-oper'); }", slug)
    assert oper == "temporal", f"al pegar un link de temporario el filtro quedó en '{oper}'"


def caso_boton_amarillo_hasta_el_primer_toque(br):
    page = pagina_nueva(br)
    es_nuevo = "document.querySelector('#f-oper button[data-v=\"temporal\"]').classList.contains('nuevo')"
    assert page.evaluate(es_nuevo), "el botón Temporario tiene que arrancar en amarillo"
    page.evaluate("document.querySelector('#f-oper button[data-v=\"temporal\"]').click()")
    assert not page.evaluate(es_nuevo), "al tocarlo una vez tiene que volver a lo normal"
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    assert not page.evaluate(es_nuevo), "ya lo usó: no tiene que volver a amarillo al recargar"


VENTANITA = "news-temporal-mapa"   # una sola ventanita: temporarios + visor por mapa


def _usuario_que_ya_conocia_la_app(page):
    """Alguien que ya usaba la app y YA VIO la ventanita de temporarios (v86), pero no esta versión con el mapa.
    (La 1ª carga de pagina_nueva lo trató como usuario nuevo y marcó todo visto: ajustamos lo que corresponde.)"""
    page.evaluate("""() => { ['news', 'news-agente', 'news-avisos', 'news-temporal', 'temporal-btn', 'iniciado'].forEach(function (k) {
        localStorage.setItem('parecidas_nv_' + k, '1'); });
        ['news-temporal-mapa', 'mapa-btn'].forEach(function (k) { localStorage.removeItem('parecidas_nv_' + k); });
        localStorage.setItem('parecidas_busquedas', '[]'); }""")
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    page.wait_for_timeout(300)


def caso_ventanita_vuelve_a_salir_con_lo_del_mapa_a_quien_ya_vio_la_de_temporarios(br):
    page = pagina_nueva(br)
    _usuario_que_ya_conocia_la_app(page)
    visible = f"document.getElementById('{VENTANITA}') && getComputedStyle(document.getElementById('{VENTANITA}')).display !== 'none'"
    assert page.evaluate(visible), "quien ya vio la ventanita de temporarios tiene que ver esta, con lo del mapa"
    txt = page.evaluate(f"document.getElementById('{VENTANITA}').textContent")
    assert "emporario" in txt and "apa" in txt, f"la ventanita tiene que hablar de temporarios Y del mapa: {txt}"
    assert len(txt) < 420, f"tiene que ser súper breve ({len(txt)} caracteres)"
    assert page.evaluate("document.querySelectorAll('#%s li').length" % VENTANITA) == 3, "debe tener 3 renglones: 2 de temporarios y 1 del mapa"
    assert not page.evaluate("['news','news-agente','news-avisos'].some(function (k) { return getComputedStyle(document.getElementById(k)).display !== 'none'; })"), \
        "no se deben mostrar las ventanitas viejas a la vez"
    page.evaluate("document.getElementById('btn-news-temporal-ok').click()")
    assert not page.evaluate(visible), "'Entendido' tiene que cerrarla"
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    page.wait_for_timeout(300)
    assert not page.evaluate(visible), "una vez vista no tiene que volver a salir"


def caso_el_boton_del_mapa_arranca_en_amarillo_hasta_el_primer_toque(br):
    page = pagina_nueva(br)
    es_nuevo = "document.getElementById('btn-mapa').classList.contains('nuevo')"
    assert page.evaluate(es_nuevo), "el botón del mapa tiene que arrancar en amarillo"
    page.evaluate("""() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
        SELBARRIOS = ['Pocitos']; renderChips(); buscar(); document.getElementById('btn-mapa').click(); }""")
    assert not page.evaluate(es_nuevo), "al tocarlo una vez tiene que volver a lo normal"
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    assert not page.evaluate(es_nuevo), "ya lo usó: no tiene que volver a amarillo al recargar"


def caso_ventanita_no_sale_a_quien_abre_la_app_por_primera_vez(br):
    page = pagina_nueva(br)
    visible = "['news','news-agente','news-avisos','news-temporal-mapa'].some(function (k) { var e = document.getElementById(k); return e && getComputedStyle(e).display !== 'none'; })"
    page.wait_for_timeout(300)
    assert not page.evaluate(visible), "la primera vez que alguien abre la app no se le muestran novedades"


CASOS_PAGINA = [caso_el_boton_temporario_busca_los_temporarios, caso_alquiler_comun_no_cambia,
                caso_la_tarjeta_dice_alquiler_temporario, caso_un_link_temporario_carga_temporario]
CASOS_NAVEGADOR = [caso_boton_amarillo_hasta_el_primer_toque, caso_el_boton_del_mapa_arranca_en_amarillo_hasta_el_primer_toque,
                   caso_ventanita_vuelve_a_salir_con_lo_del_mapa_a_quien_ya_vio_la_de_temporarios,
                   caso_ventanita_no_sale_a_quien_abre_la_app_por_primera_vez]


def main():
    srv = servir()
    fallos = 0
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = pagina_nueva(br)
        for caso, arg in [(c, page) for c in CASOS_PAGINA] + [(c, br) for c in CASOS_NAVEGADOR]:
            try:
                caso(arg)
                print("OK   ", caso.__name__)
            except AssertionError as e:
                fallos += 1
                print("FALLA", caso.__name__, "->", e)
            except Exception as e:
                fallos += 1
                print("ERROR", caso.__name__, "->", str(e).splitlines()[0][:200])
        br.close()
    srv.shutdown()
    total = len(CASOS_PAGINA) + len(CASOS_NAVEGADOR)
    print("\n%d de %d casos OK" % (total - fallos, total))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
