const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// ... (CORS, cookies, etc. – unchanged) ...

// ============================================
// YT-DLP PATH – simplified
// ============================================
let ytDlpPath = 'yt-dlp'; // default to system PATH

// Optionally, check if a local binary exists (from postinstall if any)
const localPath = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localPath)) {
    ytDlpPath = localPath;
} else {
    // Also check common system paths as fallback
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

// ... rest of the code unchanged ...
