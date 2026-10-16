"""Prueba del filtro "m² totales / padrón": un APARTAMENTO no tiene terreno, así que se compara con su
superficie total (66,8 m² no cumple "mínimo 1.000"). Las casas/terrenos sin dato de padrón siguen
apareciendo (el dato falta, no se las excluye). Misma regla en la app y en el robot de avisos.

Pedido de Juan 2026-10-16 (el apto de Pando de 66,8 m² aparecía con padrón mínimo 1.000).

Uso: python test_padron.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva, CARPETA

BASE = "{ operacion: 'sale', tipos: [], grupo: null, dmin: null, dmax: null, bmin: null, bmax: null, " \
       "precioMinUsd: null, precioMaxUsd: null, cubMin: null, cubMax: null, padronMin: null, padronMax: null, " \
       "cochera: '', estado: '', rentaSel: [], gastosMinUsd: null, gastosMaxUsd: null }"

APTO = "{ slug: 'x', estado_pub: 'active', operacion: 'sale', tipo: 'departamento_estandar', m2_homog: 64, m2_padron: 0 }"
CASA = "{ slug: 'y', estado_pub: 'active', operacion: 'sale', tipo: 'casa', m2_homog: 120, m2_padron: 0 }"


def caso_apto_no_cumple_padron_minimo(page):
    r = page.evaluate("""() => { var b = %s, apto = %s; // el robot todavía no trae m2_total: se usa m2_homog
        return [pasa(apto, Object.assign({}, b, { padronMin: 1000 }), null), pasa(apto, Object.assign({}, b, { padronMin: 50 }), null),
                pasa(apto, Object.assign({}, b, { padronMax: 30 }), null)]; }""" % (BASE, APTO))
    assert r == [False, True, False], f"apto de 64 m²: mín 1000 → no, mín 50 → sí, máx 30 → no. Dio {r}"


def caso_usa_m2_total_si_viene(page):
    r = page.evaluate("""() => { var b = %s, apto = %s; apto.m2_total = 66.8;
        return [pasa(apto, Object.assign({}, b, { padronMin: 66 }), null), pasa(apto, Object.assign({}, b, { padronMin: 67 }), null)]; }""" % (BASE, APTO))
    assert r == [True, False], f"con m2_total 66,8 manda ese dato: mín 66 → sí, mín 67 → no. Dio {r}"


def caso_casa_sin_padron_sigue_apareciendo(page):
    r = page.evaluate("""() => { var b = %s, casa = %s;
        return pasa(casa, Object.assign({}, b, { padronMin: 1000 }), null); }""" % (BASE, CASA))
    assert r is True, "casa con padrón desconocido NO se excluye (el dato falta, no es que sea chica)"


def caso_el_apto_de_pando_real(page):
    page.evaluate("""() => { limpiarTodo(); setSeg('f-oper', 'sale'); SELBARRIOS = ['Barros Blancos']; renderChips();
        $('f-padron-min').value = '1000'; buscar(); }""")
    esta = page.evaluate("RENDER_RES.some(function (c) { return c.slug === 'venta-apartamento-tres-dormitorios-centro-de-pando'; })")
    assert not esta, "el apto de Pando (66,8 m²) no puede aparecer con padrón mínimo 1.000"
    solo_aptos_chicos = page.evaluate("RENDER_RES.filter(function (c) { return tipoCat(c.tipo) === 'apto'; }).length")
    assert solo_aptos_chicos == 0, f"ningún apartamento cumple 1.000 m²: aparecieron {solo_aptos_chicos}"


JS_WORKER = r"""
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
const ini = src.indexOf('function norm(s)'), fin = src.indexOf('// ---- Push: helpers ----');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(ini, fin), ctx);
const base = %s; const apto = %s; const casa = %s;
const pasa = (c, f) => ctx.pasa(c, Object.assign({}, base, f), null);
console.log(JSON.stringify({ aptoMin: pasa(apto, { padronMin: 1000 }), aptoOk: pasa(apto, { padronMin: 50 }), casa: pasa(casa, { padronMin: 1000 }) }));
""" % (BASE, APTO, CASA)


def caso_worker(page):
    out = subprocess.run(["node", "-e", JS_WORKER, os.path.join(CARPETA, "worker", "motor.js")],
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, f"no pude cargar el filtro del worker: {out.stderr[:300]}"
    r = json.loads(out.stdout)
    assert r == {"aptoMin": False, "aptoOk": True, "casa": True}, f"worker: misma regla que la app. Dio {r}"


CASOS = [caso_apto_no_cumple_padron_minimo, caso_usa_m2_total_si_viene, caso_casa_sin_padron_sigue_apareciendo,
         caso_el_apto_de_pando_real, caso_worker]


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
