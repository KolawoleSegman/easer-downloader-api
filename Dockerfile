# Use the yt-dlp image with PO token support
FROM ghcr.io/jim60105/yt-dlp:pot

# Install Node.js 18.x and ffmpeg
RUN apt-get update && apt-get install -y curl ffmpeg && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy all project files
COPY . .

# Create a directory for yt-dlp to store data
RUN mkdir -p /app/.cache/yt-dlp

# Set environment variables
ENV YTDLP_CACHE_DIR=/app/.cache/yt-dlp
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server.js"]
