FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY index.mjs ./

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "index.mjs"]
