-- Tabla de la vinculación por código (una fila por usuario; `blob` está cifrado por la app).
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  blob TEXT NOT NULL,
  v INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
