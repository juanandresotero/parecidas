"""Prueba de la VISTA DE ESCRITORIO: se detecta sola (ventana ancha + mouse), un botón deja elegir
(Automático / Celular / Escritorio) y el CELULAR NUNCA cambia sola.

Pedido de Juan 2026-11-11: "tengo miedo de que detecte mal un celu o pc y que cambie la forma que se ve
en el celu; un botón seguro tiene que estar, pero estaría bueno que detecte solo".

Uso: python test_escritorio.py
"""
from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, PUERTO
from test_mapa import ficha_simulada

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


PNG_1X1 = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")


def pagina_mapa(br, ancho=1400, alto=900):
    """Compu con los mosaicos del mapa simulados (rápido y sin red)."""
    ctx = br.new_context(service_workers="block", viewport={"width": ancho, "height": alto})
    ctx.route("**/tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, body=PNG_1X1, content_type="image/png"))
    ctx.route("**/d1acdg20u0pmxj.cloudfront.net/**", lambda r: r.fulfill(status=200, body=PNG_1X1, content_type="image/png"))
    ctx.route("**/findBySlug/**", lambda r: r.fulfill(status=200, body=json.dumps(ficha_simulada()), content_type="application/json"))
    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PUERTO}/", wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    return page


def mapa_listo(page):
    page.wait_for_function("window.L && window.MAPA && document.querySelector('#mapa .leaflet-tile-pane')", timeout=30000)


def en_el_panel(page):
    return page.evaluate("document.getElementById('mapa-overlay').parentNode.id || document.getElementById('mapa-overlay').parentNode.tagName")


def caso_en_compu_grande_el_mapa_esta_siempre_a_la_vista(br):
    page = pagina_mapa(br)
    mapa_listo(page)
    assert en_el_panel(page) == "col-mapa", "en pantalla grande el mapa vive en su columna"
    assert caja(page, "#mapa-overlay")["w"] > 350, "el mapa tiene que verse aunque todavía no se buscó nada"
    assert page.evaluate("$('btn-mapa-cerrar').offsetParent === null"), "no hay botón Cerrar: el mapa no se cierra"
    page.evaluate(BUSCAR)
    page.wait_for_function("Object.keys(MAPA_MARCAS).length > 0", timeout=30000)
    marcas = page.evaluate("Object.keys(MAPA_MARCAS).length")
    con_coords = page.evaluate("RENDER_RES.filter(function (c) { return c.lat != null; }).length")
    assert marcas == con_coords, f"el mapa muestra lo mismo que la lista: {marcas} pines vs {con_coords}"
    lista, mapa = caja(page, "#resultados"), caja(page, "#mapa-overlay")
    assert mapa["x"] >= lista["r"] - 1, f"el mapa va a la derecha de la lista: {lista} {mapa}"
    assert page.evaluate("$('btn-mapa').offsetParent === null"), "el botón 'Ver en el mapa' sobra: el mapa ya está"
    assert sin_scroll_horizontal(page)
    page.context.close()


def caso_cada_busqueda_repinta_el_mapa(br):
    page = pagina_mapa(br)
    page.evaluate(BUSCAR)
    page.wait_for_function("Object.keys(MAPA_MARCAS).length > 0", timeout=30000)
    page.evaluate("() => { setSeg('f-oper', 'rent'); $('f-precio-max').value = ''; buscar(); }")
    page.wait_for_function("RENDER_RES.length > 0 && RENDER_RES[0].operacion === 'rent'", timeout=10000)
    ok = page.evaluate("""() => { var n = Object.keys(MAPA_MARCAS).length;
        return n === RENDER_RES.filter(function (c) { return c.lat != null; }).length; }""")
    assert ok, "al buscar de nuevo, el mapa se actualiza con la nueva lista"
    page.context.close()


