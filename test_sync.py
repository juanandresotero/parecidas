"""Prueba de VINCULAR APARATOS con un código (sync.js): dos aparatos (dos navegadores distintos) comparten
clientes y código de associate a través de un servidor simulado; todo viaja cifrado; nada se pierde.

Pedido de Juan 2026-11-11: "inicio de sesión / vincular con código para que los datos sean los mismos en PC y celu".
Uso: python test_sync.py
"""
from __future__ import annotations

import json
import re
import sys
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

from test_ocultas import servir, PUERTO

MOTOR = "https://parecidas-motor.cualcaxsiempre.workers.dev"
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "*"}

BUSCAR = """() => { limpiarTodo(); setSeg('f-oper', 'sale'); setSegMulti('f-tipo', ['apto']);
    SELBARRIOS = ['Pocitos']; renderChips(); $('f-precio-max').value = '300000'; buscar(); }"""


class Boveda:
    """El servidor simulado (misma regla que worker/motor.js: versión + choque 409)."""

    def __init__(self):
        self.filas = {}
        self.pedidos = []
        self.caido = False
        self.choques = 0       # cuántos POST rechazar con 409 (simula que otro aparato subió justo antes)


def instalar(ctx, bov):
    def h(route, request):
        bov.pedidos.append((request.method, request.url, request.post_data or ""))
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if bov.caido:
            return route.abort()
        q = parse_qs(urlparse(request.url).query)
        if "sync" not in q:
            return route.fulfill(status=200, body="{}", content_type="application/json", headers=CORS)
        id_ = q["sync"][0]
        fila = bov.filas.get(id_)
        if request.method == "GET":
            cuerpo = {"ok": True, "v": fila["v"] if fila else 0, "blob": fila["blob"] if fila else None}
            return route.fulfill(status=200, body=json.dumps(cuerpo), content_type="application/json", headers=CORS)
        d = json.loads(request.post_data)
        actual = fila["v"] if fila else 0
        if bov.choques > 0 or d["base"] != actual:
            bov.choques = max(0, bov.choques - 1)
            return route.fulfill(status=409, body=json.dumps({"error": "version", "v": actual}), content_type="application/json", headers=CORS)
        bov.filas[id_] = {"blob": d["blob"], "v": actual + 1}
        route.fulfill(status=200, body=json.dumps({"ok": True, "v": actual + 1}), content_type="application/json", headers=CORS)

    ctx.route(MOTOR + "/**", h)


def aparato(br, bov, hash_=""):
    ctx = br.new_context(service_workers="block", viewport={"width": 420, "height": 900})
    instalar(ctx, bov)
    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PUERTO}/{hash_}", wait_until="load")
    page.wait_for_function("DATA.length > 0 && window.SYNC", timeout=20000)
    return page


def con_clientes(page, nombres):
    """Deja en el aparato clientes de verdad (el primero guardado por la app y el resto copiados de él)."""
    page.evaluate(BUSCAR)
    page.evaluate("guardarBusquedaActual(%s, '099111222', '', false)" % json.dumps(nombres[0]))
    page.evaluate("""(nombres) => { var arr = cargarBusquedas(), base = arr[0];
        nombres.slice(1).forEach(function (n, i) { var c = JSON.parse(JSON.stringify(base)); c.id = 'extra' + i; c.nombre = n; arr.push(c); });
        guardarBusquedas(arr); }""", nombres)


def nombres(page):
    return page.evaluate("cargarBusquedas().map(function (c) { return c.nombre; }).sort()")


def ids(page):
    return page.evaluate("cargarBusquedas().map(function (c) { return c.id; }).sort()")


def sincronizar(page):
    return page.evaluate("SYNC.sincronizar()")


def caso_crear_y_vincular_otro_aparato(br, bov):
    a = aparato(br, bov)
    con_clientes(a, ["Ana Pérez", "Beto Gómez"])
    codigo = a.evaluate("SYNC.crear()")
    assert re.fullmatch(r"[0-9A-Z]{5}(-[0-9A-Z]{5}){3}", codigo), f"el código tiene que ser 4 grupos de 5: {codigo}"
    b = aparato(br, bov)
    assert nombres(b) == [], "el aparato nuevo arranca vacío"
    r = b.evaluate("SYNC.vincular(%s)" % json.dumps(codigo))
    assert r["ok"], f"vincular falló: {r}"
    assert nombres(b) == ["Ana Pérez", "Beto Gómez"], f"B tiene que tener los clientes de A: {nombres(b)}"
    assert ids(a) == ids(b), "mismos ids en los dos aparatos"
    a.context.close(); b.context.close()


def vinculados(br, bov, nombres_a=("Ana Pérez", "Beto Gómez")):
    a = aparato(br, bov)
    con_clientes(a, list(nombres_a))
    codigo = a.evaluate("SYNC.crear()")
    b = aparato(br, bov)
    assert b.evaluate("SYNC.vincular(%s)" % json.dumps(codigo))["ok"]
    return a, b, codigo


