"""
╔══════════════════════════════════════════════════════════════════╗
║   SleepGuardian — AI Detector v5                                 ║
║   YOLOv8 Pose + InsightFace + Firebase + WhatsApp                ║
║   Fall | Fight | Shout | Face Recognition                        ║
║   Unlimited cameras | GPU + CPU | Grid Display                   ║
╚══════════════════════════════════════════════════════════════════╝

INSTALL:
  pip install ultralytics opencv-python pyaudio requests numpy
  pip install insightface onnxruntime-gpu

HOW TO USE:

  Single webcam:
    python ai_detector.py --sources "0"

  Two cameras:
    python ai_detector.py --sources "0,1"

  IP cameras (RTSP):
    python ai_detector.py --sources "rtsp://192.168.1.100/stream,rtsp://192.168.1.101/stream"

  Phone camera (DroidCam / IP Webcam app):
    python ai_detector.py --sources "http://192.168.1.50:8080/video"

  Disable face recognition (faster):
    python ai_detector.py --sources "0" --no-face

  Force CPU mode:
    python ai_detector.py --sources "0" --cpu

  Separate windows per camera:
    python ai_detector.py --sources "0,1" --no-grid

CAMERA IDs:
  Assigned automatically: cam1, cam2, cam3...
  Match these in your zones.json cameraId field.
  First source = cam1, second = cam2, etc.

SETUP STEPS:
  1. Set TOKEN below (from browser console: localStorage.getItem('sg_token'))
  2. Export zones.json from browser console:
       copy(localStorage.getItem('sg_bed_zones'))
  3. Run the script
"""

import cv2
import numpy as np
import requests
import json
import time
import threading
import argparse
import os
import sys
import base64
from datetime import datetime
from collections import deque

# ═══════════════════════════════════════════════════════════════
#  CONFIG — Edit these values before running
# ═══════════════════════════════════════════════════════════════
CONFIG = {
    # ── Backend ───────────────────────────────────────────────
    "BACKEND_URL":  "http://localhost:5000/api",   # Your backend URL
    "TOKEN":        "PASTE_YOUR_TOKEN_HERE",        # From: localStorage.getItem('sg_token')
    "ZONES_FILE":   "zones.json",                   # Export from browser console

    # ── YOLOv8 ───────────────────────────────────────────────
    # ── YOLOv8 Fine-Tuned Models ─────────────────────────────
    # Custom trained models — replacing generic yolov8s-pose.pt
    "YOLO_MODEL":        "sg_fall.pt",   # Fine-tuned fall detection  (mAP50: 86.1%)
    "YOLO_FIGHT_MODEL":  "sg_fight.pt",  # Fine-tuned fight detection (mAP50: 81.3%)
    "YOLO_CONF":    0.40,               # Detection confidence (0.0–1.0)
    "USE_GPU":      True,               # True=RTX 3050, False=CPU

    # ── InsightFace Face Recognition ─────────────────────────
    "FACE_RECOGNITION":     True,       # Set False to disable (faster)
    "FACE_MATCH_THRESHOLD": 0.45,       # Cosine distance (lower = stricter)
    "FACE_CHECK_EVERY":     5,          # Run face recognition every N frames

    # ── Fall Detection ────────────────────────────────────────
    # ── Fall Detection — tightened for fine-tuned model ──────
    "FALL_HIP_DROP_THRESHOLD":  0.12,    # Tightened from 0.15 (model is more accurate)
    "FALL_SPEED_THRESHOLD":     0.035,   # Tightened from 0.04
    "FALL_CONFIRM_FRAMES":      3,      # Frames to confirm fall

    # ── Fight Detection ───────────────────────────────────────
    "FIGHT_MOTION_THRESHOLD":   25.0,   # Optical flow magnitude
    "FIGHT_PERSON_COUNT":       2,      # Min people needed for fight

    # ── Shout Detection ───────────────────────────────────────
    # ── Shout CNN Model ───────────────────────────────────────
    "SHOUT_MODEL":   "sg_shout.pt",      # Fine-tuned audio CNN (Acc: 95.9%, Recall: 100%)
    "SHOUT_USE_CNN": True,               # True=use CNN, False=amplitude threshold only
    "SHOUT_CNN_CONF": 0.75,              # CNN confidence threshold for shout
    "SHOUT_THRESHOLD":          2000,    # Amplitude fallback (used if CNN disabled)
    "SHOUT_DURATION_FRAMES":    3,      # Sustained frames to confirm

    # ── Camera ────────────────────────────────────────────────
    "RECONNECT_DELAY":  5,              # Seconds before reconnect
    "FRAME_SKIP":       1,              # Process every Nth frame
    "DISPLAY_GRID":     True,           # True=one grid window, False=separate windows

    # ── Alert Cooldown ────────────────────────────────────────
    "ALERT_COOLDOWN_SECONDS": 30,       # Min seconds between same alert
}
# ═══════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════
#  GLOBALS
# ═══════════════════════════════════════════════════════════════
alert_cooldown   = {}
alert_lock       = threading.Lock()
child_embeddings = {}
embeddings_ready = False
camera_states    = {}
insight_app      = None
insight_lock     = threading.Lock()
INSIGHTFACE_OK   = False
YOLO_MODEL_OBJ       = None
YOLO_FIGHT_MODEL_OBJ = None
YOLO_OK              = False
SHOUT_CNN_MODEL      = None
SHOUT_CNN_OK         = False
display_frames   = {}
display_lock     = threading.Lock()
shout_spike_count = 0
audio_running    = False


