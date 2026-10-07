import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  get, onValue, push, ref, remove, serverTimestamp, update
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { auth, db } from "./firebase.js";

// <pure> — no DOM, no Firebase: everything between these markers can be unit-tested in Node.
const HISTORY_FIELD = "Historique / Ancien(s) utilisateur(s)";
const ALERT_FIELD = "Alerte à vérifier";
const USER_FIELD = "Utilisateur actuel (dernier affecté)";
const SERIAL_FIELD = "N° Série (identifiant unique)";
const SUGGEST_FIELDS = ["État", "Service", "Type", "Marque"];
const STATUS_CURRENT = "Actuel (dernier utilisateur)";
const STATUS_PAST = "Ancien (réaffecté)";
const IGNORED_SERIALS = new Set(["pas s/n", "n/a", "na", "-", "inconnu"]);
const COMPANY_LINE = "SARL SINAL — Division Optique";

const COMPUTER_COLUMNS = [
  ["N° PC", 105], ["Désignation", 180], ["Type", 150], ["Marque", 160],
  [SERIAL_FIELD, 205], ["État", 105], ["Service", 135],
  [USER_FIELD, 220], ["Remarque", 205], [HISTORY_FIELD, 260], [ALERT_FIELD, 315]
];

const DEFINITIONS = [
  {
    name: "Unités Centrales", aliases: ["Unites Centrales"],
    collection: "unites_centrales", kind: "computer", icon: "computer", columns: COMPUTER_COLUMNS
  },
  {
    name: "Laptops", aliases: [],
    collection: "laptops", kind: "computer", icon: "laptop_mac", columns: COMPUTER_COLUMNS
  },
  {
    name: "Imprimantes", aliases: [],
    collection: "imprimantes", kind: "printer", icon: "print",
    columns: [
      ["N° Equipement", 125], ["Type", 140], ["Marque", 130], [SERIAL_FIELD, 220],
      ["État", 110], ["Service", 145], ["Remarque", 225], [HISTORY_FIELD, 285],
      [ALERT_FIELD, 315]
    ]
  },
  {
    name: "Historique", aliases: [],
    collection: "historique", kind: "history", icon: "history",
    columns: [
      ["N° Série", 210], ["N° PC", 105], ["Type", 135], ["Marque", 130],
      ["Service", 145], ["Utilisateur", 190], ["Statut", 205], ["Remarque", 200]
    ]
  }
];

const text = value => String(value ?? "").trim();
const norm = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ").toLowerCase();
const fieldId = field => field.replace(/[^a-z0-9]/gi, "-");
const dateText = (date = new Date()) => new Intl.DateTimeFormat("fr-FR").format(date);

function trimRecord(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [
    key, typeof value === "string" ? value.trim() : value
  ]));
}

function encodeRecord(record) {
  return Object.fromEntries(Object.entries(record).map(([field, value]) => [
    encodeURIComponent(field), value
  ]));
}

function decodeRecord(record) {
  return Object.fromEntries(Object.entries(record || {}).map(([field, value]) => [
    decodeURIComponent(field), value
  ]));
}

function serialField(sheet) {
  return sheet.kind === "history" ? "N° Série" : SERIAL_FIELD;
}

function pcField(sheet) {
  return sheet.kind === "printer" ? "N° Equipement" : "N° PC";
}

function titleFor(sheet) {
  return sheet.kind === "history"
    ? "Traçabilité — Matériel réaffecté (doublons détectés par N° Série)"
    : `Inventaire — ${sheet.name}`;
}

// Who "holds" the item: the user for computers, the service for printers.
function holderField(sheet) {
  return sheet.kind === "computer" ? USER_FIELD : sheet.kind === "printer" ? "Service" : null;
}

function serialKey(record, sheet) {
  const serial = text(record[serialField(sheet)]);
  return !serial || IGNORED_SERIALS.has(serial.toLowerCase()) ? "" : serial.toUpperCase();
}

function buildSerialMap(recordsByCollection) {
  const map = new Map();
  for (const sheet of DEFINITIONS) {
    if (sheet.kind === "history") continue;
    for (const record of recordsByCollection[sheet.collection] || []) {
      const key = serialKey(record, sheet);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(record);
    }
  }
  return map;
}

function alertText(record, sheet, serialMap) {
  if (sheet.kind === "history") return "";
  const key = serialKey(record, sheet);
  const matches = key ? serialMap.get(key) || [] : [];
  if (matches.length < 2) return "";
  const alerts = ["⚠ N° Série en double — à vérifier"];
  const signatures = new Set(matches.map(item => `${norm(item.Type)}|${norm(item.Marque)}`));
  if (signatures.size > 1) {
    alerts.push("⚠ Catégorie/Marque différentes entre les enregistrements de ce N° Série — à vérifier");
  }
  return alerts.join(" | ");
}

// "Ahmed → Yassin → (actuel) Khaled"  +  Khaled → Lakhdar  =>  "Ahmed → Yassin → Khaled → (actuel) Lakhdar"
function updatedChain(previousChain, oldValue, newValue) {
  const parts = String(previousChain || "").split("→").map(part => part.trim()).filter(Boolean)
    .filter(part => !part.startsWith("(actuel)"));
  if (oldValue && parts[parts.length - 1] !== oldValue) parts.push(oldValue);
  if (newValue) parts.push(`(actuel) ${newValue}`);
  return parts.join(" → ");
}

