#!/bin/sh
# prep-video.sh <video> [outdir]
# Prepare a video for analysis: sample frames (so the model can SEE it) and
# transcribe speech (Hindi/Gujarati/English, auto-detected). Prints where the
# frames and transcript landed. Then the agent Reads the frames + transcript.
set -e
VIDEO="$1"
OUT="${2:-/tmp/video-analysis}"
if [ -z "$VIDEO" ] || [ ! -f "$VIDEO" ]; then
  echo "usage: prep-video.sh <video-file> [outdir]" >&2
  exit 1
fi
mkdir -p "$OUT"
rm -f "$OUT"/frame-*.jpg "$OUT"/transcript.txt "$OUT"/audio.wav 2>/dev/null || true

# Duration (integer seconds); 0 if unknown.
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO" 2>/dev/null | cut -d. -f1)
[ -z "$DUR" ] && DUR=0

# ~16 evenly-spaced frames, scaled to 640px wide, capped at 24.
if [ "$DUR" -gt 16 ]; then
  INTERVAL=$(( DUR / 16 ))
  ffmpeg -hide_banner -loglevel error -i "$VIDEO" -vf "fps=1/${INTERVAL},scale=640:-2" -frames:v 24 "$OUT/frame-%03d.jpg"
else
  ffmpeg -hide_banner -loglevel error -i "$VIDEO" -vf "fps=1,scale=640:-2" -frames:v 24 "$OUT/frame-%03d.jpg"
fi
NF=$(ls "$OUT"/frame-*.jpg 2>/dev/null | wc -l | tr -d ' ')

# Transcribe speech if the video has an audio stream.
HAS_AUDIO=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$VIDEO" 2>/dev/null | head -1)
if [ -n "$HAS_AUDIO" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$VIDEO" -ar 16000 -ac 1 -c:a pcm_s16le "$OUT/audio.wav"
  whisper-cli -m /opt/whisper/ggml-small.bin -f "$OUT/audio.wav" -l auto -otxt -np -of "$OUT/transcript" 2>/dev/null || true
  rm -f "$OUT/audio.wav"
fi

echo "frames: $NF  ->  $OUT/frame-*.jpg"
if [ -f "$OUT/transcript.txt" ] && [ -s "$OUT/transcript.txt" ]; then
  echo "transcript: $OUT/transcript.txt ($(wc -w < "$OUT/transcript.txt" | tr -d ' ') words)"
else
  echo "transcript: none (no speech detected, or video has no audio)"
fi
