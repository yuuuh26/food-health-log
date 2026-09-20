import { deleteOne, initializeFreshDatabase, loadSnapshot, putOne } from "./db.js";
import { APP_VERSION, choiceKey, normalizeText } from "./schema.js";
import { backupThenReplace, exportAllData, readAndValidateFile } from "./import-export.js";

const app = document.querySelector("#app");
const toastElement = document.querySelector("#toast");
const modalRoot = document.querySelector("#modal-root");
const fileInput = document.querySelector("#json-file-input");
const foodCategories = ["野菜", "肉・魚", "その他"];
const overallLabels = ["とても悪い", "悪い", "普通", "良い", "とても良い"];
const hourOptions = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));

let toastTimer;
let deferredInstallPrompt = null;

const state = {
  activeTab: "meal",
  foods: [],
  choices: [],
  records: [],
  settings: [],
  saveStatus: "端末保存を準備中",
  persistStatus: "確認中",
  standalone: window.matchMedia("(display-mode: standalone)").matches,
  exportDays: "14",
  templateOpen: false,
  customFoodOpen: false,
  importCandidate: null,
  importStage: 0,
  importBusy: false,
  meal: freshMealDraft(),
  health: freshHealthDraft(),
  habit: freshHabitDraft(),
  newFood: { name: "", category: "野菜", defaultAmount: "100", protein: "" },
  customFood: "",
  customSymptom: "",
  newHabit: "",
};

function newId(prefix) {
  const value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function localDateTime(date = new Date()) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
}

function localDate(date = new Date()) {
  return localDateTime(date).slice(0, 10);
}

function roundedHourParts(date = new Date()) {
  const rounded = new Date(date);
  if (rounded.getMinutes() >= 46) rounded.setHours(rounded.getHours() + 1);
  rounded.setMinutes(0, 0, 0);
  return { date: localDate(rounded), hour: String(rounded.getHours()).padStart(2, "0") };
}

function freshMealDraft() {
  const time = roundedHourParts();
  return { id: null, date: time.date, hour: time.hour, notes: "", items: [] };
}

function freshHealthDraft() {
  return { id: null, occurredAt: localDateTime(), overallScore: null, temperature: "", symptoms: [], stoolType: "", notes: "" };
}

function freshHabitDraft() {
  const time = roundedHourParts();
  return { id: null, date: time.date, hour: time.hour, items: [], notes: "" };
}

