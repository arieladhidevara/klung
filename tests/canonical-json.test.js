import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { canonicalJson } from '../src/canonical-json.js';

const encoder=new TextEncoder();
const algorithm={name:'ECDSA',hash:'SHA-256'};

test('canonical JSON produces identical bytes after relay changes object key order',()=>{
  const before={
    kind:'snapshot-chunk',
    source:'master1',
    target:'phone1',
    payload:{version:'v1',index:0,notes:[{pitch:24,start:0.1,duration:0.5}]},
    enabled:true
  };
  // Simulate server decoding then serializing an unordered map / jsonb.
  const after={
    enabled:true,
    payload:{notes:[{duration:0.5,start:0.1,pitch:24}],index:0,version:'v1'},
    target:'phone1',
    source:'master1',
    kind:'snapshot-chunk'
  };
  assert.notEqual(JSON.stringify(before),JSON.stringify(after));
  assert.equal(canonicalJson(before),canonicalJson(after));
});

test('ECDSA signed song chunks remain authentic after REST relay key reordering',async()=>{
  const keys=await webcrypto.subtle.generateKey({
    name:'ECDSA',namedCurve:'P-256'
  },true,['sign','verify']);
  const outgoing={
    kind:'snapshot-chunk',source:'master1',target:'phone1',
    transferId:'abc',version:'one',index:0,total:1,chunk:'{"notes":[1,2,3]}'
  };
  const wire={
    chunk:outgoing.chunk,total:1,index:0,version:'one',
    transferId:'abc',target:'phone1',source:'master1',kind:'snapshot-chunk'
  };
  const sig=await webcrypto.subtle.sign(algorithm,keys.privateKey,
    encoder.encode(canonicalJson(outgoing)));
  assert.equal(await webcrypto.subtle.verify(algorithm,keys.publicKey,
    sig,encoder.encode(canonicalJson(wire))),true);
  assert.equal(await webcrypto.subtle.verify(algorithm,keys.publicKey,
    sig,encoder.encode(JSON.stringify(wire))),false);
  wire.chunk='tampered';
  assert.equal(await webcrypto.subtle.verify(algorithm,keys.publicKey,
    sig,encoder.encode(canonicalJson(wire))),false);
});
