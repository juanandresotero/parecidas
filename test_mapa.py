"""Prueba del MAPA (cartelito con "+", "Vista previa" en ventana, "Ver aviso completo") y de que la
SELECCIÓN para enviar no se pierde (al volver a dibujar, al recargar la app o al volver de "Ver aviso"),
más el desempate del orden por m². Navegador real, datos reales (la ficha de RE/MAX va simulada).

Pedido de Juan 2026-10-07.

Uso (necesita Playwright, que está en el .venv del proyecto Meta):
    python test_mapa.py
"""
from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

PNG_1X1 = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")


def ficha_simulada(n_fotos=9):
    return {"data": {"data": {
        "title": "VENTA APARTAMENTO PRUEBA", "bedrooms": 2, "bathrooms": 2, "toilets": 1, "parkingSpaces": 1,
        "dimensionTotalBuilt": 77.5, "dimensionCovered": 70.2, "dimensionLand": 0, "yearBuilt": 2019,
        "floors": 7, "expensesPrice": 4500, "expensesCurrency": {"value": "UYU"}, "furnished": False,
        "displayAddress": "Calle Falsa 1234", "price": 150000, "currency": {"value": "USD"},
        "description": "<p>Hermoso apartamento luminoso con vista despejada.</p> " + "Muy buena distribución. " * 40,
        "features": [{"category": "amenities", "value": "Parrillero"}, {"category": "amenities", "value": "Gimnasio"}],
        "photos": [{"value": f"listings/aaa/foto{i}.jpg", "position": i} for i in range(n_fotos)],
        "listingStatus": {"value": "active"}}}}


