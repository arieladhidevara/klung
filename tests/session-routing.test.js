import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  isFourDigitCode,sessionRoute,sessionUrl,newSessionCode,findSessionMaster,
  isLegacyShortSessionPath,createMissingSessionGuard
} from '../src/session-routing.js';

test('QR and typed join codes navigate to identical clean room URLs',()=>{
  const base='https://klung-one.vercel.app';
  assert.equal(sessionUrl(base,'1234'),base+'/joinsession/1234');
  assert.equal(sessionUrl(base,'0007'),base+'/joinsession/0007');
  assert.deepEqual(sessionRoute('/joinsession/1234'),{
    isJoinPage:false,isPlayer:true,code:'1234',key:''
  });
  assert.equal(sessionRoute('/joinsession/0007/').code,'0007');
  assert.deepEqual(sessionRoute('/1234'),{
    isJoinPage:false,isPlayer:true,code:'1234',key:''
  });
  assert.equal(sessionRoute('/0007/').code,'0007');
  assert.equal(isLegacyShortSessionPath('/1234'),true);
  assert.equal(isLegacyShortSessionPath('/joinsession/1234'),false);
  assert.deepEqual(sessionRoute('/joinsession'),{
    isJoinPage:true,isPlayer:false,code:'',key:''
  });
  for(const invalid of ['123','12345','12ab','','0000?key=abc']){
    assert.equal(isFourDigitCode(invalid),false);
    assert.throws(()=>sessionUrl(base,invalid));
  }
  assert.equal(sessionRoute('/12345').isPlayer,false);
  assert.equal(sessionRoute('/').isPlayer,false);
});

test('Existing signed QR URLs still open the legacy /join player',()=>{
  assert.deepEqual(sessionRoute('/join','?session=ABCD1234&mobile=1&key=PUB'),{
    isJoinPage:false,isPlayer:true,code:'ABCD1234',key:'PUB'
  });
});

test('Master generates uniformly mapped four-digit codes including leading zeroes',()=>{
  for(const n of [0,1,42,9999,10000,19999,4294959999]){
    const code=newSessionCode(array=>{array[0]=n;return array});
    assert.equal(code.length,4);
    assert.match(code,/^[0-9]{4}$/);
    assert.equal(code,String(n%10000).padStart(4,'0'));
  }
  let attempts=0;
  assert.equal(newSessionCode(array=>{
    array[0]=attempts++?23:4294967295;return array;
  }),'0023');
  assert.equal(attempts,2);
});

test('Player discovers a unique master key and rejects ambiguous codes',()=>{
  const master={id:'master-1',role:'master',publicKey:'key-A'};
  const other={id:'master-2',role:'master',publicKey:'key-B'};
  const phone={id:'phone-1',role:'mobile'};
  assert.deepEqual(findSessionMaster([phone]),{status:'waiting'});
  assert.deepEqual(findSessionMaster([phone,master]),{
    status:'found',id:'master-1',key:'key-A'
  });
  assert.deepEqual(findSessionMaster([master,other]),{status:'conflict'});
  assert.deepEqual(findSessionMaster([master,other],'key-A'),{
    status:'found',id:'master-1',key:'key-A'
  });
  assert.deepEqual(findSessionMaster([master],'key-B'),{status:'waiting'});
});

test('Vercel SPA deep links serve index.html using official Vite catch-all',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.equal(config.cleanUrls,false);
  const rules=config.rewrites.filter(({destination})=>destination==='/index.html');
  assert.ok(rules.length>0);
  for(const path of ['/joinsession','/joinsession/1234','/joinsession/0007','/1234','/0007','/join','/']){
    assert.ok(rules.some(({source})=>new RegExp('^'+source).test(path)),
      'Deep link '+path+' must resolve to SPA index.html');
  }
});

test('Inactive four-digit session redirects only after connected grace period',()=>{
  let connected=false,redirects=0,scheduled=null,delay=0;
  const guard=createMissingSessionGuard({
    isConnected:()=>connected,onMissing:()=>redirects++,
    schedule:(fn,ms)=>{scheduled=fn;delay=ms;return 42},
    unschedule:()=>{scheduled=null}
  });
  guard.start();
  assert.equal(scheduled,null,'no redirects while relay is disconnected');
  connected=true;guard.start();
  assert.equal(delay,7000);
  assert.equal(typeof scheduled,'function');
  scheduled();
  assert.equal(redirects,1);
});

test('A discovered master cancels any automatic redirect, including after disconnect',()=>{
  let connected=true,redirects=0,callback=null,cancellations=0;
  const guard=createMissingSessionGuard({
    isConnected:()=>connected,onMissing:()=>redirects++,
    schedule:fn=>{callback=fn;return 1},
    unschedule:()=>{cancellations++}
  });
  guard.start();
  const oldCallback=callback;
  guard.markFound();
  assert.equal(cancellations,1);
  oldCallback();
  assert.equal(redirects,0,'no stale callback may redirect an active session');
  guard.stop();connected=false;guard.start();connected=true;guard.start();
  assert.equal(cancellations,1);
  assert.equal(redirects,0,'master temporarily disconnecting never kicks player');
});

test('Connection loss prevents an incorrect not-found redirect',()=>{
  let connected=true,redirects=0,callback=null;
  const guard=createMissingSessionGuard({
    isConnected:()=>connected,onMissing:()=>redirects++,
    schedule:fn=>{callback=fn;return 3},unschedule:()=>{}
  });
  guard.start();connected=false;callback();
  assert.equal(redirects,0);
});