// Empty values always go last; `direction` only applies to non-empty values.
function compareValues(a, b, direction = 1) {
  const x = text(a);
  const y = text(b);
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return x.localeCompare(y, "fr", { numeric: true, sensitivity: "base" }) * direction;
}

function defaultSortKeys(sheet) {
  return sheet.kind === "history" ? ["N° Série", "N° PC"] : [sheet.columns[0][0], serialField(sheet)];
}

function sortRecords(records, sheet, sort) {
  const keys = sort ? [sort.key] : defaultSortKeys(sheet);
  const direction = sort ? sort.direction : 1;
  return [...records].sort((a, b) => {
    for (const key of keys) {
      const result = compareValues(a[key], b[key], direction);
      if (result) return result;
    }
    return 0;
  });
}

// Sheet names in the real file differ slightly ("Unites Centrales", "Historique ").
function definitionForWorksheet(name) {
  return DEFINITIONS.find(sheet =>
    [sheet.name, ...sheet.aliases].some(alias => norm(alias) === norm(name))
  ) || null;
}

function parseWorksheet(worksheet, sheet, lib) {
  const grid = lib.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });
  const wanted = new Map(sheet.columns.map(([field]) => [norm(field), field]));
  let best = { score: 0, index: -1 };
  grid.slice(0, 15).forEach((row, index) => {
    const score = row.filter(cell => wanted.has(norm(cell))).length;
    if (score > best.score) best = { score, index };
  });
  if (best.score < 1) {
    const skippedRows = grid.filter(row => row.some(value => text(value))).length;
    return { records: [], skippedRows, error: "Ligne d’en-têtes introuvable." };
  }
  const headers = grid[best.index].map(cell => wanted.get(norm(cell)) || null);
  let skippedRows = 0;
  const records = [];
  grid.slice(best.index + 1).forEach(row => {
    if (!row.some(value => text(value))) {
      skippedRows += 1;
      return;
    }
    const record = {};
    sheet.columns.forEach(([field]) => { if (field !== ALERT_FIELD) record[field] = ""; });
    headers.forEach((field, index) => {
      if (field && field !== ALERT_FIELD) record[field] = text(row[index]);
    });
    records.push(record);
  });
  return { records, skippedRows, error: "" };
}

function importDocumentId(sheet, record) {
  return encodeURIComponent(text(record[importIdentifierField(sheet)])).replace(/\./g, "%2E");
}

function importIdentifierField(sheet) {
  return sheet.columns.find(([field]) => norm(field) === norm("N° Equipement"))?.[0]
    || serialField(sheet);
}

function buildWorkbook(lib, recordsByCollection, updated = new Date()) {
  const workbook = lib.utils.book_new();
  const serialMap = buildSerialMap(recordsByCollection);
  const thin = { style: "thin", color: { rgb: "BFC5CE" } };
  const borders = { top: thin, bottom: thin, left: thin, right: thin };
  for (const sheet of DEFINITIONS) {
    const headerIndex = sheet.kind === "history" ? 4 : 3; // same rows as the original Excel file
    const lastCol = sheet.columns.length - 1;
    const aoa = Array.from({ length: headerIndex }, () => []);
    aoa[0] = [titleFor(sheet)];
    aoa[1] = [`${COMPANY_LINE} | Mise à jour du document : ${dateText(updated)}`];
    aoa.push(sheet.columns.map(([field]) => field));
    sortRecords(recordsByCollection[sheet.collection] || [], sheet, null).forEach(record => {
      aoa.push(sheet.columns.map(([field]) =>
        field === ALERT_FIELD ? alertText(record, sheet, serialMap) : text(record[field])));
    });
    const worksheet = lib.utils.aoa_to_sheet(aoa);
    worksheet["!merges"] = [0, 1].map(r => ({ s: { r, c: 0 }, e: { r, c: lastCol } }));
    worksheet["!cols"] = sheet.columns.map(([, width]) => ({ wpx: width }));
    worksheet["!rows"] = [];
    worksheet["!rows"][headerIndex] = { hpt: 32 };
    const style = (r, c, s) => {
      const address = lib.utils.encode_cell({ r, c });
      if (!worksheet[address]) worksheet[address] = { t: "s", v: "" };
      worksheet[address].s = s;
    };
    style(0, 0, { font: { name: "Arial", sz: 14, bold: true, color: { rgb: "1F3864" } } });
    style(1, 0, { font: { name: "Arial", sz: 10, italic: true, color: { rgb: "595959" } } });
    sheet.columns.forEach((_, c) => style(headerIndex, c, {
      fill: { fgColor: { rgb: "1F3864" } },
      font: { name: "Arial", sz: 11, bold: true, color: { rgb: "FFFFFF" } },
      alignment: { vertical: "center", wrapText: true },
      border: borders
    }));
    for (let r = headerIndex + 1; r < aoa.length; r += 1) {
      sheet.columns.forEach(([field], c) => {
        const font = { name: "Arial", sz: 10 };
        if (field === ALERT_FIELD && aoa[r][c]) font.color = { rgb: "9C2C18" };
        style(r, c, { font, border: borders, alignment: { vertical: "top", wrapText: true } });
      });
    }
    lib.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }
  return workbook;
}
// </pure>

