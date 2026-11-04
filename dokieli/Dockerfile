FROM node:22-alpine AS build
ARG DOKIELI_REF=main
RUN apk add --no-cache git
RUN git clone --depth 1 --branch ${DOKIELI_REF} https://github.com/dokieli/dokieli.git /src
WORKDIR /src
RUN npm install && npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY --from=build /src /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
