FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --ignore-scripts --no-fund
RUN npx tsc -p tsconfig.json

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package.json ./
RUN npm install --omit=dev
CMD ["node", "dist/index.js"]
