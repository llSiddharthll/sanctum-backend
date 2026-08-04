FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production
CMD ["npm", "start"]
