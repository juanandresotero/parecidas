"""Prueba de "📍 Copiar ubicación" (búsquedas guardadas): además del link del mapa, arriba va la DIRECCIÓN.
RE/MAX muestra la dirección redondeada (los 2 últimos números en 00): eso es "Sobre calle X al 1500". Si los 2
últimos no son 00, alguien puso la dirección exacta → "Dirección: Lecocq 1545".

Pedido de Juan 2026-11-11. Uso: python test_ubicacion.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

CASOS_TEXTO = [
    ("Lecocq 1500", "📍 Sobre calle Lecocq al 1500"),
    ("Lecocq 1545", "📍 Dirección: Lecocq 1545"),
    ("lecocq 1545", "📍 Dirección: lecocq 1545"),
    ("Avenida Brasil 2800", "📍 Sobre Avenida Brasil al 2800"),
    ("Av. Carlos Racine 3100", "📍 Sobre Av. Carlos Racine al 3100"),
    ("Rambla Doctor Claudio Williman 0", "📍 Sobre Rambla Doctor Claudio Williman"),
    ("Laguna de los Cisnes 0", "📍 Sobre calle Laguna de los Cisnes"),
    ("21 de Setiembre 2800", "📍 Sobre calle 21 de Setiembre al 2800"),
    ("Avenida 18 de Julio 1845", "📍 Dirección: Avenida 18 de Julio 1845"),
    ("Ruta 81 Km 110 S/N", "📍 Ruta 81 Km 110 S/N"),
    ("Haedo Entre Dr. Martínez y Dr. Requena 2100", "📍 Sobre calle Haedo Entre Dr. Martínez y Dr. Requena al 2100"),
    ("  Lecocq   1545  ", "📍 Dirección: Lecocq 1545"),
    ("", ""),
]


def caso_arma_el_renglon_de_la_direccion(page):
    for dir_, esperado in CASOS_TEXTO:
        r = page.evaluate("(d) => lineaDireccion(d)", dir_)
        assert r == esperado, f"{dir_!r} → {r!r} (esperado {esperado!r})"


def copiado_al_tocar_el_pin(page, cliente):
    """Guarda un cliente de verdad (con la app), le pone dirección/ubicación, toca su 📍 en 'Búsquedas guardadas'
    y devuelve lo que quedó copiado."""
    page.evaluate("""(x) => { window.__copiado = null;
        navigator.clipboard.writeText = function (t) { window.__copiado = t; return Promise.resolve(); };
        limpiarTodo(); setSeg('f-oper', 'sale'); buscar();
        guardarBusquedaActual('Ana', '099111222', x.direccion, false);
        var arr = cargarBusquedas(); arr[0].lat = x.lat; arr[0].lng = x.lng; arr[0].slugActual = x.slugActual || null;
        guardarBusquedas(arr); renderBusquedas(); }""", cliente)
    page.evaluate("document.querySelector('#busq-lista .bi-edit[aria-label=\"Copiar ubicación\"]').click()")
    page.wait_for_function("window.__copiado !== null", timeout=5000)
    return page.evaluate("window.__copiado")


CLIENTE = {"lat": -34.9, "lng": -56.15}


def caso_copia_la_direccion_exacta_y_el_link(page):
    t = copiado_al_tocar_el_pin(page, dict(CLIENTE, direccion="Lecocq 1545"))
    renglones = t.split("\n")
    assert renglones[0] == "📍 Dirección: Lecocq 1545", f"arriba va la dirección exacta: {t!r}"
    assert renglones[1] == "https://www.google.com/maps?q=-34.9,-56.15", f"abajo el link del mapa: {t!r}"


def caso_copia_la_direccion_redondeada(page):
    t = copiado_al_tocar_el_pin(page, dict(CLIENTE, direccion="Lecocq 1500"))
    assert t.split("\n")[0] == "📍 Sobre calle Lecocq al 1500", f"dirección del sistema (00): {t!r}"


def caso_sin_direccion_guardada_usa_la_de_la_propiedad(page):
    slug, dir_ = page.evaluate("(function () { var c = DATA.filter(function (x) { return x.lat != null && /[1-9]00$/.test(x.direccion || ''); })[0]; return [c.slug, c.direccion]; })()")
    t = copiado_al_tocar_el_pin(page, dict(direccion="", slugActual=slug, lat=None, lng=None))
    assert t.split("\n")[0].startswith("📍 Sobre ") and t.split("\n")[0].endswith(dir_.split()[-1]), f"usa la dirección de la propiedad ({dir_}): {t!r}"
    assert "google.com/maps" in t.split("\n")[1]


def caso_sin_ninguna_direccion_copia_solo_el_link(page):
    t = copiado_al_tocar_el_pin(page, dict(CLIENTE, direccion=""))
    assert t == "https://www.google.com/maps?q=-34.9,-56.15", f"sin dirección, solo el link (como antes): {t!r}"


CASOS = [caso_arma_el_renglon_de_la_direccion, caso_copia_la_direccion_exacta_y_el_link, caso_copia_la_direccion_redondeada,
         caso_sin_direccion_guardada_usa_la_de_la_propiedad, caso_sin_ninguna_direccion_copia_solo_el_link]


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
