// Service worker: deja andar la app sin conexión y sirve los datos frescos.
var CACHE = "parecidas-v1";
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
  if (u.pathname.endsWith("listings.json")) {
    // Datos: red primero (frescos), y si no hay conexión, lo último guardado.
    e.respondWith(fetch(e.request).then(function (r) {
      var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, cp); });
      return r;
    }).catch(function () { return caches.match(e.request); }));
  } else if (u.origin === location.origin) {
    // App: lo guardado primero (rápido), y si no está, la red.
    e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
  }
});
