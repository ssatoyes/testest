(async()=>{
 const html = await (await fetch('https://www.youtube.com/watch?v=MgqKozGmmLw&hl=ko',{headers:{'user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'}})).text();
 const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
 const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
 const rawParams = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/)?.[1];
 const paramsList=[rawParams, decodeURIComponent(rawParams)];
 for (const params of paramsList) {
  const body={context:{client:{clientName:'WEB',clientVersion,hl:'ko',gl:'KR',visitorData: html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1]}}, params, contentCheckOk:true, racyCheckOk:true};
  const r=await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${key}`,{method:'POST',headers:{'content-type':'application/json','user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8','origin':'https://www.youtube.com','referer':'https://www.youtube.com/watch?v=MgqKozGmmLw'},body:JSON.stringify(body)});
  const txt=await r.text();
  console.log('decoded?', params!==rawParams, 'status',r.status,'len',txt.length,'head',txt.slice(0,200));
 }
})();
