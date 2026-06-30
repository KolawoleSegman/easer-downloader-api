const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// CORS CONFIGURATION
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
// CREATE COOKIES FILE FROM ENVIRONMENT VARIABLE
// ============================================
if (process.env.COOKIES_BASE64) {
    try {
        const cookieContent = Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf-8');
        fs.writeFileSync('cookies.txt', cookieContent);
        console.log('✅ Cookies file created from environment variable');
    } catch (err) {
        console.error('❌ Failed to create cookies file:', err.message);
    }
}

// ============================================
// RATE LIMITING (Prevents 429 errors)
// ============================================
const requestTimestamps = {};
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const cooldown = 30000; // 30 seconds between requests from same IP
    
    if (requestTimestamps[ip] && (now - requestTimestamps[ip] < cooldown)) {
        return res.status(429).json({
            error: 'Too many requests',
            message: 'Please wait 30 seconds before trying again.'
        });
    }
    requestTimestamps[ip] = now;
    next();
});

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Easer Downloader API is running!',
        version: '1.0.0'
    });
});

// ============================================
// MAIN DOWNLOAD ENDPOINT
// ============================================
app.post('/api/download', (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: 'URL is required',
            message: 'Please provide a valid video URL'
        });
    }

    // Determine the correct yt-dlp path
    const isWindows = process.platform === 'win32';
    let ytDlpPath;
    if (isWindows) {
        ytDlpPath = 'C:\\Users\\HP\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe';
    } else {
        ytDlpPath = path.join(__dirname, 'yt-dlp');
    }

    // ============================================
    // METHOD 1: Try Android Client (Best for YouTube)
    // ============================================
    const command1 = `${ytDlpPath} --print url --format "best[ext=mp4]/best" --cookies ./cookies.txt --extractor-args "youtube:player_client=android" ${url}`;

    // ============================================
    // METHOD 2: Try Web Client (Fallback)
    // ============================================
    const command2 = `${ytDlpPath} --print url --format "best[ext=mp4]/best" --cookies ./cookies.txt --extractor-args "youtube:player_client=web" ${url}`;

    // ============================================
    // METHOD 3: Try TV Player Variant
    // ============================================
    const command3 = `${ytDlpPath} --print url --format "best[ext=mp4]/best" --cookies ./cookies.txt --extractor-args "youtube:player_js_variant=tv" ${url}`;

    // ============================================
    // METHOD 4: Try iOS Client
    // ============================================
    const command4 = `${ytDlpPath} --print url --format "best[ext=mp4]/best" --cookies ./cookies.txt --extractor-args "youtube:player_client=ios" ${url}`;

    // ============================================
    // METHOD 5: No extractor-args (Standard)
    // ============================================
    const command5 = `${ytDlpPath} --print url --format "best[ext=mp4]/best" --cookies ./cookies.txt ${url}`;

    // ============================================
    // METHOD 6: Facebook/Other Platforms (No YouTube args)
    // ============================================
    const command6 = `${ytDlpPath} --print url --format "best[ext=mp4]/best" --cookies ./cookies.txt ${url}`;

    const methods = [command1, command2, command3, command4, command5, command6];
    let currentMethod = 0;

    console.log(`📥 Processing URL: ${url}`);

    function tryMethod() {
        if (currentMethod >= methods.length) {
            console.error('❌ All methods failed');
            return res.status(500).json({
                error: 'Failed to extract media',
                details: 'All extraction methods failed for this video. Please try a different URL or platform.',
                url: url
            });
        }

        const command = methods[currentMethod];
        console.log(`🔧 Method ${currentMethod + 1}: ${command}`);

        exec(command, (error, stdout, stderr) => {
            // Log for debugging
            console.log(`📤 Method ${currentMethod + 1} stdout:`, stdout);
            if (stderr) {
                console.log(`⚠️ Method ${currentMethod + 1} stderr:`, stderr);
            }

            if (error) {
                console.log(`⚠️ Method ${currentMethod + 1} failed, trying next...`);
                currentMethod++;
                tryMethod();
                return;
            }

            const lines = stdout.trim().split('\n');
            const downloadUrl = lines[0] || '';

            if (!downloadUrl) {
                console.log(`⚠️ Method ${currentMethod + 1} returned no URL, trying next...`);
                currentMethod++;
                tryMethod();
                return;
            }

            console.log(`✅ Success! URL found using method ${currentMethod + 1}`);
            res.json({
                success: true,
                downloadUrl: downloadUrl,
                message: 'Media ready for download',
                method: currentMethod + 1
            });
        });
    }

    // Start trying methods
    tryMethod();
});

// ============================================
// FALLBACK: Try without cookies (if cookies fail)
// ============================================
app.post('/api/download-fallback', (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: 'URL is required',
            message: 'Please provide a valid video URL'
        });
    }

    const isWindows = process.platform === 'win32';
    let ytDlpPath;
    if (isWindows) {
        ytDlpPath = 'C:\\Users\\HP\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe';
    } else {
        ytDlpPath = path.join(__dirname, 'yt-dlp');
    }

    // Try without cookies (for platforms that don't need them)
    const command = `${ytDlpPath} --print url --format "best[ext=mp4]/best" ${url}`;

    console.log(`📥 Processing URL (no cookies): ${url}`);
    console.log(`🔧 Command: ${command}`);

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error('❌ Error:', error.message);
            return res.status(500).json({
                error: 'Failed to extract media',
                details: stderr || error.message,
                url: url
            });
        }

        const lines = stdout.trim().split('\n');
        const downloadUrl = lines[0] || '';

        if (!downloadUrl) {
            return res.status(404).json({
                error: 'No media found',
                message: 'Could not extract a download URL from this link.',
                url: url
            });
        }

        console.log(`✅ Success! URL found (no cookies)`);
        res.json({
            success: true,
            downloadUrl: downloadUrl,
            message: 'Media ready for download'
        });
    });
});

// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================
app.use((err, req, res, next) => {
    console.error('💥 Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// ============================================
// START THE SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 Easer Downloader API running on port ${PORT}`);
    console.log(`🌐 Health check: https://easer-downloader-api.onrender.com/`);
    console.log(`📥 API endpoint: https://easer-downloader-api.onrender.com/api/download`);
});
