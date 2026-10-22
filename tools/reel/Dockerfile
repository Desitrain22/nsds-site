# The reel runner: everything reel.yml's jobs need, models included, so a draft starts in about a
# minute instead of spending 3-5 reinstalling PyTorch and downloading ~2 GB of models every run.
# Built and published to ghcr.io/desitrain22/nsds-reel by .github/workflows/reel-image.yml.
#
# Debian bookworm's ffmpeg has libass (burned-in captions) and drawtext (the bug), and its python3
# is 3.11, which WhisperX 3.8 needs. The caption fonts are embedded in each slide; fonts-dejavu-core
# is only the fallback sans for a glyph none of them carry (the slim image ships no fonts at all).
FROM node:20-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Desitrain22/nsds-site"
LABEL org.opencontainers.image.description="NSDS reel and carousel runner: WhisperX, YuNet face tracking, ffmpeg, headless Chromium"

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ffmpeg rclone librsvg2-bin chromium fonts-noto-color-emoji fonts-dejavu-core python3 python3-venv ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH \
    HF_HOME=/opt/models/hf TORCH_HOME=/opt/models/torch \
    NSDS_PYTHON=/opt/venv/bin/python NSDS_RCLONE=rclone NSDS_FFMPEG=ffmpeg NSDS_FFPROBE=ffprobe NSDS_CHROMIUM=chromium

# The CPU torch wheels come from PyTorch's own index; PyPI stays as the fallback for everything that
# index doesn't carry (it has no flit_core, and Debian's pip 23 then tries to build from source).
COPY tools/reel/requirements.txt /tmp/requirements.txt
RUN python3 -m venv $VIRTUAL_ENV \
 && pip install -q --no-cache-dir -U pip \
 && pip install -q --no-cache-dir torch==2.8.* torchaudio==2.8.* torchvision==0.23.* \
      --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
 && pip install -q --no-cache-dir -r /tmp/requirements.txt

# Bake the models in: the Whisper model, the English aligner, and the Silero VAD.
RUN python - <<'PY'
import whisperx
whisperx.load_model("medium.en", "cpu", compute_type="int8", language="en", vad_method="silero")
whisperx.load_align_model(language_code="en", device="cpu")
print("models cached")
PY
