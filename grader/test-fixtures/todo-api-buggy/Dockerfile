FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
USER node
EXPOSE 4000
CMD ["node", "server.mjs"]
