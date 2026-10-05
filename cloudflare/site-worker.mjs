import api from './worker.mjs';
import assets from './assets.mjs';
export default {async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path.startsWith('/v1/'))return api.fetch(request,env);
  const asset=assets[path==='/'?'/index.html':path];
  if(!asset)return new Response('Not found',{status:404});
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const bytes=asset.text===undefined?Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0)):asset.text;
  return new Response(request.method==='HEAD'?null:bytes,{headers:{
    'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',
    'X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'same-origin','X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...(path.endsWith('sw.js')?{'Service-Worker-Allowed':'/'}:{})
  }});
}};

