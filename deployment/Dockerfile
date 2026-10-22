FROM node:22-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY app.mjs access-key.mjs client-ip.mjs credential-server.mjs ./
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "app.mjs"]
