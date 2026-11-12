"""Prueba de la ventanita de NOVEDADES (2026-11-11): vincular celu y compu + vista de escritorio. Súper breve,
con los botones donde está el cambio en DORADO (clase .nuevo) hasta que se usan. La ventanita anterior
(temporarios + mapa) se borró: quien no la vio, no la ve.

Uso: python test_novedades.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

VENT = "news-mercado"   # 3ª versión: + análisis de precio (2026-11-12). Antes: "news-celu-compu", "news-vincular".
VIEJA = "news-celu-compu"   # 2ª versión (título + explicación). La 1ª ("news-vincular") no quedaba clara.
VISIBLE = f"(function () {{ var e = document.getElementById('{VENT}'); return !!e && getComputedStyle(e).display !== 'none'; }})()"


def recargar(page):
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    page.wait_for_timeout(300)


def usuario_que_ya_usaba_la_app(page):
    """Ya había visto todas las ventanitas viejas, pero no la nueva."""
    page.evaluate("""() => { ['news', 'news-agente', 'news-avisos', 'news-temporal', 'news-temporal-mapa', 'news-vincular', 'news-celu-compu', 'iniciado'].forEach(function (k) {
        localStorage.setItem('parecidas_nv_' + k, '1'); });
        ['%s', 'vincular-nv', 'sync-nv', 'vista-btn', 'traer-btn'].forEach(function (k) { localStorage.removeItem('parecidas_nv_' + k); }); }""" % VENT)
    recargar(page)


def caso_la_ve_quien_ya_usaba_la_app(br):
    page = pagina_nueva(br)
    usuario_que_ya_usaba_la_app(page)
    assert page.evaluate(VISIBLE), "quien ya usaba la app tiene que ver la ventanita nueva"
    txt = page.evaluate(f"document.getElementById('{VENT}').textContent")
    assert "inculá" in txt or "incular" in txt, f"tiene que explicar vincular: {txt}"
    assert "ompu" in txt and "elu" in txt, f"habla de compu y celu: {txt}"
    assert "ecarg" in txt, f"avisa que en el otro aparato hay que recargar para ver los cambios: {txt}"
    assert "scritorio" in txt, f"explica la vista de escritorio: {txt}"
    assert "otro aparato" in txt and "código" in txt, f"explica que el código se escribe en el otro aparato: {txt}"
    assert "uardá el código" in txt and "respaldo" in txt, f"explica que hay que guardar el código como respaldo: {txt}"
    assert len(txt) < 1150, f"tiene que ser breve ({len(txt)} caracteres)"
    titulos = page.evaluate(f"Array.prototype.map.call(document.querySelectorAll('#{VENT} .news-item .news-tit'), function (t) {{ return t.textContent; }})")
    assert len(titulos) == 3, f"tres novedades, cada una con su TÍTULO descriptivo: {titulos}"
    assert "precio" in titulos[2] and "alquila" in titulos[2], f"el título 3 dice de qué se trata: {titulos[2]}"
    assert "barrio" in txt and "último año" in txt, "explica de dónde salen los datos del análisis"
    assert "elu" in titulos[0] and "ompu" in titulos[0], f"el título 1 dice de qué se trata (celu y compu): {titulos[0]}"
    assert "ompu" in titulos[1] or "PC" in titulos[1], f"el título 2 dice que es para la compu: {titulos[1]}"
    assert page.evaluate(f"document.querySelectorAll('#{VENT} .news-item p').length") == 3, "y abajo de cada título, su explicación"
    page.evaluate("document.getElementById('btn-news-vincular-ok').click()")
    assert not page.evaluate(VISIBLE), "'Entendido' la cierra"
    recargar(page)
    assert not page.evaluate(VISIBLE), "una vez vista no vuelve"
    page.context.close()


def caso_la_vieja_no_existe_mas(br):
    page = pagina_nueva(br)
    assert page.evaluate("document.getElementById('news-escritorio') === null"), "la ventanita vieja (temporarios + mapa) se borró"
    assert page.evaluate("document.getElementById('news-vincular') === null"), "la 1ª versión (sin títulos) se reemplazó"
    assert page.evaluate("document.getElementById('%s') === null" % VIEJA), "la 2ª versión se reemplazó por la de 3 novedades"
    page.context.close()


def caso_no_sale_a_quien_abre_la_app_por_primera_vez(br):
    page = pagina_nueva(br)
    page.wait_for_timeout(300)
    assert not page.evaluate(VISIBLE), "la primera vez que alguien abre la app no se le muestran novedades"
    page.context.close()


def caso_ajustes_en_dorado_hasta_abrirlo(br):
    page = pagina_nueva(br)
    usuario_que_ya_usaba_la_app(page)
    page.evaluate("document.getElementById('btn-news-vincular-ok').click()")
    dorado = "document.getElementById('btn-ajustes').classList.contains('nuevo')"
    assert page.evaluate(dorado), "⚙️ Ajustes en dorado (ahí está lo de vincular)"
    page.evaluate("$('btn-ajustes').click()")
    assert not page.evaluate(dorado), "al abrir Ajustes sale del dorado"
    assert page.evaluate("$('btn-sync-crear').classList.contains('nuevo')"), "adentro, 'Crear mi código' en dorado"
    assert page.evaluate("$('aj-sync-tit').classList.contains('nuevo')"), "adentro, el TÍTULO 'Los mismos datos en la compu y en el celu' también en dorado"
    page.context.route("https://parecidas-motor.cualcaxsiempre.workers.dev/**", lambda r: r.abort())   # NO tocar el servidor real
    page.evaluate("$('btn-sync-crear').click()")
    page.wait_for_function("SYNC.estado().vinculado", timeout=10000)
    page.wait_for_function("!document.getElementById('aj-sync-tit').classList.contains('nuevo')", timeout=5000)   # ya lo usó: vuelve a lo normal
    page.reload(wait_until="load"); page.wait_for_function("DATA.length > 0", timeout=20000)
    page.evaluate("$('btn-ajustes').click()")
    assert not page.evaluate("$('aj-sync-tit').classList.contains('nuevo')"), "y no vuelve al dorado al recargar"
    page.context.close()


def caso_vence_en_unas_semanas(br):
    """Juan 2026-11-11: la ventanita vale solo por las próximas semanas (hasta el 9/12/2026). Después no sale más."""
    page = pagina_nueva(br)
    assert page.evaluate("novedadVigente('news-mercado', new Date('2026-11-20T12:00:00'))") is True, "en noviembre se muestra"
    assert page.evaluate("novedadVigente('news-mercado', new Date('2026-12-10T23:00:00'))") is True, "el 10/12 todavía"
    assert page.evaluate("novedadVigente('news-mercado', new Date('2026-12-11T08:00:00'))") is False, "desde el 11/12 ya no"
    assert page.evaluate("novedadVigente('news-avisos', new Date('2030-01-01'))") is True, "las que no tienen vencimiento siguen igual"
    page.context.close()


def caso_traer_en_dorado_hasta_el_primer_uso(br):
    page = pagina_nueva(br)
    usuario_que_ya_usaba_la_app(page)
    page.evaluate("document.getElementById('btn-news-vincular-ok').click()")
    dorado = "document.getElementById('btn-traer').classList.contains('nuevo')"
    assert page.evaluate(dorado), "'Traer' en dorado (ahí está lo del análisis de precio)"
    page.evaluate("$('btn-traer').click()")
    assert not page.evaluate(dorado), "al usarlo sale del dorado"
    recargar(page)
    assert not page.evaluate(dorado), "y no vuelve"
    page.context.close()


CASOS = [caso_traer_en_dorado_hasta_el_primer_uso, caso_vence_en_unas_semanas, caso_la_ve_quien_ya_usaba_la_app, caso_la_vieja_no_existe_mas, caso_no_sale_a_quien_abre_la_app_por_primera_vez,
         caso_ajustes_en_dorado_hasta_abrirlo]


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
