// Service worker: deja andar la app sin conexión y sirve los datos frescos.
var CACHE = "parecidas-v4";
var SHELL = ["./", "index.html", "app.js", "barrios.js",
             "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: "reload" }); }))
            .catch(function () {}); // si falta algún archivo, no rompe la instalación
  }));
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; })
                         .map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var u = new URL(e.request.url);
  var propia = u.origin === location.origin;
  if (!propia && !u.pathname.endsWith("listings.json")) return;
  // Red PRIMERO (siempre lo más fresco: los cambios se ven al toque). Si no hay
  // señal, sirve lo último guardado (anda offline). Guarda cada respuesta buena.
  e.respondWith(fetch(e.request).then(function (r) {
    var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, cp); });
    return r;
  }).catch(function () { return caches.match(e.request); }));
});
