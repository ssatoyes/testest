(async()=>{
 const html = await (await fetch('https://www.youtube.com/watch?v=MgqKozGmmLw&hl=ko',{headers:{'user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'}})).text();
 const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
 const params = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/)?.[1];
 const ctxRaw = html.match(/"INNERTUBE_CONTEXT":(\{.*?\}),"INNERTUBE_CONTEXT_CLIENT_NAME"/)?.[1];
 console.log('ctxRaw', !!ctxRaw, 'len', ctxRaw?.length);
 const context=JSON.parse(ctxRaw);
 const body={context, params};
 const r=await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${key}`,{method:'POST',headers:{'content-type':'application/json','user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8','x-youtube-client-name': String(context.client.clientName || 1),'x-youtube-client-version': context.client.clientVersion},body:JSON.stringify(body)});
 const txt=await r.text();
 console.log('status',r.status,'len',txt.length,'head',txt.slice(0,800));
})();
