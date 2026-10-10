"""Prueba de RESERVADAS / EN NEGOCIACIÓN: nunca salen como resultado nuevo; si ya estaban en la lista
de antes se quedan con un cartel (no desaparecen); y un cartel avisa cuántas se ignoraron.
Navegador real, datos reales.

Pedido de Juan 2026-10-10.

Uso (necesita Playwright, que está en el .venv del proyecto Meta):
    python test_reservadas.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

BUSCAR = """() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
    SELBARRIOS = ['Pocitos', 'Punta Carretas']; renderChips(); $('f-precio-max').value = '300000'; buscar(); }"""

# Cuántas reservadas / en negociación "coinciden" con la búsqueda de arriba (contadas aparte, a mano).
ESPERADAS = """() => {
    var r = { reserved: 0, negotiation: 0 };
    DATA.forEach(function (c) {
        if (c.operacion === 'sale' && tipoCat(c.tipo) === 'apto' && (norm(c.barrio) === 'pocitos' || norm(c.barrio) === 'punta carretas') &&
            c.precio_usd && c.precio_usd <= 300000 && c.estado_pub in r) r[c.estado_pub]++;
    });
    return r; }"""


def banner(page):
    return page.evaluate("document.getElementById('ignoradas').textContent.trim()")


def banner_visible(page):
    return page.evaluate("var e = document.getElementById('ignoradas'); e.style.display !== 'none' && e.textContent.trim() !== ''")


def caso_nunca_trae_reservadas_ni_en_negociacion(page):
    page.evaluate(BUSCAR)
    assert page.evaluate("RENDER_RES.length") >= 5
    malas = page.evaluate("RENDER_RES.filter(function (c) { return c.estado_pub && c.estado_pub !== 'active'; }).length")
    assert malas == 0, f"salieron {malas} reservadas/en negociación como resultado"


def caso_el_cartel_cuenta_las_ignoradas(page):
    page.evaluate(BUSCAR)
    esp = page.evaluate(ESPERADAS)
    assert esp["reserved"] + esp["negotiation"] > 0, "la búsqueda de prueba no tiene reservadas: elegir otra"
    txt = banner(page)
    assert banner_visible(page) and txt.lower().startswith("ignoradas"), f"falta el cartel de ignoradas: '{txt}'"
    if esp["reserved"]:
        palabra = "reservada" if esp["reserved"] == 1 else "reservadas"
        assert f"{esp['reserved']} {palabra}" in txt, f"esperaba {esp['reserved']} {palabra} en: {txt}"
    if esp["negotiation"]:
        assert f"{esp['negotiation']} en negociación" in txt, f"esperaba {esp['negotiation']} en negociación en: {txt}"
    if not esp["reserved"]:
        assert "reservada" not in txt, f"no debería nombrar reservadas: {txt}"
    if not esp["negotiation"]:
        assert "negociación" not in txt, f"no debería nombrar negociación: {txt}"


def caso_sin_ignoradas_no_hay_cartel(page):
    page.evaluate("""() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
        SELBARRIOS = ['Pocitos', 'Punta Carretas']; renderChips(); $('f-precio-max').value = '300000'; buscar();
        DATA.forEach(function (c) { if (c.estado_pub !== 'active') c.estado_pub = 'active'; }); buscar(); }""")
    assert not banner_visible(page), f"no tendría que haber cartel: '{banner(page)}'"


def caso_la_que_ya_estaba_se_queda_con_cartel(page):
    page.evaluate(BUSCAR)
    slug = page.evaluate("RENDER_RES[0].slug")
    esp = page.evaluate(ESPERADAS)
    page.evaluate("(s) => { BY_SLUG[s].estado_pub = 'reserved'; buscar(); }", slug)
    assert slug in page.evaluate("RENDER_RES.map(function (c) { return c.slug; })"), "la que ya estaba se fue de la lista"
    tarjeta = page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0];
        return o ? o.card.textContent : null; }""", slug)
    assert tarjeta and "Reservada" in tarjeta, f"falta el cartel 'Reservada' en la tarjeta: {tarjeta}"
    # y NO cuenta como ignorada (se ve en la lista)
    txt = banner(page)
    n = esp["reserved"]
    if n:
        palabra = "reservada" if n == 1 else "reservadas"
        assert f"{n} {palabra}" in txt, f"las ignoradas no tienen que cambiar: {txt}"


def caso_en_negociacion_tambien_queda_con_cartel(page):
    page.evaluate(BUSCAR)
    slug = page.evaluate("RENDER_RES[0].slug")
    page.evaluate("(s) => { BY_SLUG[s].estado_pub = 'negotiation'; buscar(); }", slug)
    tarjeta = page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0];
        return o ? o.card.textContent : null; }""", slug)
    assert tarjeta and "En negociación" in tarjeta, f"falta el cartel 'En negociación': {tarjeta}"


def caso_con_cliente_guardado_recuerda_la_lista_de_antes(page):
    """Cliente guardado: aunque se cierre y vuelva a abrir la app (se pierde la memoria de la pantalla),
    lo que estaba listado y se reservó sigue ahí con su cartel y NO se marca '🚫 ya no entra'."""
    page.evaluate(BUSCAR)
    page.evaluate("guardarBusquedaActual('Cliente prueba', '099111222', '', false)")
    page.evaluate("buscar()")                       # guarda la lista de este momento en el cliente
    slug = page.evaluate("RENDER_RES[0].slug")
    page.evaluate("(s) => { window.__vistaPrevia = null; window.__ultimaVista = null; BY_SLUG[s].estado_pub = 'reserved'; buscar(); }", slug)
    tarjeta = page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0];
        return o ? o.card.textContent : null; }""", slug)
    assert tarjeta and "Reservada" in tarjeta, f"con cliente, la reservada tiene que seguir en la lista con cartel: {tarjeta}"
    assert "ya no entra" not in tarjeta, f"no es 'ya no entra en el filtro', es reservada: {tarjeta}"
    assert "fuera de criterios" not in tarjeta, f"no es 'fuera de criterios': {tarjeta}"


CASOS = [
    caso_nunca_trae_reservadas_ni_en_negociacion, caso_el_cartel_cuenta_las_ignoradas,
    caso_sin_ignoradas_no_hay_cartel, caso_la_que_ya_estaba_se_queda_con_cartel,
    caso_en_negociacion_tambien_queda_con_cartel, caso_con_cliente_guardado_recuerda_la_lista_de_antes,
]


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
