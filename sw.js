// Service worker: deja andar la app sin conexión y sirve los datos frescos.
var CACHE = "parecidas-v56";
// Robotito de Cloudflare (fijo y público). El aviso viene "vacío"; acá le pedimos al
// robotito qué decir (así no hace falta cifrar el mensaje = mucho más simple).
var MOTOR = "https://parecidas-motor.cualcaxsiempre.workers.dev";
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

// Aviso con la app cerrada: llega "vacío" y le preguntamos al robotito qué mostrar.
self.addEventListener("push", function (e) {
  e.waitUntil((async function () {
    var titulo = "Parecidas", cuerpo = "Tenés novedades. Tocá para ver.", url = "./";
    try {
      var sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        var r = await fetch(MOTOR + "?pending=1&ep=" + encodeURIComponent(sub.endpoint));
        var d = await r.json();
        if (d && d.avisos && d.avisos.length) {
          for (var i = 0; i < d.avisos.length; i++) {
            var a = d.avisos[i];
            await self.registration.showNotification(a.titulo || titulo, {
              body: a.cuerpo || cuerpo, icon: "icon-192.png", badge: "icon-192.png",
              tag: a.tag || ("parecidas-" + i), data: { url: a.url || url }
            });
          }
          return;
        }
      }
    } catch (err) {}
    await self.registration.showNotification(titulo, {
      body: cuerpo, icon: "icon-192.png", badge: "icon-192.png", data: { url: url }
    });
  })());
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil((async function () {
    // Cerrar TODAS las notificaciones y limpiar el "1" del ícono (Android/iOS lo dejan
    // pegado si queda una notificación sin descartar). Best-effort.
    try {
      var ns = await self.registration.getNotifications();
      ns.forEach(function (n) { n.close(); });
      if (self.navigator && self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
    } catch (err) {}
    var cls = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (var i = 0; i < cls.length; i++) { if ("focus" in cls[i]) return cls[i].focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
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
