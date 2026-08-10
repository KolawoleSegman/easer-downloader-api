# Use a Debian-based Node image (slim for smaller size)
FROM node:18-slim

# Install system dependencies: Python3, pip, ffmpeg, and curl
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Deno (required by yt-dlp for JavaScript challenges)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install yt-dlp with the default extras (includes challenge solver scripts)
RUN pip3 install --break-system-packages yt-dlp[default]

# Verify yt-dlp is installed and in PATH
RUN which yt-dlp || (echo "yt-dlp not found in PATH" && exit 1)

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy all project files
COPY . .

# Create a directory for yt-dlp to store cache
RUN mkdir -p /app/.cache/yt-dlp

# Set environment variables
ENV YTDLP_CACHE_DIR=/app/.cache/yt-dlp
ENV PORT=10000

# Expose the port
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
