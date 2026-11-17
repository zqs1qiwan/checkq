# ---- web build ----
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --fund=false
COPY web/ ./
# web 引用仓库根的共享纯逻辑模块，web 构建上下文内需可解析
COPY server/src/text-regex.js /server/src/text-regex.js
COPY server/src/sensitive-name.js /server/src/sensitive-name.js
COPY server/src/model.js /server/src/model.js
RUN npm run build

# ---- server ----
FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production PORT=8888 DATA_DIR=/data
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --fund=false
COPY server/ ./
COPY --from=webbuild /web/dist ./public
VOLUME /data
EXPOSE 8888
CMD ["node", "src/index.js"]
