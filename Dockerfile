FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/followpilot.db
EXPOSE 3000
CMD ["npm", "start"]