def caso_un_cambio_llega_al_otro(br, bov):
    a, b, _ = vinculados(br, bov)
    b.evaluate("() => { var arr = cargarBusquedas(); arr[0].nombre = 'Ana Pérez (editada)'; guardarBusquedas(arr); }")
    assert sincronizar(b)["ok"]
    assert sincronizar(a)["ok"]
    assert "Ana Pérez (editada)" in nombres(a), f"el cambio de B tiene que llegar a A: {nombres(a)}"
    a.context.close(); b.context.close()


def caso_borrar_llega_al_otro(br, bov):
    a, b, _ = vinculados(br, bov)
    id_borrar = a.evaluate("cargarBusquedas()[0].id")
    a.evaluate("(id) => borrarBusqueda(id)", id_borrar)
    assert sincronizar(a)["ok"] and sincronizar(b)["ok"]
    assert id_borrar not in ids(b), "lo que se borra en A también se borra en B"
    assert len(ids(a)) == len(ids(b)) == 1
    a.context.close(); b.context.close()


def caso_gana_el_cambio_mas_reciente(br, bov):
    a, b, _ = vinculados(br, bov)
    idc = a.evaluate("cargarBusquedas()[0].id")
    a.evaluate("(id) => { var arr = cargarBusquedas(); arr.filter(function (c) { return c.id === id; })[0].nombre = 'Versión A'; guardarBusquedas(arr); }", idc)
    a.wait_for_timeout(30)
    b.evaluate("(id) => { var arr = cargarBusquedas(); arr.filter(function (c) { return c.id === id; })[0].nombre = 'Versión B (más nueva)'; guardarBusquedas(arr); }", idc)
    assert sincronizar(a)["ok"] and sincronizar(b)["ok"] and sincronizar(a)["ok"]
    na = a.evaluate("(id) => cargarBusquedas().filter(function (c) { return c.id === id; })[0].nombre", idc)
    nb = b.evaluate("(id) => cargarBusquedas().filter(function (c) { return c.id === id; })[0].nombre", idc)
    assert na == nb == "Versión B (más nueva)", f"gana el más reciente en los dos: A={na} B={nb}"
    a.context.close(); b.context.close()


def caso_cambios_distintos_se_suman_aunque_choquen(br, bov):
    a, b, _ = vinculados(br, bov)
    a.evaluate("() => { var arr = cargarBusquedas(); arr[0].nombre = 'Cambio en A'; guardarBusquedas(arr); }")
    b.evaluate("() => { var arr = cargarBusquedas(); arr[1].nombre = 'Cambio en B'; guardarBusquedas(arr); }")
    bov.choques = 1                      # el primer subir se rechaza: tiene que volver a bajar, mezclar y reintentar
    assert sincronizar(b)["ok"], "con un choque de versión tiene que reintentar"
    assert sincronizar(a)["ok"] and sincronizar(b)["ok"]
    assert nombres(a) == nombres(b) == ["Cambio en A", "Cambio en B"], f"los dos cambios quedan: A={nombres(a)} B={nombres(b)}"
    a.context.close(); b.context.close()


def caso_viaja_cifrado(br, bov):
    a, b, codigo = vinculados(br, bov, ("Cliente Secreto Zubiría", "Otra Persona"))
    sincronizar(a)
    todo = json.dumps(bov.pedidos, ensure_ascii=False) + json.dumps(bov.filas, ensure_ascii=False)
    assert "Zubiría" not in todo and "099111222" not in todo, "los nombres y teléfonos NO pueden viajar ni guardarse en claro"
    assert codigo not in todo and codigo.replace("-", "") not in todo, "el código NO puede viajar al servidor"
    assert all(re.fullmatch(r"[0-9a-f]{32}", parse_qs(urlparse(u).query)["sync"][0]) for m, u, d in bov.pedidos if "sync=" in u), "al servidor solo llega un id de 32 hex"
    a.context.close(); b.context.close()


def caso_codigo_invalido_o_ajeno(br, bov):
    b = aparato(br, bov)
    con_clientes(b, ["Mis datos"])
    assert b.evaluate("SYNC.vincular('ABC')")["ok"] is False, "un código mal escrito se rechaza"
    assert b.evaluate("SYNC.vincular('')")["ok"] is False
    assert nombres(b) == ["Mis datos"], "no se pierde nada por intentar"
    ajeno = "ABCDE-FGHJK-MNPQR-STVWX"           # código válido pero que nadie creó
    r = b.evaluate("SYNC.vincular(%s)" % json.dumps(ajeno))
    assert r["ok"] and nombres(b) == ["Mis datos"], f"vincular con un código nuevo no borra lo local: {r} {nombres(b)}"
    b.context.close()


def caso_associate_viaja(br, bov):
    a = aparato(br, bov)
    con_clientes(a, ["Ana"])
    a.evaluate("() => { localStorage.setItem('parecidas_associate', '987654321'); SYNC.cambioAssociate(); }")
    codigo = a.evaluate("SYNC.crear()")
    b = aparato(br, bov)
    assert b.evaluate("SYNC.vincular(%s)" % json.dumps(codigo))["ok"]
    assert b.evaluate("localStorage.getItem('parecidas_associate')") == "987654321", "el código de associate llega al otro aparato"
    assert b.evaluate("ASSOCIATE") == "987654321", "y la app ya lo usa"
    a.context.close(); b.context.close()


