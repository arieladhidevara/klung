// Lightweight Supabase Realtime client using the documented Phoenix JSON v1 protocol.
// All phones connect ONLY to the hosted relay, never to one another or to laptop WebRTC.
const RETRY_MAX=10000;
export function realtimeConfigured(){
  return Boolean(import.meta.env.VITE_KLUNG_SUPABASE_URL && import.meta.env.VITE_KLUNG_SUPABASE_PUBLISHABLE_KEY);
}
export function createRealtimeHub({code,clientId,role,onReady,onEvent,onPresence,onDisconnect,onError}){
  const base=import.meta.env.VITE_KLUNG_SUPABASE_URL;
  const key=import.meta.env.VITE_KLUNG_SUPABASE_PUBLISHABLE_KEY;
  if(!base||!key)throw new Error('Realtime is not configured. Set VITE_KLUNG_SUPABASE_URL and VITE_KLUNG_SUPABASE_PUBLISHABLE_KEY.');
  const endpoint=new URL(base);
  if(endpoint.protocol!=='https:'||!endpoint.hostname.endsWith('.supabase.co'))throw new Error('Invalid Supabase project URL.');
  endpoint.protocol='wss:';
  endpoint.pathname='/realtime/v1/websocket';
  endpoint.searchParams.set('apikey',key);
  endpoint.searchParams.set('vsn','1.0.0');
  const topic='realtime:klung-'+code.toLowerCase();
  const upstreamTopic='realtime:klung-master-'+code.toLowerCase();
  const topics=role==='master'?[topic,upstreamTopic]:[topic];
  let socket=null,closed=false,ready=false,ref=0,joinRef='',heartbeat=null,retry=null,attempt=0;
  const pendingJoins=new Map();
  let presence={},desiredPresence={id:clientId},everReady=false;
  let initialResolve,initialReject,firstAttemptDone=false;
  const firstConnection=new Promise((resolve,reject)=>{initialResolve=resolve;initialReject=reject});
  function clearJobs(){
    if(heartbeat)clearInterval(heartbeat);
    if(retry)clearTimeout(retry);
    heartbeat=null;retry=null;
  }
  function push(event,payload,channel=topic,replyRef=joinRef){
    if(socket?.readyState!==WebSocket.OPEN)return false;
    socket.send(JSON.stringify({topic:channel,event,payload,ref:String(++ref),join_ref:replyRef||undefined}));
    return true;
  }
  function emit(kind,payload={}){
    if(!ready)return false;
    const packet={kind,...payload};
    if(role==='master')return push('broadcast',{type:'broadcast',event:'klung',payload:packet});
    // Phone -> master uses a REST broadcast channel subscribed to ONLY by the master.
    fetch(base.replace(/\/$/,'')+'/realtime/v1/api/broadcast',{
      method:'POST',
      headers:{apikey:key,'Content-Type':'application/json'},
      body:JSON.stringify({messages:[{
        topic:upstreamTopic.replace(/^realtime:/,''),event:'klung',
        payload:packet,private:false
      }]}),
      signal:AbortSignal.timeout(8000)
    }).then(response=>{
      if(!response.ok)throw new Error('Master relay rejected '+kind+' ('+response.status+')');
    }).catch(error=>{console.warn(error);onError?.(error.message)});
    return true;
  }
  function presenceList(){
    return Object.entries(presence).flatMap(([key,value])=>(value?.metas||[]).map(meta=>({...meta,key})));
  }
  function notifyPresence(){onPresence?.(presenceList())}
  function scheduleRetry(){
    if(closed)return;
    const delay=Math.min(RETRY_MAX,600*Math.pow(1.7,Math.min(attempt++,6)))+Math.random()*250;
    retry=setTimeout(open,delay);
  }
  function open(){
    if(closed)return;
    clearJobs();
    ready=false;presence={};pendingJoins.clear();
    const ws=new WebSocket(endpoint.toString());
    socket=ws;
    ws.onopen=()=>{
      for(const channel of topics){
        const joinToken=String(++ref);
        pendingJoins.set(joinToken,channel);
        if(channel===topic)joinRef=joinToken;
        push('phx_join',{
          config:{
            broadcast:{ack:false,self:false},
            presence:{enabled:channel===topic,key:clientId},
            postgres_changes:[],private:false
          }
        },channel,joinToken);
      }
      heartbeat=setInterval(()=>push('heartbeat',{},'phoenix',null),20000);
    };
    ws.onmessage=evt=>{
      let msg;
      try{msg=JSON.parse(evt.data)}catch{return}
      if(Array.isArray(msg))msg={join_ref:msg[0],ref:msg[1],topic:msg[2],event:msg[3],payload:msg[4]};
      if(msg.event==='phx_reply'&&pendingJoins.has(msg.ref)){
        if(msg.payload?.status==='ok'){
          pendingJoins.delete(msg.ref);
          if(pendingJoins.size===0){
            ready=true;everReady=true;attempt=0;
            push('presence',{type:'presence',event:'track',payload:desiredPresence});
            if(!firstAttemptDone){firstAttemptDone=true;initialResolve(true)}
            onReady?.();
          }
        }else{
          const reason=msg.payload?.response?.message||'Realtime channel join rejected.';
          onError?.(reason);
          ws.close();
        }
        return;
      }
      if(msg.topic!==topic&&msg.topic!==upstreamTopic)return;
      if(msg.event==='broadcast'&&msg.payload?.event==='klung'){
        if(role==='master'||msg.topic===topic)onEvent?.(msg.payload.payload);
      }else if(msg.topic===topic&&msg.event==='presence_state'){
        presence=msg.payload||{};
        notifyPresence();
      }else if(msg.topic===topic&&msg.event==='presence_diff'){
        for(const [key,record] of Object.entries(msg.payload?.leaves||{})){
          const existing=presence[key]?.metas||[];
          const leaving=new Set((record?.metas||[]).map(x=>x.phx_ref));
          const remaining=existing.filter(x=>!leaving.has(x.phx_ref));
          if(remaining.length)presence[key]={metas:remaining};else delete presence[key];
        }
        for(const [key,record] of Object.entries(msg.payload?.joins||{})){
          const existing=presence[key]?.metas||[];
          const refs=new Set(existing.map(x=>x.phx_ref));
          presence[key]={metas:[...existing,...(record?.metas||[]).filter(x=>!refs.has(x.phx_ref))]};
        }
        notifyPresence();
      }else if(msg.event==='phx_error'||msg.event==='phx_close'){
        ws.close();
      }
    };
    ws.onerror=()=>{ /* onclose reports loss and reconnects */ };
    ws.onclose=()=>{
      if(socket!==ws)return;
      ready=false;
      clearJobs();
      onDisconnect?.(everReady);
      scheduleRetry();
    };
  }
  open();
  // Caller sees an actionable failure, while background reconnect remains enabled.
  setTimeout(()=>{if(!firstAttemptDone){firstAttemptDone=true;initialReject(new Error('Realtime connection timed out. Check network and Supabase settings.'))}},12000);
  return {
    connected:()=>ready,
    firstConnection,
    send:emit,
    setPresence(meta){desiredPresence={id:clientId,...meta};if(ready)push('presence',{type:'presence',event:'track',payload:desiredPresence})},
    getPresence:presenceList,
    reconnect(){if(closed)return;socket?.close();if(!socket||socket.readyState===WebSocket.CLOSED){clearJobs();open()}},
    close(){closed=true;ready=false;clearJobs();socket?.close();socket=null}
  };
}
