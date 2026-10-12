FROM node:20-alpine

WORKDIR /app

# 仅复制依赖声明，利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev

# 复制源码
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
