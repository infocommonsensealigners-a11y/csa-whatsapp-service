# Sidecar WhatsApp CSA — imagen de producción (Railway).
# Receta explícita para evitar la ambigüedad de Nixpacks (que no empaquetaba src/).
FROM node:22-bookworm-slim

# Herramientas por si better-sqlite3 tuviera que compilar (si hay prebuilt, no se usan).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias primero (mejor cacheo). Incluye dev: typescript compila en el build
# y tsx queda para los scripts que se lanzan a mano (check:nosend, diag-*).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Código fuente (ver .dockerignore: NO entran .env, data/ ni un dist/ local).
COPY . .

# Compilado a JavaScript (29-10-2026, ahorro de Railway): arrancar con
# `npx tsx` tenía vivos npx + el tsx padre + esbuild (~180 MB de RAM fija,
# cobrada por minuto). `scripts/build-esm.mjs` falla el build si algún import
# no resuelve, así que un error sale aquí y no al arrancar en producción.
RUN npm run build

# Railway inyecta PORT; el server escucha en WA_HOST/PORT (variables de entorno).
# `exec` directo de node: recibe él las señales de parada (cierre limpio de Baileys).
CMD ["node", "dist/index.js"]
