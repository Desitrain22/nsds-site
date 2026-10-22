"""Face detections and sharpness for a carousel's candidate stills (tools/carousel/draft.mjs).

    python stills.py <frames_dir> <out.json>

<frames_dir> holds the 4 fps preview JPEGs (f00001.jpg, ...). Writes
{"aspect": w/h, "samples": [{"file", "faces": [{"cx","cy","w","h","score","sharp"}]}]} in file-name
order, every coordinate a fraction of the frame. `sharp` is the variance of the Laplacian of the
grayscale face box, always a finite number (0 for a degenerate box). Choosing WHICH face is the
performer and scoring the frame happen in videoreview/carousel.js (scoreFrames), where they are tested.

Detector: the same YuNet model and thresholds as tools/reel/track.py.
"""

import json
import math
import os
import sys

import cv2

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reel", "models", "face_detection_yunet_2023mar.onnx")


def sharpness(gray, x, y, fw, fh):
    """Variance of the Laplacian of the face box; 0 when the box is empty or the result is not finite."""
    h, w = gray.shape[:2]
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(w, int(x + fw)), min(h, int(y + fh))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return 0.0
    v = float(cv2.Laplacian(gray[y0:y1, x0:x1], cv2.CV_64F).var())
    return v if math.isfinite(v) else 0.0


def main(src, dst):
    names = sorted(n for n in os.listdir(src) if n.lower().endswith(".jpg"))
    if not names:
        sys.exit("no frames to look at")
    det = None
    size = None
    aspect = 16 / 9
    samples = []
    for name in names:
        img = cv2.imread(os.path.join(src, name))
        if img is None:
            sys.exit("could not read a frame")
        h, w = img.shape[:2]
        if size != (w, h):
            size = (w, h)
            aspect = w / h
            det = cv2.FaceDetectorYN.create(MODEL, "", (w, h), 0.6, 0.3, 50)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, faces = det.detect(img)
        found = []
        if faces is not None:
            for f in faces:
                x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
                found.append({
                    "cx": (x + fw / 2) / w, "cy": (y + fh / 2) / h, "w": fw / w, "h": fh / h,
                    "score": score, "sharp": sharpness(gray, x, y, fw, fh),
                })
        samples.append({"file": name, "faces": found})

    with open(dst, "w") as out:
        json.dump({"aspect": aspect, "samples": samples}, out)
    hits = sum(1 for s in samples if s["faces"])
    print(f"looked at {len(samples)} frames, a face in {hits}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: stills.py <frames_dir> <out.json>")
    main(sys.argv[1], sys.argv[2])