def caso_el_mas_del_mapa_no_cierra_el_cartelito(br):
    """Con cliente guardado el ＋ marca la ⭐ y la lista se actualiza SIN repintar el mapa (el cartelito queda abierto)."""
    page = pagina_mapa(br)
    page.evaluate(BUSCAR)
    page.wait_for_function("Object.keys(MAPA_MARCAS).length > 0", timeout=30000)
    page.evaluate("guardarBusquedaActual('Cliente prueba', '099111222', '', false)")
    slug = page.evaluate("Object.keys(MAPA_MARCAS)[0]")
    page.evaluate("(s) => MAPA_MARCAS[s].openPopup()", slug)
    page.wait_for_selector(".leaflet-popup .pin-mas", timeout=5000)
    page.locator(".leaflet-popup .pin-mas").click()
    page.wait_for_timeout(400)
    assert page.evaluate("valDe(busquedaActiva(), %r)" % slug) == "a_enviar", "el ＋ tiene que dejar la ⭐ para enviar"
    assert page.locator(".leaflet-popup .pin-mas").count() == 1, "el cartelito no se tiene que cerrar al tocar ＋"
    estrella = page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0]; return !!o && o.card.classList.contains('val-a_enviar'); }""", slug)
    assert estrella, "la tarjeta de la lista también quedó con ⭐"
    page.context.close()


def caso_el_pin_de_la_tarjeta_lleva_al_mapa(br):
    page = pagina_mapa(br)
    page.evaluate(BUSCAR)
    page.wait_for_function("Object.keys(MAPA_MARCAS).length > 0", timeout=30000)
    slug = page.evaluate("RENDER_RES.filter(function (c) { return c.lat != null; })[0].slug")
    page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0]; o.card.querySelector('.card-pin').click(); }""", slug)
    page.wait_for_selector(".leaflet-popup .pin-mas", timeout=5000)
    assert page.evaluate("document.querySelector('.leaflet-popup a.pin-ver').getAttribute('href').endsWith(%r)" % slug), "el cartelito es el de esa propiedad"
    page.context.close()


def caso_ventana_mediana_usa_el_mapa_de_siempre(br):
    page = pagina_mapa(br, 1100, 800)
    page.evaluate(BUSCAR)
    assert es_pc(page) and en_el_panel(page) == "BODY", "entre 1000 y 1199 px hay escritorio pero el mapa sigue siendo el botón de siempre"
    assert page.evaluate("$('btn-mapa').offsetParent !== null"), "el botón del mapa sigue visible"
    assert page.evaluate("$('mapa-overlay').style.display === 'none'"), "y el mapa arranca cerrado"
    page.context.close()


def caso_celular_no_tiene_mapa_fijo(br):
    page = pagina(br, 420, 900, tactil=True)
    page.evaluate(BUSCAR)
    assert en_el_panel(page) == "BODY" and page.evaluate("$('mapa-overlay').style.display === 'none'"), "el celular no muestra el mapa solo"
    page.context.close()


def caso_pasar_a_celular_devuelve_el_mapa_al_boton(br):
    page = pagina_mapa(br)
    page.evaluate(BUSCAR)
    page.wait_for_function("Object.keys(MAPA_MARCAS).length > 0", timeout=30000)
    page.evaluate("$('btn-vista').click()")      # → vista de celular
    assert en_el_panel(page) == "BODY" and page.evaluate("$('mapa-overlay').style.display === 'none'"), "en vista de celular el mapa vuelve a ser el botón"
    page.evaluate("$('btn-vista').click()")      # → escritorio otra vez
    page.wait_for_function("document.getElementById('mapa-overlay').parentNode.id === 'col-mapa'", timeout=5000)
    page.context.close()



# ---------------- Tanda 2 (Juan 2026-11-11): filtros más anchos, pin resaltado, clics de la tarjeta ----------------
def buscar_en_compu(br):
    page = pagina_mapa(br, 1440, 900)
    page.evaluate(BUSCAR)
    page.wait_for_function("Object.keys(MAPA_MARCAS).length > 0", timeout=30000)
    return page


def tarjeta(page, slug, sel):
    return "(function () { var o = CARDS.filter(function (x) { return x.slug === %s; })[0]; return o.card.querySelector(%s); })()" % (json.dumps(slug), json.dumps(sel))


def primera_con_mapa(page, n=0):
    return page.evaluate("RENDER_RES.filter(function (c) { return c.lat != null; })[%d].slug" % n)


def caso_filtros_mas_anchos(br):
    page = buscar_en_compu(br)
    f, l, m = caja(page, ".col-filtros"), caja(page, "#resultados"), caja(page, "#mapa-overlay")
    assert f["w"] >= 400, f"los filtros tienen que ser más anchos (protagonismo): {f['w']}"
    assert l["w"] >= 340 and m["w"] >= 340, f"lista y mapa siguen siendo usables: lista {l['w']} mapa {m['w']}"
    assert sin_scroll_horizontal(page)
    page.context.close()


def caso_ver_en_mapa_resalta_el_pin(br):
    page = buscar_en_compu(br)
    s1, s2 = primera_con_mapa(page, 0), primera_con_mapa(page, 1)
    gota = "MAPA_MARCAS[%s].getElement().querySelector('.pin-gota').classList.contains('pin-foco')"
    page.evaluate(tarjeta(page, s1, ".card-pin") + ".click()")
    page.wait_for_timeout(300)
    assert page.evaluate(gota % json.dumps(s1)), "el pin de la propiedad elegida tiene que quedar resaltado"
    page.evaluate(tarjeta(page, s2, ".card-pin") + ".click()")
    page.wait_for_timeout(300)
    assert page.evaluate(gota % json.dumps(s2)) and not page.evaluate(gota % json.dumps(s1)), "se resalta solo el último"
    page.context.close()


