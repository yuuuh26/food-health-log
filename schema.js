export const SCHEMA_VERSION = 1;
export const APP_VERSION = "1.0.0";
const MAX_COLLECTION_ITEMS = 100000;
const MAX_TOTAL_ITEMS = 250000;

const FOOD_CATEGORIES = new Set(["野菜", "肉・魚", "その他"]);
const CHOICE_CATEGORIES = new Set(["症状", "習慣", "設定"]);

export function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function choiceKey(value) {
  return normalizeText(value).toLocaleLowerCase("ja");
}

export function stableId(group, value, index = 0) {
  const source = value === undefined || value === null || value === "" ? `missing-${index}` : String(value);
  if (source.startsWith(`site-${group}-`)) return source;
  const safe = source.normalize("NFKC").replace(/[^a-zA-Z0-9_-]/g, (character) =>
    `_${character.codePointAt(0).toString(16)}_`);
  return `site-${group}-${safe}`;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label}が配列ではありません`);
    return [];
  }
  return value;
}

function normalizeTemplate(template, category, group, index, warnings) {
  const name = normalizeText(template?.name);
  if (!name) {
    warnings.push(`${category}テンプレートの${index + 1}件目は名前がないため除外しました`);
    return null;
  }
  const createdAt = validIso(template.createdAt) ? template.createdAt : new Date(0).toISOString();
  return {
    id: stableId(group, template.id, index),
    name,
    category,
    defaultAmount: Math.max(0, finiteNumber(template.defaultAmount, 1)),
    unit: normalizeText(template.unit) || (category === "肉・魚" ? "g" : category === "野菜" ? "中" : "個"),
    protein: Math.max(0, finiteNumber(template.protein, 0)),
    createdAt,
  };
}

function normalizeItem(item, index) {
  const amount = Math.max(0, finiteNumber(item?.amount, 1));
  const protein = Math.max(0, finiteNumber(item?.protein, 0));
  const baseAmount = Math.max(0, finiteNumber(item?.baseAmount, amount || 1));
  const baseProtein = Math.max(0, finiteNumber(item?.baseProtein, protein));
  return {
    key: normalizeText(item?.key) || `item-${index}`,
    name: normalizeText(item?.name) || "名称未設定",
    category: normalizeText(item?.category) || "その他",
    amount,
    unit: normalizeText(item?.unit) || "個",
    protein,
    baseAmount,
    baseProtein,
  };
}

function normalizeRecord(record, expectedKind, index, errors, warnings) {
  const kind = record?.kind;
  if (kind !== expectedKind) {
    errors.push(`${expectedKind}履歴の${index + 1}件目でkindが一致しません`);
    return null;
  }
  if (!validIso(record.occurredAt)) {
    errors.push(`${expectedKind}履歴の${index + 1}件目の日時が不正です`);
    return null;
  }
  const symptoms = Array.isArray(record.symptoms) ? record.symptoms.map((symptom) => ({
    name: normalizeText(symptom?.name) || "名称未設定",
    severity: Math.min(5, Math.max(1, Math.round(finiteNumber(symptom?.severity, 2)))),
  })) : [];
  if (!Array.isArray(record.items)) warnings.push(`${expectedKind}履歴の${index + 1}件目のitemsを空配列として読み込みます`);
  return {
    id: stableId("record", record.id, index),
    kind: expectedKind,
    occurredAt: new Date(record.occurredAt).toISOString(),
    mealType: "",
    title: normalizeText(record.title),
    items: Array.isArray(record.items) ? record.items.map(normalizeItem) : [],
    protein: Math.max(0, finiteNumber(record.protein, 0)),
    overallScore: record.overallScore == null ? null : Math.min(5, Math.max(1, Math.round(finiteNumber(record.overallScore, 3)))),
    temperature: record.temperature == null ? null : finiteNumber(record.temperature, null),
    symptoms,
    stoolType: normalizeText(record.stoolType),
    notes: String(record.notes ?? "").slice(0, 20000),
    createdAt: validIso(record.createdAt) ? record.createdAt : new Date(record.occurredAt).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function uniqueTemplates(templates) {
  const seen = new Set();
  return templates.filter((template) => {
    const key = `${template.category}\u0000${choiceKey(template.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateAndNormalizeImport(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["JSONの最上位がオブジェクトではありません"], warnings, snapshot: null, counts: null };
  }
  if (Number(raw.schemaVersion) !== SCHEMA_VERSION) {
    errors.push(`schemaVersion ${String(raw.schemaVersion)} には対応していません`);
  }
  if (!validIso(raw.exportedAt)) errors.push("exportedAtが有効な日時ではありません");

  const foodRaw = asArray(raw.foodTemplates, "foodTemplates", errors);
  const symptomRaw = asArray(raw.symptomTemplates, "symptomTemplates", errors);
  const habitRaw = asArray(raw.medicationHabitTemplates, "medicationHabitTemplates", errors);
  const mealRaw = asArray(raw.mealHistory, "mealHistory", errors);
  const healthRaw = asArray(raw.healthHistory, "healthHistory", errors);
  const habitHistoryRaw = asArray(raw.medicationHabitHistory, "medicationHabitHistory", errors);
  const systemRaw = Array.isArray(raw.settings?.systemTemplates) ? raw.settings.systemTemplates : [];

  const collections = [foodRaw, symptomRaw, habitRaw, mealRaw, healthRaw, habitHistoryRaw, systemRaw];
  if (collections.some((items) => items.length > MAX_COLLECTION_ITEMS)) {
    errors.push(`1種類あたり${MAX_COLLECTION_ITEMS.toLocaleString("ja-JP")}件を超えるデータは読み込めません`);
  }
  if (collections.reduce((total, items) => total + items.length, 0) > MAX_TOTAL_ITEMS) {
    errors.push(`合計${MAX_TOTAL_ITEMS.toLocaleString("ja-JP")}件を超えるデータは読み込めません`);
  }

  const foods = foodRaw.map((item, index) => {
    const category = FOOD_CATEGORIES.has(item?.category) ? item.category : "その他";
    return normalizeTemplate(item, category, "food", index, warnings);
  }).filter(Boolean);
  const choices = uniqueTemplates([
    ...symptomRaw.map((item, index) => normalizeTemplate(item, "症状", "symptom", index, warnings)),
    ...habitRaw.map((item, index) => normalizeTemplate(item, "習慣", "habit", index, warnings)),
    ...systemRaw.map((item, index) => normalizeTemplate(item, "設定", "setting", index, warnings)),
  ].filter(Boolean));
  const records = [
    ...mealRaw.map((item, index) => normalizeRecord(item, "meal", index, errors, warnings)),
    ...healthRaw.map((item, index) => normalizeRecord(item, "health", index, errors, warnings)),
    ...habitHistoryRaw.map((item, index) => normalizeRecord(item, "habit", index, errors, warnings)),
  ].filter(Boolean).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

  for (const record of records) {
    if (record.temperature != null && (record.temperature < 30 || record.temperature > 45)) {
      errors.push(`体調履歴の体温 ${record.temperature}℃ が範囲外です`);
    }
  }

  const counts = {
    foodTemplates: foods.length,
    symptomTemplates: choices.filter((item) => item.category === "症状").length,
    medicationHabitTemplates: choices.filter((item) => item.category === "習慣").length,
    mealHistory: records.filter((item) => item.kind === "meal").length,
    healthHistory: records.filter((item) => item.kind === "health").length,
    medicationHabitHistory: records.filter((item) => item.kind === "habit").length,
    settings: choices.filter((item) => item.category === "設定").length,
    totalHistory: records.length,
  };

  if (raw.counts && typeof raw.counts === "object") {
    for (const [key, value] of Object.entries(counts)) {
      if (raw.counts[key] != null && Number(raw.counts[key]) !== value) {
        warnings.push(`${key}の記載件数と実データ件数が一致しません。実データ${value}件を使用します`);
      }
    }
  }

  const settings = [
    { key: "schemaVersion", value: SCHEMA_VERSION },
    { key: "appVersion", value: APP_VERSION },
    { key: "symptomsSeeded", value: true },
    { key: "importedAt", value: new Date().toISOString() },
    { key: "importSource", value: raw.source ?? { app: "food-health-log" } },
    { key: "sourceExportedAt", value: raw.exportedAt ?? null },
    { key: "sourceSettings", value: raw.settings ?? {} },
  ];

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts,
    exportedAt: raw.exportedAt,
    snapshot: errors.length ? null : { foods, choices, records, settings },
  };
}

