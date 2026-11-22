import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverSnapshotWithFallback} from '../src/snapshot-delivery.js';

const packets=[{kind:'snapshot-chunk',target:'phone1',index:0,chunk:'hello'}];

test('targeted song reaches only the requested phone when it acknowledges',async()=>{
  const direct=[],shared=[];
  const result=await deliverSnapshotWithFallback({
    packets,sendTargeted:async packet=>{direct.push(packet);return true},
    sendFallback:async packet=>{shared.push(packet);return true},
    waitForReceipt:async()=>true,isValid:()=>true
  });
  assert.deepEqual(result,{ok:true,usedFallback:false});
  assert.equal(direct.length,1);
  assert.equal(shared.length,0);
});

test('HTTP accepted but not received triggers bounded room fallback',async()=>{
  const direct=[],shared=[],timeouts=[];
  const result=await deliverSnapshotWithFallback({
    packets,sendTargeted:async packet=>{direct.push(packet);return true},
    sendFallback:async packet=>{shared.push(packet);return true},
    waitForReceipt:async timeout=>{timeouts.push(timeout);return timeouts.length===2},
    isValid:()=>true
  });
  assert.deepEqual(result,{ok:true,usedFallback:true});
  assert.deepEqual(shared,packets);
  assert.deepEqual(timeouts,[2400,3000]);
});

test('missing ACK after both routes returns failure for retry queue',async()=>{
  const result=await deliverSnapshotWithFallback({
    packets,sendTargeted:async()=>true,
    sendFallback:async()=>true,
    waitForReceipt:async()=>false,isValid:()=>true
  });
  assert.deepEqual(result,{ok:false,usedFallback:true});
});

test('cancelled transfer never sends fallback to a stale session',async()=>{
  let valid=true,shared=0;
  const result=await deliverSnapshotWithFallback({
    packets,sendTargeted:async()=>true,
    sendFallback:async()=>{shared++;return true},
    waitForReceipt:async()=>{valid=false;return false},
    isValid:()=>valid
  });
  assert.deepEqual(result,{ok:false,usedFallback:false});
  assert.equal(shared,0);
});

test('fails gracefully if room cannot publish fallback',async()=>{
  const result=await deliverSnapshotWithFallback({
    packets,sendTargeted:async()=>false,
    sendFallback:async()=>false,
    waitForReceipt:async()=>false,isValid:()=>true
  });
  assert.deepEqual(result,{ok:false,usedFallback:true});
});

test('rejected direct request immediately uses the fallback without waiting for 202',async()=>{
  let waitCalls=0,shared=0;
  const result=await deliverSnapshotWithFallback({
    packets,sendTargeted:async()=>false,
    sendFallback:async()=>{shared++;return true},
    waitForReceipt:async()=>{waitCalls++;return true},isValid:()=>true
  });
  assert.deepEqual(result,{ok:true,usedFallback:true});
  assert.equal(shared,1);
  assert.equal(waitCalls,1);
});
