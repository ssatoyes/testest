(async()=>{
 const html = await (await fetch('https://www.youtube.com/watch?v=MgqKozGmmLw&hl=ko',{headers:{'user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'}})).text();
 const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
 const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
 const params = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/)?.[1];
 console.log({key, clientVersion, paramsLen: params?.length, params: params?.slice(0,80)});
 const body={context:{client:{clientName:'WEB',clientVersion,hl:'ko',gl:'KR'}}, params};
 const r=await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${key}`,{method:'POST',headers:{'content-type':'application/json','user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'},body:JSON.stringify(body)});
 const txt=await r.text();
 console.log('status',r.status,'len',txt.length,'head',txt.slice(0,500));
})();