export function buildBackupObject({ foods, choices, records, settings }) {
  const mealHistory = records.filter((item) => item.kind === "meal");
  const healthHistory = records.filter((item) => item.kind === "health");
  const medicationHabitHistory = records.filter((item) => item.kind === "habit");
  const foodTemplates = foods.filter((item) => FOOD_CATEGORIES.has(item.category));
  const symptomTemplates = choices.filter((item) => item.category === "症状");
  const medicationHabitTemplates = choices.filter((item) => item.category === "習慣");
  const systemTemplates = choices.filter((item) => item.category === "設定");
  const appSettings = Object.fromEntries(settings.map((item) => [item.key, item.value]));
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    source: { app: "food-health-log", platform: "github-pages", exportFormat: "full-backup" },
    counts: {
      foodTemplates: foodTemplates.length,
      symptomTemplates: symptomTemplates.length,
      medicationHabitTemplates: medicationHabitTemplates.length,
      mealHistory: mealHistory.length,
      healthHistory: healthHistory.length,
      medicationHabitHistory: medicationHabitHistory.length,
      settings: settings.length + systemTemplates.length,
      totalTemplates: foods.length + choices.length,
      totalHistory: records.length,
    },
    foodTemplates,
    symptomTemplates,
    medicationHabitTemplates,
    mealHistory,
    healthHistory,
    medicationHabitHistory,
    settings: { systemTemplates, appSettings },
  };
}