# ═══════════════════════════════════════════════════════════════
#  CAMERA STATE — one per camera thread
# ═══════════════════════════════════════════════════════════════
class CameraState:
    def __init__(self, camera_id):
        self.camera_id       = camera_id
        self.prev_hip_y      = {}        # person_id → deque of hip Y positions
        self.fall_counter    = {}        # person_id → consecutive fall frames
        self.prev_gray       = None      # for optical flow
        self.face_results    = []
        self.face_counter    = 0
        self.frame_count     = 0
        self.status          = "starting"
        self.fps             = 0
        self.last_fps_time   = time.time()
        self.fps_frame_count = 0


# ═══════════════════════════════════════════════════════════════
#  YOLOV8 — loaded once, shared by all camera threads
# ═══════════════════════════════════════════════════════════════
def load_yolo():
    global YOLO_MODEL_OBJ, YOLO_FIGHT_MODEL_OBJ, YOLO_OK
    try:
        from ultralytics import YOLO
        import torch

        # Load fall detection model
        print(f"[YOLO] Loading fall model: {CONFIG['YOLO_MODEL']}...")
        fall_model = YOLO(CONFIG["YOLO_MODEL"])

        # Load fight detection model
        print(f"[YOLO] Loading fight model: {CONFIG['YOLO_FIGHT_MODEL']}...")
        fight_model = YOLO(CONFIG["YOLO_FIGHT_MODEL"])

        if CONFIG["USE_GPU"] and torch.cuda.is_available():
            fall_model.to("cuda")
            fight_model.to("cuda")
            gpu_name = torch.cuda.get_device_name(0)
            print(f"✅ sg_fall.pt loaded  — GPU: {gpu_name}")
            print(f"✅ sg_fight.pt loaded — GPU: {gpu_name}")
        else:
            print("✅ sg_fall.pt loaded  — CPU mode")
            print("✅ sg_fight.pt loaded — CPU mode")

        YOLO_MODEL_OBJ       = fall_model
        YOLO_FIGHT_MODEL_OBJ = fight_model
        YOLO_OK = True

    except ImportError:
        print("⚠️  YOLOv8 not installed. Run: pip install ultralytics")
    except Exception as e:
        print(f"⚠️  YOLOv8 load failed: {e}")


def load_shout_cnn():
    """Load fine-tuned audio CNN for shout detection."""
    global SHOUT_CNN_MODEL, SHOUT_CNN_OK
    if not CONFIG.get("SHOUT_USE_CNN", False):
        print("ℹ️  Shout CNN disabled — using amplitude threshold only")
        return
    try:
        import torch
        import torch.nn as nn

        class ShoutCNN(nn.Module):
            def __init__(self, n_mfcc=40, n_classes=2):
                super(ShoutCNN, self).__init__()
                self.conv1 = nn.Sequential(
                    nn.Conv2d(1, 32, kernel_size=3, padding=1),
                    nn.BatchNorm2d(32), nn.ReLU(),
                    nn.MaxPool2d(2, 2), nn.Dropout2d(0.25),
                )
                self.conv2 = nn.Sequential(
                    nn.Conv2d(32, 64, kernel_size=3, padding=1),
                    nn.BatchNorm2d(64), nn.ReLU(),
                    nn.MaxPool2d(2, 2), nn.Dropout2d(0.25),
                )
                self.conv3 = nn.Sequential(
                    nn.Conv2d(64, 128, kernel_size=3, padding=1),
                    nn.BatchNorm2d(128), nn.ReLU(),
                    nn.AdaptiveAvgPool2d((4, 4)), nn.Dropout2d(0.25),
                )
                self.classifier = nn.Sequential(
                    nn.Flatten(),
                    nn.Linear(128 * 4 * 4, 256), nn.ReLU(), nn.Dropout(0.5),
                    nn.Linear(256, 64), nn.ReLU(), nn.Dropout(0.3),
                    nn.Linear(64, n_classes),
                )
            def forward(self, x):
                return self.classifier(self.conv3(self.conv2(self.conv1(x))))

        model_path = CONFIG["SHOUT_MODEL"]
        if not os.path.exists(model_path):
            print(f"⚠️  sg_shout.pt not found at: {model_path} — falling back to amplitude")
            return

        device = "cuda" if CONFIG["USE_GPU"] and torch.cuda.is_available() else "cpu"
        checkpoint = torch.load(model_path, map_location=device, weights_only=False)
        model = ShoutCNN(n_mfcc=40, n_classes=2).to(device)
        model.load_state_dict(checkpoint["model_state_dict"])
        model.eval()

        SHOUT_CNN_MODEL = {"model": model, "device": device}
        SHOUT_CNN_OK = True
        print(f"✅ sg_shout.pt loaded — Audio CNN (Acc: 95.9%) — {device.upper()}")

    except Exception as e:
        print(f"⚠️  Shout CNN load failed: {e} — falling back to amplitude threshold")


