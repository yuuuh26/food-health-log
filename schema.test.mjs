import test from "node:test";
import assert from "node:assert/strict";
import { buildBackupObject, validateAndNormalizeImport } from "./schema.js";

function validExport() {
  return {
    schemaVersion: 1,
    exportedAt: "2026-09-20T05:00:00.000Z",
    source: { app: "food-health-log", platform: "sites" },
    counts: {
      foodTemplates: 1,
      symptomTemplates: 1,
      medicationHabitTemplates: 1,
      mealHistory: 1,
      healthHistory: 1,
      medicationHabitHistory: 1,
      totalHistory: 3,
    },
    foodTemplates: [{ id: 1, name: "卵", category: "その他", defaultAmount: 1, unit: "個", protein: 7, createdAt: "2026-09-01T00:00:00.000Z" }],
    symptomTemplates: [{ id: 2, name: "腹部膨満", category: "症状", defaultAmount: 1, unit: "回", protein: 0, createdAt: "2026-09-01T00:00:00.000Z" }],
    medicationHabitTemplates: [{ id: 3, name: "処方薬", category: "習慣", defaultAmount: 1, unit: "回", protein: 0, createdAt: "2026-09-01T00:00:00.000Z" }],
    mealHistory: [{ id: 10, kind: "meal", occurredAt: "2026-09-20T01:00:00.000Z", items: [{ name: "卵", category: "その他", amount: 0.5, unit: "個", protein: 3.5, baseAmount: 1, baseProtein: 7 }], protein: 3.5, symptoms: [], notes: "" }],
    healthHistory: [{ id: 11, kind: "health", occurredAt: "2026-09-20T02:00:00.000Z", items: [], protein: 0, overallScore: 3, temperature: 36.5, symptoms: [{ name: "腹部膨満", severity: 3 }], stoolType: "タイプ4：普通便", notes: "" }],
    medicationHabitHistory: [{ id: 12, kind: "habit", occurredAt: "2026-09-20T03:00:00.000Z", items: [{ name: "処方薬", amount: 1, unit: "回", protein: 0 }], protein: 0, symptoms: [], notes: "食後" }],
    settings: { systemTemplates: [{ id: 4, name: "__symptom_defaults_seeded__", category: "設定", defaultAmount: 1, unit: "回", protein: 0 }], storage: { localRecordDays: 50 } },
  };
}

test("Sites版JSONを全カテゴリへ正規化できる", () => {
  const result = validateAndNormalizeImport(validExport());
  assert.equal(result.ok, true);
  assert.equal(result.counts.foodTemplates, 1);
  assert.equal(result.counts.symptomTemplates, 1);
  assert.equal(result.counts.medicationHabitTemplates, 1);
  assert.equal(result.counts.totalHistory, 3);
  assert.equal(result.snapshot.records[0].kind, "habit");
  assert.equal(result.snapshot.records.find((record) => record.kind === "health").temperature, 36.5);
});

test("同じSites IDは決定的な移行IDになる", () => {
  const first = validateAndNormalizeImport(validExport());
  const second = validateAndNormalizeImport(validExport());
  assert.equal(first.snapshot.records[0].id, second.snapshot.records[0].id);
  assert.equal(first.snapshot.foods[0].id, second.snapshot.foods[0].id);
});

test("未対応schemaVersionは拒否する", () => {
  const source = validExport();
  source.schemaVersion = 2;
  const result = validateAndNormalizeImport(source);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /schemaVersion/);
});

test("範囲外の体温は拒否する", () => {
  const source = validExport();
  source.healthHistory[0].temperature = 48;
  const result = validateAndNormalizeImport(source);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /体温/);
});

test("件数不一致は実配列を優先して警告する", () => {
  const source = validExport();
  source.counts.totalHistory = 99;
  const result = validateAndNormalizeImport(source);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /一致しません/);
});

test("GitHub Pages版バックアップを再び読み込める", () => {
  const imported = validateAndNormalizeImport(validExport());
  const backup = buildBackupObject(imported.snapshot);
  const restored = validateAndNormalizeImport(backup);
  assert.equal(restored.ok, true);
  assert.equal(restored.counts.totalHistory, 3);
  assert.equal(restored.counts.foodTemplates, 1);
  assert.equal(restored.snapshot.records[0].id, imported.snapshot.records[0].id);
});
