import { APP_VERSION, SCHEMA_VERSION, choiceKey } from "./schema.js";

const DB_NAME = "food-health-log-local-v1";
const DB_VERSION = 2;
const STORES = ["foodTemplates", "choiceTemplates", "records", "settings"];

const DEFAULT_SYMPTOMS = [
  "腹部膨満", "ガス", "腹痛", "下痢", "便秘", "吐き気",
  "だるさ", "眠気", "頭痛", "肌の変化", "睡眠の乱れ",
];

let dbPromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
  });
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("foodTemplates")) {
        const store = db.createObjectStore("foodTemplates", { keyPath: "id" });
        store.createIndex("category", "category", { unique: false });
      }
      if (!db.objectStoreNames.contains("choiceTemplates")) {
        const store = db.createObjectStore("choiceTemplates", { keyPath: "id" });
        store.createIndex("category", "category", { unique: false });
      }
      if (!db.objectStoreNames.contains("records")) {
        const store = db.createObjectStore("records", { keyPath: "id" });
        store.createIndex("kind", "kind", { unique: false });
        store.createIndex("occurredAt", "occurredAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("cloud")) db.createObjectStore("cloud");
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDBを開けませんでした"));
    request.onblocked = () => reject(new Error("別の画面がデータベース更新を妨げています"));
  });
  return dbPromise;
}

export async function getAll(storeName) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
}

export const cloudDefaults = () => ({ revision: 0, sentRevision: 0, allowUpload: false, lastSaved: null, inFlight: null });
function markChanged(transaction) {
  const store = transaction.objectStore("cloud"), request = store.get("meta");
  request.onsuccess = () => { const meta = request.result || cloudDefaults(); meta.revision++; store.put(meta, "meta"); };
}
function notifyChanged() { window.dispatchEvent(new Event("food-health-change")); }
export async function putOne(storeName, value) {
  const db = await openDatabase();
  const transaction = db.transaction([storeName, "cloud"], "readwrite");
  const store = transaction.objectStore(storeName), old = store.get(value[storeName === "settings" ? "key" : "id"]);
  old.onsuccess = () => { if (JSON.stringify(old.result) !== JSON.stringify(value)) { store.put(value); if (!(storeName === "settings" && value.key === "lastBackupAt")) markChanged(transaction); } };
  await transactionDone(transaction); notifyChanged(); return value;
}
export async function deleteOne(storeName, id) {
  const db = await openDatabase(), transaction = db.transaction([storeName, "cloud"], "readwrite");
  const store = transaction.objectStore(storeName), old = store.get(id);
  old.onsuccess = () => { if (old.result !== undefined) { store.delete(id); markChanged(transaction); } };
  await transactionDone(transaction); notifyChanged();
}
export async function readCloudState() {
  const db = await openDatabase(), transaction = db.transaction([...STORES, "cloud"], "readonly");
  const requests = STORES.map(name => requestResult(transaction.objectStore(name).getAll()));
  const [foods, choices, records, settings, meta] = await Promise.all([...requests, requestResult(transaction.objectStore("cloud").get("meta"))]);
  return { snapshot: { foods, choices, records: records.sort((a,b)=>new Date(b.occurredAt)-new Date(a.occurredAt)), settings }, meta: meta || cloudDefaults() };
}
export async function loadSnapshot() { return (await readCloudState()).snapshot; }
export async function updateCloudMeta(update) {
  const db = await openDatabase(), transaction = db.transaction("cloud", "readwrite"), store = transaction.objectStore("cloud"), request = store.get("meta");
  request.onsuccess = () => store.put(update(request.result || cloudDefaults()), "meta");
  await transactionDone(transaction);
}
export async function replaceAllData(snapshot, expectedRevision) {
  const db = await openDatabase(), transaction = db.transaction([...STORES, "cloud"], "readwrite");
  let failure;
  const metaStore = transaction.objectStore("cloud"), request = metaStore.get("meta");
  request.onsuccess = () => {
    const meta = request.result || cloudDefaults();
    if (expectedRevision !== undefined && expectedRevision !== meta.revision) { failure = Error("確認中に別の画面で更新されました。もう一度内容を確認してください"); transaction.abort(); return; }
    const safety = {}, pending = STORES.map(name => { const r = transaction.objectStore(name).getAll(); r.onsuccess = () => { safety[name] = r.result; if (Object.keys(safety).length !== STORES.length) return;
      metaStore.put({ snapshot: { foods:safety.foodTemplates, choices:safety.choiceTemplates, records:safety.records, settings:safety.settings }, meta, savedAt:new Date().toISOString() }, "restoreSafety");
      const sources = { foodTemplates:snapshot.foods, choiceTemplates:snapshot.choices, records:snapshot.records, settings:snapshot.settings };
      for (const name of STORES) { const store = transaction.objectStore(name); store.clear(); for (const item of sources[name]) store.put(item); }
      metaStore.put({ ...meta, revision:meta.revision+1, inFlight:null }, "meta");
    }; return r; });
  };
  try { await transactionDone(transaction); } catch (error) { throw failure || error; }
  notifyChanged();
}
export async function getRestoreSafety() { const db = await openDatabase(); return requestResult(db.transaction("cloud", "readonly").objectStore("cloud").get("restoreSafety")); }

export async function initializeFreshDatabase() {
  const settings = await getAll("settings");
  if (settings.some((item) => item.key === "symptomsSeeded" && item.value === true)) return;
  const existingChoices = await getAll("choiceTemplates");
  const hasImportedChoices = existingChoices.length > 0;
  const transactionDb = await openDatabase();
  const transaction = transactionDb.transaction(["choiceTemplates", "settings"], "readwrite");
  const choiceStore = transaction.objectStore("choiceTemplates");
  const existingNames = new Set(existingChoices.filter((item) => item.category === "症状").map((item) => choiceKey(item.name)));
  if (!hasImportedChoices) {
    DEFAULT_SYMPTOMS.forEach((name, index) => {
      if (existingNames.has(choiceKey(name))) return;
      choiceStore.put({
        id: `default-symptom-${index + 1}`,
        name,
        category: "症状",
        defaultAmount: 1,
        unit: "回",
        protein: 0,
        createdAt: new Date(index).toISOString(),
      });
    });
  }
  const settingStore = transaction.objectStore("settings");
  settingStore.put({ key: "symptomsSeeded", value: true });
  settingStore.put({ key: "schemaVersion", value: SCHEMA_VERSION });
  settingStore.put({ key: "appVersion", value: APP_VERSION });
  await transactionDone(transaction);
}

export async function countData(snapshot) {
  const source = snapshot || await loadSnapshot();
  return {
    foods: source.foods.length,
    choices: source.choices.length,
    records: source.records.length,
    settings: source.settings.length,
    total: source.foods.length + source.choices.length + source.records.length + source.settings.length,
  };
}

