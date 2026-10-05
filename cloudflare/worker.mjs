import { APP_ID, digest, validateBackup } from '../cloud-snapshot.js';
const COOKIE='__Host-food-health-session';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern=/^[A-Za-z0-9_-]{43,128}$/;
class ApiError extends Error { constructor(status,message) { super(message); this.status=status; } }
const fail=(status,message)=>{throw new ApiError(status,message);};
function reply(value,status=200,token) { return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(token!==undefined?{'Set-Cookie':`${COOKIE}=${token||''}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token?34560000:0}`}:{})}}); }
function sameOrigin(r) { if(r.headers.get('Origin')!==new URL(r.url).origin || (r.headers.has('Sec-Fetch-Site')&&r.headers.get('Sec-Fetch-Site')!=='same-origin')) fail(403,'このアプリから操作してください'); }
function randomKey() {return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function getToken(r) {const values=(r.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));const t=values.length===1?values[0].slice(COOKIE.length+1):'';return keyPattern.test(t)?t:null;}
async function bodyJson(r) {
  if(!(r.headers.get('Content-Type')||'').startsWith('application/json')) fail(415,'JSONを指定してください');
  const max=24*1024*1024;if(Number(r.headers.get('Content-Length'))>max)fail(413,'データが大きすぎます');
  if(!r.body)fail(400,'データがありません');
  const reader=r.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
  try {for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>max){await reader.cancel();fail(413,'データが大きすぎます');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}catch(e){if(e instanceof ApiError)throw e;fail(400,'JSONを確認できません');}
}
async function verifyKey(r,env) {
  const match=/^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(r.headers.get('Authorization')||'');if(!match)fail(401,'復旧キーで本人確認してください');
  const minute=Math.floor(Date.now()/60000),ip=await digest(r.headers.get('CF-Connecting-IP')||'unknown'),bucket=`${minute}:${ip}`;
  const results=await env.DB.batch([env.DB.prepare('INSERT INTO auth_attempts(bucket,attempts) VALUES (?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket),env.DB.prepare('DELETE FROM auth_attempts WHERE bucket<?').bind(`${minute-10}:`)]);
  if(results[0].results[0].attempts>10)fail(429,'少し待ってから接続してください');
  const config=await env.DB.prepare('SELECT key_sha256 FROM auth_config WHERE app_id=?').bind(APP_ID).first();
  const expected=config?.key_sha256||env.BACKUP_TOKEN_SHA256,actual=await digest(match[1]);let delta=0;
  for(let i=0;i<64;i++)delta|=actual.charCodeAt(i)^expected.charCodeAt(i);
  if(delta)fail(401,'復旧キーを確認してください');
}
async function session(r,env) {
  const origin=r.headers.get('Origin'),site=r.headers.get('Sec-Fetch-Site');if(origin&&origin!==new URL(r.url).origin||site&&!['same-origin','none'].includes(site))fail(403,'このアプリから操作してください');
  const token=getToken(r);if(!token)fail(401,'この端末で接続してください');
  const row=await env.DB.prepare('SELECT * FROM auth_sessions WHERE app_id=? AND token_sha256=? AND revoked_at IS NULL').bind(APP_ID,await digest(token)).first();
  if(!row)fail(401,'認証が取り消されています。復旧キーで再接続してください');
  await env.DB.prepare('UPDATE auth_sessions SET last_used_at=? WHERE session_id=? AND app_id=? AND revoked_at IS NULL').bind(new Date().toISOString(),row.session_id,APP_ID).run();return {row,token};
}
async function readBackup(env,id) {
  const row=await env.DB.prepare('SELECT * FROM backups WHERE backup_id=? AND app_id=?').bind(id,APP_ID).first();if(!row)fail(404,'バックアップがありません');
  const chunks=(await env.DB.prepare('SELECT chunk_index,backup_json FROM backup_chunks WHERE backup_id=? ORDER BY chunk_index').bind(id).all()).results;
  if(chunks.length!==row.chunk_count||chunks.some((c,i)=>c.chunk_index!==i))fail(500,'保存内容を確認できません');
  const {chunk_count,verified_seq,...b}=row;b.backup_json=chunks.map(c=>c.backup_json).join('');
  try {await validateBackup(b);}catch{fail(500,'保存内容を照合できません');}return b;
}
async function finish(env,id) {
  await readBackup(env,id);
  const expired='SELECT backup_id FROM backups WHERE app_id=? AND verified_seq IS NOT NULL ORDER BY verified_seq DESC LIMIT -1 OFFSET 5';
  await env.DB.batch([
    env.DB.prepare('UPDATE backups SET verified_seq=(SELECT COALESCE(MAX(verified_seq),0)+1 FROM backups WHERE app_id=?) WHERE backup_id=? AND app_id=? AND verified_seq IS NULL').bind(APP_ID,id,APP_ID),
    env.DB.prepare(`DELETE FROM backup_chunks WHERE backup_id IN (${expired})`).bind(APP_ID),
    env.DB.prepare(`DELETE FROM backups WHERE backup_id IN (${expired})`).bind(APP_ID)
  ]);
}
async function saveBackup(env,b,id) {
  try{await validateBackup(b);}catch(e){fail(400,e.message);}if(b.backup_id!==id)fail(400,'バックアップIDが一致しません');
  let existing=await env.DB.prepare('SELECT backup_id FROM backups WHERE app_id=? AND backup_id=?').bind(APP_ID,id).first();
  if(!existing){
    const chunks=[];for(let start=0;start<b.backup_json.length;){let end=Math.min(start+200000,b.backup_json.length);const c=b.backup_json.charCodeAt(end-1);if(end<b.backup_json.length&&c>=0xd800&&c<=0xdbff)end--;chunks.push(b.backup_json.slice(start,end));start=end;}
    try {await env.DB.batch([env.DB.prepare('INSERT INTO backups(backup_id,app_id,schema_version,created_at,received_at,device_id,record_count,source_revision,sha256,byte_length,chunk_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id,APP_ID,1,b.created_at,new Date().toISOString(),b.device_id,b.record_count,b.source_revision,b.sha256,b.byte_length,chunks.length),...chunks.map((text,i)=>env.DB.prepare('INSERT INTO backup_chunks(backup_id,chunk_index,backup_json) VALUES (?,?,?)').bind(id,i,text))]);}
    catch {existing=await env.DB.prepare('SELECT backup_id FROM backups WHERE app_id=? AND backup_id=?').bind(APP_ID,id).first();if(!existing)fail(503,'クラウドに保存できませんでした。端末データは保持しています');}
  }
  const saved=await readBackup(env,id);for(const name of ['backup_json','sha256','created_at','device_id','source_revision'])if(saved[name]!==b[name])fail(409,'同じIDの別バックアップがあります');
  await finish(env,id);return {backup_id:id,sha256:b.sha256};
}
export default {async fetch(r,env) {
  try {
    if(!env.DB||!/^[0-9a-f]{64}$/.test(env.BACKUP_TOKEN_SHA256||''))fail(503,'クラウド設定が完了していません');
    const {pathname:path}=new URL(r.url),method=r.method;
    if(!['GET','HEAD'].includes(method))sameOrigin(r);
    const publicSession=row=>({connected:true,sessionId:row.session_id,deviceName:row.device_name});
    if(path==='/v1/session'&&method==='POST') {
      await verifyKey(r,env);const b=await bodyJson(r);if(typeof b.deviceName!=='string'||!b.deviceName.trim()||b.deviceName.length>80)fail(400,'端末名は1〜80文字で入力してください');
      const token=randomKey(),id=crypto.randomUUID(),now=new Date().toISOString(),statements=[];const old=getToken(r);
      if(old)statements.push(env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND token_sha256=? AND revoked_at IS NULL').bind(now,APP_ID,await digest(old)));
      statements.push(env.DB.prepare('INSERT INTO auth_sessions(session_id,app_id,token_sha256,device_name,created_at,last_used_at) VALUES (?,?,?,?,?,?)').bind(id,APP_ID,await digest(token),b.deviceName.trim(),now,now));await env.DB.batch(statements);
      return reply({connected:true,sessionId:id,deviceName:b.deviceName.trim()},200,token);
    }
    if(path.startsWith('/v1/sessions')&&method==='POST') {
      await verifyKey(r,env);const b=await bodyJson(r),now=new Date().toISOString();
      if(path==='/v1/sessions') {const token=getToken(r),hash=token?await digest(token):null;const rows=(await env.DB.prepare('SELECT * FROM auth_sessions WHERE app_id=? AND revoked_at IS NULL ORDER BY last_used_at DESC').bind(APP_ID).all()).results;return reply({sessions:rows.map(s=>({id:s.session_id,deviceName:s.device_name,createdAt:s.created_at,lastUsedAt:s.last_used_at,current:s.token_sha256===hash}))});}
      if(path==='/v1/sessions/rotate'){const key=randomKey();await env.DB.batch([env.DB.prepare('INSERT INTO auth_config(app_id,key_sha256) VALUES (?,?) ON CONFLICT(app_id) DO UPDATE SET key_sha256=excluded.key_sha256').bind(APP_ID,await digest(key)),env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL').bind(now,APP_ID)]);return reply({recoveryKey:key},200,null);}
      if(b.all!==true&&!uuid.test(b.sessionId))fail(400,'端末を確認してください');
      if(path==='/v1/sessions/revoke'){await (b.all===true?env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL').bind(now,APP_ID):env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND session_id=? AND revoked_at IS NULL').bind(now,APP_ID,b.sessionId)).run();return reply({revoked:true});}
      if(path==='/v1/sessions/rename'){if(typeof b.deviceName!=='string'||!b.deviceName.trim()||b.deviceName.length>80)fail(400,'端末名を確認してください');await env.DB.prepare('UPDATE auth_sessions SET device_name=? WHERE app_id=? AND session_id=? AND revoked_at IS NULL').bind(b.deviceName.trim(),APP_ID,b.sessionId).run();return reply({renamed:true});}
      fail(404,'操作がありません');
    }
    if(path==='/v1/session/logout'&&method==='POST'){const token=getToken(r);if(token)await env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND token_sha256=? AND revoked_at IS NULL').bind(new Date().toISOString(),APP_ID,await digest(token)).run();return reply({connected:false},200,null);}
    const auth=await session(r,env);
    if(path==='/v1/session'&&method==='GET')return reply(publicSession(auth.row),200,auth.token);
    if(path==='/v1/backups'&&method==='GET'){const rows=(await env.DB.prepare('SELECT backup_id,created_at,received_at,record_count,source_revision,byte_length FROM backups WHERE app_id=? AND verified_seq IS NOT NULL ORDER BY verified_seq DESC LIMIT 5').bind(APP_ID).all()).results;return reply({backups:rows},200,auth.token);}
    const match=/^\/v1\/backups\/([^/]+)$/.exec(path);if(!match||!uuid.test(match[1]))fail(404,'APIがありません');
    if(method==='GET')return reply(await readBackup(env,match[1]),200,auth.token);
    if(method==='PUT')return reply(await saveBackup(env,await bodyJson(r),match[1]),200,auth.token);
    fail(405,'対応していない操作です');
  }catch(e){return reply({error:e instanceof ApiError?e.message:'クラウドで処理できませんでした。端末データは保持しています'},e.status||500);}
}};
