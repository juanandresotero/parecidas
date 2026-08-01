# Motorcito de Parecidas (InfoCasas + MercadoLibre)

Es un programita chico que vive en internet (Cloudflare Workers, **gratis**) y le
lee a la app los datos de una propiedad de **InfoCasas** o **MercadoLibre**. Hace
falta porque el celu, por seguridad del navegador, no puede leer otros sitios
directo. El motorcito lo hace por él. **No usa ninguna llave ni contraseña de esos
portales.**

## Qué devuelve

Le pasás un link y devuelve, ya masticado:
`tipo, operación (venta/alquiler), precio, moneda, dormitorios, m² construidos,
m² totales, cochera, estado (usada/a estrenar), renta`.

Ejemplo: `https://parecidas-motor.TU-USUARIO.workers.dev/?url=<link>`

## Cómo publicarlo (una sola vez)

1. Crear una cuenta **gratis** en https://dash.cloudflare.com/sign-up (con tu mail).
2. Desde esta carpeta `worker/`, en una terminal:
   ```
   npx wrangler login      # abre el navegador, dar OK
   npx wrangler deploy     # publica el motorcito y te da la URL .workers.dev
   ```
3. Copiar esa URL (`https://parecidas-motor.….workers.dev`) y pegarla en la app:
   **⚙️ Ajustes → Motor de otros portales**. Guardar. Listo.

Después, cuando pegues un link de InfoCasas o MercadoLibre en Parecidas y toques
**Traer**, la app le pregunta al motorcito y llena los datos sola.

## Aviso honesto

- **MercadoLibre**: la ficha directa (el link que uno pega) pasa bien desde el
  motorcito; precio y ficha técnica se leen sin problema.
- **InfoCasas**: los datos vienen en un JSON dentro de la página. El motorcito lo
  lee, pero como esos portales cambian el formato cada tanto, puede que algún dato
  no salga y haya que completarlo a mano. La app siempre deja completar/corregir a
  mano antes de buscar.