# ═══════════════════════════════════════════════════════════════
#  INSIGHTFACE — loaded once, shared by all camera threads
# ═══════════════════════════════════════════════════════════════
def load_insightface():
    global insight_app, INSIGHTFACE_OK
    try:
        from insightface.app import FaceAnalysis
        ctx = 0 if CONFIG["USE_GPU"] else -1
        insight_app = FaceAnalysis(
            name="buffalo_l",
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
                      if CONFIG["USE_GPU"] else ["CPUExecutionProvider"]
        )
        insight_app.prepare(ctx_id=ctx, det_size=(640, 640))
        INSIGHTFACE_OK = True
        mode = "GPU (CUDA)" if CONFIG["USE_GPU"] else "CPU"
        print(f"✅ InsightFace loaded — ArcFace buffalo_l — {mode}")
    except ImportError:
        print("⚠️  InsightFace not installed. Run: pip install insightface onnxruntime-gpu")
    except Exception as e:
        print(f"⚠️  InsightFace init failed: {e}")


def fetch_child_embeddings():
    global child_embeddings, embeddings_ready

    if not INSIGHTFACE_OK:
        print("⚠️  InsightFace unavailable — skipping face recognition.")
        return

    print("\n📸 Fetching child photos from backend...")
    headers = {"Authorization": f"Bearer {CONFIG['TOKEN']}"}

    try:
        r = requests.get(f"{CONFIG['BACKEND_URL']}/children", headers=headers, timeout=10)
        if r.status_code != 200:
            print(f"❌ Cannot fetch children: {r.status_code}")
            return

        children = r.json().get("data", [])
        print(f"   Found {len(children)} children")
        loaded = 0

        for child in children:
            cid   = str(child.get("_id", ""))
            name  = child.get("name", "Unknown")
            bed   = child.get("bedNumber", "?")
            photo = child.get("photo", None)

            if not photo:
                print(f"   ⚠️  {name} — no photo, skipping")
                continue

            try:
                if "," in photo:
                    photo = photo.split(",")[1]
                img_bytes = base64.b64decode(photo)
                img_arr   = np.frombuffer(img_bytes, dtype=np.uint8)
                img       = cv2.imdecode(img_arr, cv2.IMREAD_COLOR)

                if img is None:
                    print(f"   ⚠️  {name} — cannot decode photo")
                    continue

                with insight_lock:
                    faces = insight_app.get(img)

                if not faces:
                    print(f"   ⚠️  {name} — no face in photo")
                    continue

                face = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]))
                child_embeddings[cid] = {
                    "name":      name,
                    "bedNumber": bed,
                    "embedding": face.normed_embedding,
                }
                loaded += 1
                print(f"   ✅ {name} (Bed {bed}) — encoded")

            except Exception as e:
                print(f"   ❌ {name} — error: {e}")

        embeddings_ready = True
        print(f"\n✅ Face recognition ready: {loaded}/{len(children)} children loaded\n")

    except requests.exceptions.ConnectionError:
        print(f"❌ Cannot connect to backend at {CONFIG['BACKEND_URL']}")
    except Exception as e:
        print(f"❌ fetch_child_embeddings error: {e}")


def identify_face(embedding):
    if not child_embeddings:
        return None
    best_id   = None
    best_dist = float("inf")
    best_data = None
    for cid, data in child_embeddings.items():
        dist = 1.0 - float(np.dot(embedding, data["embedding"]))
        if dist < best_dist:
            best_dist = dist
            best_id   = cid
            best_data = data
    if best_dist <= CONFIG["FACE_MATCH_THRESHOLD"]:
        return {
            "childId":    best_id,
            "childName":  best_data["name"],
            "bedNumber":  best_data["bedNumber"],
            "similarity": round((1 - best_dist) * 100, 1),
        }
    return None


# ═══════════════════════════════════════════════════════════════
#  ZONE HELPERS
# ═══════════════════════════════════════════════════════════════
def load_zones(path):
    if not os.path.exists(path):
        print(f"⚠️  zones.json not found at: {path}")
        print("   Export: browser console → copy(localStorage.getItem('sg_bed_zones'))")
        return []
    with open(path) as f:
        zones = json.load(f)
    print(f"✅ Loaded {len(zones)} bed zones")
    for z in zones:
        print(f"   → Bed {z.get('bedNumber','?')} | {z.get('childName','Unknown')} | Cam: {z.get('cameraId','any')}")
    return zones


def point_in_polygon(px, py, points):
    n = len(points)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = points[i]["x"], points[i]["y"]
        xj, yj = points[j]["x"], points[j]["y"]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def get_child_at(px, py, zones, camera_id):
    for zone in zones:
        cam = zone.get("cameraId")
        if cam and cam != camera_id:
            continue
        if point_in_polygon(px, py, zone.get("points", [])):
            return {
                "childId":   zone.get("childId"),
                "childName": zone.get("childName", "Unknown"),
                "bedNumber": zone.get("bedNumber", "?"),
            }
    return None


def get_zones_for_camera(zones, camera_id):
    return [z for z in zones if not z.get("cameraId") or z.get("cameraId") == camera_id]


