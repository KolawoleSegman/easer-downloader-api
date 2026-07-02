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
// DETERMINE YT-DLP PATH
// ============================================
let ytDlpPath;

const localPath = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localPath)) {
    ytDlpPath = localPath;
} else {
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

if (!ytDlpPath) {
    ytDlpPath = 'yt-dlp';
}

console.log(`📌 Using yt-dlp: ${ytDlpPath}`);

// ============================================
// RATE LIMITING
// ============================================
const requestTimestamps = {};
app.use((req, res, next) => {
    if (req.path === '/debug') {
        return next();
    }
    
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const cooldown = 30000;
    
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
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Easer Downloader API is running!',
        version: '1.0.0',
        platform: process.platform,
        cookies_exist: fs.existsSync('cookies.txt')
    });
});

// ============================================
// DEBUG ENDPOINT (For testing Facebook)
// ============================================
app.get('/debug', (req, res) => {
    const url = req.query.url || 'https://www.facebook.com/share/v/17tCnPyEYG/';
    
    console.log(`🐞 Debug request for: ${url}`);
    
    const cookiesExist = fs.existsSync('cookies.txt');
    
    // Test commands for Facebook
    const commands = [
        {
            name: 'Facebook with Cookies (MP4)',
            cmd: `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt ${url}`
        },
        {
            name: 'Facebook with Cookies (Best)',
            cmd: `${ytDlpPath} --print url --format "best" --cookies ./cookies.txt ${url}`
        },
        {
            name: 'Facebook without Cookies',
            cmd: `${ytDlpPath} --print url --format "best[ext=mp4]" ${url}`
        }
    ];
    
    let results = [];
    let completed = 0;
    let successUrl = null;
    
    commands.forEach((cmdInfo, index) => {
        console.log(`🔧 Testing ${cmdInfo.name}`);
        console.log(`📝 Command: ${cmdInfo.cmd}`);
        
        exec(cmdInfo.cmd, (error, stdout, stderr) => {
            const result = {
                name: cmdInfo.name,
                success: false,
                error: null,
                output: null,
                stderr: null
            };
            
            if (error) {
                result.error = error.message;
                result.stderr = stderr;
                console.log(`❌ ${cmdInfo.name} failed`);
            } else {
                const lines = stdout.trim().split('\n');
                const downloadUrl = lines[0] || '';
                if (downloadUrl) {
                    result.success = true;
                    result.output = downloadUrl;
                    if (!successUrl) successUrl = downloadUrl;
                    console.log(`✅ ${cmdInfo.name} succeeded!`);
                } else {
                    result.error = 'No URL found';
                }
            }
            
            results.push(result);
            completed++;
            
            if (completed === commands.length) {
                res.json({
                    debug: {
                        url: url,
                        yt_dlp_path: ytDlpPath,
                        cookies_exist: cookiesExist,
                        timestamp: new Date().toISOString()
                    },
                    results: results,
                    summary: {
                        total: commands.length,
                        successful: results.filter(r => r.success).length,
                        failed: results.filter(r => !r.success).length
                    },
                    download_url: successUrl || null
                });
            }
        });
    });
});

// ============================================
// MAIN DOWNLOAD ENDPOINT - FACEBOOK ONLY
// ============================================
app.post('/api/download', (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: 'URL is required',
            message: 'Please provide a valid video URL'
        });
    }

    console.log(`📥 Processing URL: ${url}`);

    // Try multiple methods for Facebook
    const commands = [
        `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt ${url}`,
        `${ytDlpPath} --print url --format "best" --cookies ./cookies.txt ${url}`,
        `${ytDlpPath} --print url --format "best[ext=mp4]" ${url}`,
        `${ytDlpPath} --print url --format "best" ${url}`
    ];

    let currentMethod = 0;

    function tryMethod() {
        if (currentMethod >= commands.length) {
            console.error('❌ All methods failed');
            return res.status(500).json({
                error: 'Failed to extract media',
                details: 'All extraction methods failed for this video.',
                url: url
            });
        }

        const command = commands[currentMethod];
        console.log(`🔧 Method ${currentMethod + 1}/${commands.length}: ${command}`);

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.log(`⚠️ Method ${currentMethod + 1} failed`);
                currentMethod++;
                tryMethod();
                return;
            }

            const lines = stdout.trim().split('\n');
            const downloadUrl = lines[0] || '';

            if (!downloadUrl) {
                console.log(`⚠️ Method ${currentMethod + 1} returned no URL`);
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

    tryMethod();
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
// START THE SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 Easer Downloader API running on port ${PORT}`);
    console.log(`🌐 Health check: https://easer-downloader-api.onrender.com/`);
    console.log(`📥 API endpoint: https://easer-downloader-api.onrender.com/api/download`);
    console.log(`🐞 Debug endpoint: https://easer-downloader-api.onrender.com/debug?url=YOUR_URL`);
    console.log(`📌 yt-dlp path: ${ytDlpPath}`);
});