def preparar(page, ficha=True):
    """Imágenes y mosaicos del mapa simulados (rápido y sin red); ficha de RE/MAX simulada o caída."""
    page.route("**/*.png", lambda r: r.fulfill(status=200, body=PNG_1X1, content_type="image/png") if "tile.openstreetmap" in r.request.url else r.continue_())
    page.route("**/tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, body=PNG_1X1, content_type="image/png"))
    page.route("**/d1acdg20u0pmxj.cloudfront.net/**", lambda r: r.fulfill(status=200, body=PNG_1X1, content_type="image/png"))
    if ficha:
        page.route("**/findBySlug/**", lambda r: r.fulfill(status=200, body=json.dumps(ficha_simulada()), content_type="application/json"))
    else:
        page.route("**/findBySlug/**", lambda r: r.abort())
    page.evaluate("""() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
        SELBARRIOS = ['Pocitos']; renderChips(); $('f-precio-max').value = '300000'; buscar(); }""")
    assert page.evaluate("RENDER_RES.length") >= 5, "la búsqueda de prueba no dio resultados"


def abrir_mapa(page):
    page.evaluate("abrirMapa()")
    page.wait_for_function("window.L && window.MAPA_MARCAS && Object.keys(MAPA_MARCAS).length > 0", timeout=30000)
    return page.evaluate("Object.keys(MAPA_MARCAS)[0]")


def abrir_cartelito(page, slug):
    page.evaluate("(s) => MAPA_MARCAS[s].openPopup()", slug)
    page.wait_for_selector(".leaflet-popup .pin-mas", timeout=5000)


def cerrar_mapa(page):
    page.evaluate("document.getElementById('btn-mapa-cerrar').click()")


def elegidas(page):
    return page.evaluate("SEL.map(function (c) { return c.slug; })")


def cuenta_multibar(page):
    return page.evaluate("document.getElementById('btn-multicopy').textContent")


# ----------------------------- cartelito -----------------------------
def caso_el_cartelito_tiene_mas_vista_previa_y_ver_aviso_completo(page):
    preparar(page)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    txt = page.evaluate("document.querySelector('.leaflet-popup').textContent")
    assert page.locator(".leaflet-popup .pin-mas").count() == 1, "falta el botón +"
    assert "Vista previa" in txt, f"falta el botón de vista previa: {txt}"
    assert "Ver aviso completo" in txt, f"el link tiene que decir 'Ver aviso completo': {txt}"
    assert page.locator(".leaflet-popup a", has_text="Ver aviso completo").get_attribute("href").endswith(slug)


def caso_el_mas_deja_la_propiedad_elegida_al_cerrar_el_mapa(page):
    preparar(page)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    assert page.locator(".leaflet-popup .pin-mas").inner_text().strip() == "＋"
    page.locator(".leaflet-popup .pin-mas").click()
    assert elegidas(page) == [slug], f"el + no eligió la propiedad: {elegidas(page)}"
    assert page.locator(".leaflet-popup .pin-mas").inner_text().strip() == "✓", "el botón tiene que mostrar que ya está elegida"
    assert page.evaluate("MAPA_MARCAS[%s].getElement().querySelector('.pin-gota').classList.contains('pin-sel')" % json.dumps(slug)), "el pin tiene que marcarse como elegido"
    cerrar_mapa(page)
    r = page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0];
        return o ? { tilda: o.card.querySelector('.card-check').checked, num: o.numEl.textContent } : null; }""", slug)
    assert r and r["tilda"] and r["num"] == "1", f"al volver a la lista la tarjeta tiene que estar tildada: {r}"
    assert "(1)" in cuenta_multibar(page), f"el botón de enviar/copiar no cuenta la elegida: {cuenta_multibar(page)}"


def caso_el_mas_tambien_la_saca(page):
    preparar(page)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    page.locator(".leaflet-popup .pin-mas").click()
    page.locator(".leaflet-popup .pin-mas").click()
    assert elegidas(page) == [] and page.locator(".leaflet-popup .pin-mas").inner_text().strip() == "＋", "el segundo toque tiene que sacarla"


def caso_con_cliente_el_mas_marca_para_enviar(page):
    """Con un cliente normal la ⭐ 'Para enviar' ES la selección. Y sacarla devuelve lo que tenía (💚)."""
    preparar(page)
    page.evaluate("guardarBusquedaActual('Cliente prueba', '099111222', '', false); buscar();")
    slug = abrir_mapa(page)
    page.evaluate("(s) => { setVal(s, 'favorita'); MAPA_VF.favorita = true; pintarMapa(); }", slug)
    abrir_cartelito(page, slug)
    page.locator(".leaflet-popup .pin-mas").click()
    assert page.evaluate("valDe(busquedaActiva(), %s)" % json.dumps(slug)) == "a_enviar", "el + tiene que marcar ⭐ Para enviar"
    page.locator(".leaflet-popup .pin-mas").click()
    assert page.evaluate("valDe(busquedaActiva(), %s)" % json.dumps(slug)) == "favorita", "al sacarla tiene que volver a 💚 como estaba"
    page.locator(".leaflet-popup .pin-mas").click()
    cerrar_mapa(page)
    assert elegidas(page) == [slug] and "(1)" in cuenta_multibar(page), f"al cerrar, la ⭐ tiene que contar para enviar: {elegidas(page)}"


# ----------------------------- el "−": descartar desde el mapa (solo con cliente abierto) -----------------------------
def _cliente(page, campana=False):
    page.evaluate("""(camp) => { guardarBusquedaActual('Cliente prueba', '099111222', '', false);
        if (camp) { var a = cargarBusquedas(); a[0].campana = true; guardarBusquedas(a); } buscar(); }""", campana)


def caso_con_cliente_el_menos_descarta_y_queda_con_circulo_rojo(page):
    preparar(page)
    _cliente(page)
    slug = abrir_mapa(page)
    antes = page.evaluate("Object.keys(MAPA_MARCAS).length")
    abrir_cartelito(page, slug)
    assert page.locator(".leaflet-popup .pin-menos").count() == 1, "con la búsqueda guardada falta el botón −"
    page.locator(".leaflet-popup .pin-menos").click()
    assert page.evaluate("valDe(busquedaActiva(), %s)" % json.dumps(slug)) == "descarte_1", "el − tiene que descartar (🔴 No me gustó)"
    assert page.evaluate("Object.keys(MAPA_MARCAS).length") == antes - 1 and page.evaluate("%s in MAPA_MARCAS" % json.dumps(slug)) is False, "el pin descartado tiene que salir del mapa"
    page.wait_for_function("document.querySelectorAll('.leaflet-popup').length === 0", timeout=3000)   # Leaflet lo desvanece ~200 ms
    assert f"({antes - 1})" in page.evaluate("document.getElementById('mapa-titulo').textContent"), "el contador del mapa no bajó"
    cerrar_mapa(page)
    r = page.evaluate("""(s) => { var o = CARDS.filter(function (x) { return x.slug === s; })[0];
        return o ? { rojo: o.card.querySelector('.val-btn').textContent, clase: o.card.classList.contains('val-descarte_1') } : null; }""", slug)
    assert r and r["rojo"] == "🔴" and r["clase"], f"en la lista tiene que seguir, con el círculo rojo: {r}"


def caso_sin_busqueda_guardada_no_hay_menos(page):
    preparar(page)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    assert page.locator(".leaflet-popup .pin-menos").count() == 0, "sin búsqueda guardada no hay a quién descartar: no debe haber −"


def caso_el_menos_saca_la_propiedad_de_lo_elegido_en_una_campana(page):
    preparar(page)
    _cliente(page, campana=True)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    page.locator(".leaflet-popup .pin-mas").click()
    assert elegidas(page) == [slug]
    page.locator(".leaflet-popup .pin-menos").click()
    assert elegidas(page) == [], "una propiedad descartada no puede seguir elegida para enviar"
    cerrar_mapa(page)
    assert page.evaluate("document.getElementById('multibar').style.display") == "none", "no debería quedar nada para enviar"


def caso_el_menos_saca_la_estrella_de_para_enviar(page):
    preparar(page)
    _cliente(page)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    page.locator(".leaflet-popup .pin-mas").click()
    assert page.evaluate("valDe(busquedaActiva(), %s)" % json.dumps(slug)) == "a_enviar"
    page.locator(".leaflet-popup .pin-menos").click()
    assert page.evaluate("valDe(busquedaActiva(), %s)" % json.dumps(slug)) == "descarte_1"
    cerrar_mapa(page)
    assert elegidas(page) == [], f"lo descartado no puede quedar en 'Para enviar': {elegidas(page)}"


# ----------------------------- vista previa -----------------------------
def caso_vista_previa_muestra_5_fotos_y_caracteristicas_sin_salir_del_mapa(page):
    preparar(page)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    page.locator(".leaflet-popup .pin-prev").click()
    page.wait_for_function("document.querySelectorAll('#vp-fotos img').length === 5", timeout=5000)
    txt = page.evaluate("document.getElementById('vista-previa').textContent")
    for esperado in ("Baños", "Año", "Gastos comunes", "Calle Falsa 1234", "Parrillero", "Hermoso apartamento"):
        assert esperado in txt, f"la vista previa no muestra '{esperado}': {txt[:300]}"
    assert "<p>" not in txt, "la descripción tiene que salir sin etiquetas HTML"
    assert page.evaluate("getComputedStyle(document.getElementById('mapa-overlay')).display") != "none", "el mapa se cerró"
    assert page.locator("#vp-ver").inner_text().strip() == "Ver aviso completo"
    page.locator("#btn-vp-mas").click()
    assert elegidas(page) == [slug], "el + de la vista previa tiene que elegir la propiedad"
    page.evaluate("document.getElementById('btn-vp-x').click()")
    assert page.evaluate("getComputedStyle(document.getElementById('vista-previa')).display") == "none"
    assert page.evaluate("getComputedStyle(document.getElementById('mapa-overlay')).display") != "none", "al cerrar la vista previa se vuelve al mapa"
    assert page.locator(".leaflet-popup .pin-mas").inner_text().strip() == "✓", "el cartelito tiene que reflejar lo elegido en la vista previa"


def caso_vista_previa_sin_conexion_muestra_lo_que_hay(page):
    preparar(page, ficha=False)
    slug = abrir_mapa(page)
    abrir_cartelito(page, slug)
    page.locator(".leaflet-popup .pin-prev").click()
    page.wait_for_function("document.getElementById('vista-previa').textContent.indexOf('No pude traer') >= 0", timeout=8000)
    assert page.evaluate("document.querySelectorAll('#vp-fotos img').length") <= 1, "sin la ficha solo se conoce 1 foto"
    assert page.evaluate("getComputedStyle(document.getElementById('vista-previa')).display") != "none"


# ----------------------------- la selección no se pierde -----------------------------
def caso_la_seleccion_sobrevive_a_volver_a_buscar(page):
    preparar(page)
    elegidas_antes = page.evaluate("""() => { var a = CARDS.slice(0, 3); a.forEach(function (o) { var c = o.card.querySelector('.card-check'); c.checked = true; c.onchange(); });
        return SEL.map(function (c) { return c.slug; }); }""")
    page.evaluate("buscar()")
    assert elegidas(page) == elegidas_antes, f"volver a buscar borró lo elegido: {elegidas(page)} vs {elegidas_antes}"
    marcadas = page.evaluate("CARDS.filter(function (o) { return o.card.querySelector('.card-check').checked; }).length")
    assert marcadas == 3, f"las casillas no quedaron tildadas: {marcadas}"


def caso_la_seleccion_sobrevive_a_recargar_la_app(page):
    preparar(page)
    antes = page.evaluate("""() => { CARDS.slice(0, 2).forEach(function (o) { var c = o.card.querySelector('.card-check'); c.checked = true; c.onchange(); });
        return SEL.map(function (c) { return c.slug; }); }""")
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0 && RENDER_RES.length > 0", timeout=20000)
    assert elegidas(page) == antes, f"al volver a la app se perdió lo elegido: {elegidas(page)} vs {antes}"
    assert "(2)" in cuenta_multibar(page), cuenta_multibar(page)


def caso_enviar_con_cliente_limpia_la_seleccion(page):
    """Lo que NO cambia: con un cliente abierto, después de enviar lo elegido se limpia (queda 📤 Enviada)
    para no mandarlo dos veces. (Probado con una campaña, que usa casillas.)"""
    preparar(page)
    page.evaluate("""() => { guardarBusquedaActual('Campaña prueba', '099111222', '', false);
        var arr = cargarBusquedas(); arr[0].campana = true; guardarBusquedas(arr); buscar();
        window.open = function () {}; var c = CARDS[0].card.querySelector('.card-check'); c.checked = true; c.onchange(); enviarSeleccionadas(); }""")
    assert elegidas(page) == [], f"después de enviar tiene que quedar sin elegidas: {elegidas(page)}"


def caso_el_mapa_vuelve_abierto_y_con_sus_filtros_al_recargar(page):
    preparar(page)
    page.evaluate("guardarBusquedaActual('Cliente prueba', '099111222', '', false); buscar();")
    abrir_mapa(page)
    page.evaluate("document.querySelector('.mv-chip[data-v=\"favorita\"]').click()")
    page.reload(wait_until="load")
    page.wait_for_function("window.L && window.MAPA_MARCAS", timeout=30000)
    assert page.evaluate("getComputedStyle(document.getElementById('mapa-overlay')).display") != "none", "el mapa tendría que volver abierto"
    assert page.evaluate("document.querySelector('.mv-chip[data-v=\"favorita\"]').getAttribute('aria-pressed')") == "true", "el filtro del mapa se perdió"


# ----------------------------- orden -----------------------------
def caso_en_empate_gana_la_mas_cercana_en_m2(page):
    """Tres propiedades iguales en todo menos en m²: arriba la que tiene los m² más cerca de lo buscado."""
    orden = page.evaluate("""() => {
        var base = { operacion: 'sale', tipo: 'departamento_estandar', barrio: 'Pocitos', depto: 'Montevideo', precio: 100000, moneda: 'USD',
                     precio_usd: 100000, dorm: 2, banos: 1, cochera: true, estado: 'usada', estado_pub: 'active', visto_desde: '2026-01-01', lat: -34.9, lng: -56.1 };
        var mk = function (slug, m2) { var c = Object.assign({}, base, { slug: slug, m2_homog: m2 }); c._barrioN = 'pocitos'; c._deptoN = 'montevideo'; c._tipoCat = 'apto'; return c; };
        var viejo = DATA; DATA = [mk('lejos', 120), mk('justa', 62), mk('cerca', 70), mk('muy-lejos', 30)];
        limpiarTodo(); setSeg('f-oper', 'sale'); setStep('f-dmin', 2); setStep('f-dmax', 2); $('f-precio-max').value = '115.000';
        $('f-cub-min').value = '55'; $('f-cub-max').value = '125';   // centro del rango = 90
        window.__base = { operacion: 'sale', tipo: 'departamento_estandar', precio_usd: 100000, dorm: 2, m2_homog: 65, barrio: 'Pocitos', depto: 'Montevideo', cochera: true, estado: 'usada' };
        var r = filtrar(leerFiltros(), refDeBusqueda(), null).map(function (c) { return c.slug; });
        DATA = viejo; return r; }""")
    assert orden[:3] == ["justa", "cerca", "lejos"], f"en empate tiene que ganar la más cercana en m² al link (65): {orden}"


CASOS = [
    caso_el_cartelito_tiene_mas_vista_previa_y_ver_aviso_completo,
    caso_el_mas_deja_la_propiedad_elegida_al_cerrar_el_mapa, caso_el_mas_tambien_la_saca,
    caso_con_cliente_el_mas_marca_para_enviar,
    caso_con_cliente_el_menos_descarta_y_queda_con_circulo_rojo, caso_sin_busqueda_guardada_no_hay_menos,
    caso_el_menos_saca_la_propiedad_de_lo_elegido_en_una_campana, caso_el_menos_saca_la_estrella_de_para_enviar,
    caso_vista_previa_muestra_5_fotos_y_caracteristicas_sin_salir_del_mapa,
    caso_vista_previa_sin_conexion_muestra_lo_que_hay,
    caso_la_seleccion_sobrevive_a_volver_a_buscar, caso_la_seleccion_sobrevive_a_recargar_la_app,
    caso_enviar_con_cliente_limpia_la_seleccion, caso_el_mapa_vuelve_abierto_y_con_sus_filtros_al_recargar,
    caso_en_empate_gana_la_mas_cercana_en_m2,
]


def main():
    srv = servir()
    fallos = 0
    with sync_playwright() as p:
        br = p.chromium.launch()
        for caso in CASOS:
            page = pagina_nueva(br)   # página limpia por caso (el mapa y la selección tienen estado)
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
