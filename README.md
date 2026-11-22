# Klung!

Klung! turns a melody into a colorful C1–B1 falling-note performance for angklung players. It runs locally in the browser and does not require an account or paid API key.

## Features

- Import M4A, MP3, WAV, and MIDI songs, or use the separate **Load Project** control to reopen a saved Klung project.
- Transcribe audio locally with Spotify Basic Pitch, then fold every octave into one chromatic C1–B1 layout.
- Record a melody from the computer keyboard against an optional backsound. Record mode opens paused: use Space or its transport buttons to play/pause or rewind, scroll to scrub notes and backsound together, and upload or replace the backsound without leaving Record mode. Recorded notes can be selected, copied, pasted, deleted, moved, or resized while recording is still open.
- When recording with a backsound, captured note timestamps follow the playing audio's media clock (including backing start offset and stretch rate) instead of the device's wall-clock timer. This prevents notes from landing late during playback when iOS/Safari needs time to start audio. Cancelling/pausing pending audio playback also avoids accidental startup seeks. Recordings made before this change keep their saved timings; re-record them if they were out of sync.
- On touch-screen phones, **Record** opens an isolated, edge-to-edge landscape piano overlay so the regular page (including the upload controls) cannot appear or scroll behind it. Only **Menu** and the recording clock float above the keys. Tap **Menu** to open or close a matching landscape control popover with Play/Pause, Rewind, and **♫ BACKSOUND**. **EXIT RECORDING** lives inside that menu: it ends and saves the recorded take (if notes were played), restores the piano/HUD to the ordinary page and exits fullscreen/unlocks screen orientation where the browser permits it. The first piano tap starts the timeline, and holding multiple keys records chords. iPhone Safari without native fullscreen/rotation uses an app-level rotated overlay fitted to the visible browser viewport (Safari's own status and address bars may remain visible).
- Notes remain directly editable on the performance stage after recording, importing, or leaving the full timeline editor.
- Add **+ CUE** in Edit mode at the current playhead, select the cue to edit its **TEXT** (defaults to TRANSPOSE, but can be any custom text), drag it along the CUES lane, or enter its exact start time. When the cue reaches the hit line, all 12 note keys light up and the custom text appears. These are visual cues only: they do not change pitches or make sounds. Cue text and timing are preserved in projects, exported videos, and connected mobile players. Previously saved cues without text still display TRANSPOSE.
- Open the arrangement popup to play, move, resize, multi-select, copy, paste, delete, undo, or redo notes. Right-click a multi-selection for Group/Ungroup; clicking or dragging one grouped note selects and moves the entire group.
- Scroll up/down in the arrangement timeline to zoom, or **pinch with two fingers** on touch devices; the gesture zooms around its center and supports two-finger panning. Drag across the ruler with one finger to navigate horizontally when zoomed.
- Add an audio or video backsound in Edit mode. Klung uses its audio only; drag its track to align it, resize its right edge to time-stretch it, or use the precise start/length controls.
- Resize a selected note from either edge in the arrangement timeline, or enter its exact start and length values.
- Export a 720p performance video with the notes, keyboard, source/backing audio, and synthesized note cues. The recording starts as the first falling note enters the stage.
- Save one portable `.klung-project.json` containing notes, source audio/video, backsound audio/video, offsets, piano mute state, speed, and volume.
- Start a synchronized mobile-player room from the laptop. Players scan a QR code, choose one or more notes, then see only their selected falling-note lanes, sized to fill the phone screen. Upcoming notes are dimmed; notes glow and read **Klung!** when they reach the hit line.
- Switch the source piano/melody sound on or off in Edit mode without muting the backsound.
- Change playback speed from 0.50×–2.00×; notes, source audio, backsound, recording transport, exports, and connected mobile timelines stay synchronized.
- Use fixed solfège labels (Do, Di, Re, Ri, Mi, Fa, Fis, Sol, Sis, La, Lis, Si) across the stage, editor, exports, and connected phones.
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
- Mouse wheel on the stage: scrub backward or forward to find and edit notes, including during recording.
- Mouse wheel in the arrangement timeline: zoom in or out around the pointer; use horizontal overflow or Shift+wheel to move left/right.
- Mouse wheel in Record mode: scrub the recorded notes and backsound together (up moves forward, down rewinds).
- `Space` in Record mode: play or pause the recording timeline.
- Drag across empty space in the arrangement timeline to select every intersecting note.
- `Ctrl/Cmd/Shift` + click: add or remove notes from the editor selection.
- `Ctrl/Cmd+A`: select every note in the editor.
- `Ctrl/Cmd+C` / `Ctrl/Cmd+V`: copy and paste all selected notes while preserving their relative timing.
- `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`: undo or redo a note edit (`Ctrl/Cmd+Y` also redoes).
- `Delete` / `Backspace`: remove all selected notes.
- `A S D F G H J`: white notes while recording.
- `W E T Y U`: black notes while recording.
- `Escape`: stop recording or leave the editor.

## Mobile player sessions (master + up to 50 phones)

The live room uses **a hosted Supabase Realtime relay, not WebRTC peer-to-peer**. Every phone subscribes to the session-wide control broadcast **and to one per-phone song-transfer topic**; phones do **not** connect to one another. The master sends Play, Pause, Stop/Seek, playback speed, and lightweight **song-updated** notifications to everyone, but sends the large note-timeline chunks only to the phone that requested them. When the master loads a new song or saves edited notes, each phone requests and downloads the new version individually (assigned pitches are preserved). A reconnecting phone with the same song version does not re-download it. Every phone now acknowledges receipt of the complete song. If its private transfer is accepted by the relay but not acknowledged, the master retries using the shared room topic with a signed recipient ID, so existing players ignore the payload unless the direct route fails. A waiting phone automatically re-requests the song without a manual refresh. Phone-to-master HELLO, READY and clock pings use a separate upstream Realtime topic subscribed to by the master only.

1. Configure a dedicated Supabase project for Klung! (recommended, rather than sharing production credentials with another app).
2. Set these **public/publishable** Vercel environment variables (for Preview and Production when ready):
   - `VITE_KLUNG_SUPABASE_URL`: the Supabase project URL, e.g. `https://YOUR_PROJECT.supabase.co`
   - `VITE_KLUNG_SUPABASE_PUBLISHABLE_KEY`: the project's **publishable** API key (`sb_publishable_...`) or legacy anon key. **Never use service_role or a secret key.**
3. Redeploy (Vite embeds public values at build time). A new master QR code automatically uses the current deployment's origin.
4. Load a song and press **MOBILE** on the laptop. Klung generates a random **4-digit code** (including leading zeroes) and a QR that goes directly to **`https://klung-one.vercel.app/1234`** (example only). Players can either scan the QR or visit the permanent **`/joinsession`** page, type the displayed 4-digit code and press **JOIN SESSION**. Both routes lead to the same **`/1234`** room. The phone automatically finds the live master, downloads its note timeline, then offers **Which notes will you play?**. Choose notes and tap **READY**.
5. Master presses Play: a signed command tells all phones to start at a shared future master time. Each phone draws its own notes locally; realtime messages are only for playback controls and occasional synchronization. Playback continues offline after the initial Play command, but offline phones cannot receive new Pause/Seek instructions.
6. Mobile **RECONNECT** restores the session without another download if the cached song version has not changed.

The room displays a target capacity of **50 players + 1 master**, with a soft admission guard on the master. Each master generates a per-session P-256 key; phones obtain the public verification key from the master's Supabase Presence after joining the short-code room, then verify signed playback messages. The UI detects simultaneous masters on the same 4-digit code and warns that a new room is needed. **Important security tradeoff:** a 4-digit code is a discoverable pairing code, **not a password or proof of the master's identity**. The Presence key cannot authenticate a master before first contact. Public Realtime topics still allow outside subscriptions/messages; use stronger authenticated room registration and rate limiting before exposing this to untrusted public users. Legacy signed QR links (`/join?session=...&mobile=1&key=...`) remain supported.

**Important:** 50-player synchronization is an engineering target, not a measured guarantee. Before a live performance, test on the expected Wi-Fi and cellular networks with progressively more devices (5, 10, 25, 50). The largest sources of variation will be latency and browser background throttling. Keep phones awake and the master's browser open. If you only see “Realtime not configured”, the two Vercel variables above have not been set.

See [Supabase Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast), [Protocol](https://supabase.com/docs/guides/realtime/protocol) and [Limits](https://supabase.com/docs/guides/realtime/limits). The free Realtime tier currently lists 200 concurrent connections, but check the current plan and quotas before events.

## Audio notes

- Browser audio transcription is analysis-first, not real-time. MIDI and saved Klung projects load without model inference.
- Standard AAC-based M4A files, including typical iPhone Voice Memos, work in current Chrome and Edge. ALAC or unusual codecs may require conversion to WAV.
- Basic Pitch works best with an isolated melodic instrument. Dense full-band mixes can still need manual cleanup in the built-in editor.
- Spotify Basic Pitch is distributed under the Apache-2.0 license: https://github.com/spotify/basic-pitch-ts
