const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));

// Channel list (hardcoded, can be dynamic)
const CHANNELS = [
    { id: 'chill', name: 'Chill Vibes', desc: 'Relax with calm music' },
    { id: 'emotional', name: 'Emotional Pop', desc: 'Mellow Pop Western Sunday Afternoon' },
    { id: 'nature', name: 'Nature Sounds', desc: 'Healing with the sounds of nature' },
];

// Channel list API
app.get('/channels', (req, res) => {
    res.json(CHANNELS);
});

// Radio streaming (sequential playback of mp3 files per channel)
app.get('/stream/:channel', async (req, res) => {
    const channel = req.params.channel;
    const channelDir = path.join(__dirname, 'channels', channel);
    if (!fs.existsSync(channelDir)) {
        return res.status(404).send('Channel not found');
    }
    // mp3 file list
    const files = fs.readdirSync(channelDir).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) {
        return res.status(404).send('No music found');
    }

    // Sequential playback: get current track index from query string, default 0
    let idx = parseInt(req.query.idx || '0', 10);
    if (isNaN(idx) || idx < 0 || idx >= files.length) idx = 0;
    const filePath = path.join(channelDir, files[idx]);
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (!range) {
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': stat.size,
            'X-Next-Track': `/stream/${channel}?idx=${(idx + 1) % files.length}`
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('end', () => {
            // Client should handle next track (handled in frontend)
        });
    } else {
        // HTTP Range request support (progressive streaming)
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'audio/mpeg',
            'X-Next-Track': `/stream/${channel}?idx=${(idx + 1) % files.length}`
        });
        file.pipe(res);
    }
});

app.listen(PORT, () => {
    console.log(`ASMR radio server running at http://localhost:${PORT}`);
});
