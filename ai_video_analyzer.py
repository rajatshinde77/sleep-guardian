"""
SleepGuardian — AI Video Analyzer v14 (Fall Only)
===================================================
- Fall Detection:  sg_fall.pt  (mAP50: 86.1%)
- Works on ANY video length (2s, 5s, 15s, 60s+)
- Adaptive thresholds based on video duration
- Smart voting: 2+ signals OR strong pose alone
- Returns verdict: FALL / NO INCIDENT
"""

import sys, json, os
import numpy as np

# ── Pose keypoint indices (COCO format) ──
NOSE = 0
L_SHOULDER = 5;  R_SHOULDER = 6
L_HIP      = 11; R_HIP      = 12
L_KNEE     = 13; R_KNEE     = 14
L_ANKLE    = 15; R_ANKLE    = 16

try:
    import cv2
    CV2_OK = True
except ImportError:
    CV2_OK = False

YOLO_OK = False
YOLO_M  = None   # sg_fall.pt

def load_yolo():
    global YOLO_OK, YOLO_M
    try:
        from ultralytics import YOLO
        import torch

        base_dir  = os.path.dirname(os.path.abspath(__file__))
        fall_path = os.path.join(base_dir, "sg_fall.pt")
        m_fall    = YOLO(fall_path)
        if torch.cuda.is_available():
            m_fall.to("cuda")
        YOLO_M  = m_fall
        YOLO_OK = True
        print("[AI] sg_fall.pt loaded (mAP50: 86.1%)", file=sys.stderr)

    except Exception as e:
        print(f"[AI] YOLO load error: {e}", file=sys.stderr)


def get_adaptive_config(total_frames, fps):
    """
    Adaptive thresholds based on video duration.
    Shorter video = more sensitive detection.
    """
    duration = total_frames / max(fps, 1)

    if duration <= 3:
        return {
            "FRAME_SKIP":       1,
            "YOLO_CONF":        0.25,
            "FALLEN_ASPECT":    0.85,
            "SUSTAINED_FRAMES": 1,
            "MIN_CENTER_Y":     0.15,
            "POSE_THRESHOLD":   40,
            "BLOB_AREA_MIN":    150,
            "BLOB_FRACTION":    0.50,
        }
    elif duration <= 8:
        return {
            "FRAME_SKIP":       1,
            "YOLO_CONF":        0.22,
            "FALLEN_ASPECT":    0.88,
            "SUSTAINED_FRAMES": 2,
            "MIN_CENTER_Y":     0.18,
            "POSE_THRESHOLD":   42,
            "BLOB_AREA_MIN":    160,
            "BLOB_FRACTION":    0.45,
        }
    elif duration <= 20:
        return {
            "FRAME_SKIP":       1,
            "YOLO_CONF":        0.25,
            "FALLEN_ASPECT":    0.92,
            "SUSTAINED_FRAMES": 2,
            "MIN_CENTER_Y":     0.20,
            "POSE_THRESHOLD":   45,
            "BLOB_AREA_MIN":    170,
            "BLOB_FRACTION":    0.43,
        }
    else:
        return {
            "FRAME_SKIP":       2,
            "YOLO_CONF":        0.28,
            "FALLEN_ASPECT":    0.95,
            "SUSTAINED_FRAMES": 3,
            "MIN_CENTER_Y":     0.25,
            "POSE_THRESHOLD":   50,
            "BLOB_AREA_MIN":    180,
            "BLOB_FRACTION":    0.40,
        }


