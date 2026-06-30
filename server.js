const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const requestTimestamps = {};
app.use((req, res, next) => {
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

app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Easer Downloader API is running!',
        version: '1.0.0'
    });
});

app.post('/api/download', (req, res) => {
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

    // Method 1: Try with tv player variant
    let command = `${ytDlpPath} --print url --format "best[ext=mp4]/best" --cookies ./cookies.txt --extractor-args "youtube:player_js_variant=tv" ${url}`;

    console.log(`📥 Processing URL: ${url}`);
    console.log(`🔧 Command: ${command}`);

    // First attempt
    exec(command, (error, stdout, stderr) => {
        console.log('📤 stdout:', stdout);
        console.log('⚠️ stderr:', stderr);

        if (error) {
            console.error('❌ Error:', error.message);
            
            // Try fallback method
            console.log('🔄 Trying fallback method...');
            const fallbackCommand = `${ytDlpPath} --print url --format "bestvideo+bestaudio/best" --cookies ./cookies.txt --extractor-args "youtube:player_client=android" ${url}`;
            
            exec(fallbackCommand, (fallbackError, fallbackStdout, fallbackStderr) => {
                if (fallbackError) {
                    console.error('❌ Fallback also failed:', fallbackError.message);
                    return res.status(500).json({
                        error: 'Failed to extract media',
                        details: `Primary: ${stderr || error.message}. Fallback: ${fallbackStderr || fallbackError.message}`,
                        url: url
                    });
                }
                
                const lines = fallbackStdout.trim().split('\n');
                const downloadUrl = lines[0] || '';
                
                if (!downloadUrl) {
                    return res.status(404).json({
                        error: 'No media found',
                        message: 'Could not extract a download URL from this link.',
                        url: url
                    });
                }
                
                console.log(`✅ Success! Download URL found (fallback)`);
                res.json({
                    success: true,
                    downloadUrl: downloadUrl,
                    message: 'Media ready for download'
                });
            });
            return;
        }

        const lines = stdout.trim().split('\n');
        const downloadUrl = lines[0] || '';

        if (!downloadUrl) {
            console.error('❌ No URL found in output');
            return res.status(404).json({
                error: 'No media found',
                message: 'Could not extract a download URL from this link.',
                url: url
            });
        }

        console.log(`✅ Success! Download URL found`);
        res.json({
            success: true,
            downloadUrl: downloadUrl,
            message: 'Media ready for download'
        });
    });
});

app.use((err, req, res, next) => {
    console.error('💥 Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Easer Downloader API running on port ${PORT}`);
});
