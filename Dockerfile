FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js mailer.js push.js totp.js ./
COPY views ./views
COPY public ./public
COPY database ./database

EXPOSE 8000

CMD ["node", "server.js"]
