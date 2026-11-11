"""Prueba de la VISTA DE ESCRITORIO: se detecta sola (ventana ancha + mouse), un botón deja elegir
(Automático / Celular / Escritorio) y el CELULAR NUNCA cambia sola.

Pedido de Juan 2026-11-11: "tengo miedo de que detecte mal un celu o pc y que cambie la forma que se ve
en el celu; un botón seguro tiene que estar, pero estaría bueno que detecte solo".

Uso: python test_escritorio.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, PUERTO

BUSCAR = """() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
    SELBARRIOS = ['Pocitos', 'Punta Carretas']; renderChips(); $('f-precio-max').value = '300000'; buscar(); }"""


def pagina(br, ancho, alto, tactil=False, pref=None):
    ctx = br.new_context(service_workers="block", viewport={"width": ancho, "height": alto},
                         has_touch=tactil, is_mobile=tactil)
    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PUERTO}/", wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    if pref is not None:
        page.evaluate("(p) => localStorage.setItem('parecidas_vista', p)", pref)
        page.reload(wait_until="load")
        page.wait_for_function("DATA.length > 0", timeout=20000)
    return page


def es_pc(page):
    return page.evaluate("document.body.classList.contains('vista-pc')")


def caja(page, sel):
    return page.evaluate("(s) => { var r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }", sel)


def sin_scroll_horizontal(page):
    return page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")


def caso_compu_se_detecta_sola(br):
    page = pagina(br, 1400, 900)
    assert es_pc(page), "ventana ancha con mouse: tiene que verse como escritorio"
    page.evaluate(BUSCAR)
    filtros, res = caja(page, "#btn-buscar"), caja(page, "#resultados")
    assert res["x"] >= filtros["r"] - 1, f"en escritorio los resultados van al costado de los filtros: {filtros} {res}"
    assert caja(page, ".wrap")["w"] > 900, "el contenedor tiene que usar el ancho de la pantalla"
    assert sin_scroll_horizontal(page), "no puede haber scroll horizontal"
    page.context.close()


def caso_celular_nunca_cambia(br):
    page = pagina(br, 420, 900, tactil=True)
    assert not es_pc(page), "un celular NO tiene que pasar a escritorio"
    page.evaluate(BUSCAR)
    filtros, res = caja(page, "#btn-buscar"), caja(page, "#resultados")
    assert res["y"] >= filtros["b"] - 1 and caja(page, ".wrap")["w"] <= 441, f"el celular sigue en una columna de 440: {filtros} {res}"
    assert sin_scroll_horizontal(page)
    page.context.close()


def caso_tablet_tactil_ancha_sigue_como_celular(br):
    """Una tablet horizontal (1100 px, táctil) se parece a una compu por el ancho: NO debe cambiar sola."""
    page = pagina(br, 1100, 800, tactil=True)
    assert not es_pc(page), "pantalla táctil (sin mouse): se queda en vista de celular"
    page.context.close()


def caso_compu_con_ventana_angosta_sigue_como_celular(br):
    page = pagina(br, 800, 900)
    assert not es_pc(page), "ventana angosta: vista de celular aunque sea compu"
    page.context.close()


def caso_el_boton_cambia_y_se_acuerda(br):
    page = pagina(br, 1400, 900)
    assert page.evaluate("$('btn-vista').offsetParent !== null"), "en compu el botón se ve arriba"
    page.evaluate("$('btn-vista').click()")          # escritorio → celular
    assert not es_pc(page), "el botón tiene que pasar a vista de celular"
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    assert not es_pc(page), "se acuerda lo que elegiste al recargar"
    page.evaluate("$('btn-vista').click()")          # celular → escritorio
    assert es_pc(page), "el botón vuelve a escritorio"
    page.context.close()


def caso_en_el_celu_el_boton_de_arriba_no_estorba_pero_hay_ajustes(br):
    page = pagina(br, 420, 900, tactil=True)
    assert page.evaluate("$('btn-vista').offsetParent === null"), "en un celu el botón no ocupa lugar arriba"
    page.evaluate("$('btn-ajustes').click()")
    for i in ("vista-auto", "vista-celu", "vista-pc"):
        assert page.evaluate("$('%s').offsetParent !== null" % i), f"falta {i} en Ajustes"
    page.evaluate("$('vista-pc').click()")
    assert es_pc(page), "desde Ajustes se puede forzar escritorio"
    assert sin_scroll_horizontal(page), "forzado en un celu no puede romper el ancho"
    page.evaluate("$('vista-auto').click()")
    assert not es_pc(page), "Automático en un celu = celular"
    page.context.close()


def caso_forzar_celular_en_compu_y_auto_vuelve(br):
    page = pagina(br, 1400, 900)
    page.evaluate("$('btn-ajustes').click()")
    page.evaluate("$('vista-celu').click()")
    assert not es_pc(page)
    page.evaluate("$('vista-auto').click()")
    assert es_pc(page), "Automático en una compu = escritorio"
    page.context.close()


def caso_mapa_y_ventanas_en_escritorio(br):
    page = pagina(br, 1400, 900)
    page.evaluate(BUSCAR)
    page.evaluate("$('btn-ajustes').click()")
    assert caja(page, ".ajustes-card")["r"] < 1400 and sin_scroll_horizontal(page)
    page.context.close()


CASOS = [caso_compu_se_detecta_sola, caso_celular_nunca_cambia, caso_tablet_tactil_ancha_sigue_como_celular,
         caso_compu_con_ventana_angosta_sigue_como_celular, caso_el_boton_cambia_y_se_acuerda,
         caso_en_el_celu_el_boton_de_arriba_no_estorba_pero_hay_ajustes, caso_forzar_celular_en_compu_y_auto_vuelve,
         caso_mapa_y_ventanas_en_escritorio]


def main():
    srv = servir()
    fallos = 0
    with sync_playwright() as p:
        br = p.chromium.launch()
        for caso in CASOS:
            try:
                caso(br)
                print("OK   ", caso.__name__)
            except AssertionError as e:
                fallos += 1
                print("FALLA", caso.__name__, "->", str(e)[:300])
            except Exception as e:
                fallos += 1
                print("ERROR", caso.__name__, "->", str(e).splitlines()[0][:250])
        br.close()
    srv.shutdown()
    print("\n%d de %d casos OK" % (len(CASOS) - fallos, len(CASOS)))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
