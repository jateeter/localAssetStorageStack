FROM node:26.13-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV DATA_FILE=/data/state.json
ENV PORT=8443
EXPOSE 8443
HEALTHCHECK --interval=10s --timeout=5s --retries=6 CMD ["node", "src/healthcheck.js"]
CMD ["node", "src/server.js"]
