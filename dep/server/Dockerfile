FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy project
COPY . .

EXPOSE 8000

# Run correct file
CMD ["node", "server/src/app.js"]