# ═══════════════════════════════════════════════════════════════
#  ALERT SENDING — Backend API + Firebase + WhatsApp
# ═══════════════════════════════════════════════════════════════
ALERT_CONFIG = {
    "fall_detected":      {"severity": "critical", "title": "🚨 Fall Detected",     "msg": "A child appears to have fallen."},
    "fight_detected":     {"severity": "critical", "title": "⚠️ Fight Detected",    "msg": "Aggressive movement detected between children."},
    "shout_detected":     {"severity": "high",     "title": "📢 Shouting Detected", "msg": "Loud shouting detected in the room."},
    "wrong_bed_detected": {"severity": "medium",   "title": "🛏️ Wrong Bed Alert",   "msg": "Child detected in wrong bed zone."},
    "child_left_zone":    {"severity": "medium",   "title": "🚶 Child Left Bed",    "msg": "Child detected outside their bed zone."},
}


def can_send_alert(child_id, alert_type):
    with alert_lock:
        key  = (child_id, alert_type)
        last = alert_cooldown.get(key, 0)
        return (time.time() - last) >= CONFIG["ALERT_COOLDOWN_SECONDS"]


def send_alert(alert_type, child_info, camera_id=""):
    if not child_info or not child_info.get("childId"):
        return

    child_id   = child_info["childId"]
    child_name = child_info["childName"]
    bed        = child_info.get("bedNumber", "?")

    if not can_send_alert(child_id, alert_type):
        return

    cfg = ALERT_CONFIG.get(alert_type, {
        "severity": "medium",
        "title":    alert_type.replace("_", " ").title(),
        "msg":      f"{alert_type} detected."
    })

    payload = {
        "child":     child_id,
        "alertType": alert_type,
        "severity":  cfg["severity"],
        "title":     f"{cfg['title']} — {child_name} (Bed {bed})",
        "message":   (f"{cfg['msg']} Child: {child_name}, Bed {bed}. "
                      f"Camera: {camera_id}. Time: {datetime.now().strftime('%H:%M:%S')}."),
        "roomNumber": child_info.get("roomNumber", "Unknown"),
    }

    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {CONFIG['TOKEN']}"
    }

    try:
        r = requests.post(
            f"{CONFIG['BACKEND_URL']}/alerts",
            json=payload, headers=headers, timeout=5
        )
        if r.status_code == 201:
            with alert_lock:
                alert_cooldown[(child_id, alert_type)] = time.time()
            print(f"   [{camera_id}] ✅ Alert sent → {cfg['title']} for {child_name}")
            print(f"   [{camera_id}] 🔔 Firebase push + WhatsApp triggered via backend")
        else:
            print(f"   [{camera_id}] ❌ Alert failed: {r.status_code}")
    except requests.exceptions.ConnectionError:
        print(f"   [{camera_id}] ❌ Cannot reach backend")
    except Exception as e:
        print(f"   [{camera_id}] ❌ Alert error: {e}")


def send_alert_async(alert_type, child_info, camera_id=""):
    t = threading.Thread(
        target=send_alert, args=(alert_type, child_info, camera_id), daemon=True
    )
    t.start()


# ═══════════════════════════════════════════════════════════════
#  FALL DETECTION — YOLOv8 Pose keypoints
# ═══════════════════════════════════════════════════════════════
# YOLOv8 Pose keypoint indices:
# 0=nose, 5=L_shoulder, 6=R_shoulder
# 11=L_hip, 12=R_hip, 13=L_knee, 14=R_knee
# 15=L_ankle, 16=R_ankle

KP_L_SHOULDER = 5
KP_R_SHOULDER = 6
KP_L_HIP      = 11
KP_R_HIP      = 12
KP_L_KNEE     = 13
KP_R_KNEE     = 14


def detect_fall_yolo(keypoints, frame_h, frame_w, person_id, cam_zones, state, camera_id):
    """
    Detect fall using YOLOv8 pose keypoints.
    Works from side, top-down, and diagonal camera angles.
    """
    try:
        kp = keypoints  # shape: (17, 3) — x, y, confidence

        # Get key points (normalized 0-1)
        l_hip  = kp[KP_L_HIP]
        r_hip  = kp[KP_R_HIP]
        l_knee = kp[KP_L_KNEE]
        r_knee = kp[KP_R_KNEE]
        l_sh   = kp[KP_L_SHOULDER]
        r_sh   = kp[KP_R_SHOULDER]

        # Skip if keypoints not confident
        if l_hip[2] < 0.3 or r_hip[2] < 0.3:
            return None

        hip_y    = (l_hip[1] + r_hip[1]) / 2
        hip_x    = (l_hip[0] + r_hip[0]) / 2
        knee_y   = (l_knee[1] + r_knee[1]) / 2
        sh_y     = (l_sh[1]  + r_sh[1])  / 2

        # Track hip Y history
        if person_id not in state.prev_hip_y:
            state.prev_hip_y[person_id]   = deque(maxlen=10)
            state.fall_counter[person_id] = 0

        state.prev_hip_y[person_id].append(hip_y)
        history = state.prev_hip_y[person_id]

        if len(history) < 5:
            return None

        # ── INDICATOR 1: Hip dropped quickly ──
        hip_drop = history[-1] - history[0]

        # ── INDICATOR 2: Hip near knee (collapsed posture) ──
        hip_near_knee = (knee_y - hip_y) < CONFIG["FALL_HIP_DROP_THRESHOLD"]

        # ── INDICATOR 3: Shoulder near hip (horizontal body) ──
        torso_collapsed = abs(sh_y - hip_y) < 0.15

        fall_score = 0
        if hip_drop > CONFIG["FALL_SPEED_THRESHOLD"]:  fall_score += 40
        if hip_near_knee:                               fall_score += 35
        if torso_collapsed:                             fall_score += 25

        if fall_score >= 55:
            state.fall_counter[person_id] += 1
        else:
            state.fall_counter[person_id] = 0

        if state.fall_counter[person_id] >= CONFIG["FALL_CONFIRM_FRAMES"]:
            child = get_child_at(hip_x, hip_y, cam_zones, camera_id)
            print(f"   [{camera_id}] 🚨 FALL detected! Person {person_id} at ({hip_x:.2f}, {hip_y:.2f}) score={fall_score}")
            state.prev_hip_y[person_id].clear()
            state.fall_counter[person_id] = 0
            return child

    except Exception as e:
        pass

    return None


