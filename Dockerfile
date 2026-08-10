# Use a Debian-based Node image
FROM node:18-slim

# Install system dependencies: ffmpeg, curl, and python3 (for optional extras)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Deno (required by yt-dlp for JavaScript challenges)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Download yt-dlp binary and place it in /usr/local/bin
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Verify installation
RUN yt-dlp --version

# Set working directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Create cache directory for yt-dlp
RUN mkdir -p /app/.cache/yt-dlp

# Environment variables
ENV YTDLP_CACHE_DIR=/app/.cache/yt-dlp
ENV PORT=10000

# Expose port
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