def keypoint_fall_score(keypoints, fh, fw):
    """
    Score 0-100. Higher = more likely a fall.
    Uses 4 skeleton signals.
    """
    if keypoints is None or len(keypoints) < 17:
        return 0

    def get(idx):
        kp = keypoints[idx]
        if len(kp) >= 3 and float(kp[2]) < 0.20:
            return None
        return float(kp[0]) * fw, float(kp[1]) * fh

    nose    = get(NOSE)
    l_sh    = get(L_SHOULDER); r_sh    = get(R_SHOULDER)
    l_hip   = get(L_HIP);     r_hip   = get(R_HIP)
    l_knee  = get(L_KNEE);    r_knee  = get(R_KNEE)
    l_ankle = get(L_ANKLE);   r_ankle = get(R_ANKLE)

    score = 0

    # Signal A: Shoulder-Hip vertical gap collapsed = lying down
    if l_sh and r_sh and l_hip and r_hip:
        sh_y  = (l_sh[1]  + r_sh[1])  / 2
        hip_y = (l_hip[1] + r_hip[1]) / 2
        v_gap = hip_y - sh_y
        if v_gap < fh * 0.08:
            score += 45
        elif v_gap < fh * 0.18:
            score += 25

    # Signal B: Shoulder-Hip horizontal spread = lying sideways
    if l_sh and r_sh and l_hip and r_hip:
        sh_x     = (l_sh[0]  + r_sh[0])  / 2
        hip_x    = (l_hip[0] + r_hip[0]) / 2
        h_spread = abs(sh_x - hip_x)
        v_dist   = abs((l_sh[1]+r_sh[1])/2 - (l_hip[1]+r_hip[1])/2) + 1
        ratio    = h_spread / v_dist
        if ratio > 1.3:
            score += 30
        elif ratio > 0.7:
            score += 15

    # Signal C: Nose below hip level = face toward ground
    if nose and l_hip and r_hip:
        hip_y = (l_hip[1] + r_hip[1]) / 2
        if nose[1] > hip_y + 10:
            score += 20
        elif nose[1] > hip_y - fh * 0.08:
            score += 10

    # Signal D: Ankles above knees = upright, penalize
    if l_knee and r_knee and l_ankle and r_ankle:
        kn_y = (l_knee[1]  + r_knee[1])  / 2
        an_y = (l_ankle[1] + r_ankle[1]) / 2
        if an_y < kn_y - 15:
            score -= 10

    return min(max(score, 0), 100)


