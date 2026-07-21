---
name: analyze-audio
description: Listen to a voice note or audio file a member sends — transcribe the speech (Hindi/Gujarati/English, auto-detected), then act on it: answer their question, or pull out the tasks/requests they spoke and record them. Use whenever a message has an audio/voice attachment, or someone asks you to listen to / transcribe / act on a voice note or recording.
allowed-tools: Read, Bash(sh:*), Bash(bash:*), Bash(ffmpeg:*), Bash(ffprobe:*), Bash(whisper-cli:*), Bash(cat:*), Bash(ls:*)
---

# Listening to voice notes & audio

When a member sends a voice note or audio file, the formatter notes it like:

```
[audio: voice.ogg — saved to /workspace/inbox/<id>/voice.ogg]
```

You can't "hear" the file directly — transcribe it first, then work from the text.

## 1. Transcribe it

```bash
sh /app/skills/analyze-audio/transcribe-audio.sh "/workspace/inbox/<id>/voice.ogg" /tmp/aud
```

It prints e.g. `transcript: /tmp/aud/transcript.txt (38s, 96 words)`. Then read it:

```bash
cat /tmp/aud/transcript.txt
```

(A long recording takes a bit — a few minutes of audio ≈ 20–40s to transcribe. If the
member is waiting, tell them you're listening.)

## 2. Act on what was said — don't just transcribe

The point is to **do the thing**, not echo the transcript back. Read the transcript and:

- **If they asked a question** → answer it.
- **If they spoke tasks / instructions / action items** → capture them. Pull out each task,
  and record it where it belongs following your memory conventions (e.g. a `tasks.md` /
  to-do file, or the relevant business ledger — an expense said in the UMA Copiers chat goes
  to the Uma ledger, an IBS expense to the IBS ledger). Then confirm back briefly what you
  logged ("Noted 3 tasks: …").
- **If it's information to remember** → file it into the right place and add a pointer in
  `CLAUDE.local.md` so you can recall it later.

Reply with the result (the answer, or "logged X, Y, Z"), not the raw transcript — unless the
member explicitly asked for a transcript.

## Notes

- Works in any wired group or DM; members summon you the normal way (say "miro" with the
  voice note).
- Languages are auto-detected — Hindi, Gujarati, English, or mixed. If a transcript looks
  garbled, the audio may be very noisy; say so rather than guessing.
- For video (with or without sound), use the `analyze-video` skill instead.
