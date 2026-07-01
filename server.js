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
// DETERMINE YT-DLP PATH - FIXED
// ============================================
let ytDlpPath;

// 1. First try the local binary (downloaded by postinstall)
const localPath = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localPath)) {
    ytDlpPath = localPath;
    console.log(`📌 Using local yt-dlp: ${ytDlpPath}`);
} 
// 2. Try common system paths (for Docker or Linux)
else {
    const systemPaths = [
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        '/opt/render/project/src/yt-dlp'
    ];
    for (const p of systemPaths) {
        if (fs.existsSync(p)) {
            ytDlpPath = p;
            console.log(`📌 Using system yt-dlp: ${ytDlpPath}`);
            break;
        }
    }
}

// 3. Fallback to 'yt-dlp' (rely on PATH)
if (!ytDlpPath) {
    ytDlpPath = 'yt-dlp';
    console.log(`📌 Using yt-dlp from PATH (fallback)`);
}

console.log(`📌 Final yt-dlp path: ${ytDlpPath}`);
console.log(`📌 File exists: ${fs.existsSync(ytDlpPath)}`);

// ============================================
// RATE LIMITING (Excludes /debug)
// ============================================
const requestTimestamps = {};
app.use((req, res, next) => {
    // Skip rate limiting for debug endpoint
    if (req.path === '/debug') {
        return next();
    }
    
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const cooldown = 30000; // 30 seconds
    
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
        version: '1.0.0',
        yt_dlp_path: ytDlpPath,
        yt_dlp_exists: fs.existsSync(ytDlpPath),
        platform: process.platform,
        cookies_exist: fs.existsSync('cookies.txt')
    });
});

// ============================================
// 🐞 DEBUG ENDPOINT (No rate limiting)
// ============================================
app.get('/debug', (req, res) => {
    const url = req.query.url || 'https://youtu.be/Mp6gFhPFUdA';
    
    console.log(`🐞 Debug request for: ${url}`);
    
    // Check if cookies exist
    const cookiesExist = fs.existsSync('cookies.txt');
    console.log(`📁 Cookies exist: ${cookiesExist}`);
    
    // Read first few lines of cookies if they exist
    let cookiePreview = null;
    if (cookiesExist) {
        try {
            const cookieContent = fs.readFileSync('cookies.txt', 'utf-8');
            const lines = cookieContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
            cookiePreview = lines.slice(0, 3).map(line => line.substring(0, 50) + '...');
        } catch (err) {
            cookiePreview = ['Error reading cookies'];
        }
    }
    
    // Build multiple test commands
    const commands = [
        {
            name: 'Android Client + MP4',
            cmd: `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt --extractor-args "youtube:player_client=android" ${url}`
        },
        {
            name: 'Web Client + MP4',
            cmd: `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt --extractor-args "youtube:player_client=web" ${url}`
        },
        {
            name: 'Android + Best Format',
            cmd: `${ytDlpPath} --print url --format "best" --cookies ./cookies.txt --extractor-args "youtube:player_client=android" ${url}`
        },
        {
            name: 'No Cookies (Fallback)',
            cmd: `${ytDlpPath} --print url --format "best[ext=mp4]" ${url}`
        },
        {
            name: 'With User-Agent',
            cmd: `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36" ${url}`
        }
    ];
    
    let results = [];
    let completed = 0;
    let hasSuccess = false;
    let successUrl = null;
    
    // Run each command
    commands.forEach((cmdInfo, index) => {
        console.log(`🔧 Testing command ${index + 1}: ${cmdInfo.name}`);
        console.log(`📝 Command: ${cmdInfo.cmd}`);
        
        exec(cmdInfo.cmd, (error, stdout, stderr) => {
            const result = {
                name: cmdInfo.name,
                command: cmdInfo.cmd,
                success: false,
                error: null,
                output: null,
                stderr: null
            };
            
            if (error) {
                result.error = error.message;
                result.stderr = stderr;
                console.log(`❌ Command ${index + 1} failed: ${error.message}`);
            } else {
                const lines = stdout.trim().split('\n');
                const downloadUrl = lines[0] || '';
                if (downloadUrl) {
                    result.success = true;
                    result.output = downloadUrl;
                    if (!hasSuccess) {
                        hasSuccess = true;
                        successUrl = downloadUrl;
                    }
                    console.log(`✅ Command ${index + 1} succeeded!`);
                } else {
                    result.error = 'No URL found in output';
                    result.output = stdout;
                    console.log(`⚠️ Command ${index + 1} returned no URL`);
                }
            }
            
            results.push(result);
            completed++;
            
            // When all commands are done, send the response
            if (completed === commands.length) {
                const response = {
                    debug: {
                        url: url,
                        yt_dlp_path: ytDlpPath,
                        yt_dlp_exists: fs.existsSync(ytDlpPath),
                        cookies_exist: cookiesExist,
                        cookie_preview: cookiePreview,
                        timestamp: new Date().toISOString()
                    },
                    results: results,
                    summary: {
                        total_commands: commands.length,
                        successful: results.filter(r => r.success).length,
                        failed: results.filter(r => !r.success).length
                    }
                };
                
                if (successUrl) {
                    response.download_url = successUrl;
                }
                
                res.json(response);
            }
        });
    });
});