function isoFromHour(date, hour) {
  return new Date(`${date}T${hour}:00:00`).toISOString();
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function displayDate(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function displayDay(value) {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function overallLabel(score) {
  return score && score >= 1 && score <= 5 ? overallLabels[score - 1] : "未評価";
}

function normalizedCategory(category) {
  return foodCategories.includes(category) ? category : "その他";
}

function itemAmountLabel(item) {
  if (item.category === "野菜") return item.unit;
  return `${item.amount}${item.category === "その他" ? "個" : item.unit}`;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.hidden = false;
  toastTimer = window.setTimeout(() => { toastElement.hidden = true; }, 3200);
}

function selectedDayProtein() {
  const saved = state.records
    .filter((record) => record.kind === "meal" && record.id !== state.meal.id && localDate(new Date(record.occurredAt)) === state.meal.date)
    .reduce((sum, record) => sum + Number(record.protein || 0), 0);
  const current = state.meal.items.reduce((sum, item) => sum + Number(item.protein || 0), 0);
  return { saved: round(saved), current: round(current), total: round(saved + current) };
}

function cumulativeProteinMap(records = state.records) {
  const result = new Map();
  const days = new Map();
  records.filter((record) => record.kind === "meal").forEach((record) => {
    const day = localDate(new Date(record.occurredAt));
    days.set(day, [...(days.get(day) || []), record]);
  });
  for (const dayRecords of days.values()) {
    const ordered = [...dayRecords].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    let total = 0;
    let index = 0;
    while (index < ordered.length) {
      const time = new Date(ordered[index].occurredAt).getTime();
      const same = [];
      while (index < ordered.length && new Date(ordered[index].occurredAt).getTime() === time) same.push(ordered[index++]);
      total = round(total + same.reduce((sum, record) => sum + Number(record.protein || 0), 0));
      same.forEach((record) => result.set(record.id, total));
    }
  }
  return result;
}

async function reloadData() {
  const snapshot = await loadSnapshot();
  state.foods = snapshot.foods;
  state.choices = snapshot.choices;
  state.records = snapshot.records;
  state.settings = snapshot.settings;
}

async function saveToStore(store, value, message) {
  try {
    await putOne(store, value);
    state.saveStatus = "端末に保存済み";
    if (message) showToast(message);
    return true;
  } catch (error) {
    console.error(error);
    state.saveStatus = "保存できませんでした";
    showToast("端末に保存できませんでした。空き容量やブラウザ設定を確認してください");
    return false;
  }
}

function render() {
  const protein = selectedDayProtein();
  app.innerHTML = `
    <main>
      <header class="topbar">
        <div class="brand">
          <img class="brand-icon" src="./icon-v1-192.png" alt="" width="54" height="54">
          <div><p class="eyebrow">MEAL &amp; BODY JOURNAL</p><h1>食事・体調ログ</h1></div>
        </div>
        <div class="today-protein"><span>${escapeHtml(displayDay(state.meal.date))}の合計</span><strong>${protein.total}<small>g</small></strong></div>
      </header>
      <nav class="tabbar" aria-label="記録メニュー">
        ${tabButton("meal", "＋", "食べたもの")}
        ${tabButton("health", "♡", "体調")}
        ${tabButton("habit", "✓", "服薬・習慣")}
        ${tabButton("history", "◷", "履歴・出力")}
      </nav>
      <div class="page-shell">
        ${state.activeTab === "meal" ? renderMeal() : ""}
        ${state.activeTab === "health" ? renderHealth() : ""}
        ${state.activeTab === "habit" ? renderHabit() : ""}
        ${state.activeTab === "history" ? renderHistory() : ""}
      </div>
      ${renderFooter()}
    </main>`;
  renderImportModal();
}

function tabButton(tab, symbol, label) {
  return `<button type="button" class="${state.activeTab === tab ? "active" : ""}" data-action="tab" data-tab="${tab}"><span aria-hidden="true">${symbol}</span>${label}</button>`;
}

function renderMeal() {
  const protein = selectedDayProtein();
  const templates = state.foods.filter((food) => foodCategories.includes(food.category));
  return `<form class="panel-grid" data-form="meal">
    <section class="card main-card">
      <div class="section-heading">
        <div><p class="step">${state.meal.id ? "EDITING FOOD LOG" : "FOOD LOG"}</p><h2>${state.meal.id ? "食事記録を変更" : "何を食べた？"}</h2></div>
        <div class="hour-fields">
          <input aria-label="食べた日付" type="date" value="${state.meal.date}" data-model="meal.date" required>
          <select aria-label="食べた時刻" data-model="meal.hour">${hourOptions.map((hour) => `<option ${state.meal.hour === hour ? "selected" : ""} value="${hour}">${hour}時</option>`).join("")}</select>
        </div>
      </div>
      <p class="time-help">時刻は自動で1時間単位に設定（45分までは切り捨て、46分以降は次の時刻）。後から自由に変更できます。</p>
      <div class="field-label split-label"><span>使った食材</span><small>タグをタップして選択</small></div>
      ${templates.length ? `<div class="food-groups">${foodCategories.map((category) => renderFoodGroup(category, templates)).join("")}</div>` : `<p class="empty-mini">よく使う食材を登録すると、ここにタグで並びます。</p>`}
      <button class="subtle-button" type="button" data-action="toggle-template">${state.templateOpen ? "登録欄を閉じる" : "＋ よく使う食材・間食を登録"}</button>
      ${state.templateOpen ? renderFoodTemplateForm() : ""}
      <button class="subtle-button custom-toggle" type="button" data-action="toggle-custom-food">${state.customFoodOpen ? "今回だけの入力を閉じる" : "＋ 今回だけの食材・間食を入力"}</button>
      ${state.customFoodOpen ? `<div class="quick-add"><input data-model="customFood" value="${escapeHtml(state.customFood)}" placeholder="今回だけの食材・間食を入力"><button type="button" data-action="add-custom-food">追加</button></div>` : ""}
      ${state.meal.items.length ? `<div class="item-list">${state.meal.items.map(renderMealItem).join("")}</div>` : ""}
      <label class="field-label">メモ <span>調味料・食べた量の感覚など</span></label>
      <textarea data-model="meal.notes" placeholder="例：油は少なめ。食後に少し満腹感が強かった。">${escapeHtml(state.meal.notes)}</textarea>
    </section>
    <aside class="card sticky-summary">
      <p class="step">PROTEIN</p>
      <div class="protein-total"><strong>${protein.current}</strong><span>g</span></div><p>今回のたんぱく質合計</p>
      <div class="summary-rule"></div>
      <div class="day-protein-total"><span>${escapeHtml(displayDay(state.meal.date))}の一日合計</span><strong>${protein.total}<small>g</small></strong></div>
      <div class="protein-goals"><div><span>基本目標</span><strong>65<small>g</small></strong></div><div><span>充実目標</span><strong>75<small>g</small></strong></div><div><span>飽和目安</span><strong>85<small>g</small></strong></div></div>
      <p class="summary-detail">記録済み ${protein.saved}g ＋ 今回 ${protein.current}g。食事を変更中は、変更前の数値を除いて計算します。</p>
      <button class="primary-button" type="submit">${state.meal.id ? "変更を保存する" : "この食事を記録する"}<span>→</span></button>
      ${state.meal.id ? `<button class="cancel-edit-button" type="button" data-action="cancel-edit" data-kind="meal">編集をやめる</button>` : ""}
    </aside>
  </form>`;
}

function renderFoodGroup(category, templates) {
  const foods = templates.filter((food) => food.category === category).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  if (!foods.length) return "";
  return `<section class="food-group"><h3>${category}</h3><div class="food-palette">${foods.map((food) => {
    const selected = state.meal.items.some((item) => item.templateId === food.id);
    const detail = category === "肉・魚" ? `基準 ${food.defaultAmount}g · P ${food.protein}g` : category === "その他" ? `1個 P ${food.protein}g` : "";
    return `<div class="food-choice ${selected ? "selected" : ""}"><button type="button" data-action="toggle-food" data-id="${escapeHtml(food.id)}"><b>${selected ? "✓ " : ""}${escapeHtml(food.name)}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</button><button class="choice-delete" type="button" data-action="delete-template" data-store="foodTemplates" data-id="${escapeHtml(food.id)}" aria-label="${escapeHtml(food.name)}を削除">×</button></div>`;
  }).join("")}</div></section>`;
}

function renderFoodTemplateForm() {
  const category = state.newFood.category;
  return `<div class="template-box">
    <label class="template-category-label">種類</label>
    <div class="category-switch">${foodCategories.map((item) => `<button type="button" class="${category === item ? "active" : ""}" data-action="set-food-category" data-category="${item}">${item}</button>`).join("")}</div>
    <div class="template-grid">
      <label class="template-name">食材名<input data-model="newFood.name" value="${escapeHtml(state.newFood.name)}" placeholder="例：${category === "野菜" ? "ブロッコリー" : category === "肉・魚" ? "鶏もも肉" : "豆腐"}"></label>
      ${category === "肉・魚" ? `<label>基準量<input type="number" inputmode="decimal" data-model="newFood.defaultAmount" value="${escapeHtml(state.newFood.defaultAmount)}"></label>` : ""}
      ${category !== "野菜" ? `<label>${category === "その他" ? "1個あたりのたんぱく質" : "基準量のたんぱく質"}<input type="number" inputmode="decimal" data-model="newFood.protein" value="${escapeHtml(state.newFood.protein)}" placeholder="g"></label>` : ""}
    </div>
    <button class="small-primary" type="button" data-action="save-food-template">登録する</button>
  </div>`;
}

function renderMealItem(item) {
  if (item.category === "野菜") {
    return `<div class="item-row vegetable-row"><div class="item-name"><strong>${escapeHtml(item.name)}</strong><button type="button" data-action="remove-meal-item" data-key="${item.key}">×</button></div><div class="vegetable-amount"><span>量</span><div>${["少", "中", "多"].map((level) => `<button type="button" class="${item.unit === level ? "active" : ""}" data-action="set-vegetable-level" data-key="${item.key}" data-level="${level}">${level}</button>`).join("")}</div></div></div>`;
  }
  const presets = item.category === "その他" ? `<div class="count-presets">${[1, 2, 3, 4, 5].map((count) => `<button type="button" class="${Number(item.amount) === count ? "active" : ""}" data-action="set-item-amount" data-key="${item.key}" data-amount="${count}">${count}</button>`).join("")}</div>` : "";
  return `<div class="item-row ${item.category === "その他" ? "fixed-row" : "protein-row"}">
    <div class="item-name"><strong>${escapeHtml(item.name)}</strong><button type="button" data-action="remove-meal-item" data-key="${item.key}">×</button></div>
    <label><span>${item.category === "その他" ? "個数" : "量"}</span>${presets}<div class="unit-input"><input type="number" min="0" step="any" inputmode="decimal" value="${item.amount}" data-item-key="${item.key}" data-item-field="amount"><b>${item.category === "その他" ? "個" : "g"}</b></div><small class="baseline-hint">基準 ${item.baseAmount}${item.category === "その他" ? "個" : "g"} → P ${item.baseProtein}g</small></label>
    <label><span>たんぱく質</span><div class="unit-input"><input type="number" min="0" step="any" inputmode="decimal" value="${item.protein}" data-item-key="${item.key}" data-item-field="protein"><b>g</b></div></label>
  </div>`;
}

function renderHealth() {
  const symptoms = state.choices.filter((item) => item.category === "症状").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return `<form class="single-column" data-form="health"><section class="card">
    <div class="section-heading"><div><p class="step coral">${state.health.id ? "EDITING BODY LOG" : "BODY LOG"}</p><h2>${state.health.id ? "体調記録を変更" : "今の体調は？"}</h2></div><input type="datetime-local" data-model="health.occurredAt" value="${state.health.occurredAt}"></div>
    <label class="field-label">全体的な体調 <span>未選択でも保存できます</span></label>
    <div class="score-row">${overallLabels.map((label, index) => `<button type="button" class="${state.health.overallScore === index + 1 ? "selected" : ""}" data-action="set-overall" data-score="${index + 1}"><b>${label}</b></button>`).join("")}</div>
    <label class="field-label">体温 <span>任意・℃</span></label><div class="temperature-field"><input type="number" min="30" max="45" step="0.1" inputmode="decimal" data-model="health.temperature" value="${escapeHtml(state.health.temperature)}" placeholder="例：36.5"><span>℃</span></div>
    <label class="field-label">気になる症状 <span>複数選択できます</span></label><p class="scale-note">選択後に強さを記録します。1＝軽い、5＝最も強い</p>
    <div class="choice-chip-row symptoms">${symptoms.map((template) => renderChoiceChip(template, "symptom")).join("")}${state.health.symptoms.filter((symptom) => !symptoms.some((template) => choiceKey(template.name) === choiceKey(symptom.name))).map((symptom) => `<div class="choice-chip selected coral-choice"><button type="button" data-action="toggle-symptom" data-name="${escapeHtml(symptom.name)}">✓ ${escapeHtml(symptom.name)}</button></div>`).join("")}</div>
    <div class="quick-add"><input data-model="customSymptom" value="${escapeHtml(state.customSymptom)}" placeholder="ほかの症状を入力"><button type="button" data-action="add-symptom-template">追加</button></div>
    <p class="template-help">追加した症状は次回以降も選べます。×で選択肢を消しても、過去の体調記録は残ります。</p>
    ${state.health.symptoms.length ? `<div class="severity-area"><div class="severity-guide"><b>症状の強さ</b><span>1＝軽い　→　5＝最も強い</span></div><div class="severity-list">${state.health.symptoms.map((symptom) => `<div><strong>${escapeHtml(symptom.name)}</strong><span>強さ</span><div>${[1,2,3,4,5].map((level) => `<button type="button" class="${symptom.severity === level ? "active" : ""}" data-action="set-severity" data-name="${escapeHtml(symptom.name)}" data-level="${level}">${level}</button>`).join("")}</div></div>`).join("")}</div></div>` : ""}
    <label class="field-label">便の状態 <span>任意・ブリストルスケール</span></label><select data-model="health.stoolType"><option value="">記録しない</option>${["タイプ1：硬いコロコロ便","タイプ2：硬めの便","タイプ3：やや硬め","タイプ4：普通便","タイプ5：やや柔らかい","タイプ6：泥状便","タイプ7：水様便"].map((value) => `<option ${state.health.stoolType === value ? "selected" : ""}>${value}</option>`).join("")}</select>
    <label class="field-label">体調メモ <span>気づいたことを自由に</span></label><textarea data-model="health.notes" placeholder="例：夕方からお腹が張る。睡眠は6時間、ストレスは少なめ。">${escapeHtml(state.health.notes)}</textarea>
    <button class="primary-button coral-button" type="submit">${state.health.id ? "変更を保存する" : "この体調を記録する"}<span>→</span></button>${state.health.id ? `<button class="cancel-edit-button" type="button" data-action="cancel-edit" data-kind="health">編集をやめる</button>` : ""}
  </section></form>`;
}

function renderChoiceChip(template, kind) {
  const selected = kind === "symptom" ? state.health.symptoms.some((item) => choiceKey(item.name) === choiceKey(template.name)) : state.habit.items.some((name) => choiceKey(name) === choiceKey(template.name));
  return `<div class="choice-chip ${selected ? `selected ${kind === "symptom" ? "coral-choice" : "blue-choice"}` : ""}"><button type="button" data-action="${kind === "symptom" ? "toggle-symptom" : "toggle-habit"}" data-name="${escapeHtml(template.name)}">${selected ? "✓ " : ""}${escapeHtml(template.name)}</button><button type="button" data-action="delete-template" data-store="choiceTemplates" data-id="${escapeHtml(template.id)}">×</button></div>`;
}

function renderHabit() {
  const habits = state.choices.filter((item) => item.category === "習慣").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return `<form class="single-column" data-form="habit"><section class="card">
    <div class="section-heading"><div><p class="step blue">${state.habit.id ? "EDITING ROUTINE LOG" : "MEDICATION & ROUTINE"}</p><h2>${state.habit.id ? "服薬・習慣の記録を変更" : "服薬・サプリ・習慣"}</h2></div><div class="hour-fields"><input type="date" data-model="habit.date" value="${state.habit.date}"><select data-model="habit.hour">${hourOptions.map((hour) => `<option ${state.habit.hour === hour ? "selected" : ""} value="${hour}">${hour}時</option>`).join("")}</select></div></div>
    <p class="time-help">時刻は食事と同じ丸め方で自動設定。忘れていた記録は日付と時刻を変更して追加できます。</p>
    <label class="field-label">行ったこと <span>複数選択できます</span></label>
    ${habits.length || state.habit.items.length ? `<div class="choice-chip-row habit-choices">${habits.map((template) => renderChoiceChip(template, "habit")).join("")}${state.habit.items.filter((name) => !habits.some((template) => choiceKey(template.name) === choiceKey(name))).map((name) => `<div class="choice-chip selected blue-choice"><button type="button" data-action="toggle-habit" data-name="${escapeHtml(name)}">✓ ${escapeHtml(name)}</button></div>`).join("")}</div>` : `<p class="empty-mini">下の欄から、薬・サプリメント・歯磨きなどの項目を作ってください。</p>`}
    <label class="field-label">選べる項目を作る <span>端末でいつでも追加・削除できます</span></label><div class="quick-add"><input data-model="newHabit" value="${escapeHtml(state.newHabit)}" placeholder="例：処方薬、隔日のサプリ、夜の歯磨き"><button type="button" data-action="add-habit-template">追加</button></div>
    <p class="template-help">選択肢を×で削除しても、その項目を使って保存した過去の記録は消えません。</p>
    <label class="field-label">メモ <span>任意</span></label><textarea data-model="habit.notes" placeholder="例：食後に服用。サプリは今日は飲んだ。">${escapeHtml(state.habit.notes)}</textarea>
    <button class="primary-button blue-button" type="submit">${state.habit.id ? "変更を保存する" : "この記録を保存する"}<span>→</span></button>${state.habit.id ? `<button class="cancel-edit-button" type="button" data-action="cancel-edit" data-kind="habit">編集をやめる</button>` : ""}
  </section></form>`;
}

function renderHistory() {
  const cumulative = cumulativeProteinMap();
  return `<div class="history-layout">
    <aside class="history-sidebar">
      <section class="card export-card"><div><p class="step">AI ANALYSIS</p><h2>まとめて出力</h2><p>食事と体調を同じ時系列でコピーします。別のAIに貼り付けて、数日後まで含めた関連を分析できます。</p></div><label>出力期間<select data-model="exportDays">${[["7","直近7日"],["14","直近14日"],["30","直近30日"],["50","直近50日"],["all","全期間"]].map(([value,label]) => `<option value="${value}" ${state.exportDays === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="primary-button" type="button" data-action="export-text">クリップボードへコピー<span>↗</span></button></section>
      <section class="card backup-card"><p class="step blue">DATA TRANSFER</p><h2>データ移行・バックアップ</h2><p>Sites版の全データJSONを検査し、件数確認と2段階確認後に読み込みます。現在データがある場合は置換前に自動バックアップします。</p><button class="primary-button blue-button" type="button" data-action="select-json">Sites版のJSONを読み込む<span>↓</span></button><button class="subtle-button full" type="button" data-action="export-json">全データをJSONで保存</button></section>
      <section class="card info-card"><p class="step">APP INFO</p><h2>アプリ情報</h2><dl><div><dt>バージョン</dt><dd>v${APP_VERSION}</dd></div><div><dt>保存状態</dt><dd>${escapeHtml(state.saveStatus)}</dd></div><div><dt>永続ストレージ</dt><dd>${escapeHtml(state.persistStatus)}</dd></div></dl>${state.persistStatus !== "有効" ? `<button class="subtle-button full" type="button" data-action="request-persist">永続保存を申請</button>` : ""}<div class="url-copy"><span>公開URL</span><code>https://yuuuh26.github.io/food-health-log/</code><button type="button" data-action="copy-url" data-url="https://yuuuh26.github.io/food-health-log/">コピー</button></div><div class="url-copy"><span>GitHub</span><code>https://github.com/yuuuh26/food-health-log</code><button type="button" data-action="copy-url" data-url="https://github.com/yuuuh26/food-health-log">コピー</button></div></section>
    </aside>
    <section class="timeline-section"><div class="history-heading"><div><p class="step">TIMELINE</p><h2>食事と体調の履歴</h2></div><span>${state.records.length}件</span></div>${state.records.length ? `<div class="timeline">${state.records.map((record) => renderRecord(record, cumulative)).join("")}</div>` : `<div class="empty-state"><b>まだ記録がありません</b><span>Sites版のJSONを読み込むか、新しい記録を追加してください。</span></div>`}</section>
  </div>`;
}

function renderRecord(record, cumulative) {
  const kindLabel = record.kind === "meal" ? "食事" : record.kind === "health" ? "体調" : "服薬・習慣";
  let body = "";
  if (record.kind === "meal") body = `<h3>食べたもの</h3>${record.items?.length ? `<p>${record.items.map((item) => `${escapeHtml(item.name)} ${escapeHtml(itemAmountLabel(item))}`).join("・")}</p>` : ""}<div class="record-meta"><b>今回 P ${record.protein}g</b><b class="protein-cumulative">当日累計 P ${cumulative.get(record.id) ?? record.protein}g</b></div>`;
  if (record.kind === "health") body = `<h3>${record.overallScore ? `全体的な体調：${overallLabel(record.overallScore)}` : "体調メモ"}</h3>${record.temperature != null ? `<div class="record-meta"><b>体温 ${record.temperature}℃</b></div>` : ""}${record.symptoms?.length ? `<p>${record.symptoms.map((item) => `${escapeHtml(item.name)} 強さ${item.severity}/5`).join("・")}（5が最も強い）</p>` : ""}${record.stoolType ? `<div class="record-meta"><span>${escapeHtml(record.stoolType)}</span></div>` : ""}`;
  if (record.kind === "habit") body = `<h3>${record.items?.length ? "記録した項目" : "服薬・習慣メモ"}</h3>${record.items?.length ? `<p>${record.items.map((item) => escapeHtml(item.name)).join("・")}</p>` : ""}`;
  return `<article class="record ${record.kind}"><div class="record-dot" aria-hidden="true"></div><div class="record-card"><div class="record-top"><span class="record-kind">${kindLabel}</span><time>${escapeHtml(displayDate(record.occurredAt))}</time><div class="record-actions"><button class="edit-record-button" type="button" data-action="edit-record" data-id="${record.id}">編集</button><button type="button" data-action="delete-record" data-id="${record.id}" aria-label="この記録を削除">×</button></div></div>${body}${record.notes ? `<blockquote>${escapeHtml(record.notes)}</blockquote>` : ""}</div></article>`;
}

function renderFooter() {
  return `<footer><div>全期間の記録をこの端末のIndexedDBに保存します。${!state.standalone && deferredInstallPrompt ? `<button type="button" data-action="install">アイコン付きでアプリとして追加</button>` : ""}</div><span>${escapeHtml(state.saveStatus)} · v${APP_VERSION} · Made by YUU</span></footer>`;
}

function renderImportModal() {
  const candidate = state.importCandidate;
  if (!candidate) { modalRoot.innerHTML = ""; return; }
  const errorList = candidate.errors?.length ? `<div class="message error"><b>読み込めません</b><ul>${candidate.errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : "";
  const warningList = candidate.warnings?.length ? `<div class="message warning"><b>確認事項</b><ul>${candidate.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : "";
  const counts = candidate.counts;
  const countTable = counts ? `<dl class="import-counts">${[["食材テンプレート",counts.foodTemplates],["症状テンプレート",counts.symptomTemplates],["服薬・習慣テンプレート",counts.medicationHabitTemplates],["食事履歴",counts.mealHistory],["体調履歴",counts.healthHistory],["服薬・習慣履歴",counts.medicationHabitHistory],["履歴合計",counts.totalHistory]].map(([label,value]) => `<div><dt>${label}</dt><dd>${value}件</dd></div>`).join("")}</dl>` : "";
  const stageCopy = state.importStage === 2 ? `<div class="danger-confirm"><b>最終確認</b><p>現在の端末データをJSONの内容に置き換えます。現在データがある場合は、直前バックアップを先に保存します。</p></div>` : "";
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><button class="modal-close" type="button" data-action="close-import" aria-label="閉じる">×</button><p class="step blue">JSON IMPORT</p><h2 id="import-title">${state.importStage === 2 ? "現在データを置き換えます" : "読み込む内容を確認"}</h2>${candidate.exportedAt ? `<p class="import-date">エクスポート日時：${escapeHtml(new Date(candidate.exportedAt).toLocaleString("ja-JP"))}</p>` : ""}${errorList}${warningList}${countTable}${stageCopy}<div class="modal-actions"><button type="button" class="subtle-button" data-action="close-import">キャンセル</button>${candidate.ok ? state.importStage === 2 ? `<button type="button" class="danger-button" data-action="execute-import" ${state.importBusy ? "disabled" : ""}>${state.importBusy ? "読み込み中…" : "自動バックアップして置き換える"}</button>` : `<button type="button" class="primary-button blue-button" data-action="continue-import">内容を確認して続ける<span>→</span></button>` : ""}</div></section></div>`;
}

app.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.model) setModel(target.dataset.model, target.value);
  if (target.dataset.itemKey) updateMealItem(target.dataset.itemKey, target.dataset.itemField, target.value, false);
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.model) { setModel(target.dataset.model, target.value); render(); }
  if (target.dataset.itemKey) { updateMealItem(target.dataset.itemKey, target.dataset.itemField, target.value, true); render(); }
});

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target.dataset.form;
  if (form === "meal") void saveMeal();
  if (form === "health") void saveHealth();
  if (form === "habit") void saveHabit();
});

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "tab") { state.activeTab = button.dataset.tab; render(); }
  if (action === "toggle-template") { state.templateOpen = !state.templateOpen; render(); }
  if (action === "toggle-custom-food") { state.customFoodOpen = !state.customFoodOpen; render(); }
  if (action === "set-food-category") { state.newFood.category = button.dataset.category; state.newFood.defaultAmount = button.dataset.category === "肉・魚" ? "100" : "1"; render(); }
  if (action === "save-food-template") void saveFoodTemplate();
  if (action === "toggle-food") toggleFood(button.dataset.id);
  if (action === "delete-template") void deleteTemplate(button.dataset.store, button.dataset.id);
  if (action === "add-custom-food") addCustomFood();
  if (action === "remove-meal-item") { state.meal.items = state.meal.items.filter((item) => item.key !== button.dataset.key); render(); }
  if (action === "set-vegetable-level") { const item = state.meal.items.find((entry) => entry.key === button.dataset.key); if (item) item.unit = button.dataset.level; render(); }
  if (action === "set-item-amount") { updateMealItem(button.dataset.key, "amount", button.dataset.amount, true); render(); }
  if (action === "set-overall") { state.health.overallScore = Number(button.dataset.score); render(); }
  if (action === "toggle-symptom") toggleSymptom(button.dataset.name);
  if (action === "set-severity") { const symptom = state.health.symptoms.find((item) => choiceKey(item.name) === choiceKey(button.dataset.name)); if (symptom) symptom.severity = Number(button.dataset.level); render(); }
  if (action === "add-symptom-template") void addChoiceTemplate("症状", state.customSymptom);
  if (action === "toggle-habit") toggleHabit(button.dataset.name);
  if (action === "add-habit-template") void addChoiceTemplate("習慣", state.newHabit);
  if (action === "cancel-edit") cancelEdit(button.dataset.kind);
  if (action === "edit-record") editRecord(button.dataset.id);
  if (action === "delete-record") void deleteRecord(button.dataset.id);
  if (action === "export-text") void exportText();
  if (action === "select-json") fileInput.click();
  if (action === "export-json") void exportJson();
  if (action === "copy-url") void navigator.clipboard.writeText(button.dataset.url).then(() => showToast("コピーしました"), () => showToast("コピーできませんでした"));
  if (action === "request-persist") void requestPersistentStorage();
  if (action === "install") void installApp();
});

