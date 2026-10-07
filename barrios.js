// Grupos de barrios (aprobados por Juan 2026-07, ampliados en la auditoría 2026-07-31
// para cubrir barrios que quedaban afuera). Se comparan normalizados (sin tildes,
// minúsculas). Un barrio que NO esté en ningún grupo busca solo contra sí mismo.
window.GRUPOS = [
  // ---- Montevideo ----
  ["Punta Carretas","Pocitos","Pocitos Nuevo","Villa Biarritz","Trouville","Golf"],
  ["Carrasco","Carrasco Norte","Punta Gorda","San Rafael"],
  ["Malvin","Buceo","Parque Batlle","Villa Dolores","Puerto del Buceo"],
  ["Centro","Cordon","Parque Rodo","Barrio Sur","Palermo","Ciudad Vieja","Tres Cruces"],
  ["Prado","Atahualpa","Aguada","Reducto","Jacinto Vera","La Figurita","Bella Vista","Capurro","Arroyo Seco","Aires Puros"],
  ["La Blanqueada","Larranaga","La Comercial","Villa Munoz","Goes","Brazo Oriental"],
  ["Union","Villa Espanola","Malvin Norte","Maronas","Flor de Maronas","Jardines del Hipodromo","Jardin Hipodromo","Bella Italia","Ituzaingo","Mercado Modelo","Perez Castellanos"],
  ["La Teja","Belvedere","Nuevo Paris","Sayago","Penarol","Colon","Lavalleja","Conciliacion","Cerro","Paso de la Arena","La Paloma","Paso Molino","Paso del Molino","Pajas Blancas"],
  ["Piedras Blancas","Manga","Cerrito de la Victoria","Cerrito","Las Acacias","Casavalle","Punta de Rieles","Punta Rieles","Villa Garcia","Lezica","Melilla","Melila"],
  // ---- Canelones ----
  ["Solymar","Lagomar","El Pinar","Shangrila","Lomas de Solymar","San Jose de Carrasco","Medanos de Solymar","Colinas de Solymar","Ciudad de la Costa","Barra de Carrasco","Parque Miramar","Paso de Carrasco","Carmel"],
  ["Salinas","Marindia","Atlantida","Parque del Plata","La Floresta","Costa Azul","Bello Horizonte","San Luis","Neptunia","Pinamar","Villa Argentina","Cuchilla Alta","Jaureguiberry","Estacion Atlantida","Balneario Argentino","Santa Lucia del Este","Las Toscas","Guazu-Vira","Fortin de Santa Rosa","Santa Ana"],
  ["Las Piedras","La Paz","Progreso"],
  ["Pando","Barros Blancos","Joaquin Suarez","Toledo","Sauce","Empalme Olmos","Colonia Nicolich","San Jacinto"],
  ["Canelones","Santa Lucia","San Ramon","Los Cerrillos","Cerrillos","Tala"],
  // Countries / zona premium Ruta 101 - La Tahona (cerca de Carrasco). Colinas de Carrasco es un
  // barrio privado sobre la Ruta 101 (km 23,9, cerca de Zona América), NO de la costa (2026-10-07).
  ["La Tahona","Lomas de la Tahona","Mirador de la Tahona","Vinedos de la Tahona","Haras del Lago","Zona America","Colinas de Carrasco"],
];

// Los 19 departamentos de Uruguay. Elegir uno en "Barrio" busca en TODO ese departamento
// (pedido de Juan 2026-10-07). Hoy RE/MAX no tiene propiedades en Artigas ni Cerro Largo.
window.DEPARTAMENTOS = [
  "Artigas","Canelones","Cerro Largo","Colonia","Durazno","Flores","Florida","Lavalleja",
  "Maldonado","Montevideo","Paysandú","Río Negro","Rivera","Rocha","Salto","San José",
  "Soriano","Tacuarembó","Treinta y Tres",
];

// ZONAS: nombres que agrupan varios barrios/balnearios. A diferencia de GRUPOS (barrio suelto →
// busca también a sus linderos), una zona busca SOLO en los barrios que la componen, y solo en
// su departamento (hay 5 "Barra de Carrasco" cargadas en Montevideo que NO son Ciudad de la Costa).
// Ciudad de la Costa: Wikipedia + portales inmobiliarios (Carmel figura en el censo como parte de
// ella). Quedan afuera a propósito Paso de Carrasco (municipio propio, queda como lindero en GRUPOS)
// y Colinas de Carrasco (barrio privado de la Ruta 101, va con La Tahona en GRUPOS).
window.ZONAS = {
  "Ciudad de la Costa": { depto: "Canelones", barrios: ["Ciudad de la Costa","Solymar","Lagomar","El Pinar",
    "Shangrila","Lomas de Solymar","San Jose de Carrasco","Medanos de Solymar","Colinas de Solymar",
    "Barra de Carrasco","Parque Miramar","Parque Carrasco","El Bosque","Parque de Solymar","Montes de Solymar",
    "Carmel"] },
};
