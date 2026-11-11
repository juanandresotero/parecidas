"""Prueba del SERVIDOR de la vinculación por código (worker/motor.js, manejarSync): guarda lo que le mandan
(ya cifrado), lo devuelve, y no deja que dos aparatos se pisen sin enterarse (control de versión).
Usa una base de datos falsa en memoria (misma forma que D1).

Pedido de Juan 2026-11-11 (vincular PC y celular con un código).
Uso: python test_sync_worker.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

CARPETA = os.path.dirname(os.path.abspath(__file__))

JS = r"""
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
const ini = src.indexOf('// ---- Sync: inicio ----'), fin = src.indexOf('// ---- Sync: fin ----');
if (ini < 0 || fin < 0) { console.log(JSON.stringify({ error: 'no encuentro manejarSync' })); process.exit(0); }
const ctx = { Response, JSON, Number, Date, RegExp, String };
vm.createContext(ctx);
vm.runInContext('function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s }); }\n' + src.slice(ini, fin) + '\nthis.manejarSync = manejarSync;', ctx);

// D1 de mentira: solo entiende las 3 frases que usa manejarSync.
const filas = new Map();
const db = { prepare(sql) { return { bind(...a) { return {
  async first() { const r = filas.get(a[0]); return r ? { blob: r.blob, v: r.v } : null; },
  async run() {
    if (/^INSERT OR IGNORE/.test(sql)) { if (filas.has(a[0])) return { meta: { changes: 0 } }; filas.set(a[0], { blob: a[1], v: 1 }); return { meta: { changes: 1 } }; }
    if (/^UPDATE/.test(sql)) { const r = filas.get(a[2]); if (!r || r.v !== a[3]) return { meta: { changes: 0 } }; r.blob = a[0]; r.v += 1; return { meta: { changes: 1 } }; }
    throw new Error('SQL no esperado: ' + sql);
  } }; } }; } };
const env = { SYNC: db };
const ID = 'a'.repeat(32), ID2 = 'b'.repeat(32);
const pedir = async (m, id, body) => {
  const r = await ctx.manejarSync(new Request('https://x/?sync=' + id, { method: m, body: body ? JSON.stringify(body) : undefined }), env, id);
  return { status: r.status, body: await r.json() };
};
(async () => {
  const out = {};
  out.vacio = await pedir('GET', ID);
  out.crear = await pedir('POST', ID, { blob: 'AAA', base: 0 });
  out.leer = await pedir('GET', ID);
  out.crearOtraVez = await pedir('POST', ID, { blob: 'ZZZ', base: 0 });           // ya existe → choque
  out.subir = await pedir('POST', ID, { blob: 'BBB', base: 1 });
  out.subirViejo = await pedir('POST', ID, { blob: 'CCC', base: 1 });             // versión vieja → choque
  out.leer2 = await pedir('GET', ID);
  out.otraBoveda = await pedir('GET', ID2);
  out.idMalo = await pedir('GET', 'corto');
  out.sinBlob = await pedir('POST', ID, { base: 2 });
  out.enorme = await pedir('POST', ID, { blob: 'x'.repeat(3_000_001), base: 2 });
  out.metodo = await pedir('DELETE', ID);
  out.sinBase = await ctx.manejarSync(new Request('https://x', { method: 'GET' }), {}, ID).then(r => r.status);
  console.log(JSON.stringify(out));
})();
"""


def correr():
    out = subprocess.run(["node", "-e", JS, os.path.join(CARPETA, "worker", "motor.js")],
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, f"node falló: {out.stderr[:400]}"
    return json.loads(out.stdout)


def caso_guardar_y_leer(r):
    assert "error" not in r or r["error"] != "no encuentro manejarSync", "falta manejarSync en worker/motor.js"
    assert r["vacio"]["body"] == {"ok": True, "v": 0, "blob": None}, f"bóveda nueva: {r['vacio']}"
    assert r["crear"]["status"] == 200 and r["crear"]["body"]["v"] == 1, f"crear: {r['crear']}"
    assert r["leer"]["body"]["blob"] == "AAA" and r["leer"]["body"]["v"] == 1, f"leer: {r['leer']}"


def caso_no_pisa_sin_enterarse(r):
    assert r["crearOtraVez"]["status"] == 409, "crear sobre una ya existente tiene que chocar"
    assert r["subir"]["status"] == 200 and r["subir"]["body"]["v"] == 2, f"subir con la versión al día: {r['subir']}"
    assert r["subirViejo"]["status"] == 409 and r["subirViejo"]["body"]["v"] == 2, f"subir con versión vieja choca y avisa la actual: {r['subirViejo']}"
    assert r["leer2"]["body"]["blob"] == "BBB", "lo del aparato desactualizado NO pisó nada"


def caso_aislamiento_y_validaciones(r):
    assert r["otraBoveda"]["body"]["blob"] is None, "otra bóveda no ve lo de la primera"
    assert r["idMalo"]["status"] == 400, "id que no es de 32 hex → 400"
    assert r["sinBlob"]["status"] == 400, "sin datos → 400"
    assert r["enorme"]["status"] == 400, "datos enormes → 400"
    assert r["metodo"]["status"] == 405, "otro método → 405"
    assert r["sinBase"] == 501, "sin base de datos configurada → 501"


CASOS = [caso_guardar_y_leer, caso_no_pisa_sin_enterarse, caso_aislamiento_y_validaciones]


def main():
    r = correr()
    fallos = 0
    for caso in CASOS:
        try:
            caso(r)
            print("OK   ", caso.__name__)
        except AssertionError as e:
            fallos += 1
            print("FALLA", caso.__name__, "->", str(e)[:300])
        except KeyError as e:
            fallos += 1
            print("ERROR", caso.__name__, "-> falta", e)
    print("\n%d de %d casos OK" % (len(CASOS) - fallos, len(CASOS)))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
