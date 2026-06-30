const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

    // 👇 ADDED: Use cookies to bypass YouTube bot detection
    const command = `${ytDlpPath} -g -f best --cookies ./cookies.txt ${url}`;

    console.log(`📥 Processing URL: ${url}`);
    console.log(`🔧 Command: ${command}`);

    exec(command, (error, stdout, stderr) => {
        console.log('📤 stdout:', stdout);
        console.log('⚠️ stderr:', stderr);

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
