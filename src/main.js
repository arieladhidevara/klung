import './style.css';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';
import { Midi } from '@tonejs/midi';
import { createLiveSession } from './live-session.js';
const $=s=>document.querySelector(s);
const canvas=$('#stageCanvas'), ctx=canvas.getContext('2d');
const RANGE_MIN=24,RANGE_MAX=35; // C1 through B1
const whites=[24,26,28,29,31,33,35];
const all=Array.from({length:RANGE_MAX-RANGE_MIN+1},(_,i)=>RANGE_MIN+i);
const whiteSet=new Set(whites);
const black=all.filter(n=>!whiteSet.has(n));
const noteNames=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const pitchName=n=>noteNames[n%12];
// Twelve deliberately separated hues, including the requested red, yellow,
// green, blue, brown, black, white, orange, purple, pink, and turquoise.
const NOTE_COLORS=['#ef3340','#ffd400','#36c24a','#2474ff','#9b5b2e','#151515','#f7f4e8','#ff7a00','#7b3fe4','#ff5bbd','#00bfa6','#00c8ff'];
const noteColor=pitch=>NOTE_COLORS[((pitch%12)+12)%12];
const noteOutline=pitch=>[29,30].includes(pitch)?(pitch===29?'#f3dfae':'#313936'):'rgba(255,255,255,.34)';
const noteInk=pitch=>[24,27,28,29,32].includes(pitch)?'#fff':'#10201b';
const KEYBOARD_PITCHES=new Map([
  ['KeyA',24],['KeyW',25],['KeyS',26],['KeyE',27],['KeyD',28],['KeyF',29],
  ['KeyT',30],['KeyG',31],['KeyY',32],['KeyH',33],['KeyU',34],['KeyJ',35],
]);
const PITCH_KEY_LABELS=new Map([...KEYBOARD_PITCHES].map(([code,pitch])=>[pitch,code.slice(3)]));
// Fold every detected octave into the single C1-B1 angklung layout.
const foldToAngklungRange=pitch=>RANGE_MIN+((pitch%12)+12)%12;
const q=new Set();
let notes=[],duration=0,sourceDuration=0,time=0,playing=false,lead=3,audioUrl=null,source=null,startedAt=0,initialTime=0,isAudio=false,lastFrame=0,noteSequence=0,currentSourceName='';
let songMuted=false;
let backingUrl=null,backingName='',backingDuration=0,backingOffset=0,exporting=false,exportAudioDestination=null;
let sourceMediaAsset=null,backingMediaAsset=null,liveSession=null,pendingPlayTimer=null,pendingPlayPosition=0,lastLiveSyncAt=0;
let recording=false,recordStartedAt=0,recordedNotes=[],recordingSnapshot=null;
const pressedKeyboard=new Map();
const nextNoteId=()=>`klung-note-${Date.now().toString(36)}-${(++noteSequence).toString(36)}`;
function ensureNoteIds(list=notes){for(const note of list)if(!note.id)note.id=nextNoteId();return list}
const keyEls=new Map();
whites.forEach((m,i)=>{const e=document.createElement('div');e.className='key';e.textContent=pitchName(m);e.style.setProperty('--note-color',noteColor(m));$('#piano').append(e);keyEls.set(m,e)});
black.forEach(m=>{const after=whites.findIndex(w=>w>m);const el=document.createElement('div');el.className='key black';el.textContent=pitchName(m);el.style.left=`${after/whites.length*100}%`;el.style.setProperty('--note-color',noteColor(m));$('#piano').append(el);keyEls.set(m,el)});
function setPianoKeyboardLabels(enabled){for(const [pitch,element] of keyEls)element.textContent=enabled?PITCH_KEY_LABELS.get(pitch):pitchName(pitch);$('#piano').classList.toggle('computer-keys',enabled)}
// C1-B1 are layout labels; synth playback uses the brighter C4-B4 register.
const freq=n=>440*Math.pow(2,((n+36)-69)/12);
// This game follows a single melody. Only model-backed attacks are accepted;
// inferred onsets and energy-only notes are deliberately disabled below.
const detection={onsetThreshold:.35,frameThreshold:.28,minNoteFrames:5,attackWindowFrames:6,minAmplitude:.20};
function foldAndDeduplicate(detectedNotes){
  const folded=detectedNotes.map(n=>({...n,sourcePitch:n.pitch,pitch:foldToAngklungRange(n.pitch)}))
    .sort((a,b)=>a.start-b.start||b.amplitude-a.amplitude);
  const result=[];
  for(const note of folded){
    const duplicate=result.findLast(existing=>
      existing.pitch===note.pitch&&Math.abs(existing.start-note.start)<=.09
    );
    if(!duplicate){result.push(note);continue}
    if(note.amplitude>duplicate.amplitude)duplicate.sourcePitch=note.sourcePitch;
    duplicate.amplitude=Math.max(duplicate.amplitude,note.amplitude);
    duplicate.duration=Math.max(duplicate.duration,note.duration);
  }
  return result.sort((a,b)=>a.start-b.start);
}
function extractSinglePressMelody(rawEvents,onsets,audioDuration){
  const candidates=rawEvents.map(event=>{
    const pitchIndex=event.pitchMidi-21;
    const onsetScore=Math.max(0,...[-1,0,1].map(offset=>onsets[event.startFrame+offset]?.[pitchIndex]||0));
    const durationScore=Math.min(event.durationFrames/18,1);
    return {event,onsetScore,score:onsetScore*.65+event.amplitude*.25+durationScore*.10};
  }).filter(candidate=>candidate.onsetScore>=detection.onsetThreshold&&candidate.event.amplitude>=detection.minAmplitude);

  // Non-maximum suppression across every pitch: one acoustic attack becomes
  // exactly one event, while a later repeated press remains independent.
  const attackCenters=[];
  for(const candidate of [...candidates].sort((a,b)=>b.score-a.score)){
    if(attackCenters.every(center=>Math.abs(center.event.startFrame-candidate.event.startFrame)>detection.attackWindowFrames)){
      attackCenters.push(candidate);
    }
  }
  const orderedCenters=attackCenters.sort((a,b)=>a.event.startFrame-b.event.startFrame);
  const pitchSupport=Array(12).fill(0);
  let previousPitchClass=null;
  const winners=orderedCenters.map(center=>{
    const nearby=candidates.filter(candidate=>Math.abs(candidate.event.startFrame-center.event.startFrame)<=detection.attackWindowFrames);
    const byPitchClass=new Map();
    for(const candidate of nearby){
      const pitchClass=((candidate.event.pitchMidi%12)+12)%12;
      if(!byPitchClass.has(pitchClass)||candidate.score>byPitchClass.get(pitchClass).score)byPitchClass.set(pitchClass,candidate);
    }
    const winner=[...byPitchClass.entries()].reduce((best,[pitchClass,candidate])=>{
      const distance=previousPitchClass===null?0:Math.min(Math.abs(pitchClass-previousPitchClass),12-Math.abs(pitchClass-previousPitchClass));
      const supportBonus=Math.min(pitchSupport[pitchClass],3)*.025;
      const continuityBonus=previousPitchClass===null?0:(6-distance)*.005;
      const adjustedScore=candidate.score+supportBonus+continuityBonus;
      return !best||adjustedScore>best.adjustedScore?{candidate,pitchClass,adjustedScore}:best;
    },null);
    pitchSupport[winner.pitchClass]++;
    previousPitchClass=winner.pitchClass;
    return winner.candidate;
  });
  const timed=noteFramesToTime(winners.map(winner=>winner.event));
  const folded=timed.map((n,index)=>({
    pitch:foldToAngklungRange(n.pitchMidi),
    sourcePitch:n.pitchMidi,
    start:Math.max(0,n.startTimeSeconds),
    duration:Math.max(.08,Math.min(n.durationSeconds,Math.max(.08,audioDuration-n.startTimeSeconds))),
    amplitude:n.amplitude,
    confidence:winners[index].score,
  })).sort((a,b)=>a.start-b.start);

  // Reject pitch classes that appear for the first time only in the model's
  // final edge window. These are commonly padding/decay artifacts.
  const tailStart=Math.max(audioDuration*.85,audioDuration-2);
  const established=new Set(folded.filter(note=>note.start<tailStart).map(note=>note.pitch%12));
  return folded.filter(note=>note.start<tailStart||established.has(note.pitch%12));
}
let audioContext;
function context(){return audioContext ||= new (window.AudioContext||window.webkitAudioContext)()}
let mediaGraph=null;
function ensureMediaGraph(){
  if(mediaGraph)return mediaGraph;
  const audio=context(),primarySource=audio.createMediaElementSource($('#audio')),backingSource=audio.createMediaElementSource($('#backingAudio'));
  const primaryGain=audio.createGain(),backingGain=audio.createGain();
  primarySource.connect(primaryGain).connect(audio.destination);backingSource.connect(backingGain).connect(audio.destination);
  mediaGraph={primaryGain,backingGain};updateMediaGains();return mediaGraph;
}
function updateMediaGains(){
  if(!mediaGraph)return;const volume=Number($('#volume').value);
  mediaGraph.primaryGain.gain.value=isAudio&&!songMuted?volume:0;
  mediaGraph.backingGain.gain.value=backingUrl&&!songMuted?volume:0;
}
async function resampleForBasicPitch(buffer){
  const targetRate=22050;
  if(buffer.sampleRate===targetRate)return buffer;
  const OfflineContext=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!OfflineContext)throw new Error('Audio resampling is not supported by this browser. Try the latest Chrome or Edge.');
  const output=new OfflineContext(1,Math.ceil(buffer.duration*targetRate),targetRate);
  const source=output.createBufferSource();
  source.buffer=buffer;
  source.connect(output.destination);
  source.start(0);
  return output.startRendering();
}
function beep(n,when=0,d=.21){const a=context(),osc=a.createOscillator(),gain=a.createGain();osc.type='sine';osc.frequency.value=freq(n);gain.gain.setValueAtTime(0.0001,a.currentTime+when);gain.gain.exponentialRampToValueAtTime(.12*Number($('#volume').value)+.001,a.currentTime+when+.02);gain.gain.exponentialRampToValueAtTime(.0001,a.currentTime+when+Math.max(.12,d));osc.connect(gain);gain.connect(a.destination);if(exportAudioDestination)gain.connect(exportAudioDestination);osc.start(a.currentTime+when);osc.stop(a.currentTime+when+Math.max(.13,d)+.03)}
function startKeyboardVoice(pitch){
  const audio=context(),oscillator=audio.createOscillator(),gain=audio.createGain(),now=audio.currentTime;
  oscillator.type='sine';oscillator.frequency.value=freq(pitch);gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.14*Number($('#volume').value)+.001,now+.018);
  oscillator.connect(gain).connect(audio.destination);oscillator.start(now);return {oscillator,gain,stopped:false};
}
function stopKeyboardVoice(voice){
  if(!voice||voice.stopped)return;voice.stopped=true;const audio=context(),now=audio.currentTime;
  voice.gain.gain.cancelScheduledValues(now);voice.gain.gain.setValueAtTime(Math.max(.0001,voice.gain.gain.value),now);voice.gain.gain.exponentialRampToValueAtTime(.0001,now+.08);
  voice.oscillator.stop(now+.1);
}
function syncMuteButton(){
  const hasMusic=Boolean(isAudio||backingUrl);if(!hasMusic)songMuted=false;const button=$('#muteSong');button.disabled=!hasMusic;button.classList.toggle('active',songMuted);button.setAttribute('aria-pressed',String(songMuted));$('#muteSongLabel').textContent=songMuted?'Music off':'Music on';$('#audio').muted=songMuted;$('#backingAudio').muted=songMuted;updateMediaGains();
}
function setSongMuted(muted){songMuted=Boolean(muted)&&Boolean(isAudio||backingUrl);syncMuteButton();rebuildPlayedQueue(time)}
async function assetFromFile(file){return {name:file.name,type:file.type||'application/octet-stream',bytes:await file.arrayBuffer()}}
function assetToDataUrl(asset){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error||new Error('Could not package media.'));reader.readAsDataURL(new Blob([asset.bytes],{type:asset.type}))})}
async function assetFromPayload(payload){if(!payload?.dataUrl)return null;const response=await fetch(payload.dataUrl);return {name:String(payload.name||'media'),type:String(payload.type||response.headers.get('content-type')||'application/octet-stream'),bytes:await response.arrayBuffer()}}
function clearSourceMedia(){
  const media=$('#audio');media.pause();media.removeAttribute('src');media.load();if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=null;sourceMediaAsset=null;isAudio=false;updateMediaGains();
}
function attachSourceAsset(asset){
  if(audioUrl)URL.revokeObjectURL(audioUrl);sourceMediaAsset=asset;audioUrl=URL.createObjectURL(new Blob([asset.bytes],{type:asset.type}));$('#audio').src=audioUrl;$('#audio').volume=mediaGraph?1:Number($('#volume').value);isAudio=true;
}
function noteTimelineEnd(list=notes){return list.length?Math.max(...list.map(note=>note.start+note.duration)):0}
function recalculateDuration(){duration=Math.max(.1,sourceDuration,noteTimelineEnd(),backingUrl?backingOffset+backingDuration:0);$('#duration').textContent='/ '+format(duration)}
function updateBackingControls(){
  $('#backingName').textContent=backingUrl?backingName:'NO BACKSOUND';$('#backingName').title=backingUrl?backingName:'';$('#backingOffset').value=backingOffset.toFixed(2);$('#backingRemove').disabled=!backingUrl;$('#backingNudgeBack').disabled=!backingUrl;$('#backingNudgeForward').disabled=!backingUrl;syncMuteButton();
}
function clearBackingTrack(recalculate=true){
  const media=$('#backingAudio');media.pause();media.removeAttribute('src');media.load();if(backingUrl)URL.revokeObjectURL(backingUrl);
  backingUrl=null;backingName='';backingDuration=0;backingOffset=0;backingMediaAsset=null;updateBackingControls();updateMediaGains();if(recalculate)recalculateDuration();
}
function setMediaPosition(media,timeline,offset=0){
  if(!media.src)return false;const mediaTime=timeline-offset;
  if(mediaTime<0||!Number.isFinite(media.duration)||mediaTime>=media.duration){media.pause();return false}
  if(Math.abs(media.currentTime-mediaTime)>.18)media.currentTime=Math.max(0,mediaTime);return true;
}
function syncTimelineMedia(timeline,shouldPlay){
  const primaryReady=isAudio&&setMediaPosition($('#audio'),timeline,0),backingReady=Boolean(backingUrl)&&setMediaPosition($('#backingAudio'),timeline,backingOffset);
  for(const [media,ready] of [[$('#audio'),primaryReady],[$('#backingAudio'),backingReady]]){
    if(shouldPlay&&ready&&media.paused)media.play().catch(error=>{if(!exporting)$('#info').textContent='Playback blocked: '+error.message});
    else if((!shouldPlay||!ready)&&!media.paused)media.pause();
  }
}
async function attachBackingAsset(asset){
  const media=$('#backingAudio'),nextUrl=URL.createObjectURL(new Blob([asset.bytes],{type:asset.type})),previous={url:backingUrl,name:backingName,duration:backingDuration,asset:backingMediaAsset};media.pause();
  try{
    const metadataReady=new Promise((resolve,reject)=>{const loaded=()=>{cleanup();resolve()};const failed=()=>{cleanup();reject(new Error('This file has no browser-decodable audio track.'))};const cleanup=()=>{media.removeEventListener('loadedmetadata',loaded);media.removeEventListener('error',failed)};media.addEventListener('loadedmetadata',loaded);media.addEventListener('error',failed)});media.src=nextUrl;media.load();await metadataReady;
    if(previous.url)URL.revokeObjectURL(previous.url);backingUrl=nextUrl;backingName=asset.name;backingDuration=media.duration;backingMediaAsset=asset;updateBackingControls();recalculateDuration();updateMediaGains();syncTimelineMedia(time,playing);return true;
  }catch(error){URL.revokeObjectURL(nextUrl);backingUrl=previous.url;backingName=previous.name;backingDuration=previous.duration;backingMediaAsset=previous.asset;if(previous.url){media.src=previous.url;media.load()}else{media.removeAttribute('src');media.load()}throw error}
}
async function loadBackingFile(file){
  if(!file)return;const isMedia=/^(audio|video)\//.test(file.type)||/\.(mp3|wav|ogg|m4a|mp4|aac|webm|mov)$/i.test(file.name);if(!isMedia){$('#info').textContent='Choose an audio or video file for the backing track.';return}
  try{await attachBackingAsset(await assetFromFile(file));persistProject();$('#info').textContent=`Backsound ready · ${format(backingDuration)} · drag its bar or adjust START to align it.`}catch(error){$('#info').textContent=error.message}
}
function demo(){if(recording)return;if(!editorRoot.hidden)closeEditor(true);clearBackingTrack(false);clearSourceMedia();const seq=[24,26,28,29,31,33,35,33,31,29,28,26,24,28,31,35,33,31,29,28,26,24],holds=[.3,.3,.3,.72,.3,.3,.82,.3,.3,.65,.3,.3,.9,.3,.3,.7,.3,.3,.62,.3,.3,.95];notes=seq.map((pitch,i)=>({pitch,start:i*.46+.65,duration:holds[i],amplitude:.8}));sourceDuration=notes.at(-1).start+notes.at(-1).duration+.65;duration=sourceDuration;currentSourceName='klung-demo';$('#songTitle').textContent='Nusantara Melody';$('#songSubtitle').textContent='';finishLoad('Demo ready.');}
function finishLoad(message){pause();q.clear();time=0;ensureNoteIds();recalculateDuration();$('#audio').pause();$('#empty').style.display='none';for(const id of ['play','restart','seek','saveProject','exportVideo','editNotes','hostSession'])$('#'+id).disabled=false;syncMuteButton();$('#noteCount').textContent=notes.length;$('#rangeCount').textContent=notes.filter(n=>n.pitch>=RANGE_MIN&&n.pitch<=RANGE_MAX).length;$('#duration').textContent='/ '+format(duration);$('#info').textContent=message;$('#meterBar').style.width='100%';updateClock();liveSession?.refresh()}
function format(s){let t=Math.max(0,Math.floor(s||0));return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`}
function updateClock(){$('#clock').textContent=format(time);$('#seek').value=duration?Math.round(Math.min(1,time/duration)*1000):0}
function normalizeProjectNote(note){
  const rawPitch=Number(note.pitch);
  return {
    ...note,
    id:typeof note.id==='string'&&note.id?note.id:nextNoteId(),
    pitch:rawPitch>=RANGE_MIN&&rawPitch<=RANGE_MAX?Math.round(rawPitch):foldToAngklungRange(Math.round(rawPitch||RANGE_MIN)),
    start:Math.max(0,Number(note.start)||0),
    duration:Math.max(.08,Number(note.duration)||.08),
    amplitude:Math.max(0,Math.min(1,Number(note.amplitude)||.8)),
  };
}
async function loadProjectData(project,fallbackTitle='Saved Klung project'){
  if(!project||!Array.isArray(project.notes))throw new Error('This is not a valid Klung project file.');
  notes=project.notes.map(normalizeProjectNote).sort((a,b)=>a.start-b.start);
  if(!notes.length)throw new Error('This Klung project does not contain any notes.');
  clearBackingTrack(false);clearSourceMedia();sourceDuration=Math.max(Number(project.sourceDuration??project.duration)||0,...notes.map(note=>note.start+note.duration));duration=sourceDuration;currentSourceName=String(project.sourceName||fallbackTitle);
  const settings=project.settings||{};lead=clamp(Number(settings.lead)||3,1.5,7);$('#lead').value=String(lead);$('#leadText').textContent=lead.toFixed(1)+'s';const savedVolume=clamp(Number(settings.volume??.7),0,1);$('#volume').value=String(savedVolume);$('#volText').textContent=Math.round(savedVolume*100)+'%';
  if(project.media?.source){attachSourceAsset(await assetFromPayload(project.media.source));songMuted=Boolean(settings.songMuted)}else{isAudio=false;songMuted=false}
  if(project.media?.backing){await attachBackingAsset(await assetFromPayload(project.media.backing));backingOffset=roundTime(Number(settings.backingOffset??project.backing?.offset)||0);updateBackingControls()}
  updateMediaGains();recalculateDuration();
  $('#songTitle').textContent=String(project.title||fallbackTitle).slice(0,48);
  $('#songSubtitle').textContent='';
  finishLoad(`Project ready · ${notes.length} notes${project.media?.source?' + song':''}${project.media?.backing?' + backsound':''}.`);
}
async function loadFile(file){if(!file)return;if(!editorRoot.hidden)closeEditor(true);pause();clearBackingTrack(false);currentSourceName=file.name;$('#empty').style.display='none';$('#info').textContent='Loading…';$('#meterBar').style.width='3%';$('#songTitle').textContent=file.name.replace(/\.[^.]+$/,'').slice(0,48);$('#songSubtitle').textContent='';try{
clearSourceMedia();
if(/\.(json|klung)$/i.test(file.name)){
  await loadProjectData(JSON.parse(await file.text()),file.name.replace(/\.(klung\.)?json$|\.klung$/i,''));return;
}
if(/\.mid(i)?$/i.test(file.name)){
  const midi=new Midi(await file.arrayBuffer()); notes=foldAndDeduplicate(midi.tracks.flatMap(t=>t.notes.map(n=>({pitch:n.midi,start:n.time,duration:n.duration,amplitude:n.velocity}))));sourceDuration=midi.duration;duration=sourceDuration;finishLoad(`MIDI ready · ${notes.length} notes.`);return;
}
const audioExt=/\.(m4a|mp4|aac)$/i.test(file.name);
const a=context();await a.resume();
let buf;const sourceAsset=await assetFromFile(file);
try {
  // Chrome and Edge decode standard iPhone Voice Memos M4A (AAC) via Web Audio.
  // The extension alone doesn't guarantee a supported codec (e.g. ALAC).
  buf=await a.decodeAudioData(sourceAsset.bytes.slice(0));
} catch(decodeError) {
  throw new Error(audioExt
    ? 'This M4A codec could not be decoded by your browser. Open the app in the latest Chrome or Edge. iPhone Voice Memos AAC recordings are supported; ALAC or unusual codecs may require conversion to WAV.'
    : 'Your browser could not decode this audio. Try MP3, WAV, or an iPhone Voice Memos M4A (AAC) recording.');
}
if(!Number.isFinite(buf.duration)||buf.duration<=0)throw new Error('This audio file is empty or invalid');
attachSourceAsset(sourceAsset);songMuted=false;$('#audio').muted=false;sourceDuration=buf.duration;duration=sourceDuration;
const analysisBuffer=await resampleForBasicPitch(buf);
$('#info').textContent='Loading note model…';
const config=await fetch('/model-path.json');if(!config.ok)throw new Error('AI model files missing. Run npm install in the project folder.');const {path}=await config.json();
const bp=new BasicPitch(path),frames=[],onsets=[];
await bp.evaluateModel(analysisBuffer,(f,o)=>{frames.push(...f);onsets.push(...o)},p=>{$('#meterBar').style.width=`${Math.round(5+p*90)}%`;$('#info').textContent=`Analyzing · ${Math.round(p*100)}%`});
const rawEvents=outputToNotesPoly(
  frames,onsets,detection.onsetThreshold,detection.frameThreshold,detection.minNoteFrames,
  false,null,null,false,6
);
notes=extractSinglePressMelody(rawEvents,onsets,duration);
finishLoad(`Ready · ${notes.length} notes.`);
}catch(err){console.error(err);$('#info').textContent='Could not load file: '+(err?.message||err);$('#meterBar').style.width='0%';}}
function syncPlayButtons(){const label=pendingPlayTimer?'…':playing?'Ⅱ':'▶';$('#play').textContent=label;const livePlay=$('#editorPlay');if(livePlay)livePlay.textContent=label}
function pause(broadcast=true){
  if(pendingPlayTimer){clearTimeout(pendingPlayTimer);pendingPlayTimer=null;time=pendingPlayPosition}
  if(playing)time=Math.min(duration,initialTime+(performance.now()-startedAt)/1000);playing=false;syncTimelineMedia(time,false);syncPlayButtons();if(broadcast)liveSession?.broadcastPause(time);
}
function startPlaybackAt(position,executeAt=Date.now()){
  pendingPlayTimer=null;const late=Math.max(0,(Date.now()-executeAt)/1000);time=clamp(position+late,0,duration);playing=true;initialTime=time;startedAt=performance.now();lastLiveSyncAt=startedAt;rebuildPlayedQueue(time);syncTimelineMedia(time,true);syncPlayButtons();$('#liveSessionModal').hidden=true;
}
async function play(){
  if(!notes.length||exporting)return;if(playing||pendingPlayTimer){pause();return}
  try{ensureMediaGraph();$('#audio').volume=$('#backingAudio').volume=1;await Promise.race([context().resume(),new Promise(resolve=>setTimeout(resolve,250))])}catch(error){console.warn('Could not prepare audio playback',error)}
  if(time>=duration-.05){time=0;q.clear()}const scheduled=liveSession?.preparePlay(time);
  if(scheduled?.blocked){$('#info').textContent=scheduled.message;liveSession.show();return}
  if(scheduled?.executeAt){pendingPlayPosition=time;pendingPlayTimer=setTimeout(()=>startPlaybackAt(pendingPlayPosition,scheduled.executeAt),Math.max(0,scheduled.executeAt-Date.now()));syncPlayButtons();$('#info').textContent='Everyone starts together in a moment…';return}
  startPlaybackAt(time);
}
function rebuildPlayedQueue(at=time){q.clear();for(const note of visibleNotes())if(note.start<at-.06)q.add(note.id)}
function seekTo(nextTime){
  time=clamp(Number(nextTime)||0,0,duration);if(playing){initialTime=time;startedAt=performance.now()}
  syncTimelineMedia(time,playing);
  rebuildPlayedQueue(time);updateClock();liveSession?.broadcastSeek(time,playing);
}
function reset(){pause();seekTo(0)}

const editorRoot=$('#liveEditor'),arrangementCanvas=$('#arrangementCanvas'),arrangementCtx=arrangementCanvas.getContext('2d');
let editorNotes=[],selectedNoteId=null,editorDirty=false,editorDrag=null,noteHitRegions=[],noteClipboard=null,arrangementDrag=null,arrangementHitRegions=[];
for(let pitch=RANGE_MIN;pitch<=RANGE_MAX;pitch++){
  const option=document.createElement('option');option.value=String(pitch);option.textContent=`${pitchName(pitch)}1`;$('#editorPitch').append(option);
}
function roundTime(value){return Math.round(value*100)/100}
function clamp(value,min,max){return Math.min(max,Math.max(min,value))}
function selectedEditorNote(){return editorNotes.find(note=>note.id===selectedNoteId)||null}
function visibleNotes(){if(recording)return recordedNotes;return editorRoot.hidden?notes:editorNotes}
function setEditorDirty(){editorDirty=true}
function refreshEditedNoteSchedule(note){if(note.start>time+.06)q.delete(note.id);else q.add(note.id)}
function projectPayload(){return {format:'Klung! Project',version:5,title:$('#songTitle').textContent||'My Klung Song',sourceName:currentSourceName,duration,sourceDuration,backing:backingName?{name:backingName,offset:backingOffset}:null,settings:{lead,volume:Number($('#volume').value),songMuted,backingOffset},notes:notes.map(note=>({...note}))}}
function persistProject(){try{localStorage.setItem('klung:lastProject',JSON.stringify(projectPayload()))}catch(error){console.warn('Could not persist Klung project',error)}}
async function saveProjectFile(){
  if(!notes.length)return;const button=$('#saveProject'),original=button.innerHTML;button.disabled=true;button.textContent='PACKING…';persistProject();$('#info').textContent='Packing notes, song, backsound, and playback settings into one project…';
  try{
    const project={...projectPayload(),format:'Klung! Project',version:5,createdAt:new Date().toISOString(),media:{source:sourceMediaAsset?{name:sourceMediaAsset.name,type:sourceMediaAsset.type,dataUrl:await assetToDataUrl(sourceMediaAsset)}:null,backing:backingMediaAsset?{name:backingMediaAsset.name,type:backingMediaAsset.type,dataUrl:await assetToDataUrl(backingMediaAsset)}:null}};
    const blob=new Blob([JSON.stringify(project)],{type:'application/json'}),link=document.createElement('a'),safeName=(project.title||'klung-project').replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'klung-project';link.href=URL.createObjectURL(blob);link.download=`${safeName}.klung-project.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),2000);$('#info').textContent=`Project saved · notes${sourceMediaAsset?' + song':''}${backingMediaAsset?' + backsound':''} + playback settings.`;
  }catch(error){console.error(error);$('#info').textContent='Could not save project: '+(error?.message||error)}finally{button.innerHTML=original;button.disabled=false}
}
function drawExportFrame(target,timeline,exportNotes){
  const c=target.getContext('2d'),w=target.width,h=target.height,headerH=72,keysH=104,footerH=28,fieldY=headerH,fieldH=h-headerH-keysH-footerH,lineY=fieldY+fieldH-34,travel=fieldH-58,lane=w/whites.length;
  c.clearRect(0,0,w,h);c.fillStyle='#101a19';c.fillRect(0,0,w,h);
  c.fillStyle='#172423';c.fillRect(0,0,w,headerH);c.strokeStyle='rgba(255,255,255,.1)';c.beginPath();c.moveTo(0,headerH-.5);c.lineTo(w,headerH-.5);c.stroke();
  c.fillStyle='#ffcf52';c.font='800 30px Outfit, sans-serif';c.textAlign='left';c.textBaseline='middle';c.fillText('Klung!',28,headerH/2);
  c.fillStyle='#f2eee3';c.font='600 25px Outfit, sans-serif';c.textAlign='center';c.fillText(($('#songTitle').textContent||'Klung!').slice(0,54),w/2,headerH/2);
  c.fillStyle='#cbb785';c.font='700 16px DM Sans, sans-serif';c.textAlign='right';c.fillText('C1 — B1',w-28,headerH/2);
  const bg=c.createLinearGradient(0,fieldY,w,fieldY+fieldH);bg.addColorStop(0,'#192c26');bg.addColorStop(.55,'#1b302b');bg.addColorStop(1,'#12221f');c.fillStyle=bg;c.fillRect(0,fieldY,w,fieldH);
  c.save();c.strokeStyle='rgba(207,186,143,.057)';c.lineWidth=1;
  for(let x=70;x<w+140;x+=150){for(let y=fieldY+60;y<fieldY+fieldH+140;y+=150){for(let k=0;k<4;k++){const angle=k*Math.PI/2,px=x+Math.cos(angle)*20,py=y+Math.sin(angle)*20;c.save();c.translate(px,py);c.rotate(angle);c.beginPath();c.ellipse(0,0,21,12,0,0,Math.PI*2);c.stroke();c.restore()}c.beginPath();c.arc(x,y,3,0,Math.PI*2);c.stroke()}}c.restore();
  for(let i=0;i<whites.length;i++){const x=i*lane;if(i%2===0){c.fillStyle='rgba(245,233,209,.025)';c.fillRect(x,fieldY,lane,fieldH)}c.strokeStyle='rgba(235,227,204,.10)';c.beginPath();c.moveTo(x+.5,fieldY);c.lineTo(x+.5,fieldY+fieldH);c.stroke()}
  c.strokeStyle='rgba(232,221,193,.12)';for(let i=1;i<=4;i++){const y=lineY-travel*i/4;c.setLineDash([2,9]);c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke()}c.setLineDash([]);
  const activePitches=new Set();
  for(const note of exportNotes){
    if(note.pitch<RANGE_MIN||note.pitch>RANGE_MAX)continue;const dt=note.start-timeline;if(dt>lead||dt<-note.duration-.22)continue;
    const pps=travel/lead,x=laneCenter(note.pitch,w),isBlack=!whiteSet.has(note.pitch),headY=lineY-dt*pps,width=lane*(isBlack?.58:.82),noteH=Math.max(18,note.duration*pps),topY=headY-noteH,color=noteColor(note.pitch),radius=Math.min(8,noteH/2);
    if(dt<=.08&&dt>=-note.duration)activePitches.add(note.pitch);c.shadowColor=color;c.shadowBlur=dt<.12&&dt>-note.duration?24:10;c.fillStyle=color;round(c,x-width/2,topY,width,noteH,radius);c.fill();c.shadowBlur=0;c.strokeStyle=noteOutline(note.pitch);c.lineWidth=2;c.stroke();
    const shade=c.createLinearGradient(x-width/2,0,x+width/2,0);shade.addColorStop(0,'rgba(0,0,0,.16)');shade.addColorStop(.4,'rgba(255,255,255,.12)');shade.addColorStop(1,'rgba(0,0,0,.08)');c.fillStyle=shade;round(c,x-width/2,topY,width,noteH,radius);c.fill();c.fillStyle='rgba(255,255,255,.74)';round(c,x-width/2+2,headY-4,width-4,3,1.5);c.fill();
  }
  c.fillStyle='rgba(235,192,135,.12)';c.fillRect(0,lineY-9,w,20);c.shadowColor='#e9b77d';c.shadowBlur=13;c.fillStyle='#ecc28b';c.fillRect(0,lineY,w,3);c.shadowBlur=0;c.fillStyle='#e0bf91';c.font='700 12px DM Sans, sans-serif';c.textAlign='left';c.fillText('HIT',18,lineY-15);
  const keyY=fieldY+fieldH,keyW=w/whites.length;
  for(let i=0;i<whites.length;i++){const pitch=whites[i],x=i*keyW,active=activePitches.has(pitch);c.fillStyle=active?noteColor(pitch):'#eee9dc';c.fillRect(x,keyY,keyW,keysH);c.strokeStyle='#9ea7a3';c.strokeRect(x+.5,keyY+.5,keyW-1,keysH-1);c.fillStyle=noteColor(pitch);c.fillRect(x,keyY,keyW,6);c.fillStyle=active?noteInk(pitch):'#3b4742';c.font='700 15px DM Sans, sans-serif';c.textAlign='center';c.fillText(pitchName(pitch),x+keyW/2,keyY+keysH-18)}
  for(const pitch of black){const x=laneCenter(pitch,w),width=keyW*.43,active=activePitches.has(pitch);c.fillStyle=active?noteColor(pitch):'#18211f';c.fillRect(x-width/2,keyY,width,keysH*.63);c.strokeStyle=noteOutline(pitch);c.lineWidth=1.5;c.strokeRect(x-width/2+.5,keyY+.5,width-1,keysH*.63-1);c.fillStyle=active?noteInk(pitch):'#d3dbd7';c.font='700 12px DM Sans, sans-serif';c.textAlign='center';c.fillText(pitchName(pitch),x,keyY+keysH*.63-15)}
  c.fillStyle='#14201e';c.fillRect(0,h-footerH,w,footerH);c.fillStyle='#8fa29b';c.font='700 10px DM Sans, sans-serif';c.textAlign='left';c.fillText('KLUNG! PERFORMANCE',18,h-footerH/2);c.textAlign='right';c.fillText(format(Math.max(0,timeline)),w-18,h-footerH/2);
}
function videoMimeType(){
  if(!window.MediaRecorder)return '';
  const candidates=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];return typeof MediaRecorder.isTypeSupported==='function'?candidates.find(type=>MediaRecorder.isTypeSupported(type))||'':'video/webm';
}
function setExportingControls(active){
  exporting=active;for(const id of ['file','projectFile','demo','record','play','restart','seek','editNotes','saveProject','exportVideo','hostSession'])$('#'+id).disabled=active||(!notes.length&&['play','restart','seek','editNotes','saveProject','exportVideo','hostSession'].includes(id));for(const id of ['lead','volume'])$('#'+id).disabled=active;$('#muteSong').disabled=active||!(isAudio||backingUrl);$('#dropZone').classList.toggle('disabled',active);$('#exportVideo').classList.toggle('exporting',active);
}
async function exportVideo(){
  if(exporting||!notes.length)return;const mimeType=videoMimeType();
  if(!mimeType||!HTMLCanvasElement.prototype.captureStream){$('#info').textContent='Video export needs a current Chrome, Edge, Firefox, or Safari browser.';return}
  pause();const restoreTime=time,exportNotes=notes.map(note=>({...note})).sort((a,b)=>a.start-b.start),timelineStart=exportNotes[0].start-lead,timelineEnd=Math.max(noteTimelineEnd(exportNotes)+.75,isAudio?sourceDuration:0,backingUrl?backingOffset+backingDuration:0),total=Math.max(.5,timelineEnd-timelineStart);
  const exportCanvas=document.createElement('canvas');exportCanvas.width=1280;exportCanvas.height=720;drawExportFrame(exportCanvas,timelineStart,exportNotes);const canvasStream=exportCanvas.captureStream(30),audio=context(),graph=ensureMediaGraph(),mix=audio.createMediaStreamDestination();
  $('#audio').volume=$('#backingAudio').volume=1;updateMediaGains();graph.primaryGain.connect(mix);graph.backingGain.connect(mix);exportAudioDestination=mix;
  const stream=new MediaStream([...canvasStream.getVideoTracks(),...mix.stream.getAudioTracks()]),recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:8_000_000}),chunks=[];recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};
  const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=event=>reject(event.error||new Error('Video recorder failed.'))});
  const button=$('#exportVideo');setExportingControls(true);button.lastChild.textContent=' 0%';$('#info').textContent='Rendering video in real time · 0%';$('#meterBar').style.width='0%';q.clear();
  try{
    await audio.resume();recorder.start(250);const realStart=performance.now();let previousTimeline=timelineStart;
    await new Promise(resolve=>{
      const frame=now=>{
        const timeline=Math.min(timelineEnd,timelineStart+(now-realStart)/1000);time=clamp(timeline,0,duration);syncTimelineMedia(timeline,true);
        if(!isAudio||songMuted){for(const note of exportNotes)if(note.start>previousTimeline&&note.start<=timeline)beep(note.pitch,0,Math.min(note.duration,3))}
        drawExportFrame(exportCanvas,timeline,exportNotes);previousTimeline=timeline;const progress=clamp((timeline-timelineStart)/total,0,1),percent=Math.round(progress*100);button.lastChild.textContent=` ${percent}%`;$('#info').textContent=`Rendering video in real time · ${percent}%`;$('#meterBar').style.width=`${percent}%`;
        if(timeline>=timelineEnd){resolve();return}requestAnimationFrame(frame);
      };requestAnimationFrame(frame);
    });
    syncTimelineMedia(timelineEnd,false);recorder.stop();await stopped;const blob=new Blob(chunks,{type:mimeType}),link=document.createElement('a'),safeName=($('#songTitle').textContent||'klung-performance').replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'klung-performance',extension=mimeType.startsWith('video/mp4')?'mp4':'webm';link.href=URL.createObjectURL(blob);link.download=`${safeName}.${extension}`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),2000);$('#info').textContent=`Video saved as ${extension.toUpperCase()} · starts when the first note enters.`;$('#meterBar').style.width='100%';
  }catch(error){console.error(error);if(recorder.state!=='inactive')recorder.stop();$('#info').textContent='Could not export video: '+(error?.message||error);$('#meterBar').style.width='0%';
  }finally{
    syncTimelineMedia(time,false);exportAudioDestination=null;try{graph.primaryGain.disconnect(mix);graph.backingGain.disconnect(mix)}catch{}for(const track of stream.getTracks())track.stop();time=restoreTime;syncTimelineMedia(time,false);rebuildPlayedQueue(time);updateClock();setExportingControls(false);button.innerHTML='<span>▶</span> VIDEO';
  }
}
function updateEditorInspector(){
  const note=selectedEditorNote();
  for(const element of [$('#editorPitch'),$('#editorStart'),$('#editorLength'),$('#editorDelete'),$('#editorCopy')])element.disabled=!note;$('#editorPaste').disabled=!noteClipboard;
  $('#liveSelection').textContent=note?`${pitchName(note.pitch)}1  ·  ${note.start.toFixed(2)}s`:'SELECT A NOTE';
  if(!note){$('#editorPitch').value=String(RANGE_MIN);$('#editorStart').value='';$('#editorLength').value='';return}
  $('#editorPitch').value=String(note.pitch);$('#editorStart').value=note.start.toFixed(2);$('#editorLength').value=note.duration.toFixed(2);
}
function selectEditorNote(id){
  selectedNoteId=id;updateEditorInspector();
}
function openEditor(){
  if(!notes.length)return;editorNotes=notes.map(note=>({...note,id:note.id||nextNoteId()}));selectedNoteId=null;editorDirty=false;editorDrag=null;arrangementDrag=null;editorRoot.hidden=false;document.body.classList.add('editor-open');$('#stage').classList.add('live-editing');$('#editNotes').classList.add('active');$('#editNotes').lastChild.textContent=' EDITING';for(const id of ['saveProject','exportVideo','hostSession'])$('#'+id).disabled=true;updateBackingControls();updateEditorInspector();syncPlayButtons();renderArrangement();
}
function closeEditor(force=false){
  if(!force&&editorDirty&&!window.confirm('Discard your unsaved note edits?'))return;
  const discarded=editorDirty;if(discarded){q.clear();for(const note of notes)if(note.start<=time+.06)q.add(note.id)}editorDirty=false;
  editorRoot.hidden=true;document.body.classList.remove('editor-open');$('#stage').classList.remove('live-editing');$('#editNotes').classList.remove('active');$('#editNotes').lastChild.textContent=' EDIT';for(const id of ['saveProject','exportVideo','hostSession'])$('#'+id).disabled=!notes.length;selectedNoteId=null;editorDrag=null;arrangementDrag=null;noteHitRegions=[];arrangementHitRegions=[];
}
function saveEditorChanges(){
  notes=editorNotes.map(note=>({...note})).sort((a,b)=>a.start-b.start);if(!isAudio)sourceDuration=Math.max(sourceDuration,noteTimelineEnd(notes)+.45);recalculateDuration();editorDirty=false;persistProject();closeEditor(true);$('#noteCount').textContent=notes.length;$('#rangeCount').textContent=notes.length;$('#duration').textContent='/ '+format(duration);$('#info').textContent='Edits saved.';liveSession?.refresh();
}
async function copySelectedEditorNote(){
  const note=selectedEditorNote();if(!note)return;noteClipboard={pitch:note.pitch,sourcePitch:note.sourcePitch,duration:note.duration,amplitude:note.amplitude};$('#editorPaste').disabled=false;$('#info').textContent=`Copied ${pitchName(note.pitch)}1.`;
  try{await navigator.clipboard?.writeText(JSON.stringify({type:'klung-note',...noteClipboard}))}catch{}
}
function pasteEditorNote(){
  if(!noteClipboard)return;const selected=selectedEditorNote(),start=roundTime(clamp(selected?selected.start+selected.duration+.05:time,0,Math.max(0,duration-noteClipboard.duration)));
  const note={...noteClipboard,id:nextNoteId(),start};editorNotes.push(note);selectEditorNote(note.id);refreshEditedNoteSchedule(note);setEditorDirty();$('#info').textContent=`Pasted ${pitchName(note.pitch)}1 at ${note.start.toFixed(2)}s.`;
}
function deleteSelectedEditorNote(){
  if(!selectedNoteId)return;q.delete(selectedNoteId);editorNotes=editorNotes.filter(note=>note.id!==selectedNoteId);selectedNoteId=null;setEditorDirty();updateEditorInspector();
}
function pitchAtX(x,width){return all.reduce((closest,pitch)=>Math.abs(laneCenter(pitch,width)-x)<Math.abs(laneCenter(closest,width)-x)?pitch:closest,RANGE_MIN)}
function arrangementGeometry(width,height){
  const gutter=clamp(width*.115,82,122),left=gutter+13,right=18,rulerBottom=30,backingY=38,backingH=clamp(height*.16,42,65),notesY=backingY+backingH+20,notesBottom=Math.max(notesY+96,height-12),laneH=(notesBottom-notesY)/all.length;
  const first=Math.min(0,backingUrl?backingOffset:0)-.25,last=Math.max(1,duration,noteTimelineEnd(editorNotes),backingUrl?backingOffset+backingDuration:0)+.35,span=Math.max(1,last-first),timelineWidth=Math.max(80,width-left-right),pps=timelineWidth/span;
  return {width,height,gutter,left,right,rulerBottom,backingY,backingH,notesY,notesBottom,laneH,first,last,span,timelineWidth,pps,xAt:value=>left+(value-first)*pps,timeAt:x=>first+(x-left)/pps};
}
function arrangementPitchAtY(y,geometry){return clamp(RANGE_MAX-Math.floor((y-geometry.notesY)/geometry.laneH),RANGE_MIN,RANGE_MAX)}
function arrangementTickStep(span){return [0.25,.5,1,2,5,10,15,30,60,120,300].find(step=>span/step<=11)||600}
function renderArrangement(){
  if(editorRoot.hidden)return;const bounds=arrangementCanvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2),w=bounds.width,h=bounds.height;if(!w||!h)return;
  if(arrangementCanvas.width!==Math.round(w*dpr)||arrangementCanvas.height!==Math.round(h*dpr)){arrangementCanvas.width=Math.round(w*dpr);arrangementCanvas.height=Math.round(h*dpr)}
  const c=arrangementCtx,g=arrangementGeometry(w,h);c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);c.fillStyle='#0b1413';c.fillRect(0,0,w,h);arrangementHitRegions=[];
  c.fillStyle='#71847e';c.font='800 9px DM Sans';c.textAlign='right';c.textBaseline='middle';c.fillText('BACKSOUND',g.gutter,g.backingY+g.backingH/2);c.fillText('NOTES',g.gutter,g.notesY+12);
  const step=arrangementTickStep(g.span),firstTick=Math.ceil(g.first/step)*step;c.textAlign='center';c.textBaseline='top';c.font='700 8px DM Sans';
  for(let tick=firstTick;tick<=g.last+.001;tick+=step){const x=g.xAt(tick);c.strokeStyle='rgba(255,255,255,.09)';c.beginPath();c.moveTo(x,g.rulerBottom);c.lineTo(x,g.notesBottom);c.stroke();c.fillStyle='#70827c';c.fillText(tick<0?`−${Math.abs(tick).toFixed(step<1?1:0)}s`:`${tick.toFixed(step<1?1:0)}s`,x,11)}
  c.fillStyle='#101d1b';c.fillRect(g.left,g.backingY,g.timelineWidth,g.backingH);c.strokeStyle='#2d403b';c.strokeRect(g.left+.5,g.backingY+.5,g.timelineWidth-1,g.backingH-1);
  if(backingUrl){
    const x=g.xAt(backingOffset),barW=Math.max(8,backingDuration*g.pps);c.fillStyle='#275d55';c.beginPath();c.roundRect(x,g.backingY+7,barW,g.backingH-14,6);c.fill();c.strokeStyle='#6dd5c5';c.lineWidth=1.5;c.stroke();c.save();c.beginPath();c.rect(x+3,g.backingY+10,Math.max(0,barW-6),g.backingH-20);c.clip();c.strokeStyle='rgba(176,255,240,.64)';c.lineWidth=1;
    for(let px=x+7,index=0;px<x+barW-5;px+=5,index++){const amp=(.2+Math.abs(Math.sin(index*.73))* .75)*(g.backingH-25)/2;c.beginPath();c.moveTo(px,g.backingY+g.backingH/2-amp);c.lineTo(px,g.backingY+g.backingH/2+amp);c.stroke()}c.restore();c.fillStyle='#d6fff8';c.font='800 9px DM Sans';c.textAlign='left';c.textBaseline='middle';c.fillText(backingName.slice(0,34),x+9,g.backingY+g.backingH/2);arrangementHitRegions.push({type:'backing',x,y:g.backingY+7,width:barW,height:g.backingH-14});
  }else{c.fillStyle='#61726c';c.font='700 9px DM Sans';c.textAlign='left';c.textBaseline='middle';c.fillText('Upload a backsound above to add its audio track',g.left+12,g.backingY+g.backingH/2)}
  for(let laneIndex=0;laneIndex<all.length;laneIndex++){const pitch=RANGE_MAX-laneIndex,y=g.notesY+laneIndex*g.laneH;c.fillStyle=laneIndex%2?'#0e1917':'#111e1b';c.fillRect(g.left,y,g.timelineWidth,g.laneH);c.strokeStyle='rgba(255,255,255,.055)';c.beginPath();c.moveTo(g.left,y+.5);c.lineTo(g.left+g.timelineWidth,y+.5);c.stroke();c.fillStyle=noteColor(pitch);c.font='800 8px DM Sans';c.textAlign='right';c.textBaseline='middle';c.fillText(`${pitchName(pitch)}1`,g.gutter,y+g.laneH/2)}
  for(const note of editorNotes){
    const laneIndex=RANGE_MAX-note.pitch,y=g.notesY+laneIndex*g.laneH+2,x=g.xAt(note.start),noteW=Math.max(5,note.duration*g.pps),noteH=Math.max(5,g.laneH-4),selected=note.id===selectedNoteId;c.fillStyle=noteColor(note.pitch);c.beginPath();c.roundRect(x,y,noteW,noteH,Math.min(4,noteH/2));c.fill();c.strokeStyle=selected?'#fff':noteOutline(note.pitch);c.lineWidth=selected?2.5:1;c.stroke();arrangementHitRegions.push({type:'note',noteId:note.id,x,y,width:noteW,height:noteH});
  }
  const playheadX=g.xAt(time);if(playheadX>=g.left&&playheadX<=g.left+g.timelineWidth){c.strokeStyle='#ffcf52';c.lineWidth=2;c.beginPath();c.moveTo(playheadX,g.rulerBottom);c.lineTo(playheadX,g.notesBottom);c.stroke();c.fillStyle='#ffcf52';c.beginPath();c.moveTo(playheadX-5,g.rulerBottom);c.lineTo(playheadX+5,g.rulerBottom);c.lineTo(playheadX,g.rulerBottom+7);c.closePath();c.fill()}
  $('#arrangementClock').textContent=`${format(time)} / ${format(duration)}`;
}
arrangementCanvas.addEventListener('pointerdown',event=>{
  if(editorRoot.hidden)return;event.preventDefault();const bounds=arrangementCanvas.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top,g=arrangementGeometry(bounds.width,bounds.height),region=[...arrangementHitRegions].reverse().find(item=>x>=item.x&&x<=item.x+item.width&&y>=item.y&&y<=item.y+item.height);
  if(region?.type==='backing'){arrangementDrag={pointerId:event.pointerId,type:'backing',startClientX:event.clientX,originalOffset:backingOffset,pps:g.pps};arrangementCanvas.setPointerCapture?.(event.pointerId);return}
  if(region?.type==='note'){const note=editorNotes.find(item=>item.id===region.noteId);if(!note)return;selectEditorNote(note.id);arrangementDrag={pointerId:event.pointerId,type:'note',noteId:note.id,timeOffset:g.timeAt(x)-note.start};arrangementCanvas.setPointerCapture?.(event.pointerId);return}
  if(x>=g.left&&x<=g.left+g.timelineWidth)seekTo(g.timeAt(x));selectEditorNote(null);
});
canvas.addEventListener('pointerdown',event=>{
  if(editorRoot.hidden)return;event.preventDefault();const bounds=canvas.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
  const region=[...noteHitRegions].reverse().find(item=>x>=item.x&&x<=item.x+item.width&&y>=item.visibleTop&&y<=item.visibleBottom);
  if(!region){selectEditorNote(null);return}
  const note=editorNotes.find(item=>item.id===region.noteId);if(!note)return;const wasSelected=note.id===selectedNoteId;selectEditorNote(note.id);
  const resize=wasSelected&&Math.abs(y-region.visibleTop)<=10;
  editorDrag={pointerId:event.pointerId,mode:resize?'resize':'move',noteId:note.id,original:{...note},pointerToHead:y-region.headY,handleOffset:y-region.topY,pps:region.pps,moved:false};canvas.setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove',event=>{
  if(arrangementDrag&&event.pointerId===arrangementDrag.pointerId){
    event.preventDefault();const bounds=arrangementCanvas.getBoundingClientRect(),g=arrangementGeometry(bounds.width,bounds.height),x=clamp(event.clientX-bounds.left,g.left,g.left+g.timelineWidth),y=clamp(event.clientY-bounds.top,g.notesY,g.notesBottom-.01);
    if(arrangementDrag.type==='backing'){
      backingOffset=roundTime(Math.max(-Math.max(0,backingDuration-.05),arrangementDrag.originalOffset+(event.clientX-arrangementDrag.startClientX)/arrangementDrag.pps));updateBackingControls();recalculateDuration();syncTimelineMedia(time,playing);
    }else{
      const note=editorNotes.find(item=>item.id===arrangementDrag.noteId);if(!note)return;note.start=roundTime(clamp(g.timeAt(x)-arrangementDrag.timeOffset,0,Math.max(0,duration-note.duration)));note.pitch=arrangementPitchAtY(y,g);refreshEditedNoteSchedule(note);setEditorDirty();updateEditorInspector();
    }
    return;
  }
  if(!editorDrag||event.pointerId!==editorDrag.pointerId)return;event.preventDefault();const note=editorNotes.find(item=>item.id===editorDrag.noteId);if(!note)return;
  const bounds=canvas.getBoundingClientRect(),x=clamp(event.clientX-bounds.left,0,bounds.width),y=clamp(event.clientY-bounds.top,0,bounds.height),lineY=bounds.height-42;
  if(editorDrag.mode==='move'){
    const desiredHead=y-editorDrag.pointerToHead;note.start=roundTime(clamp(time+(lineY-desiredHead)/editorDrag.pps,0,Math.max(0,duration-note.duration)));note.pitch=pitchAtX(x,bounds.width);
  }else{
    const headY=lineY-(note.start-time)*editorDrag.pps,desiredTop=y-editorDrag.handleOffset;note.duration=roundTime(clamp((headY-desiredTop)/editorDrag.pps,.08,Math.max(.08,duration-note.start)));
  }
  editorDrag.moved=true;refreshEditedNoteSchedule(note);setEditorDirty();updateEditorInspector();
});
document.addEventListener('pointerup',event=>{if(editorDrag&&event.pointerId===editorDrag.pointerId)editorDrag=null;if(arrangementDrag&&event.pointerId===arrangementDrag.pointerId){arrangementDrag=null;persistProject()}});
arrangementCanvas.addEventListener('wheel',event=>{if(editorRoot.hidden||arrangementDrag||event.ctrlKey||!event.deltaY)return;event.preventDefault();const pixels=event.deltaY*(event.deltaMode===1?18:event.deltaMode===2?arrangementCanvas.clientWidth:1),seconds=clamp(pixels*.006,-2,2);seekTo(time-seconds)},{passive:false});
canvas.addEventListener('wheel',event=>{
  if(editorRoot.hidden||editorDrag||event.ctrlKey||!event.deltaY)return;
  event.preventDefault();
  const pixels=event.deltaY*(event.deltaMode===1?18:event.deltaMode===2?canvas.clientHeight:1);
  let seconds=clamp(pixels*.004,-1.5,1.5);if(Math.abs(seconds)<.06)seconds=Math.sign(seconds)*.06;
  seekTo(time-seconds);
},{passive:false});
$('#editorPitch').addEventListener('change',event=>{const note=selectedEditorNote();if(!note)return;note.pitch=Number(event.target.value);setEditorDirty();updateEditorInspector()});
$('#editorStart').addEventListener('change',event=>{const note=selectedEditorNote();if(!note)return;note.start=roundTime(clamp(Number(event.target.value)||0,0,Math.max(0,duration-note.duration)));refreshEditedNoteSchedule(note);setEditorDirty();updateEditorInspector()});
$('#editorLength').addEventListener('change',event=>{const note=selectedEditorNote();if(!note)return;note.duration=roundTime(clamp(Number(event.target.value)||.08,.08,Math.max(.08,duration-note.start)));setEditorDirty();updateEditorInspector()});
$('#editorPlay').onclick=play;$('#editorCopy').onclick=copySelectedEditorNote;$('#editorPaste').onclick=pasteEditorNote;$('#editorDelete').onclick=deleteSelectedEditorNote;$('#editorCancel').onclick=()=>closeEditor();$('#editorSave').onclick=saveEditorChanges;$('#editNotes').onclick=()=>editorRoot.hidden?openEditor():closeEditor();$('#saveProject').onclick=saveProjectFile;$('#exportVideo').onclick=exportVideo;
function setRecordingControls(active){
  const hasSong=notes.length>0;
  for(const id of ['file','projectFile','demo','centerDemo'])$("#"+id).disabled=active;
  for(const id of ['play','restart','seek','editNotes','saveProject','exportVideo','hostSession'])$("#"+id).disabled=active||!hasSong;
  $('#muteSong').disabled=active||!(isAudio||backingUrl);
  $('#dropZone').classList.toggle('disabled',active);$('#stage').classList.toggle('recording',active);$('#recordHud').hidden=!active;
  $('#record').classList.toggle('active',active);$('#record').setAttribute('aria-pressed',String(active));$('#record').setAttribute('aria-label',active?'Stop recording':'Record with computer keyboard');$('#recordLabel').textContent=active?'Stop':'Record';
}
function recordElapsed(){return Math.max(0,(performance.now()-recordStartedAt)/1000)}
function finishKeyboardNote(code,elapsed=recordElapsed()){
  const pressed=pressedKeyboard.get(code);if(!pressed)return;
  pressed.note.duration=Math.max(.08,Math.round((elapsed-pressed.note.start)*1000)/1000);stopKeyboardVoice(pressed.voice);pressedKeyboard.delete(code);
}
function finishAllKeyboardNotes(elapsed=recordElapsed()){for(const code of [...pressedKeyboard.keys()])finishKeyboardNote(code,elapsed)}
function startRecordedNote(event){
  const pitch=KEYBOARD_PITCHES.get(event.code);if(pitch===undefined||event.repeat||event.ctrlKey||event.metaKey||event.altKey||pressedKeyboard.has(event.code))return;
  event.preventDefault();const start=Math.round(recordElapsed()*1000)/1000;
  const note={id:nextNoteId(),pitch,sourcePitch:pitch+36,start,duration:.08,amplitude:.9};recordedNotes.push(note);
  pressedKeyboard.set(event.code,{note,voice:startKeyboardVoice(pitch)});$('#noteCount').textContent=recordedNotes.length;
}
async function startRecording(){
  if(recording)return;
  if(!editorRoot.hidden){closeEditor();if(!editorRoot.hidden)return}
  pause();recordingSnapshot={time,duration,isAudio,songMuted,currentSourceName,title:$('#songTitle').textContent,subtitle:$('#songSubtitle').textContent,info:$('#info').textContent,emptyDisplay:$('#empty').style.display,noteCount:$('#noteCount').textContent,rangeCount:$('#rangeCount').textContent,meterWidth:$('#meterBar').style.width,audioTime:$('#audio').currentTime};
  try{await Promise.race([context().resume(),new Promise(resolve=>setTimeout(resolve,300))])}catch(error){console.warn('Could not start audio context',error)}
  recording=true;recordedNotes=[];pressedKeyboard.clear();q.clear();time=0;recordStartedAt=performance.now();setPianoKeyboardLabels(true);setRecordingControls(true);document.activeElement?.blur?.();
  $('#empty').style.display='none';$('#songTitle').textContent='Recording';$('#songSubtitle').textContent='';$('#recordTime').textContent='00:00';$('#clock').textContent='00:00';$('#duration').textContent='/ REC';$('#noteCount').textContent='0';$('#rangeCount').textContent='0';$('#info').textContent='Play the keys.';$('#meterBar').style.width='100%';
}
function restoreRecordingSnapshot(){
  const snapshot=recordingSnapshot;if(!snapshot)return;
  time=snapshot.time;duration=snapshot.duration;isAudio=snapshot.isAudio;songMuted=snapshot.songMuted;currentSourceName=snapshot.currentSourceName;$('#songTitle').textContent=snapshot.title;$('#songSubtitle').textContent=snapshot.subtitle;$('#empty').style.display=snapshot.emptyDisplay;$('#noteCount').textContent=snapshot.noteCount;$('#rangeCount').textContent=snapshot.rangeCount;$('#meterBar').style.width=snapshot.meterWidth;$('#duration').textContent='/ '+format(duration);if(isAudio)$('#audio').currentTime=snapshot.audioTime;syncMuteButton();$('#info').textContent='No notes recorded.';recordingSnapshot=null;updateClock();
}
function stopRecording(){
  if(!recording)return;const elapsed=recordElapsed();finishAllKeyboardNotes(elapsed);recording=false;setPianoKeyboardLabels(false);setRecordingControls(false);
  if(!recordedNotes.length){restoreRecordingSnapshot();return}
  notes=recordedNotes.map(note=>({...note})).sort((a,b)=>a.start-b.start);clearBackingTrack(false);sourceDuration=Math.max(...notes.map(note=>note.start+note.duration))+.45;duration=sourceDuration;time=0;isAudio=false;songMuted=false;currentSourceName='keyboard-recording';
  clearSourceMedia();
  $('#songTitle').textContent='My Recording';$('#songSubtitle').textContent='';recordingSnapshot=null;finishLoad(`Recording ready · ${notes.length} notes.`);persistProject();
}
$('#record').onclick=()=>recording?stopRecording():startRecording();$('#stopRecord').onclick=stopRecording;
window.addEventListener('blur',()=>{if(recording)finishAllKeyboardNotes()});
document.addEventListener('visibilitychange',()=>{if(recording&&document.hidden)finishAllKeyboardNotes()});
window.addEventListener('beforeunload',event=>{if(editorDirty||recording){event.preventDefault();event.returnValue=''}});

