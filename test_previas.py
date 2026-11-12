"""Prueba de "↶ Filtros anteriores" (Juan 2026-11-12): a veces se cambian los filtros de un cliente, se guardan,
y a los días uno se da cuenta de que le erró y no se acuerda cómo estaban. Cada "Guardar cambios" se acuerda de
la versión anterior (solo las ÚLTIMAS 2). Un botón ↶ abre un cartel que pregunta si estás seguro, muestra la fecha
y qué era distinto; "Volver" la recupera (y lo de hoy pasa a ser una anterior: se puede deshacer).

Uso: python test_previas.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

CLIENTE = """() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']); SELBARRIOS = ['Pocitos']; renderChips();
    $('f-precio-max').value = '150000'; setStep('f-dmin', 2); buscar(); guardarBusquedaActual('Otero compra', '099', '', false); buscar(); }"""


def cambiar_y_guardar(page, precio):
    page.evaluate("(p) => { $('f-precio-max').value = p; $('btn-buscar').click(); $('btn-guardar-cambios').click(); }", precio)


def previas(page):
    return page.evaluate("busquedaActiva().previas || []")


def boton_visible(page):
    return page.evaluate("$('btn-previas').style.display !== 'none'")


def caso_sin_cambios_guardados_no_hay_boton(page):
    page.evaluate(CLIENTE)
    assert not boton_visible(page), "recién guardada no hay versiones anteriores → no hay botón"
    assert previas(page) == []


def caso_guardar_cambios_se_acuerda_de_la_anterior(page):
    page.evaluate(CLIENTE)
    cambiar_y_guardar(page, "135000")
    p = previas(page)
    assert len(p) == 1 and p[0]["form"]["precioMax"] == "150000" and p[0]["fecha"], f"se guarda la anterior con fecha: {p}"
    assert boton_visible(page), "con una versión anterior aparece el botón ↶"


def caso_solo_las_ultimas_dos(page):
    page.evaluate(CLIENTE)
    for precio in ("140000", "130000", "120000"):
        cambiar_y_guardar(page, precio)
    p = [x["form"]["precioMax"] for x in previas(page)]
    assert p == ["130000", "140000"], f"solo las 2 últimas, la más reciente primero: {p}"


def caso_guardar_sin_cambios_no_duplica(page):
    page.evaluate(CLIENTE)
    page.evaluate("guardarFiltrosEnCliente()")
    assert previas(page) == [], "guardar sin cambiar nada no crea una versión anterior"


def caso_el_cartel_pregunta_y_muestra_que_cambia(page):
    page.evaluate(CLIENTE)
    cambiar_y_guardar(page, "135000")
    page.evaluate("$('btn-previas').click()")
    assert page.evaluate("$('previas').style.display") == "flex", "se abre el cartel"
    txt = page.evaluate("$('previas').textContent")
    assert "seguro" in txt.lower(), f"pregunta si estás seguro: {txt[:200]}"
    assert "150.000" in txt and "135.000" in txt, f"muestra qué era distinto (antes 150.000, hoy 135.000): {txt[:300]}"
    page.evaluate("$('btn-previas-cancelar').click()")
    assert page.evaluate("$('previas').style.display") == "none"
    assert page.evaluate("$('f-precio-max').value") == "135.000" or page.evaluate("$('f-precio-max').value") == "135000", "cancelar no toca nada"
    assert len(previas(page)) == 1


def caso_volver_recupera_y_se_puede_deshacer(page):
    page.evaluate(CLIENTE)
    slug = page.evaluate("RENDER_RES[0].slug")
    page.evaluate("(s) => setVal(s, 'favorita')", slug)
    cambiar_y_guardar(page, "135000")
    page.evaluate("$('btn-previas').click(); document.querySelector('#previas-lista .prev-volver').click()")
    assert page.evaluate("$('previas').style.display") == "none", "se cierra el cartel"
    assert page.evaluate("$('f-precio-max').value").replace(".", "") == "150000", "el formulario vuelve al de antes"
    assert page.evaluate("busquedaActiva().form.precioMax").replace(".", "") == "150000", "y queda guardado en el cliente"
    assert page.evaluate("busquedaActiva().filtro.precioMaxUsd") == 150000, "el filtro guardado (avisos/nuevas) también"
    p = [x["form"]["precioMax"].replace(".", "") for x in previas(page)]
    assert p == ["135000"], f"lo de hoy pasa a ser la anterior (para deshacer): {p}"
    assert not page.evaluate("filtrosCambiaron()"), "queda sin cambios pendientes"
    assert page.evaluate("(s) => valDe(busquedaActiva(), s)", slug) == "favorita", "las valoraciones no se tocan"


CASOS = [caso_sin_cambios_guardados_no_hay_boton, caso_guardar_cambios_se_acuerda_de_la_anterior, caso_solo_las_ultimas_dos,
         caso_guardar_sin_cambios_no_duplica, caso_el_cartel_pregunta_y_muestra_que_cambia,
         caso_volver_recupera_y_se_puede_deshacer]


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
