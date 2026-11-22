// Four-digit room URLs are short-lived pairing codes, not passwords.
const FOUR_DIGITS=/^[0-9]{4}$/;
export function isFourDigitCode(value){return FOUR_DIGITS.test(String(value||''))}
export function sessionRoute(pathname,search=''){
  const path=String(pathname||'/').replace(/\/+$/,'')||'/';
  const params=new URLSearchParams(search);
  const pathCode=path.match(/^\/([0-9]{4})$/)?.[1]||'';
  const legacyCode=(params.get('session')||'').trim().toUpperCase();
  const legacyPlayer=Boolean(legacyCode)&&(path==='/join'||params.has('mobile'));
  return {
    isJoinPage:path==='/joinsession',
    isPlayer:Boolean(pathCode||legacyPlayer),
    code:pathCode||(legacyPlayer?legacyCode:''),
    key:params.get('key')||''
  };
}
export function newSessionCode(getValues=bytes=>crypto.getRandomValues(bytes)){
  // Rejection sampling avoids favoring some codes when mapping random bytes.
  const max=Math.floor(0x100000000/10000)*10000,bytes=new Uint32Array(1);
  do{getValues(bytes)}while(bytes[0]>=max);
  return String(bytes[0]%10000).padStart(4,'0');
}
export function findSessionMaster(presences,expectedKey=''){
  // Presence is used for discovery only. Playback is checked with ECDSA.
  const masters=new Map();
  for(const item of presences||[]){
    if(item?.role!=='master'||typeof item.id!=='string'||!item.id||
       typeof item.publicKey!=='string'||!item.publicKey)continue;
    masters.set(item.id,{id:item.id,key:item.publicKey});
  }
  const candidates=[...masters.values()].filter(item=>!expectedKey||item.key===expectedKey);
  if(candidates.length>1)return {status:'conflict'};
  if(!candidates.length)return {status:'waiting'};
  return {status:'found',...candidates[0]};
}
