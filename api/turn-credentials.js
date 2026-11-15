// Vercel serverless endpoint. Keep the long-lived Cloudflare TURN key in server-side env vars.
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const keyId=process.env.CLOUDFLARE_TURN_KEY_ID;
  const keyToken=process.env.CLOUDFLARE_TURN_KEY_TOKEN;
  if(!keyId||!keyToken)return res.status(503).json({error:'TURN_NOT_CONFIGURED'});
  try{
    const response=await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/'+encodeURIComponent(keyId)+'/credentials/generate-ice-servers',
      {
        method:'POST',
        headers:{Authorization:'Bearer '+keyToken,'Content-Type':'application/json'},
        body:JSON.stringify({ttl:21600}), // 6 hours, enough for most performances
        signal:AbortSignal.timeout(7000)
      }
    );
    if(!response.ok)throw new Error('TURN provider returned HTTP '+response.status);
    const data=await response.json();
    const iceServers=(Array.isArray(data.iceServers)?data.iceServers:[]).filter(server=>
      server.username&&server.credential&&
      (Array.isArray(server.urls)?server.urls:[server.urls]).some(url=>String(url).startsWith('turn'))
    );
    if(!iceServers.length)throw new Error('No TURN servers provided');
    return res.status(200).json({iceServers});
  }catch(error){
    console.error('TURN credential request failed',error.message);
    return res.status(502).json({error:'TURN_PROVIDER_UNAVAILABLE'});
  }
}
