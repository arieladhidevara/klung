# Klung!

Klung! turns a melody into a colorful C1–B1 falling-note performance for angklung players. It runs locally in the browser and does not require an account or paid API key.

## Features

- Import M4A, MP3, WAV, and MIDI songs, or use the separate **Load Project** control to reopen a saved Klung project.
- Transcribe audio locally with Spotify Basic Pitch, then fold every octave into one chromatic C1–B1 layout.
- Record a melody from the computer keyboard. Use `A S D F G H J` for white notes and `W E T Y U` for black notes; holding a key creates one longer note.
- Open the arrangement popup to play, move, resize, multi-select, copy, paste, or delete notes while comparing them with a separate backsound track.
- Scroll up/down in the arrangement timeline to scrub backward/forward.
- Add an audio or video backsound in Edit mode. Klung uses its audio only; drag its track to align it, resize its right edge to time-stretch it, or use the precise start/length controls.
- Resize a selected note from either edge in the arrangement timeline, or enter its exact start and length values.
- Export a 720p performance video with the notes, keyboard, source/backing audio, and synthesized note cues. The recording starts as the first falling note enters the stage.
- Save one portable `.klung-project.json` containing notes, source audio/video, backsound audio/video, offsets, piano mute state, speed, and volume.
- Start a synchronized mobile-player room from the laptop. Players scan a QR code, choose one or more notes, then see only their selected falling-note lanes, sized to fill the phone screen. Upcoming notes are dimmed; notes glow and read **Klung!** when they reach the hit line.
- Switch the source piano/melody sound on or off in Edit mode without muting the backsound.
- Use fixed solfège labels (Do, Re, Mi, Fa, Sol, and chromatic variants) across the stage, editor, exports, and connected phones.
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
- Drag across empty space in the arrangement timeline to select every intersecting note.
- `Ctrl/Cmd/Shift` + click: add or remove notes from the editor selection.
- `Ctrl/Cmd+A`: select every note in the editor.
- `Ctrl/Cmd+C` / `Ctrl/Cmd+V`: copy and paste all selected notes while preserving their relative timing.
- `Delete` / `Backspace`: remove all selected notes.
- `A S D F G H J`: white notes while recording.
- `W E T Y U`: black notes while recording.
- `Escape`: stop recording or leave the editor.

## Mobile player sessions

1. Load or edit a song, then click **MOBILE** on the laptop master.
2. Players scan the QR code. The production join URL is `https://klung-one.vercel.app/join?session=...`.
3. Every player chooses one or more notes and taps **READY**.
4. Press Play at any time. Connected phones follow the live master automatically; players who finish joining later are synchronized to the master's current position.

Mobile participation is optional: Play works normally when nobody joins. When phones are connected, the master schedules playback ahead, each phone estimates its clock offset from several round trips, and the master sends periodic timeline corrections during playback. Live rooms use direct, encrypted WebRTC connections with Trystero's public signaling network, so the Vercel deployment does not need a persistent WebSocket server.

Keep the laptop session open while players are connected. A restrictive network may still require TURN configuration; using the same reliable Wi-Fi is recommended for performances.

## Audio notes

- Browser audio transcription is analysis-first, not real-time. MIDI and saved Klung projects load without model inference.
- Standard AAC-based M4A files, including typical iPhone Voice Memos, work in current Chrome and Edge. ALAC or unusual codecs may require conversion to WAV.
- Basic Pitch works best with an isolated melodic instrument. Dense full-band mixes can still need manual cleanup in the built-in editor.
- Spotify Basic Pitch is distributed under the Apache-2.0 license: https://github.com/spotify/basic-pitch-ts
