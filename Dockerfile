FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/phonebook.sqlite

EXPOSE 3000

CMD ["node", "server.js"]