modalRoot.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "close-import") { state.importCandidate = null; state.importStage = 0; renderImportModal(); }
  if (button.dataset.action === "continue-import") { state.importStage = 2; renderImportModal(); }
  if (button.dataset.action === "execute-import") void executeImport();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  state.importCandidate = await readAndValidateFile(file);
  state.importStage = 1;
  fileInput.value = "";
  renderImportModal();
});

function setModel(path, value) {
  const parts = path.split(".");
  let target = state;
  while (parts.length > 1) target = target[parts.shift()];
  target[parts[0]] = value;
}

function updateMealItem(key, field, rawValue, commit) {
  const item = state.meal.items.find((entry) => entry.key === key);
  if (!item) return;
  const value = Math.max(0, Number(rawValue));
  if (!Number.isFinite(value)) return;
  if (field === "amount") {
    item.amount = value;
    item.protein = item.baseAmount > 0 ? round(value / item.baseAmount * item.baseProtein) : item.protein;
  } else {
    item.protein = round(value);
    if (commit) { item.baseAmount = item.amount || 1; item.baseProtein = item.protein; }
  }
}

function toggleFood(id) {
  const food = state.foods.find((item) => item.id === id);
  if (!food) return;
  const existing = state.meal.items.find((item) => item.templateId === id);
  if (existing) state.meal.items = state.meal.items.filter((item) => item.templateId !== id);
  else {
    const category = normalizedCategory(food.category);
    state.meal.items.push({
      key: newId("item"), templateId: food.id, name: food.name, category,
      amount: category === "肉・魚" ? Number(food.defaultAmount) : 1,
      unit: category === "野菜" ? "中" : category === "肉・魚" ? "g" : "個",
      protein: category === "野菜" ? 0 : Number(food.protein || 0),
      baseAmount: category === "肉・魚" ? Number(food.defaultAmount) : 1,
      baseProtein: category === "野菜" ? 0 : Number(food.protein || 0),
    });
  }
  render();
}

