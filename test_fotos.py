"""Prueba de las FOTOS: el servidor de fotos de RE/MAX (CloudFront) RECHAZA (403) las fotos pedidas desde la
dirección de la app (github.io) y las da si se piden SIN decir de dónde venimos. La app tiene que pedirlas así
(en la tarjeta, en la vista previa y en la galería), pero el MAPA (OpenStreetMap) sí necesita decir de dónde viene.

Error que vio Juan 2026-11-11: "toco Vista previa en el mapa y no me salen las fotos". Verificado con curl:
la misma foto da 403 con Referer github.io y 200 sin Referer.
Uso: python test_fotos.py
"""
from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, PUERTO
from test_mapa import ficha_simulada, PNG_1X1

BUSCAR = """() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
    SELBARRIOS = ['Pocitos']; renderChips(); $('f-precio-max').value = '300000'; buscar(); }"""


def pagina(br, ancho=420, alto=900):
    ctx = br.new_context(service_workers="block", viewport={"width": ancho, "height": alto})
    pedidos = {"fotos_con_origen": 0, "fotos_ok": 0, "mosaicos_sin_origen": 0}

    def cdn(route, request):   # como RE/MAX: con "Referer" → 403
        if request.headers.get("referer"):
            pedidos["fotos_con_origen"] += 1
            return route.fulfill(status=403, body="Forbidden", content_type="text/html")
        pedidos["fotos_ok"] += 1
        route.fulfill(status=200, body=PNG_1X1, content_type="image/png")

    def osm(route, request):
        if not request.headers.get("referer"):
            pedidos["mosaicos_sin_origen"] += 1
        route.fulfill(status=200, body=PNG_1X1, content_type="image/png")

    ctx.route("**/d1acdg20u0pmxj.cloudfront.net/**", cdn)
    ctx.route("**/tile.openstreetmap.org/**", osm)
    ctx.route("**/findBySlug/**", lambda r: r.fulfill(status=200, body=json.dumps(ficha_simulada()), content_type="application/json"))
    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PUERTO}/", wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    return page, pedidos


def fotos_cargadas(page, sel):
    return page.evaluate("(s) => Array.prototype.map.call(document.querySelectorAll(s), function (i) { return i.complete && i.naturalWidth > 0; })", sel)


def caso_fotos_de_las_tarjetas_cargan(br):
    page, ped = pagina(br)
    page.evaluate(BUSCAR)
    page.evaluate("() => document.querySelectorAll('#cards img.foto').forEach(function (i) { i.loading = 'eager'; })")
    page.wait_for_timeout(1500)
    ok = fotos_cargadas(page, "#cards img.foto")
    assert ok and all(ok[:5]), f"las fotos de las tarjetas no cargan (RE/MAX las rechaza): {ok[:5]}"
    assert ped["fotos_con_origen"] == 0, f"{ped['fotos_con_origen']} fotos se pidieron diciendo de dónde venimos"
    page.context.close()


def caso_fotos_de_la_vista_previa_cargan(br):
    page, ped = pagina(br)
    page.evaluate(BUSCAR)
    page.evaluate("abrirVistaPrevia(RENDER_RES[0])")
    page.wait_for_function("document.querySelectorAll('#vp-fotos img').length >= 5", timeout=10000)
    page.evaluate("() => document.querySelectorAll('#vp-fotos img').forEach(function (i) { i.loading = 'eager'; })")
    page.wait_for_timeout(1500)
    ok = fotos_cargadas(page, "#vp-fotos img")
    assert all(ok), f"las fotos de la vista previa no cargan: {ok}"
    assert ped["fotos_con_origen"] == 0
    page.context.close()


def caso_el_mapa_sigue_diciendo_de_donde_viene(br):
    """OpenStreetMap pide saber desde qué página se usan sus mosaicos (si no, puede bloquear)."""
    page, ped = pagina(br)
    page.evaluate(BUSCAR)
    page.evaluate("abrirMapa()")
    page.wait_for_function("window.L && document.querySelectorAll('#mapa .leaflet-tile').length > 0", timeout=30000)
    page.wait_for_timeout(1000)
    assert ped["mosaicos_sin_origen"] == 0, f"{ped['mosaicos_sin_origen']} mosaicos del mapa se pidieron sin origen"
    page.context.close()


CASOS = [caso_fotos_de_las_tarjetas_cargan, caso_fotos_de_la_vista_previa_cargan, caso_el_mapa_sigue_diciendo_de_donde_viene]


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