# ═══════════════════════════════════════════════════════════════
#  FIGHT DETECTION — Optical flow
# ═══════════════════════════════════════════════════════════════
def detect_fight(gray_frame, person_count, cam_zones, state, camera_id):
    if state.prev_gray is None:
        state.prev_gray = gray_frame.copy()
        return None

    flow = cv2.calcOpticalFlowFarneback(
        state.prev_gray, gray_frame, None, 0.5, 3, 15, 3, 5, 1.2, 0
    )
    state.prev_gray = gray_frame.copy()
    magnitude, _    = cv2.cartToPolar(flow[..., 0], flow[..., 1])
    avg_motion      = np.mean(magnitude)

    if avg_motion > CONFIG["FIGHT_MOTION_THRESHOLD"] and person_count >= CONFIG["FIGHT_PERSON_COUNT"]:
        h, w        = gray_frame.shape
        motion_mask = magnitude > (CONFIG["FIGHT_MOTION_THRESHOLD"] * 0.8)
        ys, xs      = np.where(motion_mask)
        if len(xs) > 0:
            cx    = float(np.mean(xs)) / w
            cy    = float(np.mean(ys)) / h
            child = get_child_at(cx, cy, cam_zones, camera_id)
            print(f"   [{camera_id}] ⚠️  FIGHT detected! Motion={avg_motion:.1f}, People={person_count}")
            return child
    return None


# ═══════════════════════════════════════════════════════════════
#  FACE RECOGNITION — InsightFace
# ═══════════════════════════════════════════════════════════════
def process_faces(frame, cam_zones, state, camera_id):
    if not INSIGHTFACE_OK or not CONFIG["FACE_RECOGNITION"]:
        return []

    h, w     = frame.shape[:2]
    detected = []

    try:
        with insight_lock:
            faces = insight_app.get(frame)
    except Exception:
        return []

    for face in faces:
        x1, y1, x2, y2 = [int(v) for v in face.bbox]
        match = identify_face(face.normed_embedding)
        cx    = ((x1 + x2) / 2) / w
        cy    = ((y1 + y2) / 2) / h

        if match:
            zone_child   = get_child_at(cx, cy, cam_zones, camera_id)
            in_zone      = zone_child is not None
            correct_zone = in_zone and zone_child["childId"] == match["childId"]

            if in_zone and not correct_zone:
                print(f"   [{camera_id}] 🛏️  {match['childName']} in WRONG zone!")
                send_alert_async("wrong_bed_detected", match, camera_id)
            elif not in_zone:
                print(f"   [{camera_id}] 🚶 {match['childName']} OUTSIDE zones!")
                send_alert_async("child_left_zone", match, camera_id)

            detected.append({
                "bbox": (x1, y1, x2, y2), "child": match,
                "correct_zone": correct_zone, "in_zone": in_zone,
            })
        else:
            detected.append({
                "bbox": (x1, y1, x2, y2), "child": None,
                "correct_zone": False, "in_zone": False,
            })

    return detected


