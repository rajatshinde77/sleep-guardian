const express = require('express');
const { protect } = require('../middleware/auth');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const router = express.Router();

// Store active ffmpeg processes
const activeStreams = {};

// HLS output directory
const HLS_DIR = path.join(os.tmpdir(), 'sleep-guardian-hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// ─────────────────────────────────────────
// @POST /api/camera/start
// Start RTSP → HLS conversion via ffmpeg
// ─────────────────────────────────────────
router.post('/start', protect, (req, res) => {
  const { cameraId, rtspUrl } = req.body;
  if (!cameraId || !rtspUrl) return res.status(400).json({ success: false, message: 'cameraId and rtspUrl required' });

  // Kill any existing stream for this camera
  if (activeStreams[cameraId]) {
    activeStreams[cameraId].kill('SIGKILL');
    delete activeStreams[cameraId];
  }

  const outDir = path.join(HLS_DIR, cameraId);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'stream.m3u8');

  // Check if ffmpeg is installed
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

  const args = [
    '-rtsp_transport', 'tcp',          // use TCP for RTSP (more reliable on Wi-Fi)
    '-i', rtspUrl,                      // input: RTSP stream
    '-c:v', 'libx264',                 // video codec
    '-preset', 'ultrafast',            // low latency
    '-tune', 'zerolatency',
    '-c:a', 'aac',                     // audio codec
    '-b:a', '64k',
    '-f', 'hls',                       // output format: HLS
    '-hls_time', '2',                  // 2 second segments
    '-hls_list_size', '5',             // keep 5 segments in playlist
    '-hls_flags', 'delete_segments+append_list',
    outFile
  ];

  try {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeStreams[cameraId] = proc;

    proc.stderr.on('data', (data) => {
      // ffmpeg logs to stderr — only log errors
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) console.error(`[Camera ${cameraId}] ${msg.trim()}`);
    });

    proc.on('close', (code) => {
      console.log(`[Camera ${cameraId}] ffmpeg exited with code ${code}`);
      delete activeStreams[cameraId];
    });

    proc.on('error', (err) => {
      console.error(`[Camera ${cameraId}] ffmpeg error:`, err.message);
      delete activeStreams[cameraId];
    });

    res.json({ success: true, message: 'Stream started', hlsPath: `/api/camera/hls/${cameraId}/stream.m3u8` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to start stream. Is ffmpeg installed?', error: err.message });
  }
});

// ─────────────────────────────────────────
// @GET /api/camera/hls/:cameraId/stream.m3u8
// Serve HLS playlist file
// ─────────────────────────────────────────
router.get('/hls/:cameraId/:file', protect, (req, res) => {
  const { cameraId, file } = req.params;
  const filePath = path.join(HLS_DIR, cameraId, file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'HLS stream not ready yet. Wait a few seconds and try again.' });
  }
  const ext = path.extname(file);
  if (ext === '.m3u8') res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  else if (ext === '.ts') res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(filePath);
});

// ─────────────────────────────────────────
// @GET /api/camera/mjpeg-proxy?url=...
// Proxy MJPEG stream (avoids browser CORS)
// ─────────────────────────────────────────
router.get('/mjpeg-proxy', protect, (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'url param required' });

  try {
    const targetUrl = new URL(url);
    const lib = targetUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      timeout: 10000,
    };
    // Pass basic auth if in URL
    if (targetUrl.username) options.auth = `${targetUrl.username}:${targetUrl.password}`;

    const proxyReq = lib.request(options, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'multipart/x-mixed-replace');
      res.setHeader('Cache-Control', 'no-cache');
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ success: false, message: 'Cannot reach camera: ' + err.message });
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ success: false, message: 'Camera connection timed out' });
    });
    proxyReq.end();

    req.on('close', () => proxyReq.destroy());
  } catch (err) {
    res.status(400).json({ success: false, message: 'Invalid camera URL: ' + err.message });
  }
});

// ─────────────────────────────────────────
// @GET /api/camera/snapshot-proxy?url=...
// Proxy single snapshot image (avoids CORS)
// ─────────────────────────────────────────
router.get('/snapshot-proxy', protect, (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'url param required' });

  try {
    const targetUrl = new URL(url);
    const lib = targetUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      timeout: 8000,
    };
    if (targetUrl.username) options.auth = `${targetUrl.username}:${targetUrl.password}`;

    const proxyReq = lib.request(options, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ success: false, message: 'Cannot reach camera: ' + err.message });
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ success: false, message: 'Camera snapshot timed out' });
    });
    proxyReq.end();
  } catch (err) {
    res.status(400).json({ success: false, message: 'Invalid camera URL: ' + err.message });
  }
});

// ─────────────────────────────────────────
// @POST /api/camera/stop
// Stop HLS conversion for a camera
// ─────────────────────────────────────────
router.post('/stop', protect, (req, res) => {
  const { cameraId } = req.body;
  if (activeStreams[cameraId]) {
    activeStreams[cameraId].kill('SIGKILL');
    delete activeStreams[cameraId];
    res.json({ success: true, message: 'Stream stopped' });
  } else {
    res.json({ success: true, message: 'No active stream for this camera' });
  }
});

// ─────────────────────────────────────────
// @GET /api/camera/status
// List active streams
// ─────────────────────────────────────────
router.get('/status', protect, (req, res) => {
  const active = Object.keys(activeStreams).map(id => ({ cameraId: id, status: 'streaming' }));
  res.json({ success: true, activeStreams: active, count: active.length });
});

// Cleanup on server shutdown
process.on('exit', () => Object.values(activeStreams).forEach(p => p.kill('SIGKILL')));
process.on('SIGINT', () => { Object.values(activeStreams).forEach(p => p.kill('SIGKILL')); process.exit(); });

module.exports = router;
