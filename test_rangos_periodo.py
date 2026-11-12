"""Prueba de lo que salió de la auditoría del 2026-11-11 (lado de la app):
- EMPRENDIMIENTOS con rangos: si ofrece de 1 a 3 dormitorios, una búsqueda de 3 lo encuentra (y de precio "desde/hasta").
- TEMPORARIOS: el precio es por un PERÍODO (día/semana/quincena/mes); se elige el período y solo se comparan iguales.
- m² construidos que FALTAN: la propiedad aparece igual, con "Falta dato".
Misma regla en el robot de avisos (worker).

Uso: python test_rangos_periodo.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva, CARPETA
from test_padron import BASE

EMP = ("{ slug: 'emp', estado_pub: 'active', operacion: 'sale', tipo: 'departamento_estandar', dorm: 1, dorm_max: 3, banos: 1, banos_max: 2, "
       "precio: 200000, moneda: 'USD', precio_usd: 200000, precio_max_usd: 400000, m2_homog: 60, m2_homog_max: 120, barrio: 'La Barra', depto: 'Maldonado' }")
TEMP = ("{ slug: 'tmp', estado_pub: 'active', operacion: 'temporal', tipo: 'casa', dorm: 2, banos: 1, precio: 4400, moneda: 'USD', "
        "precio_usd: 4400, periodo: 'fortnightly', m2_homog: 80, barrio: 'Pinares', depto: 'Maldonado' }")


def f(extra):
    return "Object.assign({}, %s, %s)" % (BASE, extra)


def pasa(page, prop, extra):
    return page.evaluate("() => { var c = %s; return pasa(c, %s, null); }" % (prop, f(extra)))


def caso_emprendimiento_por_rango_de_dormitorios(page):
    assert pasa(page, EMP, "{ dmin: 3 }") is True, "ofrece de 1 a 3 dorm: una búsqueda de 3+ lo encuentra"
    assert pasa(page, EMP, "{ dmin: 4 }") is False, "no ofrece 4"
    assert pasa(page, EMP, "{ dmax: 1 }") is True, "tiene unidades de 1 dorm"
    assert pasa(page, EMP, "{ dmin: 2, dmax: 2 }") is True, "tiene de 2"
    assert pasa(page, EMP, "{ bmin: 2 }") is True and pasa(page, EMP, "{ bmin: 3 }") is False, "baños por rango"


def caso_emprendimiento_por_rango_de_precio_y_m2(page):
    assert pasa(page, EMP, "{ precioMaxUsd: 250000 }") is True, "desde USD 200 mil entra en 'hasta 250 mil'"
    assert pasa(page, EMP, "{ precioMinUsd: 300000 }") is True, "hasta USD 400 mil entra en 'desde 300 mil'"
    assert pasa(page, EMP, "{ precioMinUsd: 450000 }") is False and pasa(page, EMP, "{ precioMaxUsd: 150000 }") is False
    assert pasa(page, EMP, "{ cubMin: 100 }") is True and pasa(page, EMP, "{ cubMin: 130 }") is False, "m² por rango"


def caso_tarjeta_del_emprendimiento(page):
    t = page.evaluate("() => resumenCard(%s)" % EMP)
    assert "1 a 3 dorm" in t and "desde U$S 200 k" in t, f"la tarjeta muestra el rango: {t}"


def caso_m2_que_falta_aparece_con_cartel(page):
    casa = "{ slug: 'c', estado_pub: 'active', operacion: 'sale', tipo: 'casa', dorm: 3, banos: 2, precio_usd: 150000, m2_homog: null }"
    assert pasa(page, casa, "{ cubMin: 80 }") is True, "sin dato de m² construidos: aparece igual"
    r = page.evaluate("() => faltantes(%s, %s)" % (casa, f("{ cubMin: 80 }")))
    assert r == ["m² construidos"], f"y marca que falta: {r}"
    terreno = "{ slug: 't', estado_pub: 'active', operacion: 'sale', tipo: 'terrenos_y_lotes', m2_homog: 0, precio_usd: 50000 }"
    assert pasa(page, terreno, "{ cubMin: 80 }") is False, "un terreno sí tiene 0 m² construidos (es dato, no falta)"


def caso_periodo_del_temporario(page):
    page.evaluate("() => { limpiarTodo(); document.querySelector('#f-oper button[data-v=\"temporal\"]').click(); }")
    assert page.evaluate("$('f-periodo-wrap').style.display") != "none", "con Temporario aparece '¿por qué período?'"
    assert page.evaluate("segVal('f-periodo')") == "fortnightly", "arranca en Quincena (la más común)"
    assert page.evaluate("leerFiltros().periodo") == "fortnightly"
    assert pasa(page, TEMP, "{ operacion: 'temporal', periodo: 'fortnightly' }") is True
    assert pasa(page, TEMP, "{ operacion: 'temporal', periodo: 'daily' }") is False, "por día no se mezcla con por quincena"
    assert pasa(page, TEMP, "{ operacion: 'temporal', periodo: '' }") is True, "'Todos' no filtra el período"
    sin = TEMP.replace("periodo: 'fortnightly', ", "")
    assert pasa(page, sin, "{ operacion: 'temporal', periodo: 'daily' }") is True, "período desconocido: aparece igual"
    assert page.evaluate("() => faltantes(%s, %s)" % (sin, f("{ operacion: 'temporal', periodo: 'daily' }"))) == ["período"]
    page.evaluate("() => document.querySelector('#f-oper button[data-v=\"sale\"]').click()")
    assert page.evaluate("$('f-periodo-wrap').style.display") == "none" and page.evaluate("leerFiltros().periodo") == "", "en venta no aplica"


def caso_tarjeta_dice_el_periodo(page):
    t = page.evaluate("() => resumenCard(%s)" % TEMP)
    assert "por quincena" in t, f"la tarjeta dice por qué período es el precio: {t}"


def caso_el_periodo_se_guarda_con_el_cliente(page):
    page.evaluate("""() => { limpiarTodo(); document.querySelector('#f-oper button[data-v="temporal"]').click();
        setSeg('f-periodo', 'monthly'); buscar(); guardarBusquedaActual('Ana', '099', '', false);
        var id = busquedaActiva().id; limpiarTodo(); abrirBusqueda(id); }""")
    assert page.evaluate("segVal('f-periodo')") == "monthly", "al reabrir el cliente vuelve su período"


JS_WORKER = r"""
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
const ini = src.indexOf('function norm(s)'), fin = src.indexOf('// ---- Push: helpers ----');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(ini, fin), ctx);
const base = %s, emp = %s, tmp = %s;
const p = (c, x) => ctx.pasa(c, Object.assign({}, base, x), null);
console.log(JSON.stringify({ d3: p(emp, { dmin: 3 }), d4: p(emp, { dmin: 4 }), p250: p(emp, { precioMaxUsd: 250000 }), p450: p(emp, { precioMinUsd: 450000 }),
  per: p(tmp, { operacion: 'temporal', periodo: 'fortnightly' }), perMal: p(tmp, { operacion: 'temporal', periodo: 'daily' }),
  m2null: p({ slug: 'c', estado_pub: 'active', operacion: 'sale', tipo: 'casa', m2_homog: null }, { cubMin: 80 }) }));
""" % (BASE, EMP, TEMP)


def caso_worker_misma_regla(page):
    out = subprocess.run(["node", "-e", JS_WORKER, os.path.join(CARPETA, "worker", "motor.js")], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr[:300]
    r = json.loads(out.stdout)
    assert r == {"d3": True, "d4": False, "p250": True, "p450": False, "per": True, "perMal": False, "m2null": True}, f"worker: {r}"


CASOS = [caso_emprendimiento_por_rango_de_dormitorios, caso_emprendimiento_por_rango_de_precio_y_m2, caso_tarjeta_del_emprendimiento,
         caso_m2_que_falta_aparece_con_cartel, caso_periodo_del_temporario, caso_tarjeta_dice_el_periodo,
         caso_el_periodo_se_guarda_con_el_cliente, caso_worker_misma_regla]


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
