FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
CMD ["npm", "start"]
