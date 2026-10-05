import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './cloudflare/worker.mjs';
import { APP_ID, createBackup, digest, validateBackup, MAX_BYTES } from './cloud-snapshot.js';
import { buildBackupObject, validateAndNormalizeImport } from './schema.js';
const origin='https://food-health-log.test';
const empty=()=>({format:APP_ID,version:1,foods:[],choices:[],records:[],settings:[]});
function database() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./cloudflare/schema.sql',import.meta.url),'utf8'));
  function prepare(sql,args=[]) {return {bind(...values){return prepare(sql,values);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {success:true,meta:sqlite.prepare(sql).run(...args)};}, sql,args};}
  return {sqlite,prepare,async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>({success:true,results:/\bSELECT\b|\bRETURNING\b/i.test(s.sql)?sqlite.prepare(s.sql).all(...s.args):(sqlite.prepare(s.sql).run(...s.args),[])}));sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
}
async function fixture() {
  const DB=database(),key=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),env={DB,BACKUP_TOKEN_SHA256:await digest(key)};
  const request=async(path,method='GET',body,cookie,bearer=undefined,originHeader=origin)=>worker.fetch(new Request(origin+path,{method,headers:{Origin:originHeader,'Sec-Fetch-Site':'same-origin',...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(bearer?{Authorization:'Bearer '+bearer}: {})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  const login=await request('/v1/session','POST',{deviceName:'test'},undefined,key),session=await login.json(),cookie=login.headers.get('Set-Cookie').split(';')[0];
  return {DB,key,env,request,cookie,session};
}
test('authentication, CSRF, cross-app credentials, revocation and key rotation',async()=>{
  const f=await fixture();
  assert.equal((await f.request('/v1/backups')).status,401);
  assert.equal((await f.request('/v1/backups/'+crypto.randomUUID())).status,401);
  assert.equal((await f.request('/v1/backups/'+crypto.randomUUID(),'PUT',{},undefined)).status,401);
  assert.equal((await f.request('/v1/backups/'+crypto.randomUUID(),'DELETE',undefined,undefined)).status,401);
  assert.equal((await f.request('/v1/session','POST',{deviceName:'x'},undefined,'B'.repeat(43))).status,401);
  assert.equal((await f.request('/v1/backups','GET',undefined,'__Host-other-session=abc')).status,401);
  assert.equal((await f.request('/v1/session','POST',{deviceName:'x'},undefined,f.key,'https://evil.test')).status,403);
  assert.equal((await f.request('/v1/sessions/revoke','POST',{all:true},f.cookie)).status,401);
  assert.match(f.cookie,/__Host-food-health-session=/);
  assert.equal((await f.request('/v1/sessions/rename','POST',{sessionId:f.session.sessionId,deviceName:'renamed'},f.cookie,f.key)).status,200);
  assert.equal((await (await f.request('/v1/session','GET',undefined,f.cookie)).json()).deviceName,'renamed');
  await f.request('/v1/sessions/revoke','POST',{sessionId:f.session.sessionId},f.cookie,f.key);
  assert.equal((await f.request('/v1/backups','GET',undefined,f.cookie)).status,401);
  const rotate=await f.request('/v1/sessions/rotate','POST',{},undefined,f.key);assert.equal(rotate.status,200);
  assert.equal((await f.request('/v1/session','POST',{deviceName:'x'},undefined,f.key)).status,401);
});
test('verified five-version retention, idempotency, failed saves, chunk reassembly',async()=>{
  const f=await fixture();let last;
  for(let revision=1;revision<=7;revision++) {
    const data=empty();data.settings=[{key:'test',value:'😊日本語'.repeat(60000)+revision}];
    const entry={id:crypto.randomUUID(),revision,createdAt:new Date().toISOString(),data};
    const b=await createBackup(entry,f.session.sessionId);last=b;
    const response=await f.request('/v1/backups/'+b.backup_id,'PUT',b,f.cookie);assert.equal(response.status,200,await response.text());
    const read=await (await f.request('/v1/backups/'+b.backup_id,'GET',undefined,f.cookie)).json();assert.deepEqual(await validateBackup(read),data);
  }
  const history=await (await f.request('/v1/backups','GET',undefined,f.cookie)).json();assert.equal(history.backups.length,5);
  const oldIds=history.backups.map(b=>b.backup_id);
  assert.equal((await f.request('/v1/backups/'+last.backup_id,'PUT',last,f.cookie)).status,200);
  assert.deepEqual((await (await f.request('/v1/backups','GET',undefined,f.cookie)).json()).backups.map(b=>b.backup_id),oldIds);
  const invalid={...last,backup_id:crypto.randomUUID(),sha256:'0'.repeat(64)};assert.equal((await f.request('/v1/backups/'+invalid.backup_id,'PUT',invalid,f.cookie)).status,400);
  assert.deepEqual((await (await f.request('/v1/backups','GET',undefined,f.cookie)).json()).backups.map(b=>b.backup_id),oldIds);
  const data=empty();data.records=[{id:'new',kind:'habit',occurredAt:new Date().toISOString()}];
  const b=await createBackup({id:crypto.randomUUID(),revision:8,createdAt:new Date().toISOString(),data},f.session.sessionId);
  const original=f.DB.batch;f.DB.batch=async()=>{throw Error('simulated outage');};
  assert.equal((await f.request('/v1/backups/'+b.backup_id,'PUT',b,f.cookie)).status,503);f.DB.batch=original;
  assert.equal((await (await f.request('/v1/backups','GET',undefined,f.cookie)).json()).backups.length,5);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(DISTINCT backup_id) n FROM backup_chunks').get().n,5);
});
test('all settings round-trip and cloud size limit',async()=>{
  const data=empty();data.settings=[{key:'customPreference',value:{theme:'dark',text:'保存'}}];
  const imported=validateAndNormalizeImport(buildBackupObject(data));assert.equal(imported.ok,true);assert.deepEqual(imported.snapshot.settings,data.settings);
  const tooBig=empty();tooBig.settings=[{key:'text',value:'x'.repeat(MAX_BYTES)}];await assert.rejects(()=>createBackup({id:crypto.randomUUID(),revision:1,createdAt:new Date().toISOString(),data:tooBig},crypto.randomUUID()),/10MB/);
});
export { database };