def caso_tocar_el_titulo_abre_el_aviso(br):
    page = buscar_en_compu(br)
    page.context.route("**/www.remax.com.uy/**", lambda r: r.fulfill(status=200, body="<html>aviso</html>", content_type="text/html"))
    s = primera_con_mapa(page)
    with page.context.expect_page(timeout=5000) as nueva:
        page.evaluate(tarjeta(page, s, ".titulo-card") + ".click()")
    assert s in nueva.value.url, f"el título abre el aviso original: {nueva.value.url}"
    page.context.close()


def caso_tocar_otra_parte_no_abre_el_aviso(br):
    page = buscar_en_compu(br)
    paginas = []
    page.context.on("page", lambda p: paginas.append(p))
    s = primera_con_mapa(page)
    page.evaluate(tarjeta(page, s, ".chips") + ".click()")
    page.wait_for_timeout(800)
    assert not paginas, "tocar fuera del título (en escritorio) no abre el aviso"
    page.context.close()


def caso_tocar_la_foto_abre_la_galeria(br):
    page = buscar_en_compu(br)
    paginas = []
    page.context.on("page", lambda p: paginas.append(p))
    s = primera_con_mapa(page)
    page.evaluate(tarjeta(page, s, "img.foto, .foto") + ".click()")
    page.wait_for_function("document.getElementById('galeria').style.display === 'flex'", timeout=5000)
    page.wait_for_function("document.getElementById('gal-cuenta').textContent.indexOf('/ 9') >= 0", timeout=10000)
    assert page.evaluate("$('gal-cuenta').textContent").strip().startswith("1 / 9"), "arranca en la primera de las 9 fotos"
    page.evaluate("$('btn-gal-sig').click()")
    assert page.evaluate("$('gal-cuenta').textContent").strip().startswith("2 / 9")
    page.keyboard.press("ArrowRight")
    assert page.evaluate("$('gal-cuenta').textContent").strip().startswith("3 / 9"), "las flechas del teclado pasan de foto"
    page.keyboard.press("ArrowLeft")
    assert page.evaluate("$('gal-cuenta').textContent").strip().startswith("2 / 9")
    assert page.evaluate("$('gal-img').referrerPolicy") == "no-referrer" or page.evaluate("document.querySelector('meta[name=referrer]') && document.querySelector('meta[name=referrer]').content") == "no-referrer"
    page.keyboard.press("Escape")
    assert page.evaluate("$('galeria').style.display") == "none", "Escape cierra la galería"
    assert not paginas, "la foto no abre el aviso"
    page.context.close()


def caso_vista_previa_de_la_tarjeta_reemplaza_el_mapa(br):
    page = buscar_en_compu(br)
    s = primera_con_mapa(page)
    page.evaluate(tarjeta(page, s, ".card-vp") + ".click()")
    page.wait_for_function("document.getElementById('vista-previa').style.display !== 'none'", timeout=5000)
    assert page.evaluate("document.getElementById('vista-previa').parentNode.id") == "col-mapa", "la ficha va en el lugar del mapa"
    vp, col = caja(page, "#vista-previa"), caja(page, "#col-mapa")
    assert abs(vp["x"] - col["x"]) < 3 and abs(vp["w"] - col["w"]) < 3 and vp["h"] > 300, f"la ficha ocupa la columna del mapa: {vp} {col}"
    page.wait_for_function("document.querySelectorAll('#vp-fotos img').length >= 5", timeout=10000)
    assert "mapa" in page.evaluate("$('btn-vp-x').textContent").lower(), "el botón dice que vuelve al mapa"
    page.evaluate("$('btn-vp-x').click()")
    assert page.evaluate("$('vista-previa').style.display") == "none" and caja(page, "#mapa-overlay")["w"] > 340, "vuelve el mapa"
    page.context.close()


def caso_vista_previa_del_pin_tambien_en_la_columna(br):
    page = buscar_en_compu(br)
    s = primera_con_mapa(page)
    page.evaluate("(s) => MAPA_MARCAS[s].openPopup()", s)
    page.wait_for_selector(".leaflet-popup .pin-prev", timeout=5000)
    page.locator(".leaflet-popup .pin-prev").click()
    page.wait_for_function("document.getElementById('vista-previa').style.display !== 'none'", timeout=5000)
    assert page.evaluate("document.getElementById('vista-previa').parentNode.id") == "col-mapa"
    page.context.close()


def caso_en_el_celu_la_tarjeta_sigue_igual(br):
    page = pagina(br, 420, 900, tactil=True)
    page.evaluate(BUSCAR)
    assert page.evaluate("document.querySelector('.card-vp') === null || document.querySelector('.card-vp').offsetParent === null"), "en el celu no aparece el botón de vista previa nuevo"
    assert page.evaluate("document.getElementById('vista-previa').parentNode.tagName") == "BODY"
    page.context.close()


