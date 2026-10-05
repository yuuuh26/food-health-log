export const APP_ID = 'food-health-log';
export const MAX_BYTES = 10 * 1024 * 1024;
export async function digest(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,'0')).join(''); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateSnapshot(s) {
  if (!s || s.format !== APP_ID || s.version !== 1) throw Error('食事・体調ログのバックアップではありません');
  for (const [name,key] of [['foods','id'],['choices','id'],['records','id'],['settings','key']]) {
    if (!Array.isArray(s[name]) || s[name].length > 250000) throw Error('保存データの形式を確認してください');
    const ids = new Set();
    for (const item of s[name]) {
      if (!item || typeof item[key] !== 'string' || !item[key] || (key==='id'&&!/^[a-zA-Z0-9_-]+$/.test(item[key])) || ids.has(item[key])) throw Error('項目の識別子が不正です');
      ids.add(item[key]);
    }
  }
  for (const r of s.records) {
    if (r.items?.some(item => item.key!==undefined && (typeof item.key!=='string'||!/^[a-zA-Z0-9_-]+$/.test(item.key)))) throw Error('記録項目の識別子が不正です');
  }
  if (s.records.some(r => !['meal','health','habit'].includes(r.kind) || !Number.isFinite(Date.parse(r.occurredAt)))) throw Error('記録の種類・日時が不正です');
  if (new TextEncoder().encode(JSON.stringify(s)).length > MAX_BYTES) throw Error('クラウド保存は10MBまでです。端末データは保持しています');
  return s;
}
export async function createBackup(entry, deviceId) {
  const backup_json = JSON.stringify(validateSnapshot(entry.data));
  return { backup_id:entry.id, app_id:APP_ID, schema_version:1, created_at:entry.createdAt, device_id:deviceId, record_count:entry.data.records.length, source_revision:entry.revision, backup_json, sha256:await digest(backup_json), byte_length:new TextEncoder().encode(backup_json).length };
}
export async function validateBackup(b) {
  if (!b || !uuid.test(b.backup_id) || b.app_id !== APP_ID || b.schema_version !== 1 || !uuid.test(b.device_id) || !Number.isFinite(Date.parse(b.created_at)) || ![b.record_count,b.source_revision,b.byte_length].every(n=>Number.isSafeInteger(n)&&n>=0) || !/^[0-9a-f]{64}$/.test(b.sha256) || typeof b.backup_json !== 'string' || b.byte_length > MAX_BYTES) throw Error('バックアップ情報が不正です');
  if (new TextEncoder().encode(b.backup_json).length !== b.byte_length || await digest(b.backup_json) !== b.sha256) throw Error('バックアップを照合できません');
  const data = validateSnapshot(JSON.parse(b.backup_json));
  if (data.records.length !== b.record_count) throw Error('保存件数が一致しません');
  return data;
}
