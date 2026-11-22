import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  isFourDigitCode,sessionRoute,sessionUrl,newSessionCode,findSessionMaster
} from '../src/session-routing.js';

test('QR and typed join codes navigate to identical clean room URLs',()=>{
  const base='https://klung-one.vercel.app';
  assert.equal(sessionUrl(base,'1234'),base+'/1234');
  assert.equal(sessionUrl(base,'0007'),base+'/0007');
  assert.deepEqual(sessionRoute('/1234'),{
    isJoinPage:false,isPlayer:true,code:'1234',key:''
  });
  assert.equal(sessionRoute('/0007/').code,'0007');
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

test('Vercel serves both clean room URL and manual join form as SPA paths',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.ok(config.rewrites.some(({source,destination})=>
    source==='/joinsession'&&destination==='/index.html'));
  assert.ok(config.rewrites.some(({source,destination})=>
    source.includes('[0-9]{4}')&&destination==='/index.html'));
});
