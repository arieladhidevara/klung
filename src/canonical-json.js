// Deterministic serialization is required for messages relayed through
// Supabase REST / WebSocket. Server JSON decoding may reorder object keys,
// but that must never invalidate the master's ECDSA signature.
function normalize(value){
  if(Array.isArray(value))return value.map(normalize);
  if(value!==null&&typeof value==='object'){
    const result={};
    for(const key of Object.keys(value).sort()){
      if(value[key]!==undefined)result[key]=normalize(value[key]);
    }
    return result;
  }
  return value;
}
export function canonicalJson(value){return JSON.stringify(normalize(value))}
