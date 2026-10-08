import './style.css';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';
import { Midi } from '@tonejs/midi';
const $=s=>document.querySelector(s);
const canvas=$('#stageCanvas'), ctx=canvas.getContext('2d');
const RANGE_MIN=24,RANGE_MAX=35; // C1 through B1
const whites=[24,26,28,29,31,33,35];
const all=Array.from({length:RANGE_MAX-RANGE_MIN+1},(_,i)=>RANGE_MIN+i);
const whiteSet=new Set(whites);
const black=all.filter(n=>!whiteSet.has(n));
const noteNames=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const pitchName=n=>noteNames[n%12];
const NOTE_COLORS=['#ff5d73','#ff7a45','#f6b73c','#d7d84b','#8bd450','#3ddc97','#33d6c5','#38bdf8','#5b8def','#8b7cf6','#c86dd7','#f062b4'];
const noteColor=pitch=>NOTE_COLORS[((pitch%12)+12)%12];
const KEYBOARD_PITCHES=new Map([
  ['KeyA',24],['KeyW',25],['KeyS',26],['KeyE',27],['KeyD',28],['KeyF',29],
  ['KeyT',30],['KeyG',31],['KeyY',32],['KeyH',33],['KeyU',34],['KeyJ',35],
]);
const PITCH_KEY_LABELS=new Map([...KEYBOARD_PITCHES].map(([code,pitch])=>[pitch,code.slice(3)]));
// Fold every detected octave into the single C1-B1 angklung layout.
const foldToAngklungRange=pitch=>RANGE_MIN+((pitch%12)+12)%12;
const q=new Set();
let notes=[],duration=0,time=0,playing=false,lead=3,audioUrl=null,source=null,startedAt=0,initialTime=0,isAudio=false,lastFrame=0,noteSequence=0,currentSourceName='';
let songMuted=false;
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
function beep(n,when=0,d=.21){const a=context(),osc=a.createOscillator(),gain=a.createGain();osc.type='sine';osc.frequency.value=freq(n);gain.gain.setValueAtTime(0.0001,a.currentTime+when);gain.gain.exponentialRampToValueAtTime(.12*Number($('#volume').value)+.001,a.currentTime+when+.02);gain.gain.exponentialRampToValueAtTime(.0001,a.currentTime+when+Math.max(.12,d));osc.connect(gain).connect(a.destination);osc.start(a.currentTime+when);osc.stop(a.currentTime+when+Math.max(.13,d)+.03)}
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
  if(!isAudio)songMuted=false;const button=$('#muteSong');button.disabled=!isAudio;button.classList.toggle('active',songMuted);button.setAttribute('aria-pressed',String(songMuted));$('#muteSongLabel').textContent=songMuted?'Notes only':'Song on';$('#audio').muted=songMuted;
}
function setSongMuted(muted){songMuted=Boolean(muted)&&isAudio;syncMuteButton();rebuildPlayedQueue(time)}
function demo(){if(recording)return;if(!editorRoot.hidden)closeEditor(true);const seq=[24,26,28,29,31,33,35,33,31,29,28,26,24,28,31,35,33,31,29,28,26,24],holds=[.3,.3,.3,.72,.3,.3,.82,.3,.3,.65,.3,.3,.9,.3,.3,.7,.3,.3,.62,.3,.3,.95];notes=seq.map((pitch,i)=>({pitch,start:i*.46+.65,duration:holds[i],amplitude:.8}));duration=notes.at(-1).start+notes.at(-1).duration+.65;isAudio=false;currentSourceName='klung-demo';$('#songTitle').textContent='Nusantara Melody';$('#songSubtitle').textContent='';finishLoad('Demo ready.');}
function finishLoad(message){pause();q.clear();time=0;ensureNoteIds();$('#audio').pause();$('#empty').style.display='none';$('#play').disabled=$('#restart').disabled=$('#seek').disabled=$('#export').disabled=$('#editNotes').disabled=false;syncMuteButton();$('#noteCount').textContent=notes.length;$('#rangeCount').textContent=notes.filter(n=>n.pitch>=RANGE_MIN&&n.pitch<=RANGE_MAX).length;$('#duration').textContent='/ '+format(duration);$('#info').textContent=message;$('#meterBar').style.width='100%';updateClock()}
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
function loadProjectData(project,fallbackTitle='Saved Klung project'){
  if(!project||!Array.isArray(project.notes))throw new Error('This is not a valid Klung project file.');
  notes=project.notes.map(normalizeProjectNote).sort((a,b)=>a.start-b.start);
  if(!notes.length)throw new Error('This Klung project does not contain any notes.');
  duration=Math.max(Number(project.duration)||0,...notes.map(note=>note.start+note.duration));
  isAudio=false;$('#audio').pause();$('#audio').removeAttribute('src');$('#audio').load();
  $('#songTitle').textContent=String(project.title||fallbackTitle).slice(0,48);
  $('#songSubtitle').textContent='';
  finishLoad(`Project ready · ${notes.length} notes.`);
}
async function loadFile(file){if(!file)return;if(!editorRoot.hidden)closeEditor(true);pause();currentSourceName=file.name;$('#empty').style.display='none';$('#info').textContent='Loading…';$('#meterBar').style.width='3%';$('#songTitle').textContent=file.name.replace(/\.[^.]+$/,'').slice(0,48);$('#songSubtitle').textContent='';try{
if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null}isAudio=false;
if(/\.(json|klung)$/i.test(file.name)){
  loadProjectData(JSON.parse(await file.text()),file.name.replace(/\.(klung\.)?json$|\.klung$/i,''));return;
}
if(/\.mid(i)?$/i.test(file.name)){
  const midi=new Midi(await file.arrayBuffer()); notes=foldAndDeduplicate(midi.tracks.flatMap(t=>t.notes.map(n=>({pitch:n.midi,start:n.time,duration:n.duration,amplitude:n.velocity}))));duration=midi.duration; finishLoad(`MIDI ready · ${notes.length} notes.`);return;
}
const audioExt=/\.(m4a|mp4|aac)$/i.test(file.name);
const a=context();await a.resume();
let buf;
try {
  // Chrome and Edge decode standard iPhone Voice Memos M4A (AAC) via Web Audio.
  // The extension alone doesn't guarantee a supported codec (e.g. ALAC).
  buf=await a.decodeAudioData(await file.arrayBuffer());
} catch(decodeError) {
  throw new Error(audioExt
    ? 'This M4A codec could not be decoded by your browser. Open the app in the latest Chrome or Edge. iPhone Voice Memos AAC recordings are supported; ALAC or unusual codecs may require conversion to WAV.'
    : 'Your browser could not decode this audio. Try MP3, WAV, or an iPhone Voice Memos M4A (AAC) recording.');
}
if(!Number.isFinite(buf.duration)||buf.duration<=0)throw new Error('This audio file is empty or invalid');
audioUrl=URL.createObjectURL(file);$('#audio').src=audioUrl;$('#audio').volume=Number($('#volume').value);songMuted=false;$('#audio').muted=false;isAudio=true;duration=buf.duration;
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
function syncPlayButtons(){const label=playing?'Ⅱ':'▶';$('#play').textContent=label;const livePlay=$('#editorPlay');if(livePlay)livePlay.textContent=label}
function pause(){if(playing){if(isAudio){$('#audio').pause();time=$('#audio').currentTime}else{time=Math.min(duration,initialTime+(performance.now()-startedAt)/1000)}}playing=false;syncPlayButtons()}
async function play(){if(!notes.length)return;if(playing){pause();return}if(!isAudio){try{await Promise.race([context().resume(),new Promise(resolve=>setTimeout(resolve,250))])}catch{}}if(time>=duration-.05){time=0;q.clear()}playing=true;initialTime=time;startedAt=performance.now();if(isAudio){$('#audio').currentTime=time;try{await $('#audio').play()}catch(e){playing=false;$('#info').textContent='Playback blocked: '+e.message}}syncPlayButtons()}
function rebuildPlayedQueue(at=time){q.clear();for(const note of visibleNotes())if(note.start<at-.06)q.add(note.id)}
function seekTo(nextTime){
  time=clamp(Number(nextTime)||0,0,duration);if(isAudio)$('#audio').currentTime=time;
  if(playing&&!isAudio){initialTime=time;startedAt=performance.now()}
  rebuildPlayedQueue(time);updateClock();
}
function reset(){pause();seekTo(0)}

const editorRoot=$('#liveEditor');
let editorNotes=[],selectedNoteId=null,editorDirty=false,editorDrag=null,noteHitRegions=[];
for(let pitch=RANGE_MIN;pitch<=RANGE_MAX;pitch++){
  const option=document.createElement('option');option.value=String(pitch);option.textContent=`${pitchName(pitch)}1`;$('#editorPitch').append(option);
}
function roundTime(value){return Math.round(value*100)/100}
function clamp(value,min,max){return Math.min(max,Math.max(min,value))}
function selectedEditorNote(){return editorNotes.find(note=>note.id===selectedNoteId)||null}
function visibleNotes(){if(recording)return recordedNotes;return editorRoot.hidden?notes:editorNotes}
function setEditorDirty(){editorDirty=true}
function refreshEditedNoteSchedule(note){if(note.start>time+.06)q.delete(note.id);else q.add(note.id)}
function projectPayload(){return {format:'Klung! Project',version:2,title:$('#songTitle').textContent||'My Klung Song',sourceName:currentSourceName,duration,notes:notes.map(note=>({...note}))}}
function persistProject(){try{localStorage.setItem('klung:lastProject',JSON.stringify(projectPayload()))}catch(error){console.warn('Could not persist Klung project',error)}}
function saveProjectFile(){
  const project=projectPayload();persistProject();
  const blob=new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),link=document.createElement('a');
  const safeName=(project.title||'klung-song').replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'klung-song';
  link.href=URL.createObjectURL(blob);link.download=`${safeName}.klung.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  $('#info').textContent='Project saved.';
}
function updateEditorInspector(){
  const note=selectedEditorNote();
  for(const element of [$('#editorPitch'),$('#editorStart'),$('#editorLength'),$('#editorDelete')])element.disabled=!note;
  $('#liveSelection').textContent=note?`${pitchName(note.pitch)}1  ·  ${note.start.toFixed(2)}s`:'SELECT A NOTE';
  if(!note){$('#editorPitch').value=String(RANGE_MIN);$('#editorStart').value='';$('#editorLength').value='';return}
  $('#editorPitch').value=String(note.pitch);$('#editorStart').value=note.start.toFixed(2);$('#editorLength').value=note.duration.toFixed(2);
}
function selectEditorNote(id){
  selectedNoteId=id;updateEditorInspector();
}
function openEditor(){
  if(!notes.length)return;editorNotes=notes.map(note=>({...note,id:note.id||nextNoteId()}));selectedNoteId=null;editorDirty=false;editorDrag=null;editorRoot.hidden=false;$('#stage').classList.add('live-editing');$('#editNotes').classList.add('active');$('#editNotes').lastChild.textContent=' EDITING';$('#export').disabled=true;updateEditorInspector();syncPlayButtons();
}
function closeEditor(force=false){
  if(!force&&editorDirty&&!window.confirm('Discard your unsaved note edits?'))return;
  const discarded=editorDirty;if(discarded){q.clear();for(const note of notes)if(note.start<=time+.06)q.add(note.id)}editorDirty=false;
  editorRoot.hidden=true;$('#stage').classList.remove('live-editing');$('#editNotes').classList.remove('active');$('#editNotes').lastChild.textContent=' EDIT';$('#export').disabled=!notes.length;selectedNoteId=null;editorDrag=null;noteHitRegions=[];
}
function saveEditorChanges(){
  notes=editorNotes.map(note=>({...note})).sort((a,b)=>a.start-b.start);if(!isAudio&&notes.length)duration=Math.max(duration,...notes.map(note=>note.start+note.duration));editorDirty=false;persistProject();closeEditor(true);$('#noteCount').textContent=notes.length;$('#rangeCount').textContent=notes.length;$('#duration').textContent='/ '+format(duration);$('#info').textContent='Edits saved.';
}
function deleteSelectedEditorNote(){
  if(!selectedNoteId)return;q.delete(selectedNoteId);editorNotes=editorNotes.filter(note=>note.id!==selectedNoteId);selectedNoteId=null;setEditorDirty();updateEditorInspector();
}
function pitchAtX(x,width){return all.reduce((closest,pitch)=>Math.abs(laneCenter(pitch,width)-x)<Math.abs(laneCenter(closest,width)-x)?pitch:closest,RANGE_MIN)}
canvas.addEventListener('pointerdown',event=>{
  if(editorRoot.hidden)return;event.preventDefault();const bounds=canvas.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
  const region=[...noteHitRegions].reverse().find(item=>x>=item.x&&x<=item.x+item.width&&y>=item.visibleTop&&y<=item.visibleBottom);
  if(!region){selectEditorNote(null);return}
  const note=editorNotes.find(item=>item.id===region.noteId);if(!note)return;const wasSelected=note.id===selectedNoteId;selectEditorNote(note.id);
  const resize=wasSelected&&Math.abs(y-region.visibleTop)<=10;
  editorDrag={pointerId:event.pointerId,mode:resize?'resize':'move',noteId:note.id,original:{...note},pointerToHead:y-region.headY,handleOffset:y-region.topY,pps:region.pps,moved:false};canvas.setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove',event=>{
  if(!editorDrag||event.pointerId!==editorDrag.pointerId)return;event.preventDefault();const note=editorNotes.find(item=>item.id===editorDrag.noteId);if(!note)return;
  const bounds=canvas.getBoundingClientRect(),x=clamp(event.clientX-bounds.left,0,bounds.width),y=clamp(event.clientY-bounds.top,0,bounds.height),lineY=bounds.height-42;
  if(editorDrag.mode==='move'){
    const desiredHead=y-editorDrag.pointerToHead;note.start=roundTime(clamp(time+(lineY-desiredHead)/editorDrag.pps,0,Math.max(0,duration-note.duration)));note.pitch=pitchAtX(x,bounds.width);
  }else{
    const headY=lineY-(note.start-time)*editorDrag.pps,desiredTop=y-editorDrag.handleOffset;note.duration=roundTime(clamp((headY-desiredTop)/editorDrag.pps,.08,Math.max(.08,duration-note.start)));
  }
  editorDrag.moved=true;refreshEditedNoteSchedule(note);setEditorDirty();updateEditorInspector();
});
document.addEventListener('pointerup',event=>{if(editorDrag&&event.pointerId===editorDrag.pointerId)editorDrag=null});
canvas.addEventListener('wheel',event=>{
  if(editorRoot.hidden||editorDrag||event.ctrlKey||!event.deltaY)return;
  event.preventDefault();
  const pixels=event.deltaY*(event.deltaMode===1?18:event.deltaMode===2?canvas.clientHeight:1);
  let seconds=clamp(pixels*.004,-1.5,1.5);if(Math.abs(seconds)<.06)seconds=Math.sign(seconds)*.06;
  seekTo(time+seconds);
},{passive:false});
$('#editorPitch').addEventListener('change',event=>{const note=selectedEditorNote();if(!note)return;note.pitch=Number(event.target.value);setEditorDirty();updateEditorInspector()});
$('#editorStart').addEventListener('change',event=>{const note=selectedEditorNote();if(!note)return;note.start=roundTime(clamp(Number(event.target.value)||0,0,Math.max(0,duration-note.duration)));refreshEditedNoteSchedule(note);setEditorDirty();updateEditorInspector()});
$('#editorLength').addEventListener('change',event=>{const note=selectedEditorNote();if(!note)return;note.duration=roundTime(clamp(Number(event.target.value)||.08,.08,Math.max(.08,duration-note.start)));setEditorDirty();updateEditorInspector()});
$('#editorPlay').onclick=play;$('#editorDelete').onclick=deleteSelectedEditorNote;$('#editorCancel').onclick=()=>closeEditor();$('#editorSave').onclick=saveEditorChanges;$('#editNotes').onclick=()=>editorRoot.hidden?openEditor():closeEditor();$('#export').onclick=saveProjectFile;
function setRecordingControls(active){
  const hasSong=notes.length>0;
  for(const id of ['file','demo','centerDemo'])$("#"+id).disabled=active;
  for(const id of ['play','restart','seek','editNotes','export'])$("#"+id).disabled=active||!hasSong;
  $('#muteSong').disabled=active||!isAudio;
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
  notes=recordedNotes.map(note=>({...note})).sort((a,b)=>a.start-b.start);duration=Math.max(...notes.map(note=>note.start+note.duration))+.45;time=0;isAudio=false;songMuted=false;currentSourceName='keyboard-recording';
  if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null}$('#audio').pause();$('#audio').removeAttribute('src');$('#audio').load();
  $('#songTitle').textContent='My Recording';$('#songSubtitle').textContent='';recordingSnapshot=null;finishLoad(`Recording ready · ${notes.length} notes.`);persistProject();
}
$('#record').onclick=()=>recording?stopRecording():startRecording();$('#stopRecord').onclick=stopRecording;
window.addEventListener('blur',()=>{if(recording)finishAllKeyboardNotes()});
document.addEventListener('visibilitychange',()=>{if(recording&&document.hidden)finishAllKeyboardNotes()});
window.addEventListener('beforeunload',event=>{if(editorDirty||recording){event.preventDefault();event.returnValue=''}});

$('#centerDemo').onclick=$('#demo').onclick=demo;$('#play').onclick=play;$('#restart').onclick=reset;
$('#file').addEventListener('change',e=>loadFile(e.target.files?.[0]));
const zone=$('#dropZone');zone.addEventListener('dragover',e=>{e.preventDefault();if(!recording)zone.classList.add('drag')});zone.addEventListener('dragleave',()=>zone.classList.remove('drag'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag');if(!recording)loadFile(e.dataTransfer.files[0])});
$('#seek').addEventListener('input',e=>seekTo(duration*Number(e.target.value)/1000));
$('#muteSong').onclick=()=>setSongMuted(!songMuted);
$('#lead').addEventListener('input',e=>{lead=Number(e.target.value);$('#leadText').textContent=lead.toFixed(1)+'s'});
$('#volume').addEventListener('input',e=>{$('#volText').textContent=Math.round(e.target.value*100)+'%';$('#audio').volume=Number(e.target.value)});
$('#audio').addEventListener('ended',()=>{playing=false;time=duration;syncPlayButtons();updateClock()});
$('#fullscreen').onclick=async()=>{if(document.fullscreenElement){await document.exitFullscreen()}else{document.body.classList.add('performance-mode');try{await document.documentElement.requestFullscreen()}catch(e){document.body.classList.remove('performance-mode');$('#info').textContent='Fullscreen unavailable: '+e.message}}};
document.addEventListener('fullscreenchange',()=>{document.body.classList.toggle('performance-mode',Boolean(document.fullscreenElement))});
document.addEventListener('keydown',e=>{
  if(recording){if(e.code==='Escape'){e.preventDefault();stopRecording()}else startRecordedNote(e);return}
  if(!editorRoot.hidden){if((e.key==='Delete'||e.key==='Backspace')&&!['INPUT','SELECT','TEXTAREA'].includes(e.target?.tagName)){e.preventDefault();deleteSelectedEditorNote();return}else if(e.key==='Escape'){closeEditor();return}}
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
 }else if(playing){time=isAudio?$('#audio').currentTime:Math.min(duration,initialTime+(ms-startedAt)/1000);if(time>=duration){pause();time=duration}updateClock()}
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
  ctx.fillStyle=color;round(ctx,x-width/2,topY,width,height,radius);ctx.fill();ctx.shadowBlur=0;
  const bodyShade=ctx.createLinearGradient(x-width/2,0,x+width/2,0);bodyShade.addColorStop(0,'rgba(0,0,0,.16)');bodyShade.addColorStop(.4,'rgba(255,255,255,.12)');bodyShade.addColorStop(1,'rgba(0,0,0,.08)');ctx.fillStyle=bodyShade;round(ctx,x-width/2,topY,width,height,radius);ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.72)';round(ctx,x-width/2+2,headY-4,width-4,3,1.5);ctx.fill();
  ctx.fillStyle='#10201b';ctx.font=`800 ${Math.max(11,Math.min(16,w/82))}px DM Sans`;
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
 if(q.size>3000)q.clear();
}
function round(c,x,y,w,h,r){c.beginPath();c.roundRect(x,y,w,h,r)}
requestAnimationFrame(render);
