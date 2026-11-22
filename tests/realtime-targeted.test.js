import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Song chunks go only to their recipient while playback remains broadcast', async () => {
  const originalSocket=globalThis.WebSocket;
  const originalFetch=globalThis.fetch;
  const sockets=new Set(),posts=[];
  const events={master:[],one:[],two:[]};
  const masterId='00000000-0000-4000-8000-000000000001';
  const firstId='00000000-0000-4000-8000-000000000002';
  const secondId='00000000-0000-4000-8000-000000000003';
  const hubs=[];

  function deliver(topic,packet) {
    for(const socket of sockets)if(socket.readyState===MockSocket.OPEN&&socket.topics.has('realtime:'+topic)) {
      socket.onmessage?.({data:JSON.stringify({
        topic:'realtime:'+topic,event:'broadcast',
        payload:{event:'klung',payload:packet}
      })});
    }
  }
  class MockSocket {
    static OPEN=1;
    static CLOSED=3;
    constructor(url) {
      this.url=url;this.readyState=0;this.topics=new Set();
      sockets.add(this);
      queueMicrotask(()=>{this.readyState=MockSocket.OPEN;this.onopen?.()});
    }
    send(raw) {
      const packet=JSON.parse(raw);
      if(packet.event==='phx_join') {
        this.topics.add(packet.topic);
        queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({
          event:'phx_reply',ref:packet.ref,join_ref:packet.join_ref,topic:packet.topic,
          payload:{status:'ok',response:{}}
        })}));
      } else if(packet.event==='broadcast'){
        deliver(packet.topic.replace(/^realtime:/,''),packet.payload.payload);
      }
    }
    close() {this.readyState=MockSocket.CLOSED;sockets.delete(this);this.onclose?.()}
  }
  globalThis.WebSocket=MockSocket;
  globalThis.fetch=async (_url,options)=>{
    const post=JSON.parse(options.body);
    posts.push(post);
    for(const message of post.messages)deliver(message.topic,message.payload);
    return {ok:true,status:200};
  };
  try {
    const source=(await readFile(new URL('../src/realtime-hub.js',import.meta.url),'utf8'))
      .replaceAll('import.meta.env','({VITE_KLUNG_SUPABASE_URL:"https://example.supabase.co",VITE_KLUNG_SUPABASE_PUBLISHABLE_KEY:"sb_publishable_test"})');
    const {createRealtimeHub}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    function make(role,id,onEvent){
      const hub=createRealtimeHub({code:'ROOM1234',clientId:id,role,onEvent});
      hubs.push(hub);return hub;
    }
    const master=make('master',masterId,packet=>events.master.push(packet));
    const one=make('mobile',firstId,packet=>events.one.push(packet));
    const two=make('mobile',secondId,packet=>events.two.push(packet));
    await Promise.all(hubs.map(hub=>hub.firstConnection));

    const delivered=await master.sendDirect('snapshot-chunk',{
      target:firstId,version:'version-1',chunk:'one private song chunk'
    },firstId);
    assert.equal(delivered,true);
    assert.equal(events.one.filter(event=>event.kind==='snapshot-chunk').length,1);
    assert.equal(events.two.filter(event=>event.kind==='snapshot-chunk').length,0);
    assert.equal(events.master.filter(event=>event.kind==='snapshot-chunk').length,0);
    assert.equal(posts.at(-1).messages[0].topic,'klung-phone-room1234-'+firstId);

    master.send('snapshot-updated',{version:'version-2'});
    master.send('transport',{command:'pause',playbackRate:1.5});
    for(const phone of [events.one,events.two]){
      assert.ok(phone.some(event=>event.kind==='snapshot-updated'));
      assert.ok(phone.some(event=>event.kind==='transport'&&event.playbackRate===1.5));
    }
    one.send('hello',{version:'version-1'});
    assert.ok(events.master.some(event=>event.kind==='hello'));
    assert.equal(events.two.some(event=>event.kind==='hello'),false);
  }finally{
    for(const hub of hubs)hub.close();
    globalThis.WebSocket=originalSocket;
    globalThis.fetch=originalFetch;
  }
});
