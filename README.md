# Klung!

Klung! turns a melody into a colorful C1–B1 falling-note performance for angklung players. It runs locally in the browser and does not require an account or paid API key.

## Features

- Import M4A, MP3, WAV, MIDI, and saved Klung projects.
- Transcribe audio locally with Spotify Basic Pitch, then fold every octave into one chromatic C1–B1 layout.
- Record a melody from the computer keyboard. Use `A S D F G H J` for white notes and `W E T Y U` for black notes; holding a key creates one longer note.
- Play and edit on the same falling-note stage. Select, move, resize, or delete notes while playback remains available.
- Scroll on the stage while editing to scrub backward or forward.
- Switch an imported audio track to **Notes only** so the original recording is muted while synthesized note cues remain audible.
- Save edits as a `.klung.json` project and load them again later.
- Use the fullscreen performance view for projection.

## Run locally

Requirements: a current Node.js LTS release and Chrome or Edge.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`.

`npm install` also copies the bundled Basic Pitch model into `public/model`; those generated files are intentionally not committed.

For a production build:

```bash
npm run build
```

## Controls

- `Space`: play or pause.
- Mouse wheel on the stage while editing: scrub backward or forward.
- `Delete` / `Backspace`: remove the selected note.
- `A S D F G H J`: white notes while recording.
- `W E T Y U`: black notes while recording.
- `Escape`: stop recording or leave the editor.

## Audio notes

- Browser audio transcription is analysis-first, not real-time. MIDI and saved Klung projects load without model inference.
- Standard AAC-based M4A files, including typical iPhone Voice Memos, work in current Chrome and Edge. ALAC or unusual codecs may require conversion to WAV.
- Basic Pitch works best with an isolated melodic instrument. Dense full-band mixes can still need manual cleanup in the built-in editor.
- Spotify Basic Pitch is distributed under the Apache-2.0 license: https://github.com/spotify/basic-pitch-ts
