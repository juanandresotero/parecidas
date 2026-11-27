"""Robot de Parecidas en la PC de Juan.

Desde el 2026-11-26 RE/MAX bloquea las computadoras de GitHub (el navegador entra a la página pero los datos dan
"Failed to fetch"); desde la conexión de Juan contesta normal. Entonces Windows corre esto 1 vez por día
(tarea "Parecidas - robot", la arma instalar_robot_pc.ps1):

  1. trae lo último de GitHub (código del robot y datos);
  2. si los datos ya son de hoy, no hace nada (la tarea tiene 2 horarios: el 2º es por si el 1º falló);
  3. corre build_listings.py (el robot de siempre);
  4. si salió bien, sube los 4 archivos de datos a GitHub con la cuenta de Juan (aunque gh tenga activa la de
     Taller212). La app los toma de ahí, igual que antes.

Corre en una copia aparte (fuera de OneDrive), así nunca sube cambios de la app que Juan no aprobó.
Lo que pasa queda en robot_pc.log, al lado de este archivo.
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
LOG = AQUI / "robot_pc.log"
CUENTA = "juanandresotero"
DATOS = ["listings.json", "primera_vez.json", "historial.json", "fichas_al.json"]
SIN_VENTANA = getattr(subprocess, "CREATE_NO_WINDOW", 0)   # que no aparezca ninguna ventana negra
BOT = ["-c", "user.name=parecidas-bot", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"]
# Solo la llave de gh (GH_TOKEN): ni el administrador de Windows (que tiene la de Taller212) ni ventanas de login.
LLAVE = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-c", "credential.interactive=never"]


def python_con_consola() -> str:
    """La tarea arranca con pythonw (sin ventana); build_listings.py se corre con el python.exe de al lado."""
    exe = Path(sys.executable)
    hermano = exe.with_name("python.exe")
    return str(hermano if exe.name.lower() == "pythonw.exe" and hermano.exists() else exe)


def correr(cmd, env=None):
    r = subprocess.run(cmd, cwd=AQUI, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env=env, creationflags=SIN_VENTANA)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def ya_es_de_hoy(carpeta: Path, hoy: str) -> bool:
    try:
        return json.loads((carpeta / "listings.json").read_text("utf-8")).get("generado_at") == hoy
    except (OSError, ValueError):
        return False


def una_vuelta(correr=correr, carpeta: Path = AQUI, hoy: str | None = None, log=print) -> int:
    hoy = hoy or datetime.date.today().isoformat()
    cod, token = correr(["gh", "auth", "token", "-u", CUENTA])
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    if cod == 0 and token.strip():
        env["GH_TOKEN"] = token.strip()
    else:
        log("No encontré la llave de GitHub de " + CUENTA + " (gh auth login): bajo igual, pero no voy a poder subir.")

    cod, salida = correr(["git", *LLAVE, "pull", "--rebase", "origin", "main"], env)
    if cod != 0:
        log("No pude traer lo último de GitHub:\n" + salida[-1500:])
        return 1
    if ya_es_de_hoy(carpeta, hoy):
        log("Los datos ya son de hoy (" + hoy + "): no hago nada.")
        return 0

    cod, salida = correr([python_con_consola(), "build_listings.py"], env)
    log(salida[-3000:])
    if cod != 0:
        log("El robot falló: no subo nada (la app sigue con los datos anteriores).")
        return 1

    correr(["git", "add", *DATOS], env)
    correr(["git", *BOT, "commit", "-m", f"datos: actualizar propiedades ({hoy}, desde la PC)"], env)
    correr(["git", *LLAVE, "pull", "--rebase", "origin", "main"], env)
    cod, salida = correr(["git", *LLAVE, "push", "origin", "HEAD:main"], env)
    if cod != 0:
        log("No pude subir los datos a GitHub:\n" + salida[-1500:])
        return 1
    log("Listo: datos de " + hoy + " subidos.")
    return 0


def anotar(msg: str):
    """Agrega al registro y lo deja en las últimas ~400 líneas (que no crezca para siempre)."""
    linea = datetime.datetime.now().strftime("%Y-%m-%d %H:%M") + "  " + msg.strip() + "\n"
    viejo = LOG.read_text("utf-8").splitlines(keepends=True) if LOG.exists() else []
    LOG.write_text("".join((viejo + [linea])[-400:]), "utf-8")


if __name__ == "__main__":
    try:
        sys.exit(una_vuelta(log=anotar))
    except Exception as e:   # que quede escrito: con pythonw no hay pantalla donde verlo
        anotar(f"Error inesperado: {e!r}")
        sys.exit(1)
