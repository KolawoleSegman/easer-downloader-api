const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// CORS
// ============================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// CREATE COOKIES FROM ENV
// ============================================
const cookiesPath = path.join(__dirname, 'cookies.txt');

if (process.env.COOKIES_BASE64) {
    try {
        const cookieContent = Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf-8');
        fs.writeFileSync(cookiesPath, cookieContent);
        console.log('✅ Cookies file created from environment variable');
    } catch (err) {
        console.error('❌ Failed to create cookies file:', err.message);
    }
}

// ============================================
// YT-DLP PATH – simplified
// ============================================
let ytDlpPath = 'yt-dlp'; // default to system PATH

// Optionally check for a local binary (legacy)
const localPath = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localPath)) {
    ytDlpPath = localPath;
} else {
    // Fallback to common system paths
    const systemPaths = [
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        '/opt/render/project/src/yt-dlp'
    ];
    for (const p of systemPaths) {
        if (fs.existsSync(p)) {
            ytDlpPath = p;
            break;
        }
    }
}

console.log(`📌 Using yt-dlp: ${ytDlpPath}`);

// ============================================
// TEMP DIRECTORY
// ============================================
const TEMP_DIR = path.join(os.tmpdir(), 'easer-downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean old files every 30 minutes
setInterval(() => {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                console.log(`🧹 Cleaned old file: ${file}`);
            }
        });
    } catch (err) {
        console.error('Cleanup error:', err.message);
    }
}, 30 * 60 * 1000);

// ============================================
// RATE LIMITING
// ============================================
const requestTimestamps = {};
app.use((req, res, next) => {
    if (req.path === '/debug' || req.path === '/') return next();

    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const cooldown = 12000;

    if (requestTimestamps[ip] && (now - requestTimestamps[ip] < cooldown)) {
        return res.status(429).json({
            error: 'Too many requests',
            message: 'Please wait 12 seconds before trying again.'
        });
    }
    requestTimestamps[ip] = now;
    next();
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Easer Downloader API is running!',
        version: '2.6.0',
        platform: process.platform,
        cookies_exist: fs.existsSync(cookiesPath),
        yt_dlp: ytDlpPath
    });
});

// ============================================
// DEBUG ENDPOINT
// ============================================
app.get('/debug', async (req, res) => {
    const url = req.query.url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    console.log(`🐞 Debug request for: ${url}`);

    const args = [
        '--print', 'url',
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=web,mweb,android',
        url
    ];

    if (fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
    }

    try {
        const result = await new Promise((resolve, reject) => {
            execFile(ytDlpPath, args, { timeout: 45000 }, (error, stdout, stderr) => {
                if (error) return reject({ error: error.message, stderr });
                resolve({ stdout: stdout.trim(), stderr });
            });
        });

        res.json({
            success: true,
            url,
            downloadUrl: result.stdout.split('\n')[0] || null,
            cookies_exist: fs.existsSync(cookiesPath),
            yt_dlp: ytDlpPath
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.error || err.message,
            stderr: err.stderr || null,
            cookies_exist: fs.existsSync(cookiesPath)
        });
    }
});

// ============================================
// MAIN DOWNLOAD ENDPOINT
// ============================================
app.post('/api/download', async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({
            error: 'URL is required',
            message: 'Please provide a valid video URL'
        });
    }

    console.log(`📥 Starting download for: ${url}`);

    const id = uuidv4();
    const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

    const args = [
        url,
        '-o', outputTemplate,
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--concurrent-fragments', '4',
        '--retries', '10',
        '--fragment-retries', '10',
        '--no-playlist',
        '--no-warnings',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--socket-timeout', '30',
        '--extractor-args', 'youtube:player_client=web,mweb,android'
    ];

    if (fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
    }

    try {
        await new Promise((resolve, reject) => {
            const child = execFile(ytDlpPath, args, {
                maxBuffer: 50 * 1024 * 1024,
                timeout: 5 * 60 * 1000
            }, (error, stdout, stderr) => {
                if (error) {
                    console.error('yt-dlp error:', error.message);
                    console.error('stderr:', stderr);
                    return reject({ message: error.message, stderr });
                }
                resolve({ stdout, stderr });
            });

            child.stderr?.on('data', (data) => {
                const line = data.toString();
                if (line.includes('%') || line.includes('Downloading')) {
                    console.log(line.trim());
                }
            });
        });

        // Find downloaded file
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
        if (files.length === 0) {
            throw new Error('Download finished but no file was found');
        }

        const downloadedFile = path.join(TEMP_DIR, files[0]);
        const stats = fs.statSync(downloadedFile);
        const fileName = files[0].replace(id + '.', 'video.');

        console.log(`✅ Download complete: ${downloadedFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

        // Stream the file
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', stats.size);

        const stream = fs.createReadStream(downloadedFile);
        stream.pipe(res);

        stream.on('end', () => {
            fs.unlink(downloadedFile, (err) => {
                if (err) console.error('Failed to delete temp file:', err.message);
                else console.log(`🧹 Deleted temp file: ${fileName}`);
            });
        });

        stream.on('error', (err) => {
            console.error('Stream error:', err);
            fs.unlink(downloadedFile, () => {});
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream file' });
            }
        });

    } catch (err) {
        console.error('❌ Download failed:', err.message || err);

        try {
            const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
            files.forEach(f => fs.unlinkSync(path.join(TEMP_DIR, f)));
        } catch (_) {}

        return res.status(500).json({
            error: 'Failed to download media',
            details: err.message || 'Unknown error',
            stderr: err.stderr || null,
            suggestion: 'Try again later or use a different video.'
        });
    }
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
    console.error('💥 Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 Easer Downloader API running on port ${PORT}`);
    console.log(`📌 yt-dlp: ${ytDlpPath}`);
    console.log(`🍪 Cookies: ${fs.existsSync(cookiesPath) ? 'Yes' : 'No'}`);
    console.log(`📂 Temp dir: ${TEMP_DIR}`);
});
