// Grupos de barrios (aprobados por Juan 2026-07). Se comparan normalizados (sin
// tildes, minúsculas), así "Cordón"/"Cordon"/"CORDON" matchean igual.
// Un barrio que NO esté en ningún grupo busca solo contra sí mismo.
window.GRUPOS = [
  // ---- Montevideo ----
  ["Punta Carretas","Pocitos","Pocitos Nuevo","Villa Biarritz","Trouville","Golf"],
  ["Carrasco","Carrasco Norte","Punta Gorda","San Rafael"],
  ["Malvin","Buceo","Parque Batlle","Villa Dolores"],
  ["Centro","Cordon","Parque Rodo","Barrio Sur","Palermo","Ciudad Vieja","Tres Cruces"],
  ["Prado","Atahualpa","Aguada","Reducto","Jacinto Vera","La Figurita","Bella Vista","Capurro"],
  ["La Blanqueada","Larranaga","La Comercial","Villa Munoz","Goes","Brazo Oriental"],
  ["Union","Villa Espanola","Malvin Norte","Maronas","Flor de Maronas","Jardines del Hipodromo","Bella Italia","Ituzaingo","Mercado Modelo"],
  ["La Teja","Belvedere","Nuevo Paris","Sayago","Penarol","Colon","Lavalleja","Conciliacion","Cerro","Paso de la Arena","La Paloma"],
  ["Piedras Blancas","Manga","Cerrito de la Victoria","Las Acacias","Casavalle","Punta de Rieles","Villa Garcia","Lezica","Melilla"],
  // ---- Canelones ----
  ["Solymar","Lagomar","El Pinar","Shangrila","Lomas de Solymar","San Jose de Carrasco","Medanos de Solymar","Colinas de Solymar"],
  ["Salinas","Marindia","Atlantida","Parque del Plata","La Floresta","Costa Azul","Bello Horizonte","San Luis","Neptunia","Pinamar","Villa Argentina"],
  ["Las Piedras","La Paz","Progreso"],
  ["Pando","Barros Blancos","Joaquin Suarez","Toledo","Sauce"],
  ["Canelones","Santa Lucia","San Ramon","Los Cerrillos","Tala"],
];
