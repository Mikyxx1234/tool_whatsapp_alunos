# syntax=docker/dockerfile:1.7

############################
# Stage 1 - builder
# Instala TODAS as deps (incluindo dev) e gera o build do frontend (Vite -> dist/).
############################
FROM node:20-alpine AS builder

WORKDIR /app

# Instala deps a partir do lockfile (cache eficiente)
COPY package.json package-lock.json ./
RUN npm ci

# Copia o restante do código e gera o build do frontend
COPY . .
RUN npm run build

# Remove dev deps para reaproveitar node_modules no runtime
RUN npm prune --omit=dev

############################
# Stage 2 - runtime
# Imagem mínima rodando apenas o backend Express, que tambem serve o dist/.
############################
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Roda como usuário não-root (já existe na imagem oficial node:alpine)
USER node

# Copia node_modules de produção, código do servidor e build do frontend
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/server ./server
COPY --chown=node:node --from=builder /app/dist ./dist
# PROD field/stage IDs (envId → getNovoCrmDealFieldIds); path: /app/data/novo-crm-prod-ids.json
COPY --chown=node:node --from=builder /app/data/novo-crm-prod-ids.json ./data/novo-crm-prod-ids.json
# Regras Pré/Pós (lista 2025/2). Sem o arquivo, marcoRegulatorio.js usa defaults.
COPY --chown=node:node --from=builder /app/data/marco-regulatorio.json ./data/marco-regulatorio.json
COPY --chown=node:node --from=builder /app/data/marco-pre-rgms.json ./data/marco-pre-rgms.json

EXPOSE 3001

CMD ["node", "server/index.js"]