const state = {
  activeIndex: 0,
  records: Object.fromEntries(DEFINITIONS.map(sheet => [sheet.collection, []])),
  listeners: [],
  sort: null,
  renderQueued: false,
  renderDeferred: false,
  pointerDown: false
};

const appMessage = document.querySelector("#app-message");
const sheetArea = document.querySelector("#sheet-area");
const tabs = document.querySelector("#sheet-tabs");
const searchInput = document.querySelector("#search");
const stateFilter = document.querySelector("#state-filter");
const serviceFilter = document.querySelector("#service-filter");
const recordDialog = document.querySelector("#record-dialog");
const recordForm = document.querySelector("#record-form");
const formFields = document.querySelector("#form-fields");
const formError = document.querySelector("#form-error");

function activeSheet() {
  return DEFINITIONS[state.activeIndex];
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function notify(message, isError = false, duration = 6000) {
  appMessage.textContent = message;
  appMessage.style.color = isError ? "#9c2c18" : "#27623b";
  if (message) window.setTimeout(() => {
    if (appMessage.textContent === message) appMessage.textContent = "";
  }, duration);
}

function friendlyError(error) {
  if (error?.code === "permission-denied" || String(error?.code || "").startsWith("PERMISSION_DENIED")) {
    return "Accès refusé par Realtime Database. Vérifiez les règles de sécurité et la connexion.";
  }
  return error?.message || "Erreur inconnue.";
}

/* ---------- Auth ---------- */

onAuthStateChanged(auth, user => {
  if (!user) {
    stopListeners();
    window.location.replace("index.html");
    return;
  }
  document.querySelector("#app").hidden = false;
  render();
  startDataListeners();
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    stopListeners();
    await signOut(auth);
    window.location.replace("index.html");
  } catch (error) {
    notify(`Déconnexion impossible : ${friendlyError(error)}`, true);
  }
});

/* ---------- Realtime data ---------- */

function stopListeners() {
  state.listeners.forEach(unsubscribe => unsubscribe());
  state.listeners = [];
}

function startDataListeners() {
  stopListeners();
  for (const sheet of DEFINITIONS) {
    const unsubscribe = onValue(ref(db, sheet.collection), snapshot => {
      const values = snapshot.val() || {};
      state.records[sheet.collection] = Object.entries(values).map(([id, value]) => ({
        id, ...decodeRecord(value)
      }));
      scheduleRender();
    }, error => notify(`Lecture de « ${sheet.name} » impossible : ${friendlyError(error)}`, true));
    state.listeners.push(unsubscribe);
  }
}

async function refreshAllTables() {
  const snapshots = await Promise.all(
    DEFINITIONS.map(sheet => get(ref(db, sheet.collection)))
  );
  snapshots.forEach((snapshot, index) => {
    const sheet = DEFINITIONS[index];
    const values = snapshot.val() || {};
    state.records[sheet.collection] = Object.entries(values).map(([id, value]) => ({
      id, ...decodeRecord(value)
    }));
  });
  scheduleRender();
}

function documentDate() {
  let latest = 0;
  for (const list of Object.values(state.records)) {
    for (const record of list) {
      const time = Number(record.updatedAt) || 0;
      if (time > latest) latest = time;
    }
  }
  return latest ? new Date(latest) : new Date();
}

/* ---------- Rendering ---------- */

function isEditing() {
  return Boolean(sheetArea.querySelector('[data-editing="1"]'));
}

// Never re-render while a cell is being edited or the mouse is down (it would destroy the click).
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  window.requestAnimationFrame(() => {
    state.renderQueued = false;
    if (isEditing() || state.pointerDown) {
      state.renderDeferred = true;
      return;
    }
    render();
  });
}

function flushDeferredRender() {
  if (state.renderDeferred && !isEditing() && !state.pointerDown) {
    state.renderDeferred = false;
    scheduleRender();
  }
}

document.addEventListener("mousedown", () => { state.pointerDown = true; }, true);
document.addEventListener("mouseup", () => {
  state.pointerDown = false;
  window.setTimeout(flushDeferredRender, 0);
}, true);

function captureFocus() {
  const cell = document.activeElement?.closest?.("td[data-field]");
  return cell && sheetArea.contains(cell) ? { docId: cell.dataset.docId, field: cell.dataset.field } : null;
}

function restoreFocus(saved) {
  if (!saved) return;
  const cell = [...sheetArea.querySelectorAll("td[data-field]")]
    .find(item => item.dataset.docId === saved.docId && item.dataset.field === saved.field);
  cell?.focus({ preventScroll: true });
}

function renderTabs() {
  tabs.replaceChildren();
  DEFINITIONS.forEach((sheet, index) => {
    const button = el("button", `sheet-tab${index === state.activeIndex ? " active" : ""}`);
    const icon = el("span", "sheet-tab-icon", sheet.icon);
    icon.setAttribute("aria-hidden", "true");
    const label = el("span", "sheet-tab-label", sheet.name);
    button.append(icon, label);
    button.type = "button";
    button.addEventListener("click", () => {
      state.activeIndex = index;
      state.sort = null;
      stateFilter.value = "";
      serviceFilter.value = "";
      render();
    });
    tabs.append(button);
  });
}

