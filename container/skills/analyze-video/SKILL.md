---
name: analyze-video
description: Watch and analyze a video a member sends — sample its frames (so you can SEE what happens) and transcribe its speech (Hindi/Gujarati/English, auto-detected), then answer questions or do whatever task the member asked about it. Use whenever a message has a video attachment, or someone asks you to watch/check/summarize/analyze a video or video clip.
allowed-tools: Read, Bash(sh:*), Bash(bash:*), Bash(ffmpeg:*), Bash(ffprobe:*), Bash(whisper-cli:*), Bash(ls:*), Bash(cat:*)
---

# Analyzing videos

When a member sends a video, the formatter notes it like:

```
[video: clip.mp4 — saved to /workspace/inbox/<id>/clip.mp4]
```

You can't watch an .mp4 directly, so prepare it first: one helper samples **frames**
(you view them) and **transcribes the speech** (whatever language — Hindi, Gujarati,
English; auto-detected).

## 1. Prepare the video

```bash
sh /app/skills/analyze-video/prep-video.sh "/workspace/inbox/<id>/clip.mp4" /tmp/vid
```

It prints something like:

```
frames: 16  ->  /tmp/vid/frame-*.jpg
transcript: /tmp/vid/transcript.txt (212 words)
```

(Longer videos take longer — transcription of a few minutes can take ~30–60s. If the
member's request is time-sensitive, tell them you're watching it.)

## 2. Look at it

- **Read the frames** with the Read tool — `Read /tmp/vid/frame-001.jpg`, `frame-002.jpg`, …
  The frames are evenly spaced through the video, so they show how it progresses. Read them
  in order to follow what happens.
- **Read the transcript** — `cat /tmp/vid/transcript.txt` (or Read it) for what was *said*.
  If it says "none," the video had no speech/audio — rely on the frames.

## 3. Do what the member asked

Combine what you saw (frames) and heard (transcript) to answer their question or do the
task — summarize it, extract the info they need, check for a problem, pull on-screen text
or numbers, draft a reply, file it into a ledger, whatever was asked. Don't dump the raw
transcript or describe every frame unless they want that — give them the answer.

## Notes

- Works for any member's video in any wired group — they summon you the normal way (say
  "miro" with the video).
- For a still photo (not a video), use the Read tool directly / the read-documents skill —
  this skill is for `.mp4`/video clips.
- Frames are downscaled to 640px and capped at ~16–24 so they're quick to view. If you need
  a closer look at one moment, re-run ffmpeg for that timestamp at full resolution.
