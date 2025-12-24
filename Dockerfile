# syntax=docker/dockerfile:1.7

FROM node:25-alpine AS build
WORKDIR /app

ARG ICECAST_BASE_URL
ENV ICECAST_BASE_URL=${ICECAST_BASE_URL}

COPY package*.json ./
COPY tsconfig*.json ./
COPY eslint.config.js ./
COPY vite.config.ts ./
COPY index.html ./
COPY public ./public
COPY src ./src

RUN npm ci
RUN npm run build

FROM nginx:1.29.4-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