function getVisibleRecords(sheet) {
  const query = searchInput.value.trim().toLocaleLowerCase("fr");
  const selectedState = stateFilter.value;
  const selectedService = serviceFilter.value;
  const filtered = state.records[sheet.collection].filter(record => {
    const matchesQuery = !query || sheet.columns
      .filter(([name]) => name !== ALERT_FIELD)
      .some(([name]) => text(record[name]).toLocaleLowerCase("fr").includes(query));
    const matchesState = !selectedState || record["État"] === selectedState;
    const matchesService = !selectedService || record.Service === selectedService;
    return matchesQuery && matchesState && matchesService;
  });
  return sortRecords(filtered, sheet, state.sort);
}

function refreshFilters(sheet) {
  for (const [select, field] of [[stateFilter, "État"], [serviceFilter, "Service"]]) {
    const previous = select.value;
    const values = [...new Set(state.records[sheet.collection].map(record => text(record[field])).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "fr"));
    select.replaceChildren(new Option("Tous", ""));
    values.forEach(value => select.add(new Option(value, value)));
    if (values.includes(previous)) select.value = previous;
    select.parentElement.hidden = !sheet.columns.some(([name]) => name === field);
  }
}

function suggestionValues(field) {
  const values = new Set();
  for (const definition of DEFINITIONS) {
    if (definition.kind === "history" || !definition.columns.some(([name]) => name === field)) continue;
    state.records[definition.collection].forEach(record => {
      if (text(record[field])) values.add(text(record[field]));
    });
  }
  return [...values].sort((a, b) => a.localeCompare(b, "fr"));
}

function buildDatalist(id, field) {
  const list = el("datalist");
  list.id = id;
  suggestionValues(field).forEach(value => {
    const option = el("option");
    option.value = value;
    list.append(option);
  });
  return list;
}

function appendDataCell(row, sheet, record, rowIndex, colIndex, serialMap) {
  const field = sheet.columns[colIndex][0];
  const isAlert = field === ALERT_FIELD;
  const value = isAlert ? alertText(record, sheet, serialMap) : text(record[field]);
  const cell = el("td", "", value);
  cell.dataset.field = field;
  cell.dataset.row = String(rowIndex);
  cell.dataset.col = String(colIndex);
  cell.dataset.docId = record.id || "";
  cell.dataset.collection = sheet.collection;
  cell.tabIndex = 0;
  if (rowIndex === 0) cell.classList.add("first-data-cell");
  if (isAlert && value) cell.classList.add("alert-cell");
  const isHistorySerial = sheet.kind === "history" && field === "N° Série";
  if (isHistorySerial) {
    let roadmapClickTimer;
    cell.classList.add("roadmap-trigger");
    cell.title = "Voir le parcours";
    cell.addEventListener("click", () => {
      window.clearTimeout(roadmapClickTimer);
      roadmapClickTimer = window.setTimeout(() => openRoadmap(record), 250);
    });
    cell.addEventListener("dblclick", () => {
      window.clearTimeout(roadmapClickTimer);
      beginEdit(cell);
    });
  } else if (!isAlert) {
    cell.addEventListener("click", () => beginEdit(cell));
  }
  cell.addEventListener("keydown", event => handleCellKeydown(event, cell));
  row.append(cell);
}

function roadmapSteps(serial) {
  const history = state.records.historique
    .filter(record => norm(record["N° Série"]) === norm(serial))
    .sort((a, b) => {
      const aTime = Number(a.updatedAt) || 0;
      const bTime = Number(b.updatedAt) || 0;
      if (aTime && bTime) return aTime - bTime;
      if (aTime) return -1;
      if (bTime) return 1;
      const statusOrder = record => norm(record.Statut) === norm(STATUS_PAST) ? 0
        : norm(record.Statut) === norm(STATUS_CURRENT) ? 1 : 0.5;
      return statusOrder(a) - statusOrder(b);
    });
  const equipmentRecords = DEFINITIONS
    .filter(sheet => sheet.kind !== "history")
    .flatMap(sheet => state.records[sheet.collection])
    .filter(record => norm(record[SERIAL_FIELD]) === norm(serial));
  const source = history.length ? history : equipmentRecords;
  const steps = [];
  if (history.length) {
    source.forEach(record => {
      const name = text(record.Utilisateur) || text(record.Service);
      if (!name) return;
      const time = Number(record.updatedAt);
      const step = {
        name,
        date: Number.isFinite(time) && time > 0 ? new Date(time) : null,
        remark: text(record.Remarque)
      };
      const previous = steps[steps.length - 1];
      if (previous && norm(previous.name) === norm(name)) {
        if (step.date) previous.date = step.date;
        if (step.remark) previous.remark = step.remark;
      } else {
        steps.push(step);
      }
    });
    return steps;
  }

  const equipment = source.find(record => text(record[HISTORY_FIELD]));
  if (!equipment) return steps;
  text(equipment[HISTORY_FIELD]).split("→").map(text).filter(Boolean).forEach(part => {
    const name = part.replace(/^\(actuel\)\s*/i, "").trim();
    if (!name) return;
    const previous = steps[steps.length - 1];
    if (!previous || norm(previous.name) !== norm(name)) {
      steps.push({
        name,
        date: Number(equipment.updatedAt) > 0 ? new Date(Number(equipment.updatedAt)) : null,
        remark: text(equipment.Remarque)
      });
    }
  });
  return steps;
}

