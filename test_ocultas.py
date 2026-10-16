"""Prueba de "🧹 Limpiar" (despejar la pantalla del cliente) en un navegador real, con los datos reales.

Regla que se cuida (pedido de Juan 2026-10-16): Limpiar solo despeja la pantalla; NO oculta nada.
Al tocar Buscar vuelve todo lo que coincide con los filtros, incluso lo que se había limpiado.

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


def caso_limpiar_despeja_y_buscar_trae_todo_de_nuevo(br):
    """Pedido de Juan 2026-10-16: Limpiar saca todo de la pantalla pero NO oculta nada:
    al tocar Buscar con los mismos filtros tiene que volver lo mismo que se limpió."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    antes = mostradas(page)
    assert antes > 0
    limpiar_todo_lo_que_se_ve(page)
    assert mostradas(page) == 0, "Limpiar tendría que dejar la lista vacía"
    page.evaluate("$('btn-buscar').click()")
    assert mostradas(page) == antes, f"Buscar tiene que traer lo mismo de antes: {mostradas(page)} vs {antes}"


def caso_limpiar_y_cambiar_filtros_trae_todo(br):
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    limpiar_todo_lo_que_se_ve(page)
    cambiar_filtros_y_buscar(page, ANCHA)
    assert mostradas(page) == deberian_mostrarse(page), (
        f"faltan propiedades que coinciden: muestra {mostradas(page)}, debería {deberian_mostrarse(page)}")


def caso_limpiar_solo_lo_tildado(br):
    """Limpiar por categoría: solo sale la categoría tildada; el resto queda; y Buscar las trae de nuevo."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    antes = mostradas(page)
    assert antes >= 2
    slug = page.evaluate("RENDER_RES[0].slug")
    page.evaluate("(s) => { setVal(s, 'favorita'); buscar(); }", slug)
    page.evaluate("""() => { $('btn-limpiar').click();
        document.querySelectorAll('#limpiar-lista .lm-chk').forEach(c => c.checked = (c.getAttribute('data-clave') !== 'favorita'));
        $('btn-limpiar-borrar').click(); }""")
    assert page.evaluate("RENDER_RES.map(c => c.slug)") == [slug], "tendría que quedar solo la favorita"
    page.evaluate("$('btn-buscar').click()")
    assert mostradas(page) == antes, "al buscar de nuevo vuelven las que se limpiaron"


def caso_cliente_viejo_con_ocultas_guardadas(br):
    """Clientes guardados con el sistema viejo (b.ocultas): ya no esconden nada."""
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    antes = mostradas(page)
    page.evaluate("""() => {
        var arr = cargarBusquedas();
        arr[0].ocultas = RENDER_RES.map(c => c.slug);
        arr[0].ocultasFiltro = snapshotFiltros();
        guardarBusquedas(arr);
        abrirBusqueda(arr[0].id);
    }""")
    assert mostradas(page) == antes, "las 'ocultas' viejas no deben esconder nada"


def caso_ya_no_hay_boton_restaurar(br):
    page = pagina_nueva(br)
    cliente_con_busqueda_angosta(page)
    assert page.evaluate("document.getElementById('btn-limpiar-restaurar') === null"), "ya no hay nada que restaurar"


CASOS = [caso_limpiar_despeja_y_buscar_trae_todo_de_nuevo, caso_limpiar_y_cambiar_filtros_trae_todo,
         caso_limpiar_solo_lo_tildado, caso_cliente_viejo_con_ocultas_guardadas, caso_ya_no_hay_boton_restaurar]


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
