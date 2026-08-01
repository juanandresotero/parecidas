# Parecidas 🔎🏠

Buscador de propiedades **similares** para agentes de RE/MAX (Montevideo + Canelones).
Pegás el link de una propiedad → te devuelve las parecidas de **todo RE/MAX**, listas
para copiar con tu `associate`.

Es una **web app** (se abre en el celu y se agrega a la pantalla de inicio). No necesita
servidor: el celu baja un archivo (`listings.json`) y filtra solo.

## Cómo funciona

- **`build_listings.py`** (el "robot"): baja las propiedades de RE/MAX (Mvd + Canelones),
  entra al detalle de cada una y arma `listings.json` con todo precalculado
  (m² homogeneizado, padrón, cochera, estado, precio en USD). Solo usa Python estándar.
- **GitHub Actions** (`.github/workflows/build.yml`): corre el robot **1 vez por día** y
  guarda el `listings.json` nuevo. Automático.
- **GitHub Pages**: sirve la app (`index.html` + `app.js` + `barrios.js` + datos).

## Reglas de búsqueda

Todos los filtros son **opcionales**: lo que dejes vacío (o en "Da igual") se ignora.

- **Barrio**: linderos / de valor parecido (grupos en `barrios.js`).
- **Precio**: hasta +15% del que pongas (comparado en USD).
- **Dormitorios**: rango mín–máx.
- **Tipo**: casa / apto / terreno.
- **m² construidos** y **m² totales (padrón)**: ±25%.
- **Cochera** y **estado** (usada / a estrenar).

## Correr el robot a mano

```bash
python build_listings.py            # todo Mvd + Canelones
LIMIT=25 python build_listings.py   # prueba rápida
```

Datos públicos de RE/MAX. Sin claves ni secretos.
