import { loadSnapshot, replaceAllData } from "./db.js";
import { buildBackupObject, validateAndNormalizeImport } from "./schema.js";

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function backupFilename(date = new Date()) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return `food-health-log-backup-${adjusted.toISOString().slice(0, 10)}.json`;
}

export async function exportAllData() {
  const snapshot = await loadSnapshot();
  const backup = buildBackupObject(snapshot);
  downloadJson(backup, backupFilename());
  return backup.counts;
}

export async function readAndValidateFile(file) {
  if (!file || (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json")) {
    return { ok: false, errors: ["JSONファイルを選択してください"], warnings: [], snapshot: null, counts: null };
  }
  if (file.size > 25 * 1024 * 1024) {
    return { ok: false, errors: ["JSONファイルが25MBを超えています"], warnings: [], snapshot: null, counts: null };
  }
  try {
    const raw = JSON.parse(await file.text());
    return validateAndNormalizeImport(raw);
  } catch {
    return { ok: false, errors: ["JSONを解析できませんでした。ファイルが破損している可能性があります"], warnings: [], snapshot: null, counts: null };
  }
}

export async function backupThenReplace(candidate, hasCurrentData) {
  if (!candidate?.ok || !candidate.snapshot) throw new Error("検査済みデータがありません");
  if (hasCurrentData) {
    const current = await loadSnapshot();
    downloadJson(buildBackupObject(current), backupFilename());
  }
  await replaceAllData(candidate.snapshot);
}
