// Application-level receipts protect against accepted (202) but undelivered
// Realtime REST broadcasts. Fast path sends only to the intended phone.
export async function deliverSnapshotWithFallback({
  packets,sendTargeted,sendFallback,waitForReceipt,isValid,
  directTimeoutMs=2400,fallbackTimeoutMs=3000,pause=()=>Promise.resolve()
}){
  for(const packet of packets){
    if(!isValid())return {ok:false,usedFallback:false};
    await sendTargeted(packet);
    if(packets.length>1)await pause();
  }
  if(await waitForReceipt(directTimeoutMs))
    return {ok:true,usedFallback:false};
  if(!isValid())return {ok:false,usedFallback:false};
  for(const packet of packets){
    if(!isValid())return {ok:false,usedFallback:true};
    const sent=await sendFallback(packet);
    if(!sent)return {ok:false,usedFallback:true};
    if(packets.length>1)await pause();
  }
  return {ok:await waitForReceipt(fallbackTimeoutMs),usedFallback:true};
}
