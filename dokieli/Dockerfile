# dokieli, built from a pinned commit with its own lockfile.
#
# dokieli publishes no tags, so the pin is a commit. Move it deliberately: pick
# a newer commit, build, and record why. It is a Yarn 4 project
# (`packageManager` in its package.json, `yarn.lock`, no npm lockfile);
# `npm install` ignores the lockfile and failed to resolve its tree on
# 2026-11-04 (#5). Corepack provides the exact Yarn its package.json names,
# and `--immutable` refuses to build if the lockfile would change. Node stopped
# bundling Corepack in 25, so it is installed at a pinned version.
#
# The Node base follows the suite's minor (RealityEngine_CI .nvmrc,
# advanced by scripts/advance-node.sh).
FROM node:26.12-alpine AS build
ARG DOKIELI_COMMIT=e1de48743ace45cdbf4cc23caa902710d4a739bc
ARG COREPACK_VERSION=0.36.0
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
 && git remote add origin https://github.com/dokieli/dokieli.git \
 && git fetch -q --depth 1 origin "${DOKIELI_COMMIT}" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${DOKIELI_COMMIT}"
RUN npm install -g --no-fund --no-audit "corepack@${COREPACK_VERSION}" \
 && corepack enable \
 && yarn install --immutable \
 && yarn build \
 && rm -rf node_modules .git .yarn tests

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY --from=build /src /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=6 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
