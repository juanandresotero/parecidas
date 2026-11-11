// Vincular aparatos con un código: la compu y el celu quedan con los MISMOS clientes y el mismo código de
// associate. Sin cuentas ni contraseñas:
//   · El código (20 letras/números) se crea en un aparato y se ingresa en el otro.
//   · De ese código salen DOS cosas que nunca viajan juntas: un id (lo único que ve el servidor) y la llave que
//     cifra los datos (AES-256, en el aparato). El servidor guarda texto ilegible: ni Juan ni nadie lo puede leer.
//   · Cada cliente lleva su marca de "última modificación" (`mod`); al mezclar gana el cambio más reciente de cada
//     cliente, y los borrados se avisan con una "lápida" para que el otro aparato también lo borre.
// Servidor: worker/motor.js → manejarSync (?sync=<id>, GET baja / POST sube con control de versión).
(function () {
  "use strict";
  var BUSQ = "parecidas_busquedas", ESTADO = "parecidas_sync", TOMBS = "parecidas_sync_borradas",
      ASSOC = "parecidas_associate", ASSOC_MOD = "parecidas_associate_mod";
  var ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";            // sin I, L, O, U (no se confunden al copiar)
  var IGNORAR = { mod: 1, ultimaLista: 1, vistas: 1 };            // cosas de pantalla: no cuentan como "modificó el cliente"
  var DIAS_LAPIDA = 60;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- utilitarios ----------
  function leer(k, def) { try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function guardar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function estable(o) {   // JSON con las claves ordenadas (para comparar sin que importe el orden)
    if (Array.isArray(o)) return "[" + o.map(estable).join(",") + "]";
    if (o && typeof o === "object") return "{" + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ":" + estable(o[k]); }).join(",") + "}";
    return JSON.stringify(o);
  }
  function huella(c) {   // el cliente sin lo que no cuenta; pasa por JSON para que un `undefined` no engañe
    var x = {}, limpio = JSON.parse(JSON.stringify(c));
    Object.keys(limpio).forEach(function (k) { if (!IGNORAR[k]) x[k] = limpio[k]; });
    return estable(x);
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function b64(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function deB64(t) { var s = atob(t), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function urlSync(id) { return MOTOR_URL + (MOTOR_URL.indexOf("?") >= 0 ? "&" : "?") + "sync=" + id; }

  // ---------- código ----------
  function codigoNuevo() {
    var r = crypto.getRandomValues(new Uint8Array(20)), t = "";
    for (var i = 0; i < 20; i++) t += ALFABETO.charAt(r[i] & 31);
    return t.match(/.{5}/g).join("-");
  }
  function normalizar(texto) {   // acepta minúsculas, espacios, guiones; devuelve "XXXXX-XXXXX-XXXXX-XXXXX" o null
    var t = String(texto || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
    if (t.length !== 20) return null;
    for (var i = 0; i < 20; i++) if (ALFABETO.indexOf(t.charAt(i)) < 0) return null;
    return t.match(/.{5}/g).join("-");
  }
  var DERIVADO = null;   // { codigo, id, key } en memoria
  async function derivar(codigo) {
    if (DERIVADO && DERIVADO.codigo === codigo) return DERIVADO;
    var base = await crypto.subtle.importKey("raw", utf8(codigo), "HKDF", false, ["deriveBits", "deriveKey"]);
    var salt = utf8("parecidas-sync-v1");
    var idBits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: utf8("id") }, base, 128);
    var key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt, info: utf8("clave") }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    DERIVADO = { codigo: codigo, id: hex(idBits), key: key };
    return DERIVADO;
  }
  async function cifrar(obj, key) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, utf8(JSON.stringify(obj))));
    var todo = new Uint8Array(12 + ct.length); todo.set(iv, 0); todo.set(ct, 12);
    return b64(todo);
  }
  async function descifrar(texto, key) {
    var todo = deB64(texto);
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: todo.slice(0, 12) }, key, todo.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---------- marcas de modificación y borrados (se llama desde guardarBusquedas) ----------
  // Devuelve true si hubo un cambio que valga la pena sincronizar.
  function preGuardar(arr) {
    var previos = {}, ahora = Date.now(), hubo = false;
    leer(BUSQ, []).forEach(function (c) { previos[c.id] = c; });
    var vivos = {};
    arr.forEach(function (c) {
      vivos[c.id] = 1;
      var p = previos[c.id];
      if (!p || huella(p) !== huella(c)) { c.mod = ahora; hubo = true; }
      else if (c.mod == null && p.mod != null) c.mod = p.mod;
    });
    var tombs = leer(TOMBS, {}), corte = ahora - DIAS_LAPIDA * 86400000;
    Object.keys(previos).forEach(function (id) { if (!vivos[id]) { tombs[id] = ahora; hubo = true; } });
    Object.keys(tombs).forEach(function (id) { if (tombs[id] < corte) delete tombs[id]; });
    guardar(TOMBS, tombs);
    return hubo;
  }

  // ---------- mezcla ----------
  function armarLocal() {
    var v = null;
    try { v = localStorage.getItem(ASSOC); } catch (e) {}
    return {
      clientes: leer(BUSQ, []), tombs: leer(TOMBS, {}),
      associate: v == null ? null : { valor: v, mod: Number(localStorage.getItem(ASSOC_MOD)) || 0 }
    };
  }
  function vacio() { return { clientes: [], tombs: {}, associate: null }; }
  function mezclar(a, b) {   // a = lo de este aparato, b = lo del servidor
    var ahora = Date.now(), corte = ahora - DIAS_LAPIDA * 86400000, tombs = {};
    [a.tombs || {}, b.tombs || {}].forEach(function (t) {
      Object.keys(t).forEach(function (id) { if (t[id] >= corte) tombs[id] = Math.max(tombs[id] || 0, t[id]); });
    });
    var porId = {}, orden = [];
    (a.clientes || []).concat(b.clientes || []).forEach(function (c) {
      var p = porId[c.id];
      if (!p) { porId[c.id] = c; orden.push(c.id); }
      else if ((c.mod || 0) > (p.mod || 0)) porId[c.id] = c;   // empate → se queda el de este aparato
    });
    var clientes = orden.map(function (id) { return porId[id]; })
      .filter(function (c) { return !(tombs[c.id] && tombs[c.id] >= (c.mod || 0)); });
    var as = a.associate, bs = b.associate;
    var associate = !as ? bs : (!bs ? as : (bs.mod > as.mod ? bs : as));
    return { clientes: clientes, tombs: tombs, associate: associate };
  }
  function proyectar(x) {   // para comparar dos estados sin que importe el orden ni las cosas de pantalla
    return estable({
      c: (x.clientes || []).map(function (c) { return [c.id, huella(c)]; }).sort(),
      t: x.tombs || {}, a: x.associate || null
    });
  }
  function aplicar(m) {   // escribe lo mezclado en este aparato SIN marcar cambios (no es una edición del usuario)
    guardar(BUSQ, m.clientes);
    guardar(TOMBS, m.tombs);
    if (m.associate) {
      try { localStorage.setItem(ASSOC, m.associate.valor); localStorage.setItem(ASSOC_MOD, String(m.associate.mod)); } catch (e) {}
      window.ASSOCIATE = m.associate.valor;
    }
    if (typeof renderBusquedas === "function") renderBusquedas();
    if (typeof renderBadge === "function") renderBadge();
    if (typeof sincronizarPush === "function") sincronizarPush();   // el robotito de avisos vigila lo nuevo
  }

  // ---------- sincronizar ----------
  var enCurso = null, timer = null, pendiente = false;
  var ESPERA_MS = 3000;   // un cambio se sube a los 3 s (junta varios cambios seguidos en una sola subida)
  var CADA_MS = 60000;    // con la app abierta y a la vista, cada 1 minuto revisa si otro aparato cambió algo
  function guardarEstado(cambios) {
    var st = leer(ESTADO, null); if (!st) return;
    Object.keys(cambios).forEach(function (k) { st[k] = cambios[k]; });
    guardar(ESTADO, st);
  }
  async function hacerSync() {
    var st = leer(ESTADO, null);
    if (!st) return { ok: false, error: "Este aparato no está vinculado." };
    try {
      var d = await derivar(st.codigo);
      for (var intento = 0; intento < 3; intento++) {
        var r = await fetch(urlSync(d.id));
        if (!r.ok) throw new Error("http " + r.status);
        var j = await r.json();
        var remoto;
        try { remoto = j.blob ? await descifrar(j.blob, d.key) : vacio(); }
        catch (e) { guardarEstado({ error: "No pude abrir los datos con ese código." }); return { ok: false, error: "No pude abrir los datos con ese código." }; }
        var local = armarLocal(), mezcla = mezclar(local, remoto);
        if (proyectar(mezcla) !== proyectar(local)) aplicar(mezcla);
        if (j.v !== 0 && proyectar(mezcla) === proyectar(remoto)) {   // el servidor ya está al día
          guardarEstado({ v: j.v, ultima: Date.now(), error: "" });
          pendiente = false;
          return { ok: true };
        }
        var p = await fetch(urlSync(d.id), { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blob: await cifrar(mezcla, d.key), base: j.v }) });
        if (p.status === 409) continue;                                // otro aparato subió justo antes: volver a bajar y mezclar
        if (!p.ok) throw new Error("http " + p.status);
        var pj = await p.json();
        guardarEstado({ v: pj.v, ultima: Date.now(), error: "" });
        pendiente = false;
        return { ok: true };
      }
      return { ok: false, error: "Otro aparato estaba guardando a la vez. Probá de nuevo." };
    } catch (e) {
      var msg = "No pude conectar. Tus datos siguen guardados en este aparato.";
      guardarEstado({ error: msg });
      return { ok: false, error: msg };
    }
  }
  function sincronizar() {
    if (enCurso) return enCurso;
    enCurso = hacerSync().then(function (r) { enCurso = null; pintar(); return r; }, function (e) { enCurso = null; throw e; });
    return enCurso;
  }
  function cambio() {   // algo cambió acá: subirlo en unos segundos
    if (!leer(ESTADO, null)) return;
    pendiente = true;
    clearTimeout(timer);
    timer = setTimeout(function () { sincronizar(); }, ESPERA_MS);
  }
  function cambioAssociate() {
    try { localStorage.setItem(ASSOC_MOD, String(Date.now())); } catch (e) {}
    cambio();
  }

  // ---------- vincular / crear / desvincular ----------
  function marcarVisto() { try { localStorage.setItem("parecidas_nv_sync-nv", "1"); } catch (e) {} }
  async function crear() {
    marcarVisto();
    var codigo = codigoNuevo();
    guardar(ESTADO, { codigo: codigo, v: 0, ultima: 0, error: "" });
    await derivar(codigo);
    await sincronizar();
    return codigo;
  }
  async function vincular(texto) {
    var codigo = normalizar(texto);
    if (!codigo) return { ok: false, error: "El código no es válido. Son 20 letras y números, por ejemplo K7QF3-M9TXW-2P8HD-A4RNB." };
    var anterior = leer(ESTADO, null);
    guardar(ESTADO, { codigo: codigo, v: 0, ultima: 0, error: "" });
    var r = await sincronizar();
    if (r.ok) marcarVisto();
    if (!r.ok) { if (anterior) guardar(ESTADO, anterior); else { try { localStorage.removeItem(ESTADO); } catch (e) {} } pintar(); }
    return r;
  }
  function desvincular() {
    try { localStorage.removeItem(ESTADO); localStorage.removeItem(TOMBS); } catch (e) {}
    DERIVADO = null; clearTimeout(timer); pintar();
  }
  function estado() {
    var st = leer(ESTADO, null);
    return { vinculado: !!st, codigo: st ? st.codigo : "", ultima: st ? st.ultima : 0, error: st ? st.error : "" };
  }

  // ---------- pantalla (Ajustes) ----------
  function hace(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "recién"; if (m < 60) return "hace " + m + " min";
    var h = Math.round(m / 60); return h < 24 ? "hace " + h + " h" : "hace " + Math.round(h / 24) + " días";
  }
  function msg(t) { var e = $("sync-msg"); if (e) e.textContent = t || ""; }
  function pintar() {
    if (!$("sync-sin")) return;
    var st = estado();
    $("sync-sin").style.display = st.vinculado ? "none" : "";
    var visto = false;
    try { visto = localStorage.getItem("parecidas_nv_sync-nv") === "1"; } catch (e) {}
    $("btn-sync-crear").classList.toggle("nuevo", !visto && !st.vinculado);   // dorado: la novedad está acá
    $("sync-con").style.display = st.vinculado ? "" : "none";
    if (st.vinculado) {
      $("sync-estado").textContent = st.error ? "⚠️ " + st.error
        : "✓ Vinculado" + (st.ultima ? " · sincronizado " + hace(st.ultima) : " · todavía sin sincronizar");
    } else { $("sync-codigo-vista").style.display = "none"; }
  }
  function mostrarCodigo() {
    var e = $("sync-codigo-vista"); e.textContent = estado().codigo; e.style.display = "block";
  }
  function copiar(texto) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(texto);
    var t = document.createElement("textarea"); t.value = texto; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch (e) {} document.body.removeChild(t); return Promise.resolve();
  }
  function iniciar() {
    if (!$("sync-sin")) return;
    var confirmando = false;
    $("btn-sync-crear").addEventListener("click", async function () {
      msg("Creando tu código…");
      await crear(); pintar(); mostrarCodigo();
      msg("✓ Listo. Guardá este código: lo necesitás para vincular otro aparato.");
    });
    $("btn-sync-vincular").addEventListener("click", async function () {
      msg("Vinculando…");
      var r = await vincular($("in-sync-codigo").value);
      pintar(); msg(r.ok ? "✓ Vinculado. Tus clientes ya están acá." : r.error);
    });
    $("in-sync-codigo").addEventListener("input", function () {   // mayúsculas y guion solo cada 5 (no hay que escribirlo)
      var t = this.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 20);
      this.value = (t.match(/.{1,5}/g) || []).join("-");
    });
    $("btn-sync-ver").addEventListener("click", mostrarCodigo);
    $("btn-sync-copiar-link").addEventListener("click", function () {
      var link = location.origin + location.pathname + "#vincular=" + estado().codigo;
      copiar(link).then(function () { msg("✓ Link copiado. Abrilo en el otro aparato y tocá Vincular."); });
    });
    $("btn-sync-ahora").addEventListener("click", async function () {
      msg("Sincronizando…"); var r = await sincronizar(); msg(r.ok ? "✓ Todo al día." : r.error);
    });
    $("btn-sync-fuera").addEventListener("click", function () {   // dos toques (sin ventanas del navegador)
      var b = $("btn-sync-fuera");
      if (!confirmando) {
        confirmando = true; b.textContent = "¿Seguro? Tocá otra vez para desvincular";
        setTimeout(function () { confirmando = false; b.textContent = "Desvincular este aparato"; }, 4000);
        return;
      }
      confirmando = false; b.textContent = "Desvincular este aparato";
      desvincular(); msg("Este aparato ya no está vinculado. Tus clientes siguen acá.");
    });
    $("btn-ajustes").addEventListener("click", function () { msg(""); pintar(); });
    pintar();
    // Link para vincular (#vincular=CODIGO): deja el código escrito y abre Ajustes; NO se vincula solo.
    var m = /[#&]vincular=([A-Za-z0-9-]+)/.exec(location.hash);
    if (m) {
      $("in-sync-codigo").value = m[1];
      $("ajustes").style.display = "flex";
      msg("Tocá “Vincular con este código” para terminar.");
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    }
    // Sincronizar solo: al abrir, al volver a la app y cuando vuelve internet (sin pasarse: máximo 1 vez cada 20 s).
    var ultimaVez = 0, auto = function () {
      if (!leer(ESTADO, null) || Date.now() - ultimaVez < 20000) return;
      ultimaVez = Date.now(); sincronizar();
    };
    setTimeout(auto, 1500);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) auto();
      else if (pendiente) { clearTimeout(timer); sincronizar(); }   // se va de la app con algo sin subir: subirlo ya
    });
    window.addEventListener("online", auto);
    setInterval(function () { if (!document.hidden) auto(); }, CADA_MS);
  }

  window.SYNC = { crear: crear, vincular: vincular, sincronizar: sincronizar, desvincular: desvincular, estado: estado,
                  preGuardar: preGuardar, cambio: cambio, cambioAssociate: cambioAssociate, CADA_MS: CADA_MS };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
})();
