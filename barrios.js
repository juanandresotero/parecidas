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
  ["Solymar","Lagomar","El Pinar","Shangrila","Lomas de Solymar","San Jose de Carrasco","Medanos de Solymar","Colinas de Solymar","Ciudad de la Costa","Barra de Carrasco","Parque Miramar","Colinas de Carrasco","Paso de Carrasco","Carmel"],
  ["Salinas","Marindia","Atlantida","Parque del Plata","La Floresta","Costa Azul","Bello Horizonte","San Luis","Neptunia","Pinamar","Villa Argentina","Cuchilla Alta","Jaureguiberry","Estacion Atlantida","Balneario Argentino","Santa Lucia del Este","Las Toscas","Guazu-Vira","Fortin de Santa Rosa","Santa Ana"],
  ["Las Piedras","La Paz","Progreso"],
  ["Pando","Barros Blancos","Joaquin Suarez","Toledo","Sauce","Empalme Olmos","Colonia Nicolich","San Jacinto"],
  ["Canelones","Santa Lucia","San Ramon","Los Cerrillos","Cerrillos","Tala"],
  // Countries / zona premium Ruta 101 - La Tahona (cerca de Carrasco)
  ["La Tahona","Lomas de la Tahona","Mirador de la Tahona","Vinedos de la Tahona","Haras del Lago","Zona America"],
];
