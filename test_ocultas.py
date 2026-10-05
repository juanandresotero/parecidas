"""Prueba de "🧹 Limpiar" (propiedades ocultas del cliente) en un navegador real, con los datos reales.

Regla que se cuida: lo que se oculta con Limpiar vale SOLO para esa búsqueda. Si cambiás los
filtros es otra búsqueda → cuenta nueva (lo ocultado antes NO tapa lo que ahora coincide).

Uso (necesita Playwright, que está en el .venv del proyecto Meta):
    python test_ocultas.py
"""
from __future__ import annotations

import functools
import http.server
import os
import sys
import threading

from playwright.sync_api import sync_playwright

CARPETA = os.path.dirname(os.path.abspath(__file__))
PUERTO = 8765
TOPE = 300  # TOPE_RESULTADOS de app.js

# Búsqueda "angosta" (2 dorm, hasta 150 mil) y "ancha" (2-3 dorm, hasta 200 mil: incluye la angosta).
ANGOSTA = "setStep('f-dmin', 2); setStep('f-dmax', 2); $('f-precio-max').value = '150000';"
ANCHA = "setStep('f-dmin', 2); setStep('f-dmax', 3); $('f-precio-max').value = '200000';"


def servir():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=CARPETA)
    h.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PUERTO), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def pagina_nueva(browser):
    ctx = browser.new_context(service_workers="block", viewport={"width": 420, "height": 900})
    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PUERTO}/", wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    return page


def cliente_con_busqueda_angosta(page):
    page.evaluate("() => { setSeg('f-oper','sale'); setSeg('f-moneda','USD'); " + ANGOSTA + " buscar(); }")
    page.evaluate("guardarBusquedaActual('Cliente prueba', '099111222', '', false)")


def limpiar_todo_lo_que_se_ve(page):
    """El gesto real de Juan: 🧹 Limpiar → tilda todo → Borrar lo tildado."""
    page.evaluate("""() => {
        $('btn-limpiar').click();
        document.querySelectorAll('#limpiar-lista .lm-chk').forEach(c => c.checked = true);
        $('btn-limpiar-borrar').click();
    }""")


def cambiar_filtros_y_buscar(page, filtros):
    page.evaluate("() => { " + filtros + " $('btn-buscar').click(); }")


def mostradas(page):
    return page.evaluate("RENDER_RES.length")


def deberian_mostrarse(page):
    n = page.evaluate("DATA.filter(c => pasa(c, leerFiltros(), null)).length")
    return min(n, TOPE)


def boton_restaurar_visible(page):
    page.evaluate("$('btn-limpiar').click()")
    return page.evaluate("$('limpiar-restaurar-wrap').style.display !== 'none'")


def caso_cambio_de_filtros_trae_todo(br):
    """El bug: limpiar, cambiar filtros, Buscar → tiene que mostrar TODO lo que coincide."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    limpiar_todo_lo_que_se_ve(page)
    assert mostradas(page) == 0, "Limpiar tendría que dejar la lista vacía"
    cambiar_filtros_y_buscar(page, ANCHA)
    assert mostradas(page) == deberian_mostrarse(page), (
        f"faltan propiedades que coinciden: muestra {mostradas(page)}, debería {deberian_mostrarse(page)}")
    assert not boton_restaurar_visible(page), "no hay nada oculto vigente: no debe ofrecer 'Restaurar'"


def caso_misma_busqueda_sigue_oculta(br):
    """Lo que NO hay que romper: con los MISMOS filtros, lo limpiado sigue oculto y se puede restaurar."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    antes = mostradas(page)
    limpiar_todo_lo_que_se_ve(page)
    page.evaluate("$('btn-buscar').click()")
    assert mostradas(page) == 0, "mismos filtros: lo limpiado debe seguir oculto"
    assert boton_restaurar_visible(page), "mismos filtros: debe ofrecer 'Restaurar'"
    page.evaluate("$('btn-limpiar-restaurar').click()")
    assert mostradas(page) == antes, "Restaurar tiene que traer de vuelta todo"


def caso_limpiar_sobre_filtros_sin_guardar(br):
    """Cambiás filtros (sin guardar), buscás y limpiás ahí: ese limpiar tiene que valer."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    cambiar_filtros_y_buscar(page, ANCHA)
    limpiar_todo_lo_que_se_ve(page)
    assert mostradas(page) == 0, "limpiar sobre filtros sin guardar tiene que ocultar"
    page.evaluate("$('btn-buscar').click()")
    assert mostradas(page) == 0, "y al volver a buscar con esos mismos filtros sigue oculto"
    page.evaluate("guardarFiltrosEnCliente()")
    assert page.evaluate("(busquedaActiva().ocultas || []).length") > 0, (
        "guardar esos filtros NO debe borrar lo que se limpió con ellos")


def caso_guardar_filtros_nuevos_arranca_de_cero(br):
    """Guardar filtros distintos en el cliente = cuenta nueva: no queda basura vieja guardada."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    limpiar_todo_lo_que_se_ve(page)
    cambiar_filtros_y_buscar(page, ANCHA)
    page.evaluate("guardarFiltrosEnCliente()")
    assert page.evaluate("(busquedaActiva().ocultas || []).length") == 0, "debe arrancar sin ocultas"
    page.evaluate("$('btn-buscar').click()")
    assert mostradas(page) == deberian_mostrarse(page)


def caso_cliente_viejo_sin_huella(br):
    """Clientes guardados ANTES del arreglo (ocultas sin 'huella'): siguen ocultas con sus filtros
    y se liberan solas al cambiar los filtros."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    page.evaluate("""() => {
        var arr = cargarBusquedas();
        arr[0].ocultas = RENDER_RES.map(c => c.slug);
        delete arr[0].ocultasFiltro;
        guardarBusquedas(arr);
        abrirBusqueda(arr[0].id);
    }""")
    assert mostradas(page) == 0, "cliente viejo: con sus filtros, lo oculto sigue oculto"
    cambiar_filtros_y_buscar(page, ANCHA)
    assert mostradas(page) == deberian_mostrarse(page), "cliente viejo: al cambiar filtros se libera"


CASOS = [caso_cambio_de_filtros_trae_todo, caso_misma_busqueda_sigue_oculta,
         caso_limpiar_sobre_filtros_sin_guardar, caso_guardar_filtros_nuevos_arranca_de_cero,
         caso_cliente_viejo_sin_huella]


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
                print("FALLA", caso.__name__, "->", e)
        br.close()
    srv.shutdown()
    print("\n%d de %d casos OK" % (len(CASOS) - fallos, len(CASOS)))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