def analyze_video(video_path):
    result = {
        "success":        False,
        "verdict":        "UNKNOWN",
        "fallDetected":   False,
        "confidence":     0,
        "totalFrames":    0,
        "analyzedFrames": 0,
        "detections":     [],
        "method":         "sg_fall.pt v14 fine-tuned adaptive",
        "error":          None,
        "summary":        "",
    }

    if not CV2_OK:
        result["error"] = "opencv-python not installed"
        return result

    if not os.path.exists(video_path):
        result["error"] = f"File not found: {video_path}"
        return result

    load_yolo()

    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            result["error"] = "Cannot open video"
            return result

        total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps    = cap.get(cv2.CAP_PROP_FPS) or 30
        fw_v   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        fh_v   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        result["totalFrames"] = total

        cfg      = get_adaptive_config(total, fps)
        duration = total / fps

        print(f"[AI] {fw_v}x{fh_v} @ {fps:.1f}fps | {total} frames | {duration:.1f}s", file=sys.stderr)
        print(f"[AI] Config: sustained={cfg['SUSTAINED_FRAMES']} aspect={cfg['FALLEN_ASPECT']} pose_thresh={cfg['POSE_THRESHOLD']}", file=sys.stderr)

        falls     = []
        sustained = 0
        fc        = 0
        analyzed  = 0

        bg  = cv2.createBackgroundSubtractorMOG2(history=100, varThreshold=35, detectShadows=False)
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

        prev_g    = None
        spike     = False
        still_cnt = 0
        mot_hist  = []
        MOTION_SPIKE     = 10.0
        STILLNESS_THRESH = 3.5
        STILLNESS_FRAMES = max(2, cfg["SUSTAINED_FRAMES"])

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            fc += 1
            if fc % cfg["FRAME_SKIP"] != 0:
                continue
            analyzed += 1
            fh, fw = frame.shape[:2]
            f_area = fw * fh

            gray   = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            gray_b = cv2.GaussianBlur(gray, (21, 21), 0)

            # ── SIGNAL 1: YOLOv8 pose (sg_fall.pt) ──
            pose_score  = 0
            yolo_fallen = False

            if YOLO_OK and YOLO_M:
                try:
                    results = YOLO_M(frame, conf=cfg["YOLO_CONF"], verbose=False)
                    for r in results:
                        boxes = r.boxes
                        kps   = r.keypoints
                        for i, box in enumerate(boxes):
                            x1, y1, x2, y2 = map(int, box.xyxy[0])
                            bw  = x2 - x1
                            bh  = max(y2 - y1, 1)
                            bcy = (y1 + y2) / (2 * fh_v)
                            if (bw / bh) >= cfg["FALLEN_ASPECT"] and bcy >= cfg["MIN_CENTER_Y"]:
                                yolo_fallen = True
                            if kps is not None and i < len(kps.data):
                                kp_data = kps.data[i].cpu().numpy()
                                ps = keypoint_fall_score(kp_data, fh_v, fw_v)
                                if ps > pose_score:
                                    pose_score = ps
                except Exception as e:
                    print(f"[AI] frame error: {e}", file=sys.stderr)

            # ── SIGNAL 2: OpenCV blob ──
            fg = bg.apply(frame)
            fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN,  ker)
            fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, ker)
            fg = cv2.dilate(fg, None, iterations=2)
            cnts, _ = cv2.findContours(fg.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

            blob_fallen = False
            if cnts:
                valid = [c for c in cnts if cfg["BLOB_AREA_MIN"] < cv2.contourArea(c) < f_area * cfg["BLOB_FRACTION"]]
                if valid:
                    big = max(valid, key=cv2.contourArea)
                    bx, by, bw2, bh2 = cv2.boundingRect(big)
                    b_asp = bw2 / max(bh2, 1)
                    b_cy  = (by + bh2 / 2) / fh
                    if b_asp >= cfg["FALLEN_ASPECT"] and b_cy >= cfg["MIN_CENTER_Y"]:
                        blob_fallen = True

            # ── SMART VOTING ──
            signals = sum([yolo_fallen, pose_score >= cfg["POSE_THRESHOLD"], blob_fallen])

            is_fallen = (
                (signals >= 2) or
                (pose_score >= 65) or
                (yolo_fallen and pose_score >= cfg["POSE_THRESHOLD"]) or
                (blob_fallen and pose_score >= cfg["POSE_THRESHOLD"])
            )

            if is_fallen:
                sustained += 1
            else:
                sustained = 0

            if sustained >= cfg["SUSTAINED_FRAMES"]:
                ts     = fc / fps
                is_dup = any(abs(f["timestamp"] - ts) < 2.0 for f in falls)
                if not is_dup:
                    conf = min(48 + (signals * 16) + (sustained * 5) + int(pose_score * 0.28), 97)
                    falls.append({
                        "frame":             fc,
                        "timestamp":         round(ts, 2),
                        "confidence":        conf,
                        "method":            "sg_fall+pose+blob",
                        "consecutiveFrames": sustained,
                        "poseScore":         pose_score,
                        "signals":           signals,
                    })
                    print(f"[AI] FALL at {ts:.1f}s conf={conf}% signals={signals} pose={pose_score:.0f}", file=sys.stderr)
                sustained = 0

            # ── SIGNAL 3: Motion spike → stillness (CCTV pattern) ──
            if prev_g is not None:
                try:
                    flow   = cv2.calcOpticalFlowFarneback(prev_g, gray_b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
                    mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
                    mm     = float(np.mean(mag))
                    mot_hist.append(mm)
                    if len(mot_hist) > 20: mot_hist.pop(0)
                    if not spike and mm > MOTION_SPIKE:
                        spike = True; still_cnt = 0
                    if spike:
                        still_cnt = still_cnt + 1 if mm < STILLNESS_THRESH else 0
                        if still_cnt >= STILLNESS_FRAMES:
                            ts = fc / fps
                            if not any(abs(f["timestamp"] - ts) < 2.0 for f in falls):
                                falls.append({
                                    "frame": fc, "timestamp": round(ts, 2),
                                    "confidence": 72, "method": "motion_spike_stillness",
                                    "consecutiveFrames": still_cnt, "poseScore": 0, "signals": 1,
                                })
                                print(f"[AI] Motion spike fall at {ts:.1f}s", file=sys.stderr)
                            spike = False; still_cnt = 0
                except Exception:
                    pass

            prev_g = gray_b

        cap.release()
        result["analyzedFrames"] = analyzed

        fall_detected = len(falls) > 0

        if fall_detected:
            best_fall = max(falls, key=lambda x: x["confidence"])
            verdict   = "FALL"
            summary   = f"FALL DETECTED at {best_fall['timestamp']}s — {best_fall['confidence']}% confidence"
        else:
            verdict = "NO INCIDENT"
            summary = f"NO INCIDENT — Analyzed {analyzed}/{total} frames ({duration:.1f}s). Normal activity."

        result.update({
            "success":      True,
            "verdict":      verdict,
            "fallDetected": fall_detected,
            "confidence":   max(falls, key=lambda x: x["confidence"])["confidence"] if falls else 0,
            "detections":   falls[:5],
            "summary":      summary,
        })

    except Exception as e:
        import traceback
        result["error"] = str(e)
        print(f"[AI] EXCEPTION:\n{traceback.format_exc()}", file=sys.stderr)

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: python ai_video_analyzer.py <video_path>"}))
        sys.exit(1)
    print(json.dumps(analyze_video(sys.argv[1])))
