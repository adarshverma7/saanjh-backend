FROM node:20-alpine AS builder
WORKDIR /app

# Install build tools needed for any native addons
RUN apk add --no-cache python3 make g++

COPY package*.json ./
# Install ALL deps (including devDeps needed for nest build / tsc)
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# Production deps only — no native build tools needed here
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main"]