function addCustomFood() {
  const name = normalizeText(state.customFood);
  if (!name) return showToast("食材名を入力してね");
  state.meal.items.push({ key: newId("item"), name, category: "その他", amount: 1, unit: "個", protein: 0, baseAmount: 1, baseProtein: 0 });
  state.customFood = "";
  state.customFoodOpen = false;
  render();
}

async function saveFoodTemplate() {
  const name = normalizeText(state.newFood.name);
  if (!name) return showToast("食材名を入力してね");
  if (state.foods.some((food) => food.category === state.newFood.category && choiceKey(food.name) === choiceKey(name))) return showToast("その食材はすでにあります");
  const category = state.newFood.category;
  const template = {
    id: newId("food"), name, category,
    defaultAmount: category === "肉・魚" ? Math.max(0, Number(state.newFood.defaultAmount) || 100) : 1,
    unit: category === "野菜" ? "中" : category === "肉・魚" ? "g" : "個",
    protein: category === "野菜" ? 0 : Math.max(0, Number(state.newFood.protein) || 0),
    createdAt: new Date().toISOString(),
  };
  if (await saveToStore("foodTemplates", template, "よく使う食材を端末に保存しました")) {
    state.foods.push(template);
    state.newFood = { name: "", category: "野菜", defaultAmount: "100", protein: "" };
    render();
  }
}