// ============================================
// MAIN DOWNLOAD ENDPOINT (Rate limited)
// ============================================
app.post('/api/download', (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: 'URL is required',
            message: 'Please provide a valid video URL'
        });
    }

    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
    let commands = [];
    
    if (isYoutube) {
        commands = [
            `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt --extractor-args "youtube:player_client=android" ${url}`,
            `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt --extractor-args "youtube:player_client=web" ${url}`,
            `${ytDlpPath} --print url --format "best" --cookies ./cookies.txt --extractor-args "youtube:player_client=android" ${url}`,
            `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt ${url}`,
            `${ytDlpPath} --print url --format "best" --cookies ./cookies.txt ${url}`
        ];
    } else {
        commands = [
            `${ytDlpPath} --print url --format "best[ext=mp4]" --cookies ./cookies.txt ${url}`,
            `${ytDlpPath} --print url --format "best" --cookies ./cookies.txt ${url}`,
            `${ytDlpPath} --print url --format "best[ext=mp4]" ${url}`
        ];
    }

    let currentMethod = 0;

    console.log(`📥 Processing URL: ${url}`);
    console.log(`📌 Platform: ${isYoutube ? 'YouTube' : 'Other'}`);

    function tryMethod() {
        if (currentMethod >= commands.length) {
            console.error('❌ All methods failed');
            return res.status(500).json({
                error: 'Failed to extract media',
                details: 'All extraction methods failed for this video.',
                url: url,
                attempts: commands.length
            });
        }

        const command = commands[currentMethod];
        console.log(`🔧 Method ${currentMethod + 1}/${commands.length}: ${command}`);

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.log(`⚠️ Method ${currentMethod + 1} failed: ${error.message}`);
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
// FALLBACK ENDPOINT (No rate limiting)
// ============================================
app.post('/api/download-fallback', (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: 'URL is required'
        });
    }

    const command = `${ytDlpPath} --print url --format "best[ext=mp4]" ${url}`;
    console.log(`📥 Processing URL (no cookies): ${url}`);
    console.log(`🔧 Command: ${command}`);

    exec(command, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({
                error: 'Failed to extract media',
                details: stderr || error.message
            });
        }

        const lines = stdout.trim().split('\n');
        const downloadUrl = lines[0] || '';

        if (!downloadUrl) {
            return res.status(404).json({
                error: 'No media found'
            });
        }

        res.json({
            success: true,
            downloadUrl: downloadUrl
        });
    });
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
    console.log(`🐞 Debug endpoint: https://easer-downloader-api.onrender.com/debug?url=YOUR_VIDEO_URL`);
    console.log(`📌 yt-dlp path: ${ytDlpPath}`);
    console.log(`🖥️ Platform: ${process.platform}`);
});
