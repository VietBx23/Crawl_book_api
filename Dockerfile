FROM node:20-bullseye-slim

# Cài dependencies cần thiết cho Chromium
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libx11-xcb1 \
    libxcb1 \
    libx11-6 \
    libxext6 \
    libxfixes3 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json + package-lock.json trước để cache npm install
COPY package*.json ./

# Cài dependencies và Playwright
RUN npm install --unsafe-perm && npx playwright install chromium

# Copy toàn bộ project
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
