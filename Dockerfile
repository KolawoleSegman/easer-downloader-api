FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl ca-certificates python3 unzip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# JS runtime that yt-dlp uses for YouTube signature solving
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && ln -sf /usr/local/bin/deno /usr/bin/deno || true

# yt-dlp is owned by the unprivileged user so `yt-dlp -U` (auto-update) works
RUN useradd -m -u 10001 app \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp && chown app:app /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=app:app . .
RUN mkdir -p /tmp/easer-downloads && chown -R app:app /app /tmp/easer-downloads

USER app
ENV PORT=10000 NODE_ENV=production

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]