$('#centerDemo').onclick=$('#demo').onclick=demo;$('#play').onclick=play;$('#restart').onclick=reset;
$('#file').addEventListener('change',event=>{loadFile(event.target.files?.[0]);event.target.value=''});
$('#projectFile').addEventListener('change',event=>{loadFile(event.target.files?.[0]);event.target.value=''});
$('#backingFile').addEventListener('change',async event=>{await loadBackingFile(event.target.files?.[0]);event.target.value=''});
function shiftBacking(seconds){if(!backingUrl)return;backingOffset=roundTime(Math.max(-Math.max(0,backingDuration-.05),backingOffset+seconds));updateBackingControls();recalculateDuration();syncTimelineMedia(time,playing);persistProject();$('#info').textContent=`Backsound starts at ${backingOffset.toFixed(2)}s.`}
$('#backingNudgeBack').onclick=()=>shiftBacking(-.1);$('#backingNudgeForward').onclick=()=>shiftBacking(.1);
$('#backingOffset').addEventListener('change',event=>{backingOffset=roundTime(Number(event.target.value)||0);updateBackingControls();recalculateDuration();syncTimelineMedia(time,playing);persistProject();$('#info').textContent=`Backsound starts at ${backingOffset.toFixed(2)}s.`});
$('#backingRemove').onclick=()=>{clearBackingTrack();persistProject();$('#info').textContent='Backsound removed.'};
const zone=$('#dropZone');zone.addEventListener('dragover',e=>{e.preventDefault();if(!recording)zone.classList.add('drag')});zone.addEventListener('dragleave',()=>zone.classList.remove('drag'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag');if(!recording)loadFile(e.dataTransfer.files[0])});
$('#seek').addEventListener('input',e=>seekTo(duration*Number(e.target.value)/1000));
$('#muteSong').onclick=()=>setSongMuted(!songMuted);
$('#lead').addEventListener('input',e=>{lead=Number(e.target.value);$('#leadText').textContent=lead.toFixed(1)+'s'});
$('#volume').addEventListener('input',e=>{$('#volText').textContent=Math.round(e.target.value*100)+'%';if(mediaGraph){$('#audio').volume=$('#backingAudio').volume=1;updateMediaGains()}else{$('#audio').volume=$('#backingAudio').volume=Number(e.target.value)}});
$('#audio').addEventListener('ended',()=>{if(playing&&duration<=sourceDuration+.05){playing=false;time=duration;syncTimelineMedia(time,false);syncPlayButtons();updateClock()}});
$('#fullscreen').onclick=async()=>{if(document.fullscreenElement){await document.exitFullscreen()}else{document.body.classList.add('performance-mode');try{await document.documentElement.requestFullscreen()}catch(e){document.body.classList.remove('performance-mode');$('#info').textContent='Fullscreen unavailable: '+e.message}}};
document.addEventListener('fullscreenchange',()=>{document.body.classList.toggle('performance-mode',Boolean(document.fullscreenElement))});
document.addEventListener('keydown',e=>{
  if(liveSession?.isMobile)return;
  if(recording){if(e.code==='Escape'){e.preventDefault();stopRecording()}else startRecordedNote(e);return}
  if(!editorRoot.hidden){
    const typing=['INPUT','SELECT','TEXTAREA'].includes(e.target?.tagName);
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'&&!typing){e.preventDefault();copySelectedEditorNote();return}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v'&&!typing){e.preventDefault();pasteEditorNote();return}
    if((e.key==='Delete'||e.key==='Backspace')&&!typing){e.preventDefault();deleteSelectedEditorNote();return}else if(e.key==='Escape'){closeEditor();return}
  }
  if(e.code==='Space'&&e.target?.tagName!=='INPUT'&&e.target?.tagName!=='BUTTON'){e.preventDefault();play()}
});
document.addEventListener('keyup',e=>{if(pressedKeyboard.has(e.code)){e.preventDefault();finishKeyboardNote(e.code)}});

function laneCenter(m,w){if(whiteSet.has(m))return (whites.indexOf(m)+.5)*w/whites.length;const next=whites.findIndex(p=>p>m);return next*w/whites.length}
function render(ms){
 requestAnimationFrame(render);
 const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
 if(canvas.width!==Math.round(rect.width*dpr)||canvas.height!==Math.round(rect.height*dpr)){
   canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
 }
 ctx.setTransform(dpr,0,0,dpr,0,0);
 const w=rect.width,h=rect.height;
 if(!w||!h)return;
 ctx.clearRect(0,0,w,h);
 const bg=ctx.createLinearGradient(0,0,w,h);
 bg.addColorStop(0,'#192c26');bg.addColorStop(.55,'#1b302b');bg.addColorStop(1,'#12221f');
 ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
 // Kawung-inspired four-petal pattern, barely visible, like embossed cloth.
 ctx.save();ctx.strokeStyle='rgba(207,186,143,.057)';ctx.lineWidth=1;
 for(let x=70;x<w+140;x+=150){for(let y=60;y<h+140;y+=150){
  for(let k=0;k<4;k++){const a=k*Math.PI/2;const px=x+Math.cos(a)*20,py=y+Math.sin(a)*20;
   ctx.save();ctx.translate(px,py);ctx.rotate(a);ctx.beginPath();ctx.ellipse(0,0,21,12,0,0,Math.PI*2);ctx.stroke();ctx.restore();}
  ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.stroke();
 }}ctx.restore();
 const lineY=h-42,travel=Math.max(110,lineY-22),lane=w/whites.length;
 for(let i=0;i<whites.length;i++){
  const x=i*lane;
  if(i%2===0){ctx.fillStyle='rgba(245,233,209,.025)';ctx.fillRect(x,0,lane,h)}
  ctx.strokeStyle='rgba(235,227,204,.10)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x+.5,0);ctx.lineTo(x+.5,h);ctx.stroke();
 }
 ctx.strokeStyle='rgba(232,221,193,.12)';ctx.lineWidth=1;
 for(let i=1;i<=4;i++){
  const y=lineY-travel*i/4;ctx.setLineDash([2,9]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
 }ctx.setLineDash([]);
 if(recording){
  time=recordElapsed();for(const {note} of pressedKeyboard.values())note.duration=Math.max(.08,time-note.start);
  $('#recordTime').textContent=format(time);$('#clock').textContent=format(time);
 }else if(playing){time=Math.min(duration,initialTime+(ms-startedAt)/1000);syncTimelineMedia(time,true);if(ms-lastLiveSyncAt>1800){lastLiveSyncAt=ms;liveSession?.broadcastSync(time)}if(time>=duration){pause();time=duration}updateClock()}
 for(const key of keyEls.values())key.classList.remove('active');
 for(const {note} of pressedKeyboard.values())keyEls.get(note.pitch)?.classList.add('active');
 noteHitRegions=[];
 for(const n of visibleNotes()){
  if(n.pitch<RANGE_MIN||n.pitch>RANGE_MAX)continue;
  const dt=n.start-time;if(dt>lead||dt<-n.duration-.22)continue;
  const pixelsPerSecond=travel/lead,x=laneCenter(n.pitch,w),isBlack=!whiteSet.has(n.pitch),headY=lineY-dt*pixelsPerSecond;
  const width=lane*(isBlack?.58:.82),height=Math.max(18,n.duration*pixelsPerSecond),topY=headY-height,color=noteColor(n.pitch),radius=Math.min(8,height/2);
  if(dt<=.08&&dt>=-n.duration)keyEls.get(n.pitch)?.classList.add('active');
  if(playing&&(!isAudio||songMuted)&&dt<=.06&&dt>=-.09&&!q.has(n.id)){beep(n.pitch,0,Math.min(n.duration,3));q.add(n.id)}
  ctx.shadowColor=color;ctx.shadowBlur=dt<.12&&dt>-n.duration?24:10;
   ctx.fillStyle=color;round(ctx,x-width/2,topY,width,height,radius);ctx.fill();ctx.shadowBlur=0;ctx.strokeStyle=noteOutline(n.pitch);ctx.lineWidth=1.5;ctx.stroke();
  const bodyShade=ctx.createLinearGradient(x-width/2,0,x+width/2,0);bodyShade.addColorStop(0,'rgba(0,0,0,.16)');bodyShade.addColorStop(.4,'rgba(255,255,255,.12)');bodyShade.addColorStop(1,'rgba(0,0,0,.08)');ctx.fillStyle=bodyShade;round(ctx,x-width/2,topY,width,height,radius);ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.72)';round(ctx,x-width/2+2,headY-4,width-4,3,1.5);ctx.fill();
   ctx.fillStyle=noteInk(n.pitch);ctx.font=`800 ${Math.max(11,Math.min(16,w/82))}px DM Sans`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  if(!editorRoot.hidden&&n.id===selectedNoteId&&width>33&&height>20)ctx.fillText(pitchName(n.pitch),x,Math.max(topY+12,Math.min(headY-12,lineY-13)));
  if(!editorRoot.hidden){
   const region={noteId:n.id,x:x-width/2,width,topY,headY,visibleTop:Math.max(0,topY),visibleBottom:Math.min(h,headY),pps:pixelsPerSecond};
   if(region.visibleBottom>region.visibleTop)noteHitRegions.push(region);
   if(n.id===selectedNoteId){
    ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.setLineDash([6,4]);round(ctx,x-width/2-3,topY-3,width+6,height+6,radius+2);ctx.stroke();ctx.setLineDash([]);
    const handleY=clamp(topY,6,h-6);ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,handleY,6,0,Math.PI*2);ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();ctx.restore();
   }
  }
 }
 // A single clear performance horizon, echoing the brass color of angklung bamboo fixtures.
 ctx.fillStyle='rgba(235,192,135,.12)';ctx.fillRect(0,lineY-9,w,20);
 ctx.shadowColor='#e9b77d';ctx.shadowBlur=13;ctx.fillStyle='#ecc28b';ctx.fillRect(0,lineY,w,3);ctx.shadowBlur=0;
 ctx.fillStyle='#e0bf91';ctx.font='700 10px DM Sans';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillText('HIT',17,lineY-15);
  renderArrangement();
 if(q.size>3000)q.clear();
}
function round(c,x,y,w,h,r){c.beginPath();c.roundRect(x,y,w,h,r)}
liveSession=createLiveSession({
  getSnapshot:()=>({title:$('#songTitle').textContent||'Klung!',duration,notes:notes.map(note=>({pitch:note.pitch,start:note.start,duration:note.duration}))}),
  getPosition:()=>time,
  isPlaying:()=>playing,
  onMasterPlay:()=>play(),
  noteNames,
  noteColors:NOTE_COLORS,
  noteInk,
});
requestAnimationFrame(render);
