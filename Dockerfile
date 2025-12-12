# Use Node 20 to support the global 'File' API required by axios/undici
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy dependency definitions first
COPY package.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy the script
COPY torus-scraper.js .

# Run the script
CMD ["node", "torus-scraper.js"]