function openRoadmap(record) {
  const serial = text(record["N° Série"]);
  if (!serial || IGNORED_SERIALS.has(norm(serial))) return;
  const equipmentSheet = DEFINITIONS.find(sheet => sheet.kind !== "history" &&
    state.records[sheet.collection].some(item =>
      norm(item[SERIAL_FIELD]) === norm(serial) && text(item[HISTORY_FIELD])
    ));
  const equipment = equipmentSheet && state.records[equipmentSheet.collection].find(item =>
    norm(item[SERIAL_FIELD]) === norm(serial) && text(item[HISTORY_FIELD])
  );
  const steps = roadmapSteps(serial);
  const dialog = el("dialog", "roadmap-dialog");
  const heading = el("div", "roadmap-heading");
  const title = el("h2", "", `Parcours — ${serial}`);
  const close = el("button", "roadmap-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Fermer");
  close.addEventListener("click", () => dialog.close());
  heading.append(title, close);

  const details = el("dl", "roadmap-details");
  const values = [
    ["N° Série", serial],
    ["N° PC", text(record["N° PC"]) || text(equipment && equipmentSheet ? equipment[pcField(equipmentSheet)] : "")],
    ["Type", text(record.Type) || text(equipment?.Type)],
    ["Marque", text(record.Marque) || text(equipment?.Marque)],
    ["Étapes", String(steps.length)]
  ];
  values.forEach(([label, value]) => {
    const group = el("div", "roadmap-detail");
    group.append(el("dt", "", label), el("dd", "", value || "—"));
    details.append(group);
  });

  const chain = el("ol", "roadmap-chain");
  steps.forEach((step, index) => {
    const isCurrent = index === steps.length - 1;
    const item = el("li", `roadmap-step${isCurrent ? " current" : ""}`);
    const name = el("strong", "roadmap-step-name", isCurrent ? `Now: ${step.name}` : step.name);
    const date = el("span", "roadmap-step-date", step.date ? dateText(step.date) : "Date inconnue");
    const remark = el("span", "roadmap-step-remark", step.remark || "Aucune remarque");
    item.append(name, date, remark);
    chain.append(item);
  });
  const content = el("div", "roadmap-content");
  content.append(details, chain);
  dialog.append(heading, content);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function render() {
  const sheet = activeSheet();
  const saved = captureFocus();
  const scroll = { top: sheetArea.scrollTop, left: sheetArea.scrollLeft };
  renderTabs();
  refreshFilters(sheet);
  const serialMap = buildSerialMap(state.records);
  const records = getVisibleRecords(sheet);
  const colSpan = sheet.columns.length + 2;

  const table = el("table", "grid");
  const colgroup = el("colgroup");
  const widths = [42, ...sheet.columns.map(([, width]) => width), 40];
  widths.forEach(width => {
    const col = el("col");
    col.style.width = `${width}px`;
    colgroup.append(col);
  });
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  table.append(colgroup);

  const thead = el("thead");
  const titleRow = el("tr", "title-row");
  const titleCell = el("td");
  titleCell.append(el("span", "sticky-text", titleFor(sheet)));
  titleCell.colSpan = colSpan;
  titleRow.append(titleCell);
  const subtitleRow = el("tr", "subtitle-row");
  const subtitleCell = el("td");
  subtitleCell.append(el("span", "sticky-text", `${COMPANY_LINE} | Mise à jour du document : ${dateText(documentDate())}`));
  subtitleCell.colSpan = colSpan;
  subtitleRow.append(subtitleCell);
  const headerRow = el("tr");
  headerRow.append(el("th", "row-number"));
  sheet.columns.forEach(([field]) => {
    const sorted = state.sort?.key === field ? state.sort.direction : 0;
    const header = el("th", "", field + (sorted ? (sorted === 1 ? " ▲" : " ▼") : ""));
    header.title = "Cliquer pour trier";
    header.addEventListener("click", () => {
      state.sort = { key: field, direction: sorted === 1 ? -1 : 1 };
      render();
    });
    headerRow.append(header);
  });
  headerRow.append(el("th", "delete-cell"));
  thead.append(titleRow, subtitleRow, headerRow);
  table.append(thead);

  const tbody = el("tbody");
  records.forEach((record, rowIndex) => {
    const row = el("tr");
    row.append(el("td", "row-number", String(rowIndex + 1)));
    sheet.columns.forEach((_, colIndex) => appendDataCell(row, sheet, record, rowIndex, colIndex, serialMap));
    const actions = el("td", "delete-cell");
    const remove = el("button", "delete-button", "×");
    remove.type = "button";
    remove.title = "Supprimer la ligne";
    remove.setAttribute("aria-label", `Supprimer la ligne ${rowIndex + 1}`);
    remove.addEventListener("click", () => deleteRecord(sheet, record));
    actions.append(remove);
    row.append(actions);
    tbody.append(row);
  });
  const blank = el("tr", "blank-row");
  blank.append(el("td", "row-number"));
  sheet.columns.forEach((_, index) => {
    const cell = index === 0 ? el("td", "first-data-cell", "+ Ajouter une ligne…") : el("td");
    if (index === 0) cell.addEventListener("click", openForm);
    blank.append(cell);
  });
  blank.append(el("td"));
  tbody.append(blank);
  table.append(tbody);

  const lists = el("div");
  lists.hidden = true;
  sheet.columns.filter(([field]) => SUGGEST_FIELDS.includes(field))
    .forEach(([field]) => lists.append(buildDatalist(`suggest-${fieldId(field)}`, field)));

  sheetArea.replaceChildren(table, lists);
  sheetArea.scrollTop = scroll.top;
  sheetArea.scrollLeft = scroll.left;
  restoreFocus(saved);
}

/* ---------- Cell editing (Excel-like) ---------- */

function beginEdit(cell) {
  const field = cell.dataset.field;
  if (cell.dataset.editing === "1" || field === ALERT_FIELD) return;
  cell.dataset.original = cell.textContent;
  cell.dataset.editing = "1";
  if (SUGGEST_FIELDS.includes(field)) {
    const input = el("input", "cell-editor");
    input.value = cell.textContent;
    input.setAttribute("list", `suggest-${fieldId(field)}`);
    input.setAttribute("aria-label", field);
    cell.replaceChildren(input);
    input.addEventListener("blur", () => finishEdit(cell, true), { once: true });
    input.focus();
    input.select();
    return;
  }
  cell.setAttribute("contenteditable", "true");
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  cell.addEventListener("blur", () => finishEdit(cell, true), { once: true });
}

function finishEdit(cell, save) {
  if (cell.dataset.editing !== "1") return;
  delete cell.dataset.editing;
  const input = cell.querySelector("input");
  const original = cell.dataset.original ?? "";
  const nextValue = text(input ? input.value : cell.textContent);
  cell.removeAttribute("contenteditable");
  cell.textContent = save ? nextValue : original;
  if (!save || nextValue === text(original)) {
    flushDeferredRender();
    return;
  }
  const sheet = DEFINITIONS.find(item => item.collection === cell.dataset.collection) || activeSheet();
  const record = state.records[sheet.collection].find(item => item.id === cell.dataset.docId);
  if (!record) {
    notify("La ligne n’existe plus. Elle a peut-être été supprimée par un autre utilisateur.", true);
    scheduleRender();
    return;
  }
  // The SDK queues writes while the tab remains open if the connection drops.
  saveRecord(sheet, record, { [cell.dataset.field]: nextValue }).catch(error => {
    notify(`Enregistrement impossible : ${friendlyError(error)}`, true);
    scheduleRender();
  });
  flushDeferredRender();
}

function moveFocus(cell, dRow, dCol, wrap) {
  const cols = activeSheet().columns.length;
  let row = Number(cell.dataset.row) + dRow;
  let col = Number(cell.dataset.col) + dCol;
  if (wrap) {
    if (col >= cols) { col = 0; row += 1; }
    else if (col < 0) { col = cols - 1; row -= 1; }
  }
  const target = sheetArea.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
  if (!target) return false;
  target.focus();
  return true;
}

function handleCellKeydown(event, cell) {
  if (cell.dataset.editing === "1") {
    if (event.key === "Escape") {
      event.preventDefault();
      finishEdit(cell, false);
      cell.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      finishEdit(cell, true);
      if (!moveFocus(cell, 1, 0, false)) cell.focus();
    } else if (event.key === "Tab") {
      event.preventDefault();
      finishEdit(cell, true);
      if (!moveFocus(cell, 0, event.shiftKey ? -1 : 1, true)) cell.focus();
    }
    return;
  }
  const sheet = DEFINITIONS.find(item => item.collection === cell.dataset.collection);
  if (sheet?.kind === "history" && cell.dataset.field === "N° Série" && event.key === "Enter") {
    event.preventDefault();
    const record = state.records[sheet.collection].find(item => item.id === cell.dataset.docId);
    if (record) openRoadmap(record);
    return;
  }
  if (event.key === "F2" || event.key === "Enter") {
    event.preventDefault();
    beginEdit(cell);
  } else if (event.key === "Tab") {
    if (moveFocus(cell, 0, event.shiftKey ? -1 : 1, true)) event.preventDefault();
  } else if (event.key.startsWith("Arrow")) {
    const delta = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    event.preventDefault();
    moveFocus(cell, delta[0], delta[1], false);
  }
}

/* ---------- Writes ---------- */

function holderOf(sheet, record) {
  const field = holderField(sheet);
  return field ? text(record[field]) : "";
}

function historyEntry(record, sheet, holder, status, remark) {
  const isPrinter = sheet.kind === "printer";
  return trimRecord({
    "N° Série": record[serialField(sheet)] || "",
    "N° PC": record[pcField(sheet)] || "",
    Type: record.Type || "",
    Marque: record.Marque || "",
    Service: isPrinter ? holder : record.Service || "",
    Utilisateur: isPrinter ? "" : holder,
    Statut: status,
    Remarque: remark,
    updatedAt: serverTimestamp()
  });
}

async function saveRecord(sheet, existing, changes) {
  const cleaned = trimRecord(changes);
  const persisted = { ...cleaned, updatedAt: serverTimestamp() };
  const field = holderField(sheet);
  const oldHolder = holderOf(sheet, existing);
  const newHolder = field && field in cleaned ? text(cleaned[field]) : oldHolder;
  const holderChanged = Boolean(field) && oldHolder !== newHolder;
  const updates = {};

  if (holderChanged) {
    persisted[HISTORY_FIELD] = updatedChain(
      cleaned[HISTORY_FIELD] ?? existing[HISTORY_FIELD], oldHolder, newHolder
    );
  }
  updates[`${sheet.collection}/${existing.id}`] = encodeRecord(persisted);

  if (holderChanged) {
    const merged = { ...existing, ...cleaned };
    const serial = text(merged[serialField(sheet)]);
    let hadCurrent = false;
    state.records.historique
      .filter(item => serial && text(item["N° Série"]) === serial && item.Statut === STATUS_CURRENT)
      .forEach(item => {
        hadCurrent = true;
        updates[`historique/${item.id}`] = encodeRecord({
          Statut: STATUS_PAST,
          updatedAt: serverTimestamp()
        });
      });
    if (!hadCurrent && oldHolder) {
      const id = push(ref(db, "historique")).key;
      updates[`historique/${id}`] = encodeRecord(
        historyEntry(existing, sheet, oldHolder, STATUS_PAST, `réaffecté le ${dateText()}`)
      );
    }
    if (newHolder) {
      const id = push(ref(db, "historique")).key;
      updates[`historique/${id}`] = encodeRecord(
        historyEntry(merged, sheet, newHolder, STATUS_CURRENT, `affecté le ${dateText()}`)
      );
    }
  }
  await update(ref(db), updates);
}

async function addRecord(sheet, record) {
  const cleaned = trimRecord(record);
  const holder = holderOf(sheet, cleaned);
  if (sheet.kind !== "history") {
    if (!cleaned[serialField(sheet)] && !cleaned[pcField(sheet)]) {
      throw new Error(`Renseignez au moins « ${pcField(sheet)} » ou le N° de série.`);
    }
    if (holder && !cleaned[HISTORY_FIELD]) cleaned[HISTORY_FIELD] = `(actuel) ${holder}`;
  }
  const updates = {};
  const id = push(ref(db, sheet.collection)).key;
  updates[`${sheet.collection}/${id}`] = encodeRecord({ ...cleaned, updatedAt: serverTimestamp() });
  if (holder) {
    const historyId = push(ref(db, "historique")).key;
    updates[`historique/${historyId}`] = encodeRecord(
      historyEntry(cleaned, sheet, holder, STATUS_CURRENT, `affecté le ${dateText()}`)
    );
  }
  await update(ref(db), updates);
}

async function deleteRecord(sheet, record) {
  if (!window.confirm(`Supprimer cette ligne de « ${sheet.name} » ?`)) return;
  try {
    await remove(ref(db, `${sheet.collection}/${record.id}`));
  } catch (error) {
    notify(`Suppression impossible : ${friendlyError(error)}`, true);
  }
}

/* ---------- Add form ---------- */

function openForm() {
  const sheet = activeSheet();
  formFields.replaceChildren();
  if (formError) formError.textContent = "";
  document.querySelector("#dialog-title").textContent = `Ajouter — ${sheet.name}`;
  sheet.columns.filter(([name]) => name !== ALERT_FIELD).forEach(([field]) => {
    const label = el("label", "", field);
    const input = el("input");
    input.name = field;
    input.autocomplete = "off";
    label.append(input);
    if (SUGGEST_FIELDS.includes(field)) {
      const id = `form-${fieldId(field)}`;
      input.setAttribute("list", id);
      label.append(buildDatalist(id, field));
    }
    formFields.append(label);
  });
  recordDialog.showModal();
  formFields.querySelector("input")?.focus();
}

recordForm.addEventListener("submit", async event => {
  event.preventDefault();
  const record = Object.fromEntries(new FormData(recordForm).entries());
  try {
    await addRecord(activeSheet(), record);
    recordDialog.close();
    notify("Ligne ajoutée.");
  } catch (error) {
    const message = friendlyError(error);
    if (formError) formError.textContent = message;
    else notify(message, true);
  }
});
recordDialog.addEventListener("close", () => recordForm.reset());
document.querySelector("#add-button").addEventListener("click", openForm);
document.querySelector("#close-dialog").addEventListener("click", () => recordDialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => recordDialog.close());

/* ---------- Paste from Excel ---------- */

async function pasteGrid(startCell, raw) {
  const sheet = activeSheet();
  const rows = raw.replace(/\r\n?/g, "\n").split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  const matrix = rows.map(row => row.split("\t"));
  const startRow = Number(startCell.dataset.row);
  const startCol = Number(startCell.dataset.col);
  const visible = getVisibleRecords(sheet);
  const jobs = [];
  matrix.forEach((values, rowOffset) => {
    const changes = {};
    values.forEach((value, colOffset) => {
      const field = sheet.columns[startCol + colOffset]?.[0];
      if (field && field !== ALERT_FIELD) changes[field] = value.trim();
    });
    if (!Object.keys(changes).length) return;
    const target = visible[startRow + rowOffset];
    if (target) jobs.push(saveRecord(sheet, target, changes));
    else if (Object.values(changes).some(Boolean)) jobs.push(addRecord(sheet, changes));
  });
  try {
    await Promise.all(jobs);
    notify("Cellules collées et enregistrées.");
  } catch (error) {
    notify(`Collage impossible : ${friendlyError(error)}`, true);
  }
}

sheetArea.addEventListener("paste", event => {
  const cell = event.target.closest?.("td[data-field]");
  if (!cell) return;
  const raw = event.clipboardData?.getData("text/plain") ?? "";
  const multi = /[\t\r\n]/.test(raw.replace(/[\r\n]+$/, ""));
  const editing = cell.dataset.editing === "1";
  if (editing && !multi) {
    // Single value inside an edited cell: paste plain text only (never HTML into the cell).
    if (event.target === cell) {
      event.preventDefault();
      document.execCommand("insertText", false, raw.replace(/[\r\n]+/g, " "));
    }
    return;
  }
  event.preventDefault();
  if (editing) finishEdit(cell, false);
  pasteGrid(cell, raw);
});

/* ---------- Import / Export Excel ---------- */

async function importWorkbook(file) {
  try {
    if (!window.XLSX) throw new Error("La librairie Excel n’est pas chargée.");
    await refreshAllTables();
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const stats = new Map(DEFINITIONS.map(sheet => [
      sheet.collection, { sheet, imported: 0, skipped: 0, errors: [] }
    ]));
    const knownBySheet = new Map(DEFINITIONS.map(sheet => {
      const known = new Map();
      if (sheet.kind !== "history") {
        const identifierField = importIdentifierField(sheet);
        for (const record of state.records[sheet.collection]) {
          const identifier = norm(record[identifierField]);
          if (identifier && !known.has(identifier)) known.set(identifier, record);
        }
      }
      return [sheet.collection, known];
    }));
    const writesByPath = new Map();

    for (const worksheetName of workbook.SheetNames) {
      const sheet = definitionForWorksheet(worksheetName);
      if (!sheet) continue;
      const result = stats.get(sheet.collection);
      try {
        const parsed = parseWorksheet(workbook.Sheets[worksheetName], sheet, XLSX);
        result.skipped += parsed.skippedRows;
        if (parsed.error) {
          result.errors.push(`${worksheetName}: ${parsed.error}`);
          continue;
        }
        const known = knownBySheet.get(sheet.collection);
        for (const record of parsed.records) {
          if (!Object.values(record).some(Boolean)) {
            result.skipped += 1;
            continue;
          }
          let id;
          let existing = null;
          if (sheet.kind === "history") {
            id = push(ref(db, sheet.collection)).key;
          } else {
            const identifierField = importIdentifierField(sheet);
            const identifier = norm(record[identifierField]);
            if (!identifier) {
              result.skipped += 1;
              continue;
            }
            existing = known.get(identifier) || null;
            id = existing?.id || importDocumentId(sheet, record);
          }

          const path = `${sheet.collection}/${id}`;
          const previous = writesByPath.get(path);
          const previousRecord = previous?.record || existing || {};
          const merged = { ...previousRecord, ...record };
          delete merged.id;
          writesByPath.set(path, {
            path,
            sheet,
            record: merged,
            rows: (previous?.rows || 0) + 1,
            data: encodeRecord({ ...merged, updatedAt: serverTimestamp() })
          });
          result.imported += 1;
          if (sheet.kind !== "history") {
            const identifierField = importIdentifierField(sheet);
            known.set(norm(record[identifierField]), { id, ...merged });
          }
        }
      } catch (error) {
        result.errors.push(`${worksheetName}: ${friendlyError(error)}`);
      }
    }

    const writes = [...writesByPath.values()];
    for (let index = 0; index < writes.length; index += 500) {
      const batch = writes.slice(index, index + 500);
      const updates = Object.fromEntries(batch.map(({ path, data }) => [path, data]));
      try {
        await update(ref(db), updates);
      } catch (error) {
        const failedBySheet = new Map();
        for (const write of batch) {
          const result = stats.get(write.sheet.collection);
          result.imported -= write.rows;
          failedBySheet.set(write.sheet.collection, (failedBySheet.get(write.sheet.collection) || 0) + write.rows);
        }
        for (const [collection, rows] of failedBySheet) {
          stats.get(collection).errors.push(`${rows} ligne(s) non enregistrée(s): ${friendlyError(error)}`);
        }
      }
    }

    try {
      await refreshAllTables();
    } catch (error) {
      for (const result of stats.values()) result.errors.push(`Rafraîchissement impossible: ${friendlyError(error)}`);
    }

    const summary = [...stats.values()].map(({ sheet, imported, skipped }) =>
      `${sheet.name}: ${imported} importée(s), ${skipped} ignorée(s)`
    );
    const errors = [...stats.values()].flatMap(({ sheet, errors: sheetErrors }) =>
      sheetErrors.map(error => `${sheet.name}: ${error}`)
    );
    summary.push(`Total ignoré: ${[...stats.values()].reduce((sum, result) => sum + result.skipped, 0)}`);
    summary.push(errors.length ? `Erreurs (${errors.length}): ${errors.join(" | ")}` : "Erreurs: 0");
    notify(summary.join("\n"), errors.length > 0, 20000);
  } catch (error) {
    notify(`Import impossible : ${friendlyError(error)}`, true);
  }
}

function exportWorkbook() {
  try {
    if (!window.XLSX) throw new Error("La librairie Excel n’est pas chargée.");
    const workbook = buildWorkbook(XLSX, state.records, documentDate());
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `Inventaire_Parc_Informatique_${stamp}.xlsx`, { cellStyles: true });
    notify("Classeur exporté.");
  } catch (error) {
    notify(`Export impossible : ${friendlyError(error)}`, true);
  }
}

document.querySelector("#import-button").addEventListener("click", () => document.querySelector("#import-file").click());
document.querySelector("#import-file").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (file) importWorkbook(file);
  event.target.value = "";
});
document.querySelector("#export-button").addEventListener("click", exportWorkbook);
document.querySelector("#print-button").addEventListener("click", () => window.print());
searchInput.addEventListener("input", render);
stateFilter.addEventListener("change", render);
serviceFilter.addEventListener("change", render);