def caso_sin_conexion_no_pierde_nada(br, bov):
    a, b, _ = vinculados(br, bov)
    antes = nombres(a)
    bov.caido = True
    r = sincronizar(a)
    assert r["ok"] is False, "sin conexión tiene que avisar que no pudo"
    assert nombres(a) == antes, "y no tocar los datos locales"
    bov.caido = False
    assert sincronizar(a)["ok"], "al volver la conexión funciona"
    a.context.close(); b.context.close()


def caso_marca_de_modificacion(br, bov):
    a = aparato(br, bov)
    con_clientes(a, ["Ana", "Beto"])
    mods = a.evaluate("cargarBusquedas().map(function (c) { return c.mod; })")
    assert all(isinstance(m, (int, float)) and m > 0 for m in mods), f"cada cliente guardado lleva su marca de modificación: {mods}"
    a.wait_for_timeout(20)
    a.evaluate("() => { var arr = cargarBusquedas(); arr[0].ultimaLista = ['x']; arr[0].vistas = ['y']; guardarBusquedas(arr); }")
    mods2 = a.evaluate("cargarBusquedas().map(function (c) { return c.mod; })")
    assert mods2 == mods, "cambiar 'ultimaLista'/'vistas' (cosas de pantalla) no cuenta como modificación"
    a.evaluate("() => { var arr = cargarBusquedas(); arr[0].nombre = 'Ana Nueva'; guardarBusquedas(arr); }")
    mods3 = a.evaluate("cargarBusquedas().map(function (c) { return c.mod; })")
    assert mods3[0] > mods[0] and mods3[1] == mods[1], f"solo el cliente que cambió sube su marca: {mods} → {mods3}"
    a.context.close()


def caso_pantalla_de_ajustes(br, bov):
    a = aparato(br, bov)
    con_clientes(a, ["Ana"])
    a.evaluate("$('btn-ajustes').click()")
    assert a.evaluate("$('sync-con').offsetParent === null") and a.evaluate("$('btn-sync-crear').offsetParent !== null"), "sin vincular se ofrece crear o ingresar un código"
    a.evaluate("$('btn-sync-crear').click()")
    a.wait_for_function("document.getElementById('sync-con').offsetParent !== null", timeout=10000)
    assert a.evaluate("$('sync-sin').offsetParent === null"), "ya vinculado, se ve el estado"
    codigo = a.evaluate("SYNC.estado().codigo")
    a.evaluate("$('btn-sync-ver').click()")
    assert codigo in a.evaluate("$('sync-codigo-vista').textContent"), "'Ver mi código' muestra el código"
    b = aparato(br, bov)
    b.evaluate("$('btn-ajustes').click()")
    b.evaluate("(c) => { $('in-sync-codigo').value = c; $('btn-sync-vincular').click(); }", codigo)
    b.wait_for_function("document.getElementById('sync-con').offsetParent !== null", timeout=10000)
    assert nombres(b) == ["Ana"], f"vincular desde la pantalla trae los clientes: {nombres(b)}"
    b.evaluate("$('btn-sync-fuera').click()")      # primer toque: pide confirmar
    assert b.evaluate("SYNC.estado().vinculado") is True, "un solo toque no desvincula"
    b.evaluate("$('btn-sync-fuera').click()")
    assert b.evaluate("SYNC.estado().vinculado") is False and nombres(b) == ["Ana"], "desvincular no borra los datos del aparato"
    a.context.close(); b.context.close()


def caso_link_de_vinculacion(br, bov):
    a = aparato(br, bov)
    codigo = a.evaluate("SYNC.crear()")
    b = aparato(br, bov, hash_="#vincular=" + codigo)
    assert b.evaluate("$('in-sync-codigo').value").replace("-", "") == codigo.replace("-", ""), "el link deja el código escrito"
    assert b.evaluate("$('ajustes').style.display") == "flex", "y abre Ajustes para tocar Vincular"
    assert b.evaluate("SYNC.estado().vinculado") is False, "NO se vincula solo: hay que confirmar"
    a.context.close(); b.context.close()


CASOS = [caso_crear_y_vincular_otro_aparato, caso_un_cambio_llega_al_otro, caso_borrar_llega_al_otro,
         caso_gana_el_cambio_mas_reciente, caso_cambios_distintos_se_suman_aunque_choquen, caso_viaja_cifrado,
         caso_codigo_invalido_o_ajeno, caso_associate_viaja, caso_sin_conexion_no_pierde_nada,
         caso_marca_de_modificacion, caso_pantalla_de_ajustes, caso_link_de_vinculacion]


def main():
    srv = servir()
    fallos = 0
    with sync_playwright() as p:
        br = p.chromium.launch()
        for caso in CASOS:
            try:
                caso(br, Boveda())
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
