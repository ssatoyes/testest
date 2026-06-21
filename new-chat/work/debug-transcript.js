const fs = require('fs');
(async()=>{
 const html = await (await fetch('https://www.youtube.com/watch?v=MgqKozGmmLw&hl=ko',{headers:{'user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'}})).text();
 const marker='ytInitialPlayerResponse = ';
 const s=html.indexOf(marker)+marker.length;
 const e=html.indexOf(';</script>', s);
 const pr=JSON.parse(html.slice(s,e));
 const tracks=pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks||[];
 console.log(tracks.map(t=>({lang:t.languageCode,kind:t.kind,name:t.name?.simpleText,baseUrl:t.baseUrl.slice(0,160)})));
 const t=tracks.find(x=>x.languageCode==='ko') || tracks[0];
 for (const fmt of ['json3','srv3','vtt','ttml']) {
   const u=new URL(t.baseUrl); u.searchParams.set('fmt',fmt);
   const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'}});
   const txt=await r.text();
   console.log('\nFMT',fmt,'status',r.status,'ct',r.headers.get('content-type'),'len',txt.length,'head',txt.slice(0,300));
 }
})();
