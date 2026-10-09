FROM node:24-alpine

WORKDIR /app

COPY package.json server.mjs ./

ENV NODE_ENV=production
ENV PORT=3001
ENV DATA_DIR=/data

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/health || exit 1

CMD ["node", "server.mjs"]
