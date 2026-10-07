"""Prueba del filtro de LUGARES (departamento entero / zona / barrio, y mezclas) con los datos reales.

Reglas que se cuidan (pedido de Juan 2026-10-07):
  - Elegir "Montevideo" (o cualquier departamento) busca en TODO ese departamento.
  - Se pueden elegir varios departamentos, y mezclar departamentos con barrios/balnearios.
  - Sin resultados dobles: lo elegido se combina con "o" (una propiedad entra una sola vez).
  - "Ciudad de la Costa" es una ZONA: busca solo en sus balnearios (sin "linderos").
  - 1 barrio suelto sigue buscando su grupo de similares; 2+ barrios siguen siendo exactos.
  - Sin ningún lugar elegido = todo el país (con los demás filtros).
  - El robotito de avisos (worker/motor.js) aplica la MISMA regla.

Uso (necesita Playwright y Node; Playwright está en el .venv del proyecto Meta):
    python test_lugares.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

from test_ocultas import servir, pagina_nueva

CARPETA = os.path.dirname(os.path.abspath(__file__))
LISTINGS = json.load(open(os.path.join(CARPETA, "listings.json"), encoding="utf-8"))["listings"]

# Balnearios que componen Ciudad de la Costa (normalizados). Fuente: Wikipedia + portales
# inmobiliarios (Carmel figura en el censo como parte de Ciudad de la Costa). Quedan AFUERA a
# propósito: Paso de Carrasco (municipio propio) y Colinas de Carrasco (barrio privado en Ruta 101).
ZONA_COSTA = {
    "ciudad de la costa", "solymar", "lagomar", "el pinar", "shangrila", "lomas de solymar",
    "san jose de carrasco", "medanos de solymar", "colinas de solymar", "barra de carrasco",
    "parque miramar", "parque carrasco", "el bosque", "parque de solymar", "montes de solymar",
    "carmel",
}


def norm(s):
    import unicodedata
    s = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower().strip()


def venta():
    return [x for x in LISTINGS if x["operacion"] == "sale" and x.get("estado_pub") in (None, "active")]


def slugs(props):
    return {x["slug"] for x in props}


def lo_que_encuentra_la_app(page, chips, base=None):
    """Elige esos lugares en la app (venta, sin otros filtros) y devuelve los slugs que pasan."""
    return set(page.evaluate("""(a) => {
        limpiarTodo();
        window.__base = a.base || null;
        SELBARRIOS = a.chips; renderChips(); pintarGrupo();
        var f = leerFiltros();
        return DATA.filter(function (c) { return pasa(c, f, null); }).map(function (c) { return c.slug; });
    }""", {"chips": chips, "base": base}))


def caso_departamento_entero(page):
    for depto in ("Montevideo", "Canelones", "Maldonado"):
        esperado = slugs(x for x in venta() if norm(x["depto"]) == norm(depto))
        obtenido = lo_que_encuentra_la_app(page, [depto])
        assert obtenido == esperado, (
            f"'{depto}' tiene que traer TODO el departamento: esperado {len(esperado)}, la app da {len(obtenido)}")


def caso_varios_departamentos(page):
    esperado = slugs(x for x in venta() if x["depto"] in ("Montevideo", "Canelones"))
    obtenido = lo_que_encuentra_la_app(page, ["Montevideo", "Canelones"])
    assert obtenido == esperado, f"Montevideo+Canelones: esperado {len(esperado)}, da {len(obtenido)}"


def caso_departamento_mas_barrio_de_otro(page):
    """Mezcla: todo Montevideo + Pando (que es de Canelones)."""
    esperado = slugs(x for x in venta() if x["depto"] == "Montevideo" or norm(x["barrio"]) == "pando")
    obtenido = lo_que_encuentra_la_app(page, ["Montevideo", "Pando"])
    assert obtenido == esperado, f"Montevideo+Pando: esperado {len(esperado)}, da {len(obtenido)}"
    assert any(norm(x["barrio"]) == "pando" for x in venta() if x["slug"] in obtenido), "faltó Pando"


def caso_zona_ciudad_de_la_costa_sola(page):
    """Sola: solo sus balnearios (sin linderos como Paso de Carrasco, Carmel, Pando...)."""
    esperado = slugs(x for x in venta() if x["depto"] == "Canelones" and norm(x["barrio"]) in ZONA_COSTA)
    obtenido = lo_que_encuentra_la_app(page, ["Ciudad de la Costa"])
    assert obtenido == esperado, f"Ciudad de la Costa sola: esperado {len(esperado)}, da {len(obtenido)}"
    barrios = {norm(x["barrio"]) for x in venta() if x["slug"] in obtenido}
    assert "solymar" in barrios and "lagomar" in barrios, "tiene que incluir sus balnearios (Solymar, Lagomar...)"
    assert not barrios & {"paso de carrasco", "colinas de carrasco", "pando"}, "no debe traer linderos"


def caso_sin_resultados_dobles(page):
    """Canelones + Ciudad de la Costa (que está dentro de Canelones) = lo de Canelones, una sola vez."""
    esperado = slugs(x for x in venta() if x["depto"] == "Canelones")
    obtenido = lo_que_encuentra_la_app(page, ["Canelones", "Ciudad de la Costa"])
    assert obtenido == esperado, f"Canelones+Costa: esperado {len(esperado)}, da {len(obtenido)}"
    # y en pantalla (buscar() de punta a punta): ninguna repetida
    page.evaluate("""() => { setStep('f-dmin', 2); setStep('f-dmax', 2); $('f-precio-max').value = '150000';
        SELBARRIOS = ['Canelones', 'Ciudad de la Costa']; renderChips(); buscar(); }""")
    en_pantalla = page.evaluate("RENDER_RES.map(function (c) { return c.slug; })")
    assert len(en_pantalla) == len(set(en_pantalla)) > 0, "hay resultados repetidos (o ninguno)"


def caso_zona_mas_otro_barrio(page):
    esperado = slugs(x for x in venta() if (x["depto"] == "Canelones" and norm(x["barrio"]) in ZONA_COSTA)
                     or norm(x["barrio"]) == "pando")
    obtenido = lo_que_encuentra_la_app(page, ["Ciudad de la Costa", "Pando"])
    assert obtenido == esperado, f"Costa+Pando: esperado {len(esperado)}, da {len(obtenido)}"


def caso_un_barrio_sigue_buscando_su_grupo(page):
    """La regla de los linderos NO cambia para un barrio suelto: Solymar trae también Paso de Carrasco."""
    barrios = {norm(x["barrio"]) for x in venta() if x["slug"] in lo_que_encuentra_la_app(page, ["Solymar"])}
    assert "paso de carrasco" in barrios or "carmel" in barrios, "un barrio suelto debe seguir trayendo su grupo"
    barrios = {norm(x["barrio"]) for x in venta() if x["slug"] in lo_que_encuentra_la_app(page, ["Pocitos"])}
    assert "punta carretas" in barrios, "Pocitos sigue trayendo a Punta Carretas (grupo de similares)"


def caso_dos_barrios_siguen_exactos(page):
    obtenido = lo_que_encuentra_la_app(page, ["Pocitos", "Centro"])
    barrios = {norm(x["barrio"]) for x in venta() if x["slug"] in obtenido}
    assert barrios == {"pocitos", "centro"}, f"2 barrios = solo esos exactos, y dio {barrios}"


def caso_sin_lugar_busca_todo_el_pais(page):
    esperado = slugs(venta())
    obtenido = lo_que_encuentra_la_app(page, [])
    assert obtenido == esperado, f"sin lugar tiene que traer todo: esperado {len(esperado)}, da {len(obtenido)}"
    assert len({x["depto"] for x in venta() if x["slug"] in obtenido}) > 10, "tiene que ser de varios departamentos"


def caso_departamento_explicito_gana_a_la_region_del_link(page):
    """Link pegado de Montevideo (región metro) + elijo Maldonado: no se puede bloquear en silencio."""
    obtenido = lo_que_encuentra_la_app(page, ["Maldonado"], base={"depto": "Montevideo", "barrio": "Pocitos"})
    esperado = slugs(x for x in venta() if x["depto"] == "Maldonado")
    assert obtenido == esperado, f"Maldonado explícito: esperado {len(esperado)}, da {len(obtenido)}"


def caso_link_y_sin_barrio_busca_todo_el_pais(page):
    """Pegás un link (de Maldonado), borrás el barrio → no queda NINGÚN filtro de zona: todo el país."""
    obtenido = lo_que_encuentra_la_app(page, [], base={"depto": "Maldonado", "barrio": "Punta del Este"})
    assert obtenido == slugs(venta()), (
        f"sin lugar elegido tiene que traer todo el país aunque haya un link: esperado {len(venta())}, da {len(obtenido)}")


def caso_la_region_del_link_sigue_cuidando_los_barrios(page):
    """Con un barrio elegido, la región del link sigue evitando mezclar ciudades: un link de Salto
    con 'Pocitos' no debe traer el Pocitos de Montevideo."""
    con_link = lo_que_encuentra_la_app(page, ["Pocitos"], base={"depto": "Salto", "barrio": "Centro"})
    sin_link = lo_que_encuentra_la_app(page, ["Pocitos"])
    assert sin_link and not con_link, f"la región del link debe seguir frenando barrios de otra ciudad ({len(con_link)})"


def caso_ubicacion_de_colinas_paso_y_carmel(page):
    """Colinas de Carrasco = Ruta 101 (con La Tahona/Zona América); Paso de Carrasco = lindero de la Costa;
    Carmel = parte de Ciudad de la Costa."""
    g = page.evaluate("""() => ({ tahona: grupoDe('La Tahona'), colinas: grupoDe('Colinas de Carrasco'),
        solymar: grupoDe('Solymar'), paso: grupoDe('Paso de Carrasco'), zonaCarmel: ZONA_IDX['ciudad de la costa'].barrios }) """)
    assert "colinas de carrasco" in g["tahona"] and g["colinas"] == g["tahona"], "Colinas de Carrasco va con La Tahona/Zona América"
    assert "colinas de carrasco" not in g["solymar"], "Colinas de Carrasco ya no es lindero de Solymar"
    assert "paso de carrasco" in g["solymar"] and g["paso"] == g["solymar"], "Paso de Carrasco sigue de lindero de la Costa"
    assert "carmel" in g["zonaCarmel"], "Carmel es parte de Ciudad de la Costa"
    canelones = {x["depto"] for x in LISTINGS if norm(x["barrio"]) in ("colinas de carrasco", "paso de carrasco", "carmel")}
    assert canelones == {"Canelones"}, f"los tres son de Canelones: {canelones}"


def caso_autocompletado_ofrece_departamento_y_zona(page):
    def sugerencias(q):
        return page.evaluate("""(q) => { limpiarTodo(); $('f-barrio').value = q; mostrarSug();
            return Array.from(document.querySelectorAll('.barrio-sug-item')).map(function (e) { return e.textContent; }); }""", q)
    s = sugerencias("monte")
    assert any("Montevideo" in t and "departamento" in t.lower() for t in s), f"'monte' debe ofrecer el departamento: {s}"
    assert sum("Montevideo" in t for t in s) == 1, f"'Montevideo' no debe aparecer dos veces (depto y barrio): {s}"
    s = sugerencias("ciudad de la")
    assert any("Ciudad de la Costa" in t and "zona" in t.lower() for t in s), f"debe ofrecer la zona: {s}"
    assert sum("Ciudad de la Costa" in t for t in s) == 1, f"'Ciudad de la Costa' repetida: {s}"
    s = sugerencias("pocitos")
    assert any(t.strip() == "Pocitos" for t in s), f"los barrios siguen ofreciéndose normal: {s}"


def caso_se_guarda_y_se_restaura(page):
    """Un cliente con departamento elegido se guarda y se reabre igual (snapshotForm/restoreForm)."""
    r = page.evaluate("""() => { limpiarTodo(); SELBARRIOS = ['Montevideo', 'Ciudad de la Costa', 'Pando'];
        var antes = JSON.stringify(leerFiltros()); var form = snapshotForm();
        limpiarTodo(); restoreForm(form); return [antes, JSON.stringify(leerFiltros()), $('barrio-chips').textContent]; }""")
    assert r[0] == r[1], "al reabrir, los filtros no quedaron iguales"
    assert "Montevideo" in r[2] and "Ciudad de la Costa" in r[2], "los chips no se restauraron"


def caso_cliente_viejo_sin_deptos(page):
    """Filtros guardados ANTES de este cambio (solo `grupo`, sin `deptos`) siguen andando igual."""
    r = page.evaluate("""() => { limpiarTodo(); var f = leerFiltros(); f.deptos = undefined; f.grupo = ['pocitos'];
        var n = DATA.filter(function (c) { return pasa(c, f, null); });
        return [n.length, n.every(function (c) { return norm(c.barrio) === 'pocitos'; })]; }""")
    assert r[0] > 0 and r[1], "un filtro viejo (solo barrio) dejó de funcionar"


def caso_la_captura_del_colega(page):
    """La búsqueda real que no daba nada: Montevideo+Canelones+Ciudad de la Costa, hasta 57.500 USD."""
    esperado = slugs(
        x for x in venta()
        if x["depto"] in ("Montevideo", "Canelones")
        and x.get("precio_usd") is not None and x["precio_usd"] <= 57500
        and x.get("dorm") is not None and 1 <= x["dorm"] <= 3
        and x.get("banos") is not None and 1 <= x["banos"] <= 3
        and x.get("m2_homog") is not None and x["m2_homog"] <= 100
        and (x.get("renta") in (True, False) or x.get("multiunidad") is True))
    obtenido = set(page.evaluate("""() => {
        limpiarTodo(); SELBARRIOS = ['Montevideo', 'Canelones', 'Ciudad de la Costa']; renderChips(); pintarGrupo();
        $('f-precio-max').value = '57.500'; $('f-cub-max').value = '100';
        setStep('f-dmin', 1); setStep('f-dmax', 3); setStep('f-bmin', 1); setStep('f-bmax', 3);
        setSegMulti('f-renta', ['con', 'multi', 'sin']);
        var f = leerFiltros();
        return DATA.filter(function (c) { return pasa(c, f, null); }).map(function (c) { return c.slug; }); }"""))
    assert esperado, "el dato de hoy no tiene casos para esta prueba"
    assert obtenido == esperado, f"captura del colega: esperado {len(esperado)}, la app da {len(obtenido)}"


CASOS_APP = [
    caso_departamento_entero, caso_varios_departamentos, caso_departamento_mas_barrio_de_otro,
    caso_zona_ciudad_de_la_costa_sola, caso_sin_resultados_dobles, caso_zona_mas_otro_barrio,
    caso_un_barrio_sigue_buscando_su_grupo, caso_dos_barrios_siguen_exactos,
    caso_sin_lugar_busca_todo_el_pais, caso_departamento_explicito_gana_a_la_region_del_link,
    caso_link_y_sin_barrio_busca_todo_el_pais, caso_la_region_del_link_sigue_cuidando_los_barrios,
    caso_ubicacion_de_colinas_paso_y_carmel, caso_autocompletado_ofrece_departamento_y_zona, caso_se_guarda_y_se_restaura,
    caso_cliente_viejo_sin_deptos, caso_la_captura_del_colega,
]


# ---------------- El robotito de avisos (worker/motor.js): misma regla ----------------
JS_WORKER = r"""
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
const ini = src.indexOf('function norm(s)'), fin = src.indexOf('// ---- Push: helpers ----');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(ini, fin), ctx);
const base = { operacion: 'sale', tipos: [], grupo: null, region: null, dmin: null, dmax: null, bmin: null, bmax: null,
  precioMinUsd: null, precioMaxUsd: null, cubMin: null, cubMax: null, padronMin: null, padronMax: null,
  cochera: '', estado: '', rentaSel: [], gastosMinUsd: null, gastosMaxUsd: null };
