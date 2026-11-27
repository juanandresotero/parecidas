# Arma el robot de Parecidas en esta PC (1 sola vez; sirve también en una PC nueva).
# Desde el 2026-11-26 RE/MAX bloquea a las computadoras de GitHub, así que el robot corre acá:
#   - copia aparte del proyecto en %USERPROFILE%\parecidas-robot (fuera de OneDrive);
#   - su propio Python con el navegador (Playwright 1.49.1, igual que antes en GitHub);
#   - tarea de Windows "Parecidas - robot": todos los días 13:00, y 17:00 por si la primera falló.
#     Si la PC estaba suspendida a esa hora, corre apenas se despierta. No abre ninguna ventana.
# Requisitos: Python 3.13, git y gh logueado con la cuenta juanandresotero (gh auth login).
# Uso: powershell -ExecutionPolicy Bypass -File instalar_robot_pc.ps1

$ErrorActionPreference = "Stop"
$dest = Join-Path $env:USERPROFILE "parecidas-robot"

if (-not (Test-Path (Join-Path $dest ".git"))) {
    git clone https://github.com/juanandresotero/parecidas.git $dest
    if ($LASTEXITCODE -ne 0) { throw "No pude bajar el proyecto de GitHub" }
}

$venvPy = Join-Path $dest ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    py -3.13 -m venv (Join-Path $dest ".venv")
    if ($LASTEXITCODE -ne 0) { throw "No pude crear el Python del robot" }
}
& $venvPy -m pip install --quiet --disable-pip-version-check playwright==1.49.1
if ($LASTEXITCODE -ne 0) { throw "No pude instalar Playwright" }
& $venvPy -m playwright install chromium
if ($LASTEXITCODE -ne 0) { throw "No pude instalar el navegador" }

$accion = New-ScheduledTaskAction -Execute (Join-Path $dest ".venv\Scripts\pythonw.exe") `
    -Argument "`"$(Join-Path $dest 'robot_pc.py')`"" -WorkingDirectory $dest
$horarios = @((New-ScheduledTaskTrigger -Daily -At "13:00"), (New-ScheduledTaskTrigger -Daily -At "17:00"))
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Parecidas - robot" -Action $accion -Trigger $horarios -Settings $ajustes `
    -Description "Baja las propiedades de RE/MAX y las sube a GitHub para la app Parecidas (robot_pc.py)" -Force | Out-Null

Write-Host "Listo: robot instalado en $dest (tarea 'Parecidas - robot', 13:00 y 17:00)."
