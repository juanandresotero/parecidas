"""Prueba de "el formulario manda": después de pegar un link, la app busca con lo que dicen los FILTROS
(que se pueden modificar), no con características escondidas del link. "Traer" resetea todos los filtros.

Pedido de Juan 2026-10-07. Lo único del link que sigue valiendo es: la propiedad del link no se ofrece
como parecida de sí misma, y el ORDEN de las parecidas sale de la propiedad del link (no cambia qué se muestra).

Uso (necesita Playwright, que está en el .venv del proyecto Meta):
    python test_link.py
"""
from __future__ import annotations

import collections
import json
import os
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

CARPETA = os.path.dirname(os.path.abspath(__file__))
LISTINGS = json.load(open(os.path.join(CARPETA, "listings.json"), encoding="utf-8"))["listings"]


def activas(**campos):
    return [x for x in LISTINGS if x.get("estado_pub") in (None, "active")
            and all(x.get(k) == v for k, v in campos.items())]


JS_FILTROS_VIEJOS = """() => {
    limpiarTodo();
    $('f-gastos-min').value = '5.000'; $('f-gastos-max').value = '9.000';
    $('f-padron-min').value = '100'; $('f-padron-max').value = '200';
    $('f-cub-min').value = '10'; $('f-cub-max').value = '20'; $('f-precio-min').value = '1.000';
    setSegMulti('f-tipo', ['casa']); SELBARRIOS = ['Cerro', 'Pando']; renderChips();
    setStep('f-bmin', 3); setStep('f-bmax', 3); setStep('f-dmin', 5); setStep('f-dmax', 5);
    setSeg('f-coch', 'no'); setSeg('f-estado', 'usada'); setSegMulti('f-renta', ['con', 'multi', 'sin']);
}"""

JS_LEER = """() => { var f = leerFiltros(); return {
    gastosTexto: [$('f-gastos-min').value, $('f-gastos-max').value], gastos: [f.gastosMinUsd, f.gastosMaxUsd],
    padron: [f.padronMin, f.padronMax], banos: [f.bmin, f.bmax], dorm: [f.dmin, f.dmax],
    tipos: f.tipos, barrios: SELBARRIOS.slice(), coch: f.cochera, estado: f.estado, renta: f.rentaSel,
    precioMin: f.precioMinUsd, cub: [f.cubMin, f.cubMax] }; }"""


def caso_traer_de_remax_pisa_todos_los_filtros(page):
    apto = next(x for x in activas(operacion="sale") if x["tipo"].startswith("departamento") and x.get("banos") and x.get("dorm"))
    page.evaluate(JS_FILTROS_VIEJOS)
    r = page.evaluate("(s) => { rellenar(BY_SLUG[s]); return (" + JS_LEER + ")(); }", apto["slug"])
    assert r["gastosTexto"] == ["", ""] and r["gastos"] == [None, None], f"Traer dejó los gastos comunes viejos: {r['gastosTexto']}"
    assert r["padron"] == [None, None], f"padrón viejo: {r['padron']}"
    assert r["banos"] == [apto["banos"]] * 2 and r["dorm"] == [apto["dorm"]] * 2, f"baños/dorm: {r['banos']} {r['dorm']}"
    assert r["tipos"] == ["apto"] and r["precioMin"] is None, f"tipo/precio mín: {r['tipos']} {r['precioMin']}"
    assert r["barrios"] == [apto["barrio"]], f"barrios: {r['barrios']}"


def caso_traer_de_otro_portal_pisa_todos_los_filtros(page):
    """InfoCasas/MercadoLibre no trae baños ni gastos: tienen que quedar vacíos, no con lo de la búsqueda anterior."""
    page.evaluate(JS_FILTROS_VIEJOS)
    r = page.evaluate("() => { rellenarExterno({ operacion: 'sale', moneda: 'USD', tipo: 'Apartamento', precio: 100000, m2_construidos: 60, dorm: 2 }); return (" + JS_LEER + ")(); }")
    assert r["gastosTexto"] == ["", ""], f"Traer (otro portal) dejó los gastos viejos: {r['gastosTexto']}"
    assert r["banos"] == [None, None], f"Traer (otro portal) dejó los baños viejos: {r['banos']}"
    assert r["padron"] == [None, None] and r["dorm"] == [2, 2] and r["tipos"] == ["apto"], f"{r}"


def caso_barrio_elegido_a_mano_no_lo_frena_el_link(page):
    """Link de Montevideo + elijo a mano un barrio de Maldonado y saco los demás filtros: tiene que traer
    ese barrio (el formulario manda; no hay una 'región' escondida del link)."""
    mvd = next(x for x in activas(operacion="sale", depto="Montevideo") if x.get("dorm"))
    barrio = collections.Counter(x["barrio"] for x in activas(operacion="sale", depto="Maldonado")
                                 if x["barrio"]).most_common(1)[0][0]
    esperado = {x["slug"] for x in activas(operacion="sale", depto="Maldonado") if x["barrio"] == barrio}
    obtenido = set(page.evaluate("""(a) => { limpiarTodo(); rellenar(BY_SLUG[a.slug]);
        vaciarFiltros();   // el usuario deja todos los filtros en "da igual" (el link sigue cargado)
        setSeg('f-oper', 'sale'); SELBARRIOS = [a.barrio]; renderChips();
        var f = leerFiltros();
        return DATA.filter(function (c) { return pasa(c, f, window.__slugActual); }).map(function (c) { return c.slug; }); }""",
                                  {"slug": mvd["slug"], "barrio": barrio}))
    # un barrio suelto trae también su grupo (linderos); lo que importa: NO falta ninguno del barrio elegido
    assert esperado and esperado <= obtenido, f"'{barrio}' (Maldonado) quedó bloqueado por el link de Montevideo: {len(esperado & obtenido)} de {len(esperado)}"


def caso_la_propiedad_del_link_no_se_ofrece_a_si_misma(page):
    """Lo que SÍ sigue valiendo del link: la propiedad pegada no aparece entre sus propias parecidas."""
    c = next(x for x in activas(operacion="sale", depto="Montevideo") if x.get("dorm") and x.get("precio_usd"))
    r = page.evaluate("""(s) => { limpiarTodo(); rellenar(BY_SLUG[s]); buscar();
        return { en: RENDER_RES.some(function (x) { return x.slug === s; }), n: RENDER_RES.length }; }""", c["slug"])
    assert r["n"] > 0 and not r["en"], f"la propiedad del link aparece entre sus propias parecidas: {r}"


CASOS = [caso_traer_de_remax_pisa_todos_los_filtros, caso_traer_de_otro_portal_pisa_todos_los_filtros,
         caso_barrio_elegido_a_mano_no_lo_frena_el_link, caso_la_propiedad_del_link_no_se_ofrece_a_si_misma]


def main():
    srv = servir()
    fallos = 0
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = pagina_nueva(br)
        for caso in CASOS:
            try:
                caso(page)
                print("OK   ", caso.__name__)
            except AssertionError as e:
                fallos += 1
                print("FALLA", caso.__name__, "->", e)
            except Exception as e:
                fallos += 1
                print("ERROR", caso.__name__, "->", str(e).splitlines()[0][:200])
        br.close()
    srv.shutdown()
    print("\n%d de %d casos OK" % (len(CASOS) - fallos, len(CASOS)))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
