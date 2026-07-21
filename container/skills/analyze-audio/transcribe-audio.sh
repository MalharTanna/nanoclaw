#!/bin/sh
# transcribe-audio.sh <audio-file> [outdir]
# Transcribe a voice note / audio file (any format: ogg/opus, mp3, m4a, wav,
# aac…) to text. Language auto-detected (Hindi/Gujarati/English/…). Prints where
# the transcript landed; the agent then reads it and acts on it.
set -e
AUDIO="$1"
OUT="${2:-/tmp/audio-analysis}"
if [ -z "$AUDIO" ] || [ ! -f "$AUDIO" ]; then
  echo "usage: transcribe-audio.sh <audio-file> [outdir]" >&2
  exit 1
fi
mkdir -p "$OUT"
rm -f "$OUT"/transcript.txt "$OUT"/audio.wav 2>/dev/null || true

# Convert to 16kHz mono PCM wav — whisper's expected input. ffmpeg decodes
# ogg/opus (WhatsApp voice notes), mp3, m4a, aac, wav, etc.
ffmpeg -hide_banner -loglevel error -y -i "$AUDIO" -ar 16000 -ac 1 -c:a pcm_s16le "$OUT/audio.wav"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/audio.wav" 2>/dev/null | cut -d. -f1)

whisper-cli -m /opt/whisper/ggml-small.bin -f "$OUT/audio.wav" -l auto -otxt -np -of "$OUT/transcript" 2>/dev/null || true
rm -f "$OUT/audio.wav"

if [ -f "$OUT/transcript.txt" ] && [ -s "$OUT/transcript.txt" ]; then
  echo "transcript: $OUT/transcript.txt (${DUR:-?}s, $(wc -w < "$OUT/transcript.txt" | tr -d ' ') words)"
else
  echo "transcript: empty (no speech detected)"
fi