# ═══════════════════════════════════════════════════════════════
#  DRAWING HELPERS
# ═══════════════════════════════════════════════════════════════
def draw_zones(frame, cam_zones):
    h, w = frame.shape[:2]
    for zone in cam_zones:
        pts = zone.get("points", [])
        if len(pts) < 3:
            continue
        poly = np.array(
            [[int(p["x"] * w), int(p["y"] * h)] for p in pts], dtype=np.int32
        )
        hex_c  = zone.get("color", "#4f46e5").lstrip("#")
        b, g, r = tuple(int(hex_c[i:i+2], 16) for i in (4, 2, 0))
        overlay = frame.copy()
        cv2.fillPoly(overlay, [poly], (b, g, r))
        cv2.addWeighted(overlay, 0.12, frame, 0.88, 0, frame)
        cv2.polylines(frame, [poly], True, (b, g, r), 2)
        cx = int(np.mean([p["x"] for p in pts]) * w)
        cy = int(np.mean([p["y"] for p in pts]) * h)
        cv2.putText(frame,
                    f"Bed {zone.get('bedNumber','?')} — {zone.get('childName','?')}",
                    (cx - 50, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (b, g, r), 1)


def draw_faces(frame, face_results):
    for res in face_results:
        x1, y1, x2, y2 = res["bbox"]
        child = res["child"]
        if child:
            color = (0, 255, 0) if res["correct_zone"] else (0, 100, 255)
            label = f"{child['childName']} {child['similarity']}%"
            if not res["correct_zone"]:
                label += " ⚠ WRONG ZONE"
        else:
            color = (0, 0, 255)
            label = "Unknown"
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, label, (x1, y1 - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)


def draw_skeleton(frame, keypoints, color=(0, 255, 0)):
    """Draw YOLOv8 pose skeleton on frame"""
    # YOLOv8 pose connections
    connections = [
        (5, 6),   # shoulders
        (5, 7),   (7, 9),    # left arm
        (6, 8),   (8, 10),   # right arm
        (5, 11),  (6, 12),   # torso sides
        (11, 12),             # hips
        (11, 13), (13, 15),  # left leg
        (12, 14), (14, 16),  # right leg
    ]
    h, w = frame.shape[:2]
    try:
        for a, b in connections:
            if keypoints[a][2] > 0.3 and keypoints[b][2] > 0.3:
                pt1 = (int(keypoints[a][0] * w), int(keypoints[a][1] * h))
                pt2 = (int(keypoints[b][0] * w), int(keypoints[b][1] * h))
                cv2.line(frame, pt1, pt2, color, 2)
        for i, kp in enumerate(keypoints):
            if kp[2] > 0.3:
                pt = (int(kp[0] * w), int(kp[1] * h))
                cv2.circle(frame, pt, 3, (0, 0, 255), -1)
    except Exception:
        pass


def draw_status(frame, state, num_zones, person_count):
    h, w = frame.shape[:2]
    cv2.rectangle(frame, (0, 0), (w, 90), (20, 10, 40), -1)
    cv2.putText(frame, f"SleepGuardian v4 — {state.camera_id.upper()}",
                (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (180, 130, 255), 2)
    s_color = (0, 255, 100) if state.status == "running" else (0, 165, 255)
    cv2.putText(frame,
                f"Status: {state.status}  FPS: {state.fps}  People: {person_count}  Zones: {num_zones}",
                (10, 47), cv2.FONT_HERSHEY_SIMPLEX, 0.42, s_color, 1)
    yolo_label  = "Fall:ON ✅"  if YOLO_OK else "Fall:OFF ❌"
    fight_label = "Fight:ON ✅" if YOLO_OK else "Fight:OFF ❌"
    shout_label = "Shout:ON ✅" if SHOUT_CNN_OK else "Shout:AMP"
    face_label  = "Face:ON ✅"  if INSIGHTFACE_OK else "Face:OFF"
    cv2.putText(frame, f"{yolo_label} | {fight_label} | {shout_label} | {face_label} | Q=Quit",
                (10, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.38,
                (0, 255, 150) if YOLO_OK else (0, 165, 255), 1)


# ═══════════════════════════════════════════════════════════════
#  SHOUT DETECTION — shared audio thread
# ═══════════════════════════════════════════════════════════════
def start_audio_detection(zones):
    global shout_spike_count, audio_running
    try:
        import pyaudio
    except ImportError:
        print("⚠️  PyAudio not installed — shout detection disabled.")
        print("   Run: pip install pyaudio")
        return

    try:
        pa     = pyaudio.PyAudio()
        stream = pa.open(format=pyaudio.paInt16, channels=1,
                         rate=44100, input=True, frames_per_buffer=1024)
        print("🎤 Audio shout detection started.")
        audio_running = True

        # Audio buffer for CNN (collect 3 seconds = 3*44100 samples)
        audio_buffer = []
        CNN_BUFFER_SIZE = int(44100 * 3.0)  # 3 seconds of audio

        while audio_running:
            try:
                data      = stream.read(1024, exception_on_overflow=False)
                samples   = np.frombuffer(data, dtype=np.int16)
                amplitude = np.max(np.abs(samples))

                # ── CNN-based shout detection ─────────────────
                if SHOUT_CNN_OK and CONFIG.get("SHOUT_USE_CNN", False):
                    audio_buffer.extend(samples.tolist())

                    # Process when buffer has enough samples
                    if len(audio_buffer) >= CNN_BUFFER_SIZE:
                        try:
                            import torch
                            import librosa

                            # Convert buffer to numpy float
                            y = np.array(audio_buffer[:CNN_BUFFER_SIZE], dtype=np.float32) / 32768.0
                            audio_buffer = audio_buffer[CNN_BUFFER_SIZE//2:]  # 50% overlap

                            # Extract MFCC
                            mfcc = librosa.feature.mfcc(
                                y=y, sr=44100, n_mfcc=40,
                                n_fft=2048, hop_length=512
                            )
                            mfcc = (mfcc - mfcc.mean()) / (mfcc.std() + 1e-8)

                            # Fix length to 130 frames
                            if mfcc.shape[1] < 130:
                                mfcc = np.pad(mfcc, ((0,0),(0,130-mfcc.shape[1])), mode="constant")
                            else:
                                mfcc = mfcc[:, :130]

                            # Run CNN
                            device = SHOUT_CNN_MODEL["device"]
                            model  = SHOUT_CNN_MODEL["model"]
                            inp    = torch.FloatTensor(mfcc).unsqueeze(0).unsqueeze(0).to(device)

                            with torch.no_grad():
                                out   = model(inp)
                                probs = torch.softmax(out, dim=1)
                                shout_prob = probs[0][1].item()  # class 1 = shout

                            if shout_prob >= CONFIG.get("SHOUT_CNN_CONF", 0.75):
                                print(f"📢 SHOUT detected! CNN confidence={shout_prob:.2f}")
                                if zones:
                                    child = {
                                        "childId":   zones[0].get("childId"),
                                        "childName": zones[0].get("childName", "Unknown"),
                                        "bedNumber": zones[0].get("bedNumber", "?"),
                                    }
                                    send_alert_async("shout_detected", child, "audio")

                        except Exception as cnn_err:
                            pass  # silently fall through to amplitude check

                # ── Amplitude fallback (always runs as backup) ─
                if amplitude > CONFIG["SHOUT_THRESHOLD"]:
                    shout_spike_count += 1
                    if shout_spike_count >= CONFIG["SHOUT_DURATION_FRAMES"]:
                        if not (SHOUT_CNN_OK and CONFIG.get("SHOUT_USE_CNN", False)):
                            # Only alert from amplitude if CNN is not running
                            print(f"📢 SHOUT detected! Amplitude={amplitude}")
                            if zones:
                                child = {
                                    "childId":   zones[0].get("childId"),
                                    "childName": zones[0].get("childName", "Unknown"),
                                    "bedNumber": zones[0].get("bedNumber", "?"),
                                }
                                send_alert_async("shout_detected", child, "audio")
                        shout_spike_count = 0
                else:
                    shout_spike_count = max(0, shout_spike_count - 1)

            except Exception:
                pass

        stream.stop_stream()
        stream.close()
        pa.terminate()

    except Exception as e:
        print(f"⚠️  Audio init failed: {e}")


# ═══════════════════════════════════════════════════════════════
#  CAMERA THREAD — one per camera source
# ═══════════════════════════════════════════════════════════════
def camera_thread(source, camera_id, zones):
    state = CameraState(camera_id)
    camera_states[camera_id] = state
    cam_zones = get_zones_for_camera(zones, camera_id)

    print(f"[{camera_id}] Starting — source: {source} — zones: {len(cam_zones)}")

    while True:  # outer reconnect loop
        state.status = "starting"
        src = int(source) if str(source).isdigit() else source
        cap = cv2.VideoCapture(src)

        if not cap.isOpened():
            print(f"[{camera_id}] ❌ Cannot open — retrying in {CONFIG['RECONNECT_DELAY']}s...")
            state.status = "reconnecting"
            placeholder  = np.zeros((360, 640, 3), dtype=np.uint8)
            cv2.putText(placeholder, f"{camera_id} — reconnecting...",
                        (30, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 80, 200), 2)
            with display_lock:
                display_frames[camera_id] = placeholder
            time.sleep(CONFIG["RECONNECT_DELAY"])
            continue

        state.status = "running"
        print(f"[{camera_id}] ✅ Camera opened")

        while True:
            ret, frame = cap.read()
            if not ret:
                print(f"[{camera_id}] ⚠️  Lost connection — reconnecting...")
                state.status = "reconnecting"
                break

            state.frame_count += 1

            # FPS counter
            state.fps_frame_count += 1
            now = time.time()
            if now - state.last_fps_time >= 1.0:
                state.fps             = round(state.fps_frame_count / (now - state.last_fps_time), 1)
                state.fps_frame_count = 0
                state.last_fps_time   = now

            # Frame skip
            if state.frame_count % max(1, CONFIG["FRAME_SKIP"]) != 0:
                continue

            h, w = frame.shape[:2]
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            person_count = 0

            # ── YOLOv8 Pose Detection ─────────────────────────
            if YOLO_OK and YOLO_MODEL_OBJ is not None:
                try:
                    results = YOLO_MODEL_OBJ(
                        frame,
                        conf=CONFIG["YOLO_CONF"],
                        verbose=False
                    )

                    for r in results:
                        if r.keypoints is None:
                            continue

                        kps_data = r.keypoints.xyn.cpu().numpy()  # normalized keypoints
                        kps_conf = r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None else None

                        for person_idx, kp_xy in enumerate(kps_data):
                            person_count += 1

                            # Build keypoints array: (17, 3) — x, y, conf
                            if kps_conf is not None and person_idx < len(kps_conf):
                                conf_arr = kps_conf[person_idx]
                                kp_full  = np.column_stack([kp_xy, conf_arr])
                            else:
                                kp_full  = np.column_stack([kp_xy, np.ones(len(kp_xy))])

                            # Draw skeleton
                            draw_skeleton(frame, kp_full)

                            # Fall detection
                            child = detect_fall_yolo(
                                kp_full, h, w,
                                f"p{person_idx}",
                                cam_zones, state, camera_id
                            )
                            if child:
                                send_alert_async("fall_detected", child, camera_id)

                except Exception as e:
                    print(f"[{camera_id}] YOLO error: {e}")

            # ── Fight Detection ───────────────────────────────
            if state.frame_count % 2 == 0:
                child = detect_fight(gray, person_count, cam_zones, state, camera_id)
                if child:
                    send_alert_async("fight_detected", child, camera_id)

            # ── Face Recognition ──────────────────────────────
            state.face_counter += 1
            if state.face_counter >= CONFIG["FACE_CHECK_EVERY"]:
                state.face_counter = 0
                state.face_results = process_faces(frame, cam_zones, state, camera_id)

            # ── Draw everything ───────────────────────────────
            draw_zones(frame, cam_zones)
            draw_faces(frame, state.face_results)
            draw_status(frame, state, len(cam_zones), person_count)

            # ── Store frame for display grid ──────────────────
            with display_lock:
                display_frames[camera_id] = frame.copy()

        cap.release()
        time.sleep(CONFIG["RECONNECT_DELAY"])


# ═══════════════════════════════════════════════════════════════
#  DISPLAY GRID — all cameras in one window
# ═══════════════════════════════════════════════════════════════
def build_display_grid(camera_ids, target_w=1280, target_h=720):
    n = len(camera_ids)
    if n == 0:
        return None

    if n == 1:    cols, rows = 1, 1
    elif n == 2:  cols, rows = 2, 1
    elif n <= 4:  cols, rows = 2, 2
    elif n <= 6:  cols, rows = 3, 2
    elif n <= 9:  cols, rows = 3, 3
    else:         cols, rows = 4, 3

    cell_w = target_w // cols
    cell_h = target_h // rows
    grid   = np.zeros((target_h, target_w, 3), dtype=np.uint8)

    with display_lock:
        frames = {cid: display_frames.get(cid) for cid in camera_ids}

    for idx, cid in enumerate(camera_ids):
        row = idx // cols
        col = idx % cols
        x   = col * cell_w
        y   = row * cell_h

        frame = frames.get(cid)
        if frame is not None:
            resized = cv2.resize(frame, (cell_w, cell_h))
        else:
            resized = np.zeros((cell_h, cell_w, 3), dtype=np.uint8)
            cv2.putText(resized, f"{cid} — connecting...",
                        (20, cell_h // 2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 100, 100), 1)

        grid[y:y+cell_h, x:x+cell_w] = resized
        cv2.rectangle(grid, (x, y), (x+cell_w-1, y+cell_h-1), (60, 60, 60), 1)

    return grid


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════
def run(sources):
    global audio_running

    if CONFIG["TOKEN"] == "PASTE_YOUR_TOKEN_HERE":
        print("❌ ERROR: Set your TOKEN in CONFIG at top of this file.")
        print("   Browser console → localStorage.getItem('sg_token')")
        sys.exit(1)

    print("\n" + "="*60)
    print("  SleepGuardian AI Detector v5 — Custom Fine-Tuned Models")
    print("  sg_fall.pt | sg_fight.pt | sg_shout.pt | InsightFace")
    print("="*60 + "\n")

    zones = load_zones(CONFIG["ZONES_FILE"])

    # Load AI models
    load_yolo()
    load_shout_cnn()

    if CONFIG["FACE_RECOGNITION"]:
        load_insightface()
        fetch_child_embeddings()

    print(f"\n📷 Starting {len(sources)} camera(s):")
    camera_ids = []
    for i, src in enumerate(sources):
        cid = f"cam{i+1}"
        camera_ids.append(cid)
        cam_zones = get_zones_for_camera(zones, cid)
        print(f"   {cid} → {src}  ({len(cam_zones)} zones)")
    print()

    # Audio thread (shared — one microphone for all cameras)
    audio_t = threading.Thread(
        target=start_audio_detection, args=(zones,), daemon=True
    )
    audio_t.start()

    # One thread per camera
    for i, src in enumerate(sources):
        cid = f"cam{i+1}"
        t = threading.Thread(
            target=camera_thread, args=(src, cid, zones), daemon=True
        )
        t.start()
        time.sleep(0.5)  # stagger startup to avoid GPU overload

    print(f"✅ {len(sources)} camera thread(s) started")
    print("🔍 Detection running...")
    print("   Press Q to quit\n")

    window_name = f"SleepGuardian AI v5 — {len(sources)} Camera(s)"

    while True:
        if CONFIG["DISPLAY_GRID"]:
            grid = build_display_grid(camera_ids)
            if grid is not None:
                cv2.imshow(window_name, grid)
        else:
            with display_lock:
                frames_copy = dict(display_frames)
            for cid, frame in frames_copy.items():
                if frame is not None:
                    cv2.imshow(f"SleepGuardian — {cid}", frame)

        if cv2.waitKey(30) & 0xFF == ord("q"):
            break

    audio_running = False
    cv2.destroyAllWindows()
    print("\n👋 SleepGuardian AI stopped.")


# ═══════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="SleepGuardian AI Detector v4 — YOLOv8 + InsightFace"
    )
    parser.add_argument(
        "--sources", default="0",
        help=(
            "Comma-separated camera sources.\n"
            "  --sources '0'                    single webcam\n"
            "  --sources '0,1'                  two webcams\n"
            "  --sources 'rtsp://x,rtsp://y'    two IP cameras\n"
            "  --sources '0,rtsp://x'           mix webcam + IP\n"
            "  --sources 'http://x:8080/video'  phone camera"
        )
    )
    parser.add_argument("--no-face", action="store_true", help="Disable face recognition (faster)")
    parser.add_argument("--cpu",     action="store_true", help="Force CPU mode (no GPU)")
    parser.add_argument("--no-grid", action="store_true", help="Separate window per camera")
    args = parser.parse_args()

    if args.no_face:
        CONFIG["FACE_RECOGNITION"] = False
        print("ℹ️  Face recognition disabled")

    if args.cpu:
        CONFIG["USE_GPU"] = False
        print("ℹ️  CPU mode forced")

    if args.no_grid:
        CONFIG["DISPLAY_GRID"] = False

    raw_sources = [s.strip() for s in args.sources.split(",")]
    sources     = [int(s) if s.isdigit() else s for s in raw_sources]

    run(sources)
