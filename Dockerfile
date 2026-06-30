FROM ghcr.io/jim60105/yt-dlp:pot

# Copy your server files
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Expose the port your app uses
EXPOSE 10000

# Start your Node.js server
CMD ["node", "server.js"]
