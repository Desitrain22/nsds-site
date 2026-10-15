"""Face detections across a clip, for the performer-following 9:16 crop (tools/reel/draft.mjs).

    python track.py <frames.mp4> <fps> <out.json>

<frames.mp4> is a small, low-frame-rate copy of the clip that draft.mjs cuts in the same ffmpeg pass
as the audio. Writes {"aspect": w/h, "samples": [{"t", "faces": [{"cx","cy","w","h","score"}]}]} with
t in seconds from the start of the copy and every coordinate a fraction of the frame. Choosing WHICH
face is the performer, and smoothing the camera, happen in videoreview/reel.js (followTrack), where
they are tested.

Detector: OpenCV's YuNet (MIT, models/face_detection_yunet_2023mar.onnx), CPU only.
"""

import json
import os
import sys

import cv2

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")


def main(src, fps, dst):
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        sys.exit(f"could not open {src}")
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    det = cv2.FaceDetectorYN.create(MODEL, "", (w, h), 0.6, 0.3, 50)

    samples = []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        _, faces = det.detect(frame)
        found = []
        if faces is not None:
            for f in faces:
                x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
                found.append({"cx": (x + fw / 2) / w, "cy": (y + fh / 2) / h, "w": fw / w, "h": fh / h, "score": score})
        samples.append({"t": i / fps, "faces": found})
        i += 1

    with open(dst, "w") as out:
        json.dump({"aspect": w / h if h else 16 / 9, "samples": samples}, out)
    hits = sum(1 for s in samples if s["faces"])
    print(f"tracked {len(samples)} frames, a face in {hits}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: track.py <frames.mp4> <fps> <out.json>")
    main(sys.argv[1], float(sys.argv[2]), sys.argv[3])