const mk = (barrio, depto) => ({ slug: barrio + depto, estado_pub: 'active', operacion: 'sale', tipo: 'casa', barrio, depto });
const pasa = (c, f) => ctx.pasa(c, Object.assign({}, base, f), null);
const r = {
  deptoEntero: pasa(mk('Cordon', 'Montevideo'), { deptos: ['montevideo'] }),
  otroDepto: pasa(mk('Pando', 'Canelones'), { deptos: ['montevideo'] }),
  union: pasa(mk('Pando', 'Canelones'), { deptos: ['montevideo'], grupo: ['pando'] }),
  unionOtro: pasa(mk('Salinas', 'Canelones'), { deptos: ['montevideo'], grupo: ['pando'] }),
  gana: pasa(mk('Punta del Este', 'Maldonado'), { deptos: ['maldonado'], region: 'metro' }),
  regionSigue: pasa(mk('Centro', 'Salto'), { grupo: ['centro'], region: 'metro' }),
  viejo: pasa(mk('Pocitos', 'Montevideo'), { grupo: ['pocitos'] }),
  viejoFuera: pasa(mk('Centro', 'Montevideo'), { grupo: ['pocitos'] }),
  zonaDentro: pasa(mk('Solymar', 'Canelones'), { zonas: [{ depto: 'canelones', barrios: ['solymar', 'lagomar'] }] }),
  zonaOtroBarrio: pasa(mk('Pando', 'Canelones'), { zonas: [{ depto: 'canelones', barrios: ['solymar', 'lagomar'] }] }),
  zonaOtroDepto: pasa(mk('Solymar', 'Montevideo'), { zonas: [{ depto: 'canelones', barrios: ['solymar', 'lagomar'] }] }),
  zonaGanaARegion: pasa(mk('Solymar', 'Canelones'), { zonas: [{ depto: 'canelones', barrios: ['solymar'] }], region: 'salto' }),
  regionSinLugar: pasa(mk('Punta del Este', 'Maldonado'), { region: 'metro' }),
};
console.log(JSON.stringify(r));
"""


def caso_worker():
    out = subprocess.run(["node", "-e", JS_WORKER, os.path.join(CARPETA, "worker", "motor.js")],
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, f"no pude cargar el filtro del worker: {out.stderr[:300]}"
    r = json.loads(out.stdout)
    assert r["deptoEntero"] is True, "worker: un departamento elegido tiene que traer propiedades de ese depto"
    assert r["otroDepto"] is False, "worker: no debe traer de otro departamento"
    assert r["union"] is True and r["unionOtro"] is False, "worker: departamento + barrio se combinan con 'o'"
    assert r["gana"] is True, "worker: el departamento elegido gana a la región del link"
    assert r["regionSigue"] is False, "worker: la región sigue frenando barrios de otra ciudad"
    assert r["viejo"] is True and r["viejoFuera"] is False, "worker: filtros viejos (solo barrio) deben seguir igual"
    assert r["zonaDentro"] is True and r["zonaOtroBarrio"] is False, "worker: la zona trae solo sus barrios"
    assert r["zonaOtroDepto"] is False, "worker: la zona exige su departamento (Solymar de Montevideo no entra)"
    assert r["zonaGanaARegion"] is True, "worker: la zona elegida gana a la región del link"
    assert r["regionSinLugar"] is True, "worker: sin ningún lugar elegido no hay restricción de región (todo el país)"


def main():
    srv = servir()
    fallos = 0
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = pagina_nueva(br)
        for caso in CASOS_APP:
            try:
                caso(page)
                print("OK   ", caso.__name__)
            except AssertionError as e:
                fallos += 1
                print("FALLA", caso.__name__, "->", e)
            except Exception as e:   # error de la app (función que todavía no existe, etc.)
                fallos += 1
                print("ERROR", caso.__name__, "->", str(e).splitlines()[0][:200])
        br.close()
    try:
        caso_worker()
        print("OK    caso_worker")
    except AssertionError as e:
        fallos += 1
        print("FALLA caso_worker ->", e)
    srv.shutdown()
    total = len(CASOS_APP) + 1
    print("\n%d de %d casos OK" % (total - fallos, total))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
