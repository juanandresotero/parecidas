# Detector de MULTI-UNIDAD (varias viviendas en un mismo padrón)

Filtro "Varias unidades" de Parecidas. Detecta avisos donde hay **más de una vivienda
construida sobre un mismo padrón** (casa con apto al fondo, 2 casas, multifamiliar, etc.).

## Dónde vive
- **Detector:** `build_listings.py` → `es_multiunidad(texto)` + listas `_MULTI_*`.
  Se aplica sobre **título + descripción** (la API de RE/MAX ya nos da la descripción,
  así que NO hace falta scraping ni cola de pendientes).
- **Flag guardado:** cada propiedad en `listings.json` lleva `"multiunidad": true|false|null`
  (null = sin texto que leer; el robot re-lee al día siguiente).
- **Filtro (UI):** control multi-select "Con renta / Varias unidades / Sin renta"
  (`f-renta` en `index.html`, lógica OR en `pasa()` de `app.js` y `worker/motor.js`).

## Lógica del detector (el ORDEN importa)
1. Normalizar: minúsculas, sin tildes, números en letra→cifra, separar cifra pegada.
2. **Exclusiones PRIMERO** (`_MULTI_EXCLUIR`): edificio nuevo/desarrollo + Propiedad
   Horizontal. Si matchea → descartar YA.
3. Frases positivas fuertes (`_MULTI_POSITIVAS`): "mismo padron", "casa con apto",
   "2 casas", "vivienda multifamiliar", "viviendas independientes", "2 familias", etc.
4. Patrón numérico restringido: `N <sustantivo>` **solo** si sustantivo ∈ {casas, casitas}.
5. Combinación: una de `_MULTI_COMBO_A` (frente/adelante/principal) **+** una de
   `_MULTI_COMBO_B` (al fondo/segunda/trasera).

## Base: documento original
El vocabulario y la lógica vienen de `CONOCIMIENTO_MULTIUNIDAD_PADRON.md` (proyecto
SerchJAO, validado contra MercadoLibre/InfoCasas). **Leerlo antes de tocar las listas.**

## ⚠️ Ajustes hechos al validar contra RE/MAX (2026-08-14)
Probado contra 3.711 descripciones reales. Bajó de 7,0% a 3,4% (limpio) sacando falsos
positivos propios de RE/MAX (que en MELI/InfoCasas no aparecían así):

- **"casa principal" sola = ruido.** En RE/MAX los agentes la usan para describir LA
  construcción principal ("Casa principal: living, 3 dorm…"), no una 2da vivienda
  (~80% falsos). Se movió de positiva fuerte a **mitad de combinación** (`_MULTI_COMBO_A`):
  solo cuenta si además hay "al fondo/segunda/trasera".
- **PH reforzado.** Se agregó `"propiedad horizontal"` (sin preposición) y `"regimen de ph"`
  a las exclusiones (se colaban avisos "Excelente propiedad horizontal…", "régimen de PH").
- **"frente y fondo" solo = ruido** (era "jardín/patio/terreno al frente y fondo", ~90%
  falsos). Se sacó; queda el inequívoco "casa al frente y al fondo".

**Regla de oro:** cualquier cambio a las listas → volver a medir contra las descripciones
reales (script suelto: aplicar `es_multiunidad` sobre `propiedadparecidaspool.descripcion`
de la base de Auto-Meta y revisar las frases disparadoras). Cada línea es una prueba.
