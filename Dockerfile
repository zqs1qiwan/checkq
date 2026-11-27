# ---- web build ----
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --fund=false
COPY web/ ./
# web 引用仓库根的共享纯逻辑模块，web 构建上下文内需可解析
# 新增 web → server/src 的跨包引用时，必须同步在这里补 COPY
COPY server/src/text-regex.js /server/src/text-regex.js
COPY server/src/sensitive-name.js /server/src/sensitive-name.js
COPY server/src/model.js /server/src/model.js
COPY server/src/structure.js /server/src/structure.js
COPY server/src/diagnose.js /server/src/diagnose.js
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8888)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
