const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));

const CHANNELS = [
  { id: 'chill', name: 'Chill Vibes', desc: 'Relax with calm music' },
  { id: 'emotional', name: 'Emotional Pop', desc: 'Mellow Pop Western Sunday Afternoon' },
  { id: 'nature', name: 'Nature Sounds', desc: 'Healing with the sounds of nature' },
];

app.get('/channels', (req, res) => {
  res.json(CHANNELS);
});

const channelState = {};
function initChannelState(channel) {
  const channelDir = path.join(__dirname, 'channels', channel);
  if (!fs.existsSync(channelDir)) return;
  const files = fs.readdirSync(channelDir).filter(f => f.endsWith('.mp3'));
  if (files.length === 0) return;
  if (!channelState[channel]) {
    channelState[channel] = {
      files,
      idx: 0,
      startTime: Date.now(),
    };
  }
}
CHANNELS.forEach(ch => initChannelState(ch.id));

setInterval(() => {
  for (const channel of Object.keys(channelState)) {
    const state = channelState[channel];
    const channelDir = path.join(__dirname, 'channels', channel);
    const files = fs.readdirSync(channelDir).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) continue;
    state.files = files;
    const filePath = path.join(channelDir, files[state.idx]);
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (!stat) continue;
    const elapsed = Date.now() - state.startTime;
    if (elapsed >= stat.size / 16000 * 1000) {
      state.idx = (state.idx + 1) % files.length;
      state.startTime = Date.now();
    }
  }
}, 1000);

function getCurrentState(channel) {
  const state = channelState[channel];
  if (!state) return null;
  const channelDir = path.join(__dirname, 'channels', channel);
  const files = state.files;
  if (!files || files.length === 0) return null;
  const filePath = path.join(channelDir, files[state.idx]);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const startByte = elapsed * 2000;
  return { filePath, stat, startByte };
}

const server = http.createServer(app);
const io = new Server(server);

const radioChannels = {};

function startRadioBroadcast(channel) {
  const channelDir = path.join(__dirname, 'channels', channel);
  if (!fs.existsSync(channelDir)) return;
  const files = fs.readdirSync(channelDir).filter(f => f.endsWith('.mp3'));
  if (files.length === 0) return;
  let idx = 0;
  let ffmpeg = null;
  let stopped = false;

  function playNext() {
    if (stopped) return;
    const filePath = path.join(channelDir, files[idx]);
    ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', filePath,
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      'pipe:1'
    ]);
    ffmpeg.stdout.on('data', chunk => {
      io.to(`radio-${channel}`).emit('audio', chunk);
    });
    ffmpeg.on('close', () => {
      if (stopped) return;
      idx = (idx + 1) % files.length;
      playNext();
    });
    ffmpeg.stderr.on('data', () => { });
  }

  playNext();

  radioChannels[channel] = {
    stop: () => {
      stopped = true;
      if (ffmpeg) ffmpeg.kill('SIGKILL');
    }
  };
}

CHANNELS.forEach(ch => startRadioBroadcast(ch.id));

io.on('connection', socket => {
  socket.on('join-channel', channel => {
    socket.join(`radio-${channel}`);
  });
  socket.on('leave-channel', channel => {
    socket.leave(`radio-${channel}`);
  });
});

server.listen(PORT, () => {
  console.log(`ASMR radio server running at http://localhost:${PORT}`);
});
