"""Word-timed transcript of one WAV with WhisperX, for tools/reel/draft.mjs.

    python transcribe.py <in.wav> <out.json>

Writes {"words": [{"text", "s", "e"}]} with times in seconds from the start of the WAV. A word
WhisperX's aligner can't place (digits, symbols: "2014", "$13.60") comes back with s/e null;
fillTimings() in videoreview/reel.js fills those in. Prints a count only -- the repo is public and
so are its Actions logs, so the transcript itself is never printed.

CPU only (GitHub's standard runners have no GPU), int8, Silero VAD so no Hugging Face token is
needed. NSDS_WHISPER_MODEL overrides the model (default medium.en: club audio, with laughter over
the punchlines, is where the small models fall apart, and a clip is only a minute or two of audio).
"""

import json
import os
import sys

import whisperx


def main(src, dst):
    model_name = os.environ.get("NSDS_WHISPER_MODEL", "medium.en")
    audio = whisperx.load_audio(src)
    model = whisperx.load_model(model_name, "cpu", compute_type="int8", language="en",
                                vad_method="silero", threads=os.cpu_count() or 4)
    result = model.transcribe(audio, batch_size=8, language="en")
    align_model, meta = whisperx.load_align_model(language_code="en", device="cpu")
    aligned = whisperx.align(result["segments"], align_model, meta, audio, "cpu",
                             return_char_alignments=False)

    words = []
    for seg in aligned.get("segments", []):
        for w in seg.get("words", []):
            text = str(w.get("word", "")).strip()
            if text:
                words.append({"text": text, "s": w.get("start"), "e": w.get("end")})

    with open(dst, "w") as f:
        json.dump({"words": words}, f)
    untimed = sum(1 for w in words if w["s"] is None)
    print(f"{len(words)} words ({untimed} without timing) with {model_name}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: transcribe.py <in.wav> <out.json>")
    main(sys.argv[1], sys.argv[2])
