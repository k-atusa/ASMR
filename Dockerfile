FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]