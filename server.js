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
// YT-DLP PATH
// ============================================
let ytDlpPath;
const localPath = path.join(__dirname, 'yt-dlp');

if (fs.existsSync(localPath)) {
    ytDlpPath = localPath;
} else {
    const systemPaths = [
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        '/opt/render/project/src/yt-dlp',
        'yt-dlp'
    ];
    for (const p of systemPaths) {
        if (p === 'yt-dlp' || fs.existsSync(p)) {
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
// RATE LIMITING (12 seconds)
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
        version: '2.1.0',
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
        '--format', 'best[ext=mp4]/best',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=android,web',
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

    console.log(`📥 Starting download for
