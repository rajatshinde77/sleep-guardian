// backend/routes/aianalysis.js
const express = require('express');
const { protect } = require('../middleware/auth');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(os.tmpdir(), 'sg-videos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `video_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExts  = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.wmv'];
    const allowedMimes = [
      'video/mp4',
      'video/avi',
      'video/x-msvideo',
      'video/x-ms-wmv',
      'video/quicktime',
      'video/x-matroska',
      'video/webm',
      'application/octet-stream'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  }
});

// ─────────────────────────────────────────────────────────────
// @POST /api/aianalysis/analyze
//
// Body (multipart/form-data):
//   video   — video file
//   childId — MongoDB child ID (optional)
// ─────────────────────────────────────────────────────────────
router.post('/analyze', protect, upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No video file uploaded' });
  }

  req.setTimeout(0);
  res.setTimeout(0);
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=300');

  const videoPath = req.file.path;
  const childId   = req.body.childId;

  console.log(`[AI] Video: ${videoPath}`);
  console.log(`[AI] childId received: "${childId}"`);
  console.log(`[AI] File size: ${Math.round(req.file.size / 1024)}KB`);

  // ── Find Python script ──
  const possibleScripts = [
    path.join(__dirname, '../../ai_video_analyzer.py'),
    path.join(__dirname, '../../../ai_video_analyzer.py'),
    path.join(process.cwd(), 'ai_video_analyzer.py'),
    path.join(process.cwd(), '../ai_video_analyzer.py'),
  ];

  let scriptPath = null;
  for (const p of possibleScripts) {
    if (fs.existsSync(p)) { scriptPath = p; break; }
  }

  if (!scriptPath) {
    cleanup();
    return res.status(500).json({ success: false, message: 'ai_video_analyzer.py not found!' });
  }

  const pythonCmds = ['py', 'python', 'python3'];
  let cmdIndex = 0;
  let finished = false;

  function tryRun() {
    if (cmdIndex >= pythonCmds.length) {
      cleanup();
      if (!finished) { finished = true; res.status(500).json({ success: false, message: 'Python not found.' }); }
      return;
    }

    const cmd  = pythonCmds[cmdIndex];
    const proc = spawn(cmd, [scriptPath, videoPath], { timeout: 300000 });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      const line = d.toString();
      stderr += line;
      process.stdout.write(`[AI-PY] ${line}`);
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') { cmdIndex++; tryRun(); }
      else {
        cleanup();
        if (!finished) { finished = true; res.status(500).json({ success: false, message: 'Python error: ' + err.message }); }
      }
    });

    proc.on('close', (code) => {
      cleanup();
      if (finished) return;
      finished = true;

      console.log(`[AI] Python exit code: ${code}`);

      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return res.status(500).json({
            success: false,
            message: 'Python returned no JSON output',
            stderr: stderr.substring(0, 300)
          });
        }

        const data = JSON.parse(jsonMatch[0]);
        console.log(`[AI] verdict=${data.verdict} confidence=${data.confidence}%`);

        // ── Send alert only when fall detected ──
        if (data.fallDetected) {
          const Alert                     = require('../models/Alert');
          const Child                     = require('../models/Child');
          const { sendWhatsAppAlert }     = require('../config/whatsapp');
          const { sendAlertNotification } = require('../config/firebase');

          const isValidChild = childId && childId !== 'none' && childId !== 'undefined' && childId !== '';
          console.log(`[AI] isValidChild: ${isValidChild} childId: "${childId}"`);

          if (isValidChild) {
            // ── Child selected — send with child details ──
            Child.findById(childId).then(child => {
              if (!child) {
                console.log(`[AI] Child not found for id: ${childId} — sending generic alert`);
                sendWhatsAppAlert('fall_detected', 'Unknown Child', 'Unknown',
                  data.confidence >= 80 ? 'critical' : 'high', 'Unknown')
                  .catch(e => console.error('[AI] WhatsApp error:', e.message));
                sendAlertNotification('fall_detected', 'Unknown Child', 'critical').catch(() => {});
                return;
              }

              // Create alert in DB
              Alert.create({
                child:      child._id,
                alertType:  'fall_detected',
                severity:   data.confidence >= 80 ? 'critical' : 'high',
                title:      `🚨 Fall Detected — AI Video Analysis`,
                message:    `${child.name} (Bed ${child.bedNumber}): Fall detected with ${data.confidence}% confidence`,
                roomNumber: child.roomNumber || 'Unknown'
              }).then(alert => {
                req.app.get('io').emit('alert:new', alert);

                // Send WhatsApp
                sendWhatsAppAlert(
                  'fall_detected',
                  child.name,
                  child.bedNumber,
                  data.confidence >= 80 ? 'critical' : 'high',
                  child.roomNumber || 'Unknown'
                ).then(r => console.log(`[AI] WhatsApp sent for ${child.name}:`, JSON.stringify(r)))
                 .catch(e => console.error('[AI] WhatsApp error:', e.message));

                // Send Firebase push
                sendAlertNotification('fall_detected', child.name, 'critical').catch(() => {});

                console.log(`[AI] Alert + WhatsApp sent for ${child.name}`);
              }).catch(e => console.error('[AI] Alert create error:', e.message));

            }).catch(e => {
              console.error('[AI] Child findById error:', e.message);
              sendWhatsAppAlert('fall_detected', 'Unknown', 'Unknown',
                data.confidence >= 80 ? 'critical' : 'high', 'Unknown').catch(() => {});
            });

          } else {
            // ── No child selected — send generic alert ──
            console.log(`[AI] No childId — sending generic WhatsApp alert`);
            sendWhatsAppAlert('fall_detected', 'Unknown Child', 'Unknown',
              data.confidence >= 80 ? 'critical' : 'high', 'Unknown')
              .then(r => console.log('[AI] Generic WhatsApp sent:', JSON.stringify(r)))
              .catch(e => console.error('[AI] WhatsApp error:', e.message));
            sendAlertNotification('fall_detected', 'Unknown Child', 'critical').catch(() => {});
          }
        }

        res.json({ success: true, data });

      } catch (e) {
        res.status(500).json({
          success: false,
          message: 'Failed to parse Python output: ' + e.message,
          raw: stdout.substring(0, 300)
        });
      }
    });
  }

  function cleanup() {
    try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch (e) {}
  }

  tryRun();
});

// ─────────────────────────────────────────────────────────────
// @GET /api/aianalysis/status
// ─────────────────────────────────────────────────────────────
router.get('/status', protect, (req, res) => {
  const possibleScripts = [
    path.join(__dirname, '../../ai_video_analyzer.py'),
    path.join(process.cwd(), 'ai_video_analyzer.py'),
    path.join(process.cwd(), '../ai_video_analyzer.py'),
  ];
  const scriptPath = possibleScripts.find(p => fs.existsSync(p)) || 'NOT FOUND';
  const proc = spawn('py', ['-c', 'import cv2; print("OK")']);
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.on('close', code => {
    res.json({ success: true, data: { pythonAvailable: code === 0, opencvAvailable: out.includes('OK'), scriptPath } });
  });
  proc.on('error', () => {
    res.json({ success: true, data: { pythonAvailable: false, scriptPath } });
  });
});

module.exports = router;
