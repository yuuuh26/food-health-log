import { readCloudState, updateCloudMeta, replaceAllData, getRestoreSafety } from './db.js';
import { APP_ID, createBackup, validateBackup, validateSnapshot } from './cloud-snapshot.js';
import { buildBackupObject } from './schema.js';
import { downloadJson, backupFilename } from './import-export.js';
export const CLOUD_URL='https://food-health-log-backups.dengana-10011212.workers.dev/';
const cloudHost=new URL(CLOUD_URL).origin;
let connected=false,sessionId=null,status='未接続（端末の記録は利用できます）',timer,retryTimer,paused=false,meta;
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'まだありません';
export async function api(path,method='GET',body,key) {
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{Authorization:'Bearer '+key}: {})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok){const e=Error(data.error||'クラウド通信に失敗しました');e.status=response.status;throw e;}return data;
}
function message(value) {status=value;const e=document.querySelector('#cloud-status');if(e)e.textContent=status;}
async function refreshStatus() {meta=(await readCloudState()).meta;const last=document.querySelector('#cloud-last'),pending=document.querySelector('#cloud-pending');if(last)last.textContent=date(meta.lastSaved);if(pending)pending.textContent=meta.revision>meta.sentRevision?'あり（端末に保存済み）':'なし';message(status);}
function lock(fn) {if(!navigator.locks)throw Error('クラウド保存にはChromeで開いてください');return navigator.locks.request('food-health-cloud-send',fn);}
function schedule() {
  clearTimeout(timer);
  void readCloudState().then(({meta:m})=>{if(connected&&m.allowUpload&&(m.inFlight||m.revision>m.sentRevision)){message(navigator.onLine?'送信待ち（端末に保存済み）':'オフライン。端末に保存済み');timer=setTimeout(()=>void send().catch(handleError),2500);}return refreshStatus();}).catch(handleError);
}
function handleError(error) {
  if(error.status===401||error.status===403){connected=false;paused=true;message('再接続が必要です。端末の記録は保持しています');}
  else {message(error.message||'通信失敗。端末の記録は保持しています');clearTimeout(retryTimer);if(connected&&!paused)retryTimer=setTimeout(()=>void send().catch(handleError),30000);}
}
export async function send() {
  if(location.origin!==cloudHost||!connected||paused||!navigator.onLine)return;
  return lock(async()=>{
    for(let pass=0;pass<3;pass++) {
      const {snapshot,meta:m}=await readCloudState();if(!m.allowUpload||(!m.inFlight&&m.revision<=m.sentRevision))break;
      const entry=m.inFlight||{id:crypto.randomUUID(),revision:m.revision,createdAt:new Date().toISOString(),deviceId:sessionId,data:{format:APP_ID,version:1,...snapshot}};
      validateSnapshot(entry.data);
      if(!m.inFlight)await updateCloudMeta(current=>({...current,inFlight:entry}));
      const b=await createBackup(entry,entry.deviceId||sessionId);message('送信中（端末には保存済み）');
      await api('/v1/backups/'+entry.id,'PUT',b);
      const verified=await api('/v1/backups/'+entry.id);await validateBackup(verified);
      if(verified.backup_json!==b.backup_json||verified.source_revision!==entry.revision||verified.sha256!==b.sha256)throw Error('保存後の内容が一致しません');
      await updateCloudMeta(current=>current.inFlight?.id===entry.id?{...current,sentRevision:Math.max(current.sentRevision,entry.revision),lastSaved:verified.received_at,inFlight:null}:current);
      message('クラウドに保存済み');await refreshStatus();
    }
    const {meta:m}=await readCloudState();if(m.allowUpload&&m.revision>m.sentRevision)schedule();
  });
}
async function checkSession() {
  if(location.origin!==cloudHost)return;
  try {const s=await api('/v1/session');connected=true;paused=false;sessionId=s.sessionId;message('接続済み');await refreshStatus();if(meta.allowUpload)schedule();else message('接続済み。初回は保存か復元を選んでください');}
  catch(e){if(e.status===401){connected=false;message('未接続。復旧キーで接続してください');}else handleError(e);}
}
export function mountCloudSettings() {
  const root=document.querySelector('#cloud-settings');if(!root)return;
  if(location.origin!==cloudHost){root.innerHTML=`<section class="card"><h2>クラウド版へ引き継ぐ</h2><p>① この画面の「全データをJSONで保存」で書き出す<br>② クラウド版を開き、JSONを読み込む<br>③ 設定の復旧キーで接続し「今すぐクラウド保存」を押す</p><p>引き継ぎを確認するまで、この端末の元データを残してください。</p><a class="primary-button" href="${CLOUD_URL}" target="_blank" rel="noopener">クラウド版を開く ↗</a></section>`;return;}
  root.innerHTML=`<details class="card cloud-card"><summary><b>☁ クラウド保存・設定</b></summary><p>端末への保存後、変更を約2.5秒まとめて自動保存。最新5世代を保持します（1件10MBまで）。複数端末では必要なときに履歴から復元してください。</p><dl><div><dt>状態</dt><dd id="cloud-status">${escape(status)}</dd></div><div><dt>前回の保存成功</dt><dd id="cloud-last">${date(meta?.lastSaved)}</dd></div><div><dt>未送信の変更</dt><dd id="cloud-pending">確認中</dd></div></dl><div class="cloud-connect"><label>復旧キー<input id="cloud-key" type="password" autocomplete="off" spellcheck="false" placeholder="専用の復旧キー"></label><label>この端末の名前<input id="cloud-device" maxlength="80" value="${/Android/.test(navigator.userAgent)?'Android':'パソコン'}"></label><button data-cloud="connect" type="button" class="subtle-button">この端末を接続</button></div><div class="cloud-buttons"><button data-cloud="save" type="button" class="primary-button">今すぐクラウド保存</button><button data-cloud="history" type="button" class="subtle-button">履歴から復元</button><button data-cloud="devices" type="button" class="subtle-button">接続端末の管理</button><button data-cloud="logout" type="button" class="subtle-button">この端末の接続を解除</button><button data-cloud="safety" type="button" class="subtle-button">置換前の退避データを保存</button></div><div id="cloud-results" aria-live="polite"></div></details>`;
  root.addEventListener('click',onAction);void refreshStatus().catch(handleError);
}
async function askKey() {const key=prompt('端末管理の本人確認：復旧キーを入力してください');if(!key)return null;if(!/^[A-Za-z0-9_-]{43,128}$/.test(key))throw Error('復旧キーを確認してください');return key;}
async function loadHistory() {
  const {backups}=await api('/v1/backups'),root=document.querySelector('#cloud-results');if(!root)return;
  root.innerHTML=backups.length?`<h3>クラウド履歴</h3>${backups.map(b=>`<p>${escape(date(b.received_at))}・記録${b.record_count}件 <button type="button" data-cloud="restore" data-id="${b.backup_id}" class="subtle-button">確認して復元</button></p>`).join('')}`:'<p>クラウド履歴はまだありません。</p>';
}
async function restore(id) {
  paused=true;
  try {await lock(async()=>{
    const before=await readCloudState(),backup=await api('/v1/backups/'+id),data=await validateBackup(backup);
    if(!confirm(`${date(backup.received_at)}のバックアップを復元します。\n食材${data.foods.length}件・症状/習慣${data.choices.length}件・記録${data.records.length}件・設定${data.settings.length}件\n現在の端末データはJSONと端末内に退避して置き換えます。続けますか？`))return;
    downloadJson(buildBackupObject(before.snapshot),backupFilename());
    await replaceAllData(data,before.meta.revision);
    await updateCloudMeta(m=>({...m,allowUpload:true}));window.dispatchEvent(new Event('food-health-restored'));message('復元しました。端末への保存を確認済み');
  });}finally{paused=false;schedule();}
}
async function manageDevices() {
  let key=await askKey();if(!key)return;
  try {const {sessions}=await api('/v1/sessions','POST',{},key),root=document.querySelector('#cloud-results');if(!root)return;
    root.innerHTML=`<h3>接続中の端末</h3>${sessions.map(s=>`<p><b>${escape(s.deviceName)}${s.current?'（この端末）':''}</b><br>作成：${escape(date(s.createdAt))}<br>最終利用：${escape(date(s.lastUsedAt))}<br><button type="button" data-cloud="rename" data-id="${s.id}" class="subtle-button">名前変更</button> <button type="button" data-cloud="revoke" data-id="${s.id}" class="subtle-button">取消</button></p>`).join('')}<button type="button" data-cloud="revoke-all" class="subtle-button">全端末を取り消す</button> <button type="button" data-cloud="rotate" class="subtle-button">復旧キー変更・全端末取消</button>`;
  }finally{key=null;}
}
async function onAction(event) {
  const button=event.target.closest('[data-cloud]');if(!button)return;button.disabled=true;
  try {
    const action=button.dataset.cloud;
    if(action==='connect') {
      const input=document.querySelector('#cloud-key');let key=input.value.trim();input.value='';
      try{const s=await api('/v1/session','POST',{deviceName:document.querySelector('#cloud-device').value},key);connected=true;paused=false;sessionId=s.sessionId;message('接続済み。初回は保存か復元を選んでください');await loadHistory();const m=(await readCloudState()).meta;if(m.allowUpload)schedule();}finally{key=null;}
    }
    if(action==='save') {
      if(!connected)throw Error('復旧キーでこの端末を接続してください');
      const current=await readCloudState();
      if(!current.meta.allowUpload){const {backups}=await api('/v1/backups');if(!confirm(`この端末の記録${current.snapshot.records.length}件をクラウドへ保存します。${backups.length?'既存のクラウド履歴があります。空の端末なら先に「履歴から復元」を選んでください。':''}`))return;await updateCloudMeta(m=>({...m,allowUpload:true,revision:m.revision+1}));}
      else if(current.meta.revision<=current.meta.sentRevision&&!current.meta.inFlight){message('変更はありません。クラウドに保存済み');return;}
      await send();
    }
    if(action==='history')await loadHistory();
    if(action==='restore')await restore(button.dataset.id);
    if(action==='devices')await manageDevices();
    if(action==='logout'){await api('/v1/session/logout','POST',{});connected=false;paused=true;message('この端末の接続を解除しました');}
    if(['revoke','rename','revoke-all','rotate'].includes(action)) {
      let key=await askKey();if(!key)return;
      try {
        if(action==='rename'){const name=prompt('新しい端末名');if(name)await api('/v1/sessions/rename','POST',{sessionId:button.dataset.id,deviceName:name},key);}
        if(action==='revoke'&&confirm('この端末のクラウド接続を取り消しますか？'))await api('/v1/sessions/revoke','POST',{sessionId:button.dataset.id},key);
        if(action==='revoke-all'&&confirm('すべての端末のクラウド接続を取り消しますか？'))await api('/v1/sessions/revoke','POST',{all:true},key);
        if(action==='rotate'&&confirm('新しい復旧キーを発行し、全端末の接続を取り消します。新しいキーのファイルを必ず保管してください。')){const b=await api('/v1/sessions/rotate','POST',{},key);const blob=new Blob([`食事・体調ログ 復旧キー\n${b.recoveryKey}\n${CLOUD_URL}\n`],{type:'text/plain'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='food-health-log-recovery-key.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);alert('新しい復旧キーをダウンロードしました。ファイルを保管してください。');}
        await checkSession();message('端末管理を更新しました');const root=document.querySelector('#cloud-results');if(root)root.textContent='管理を更新しました。端末一覧を開き直してください。';
      }finally{key=null;}
    }
    if(action==='safety'){const safety=await getRestoreSafety();if(!safety)throw Error('置換前の退避データはまだありません');downloadJson(buildBackupObject(safety.snapshot),'food-health-log-before-replace.json');message('置換前のデータを書き出しました');}
  }catch(e){handleError(e);}finally{button.disabled=false;await refreshStatus();}
}
export async function initializeCloud() {
  window.addEventListener('food-health-change',schedule);
  window.addEventListener('online',()=>void checkSession());
  window.addEventListener('focus',()=>{if(connected)void send().catch(handleError);});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&connected)void send().catch(handleError);});
  await refreshStatus();await checkSession();
}