async function addChoiceTemplate(category, rawName) {
  const name = normalizeText(rawName);
  if (!name) return showToast("項目名を入力してね");
  if (state.choices.some((item) => item.category === category && choiceKey(item.name) === choiceKey(name))) return showToast("その項目はすでにあります");
  const template = { id: newId(category === "症状" ? "symptom" : "habit"), name, category, defaultAmount: 1, unit: "回", protein: 0, createdAt: new Date().toISOString() };
  if (await saveToStore("choiceTemplates", template, "選べる項目に追加しました")) {
    state.choices.push(template);
    if (category === "症状") {
      state.health.symptoms.push({ name, severity: 2 });
      state.customSymptom = "";
    } else {
      state.newHabit = "";
    }
    render();
  }
}

async function deleteTemplate(store, id) {
  const source = store === "foodTemplates" ? state.foods : state.choices;
  const template = source.find((item) => item.id === id);
  if (!template) return;
  if (!confirm(`「${template.name}」を選択肢から削除しますか？\nこれまでの記録は残ります。`)) return;
  try {
    await deleteOne(store, id);
    if (store === "foodTemplates") state.foods = state.foods.filter((item) => item.id !== id);
    else state.choices = state.choices.filter((item) => item.id !== id);
    state.saveStatus = "端末に保存済み";
    showToast("選択肢から削除しました。過去の記録はそのまま残ります");
    render();
  } catch { showToast("削除できませんでした。現在のデータは変更されていません"); }
}

