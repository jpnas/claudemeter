FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server.js ./
COPY public/ ./public/
COPY start.sh ./

RUN chmod +x start.sh

EXPOSE 3333

CMD ["sh", "start.sh"]
