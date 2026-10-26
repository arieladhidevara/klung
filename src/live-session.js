import {joinRoom} from 'trystero';
import QRCode from 'qrcode';

const APP_ID='app.klung-one.vercel.live.v1';
const JOIN_ORIGIN='https://klung-one.vercel.app';
const $=selector=>document.querySelector(selector);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function randomCode(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=new Uint8Array(6);crypto.getRandomValues(bytes);
  return [...bytes].map(value=>alphabet[value%alphabet.length]).join('');
}

export function createLiveSession({getSnapshot,getPosition,getPlaybackRate,isPlaying,onMasterPlay,noteNames,noteColors,noteInk,allPitches}){
  const params=new URLSearchParams(location.search),joinCode=(params.get('session')||'').trim().toUpperCase();
  const isMobile=Boolean(joinCode)&&(location.pathname.replace(/\/+$/,'')==='/join'||params.has('mobile'));
  let role=isMobile?'mobile':null,room=null,code='',masterPeerId=null,snapshot=null,clockOffset=0,clockSamples=[],mobileSelection=new Set(),mobileTransport={playing:false,position:0,executeAt:0,playbackRate:1,status:'Waiting for master'};
  let stateAction,selectionAction,transportAction,clockAction,helloAction,mobileFrame=0,mobileLastFrame=0,wakeLock=null;
  const peers=new Map(),pendingPings=new Map();
  const mobileTimeline=$('#mobileTimeline'),mobileTimelineContext=mobileTimeline?.getContext('2d');
  const displayedName=pitch=>noteNames[((pitch%12)+12)%12];

  function safeSend(action,data,target){action?.send(data,target?{target}:undefined).catch(error=>console.warn('Live session send failed',error))}
  function joinUrl(sessionCode){const url=new URL('/join',JOIN_ORIGIN);url.searchParams.set('session',sessionCode);url.searchParams.set('mobile','1');return url.toString()}
  function roomId(sessionCode){return `klung-${sessionCode.toLowerCase()}`}
  function showConnectionError(message){
    if(role==='mobile'){$('#mobileConnectTitle').textContent='Could not connect';$('#mobileConnectText').textContent=message}
    else $('#info').textContent=message;
  }

  function setupActions(){
    stateAction=room.makeAction('klung-state');selectionAction=room.makeAction('klung-selection');transportAction=room.makeAction('klung-transport');clockAction=room.makeAction('klung-clock');helloAction=room.makeAction('klung-hello');
    stateAction.onMessage=(data,{peerId})=>{if(role!=='mobile')return;masterPeerId=peerId;snapshot=data;if($('#mobileCue').hidden||!mobileSelection.size)showMobilePicker();runClockSync()};
    selectionAction.onMessage=(data,{peerId})=>{if(role!=='master')return;const player=peers.get(peerId)||{number:peers.size+1};player.selection=Array.isArray(data.pitches)?data.pitches.map(Number):[];player.ready=player.selection.length>0;peers.set(peerId,player);renderMasterPlayers();if(player.ready&&isPlaying())broadcastSync(getPosition())};
    helloAction.onMessage=(data,{peerId})=>{if(role!=='master')return;const player=peers.get(peerId)||{number:peers.size+1};player.device=String(data?.device||'Mobile player').slice(0,36);peers.set(peerId,player);renderMasterPlayers();sendState(peerId)};
    clockAction.onMessage=(data,{peerId})=>{
      if(role==='master'&&data?.kind==='ping'){safeSend(clockAction,{kind:'pong',id:data.id,clientSent:data.clientSent,masterNow:Date.now()},peerId);return}
      if(role==='mobile'&&data?.kind==='pong'&&peerId===masterPeerId){const localNow=Date.now(),sent=pendingPings.get(data.id)??data.clientSent,rtt=localNow-sent;pendingPings.delete(data.id);clockSamples.push({rtt,offset:data.masterNow+rtt/2-localNow});clockSamples.sort((a,b)=>a.rtt-b.rtt);clockOffset=clockSamples.slice(0,Math.min(5,clockSamples.length)).reduce((sum,sample)=>sum+sample.offset,0)/Math.min(5,clockSamples.length)}
    };
    transportAction.onMessage=(data,{peerId})=>{if(role!=='mobile'||peerId!==masterPeerId)return;applyMobileTransport(data)};
  }

  function connect(sessionCode,nextRole){
    role=nextRole;code=sessionCode;room=joinRoom({appId:APP_ID,password:sessionCode},roomId(sessionCode),{onJoinError:details=>showConnectionError(details?.error||'The peer-to-peer connection failed. Try the same Wi-Fi or another network.')});setupActions();
    room.onPeerJoin=peerId=>{
      if(role==='master'){peers.set(peerId,{number:peers.size+1,ready:false,selection:[]});renderMasterPlayers();sendState(peerId)}
      else safeSend(helloAction,{device:navigator.userAgentData?.mobile?'Mobile player':'Browser player'},peerId);
    };
    room.onPeerLeave=peerId=>{if(role==='master'){peers.delete(peerId);renderMasterPlayers()}else if(peerId===masterPeerId){masterPeerId=null;mobileTransport.playing=false;setMobileStatus('MASTER DISCONNECTED',true)}};
  }

  function sendState(target){safeSend(stateAction,{...getSnapshot(),sentAt:Date.now()},target)}
  function renderMasterPlayers(){
    const list=$('#livePlayerList'),ready=[...peers.values()].filter(player=>player.ready).length;$('#livePlayerCount').textContent=`${peers.size} connected · ${ready} ready`;$('#liveSessionPlay').disabled=false;
    if(!peers.size){list.innerHTML='<small>Waiting for players…</small>';return}
    list.replaceChildren(...[...peers.values()].map(player=>{const row=document.createElement('div');row.className='live-player-row';const colors=(player.selection||[]).map(pitch=>`<b style="background:${noteColors[pitch%12]}"></b>`).join('');row.innerHTML=`<i></i><strong>Player ${player.number}</strong><small>${player.ready?'READY':'CHOOSING'}</small><span>${colors}${player.selection?.map(pitch=>displayedName(pitch)).join(' · ')||''}</span>`;return row}))
  }

  async function host(){
    if(room&&role==='master'){$('#liveSessionModal').hidden=false;return}
    code=randomCode();connect(code,'master');const url=joinUrl(code);$('#liveSessionCode').textContent=`${code.slice(0,3)} ${code.slice(3)}`;$('#liveSessionLink').value=url;$('#liveSessionModal').hidden=false;$('#hostSession').classList.add('active');$('#hostSession').innerHTML='<span>●</span> LIVE';
    try{await QRCode.toCanvas($('#liveSessionQr'),url,{width:260,margin:1,errorCorrectionLevel:'M',color:{dark:'#14211fff',light:'#ffffffff'}})}catch(error){showConnectionError('Could not generate QR: '+error.message)}
    renderMasterPlayers();
  }

  async function end(){
    if(room)await room.leave().catch(()=>{});room=null;role=isMobile?'mobile':null;code='';masterPeerId=null;peers.clear();$('#liveSessionModal').hidden=true;$('#hostSession')?.classList.remove('active');if($('#hostSession'))$('#hostSession').innerHTML='<span>⌁</span> MOBILE';
  }

  function preparePlay(position){
    if(!room||role!=='master'||!peers.size)return null;
    const executeAt=Date.now()+1800,payload={command:'play',position,playbackRate:Number(getPlaybackRate?.())||1,executeAt,sequence:crypto.randomUUID?.()||String(executeAt)};safeSend(transportAction,payload);return {blocked:false,executeAt};
  }
  function broadcastPause(position){if(room&&role==='master')safeSend(transportAction,{command:'pause',position,playbackRate:Number(getPlaybackRate?.())||1,masterNow:Date.now()})}
  function broadcastSeek(position,playing){if(room&&role==='master')safeSend(transportAction,{command:'sync',position,playing:Boolean(playing),playbackRate:Number(getPlaybackRate?.())||1,masterNow:Date.now()})}
  function broadcastSync(position){broadcastSeek(position,true)}
  function refresh(){if(room&&role==='master'){sendState();renderMasterPlayers()}}

  async function runClockSync(){
    if(!masterPeerId)return;clockSamples=[];
    for(let index=0;index<8;index++){const id=`${Date.now()}-${index}`,clientSent=Date.now();pendingPings.set(id,clientSent);safeSend(clockAction,{kind:'ping',id,clientSent},masterPeerId);await wait(180)}
  }

  function showMobilePicker(){
    if(!snapshot)return;$('#mobileConnect').hidden=true;$('#mobileCue').hidden=true;$('#mobileNotePicker').hidden=false;const choices=$('#mobileNoteChoices'),counts=new Map();for(const note of snapshot.notes)counts.set(note.pitch,(counts.get(note.pitch)||0)+1);const pitches=Array.isArray(allPitches)&&allPitches.length?[...allPitches]:[...counts.keys()].sort((a,b)=>a-b),available=new Set(pitches);mobileSelection=new Set([...mobileSelection].filter(pitch=>available.has(pitch)));$('#mobileReady').disabled=!mobileSelection.size;choices.replaceChildren(...pitches.map(pitch=>{const count=counts.get(pitch)||0,button=document.createElement('button');button.type='button';button.className='mobile-note-choice';button.classList.toggle('selected',mobileSelection.has(pitch));button.classList.toggle('unused',!count);button.style.setProperty('--note-color',noteColors[pitch%12]);button.style.setProperty('--note-ink',noteInk(pitch));button.dataset.pitch=String(pitch);button.innerHTML=`${displayedName(pitch)}<small>${count} NOTES</small>`;button.onclick=()=>{mobileSelection.has(pitch)?mobileSelection.delete(pitch):mobileSelection.add(pitch);button.classList.toggle('selected',mobileSelection.has(pitch));$('#mobileReady').disabled=!mobileSelection.size};return button}))
  }

  async function readyMobile(){
    if(!mobileSelection.size||!masterPeerId)return;safeSend(selectionAction,{pitches:[...mobileSelection]},masterPeerId);$('#mobileNotePicker').hidden=true;$('#mobileCue').hidden=false;setMobileStatus('WAITING FOR MASTER');
    try{wakeLock=await navigator.wakeLock?.request('screen')}catch{}
    try{await document.documentElement.requestFullscreen?.()}catch{}
    cancelAnimationFrame(mobileFrame);mobileFrame=requestAnimationFrame(renderMobileCue);
  }

  function setMobileStatus(label,disconnected=false){const cue=$('#mobileCue');$('#mobileCueStatus').textContent=label;cue.classList.toggle('disconnected',disconnected);cue.classList.remove('playing');cue.style.background='#0d1715'}
  function applyMobileTransport(data){
    const playbackRate=Math.max(.1,Number(data.playbackRate)||Number(snapshot?.playbackSpeed)||1);
    if(data.command==='play'){mobileTransport={playing:true,position:Number(data.position)||0,executeAt:Number(data.executeAt)||Date.now()+clockOffset,playbackRate,status:'Get ready'};$('#mobileCue').classList.add('playing');return}
    if(data.command==='pause'){mobileTransport={playing:false,position:Number(data.position)||0,executeAt:0,playbackRate,status:'PAUSED BY MASTER'};setMobileStatus('PAUSED BY MASTER');return}
    if(data.command==='sync'){
      const corrected=(Number(data.position)||0)+(data.playing?Math.max(0,(Date.now()+clockOffset-(Number(data.masterNow)||Date.now()+clockOffset))/1000)*playbackRate:0);mobileTransport={playing:Boolean(data.playing),position:corrected,executeAt:Date.now()+clockOffset,playbackRate,status:data.playing?'Playing':'Waiting for master'};
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
    c.shadowColor='#ffcf52';c.shadowBlur=10;c.fillStyle='#ffcf52';c.fillRect(0,hitY,width,3);c.shadowBlur=0;
    for(const effect of hitEffects){const radius=24+25*effect.strength,glow=c.createRadialGradient(effect.x,hitY,0,effect.x,hitY,radius);glow.addColorStop(0,`${effect.color}f2`);glow.addColorStop(.28,`${effect.color}8c`);glow.addColorStop(1,`${effect.color}00`);c.save();c.globalAlpha=.4+.6*effect.strength;c.fillStyle=glow;c.beginPath();c.arc(effect.x,hitY,radius,0,Math.PI*2);c.fill();c.strokeStyle='#fff';c.lineWidth=2+3*effect.strength;c.beginPath();c.arc(effect.x,hitY,7+13*(1-effect.strength),0,Math.PI*2);c.stroke();c.restore()}
    c.textAlign='center';c.textBaseline='top';for(let lane=0;lane<selectedPitches.length;lane++){const pitch=selectedPitches[lane],active=activePitches.has(pitch),label=active?'Klung!':displayedName(pitch);c.save();c.fillStyle=active?'#fff':noteColors[((pitch%12)+12)%12];c.font=`900 ${Math.max(11,Math.min(active?20:22,laneWidth/(active?5.5:4)))}px sans-serif`;if(active){c.shadowColor=noteColors[((pitch%12)+12)%12];c.shadowBlur=20}c.fillText(label,lane*laneWidth+laneWidth/2,hitY+12);c.restore()}
    return activePitches.size>0;
  }

  function renderMobileCue(ms){
    mobileFrame=requestAnimationFrame(renderMobileCue);if(ms-mobileLastFrame<1000/70||!snapshot||$('#mobileCue').hidden)return;mobileLastFrame=ms;const cue=$('#mobileCue');
    if(!mobileTransport.playing){renderMobileTimeline(mobileTransport.position);cue.classList.remove('playing','active');cue.style.background='#0d1715';$('#mobileCueStatus').textContent=mobileTransport.status.toUpperCase();return}
    const masterNow=Date.now()+clockOffset;if(masterNow<mobileTransport.executeAt){renderMobileTimeline(mobileTransport.position);cue.classList.remove('active');cue.style.background='#0d1715';$('#mobileCueStatus').textContent='GET READY';return}
    const timeline=mobileTransport.position+(masterNow-mobileTransport.executeAt)/1000*mobileTransport.playbackRate,active=renderMobileTimeline(timeline);cue.classList.add('playing');cue.classList.toggle('active',active);cue.style.background='#0d1715';$('#mobileCueStatus').textContent='PLAYING';
    if(timeline>(snapshot.duration||0)+.5){mobileTransport.playing=false;mobileTransport.status='Finished';setMobileStatus('FINISHED')}
  }

  function initMobile(){
    document.body.classList.add('mobile-player-mode');$('#mobilePlayer').hidden=false;$('#mobileReady').onclick=readyMobile;
    if(!joinCode){showConnectionError('The session code is missing.');return}connect(joinCode,'mobile');
    setTimeout(()=>{if(!snapshot)$('#mobileConnectText').textContent='Still looking for the master. Make sure their session stays open.'},8000);
  }

  $('#liveSessionClose').onclick=()=>{$('#liveSessionModal').hidden=true};
  $('#liveSessionEnd').onclick=end;
  $('#liveSessionCopy').onclick=async()=>{try{await navigator.clipboard.writeText($('#liveSessionLink').value);$('#liveSessionCopy').textContent='COPIED';setTimeout(()=>$('#liveSessionCopy').textContent='COPY',1200)}catch{}}
  $('#liveSessionPlay').onclick=()=>onMasterPlay();
  $('#hostSession').onclick=host;
  if(isMobile)initMobile();

  return {isMobile,host,end,preparePlay,broadcastPause,broadcastSeek,broadcastSync,refresh,show:()=>{$('#liveSessionModal').hidden=false},isHosting:()=>Boolean(room&&role==='master')};
}