def caso_cartel_de_campanas_fuera_de_los_filtros(br):
    page = pagina_mapa(br, 1440, 900)
    page.evaluate("$('camp-banner').style.display = ''")
    banner, filtros = caja(page, "#camp-banner"), caja(page, ".col-filtros")
    assert banner["x"] >= filtros["r"] - 1, f"en la compu el cartel no va en la columna de los filtros: {banner} {filtros}"
    assert page.evaluate("$('camp-banner').parentNode.className").find("col-filtros") < 0
    page.evaluate("$('btn-vista').click()")      # → celular: vuelve arriba de todo, como siempre
    assert page.evaluate("$('camp-banner').parentNode.className") == "col-filtros", "en el celu sigue arriba de todo"
    page.context.close()


def caso_ajustes_equilibrado_en_la_compu(br):
    page = pagina_mapa(br, 1440, 900)
    page.evaluate("$('btn-ajustes').click()")
    tarjeta_aj = caja(page, "#ajustes .ajustes-card")
    assert tarjeta_aj["w"] >= 760, f"en la compu Ajustes tiene que ser más ancho: {tarjeta_aj['w']}"
    assert tarjeta_aj["h"] < 850, f"y menos alargado (en dos columnas): alto {tarjeta_aj['h']}"
    vin, aso = caja(page, ".aj-vincular"), caja(page, ".aj-associate")
    assert vin["x"] > aso["r"] - 1, "vincular va en la otra columna"
    page.context.close()
    cel = pagina(br, 420, 900, tactil=True)
    cel.evaluate("$('btn-ajustes').click()")
    assert caja(cel, "#ajustes .ajustes-card")["w"] <= 400, "en el celu Ajustes sigue igual"
    cel.context.close()


def caso_vista_previa_en_la_compu_tiene_toda_la_descripcion(br):
    """Juan 2026-11-11: en la compu la vista previa muestra la descripción COMPLETA (no solo los primeros renglones)."""
    page = buscar_en_compu(br)
    s = primera_con_mapa(page)
    page.evaluate(tarjeta(page, s, ".card-vp") + ".click()")
    page.wait_for_function("document.getElementById('vp-desc').textContent.length > 300", timeout=10000)
    txt = page.evaluate("$('vp-desc').textContent")
    assert len(txt) > 900 and not txt.endswith("…"), f"en la compu va la descripción entera ({len(txt)} letras)"
    page.context.close()
    cel = pagina_mapa(br, 420, 900)               # ventana angosta = vista de celular
    cel.evaluate(BUSCAR)
    cel.evaluate("abrirVistaPrevia(RENDER_RES[0])")
    cel.wait_for_function("document.getElementById('vp-desc').textContent.length > 100", timeout=10000)
    corto = cel.evaluate("$('vp-desc').textContent")
    assert len(corto) <= 262 and corto.endswith("…"), f"en el celu sigue el resumen corto ({len(corto)} letras)"
    cel.context.close()


CASOS = [caso_compu_se_detecta_sola, caso_celular_nunca_cambia, caso_tablet_tactil_ancha_sigue_como_celular,
         caso_compu_con_ventana_angosta_sigue_como_celular, caso_el_boton_cambia_y_se_acuerda,
         caso_en_el_celu_el_boton_de_arriba_no_estorba_pero_hay_ajustes, caso_forzar_celular_en_compu_y_auto_vuelve,
         caso_mapa_y_ventanas_en_escritorio, caso_en_compu_grande_el_mapa_esta_siempre_a_la_vista,
         caso_cada_busqueda_repinta_el_mapa, caso_el_mas_del_mapa_no_cierra_el_cartelito,
         caso_el_pin_de_la_tarjeta_lleva_al_mapa, caso_ventana_mediana_usa_el_mapa_de_siempre,
         caso_celular_no_tiene_mapa_fijo, caso_pasar_a_celular_devuelve_el_mapa_al_boton,
         caso_filtros_mas_anchos, caso_ver_en_mapa_resalta_el_pin, caso_tocar_el_titulo_abre_el_aviso,
         caso_tocar_otra_parte_no_abre_el_aviso, caso_tocar_la_foto_abre_la_galeria,
         caso_vista_previa_de_la_tarjeta_reemplaza_el_mapa, caso_vista_previa_del_pin_tambien_en_la_columna,
         caso_en_el_celu_la_tarjeta_sigue_igual, caso_cartel_de_campanas_fuera_de_los_filtros,
         caso_ajustes_equilibrado_en_la_compu, caso_vista_previa_en_la_compu_tiene_toda_la_descripcion]


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
