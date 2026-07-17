# Sidecar WhatsApp CSA — imagen de producción (Railway).
# Receta explícita para evitar la ambigüedad de Nixpacks (que no empaquetaba src/).
FROM node:22-bookworm-slim

# Herramientas por si better-sqlite3 tuviera que compilar (si hay prebuilt, no se usan).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias primero (mejor cacheo). Incluye dev: tsx/typescript se usan en runtime.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Código fuente (ver .dockerignore: NO entran .env ni data/).
COPY . .

# Railway inyecta PORT; el server escucha en WA_HOST/PORT (variables de entorno).
CMD ["npx", "tsx", "src/index.ts"]
