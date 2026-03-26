FROM node:20-slim

# Install yt-dlp, ffmpeg, and pip for auto-update
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip install --break-system-packages yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
