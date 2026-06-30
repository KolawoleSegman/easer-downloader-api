# Use the yt-dlp image with PO token support
FROM ghcr.io/jim60105/yt-dlp:pot

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

# Expose the port
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
