import { APP_VERSION, SCHEMA_VERSION, choiceKey } from "./schema.js";

const DB_NAME = "food-health-log-local-v1";
const DB_VERSION = 1;
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

export async function putOne(storeName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
  return value;
}

export async function deleteOne(storeName, id) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(id);
  await transactionDone(transaction);
}

export async function loadSnapshot() {
  const [foods, choices, records, settings] = await Promise.all(STORES.map(getAll));
  return {
    foods,
    choices,
    records: records.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)),
    settings,
  };
}

export async function replaceAllData(snapshot) {
  const db = await openDatabase();
  const transaction = db.transaction(STORES, "readwrite");
  const sources = {
    foodTemplates: snapshot.foods,
    choiceTemplates: snapshot.choices,
    records: snapshot.records,
    settings: snapshot.settings,
  };
  for (const storeName of STORES) {
    const store = transaction.objectStore(storeName);
    store.clear();
    for (const value of sources[storeName]) store.put(value);
  }
  await transactionDone(transaction);
}

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
