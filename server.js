const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint (useful for Render)
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Easer Downloader API is running!',
        version: '1.0.0'
    });
});

// Main download endpoint
app.post('/api/download', (req, res) => {
    const { url } = req.body;

    // Validate URL
    if (!url) {
        return res.status(400).json({ 
            error: 'URL is required',
            message: 'Please provide a valid video URL'
        });
    }

    // For Render deployment, we just use 'yt-dlp' (it will be in PATH)
    // For local Windows, you can use the full path
    const isWindows = process.platform === 'win32';
    const ytDlpCmd = isWindows 
        ? 'C:\\Users\\HP\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe'
        : 'yt-dlp';
    
    // Build the command
    const command = `${ytDlpCmd} -g -f best ${url}`;

    console.log(`📥 Processing URL: ${url}`);
    console.log(`🔧 Command: ${command}`);

    // Execute yt-dlp
    exec(command, (error, stdout, stderr) => {
        // Log everything for debugging
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

        // Extract the first URL from output
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
        console.log(`🔗 URL: ${downloadUrl.substring(0, 100)}...`);

        // Return the download URL
        res.json({ 
            success: true,
            downloadUrl: downloadUrl,
            message: 'Media ready for download'
        });
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('💥 Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message 
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Easer Downloader API running on port ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/`);
    console.log(`📥 API endpoint: http://localhost:${PORT}/api/download`);
});