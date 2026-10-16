# Easer Downloader API v4.0.1

Media downloader API and web UI powered by **yt-dlp** (YouTube, TikTok, Instagram, X, Vimeo, SoundCloud and 1000+ other sites).
Only download content you own or have permission to save, and respect each site's terms.

## What's new in v4

- **Security**: URLs validated (http/https only, private/loopback/metadata addresses blocked, can't be parsed as yt-dlp options); `format_id`/`sub_lang`/quality whitelisted; optional `API_KEY`; secrets and server paths scrubbed from errors; non-root Docker user; XSS-free UI.
- **Playlists → ZIP** (and media + subtitles → ZIP). Built-in zero-dependency ZIP writer.
- **Clips** (`start`/`end`), **SponsorBlock**, **embedded cover art/metadata**, more formats (mp4, webm, mkv, mp3, m4a, opus, flac, wav).
- **Real progress** (percent, speed, ETA, playlist item) with **Server-Sent Events**, job cancel/delete, **batch** jobs.
- **Queue** with a waiting line (`MAX_QUEUE`) instead of instant 503s; client disconnect kills the yt-dlp process.
- Sliding-window **rate limiting** (general + stricter for downloads); polling is exempt.
- Accurate error codes (`PRIVATE`, `AUTH_REQUIRED`, `GEO_BLOCKED`, `FORMAT_UNAVAILABLE`, `TOO_LARGE`…) with hints.
- `/api/info` caching, qualities/subtitle languages/chapters, `/api/stats`, yt-dlp auto-update + `/api/admin/update`, graceful shutdown, Range support on job files.
- Rebuilt UI: batch URLs, format picker, clip range, queue view with live progress, light/dark theme.

### v4.0.1 polish
- Tests run the yt-dlp fake via Node (no executable-bit / noexec mount issues).
- Hardened test runner (no unhandled rejections, clean process exit).
- `package-lock.json` for reproducible installs.

## Quick start

```bash
npm install
export COOKIES_BASE64=$(base64 -w0 cookies.txt)   # optional, helps with YouTube
export API_KEY=change-me                          # recommended on a public URL
npm start        # http://localhost:5000
npm test
```
Requires `yt-dlp` and `ffmpeg` on the machine (the Docker image has both).

## API

Send `X-API-Key: <key>` (or `Authorization: Bearer`, or `?key=` for browser links) when `API_KEY` is set.
All errors: `{ success:false, error, code, details?, suggestion?, requestId }`.

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/info` | `{url, playlist?, limit?}` | metadata, `available_heights`, `subtitle_langs`, `chapters`, `formats` |
| `POST /api/extract` | `{url, format?, quality?, format_id?}` | direct stream URLs + headers (no server bandwidth) |
| `POST /api/download` | see options | file stream (ZIP when several files) |
| `POST /api/thumbnail` | `{url}` | JPG |
| `POST /api/subtitles` | `{url, lang?, format?: srt\|vtt}` | subtitle file (ZIP if several) |
| `POST /api/search` | `{query, limit?, source?: youtube\|soundcloud}` | results |
| `POST /api/job/download` | download options | `202 {jobId}` |
| `POST /api/job/batch` | `{urls:[…≤10], …options}` | `202 {jobs:[…]}` |
| `GET /api/job/:id` · `/events` (SSE) · `/file` | | status · live progress · result |
| `DELETE /api/job/:id` | | cancel + delete |
| `GET /api/jobs`, `/api/stats`, `/health`, `/api` | | |
| `POST /api/admin/update` | | update yt-dlp (needs `API_KEY`) |

**Download options**: `format` (`video|mp4|webm|mkv|mp3|m4a|opus|flac|wav`), `quality` (`best|worst|720|1080p…`), `format_id`, `subtitles`, `sub_lang`, `playlist`, `limit`, `start`, `end` (seconds or `HH:MM:SS`), `sponsorblock`, `embed_thumbnail`, `embed_metadata` (default true).

```bash
curl -X POST localhost:5000/api/download -H 'X-API-Key: …' -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/…","format":"mp3","start":"0:30","end":"1:30"}' -OJ
```

## Configuration

See `.env.example`. Key variables: `API_KEY`, `COOKIES_BASE64`, `PROXY`, `CORS_ORIGIN`, `MAX_CONCURRENT`, `MAX_QUEUE`, `MAX_FILESIZE`, `RATE_LIMIT_MAX`, `HEAVY_LIMIT_MAX`, `ALLOWED_HOSTS`, `YTDLP_UPDATE_HOURS`, `DEBUG`.

## Docker / Render

```bash
docker build -t easer-downloader-api .
docker run -p 10000:10000 -e API_KEY=… -e COOKIES_BASE64=… easer-downloader-api
```
`render.yaml` is included (health check on `/health`).

## Notes

- Jobs and files are in memory/temp only; they vanish on restart or after `JOB_TTL_MS`/`FILE_TTL_MS`.
- Behind a reverse proxy, `trust proxy` is on so rate limits see real client IPs (`TRUST_PROXY=false` to disable).
- On a free Render instance, keep `MAX_CONCURRENT` low (default in `render.yaml` is 2) and `MAX_FILESIZE` modest; ffmpeg merging is CPU- and disk-heavy. Prefer `/api/extract` or `/api/job/download` over long synchronous `/api/download` streams on tiny plans.

MIT
