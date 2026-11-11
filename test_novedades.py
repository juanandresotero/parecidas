"""Prueba de la ventanita de NOVEDADES (2026-11-11): vincular celu y compu + vista de escritorio. Súper breve,
con los botones donde está el cambio en DORADO (clase .nuevo) hasta que se usan. La ventanita anterior
(temporarios + mapa) se borró: quien no la vio, no la ve.

Uso: python test_novedades.py
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

VENT = "news-celu-compu"   # 2ª versión (título + explicación). La 1ª ("news-vincular") no quedaba clara.
VISIBLE = f"(function () {{ var e = document.getElementById('{VENT}'); return !!e && getComputedStyle(e).display !== 'none'; }})()"


def recargar(page):
    page.reload(wait_until="load")
    page.wait_for_function("DATA.length > 0", timeout=20000)
    page.wait_for_timeout(300)


def usuario_que_ya_usaba_la_app(page):
    """Ya había visto todas las ventanitas viejas, pero no la nueva."""
    page.evaluate("""() => { ['news', 'news-agente', 'news-avisos', 'news-temporal', 'news-temporal-mapa', 'news-vincular', 'iniciado'].forEach(function (k) {
        localStorage.setItem('parecidas_nv_' + k, '1'); });
        ['%s', 'vincular-nv', 'sync-nv', 'vista-btn'].forEach(function (k) { localStorage.removeItem('parecidas_nv_' + k); }); }""" % VENT)
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
    assert len(txt) < 650, f"tiene que ser breve ({len(txt)} caracteres)"
    titulos = page.evaluate(f"Array.prototype.map.call(document.querySelectorAll('#{VENT} .news-item .news-tit'), function (t) {{ return t.textContent; }})")
    assert len(titulos) == 2, f"dos novedades, cada una con su TÍTULO descriptivo: {titulos}"
    assert "elu" in titulos[0] and "ompu" in titulos[0], f"el título 1 dice de qué se trata (celu y compu): {titulos[0]}"
    assert "ompu" in titulos[1] or "PC" in titulos[1], f"el título 2 dice que es para la compu: {titulos[1]}"
    assert page.evaluate(f"document.querySelectorAll('#{VENT} .news-item p').length") == 2, "y abajo de cada título, su explicación"
    page.evaluate("document.getElementById('btn-news-vincular-ok').click()")
    assert not page.evaluate(VISIBLE), "'Entendido' la cierra"
    recargar(page)
    assert not page.evaluate(VISIBLE), "una vez vista no vuelve"
    page.context.close()


def caso_la_vieja_no_existe_mas(br):
    page = pagina_nueva(br)
    assert page.evaluate("document.getElementById('news-escritorio') === null"), "la ventanita vieja (temporarios + mapa) se borró"
    assert page.evaluate("document.getElementById('news-vincular') === null"), "la 1ª versión (sin títulos) se reemplazó"
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
    page.context.close()


CASOS = [caso_la_ve_quien_ya_usaba_la_app, caso_la_vieja_no_existe_mas, caso_no_sale_a_quien_abre_la_app_por_primera_vez,
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
