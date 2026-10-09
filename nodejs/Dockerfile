FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# Uma única imagem com os dois entrypoints; o comando é escolhido no deployment.
USER node
CMD ["node", "src/http.js"]
