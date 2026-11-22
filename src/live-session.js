import { cueLabel } from './cue-label.js';
import QRCode from 'qrcode';
import {createRealtimeHub,realtimeConfigured} from './realtime-hub.js';

const MAX_PLAYERS=50,CHUNK_SIZE=40000;
const $=selector=>document.querySelector(selector);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const encoder=new TextEncoder();
const randomId=()=>crypto.randomUUID();
function randomCode(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(n=>alphabet[n%alphabet.length]).join('');
}
function toBase64Url(bytes){
  let s='';for(const n of bytes)s+=String.fromCharCode(n);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function fromBase64Url(value){
  const s=atob(value.replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from(s,c=>c.charCodeAt(0));
}
async function createMasterKey(){
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicBytes=await crypto.subtle.exportKey('raw',pair.publicKey);
  return {signer:pair.privateKey,publicKey:toBase64Url(new Uint8Array(publicBytes))};
}
async function createVerifier(key){
  const bytes=fromBase64Url(key);
  if(bytes.byteLength!==65)throw new Error('Invalid session link. Please scan the QR again.');
  return crypto.subtle.importKey('raw',bytes,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
}

export function createLiveSession({getSnapshot,getPosition,getPlaybackRate,isPlaying,onMasterPlay,noteNames,noteColors,noteInk,allPitches}){
  const params=new URLSearchParams(location.search),joinCode=(params.get('session')||'').trim().toUpperCase(),joinKey=params.get('key')||'';
  const isMobile=Boolean(joinCode)&&(location.pathname.replace(/\/+$/,'')==='/join'||params.has('mobile'));
  const clientId=randomId();
  let role=isMobile?'mobile':null,room=null,code='',signer=null,publicKey='',verifier=null;
  let snapshot=null,snapshotVersion='',masterId=null,clockOffset=0,clockSamples=[],mobileSelection=new Set();
  let mobileTransport={playing:false,position:0,executeAt:0,playbackRate:1,status:'Waiting for master'};
  let mobileFrame=0,mobileLastFrame=0,wakeLock=null,joining=false;
  let transportSeq=0,lastSeq=0,lastSyncAt=0,pendingTransport=null,masterTransport=null;
  let download=null,downloadQueue=new Set(),downloadTimer=null,clockTimer=null;
  let flushingSnapshots=false,expectedSnapshotVersion='';
  const peers=new Map(),pendingPings=new Map(),leaveTimers=new Map();
  let onlinePresence=new Set();
  const mobileTimeline=$('#mobileTimeline'),mobileTimelineContext=mobileTimeline?.getContext('2d');
  const displayedName=pitch=>noteNames[((pitch%12)+12)%12];
  const liveConnected=()=>room?.connected()===true;
  // A returning player keeps their Ready selection for this exact QR/session.
  // No account is needed. A new QR/public key cannot accidentally reuse it.
  const savedNotesKey=()=>`klung:ready:v1:${joinCode}:${joinKey}`;
  function savedNotes(){
    try{
      const record=JSON.parse(localStorage.getItem(savedNotesKey())||'null');
      if(!record?.ready||!Array.isArray(record.pitches))return null;
      return [...new Set(record.pitches.map(Number).filter(Number.isInteger))].slice(0,12);
    }catch{return null}
  }
  function saveReadyNotes(){
    try{
      localStorage.setItem(savedNotesKey(),JSON.stringify({
        ready:true,pitches:[...mobileSelection],savedAt:Date.now()
      }));
    }catch{/* Private mode may not allow persistent storage. */}
  }
  function restoreReadyNotes(){
    if(!snapshot)return false;
    const stored=savedNotes();
    if(!stored?.length)return false;
    const valid=new Set(Array.isArray(allPitches)&&allPitches.length
      ?allPitches:snapshot.notes.map(note=>note.pitch));
    mobileSelection=new Set(stored.filter(pitch=>valid.has(pitch)));
    return mobileSelection.size>0;
  }

  function joinUrl(sessionCode,key){
    const url=new URL('/join',location.origin);
    url.searchParams.set('session',sessionCode);url.searchParams.set('mobile','1');url.searchParams.set('key',key);
    return url.toString();
  }
  function showConnectionError(message){
    if(role==='mobile'){
      $('#mobileConnect').hidden=false;$('#mobileNotePicker').hidden=true;$('#mobileCue').hidden=true;
      $('#mobileConnectTitle').textContent='Could not connect';$('#mobileConnectText').textContent=message;
      $('#mobileReconnect').hidden=false;
    }else $('#info').textContent=message;
  }
  async function sendFromMaster(kind,data={},recipient=null){
    if(!liveConnected()||!signer)return false;
    const unsigned={kind,source:clientId,...data};
    const bytes=encoder.encode(JSON.stringify(unsigned));
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signer,bytes);
    const signed={...unsigned,signature:toBase64Url(new Uint8Array(signature))};
    return recipient?room.sendDirect(kind,signed,recipient):room.send(kind,signed);
  }
  async function verifyFromMaster(data){
    if(!verifier||typeof data?.signature!=='string'||!data.source)return false;
    const {signature,...unsigned}=data;
    try{
      return await crypto.subtle.verify(
        {name:'ECDSA',hash:'SHA-256'},verifier,fromBase64Url(signature),
        encoder.encode(JSON.stringify(unsigned))
      );
    }catch{return false}
  }
  function sendFromPlayer(kind,data={}){
    return room?.send(kind,{...data,source:clientId})===true;
  }
  function sayHello(){
    const isReady=Boolean(mobileSelection.size&&(snapshot||expectedSnapshotVersion));
    sendFromPlayer('hello',{
      version:snapshotVersion||null,device:'Mobile player',
      pitches:isReady?[...mobileSelection]:[]
    });
  }
  function updateOwnPresence(){
    room?.setPresence({id:clientId,role,ready:Boolean(mobileSelection.size)&&!$('#mobileCue').hidden,
      pitches:[...mobileSelection].slice(0,12)});
  }
  function renderMasterPlayers(){
    const online=[...peers.values()];
    const ready=online.filter(p=>p.ready).length;
    $('#livePlayerCount').textContent=online.length+'/'+MAX_PLAYERS+' connected · '+ready+' ready';
    $('#liveSessionPlay').disabled=false;
    const list=$('#livePlayerList');
    if(!online.length){list.innerHTML='<small>Waiting for players…</small>';return}
    list.replaceChildren(...online.map(player=>{
      const row=document.createElement('div');row.className='live-player-row';
      const colors=(player.selection||[]).map(pitch=>'<b style="background:'+noteColors[((pitch%12)+12)%12]+'"></b>').join('');
      row.innerHTML='<i></i><strong>Player '+player.number+'</strong><small>'+(player.ready?'READY':'CHOOSING')+
        '</small><span>'+colors+(player.selection||[]).map(pitch=>displayedName(pitch)).join(' · ')+'</span>';
      return row;
    }));
  }
  function onPresence(list){
    if(role==='master'){
      onlinePresence=new Set(list.filter(p=>p.role==='mobile'&&typeof p.id==='string').map(p=>p.id));
      for(const [id] of peers){
        if(onlinePresence.has(id)){
          const timer=leaveTimers.get(id);
          if(timer)clearTimeout(timer);
          leaveTimers.delete(id);
        }else if(!leaveTimers.has(id)){
          // Presence can briefly disappear during refresh. Remove only after grace.
          leaveTimers.set(id,setTimeout(()=>{
            leaveTimers.delete(id);
            if(!onlinePresence.has(id)){peers.delete(id);renderMasterPlayers()}
          },3000));
        }
      }
      renderMasterPlayers();
    }else if(masterId&&!list.some(p=>p.role==='master'&&p.id===masterId)){
      // The music remains cached locally; only remote controls are unavailable.
      if(!$('#mobileCue').hidden&&!mobileTransport.playing)setMobileStatus('MASTER OFFLINE',true);
    }
  }
  function onReady(){
    updateOwnPresence();
    if(role==='mobile'){
      $('#mobileConnectTitle').textContent='Connected · loading song…';
      $('#mobileConnectText').textContent='Downloading the note timeline once.';
      $('#mobileReconnect').hidden=true;
      sayHello();
      if(snapshot){
        if(mobileSelection.size){$('#mobileConnect').hidden=true;$('#mobileCue').hidden=false}
        void startClockSync();
      }
    }else{
      $('#info').textContent='Live session connected. Players can scan the QR.';
      renderMasterPlayers();
      if(downloadQueue.size)queueSnapshotFlush();
    }
  }
  function onDisconnect(){
    if(role==='mobile'){
      if(!snapshot){
        $('#mobileConnectTitle').textContent='Reconnecting…';
        $('#mobileConnectText').textContent='Trying to reach the session relay.';
      }else if(!$('#mobileCue').hidden&&!mobileTransport.playing){
        $('#mobileCue').hidden=true;$('#mobileConnect').hidden=false;
        $('#mobileConnectTitle').textContent='Reconnecting…';
        $('#mobileConnectText').textContent='Song is saved locally. Restoring master controls.';
      }
      $('#mobileReconnect').hidden=false;
    }else $('#info').textContent='Live relay disconnected. Reconnecting automatically…';
  }
  function connect(sessionCode){
    room?.close();
    room=createRealtimeHub({
      code:sessionCode,clientId,role,onReady,onPresence,onDisconnect,
      onError:message=>showConnectionError(String(message)),
      onEvent:data=>{void handleMessage(data)}
    });
    return room.firstConnection;
  }
  async function handleMessage(data){
    if(!data||typeof data.kind!=='string')return;
    if(role==='master'){
      const id=String(data.source||'');
      if(!id||id===clientId)return;
      if(data.kind==='hello'){
        if(!peers.has(id)&&peers.size>=MAX_PLAYERS){
          await sendFromMaster('room-full',{target:id});return;
        }
        const player=peers.get(id)||{number:peers.size+1,selection:[],ready:false};
        if(Array.isArray(data.pitches)){
          player.selection=[...new Set(data.pitches.map(Number).filter(Number.isInteger))].slice(0,12);
          player.ready=player.selection.length>0;
        }
        player.lastSeen=Date.now();peers.set(id,player);
        if(leaveTimers.has(id)){clearTimeout(leaveTimers.get(id));leaveTimers.delete(id)}
        renderMasterPlayers();
        if(data.version!==snapshotVersion)queueSnapshot(id);
        else void sendCurrentTransport([id]);
      }else if(data.kind==='ready'&&peers.has(id)){
        const player=peers.get(id);
        player.selection=Array.isArray(data.pitches)?[...new Set(data.pitches.map(Number).filter(Number.isInteger))].slice(0,12):[];
        player.ready=player.selection.length>0;player.lastSeen=Date.now();renderMasterPlayers();
        void sendCurrentTransport([id]);
      }else if(data.kind==='ping'&&peers.has(id)){
        void sendFromMaster('pong',{target:id,id:data.id,clientSent:data.clientSent,masterNow:Date.now()});
      }else if(data.kind==='bye'){
        peers.delete(id);renderMasterPlayers();
      }
      return;
    }
    if(role!=='mobile'||!await verifyFromMaster(data))return;
    if(data.target&&data.target!==clientId&&!Array.isArray(data.target))return;
    if(Array.isArray(data.target)&&!data.target.includes(clientId))return;
    if(data.kind==='snapshot-updated'){
      if(typeof data.version!=='string'||!data.version||
         data.version===snapshotVersion||data.version===expectedSnapshotVersion)return;
      // A new song replaces the cached notes, but players keep their assigned pitches.
      expectedSnapshotVersion=data.version;
      snapshot=null;download=null;pendingTransport=null;clockSamples=[];
      mobileTransport={playing:false,position:0,executeAt:0,playbackRate:1,status:'Updating song'};
      $('#mobileCue').hidden=true;$('#mobileNotePicker').hidden=true;$('#mobileConnect').hidden=false;
      $('#mobileConnectTitle').textContent='Updating song…';
      $('#mobileConnectText').textContent='Downloading the latest notes for this phone.';
      sayHello(); // Request the new version; the master will reply privately.
      return;
    }
    if(data.kind==='snapshot-chunk'){
      receiveChunk(data);return;
    }
    if(data.kind==='transport'){
      // Join/rejoin: don't calculate song time with an unsynchronized device clock.
      // Keep only the newest command until a signed master pong establishes the offset.
      if(!snapshot||!clockSamples.length){
        if(!pendingTransport||Number(data.sequence)>Number(pendingTransport.sequence)){
          pendingTransport=data;
        }
        if(snapshot&&!$('#mobileCue').hidden)setMobileStatus('SYNCING WITH MASTER');
        return;
      }
      applyMobileTransport(data);return;
    }
    if(data.kind==='pong'){
      if(masterId&&data.source!==masterId)return;
      const sent=pendingPings.get(data.id);
      if(sent===undefined)return;
      pendingPings.delete(data.id);
      const localNow=Date.now(),rtt=Math.max(0,localNow-sent);
      clockSamples.push({rtt,offset:Number(data.masterNow)+rtt/2-localNow});
      clockSamples.sort((a,b)=>a.rtt-b.rtt);
      const samples=clockSamples.slice(0,Math.min(3,clockSamples.length));
      clockOffset=samples.reduce((sum,s)=>sum+s.offset,0)/samples.length;
      if(pendingTransport&&snapshot){
        const latest=pendingTransport;pendingTransport=null;
        applyMobileTransport(latest);
      }
      return;
    }
    if(data.kind==='room-full'){showConnectionError('Room is full. Maximum 50 players.');return}
    if(data.kind==='ended'){showConnectionError('The master has ended this session.');room?.close()}
  }
  function queueSnapshotFlush(delay=350){
    if(downloadTimer)clearTimeout(downloadTimer);
    downloadTimer=setTimeout(()=>{downloadTimer=null;void flushSnapshots()},delay);
  }
  function queueSnapshot(id){
    if(!id||!peers.has(id))return;
    downloadQueue.add(id);
    if(!flushingSnapshots)queueSnapshotFlush();
  }
  async function sendSnapshotToPlayer(id){
    if(!peers.has(id)||!liveConnected())return true;
    const version=snapshotVersion;
    const serialized=JSON.stringify({...getSnapshot(),version});
    const total=Math.max(1,Math.ceil(serialized.length/CHUNK_SIZE));
    const transferId=randomId();
    for(let index=0;index<total;index++){
      if(!liveConnected()||!peers.has(id))return false;
      if(snapshotVersion!==version){queueSnapshot(id);return true}
      // Only the addressed phone receives these large song chunks.
      const sent=await sendFromMaster('snapshot-chunk',{
        target:id,transferId,version,index,total,
        chunk:serialized.slice(index*CHUNK_SIZE,(index+1)*CHUNK_SIZE)
      },id);
      if(!sent)return false;
      if(total>1)await wait(60);
    }
    if(snapshotVersion===version)await sendCurrentTransport([id]);
    return true;
  }
  async function flushSnapshots(){
    if(flushingSnapshots||!liveConnected()||role!=='master')return;
    flushingSnapshots=true;
    try{
      while(downloadQueue.size&&liveConnected()&&role==='master'){
        // Four simultaneous targeted transfers at most, even when 50 phones join.
        const targets=[...downloadQueue].slice(0,4);
        for(const id of targets)downloadQueue.delete(id);
        const results=await Promise.all(targets.map(async id=>{
          try{return {id,ok:await sendSnapshotToPlayer(id)}}
          catch(error){console.warn('Song transfer failed',error);return {id,ok:false}}
        }));
        const failed=results.filter(result=>!result.ok);
        if(failed.length){
          for(const {id} of failed)downloadQueue.add(id);
          break; // Avoid a tight retry loop when the relay is unavailable.
        }
      }
    }finally{
      flushingSnapshots=false;
      if(downloadQueue.size&&liveConnected()&&role==='master')queueSnapshotFlush(1500);
    }
  }
  function receiveChunk(data){
    if(!Number.isInteger(data.index)||!Number.isInteger(data.total)||data.total<1||data.total>300||
      data.index<0||data.index>=data.total||typeof data.chunk!=='string'||data.chunk.length>CHUNK_SIZE)return;
    if(expectedSnapshotVersion&&data.version!==expectedSnapshotVersion)return;
    if(data.version===snapshotVersion&&snapshot)return;
    if(!download||download.id!==data.transferId){
      // Chunks may arrive slightly out of order; assemble by index.
      download={id:data.transferId,total:data.total,parts:new Array(data.total),received:0};
      if(!snapshot){$('#mobileConnectTitle').textContent='Downloading song…';$('#mobileConnect').hidden=false;}
    }
    if(download.total!==data.total||download.parts[data.index]!==undefined)return;
    download.parts[data.index]=data.chunk;download.received++;
    if(!snapshot)$('#mobileConnectText').textContent=Math.round(100*download.received/download.total)+'% of the song loaded';
    if(download.received!==download.total)return;
    try{
      const incoming=JSON.parse(download.parts.join(''));
      if(!Array.isArray(incoming.notes)||!Number.isFinite(Number(incoming.duration)))throw new Error('Invalid song');
      snapshot=incoming;snapshotVersion=data.version;expectedSnapshotVersion='';masterId=data.source;
      download=null;
      // First visit: choose notes. Returning visit: auto-restore Ready and catch up.
      if(restoreReadyNotes())void readyMobile({restored:true});
      else showMobilePicker();
      // Master responds with its CURRENT playback position, even during a song.
      // Hold that command until clock synchronization has finished.
      sayHello();
      void startClockSync();
    }catch(error){
      download=null;
      showConnectionError('Song download failed. Tap RECONNECT.');
      console.warn('Invalid song transfer',error);
    }
  }
  function currentTransport(){
    if(masterTransport?.command==='play'&&Date.now()<masterTransport.executeAt)return masterTransport;
    return {command:'sync',position:getPosition(),playing:isPlaying(),
      playbackRate:Number(getPlaybackRate?.())||1,masterNow:Date.now(),sequence:++transportSeq};
  }
  function sendCurrentTransport(target=null){
    return sendFromMaster('transport',{...currentTransport(),target});
  }
  async function startClockSync(){
    if(!liveConnected()||!snapshot)return;
    if(clockTimer)clearTimeout(clockTimer);
    clockSamples=[];
    for(let i=0;i<4;i++){
      if(!liveConnected())return;
      const id=randomId(),sent=Date.now();
      pendingPings.set(id,sent);
      sendFromPlayer('ping',{id,clientSent:sent});
      await wait(500);
    }
    clockTimer=setTimeout(()=>{void startClockSync()},120000);
  }
  async function host(){
    if(room&&role==='master'){$('#liveSessionModal').hidden=false;return}
    if(joining)return;
    if(!realtimeConfigured()){
      $('#info').textContent='Klung Realtime not configured. Set the two Vercel Supabase public variables.';
      return;
    }
    joining=true;role='master';code=randomCode();snapshotVersion=randomId();
    try{
      const credentials=await createMasterKey();signer=credentials.signer;publicKey=credentials.publicKey;
      await connect(code);
      const url=joinUrl(code,publicKey);
      $('#liveSessionCode').textContent=code.slice(0,4)+' '+code.slice(4);
      $('#liveSessionLink').value=url;
      $('#liveSessionModal').hidden=false;$('#hostSession').classList.add('active');
      $('#hostSession').innerHTML='<span>●</span> LIVE';
      await QRCode.toCanvas($('#liveSessionQr'),url,{width:260,margin:1,errorCorrectionLevel:'M',
        color:{dark:'#14211fff',light:'#ffffffff'}});
      renderMasterPlayers();
    }catch(error){
      room?.close();room=null;role=null;$('#info').textContent='Could not start session: '+error.message;
    }finally{joining=false}
  }
  async function end(){
    if(role==='master')await sendFromMaster('ended');
    else if(role==='mobile')sendFromPlayer('bye');
    room?.close();room=null;code='';masterId=null;snapshot=null;peers.clear();
    for(const timer of leaveTimers.values())clearTimeout(timer);
    leaveTimers.clear();onlinePresence.clear();
    if(downloadTimer)clearTimeout(downloadTimer);
    if(clockTimer)clearTimeout(clockTimer);
    role=isMobile?'mobile':null;
    $('#liveSessionModal').hidden=true;
    $('#hostSession')?.classList.remove('active');
    if($('#hostSession'))$('#hostSession').innerHTML='<span>⌁</span> MOBILE';
  }
  function preparePlay(position){
    if(!liveConnected()||role!=='master'||!peers.size)return null;
    const executeAt=Date.now()+3500;
    masterTransport={command:'play',position,executeAt,
      playbackRate:Number(getPlaybackRate?.())||1,sequence:++transportSeq};
    void sendFromMaster('transport',masterTransport);
    return {blocked:false,executeAt};
  }
  function broadcastPause(position){
    if(!liveConnected()||role!=='master')return;
    masterTransport={command:'pause',position,playing:false,
      playbackRate:Number(getPlaybackRate?.())||1,sequence:++transportSeq,masterNow:Date.now()};
    void sendFromMaster('transport',masterTransport);
  }
  function broadcastSeek(position,playing){
    if(!liveConnected()||role!=='master')return;
    masterTransport={command:'sync',position,playing:Boolean(playing),playbackRate:Number(getPlaybackRate?.())||1,
      masterNow:Date.now(),sequence:++transportSeq};
    void sendFromMaster('transport',masterTransport);
  }
  function broadcastSync(position){
    // Mobile animates locally; do not stream the playhead 30x per minute.
    if(!liveConnected()||Date.now()-lastSyncAt<30000)return;
    lastSyncAt=Date.now();broadcastSeek(position,true);
  }
  function refresh(){
    if(!liveConnected()||role!=='master')return;
    snapshotVersion=randomId();
    // Tell all phones the song changed; each downloads it on its own topic.
    void sendFromMaster('snapshot-updated',{version:snapshotVersion});
    void sendCurrentTransport();
    renderMasterPlayers();
  }

  function showMobilePicker(){
    if(!snapshot)return;$('#mobileConnect').hidden=true;$('#mobileCue').hidden=true;$('#mobileNotePicker').hidden=false;const choices=$('#mobileNoteChoices'),counts=new Map();for(const note of snapshot.notes)counts.set(note.pitch,(counts.get(note.pitch)||0)+1);const pitches=Array.isArray(allPitches)&&allPitches.length?[...allPitches]:[...counts.keys()].sort((a,b)=>a-b),available=new Set(pitches);mobileSelection=new Set([...mobileSelection].filter(pitch=>available.has(pitch)));$('#mobileReady').disabled=!mobileSelection.size;choices.replaceChildren(...pitches.map(pitch=>{const count=counts.get(pitch)||0,button=document.createElement('button');button.type='button';button.className='mobile-note-choice';button.classList.toggle('selected',mobileSelection.has(pitch));button.classList.toggle('unused',!count);button.style.setProperty('--note-color',noteColors[pitch%12]);button.style.setProperty('--note-ink',noteInk(pitch));button.dataset.pitch=String(pitch);button.innerHTML=`${displayedName(pitch)}<small>${count} NOTES</small>`;button.onclick=()=>{mobileSelection.has(pitch)?mobileSelection.delete(pitch):mobileSelection.add(pitch);button.classList.toggle('selected',mobileSelection.has(pitch));$('#mobileReady').disabled=!mobileSelection.size};return button}))
  }

  async function readyMobile({restored=false}={}){
    if(!mobileSelection.size||!snapshot)return;
    saveReadyNotes();
    $('#mobileNotePicker').hidden=true;$('#mobileConnect').hidden=true;$('#mobileCue').hidden=false;
    setMobileStatus(restored?'SYNCING WITH MASTER':liveConnected()?'WAITING FOR MASTER':'OFFLINE');
    updateOwnPresence();
    sendFromPlayer('ready',{pitches:[...mobileSelection]});
    try{wakeLock=await navigator.wakeLock?.request('screen')}catch{}
    // Browser fullscreen requires a direct tap. Don't request it on auto-restore.
    if(!restored){try{await document.documentElement.requestFullscreen?.()}catch{}}
    cancelAnimationFrame(mobileFrame);mobileFrame=requestAnimationFrame(renderMobileCue);
  }

  function setMobileStatus(label,disconnected=false){const cue=$('#mobileCue');$('#mobileCueStatus').textContent=label;cue.classList.toggle('disconnected',disconnected);cue.classList.remove('playing');cue.style.background='#0d1715'}
  function applyMobileTransport(data){
    const sequence=Number(data.sequence)||0;
    if(sequence<=lastSeq||!clockSamples.length)return;
    lastSeq=sequence;
    const playbackRate=Math.max(.1,Number(data.playbackRate)||Number(snapshot?.playbackSpeed)||1);
    if(data.command==='play'){
      mobileTransport={playing:true,position:Number(data.position)||0,
        executeAt:Number(data.executeAt)||Date.now()+clockOffset,playbackRate,status:'Get ready'};
      $('#mobileCue').classList.add('playing');return;
    }
    if(data.command==='pause'){
      mobileTransport={playing:false,position:Number(data.position)||0,executeAt:0,
        playbackRate,status:'PAUSED BY MASTER'};
      setMobileStatus('PAUSED BY MASTER');return;
    }
    if(data.command==='sync'){
      const masterNow=Date.now()+clockOffset;
      const elapsed=data.playing?Math.max(0,(masterNow-(Number(data.masterNow)||masterNow))/1000):0;
      const corrected=(Number(data.position)||0)+elapsed*playbackRate;
      mobileTransport={playing:Boolean(data.playing),position:corrected,executeAt:masterNow,
        playbackRate,status:data.playing?'Playing':'Waiting for master'};
      if(!data.playing)setMobileStatus('WAITING FOR MASTER');
    }
  }

  function renderMobileTimeline(timeline){
    if(!snapshot||!mobileTimelineContext)return false;const bounds=mobileTimeline.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2),width=bounds.width,height=bounds.height;if(!width||!height)return false;
    if(mobileTimeline.width!==Math.round(width*dpr)||mobileTimeline.height!==Math.round(height*dpr)){mobileTimeline.width=Math.round(width*dpr);mobileTimeline.height=Math.round(height*dpr)}
    const selectedPitches=[...mobileSelection].sort((a,b)=>a-b),laneByPitch=new Map(selectedPitches.map((pitch,index)=>[pitch,index])),activePitches=new Set(),hitEffects=[],c=mobileTimelineContext,laneWidth=width/Math.max(1,selectedPitches.length),top=58,hitY=Math.max(top+120,height-92),travel=hitY-top,lookAhead=4;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,width,height);if(!selectedPitches.length)return false;
    for(let lane=0;lane<selectedPitches.length;lane++){if(lane%2===0){c.fillStyle='rgba(255,255,255,.022)';c.fillRect(lane*laneWidth,top,laneWidth,hitY-top)}c.strokeStyle='rgba(255,255,255,.075)';c.beginPath();c.moveTo(lane*laneWidth+.5,top);c.lineTo(lane*laneWidth+.5,hitY+27);c.stroke()}
    for(const note of snapshot.notes){
      if(!mobileSelection.has(note.pitch))continue;const delta=note.start-timeline,duration=Math.max(.08,Number(note.duration)||.08);if(delta>lookAhead||delta<-duration-.18)continue;const lane=laneByPitch.get(note.pitch),gap=Math.min(12,Math.max(3,laneWidth*.035)),x=lane*laneWidth+gap,headY=hitY-delta/lookAhead*travel,noteHeight=Math.max(18,duration/lookAhead*travel),noteWidth=Math.max(12,laneWidth-gap*2),y=headY-noteHeight,color=noteColors[((note.pitch%12)+12)%12],active=delta<=.035&&delta>=-duration;if(active)activePitches.add(note.pitch);if(delta<=.045&&delta>=-.16)hitEffects.push({x:x+noteWidth/2,color,strength:1-Math.min(1,Math.abs(delta)/.16)});c.save();c.globalAlpha=active?1:delta>0?.48:.18;c.fillStyle=color;if(active){c.shadowColor=color;c.shadowBlur=34}c.beginPath();c.roundRect(x,y,noteWidth,noteHeight,Math.min(10,noteHeight/2));c.fill();c.shadowBlur=0;c.strokeStyle=active?'#fff':'rgba(255,255,255,.7)';c.lineWidth=active?4:1.5;c.stroke();if(noteWidth>=36&&noteHeight>=18){const label=active?'Klung!':displayedName(note.pitch),fontSize=Math.max(11,Math.min(active?30:25,noteWidth/(active?6:3.8))),labelY=active?Math.max(y+10,Math.min(headY-10,hitY-16)):Math.max(y+10,headY-11);c.fillStyle=noteInk(note.pitch);c.font=`900 ${fontSize}px sans-serif`;c.textAlign='center';c.textBaseline='middle';c.fillText(label,x+noteWidth/2,labelY)}c.restore();
    }
    // Transpose is a visual all-player cue; it does not generate piano notes.
    const transposeCues=Array.isArray(snapshot.transposes)?snapshot.transposes:[];
    let transposeActive=false;
    for(const cue of transposeCues){
      const delta=Number(cue.start)-timeline,seconds=.9;
      if(!Number.isFinite(delta)||delta>lookAhead||delta<-seconds)continue;
      const cueHead=hitY-delta/lookAhead*travel,cueHeight=Math.max(35,seconds/lookAhead*travel),cueTop=cueHead-cueHeight,active=delta<=.05&&delta>=-seconds;
      transposeActive ||= active;
      c.save();c.beginPath();c.rect(0,top,width,Math.max(0,hitY-top+30));c.clip();
      c.globalAlpha=active?.96:delta>0?.62:.32;
      c.fillStyle='rgba(255,207,82,.36)';c.fillRect(0,cueTop,width,cueHeight);c.strokeStyle='#ffcf52';c.lineWidth=3;c.strokeRect(1,cueTop,width-2,cueHeight);
      c.shadowColor='#ffcf52';c.shadowBlur=active?30:8;c.font=`900 ${Math.max(16,Math.min(28,width/15))}px sans-serif`;c.textAlign='center';c.textBaseline='middle';c.fillStyle='#fff2b9';c.fillText(cueLabel(cue),width/2,(cueTop+cueHead)/2,Math.max(28,width-28));c.restore();
    }
    if(transposeActive)for(const pitch of selectedPitches)activePitches.add(pitch);
    c.shadowColor='#ffcf52';c.shadowBlur=10;c.fillStyle='#ffcf52';c.fillRect(0,hitY,width,3);c.shadowBlur=0;
    for(const effect of hitEffects){const radius=24+25*effect.strength,glow=c.createRadialGradient(effect.x,hitY,0,effect.x,hitY,radius);glow.addColorStop(0,`${effect.color}f2`);glow.addColorStop(.28,`${effect.color}8c`);glow.addColorStop(1,`${effect.color}00`);c.save();c.globalAlpha=.4+.6*effect.strength;c.fillStyle=glow;c.beginPath();c.arc(effect.x,hitY,radius,0,Math.PI*2);c.fill();c.strokeStyle='#fff';c.lineWidth=2+3*effect.strength;c.beginPath();c.arc(effect.x,hitY,7+13*(1-effect.strength),0,Math.PI*2);c.stroke();c.restore()}
    c.textAlign='center';c.textBaseline='top';for(let lane=0;lane<selectedPitches.length;lane++){const pitch=selectedPitches[lane],active=activePitches.has(pitch),label=active?'Klung!':displayedName(pitch);c.save();c.fillStyle=active?'#fff':noteColors[((pitch%12)+12)%12];c.font=`900 ${Math.max(11,Math.min(active?20:22,laneWidth/(active?5.5:4)))}px sans-serif`;if(active){c.shadowColor=noteColors[((pitch%12)+12)%12];c.shadowBlur=20}c.fillText(label,lane*laneWidth+laneWidth/2,hitY+12);c.restore()}
    return activePitches.size>0;
  }

  function renderMobileCue(ms){
    mobileFrame=requestAnimationFrame(renderMobileCue);if(ms-mobileLastFrame<1000/70||!snapshot||$('#mobileCue').hidden)return;mobileLastFrame=ms;const cue=$('#mobileCue');
    if(!mobileTransport.playing){renderMobileTimeline(mobileTransport.position);cue.classList.remove('playing','active');cue.style.background='#0d1715';$('#mobileCueStatus').textContent=mobileTransport.status.toUpperCase();return}
    const masterNow=Date.now()+clockOffset;if(masterNow<mobileTransport.executeAt){renderMobileTimeline(mobileTransport.position);cue.classList.remove('active');cue.style.background='#0d1715';$('#mobileCueStatus').textContent='GET READY';return}
    const timeline=mobileTransport.position+(masterNow-mobileTransport.executeAt)/1000*mobileTransport.playbackRate,active=renderMobileTimeline(timeline);cue.classList.add('playing');cue.classList.toggle('active',active);cue.style.background='#0d1715';const activeCue=(snapshot?.transposes||[]).find(item=>timeline>=Number(item.start)&&timeline<Number(item.start)+.9);$('#mobileCueStatus').textContent=activeCue?cueLabel(activeCue):'PLAYING';
    if(timeline>(snapshot.duration||0)+.5){mobileTransport.playing=false;mobileTransport.status='Finished';setMobileStatus('FINISHED')}
  }

  async function initMobile(){
    document.body.classList.add('mobile-player-mode');
    $('#mobilePlayer').hidden=false;$('#mobileReady').onclick=readyMobile;
    $('#mobileReconnect').onclick=()=>{room?.reconnect();$('#mobileReconnect').hidden=true};
    if(!joinCode||!joinKey){showConnectionError('Session link is incomplete. Please scan the QR on the master again.');return}
    if(!realtimeConfigured()){showConnectionError('Realtime relay has not been configured on this deployment.');return}
    role='mobile';code=joinCode;
    try{
      verifier=await createVerifier(joinKey);
      await connect(joinCode);
    }catch(error){
      showConnectionError('Connection failed: '+(error?.message||error));
    }
    setTimeout(()=>{
      if(!snapshot&&room){
        $('#mobileConnectTitle').textContent='Still waiting for master…';
        $('#mobileConnectText').textContent='Keep the master session open, or tap RECONNECT.';
        $('#mobileReconnect').hidden=false;
      }
    },12000);
  }

  // Safari may freeze an inactive tab. On foreground resume, ask the master for
  // the latest transport so missed Pause/Seek events don't leave the player behind.
  document.addEventListener('visibilitychange',()=>{
    if(!isMobile||document.visibilityState!=='visible'||!snapshot||!liveConnected())return;
    sayHello();
    void startClockSync();
  });

  $('#liveSessionClose').onclick=()=>{$('#liveSessionModal').hidden=true};
  $('#liveSessionEnd').onclick=end;
  $('#liveSessionCopy').onclick=async()=>{try{await navigator.clipboard.writeText($('#liveSessionLink').value);$('#liveSessionCopy').textContent='COPIED';setTimeout(()=>$('#liveSessionCopy').textContent='COPY',1200)}catch{}}
  $('#liveSessionPlay').onclick=()=>onMasterPlay();
  $('#hostSession').onclick=host;
  if(isMobile)void initMobile();

  return {isMobile,host,end,preparePlay,broadcastPause,broadcastSeek,broadcastSync,refresh,show:()=>{$('#liveSessionModal').hidden=false},isHosting:()=>Boolean(room&&role==='master')};
}
