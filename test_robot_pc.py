"""Prueba del robot en la PC de Juan (robot_pc.py). Desde el 2026-11-26 RE/MAX bloquea las compus de GitHub,
así que el robot corre en la PC: baja los datos y los sube a GitHub (de ahí los toma la app).
No toca RE/MAX ni GitHub de verdad: los comandos se registran en vez de ejecutarse.

Uso: python test_robot_pc.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import robot_pc


class Comandos:
    """Hace de cuenta que corre los comandos: los anota y contesta OK (o falla los que se le digan)."""

    def __init__(self, fallan=()):
        self.hechos, self.envs, self.fallan = [], [], fallan

    def __call__(self, cmd, env=None):
        self.hechos.append(cmd)
        self.envs.append(env)
        if cmd[:3] == ["gh", "auth", "token"]:
            return 0, "TOKEN-DE-JUAN\n"
        if any(f in " ".join(cmd) for f in self.fallan):
            return 1, "Error: Failed to fetch"
        return 0, ""

    def corrio(self, texto):
        return any(texto in " ".join(c) for c in self.hechos)


def carpeta_con(generado_at):
    d = Path(tempfile.mkdtemp())
    (d / "listings.json").write_text(json.dumps({"listings": [], "generado_at": generado_at}), "utf-8")
    return d


def caso_si_ya_se_actualizo_hoy_no_baja_nada():
    c = Comandos()
    assert robot_pc.una_vuelta(c, carpeta=carpeta_con("2026-11-27"), hoy="2026-11-27", log=lambda m: None) == 0
    assert c.corrio("pull"), "igual trae lo último de GitHub (por si ya corrió en otro lado)"
    assert not c.corrio("build_listings.py"), "no le vuelve a pedir todo a RE/MAX el mismo día"
    assert not c.corrio("push")


def caso_si_el_robot_falla_no_sube_nada():
    c = Comandos(fallan=("build_listings.py",))
    avisos = []
    assert robot_pc.una_vuelta(c, carpeta=carpeta_con("2026-11-25"), hoy="2026-11-27", log=avisos.append) == 1
    assert not c.corrio("push") and not c.corrio("commit"), "con datos a medias no se sube nada"
    assert any("Failed to fetch" in a for a in avisos), f"el error queda anotado en el registro: {avisos}"


def caso_sube_los_datos_con_la_cuenta_de_juan():
    c = Comandos()
    assert robot_pc.una_vuelta(c, carpeta=carpeta_con("2026-11-25"), hoy="2026-11-27", log=lambda m: None) == 0
    assert ["gh", "auth", "token", "-u", "juanandresotero"] in c.hechos, \
        "usa la cuenta de Juan aunque gh tenga activa la de Taller212"
    add = next(x for x in c.hechos if x[:2] == ["git", "add"])
    assert set(robot_pc.DATOS) <= set(add), f"sube los 4 archivos de datos: {add}"
    push = c.hechos.index(next(x for x in c.hechos if "push" in x))
    assert c.envs[push] and c.envs[push].get("GH_TOKEN") == "TOKEN-DE-JUAN", "el push va con la llave de Juan"
    assert c.hechos.index(next(x for x in c.hechos if "build_listings.py" in " ".join(x))) < push


CASOS = [caso_si_ya_se_actualizo_hoy_no_baja_nada, caso_si_el_robot_falla_no_sube_nada,
         caso_sube_los_datos_con_la_cuenta_de_juan]


def main():
    fallos = 0
    for caso in CASOS:
        try:
            caso()
            print("OK   ", caso.__name__)
        except Exception as e:
            fallos += 1
            print("FALLA", caso.__name__, "->", repr(e)[:300])
    print("\n%d de %d casos OK" % (len(CASOS) - fallos, len(CASOS)))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
