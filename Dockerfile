# Playwright-Image: Chromium samt Systembibliotheken für PDF und Formular-Ausfüllen
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/index.ts"]
