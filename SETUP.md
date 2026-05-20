# ─────────────────────────────────────────────────────────────
# HOW TO SETUP — Step by Step
# ─────────────────────────────────────────────────────────────

## STEP 1 — Install Python libraries
pip install opencv-python mediapipe pyaudio requests numpy

## If pyaudio fails on Windows:
pip install pipwin
pipwin install pyaudio

## If pyaudio fails on Linux:
sudo apt-get install portaudio19-dev
pip install pyaudio

## If pyaudio fails on Mac:
brew install portaudio
pip install pyaudio


# ─────────────────────────────────────────────────────────────
## STEP 2 — Export your zones from browser
# ─────────────────────────────────────────────────────────────

1. Open Sleep Guardian in browser
2. Press F12 → go to Console tab
3. Type this and press Enter:
   copy(localStorage.getItem('sg_bed_zones'))
4. Open Notepad → Paste → Save as:  zones.json
5. Put zones.json in the SAME folder as ai_detector.py


# ─────────────────────────────────────────────────────────────
## STEP 3 — Get your login token
# ─────────────────────────────────────────────────────────────

1. Login to Sleep Guardian in browser
2. Press F12 → Console tab
3. Type this and press Enter:
   copy(localStorage.getItem('sg_token'))
4. Open ai_detector.py in any text editor
5. Find this line (line ~40):
   "TOKEN": "PASTE_YOUR_TOKEN_HERE",
6. Replace PASTE_YOUR_TOKEN_HERE with the copied token


# ─────────────────────────────────────────────────────────────
## STEP 4 — Run the detector
# ─────────────────────────────────────────────────────────────

## Webcam (default):
python ai_detector.py

## Laptop webcam (explicitly):
python ai_detector.py --source 0

## IP Camera (RTSP):
python ai_detector.py --source "rtsp://192.168.1.100:554/stream"

## Phone as camera (use DroidCam or IP Webcam app):
python ai_detector.py --source "http://192.168.1.xxx:8080/video"


# ─────────────────────────────────────────────────────────────
## WHAT YOU WILL SEE
# ─────────────────────────────────────────────────────────────

- A window opens showing camera feed
- Your bed zones are drawn as colored polygons
- Child names shown inside each zone
- Green skeleton = pose detected on person
- When fall/fight/shout detected:
  → Terminal shows: ✅ Alert sent → [alert type] for [child name]
  → Dashboard shows new alert instantly (Socket.io)
  → Firebase push notification fires on mobile


# ─────────────────────────────────────────────────────────────
## TUNING SENSITIVITY (in ai_detector.py CONFIG section)
# ─────────────────────────────────────────────────────────────

Too many false fall alerts?
  → Increase FALL_SPEED_THRESHOLD from 0.04 to 0.06

Too many false fight alerts?
  → Increase FIGHT_MOTION_THRESHOLD from 25.0 to 35.0

Shout detection too sensitive?
  → Increase SHOUT_THRESHOLD from 2000 to 3500

Too many repeated alerts?
  → Increase ALERT_COOLDOWN_SECONDS from 30 to 60


# ─────────────────────────────────────────────────────────────
## FOLDER STRUCTURE
# ─────────────────────────────────────────────────────────────

sleep-guardian/
├── backend/
├── frontend/
├── ai_detector.py      ← AI script (this file)
├── zones.json          ← Exported from browser
└── SETUP.md            ← This file