function toggleSymptom(name) {
  const existing = state.health.symptoms.find((item) => choiceKey(item.name) === choiceKey(name));
  state.health.symptoms = existing ? state.health.symptoms.filter((item) => choiceKey(item.name) !== choiceKey(name)) : [...state.health.symptoms, { name, severity: 2 }];
  render();
}

function toggleHabit(name) {
  const exists = state.habit.items.some((item) => choiceKey(item) === choiceKey(name));
  state.habit.items = exists ? state.habit.items.filter((item) => choiceKey(item) !== choiceKey(name)) : [...state.habit.items, name];
  render();
}

async function saveMeal() {
  if (!state.meal.items.length && !normalizeText(state.meal.notes)) return showToast("食材またはメモを入力してね");
  const record = {
    id: state.meal.id || newId("record"), kind: "meal", occurredAt: isoFromHour(state.meal.date, state.meal.hour), mealType: "", title: "",
    items: state.meal.items.map(({ templateId, ...item }) => item), protein: round(state.meal.items.reduce((sum, item) => sum + Number(item.protein || 0), 0)),
    overallScore: null, temperature: null, symptoms: [], stoolType: "", notes: state.meal.notes,
    createdAt: state.meal.id ? state.records.find((item) => item.id === state.meal.id)?.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const editing = Boolean(state.meal.id);
  if (await saveToStore("records", record, editing ? "食事記録の変更を端末に保存しました" : "食べたものを端末に保存しました")) {
    await reloadData(); state.meal = freshMealDraft(); render();
  }
}

async function saveHealth() {
  if (!state.health.occurredAt || !Number.isFinite(new Date(state.health.occurredAt).getTime())) return showToast("日時を入力してね");
  const temperature = state.health.temperature === "" ? null : round(Number(state.health.temperature));
  if (temperature != null && (!Number.isFinite(temperature) || temperature < 30 || temperature > 45)) return showToast("体温は30.0〜45.0℃で入力してね");
  if (state.health.overallScore == null && temperature == null && !state.health.symptoms.length && !state.health.stoolType && !normalizeText(state.health.notes)) return showToast("体温・体調・症状・メモのどれかを入力してね");
  const record = {
    id: state.health.id || newId("record"), kind: "health", occurredAt: new Date(state.health.occurredAt).toISOString(), mealType: "", title: "", items: [], protein: 0,
    overallScore: state.health.overallScore, temperature, symptoms: state.health.symptoms, stoolType: state.health.stoolType, notes: state.health.notes,
    createdAt: state.health.id ? state.records.find((item) => item.id === state.health.id)?.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const editing = Boolean(state.health.id);
  if (await saveToStore("records", record, editing ? "体調記録の変更を端末に保存しました" : "体調を端末に保存しました")) {
    await reloadData(); state.health = freshHealthDraft(); render();
  }
}

async function saveHabit() {
  if (!state.habit.date || !Number.isFinite(new Date(`${state.habit.date}T${state.habit.hour}:00:00`).getTime())) return showToast("日付と時刻を入力してね");
  if (!state.habit.items.length && !normalizeText(state.habit.notes)) return showToast("服薬・サプリ・習慣の項目かメモを入力してね");
  const record = {
    id: state.habit.id || newId("record"), kind: "habit", occurredAt: isoFromHour(state.habit.date, state.habit.hour), mealType: "", title: "",
    items: state.habit.items.map((name) => ({ key: newId("item"), name, category: "習慣", amount: 1, unit: "回", protein: 0, baseAmount: 1, baseProtein: 0 })),
    protein: 0, overallScore: null, temperature: null, symptoms: [], stoolType: "", notes: state.habit.notes,
    createdAt: state.habit.id ? state.records.find((item) => item.id === state.habit.id)?.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const editing = Boolean(state.habit.id);
  if (await saveToStore("records", record, editing ? "服薬・習慣の変更を端末に保存しました" : "服薬・習慣を端末に保存しました")) {
    await reloadData(); state.habit = freshHabitDraft(); render();
  }
}

function editRecord(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  const date = new Date(record.occurredAt);
  if (record.kind === "meal") {
    state.meal = { id, date: localDate(date), hour: String(date.getHours()).padStart(2, "0"), notes: record.notes || "", items: record.items.map((item) => ({ ...item, key: item.key || newId("item") })) };
    state.activeTab = "meal";
  }
  if (record.kind === "health") {
    state.health = { id, occurredAt: localDateTime(date), overallScore: record.overallScore, temperature: record.temperature == null ? "" : String(record.temperature), symptoms: (record.symptoms || []).map((item) => ({ ...item })), stoolType: record.stoolType || "", notes: record.notes || "" };
    state.activeTab = "health";
  }
  if (record.kind === "habit") {
    state.habit = { id, date: localDate(date), hour: String(date.getHours()).padStart(2, "0"), items: (record.items || []).map((item) => item.name), notes: record.notes || "" };
    state.activeTab = "habit";
  }
  render(); window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelEdit(kind) {
  if (kind === "meal") state.meal = freshMealDraft();
  if (kind === "health") state.health = freshHealthDraft();
  if (kind === "habit") state.habit = freshHabitDraft();
  render();
}

async function deleteRecord(id) {
  if (!confirm("この記録を削除しますか？")) return;
  try { await deleteOne("records", id); await reloadData(); state.saveStatus = "端末に保存済み"; showToast("記録を削除しました"); render(); }
  catch { showToast("記録を削除できませんでした"); }
}

async function exportJson() {
  try { const counts = await exportAllData(); await putOne("settings", { key: "lastBackupAt", value: new Date().toISOString() }); showToast(`全データJSONを保存しました（履歴${counts.totalHistory}件）`); }
  catch (error) { console.error(error); showToast("JSONファイルを保存できませんでした"); }
}

async function executeImport() {
  if (!state.importCandidate?.ok || state.importBusy) return;
  state.importBusy = true; renderImportModal();
  try {
    const hasCurrentData = state.foods.length + state.choices.length + state.records.length > 0;
    await backupThenReplace(state.importCandidate, hasCurrentData);
    const counts = state.importCandidate.counts;
    await reloadData();
    state.importCandidate = null; state.importStage = 0; state.importBusy = false;
    state.meal = freshMealDraft(); state.health = freshHealthDraft(); state.habit = freshHabitDraft(); state.saveStatus = "端末に保存済み";
    render(); showToast(`全データを読み込みました。履歴${counts.totalHistory}件`);
  } catch (error) {
    console.error(error); state.importBusy = false; renderImportModal();
    showToast("インポートできませんでした。現在の端末データは変更されていません");
  }
}

async function exportText() {
  const threshold = state.exportDays === "all" ? 0 : Date.now() - Number(state.exportDays) * 86400000;
  const records = state.records.filter((record) => new Date(record.occurredAt).getTime() >= threshold).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  const cumulative = cumulativeProteinMap(records);
  const lines = ["# 食事・体調ログ（AI分析用）", `出力日時: ${new Date().toLocaleString("ja-JP")}`, `対象期間: ${state.exportDays === "all" ? "全期間" : `直近${state.exportDays}日`}`, "※食事と体調は発生日時順。数日遅れの影響も含めて関連を検討してください。", "※症状の強さは1=軽い、5=最も強いです。", ""];
  for (const record of records) {
    lines.push(`## ${displayDate(record.occurredAt)}｜${record.kind === "meal" ? "食事" : record.kind === "health" ? "体調" : "服薬・習慣"}`);
    if (record.kind === "meal") {
      if (record.items?.length) { lines.push("食材:"); record.items.forEach((item) => lines.push(`- ${item.name}: ${itemAmountLabel(item)} / たんぱく質 ${item.protein}g`)); }
      lines.push(`たんぱく質（今回）: ${record.protein}g`, `この時点の当日累計: ${cumulative.get(record.id) ?? record.protein}g`);
    }
    if (record.kind === "health") {
      lines.push(`全体的な体調: ${overallLabel(record.overallScore)}`);
      if (record.temperature != null) lines.push(`体温: ${record.temperature}℃`);
      if (record.symptoms?.length) lines.push(`症状の強さ: ${record.symptoms.map((item) => `${item.name}（${item.severity}/5）`).join("、")}`);
      if (record.stoolType) lines.push(`便の状態: ${record.stoolType}`);
    }
    if (record.kind === "habit" && record.items?.length) lines.push(`記録項目: ${record.items.map((item) => item.name).join("、")}`);
    if (record.notes) lines.push(`メモ: ${record.notes}`);
    lines.push("");
  }
  try { await navigator.clipboard.writeText(lines.join("\n")); showToast(`${records.length}件をクリップボードにコピーしました`); }
  catch { showToast("コピーできませんでした。ブラウザの権限を確認してください"); }
}

async function updatePersistStatus() {
  if (!navigator.storage?.persisted) state.persistStatus = "この環境では確認できません";
  else state.persistStatus = await navigator.storage.persisted() ? "有効" : "未許可";
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return showToast("この環境では永続ストレージを申請できません");
  const granted = await navigator.storage.persist();
  state.persistStatus = granted ? "有効" : "未許可";
  render(); showToast(granted ? "永続ストレージが有効になりました" : "永続ストレージは許可されませんでした");
}

async function installApp() {
  if (!deferredInstallPrompt) return showToast("Chromeのメニューから『アプリをインストール』を選んでね");
  await deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  render();
}

window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; render(); });
window.matchMedia("(display-mode: standalone)").addEventListener("change", (event) => { state.standalone = event.matches; render(); });

async function initialize() {
  try {
    await initializeFreshDatabase();
    await reloadData();
    await updatePersistStatus();
    state.saveStatus = "端末から表示中";
    render();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(console.error);
  } catch (error) {
    console.error(error);
    app.innerHTML = `<main class="fatal-error"><h1>食事・体調ログ</h1><p>端末の保存機能を準備できませんでした。</p><p>Chromeの設定と空き容量を確認して、再読み込みしてください。</p></main>`;
  }
}

void initialize();
