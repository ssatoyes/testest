(async()=>{
 const html = await (await fetch('https://www.youtube.com/watch?v=MgqKozGmmLw&hl=ko',{headers:{'user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'}})).text();
 const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
 const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
 const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1];
 const params = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/)?.[1];
 const variants = [
  {clientName:1, clientVersion, hl:'ko', gl:'KR', visitorData},
  {clientName:'WEB', clientVersion, hl:'ko', gl:'KR', visitorData},
  {clientName:1, clientVersion, hl:'en', gl:'US', visitorData},
  {clientName:'WEB', clientVersion, hl:'en', gl:'US', visitorData},
 ];
 for (const client of variants) {
  const body={context:{client}, params};
  const r=await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${key}&prettyPrint=false`,{method:'POST',headers:{'content-type':'application/json','user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8','origin':'https://www.youtube.com','referer':'https://www.youtube.com/watch?v=MgqKozGmmLw','x-youtube-client-name': String(client.clientName === 'WEB' ? 1 : client.clientName),'x-youtube-client-version': clientVersion},body:JSON.stringify(body)});
  const txt=await r.text();
  console.log(client.clientName, client.hl, 'status', r.status, 'len', txt.length, txt.slice(0,80).replace(/\n/g,' '));
 }
})();
