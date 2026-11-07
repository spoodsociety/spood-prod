// Print Plan: assign pieces to printers, commit, run batches, finalize. Line states save to order_lines (set_line_state);
// the queue layout and settings save to app_state key printplan2/main (set_app_state).
import * as db from "./supabase.js";
import { $, esc, plural, isoDay, addDays, NO_DATE, store, onChange, load, alloc, owed, free, lineKind, lineSpec, isCustom, shipBy, isExpress, rank, sizeLabel, toast, confirmBox, reloadOrder, reloadInventory, cleanText, setErr, fmtSize, cardHtml, modal, openOrderForm } from "./orders.js";

const KEY = "printplan2/main";
const PRINTERS = [1, 2, 3, 4, 5, 6];
const B = { QUEUED: "queued", PRINTING: "printing", REVIEW: "review", DONE: "done" };
const LIVE = new Set([B.QUEUED, B.PRINTING]);
const UI_KEY = "spood.pq.ui";
const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const daysFromToday = (day) => Math.round((new Date(day + "T12:00") - new Date(isoDay() + "T12:00")) / 864e5);
function shipLabel(day) { if (!day || day === NO_DATE) return { text: "no ship date", tone: "" }; const n = daysFromToday(day); if (n < 0) return { text: "overdue", tone: "late" }; if (n === 0) return { text: "ships today", tone: "due" }; if (n === 1) return { text: "ships tomorrow", tone: "" }; return { text: "ships " + new Date(day + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }), tone: "" }; }
const fmtHours = (h) => { const m = Math.round(h * 60); const s = (m >= 60 ? Math.floor(m / 60) + "h " : "") + (m % 60 ? (m % 60) + "m" : ""); return s.trim() || "0m"; };
const clock = (min) => { const d = Math.floor(min / 1440); const t = new Date(2000, 0, 1, 0, min % 1440); return t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + (d ? ` (+${d}d)` : ""); };
const printerColor = (p) => `var(--p${p})`;
const norm = (s) => String(s || "").trim().toLowerCase();
const groupKey = (s) => `${norm(s.name)}|${norm(s.color)}`;
const skuKey = (s) => `${norm(s.name)}|${norm(s.size)}|${norm(s.color)}`;
const specText = (s) => [s.size ? sizeLabel(s.size) : "", s.color].filter(Boolean).join(" · ");
const sizeBucket = (s) => (/^(small|standard|default size)$/i.test(s || "") || !s ? "Standard" : s);
function estimateHours(name, size) { const s = (name + " " + (size || "")).toLowerCase(); let h = /floor|insert/.test(s) ? 3 : /climb|wall|tree|mountain/.test(s) ? 2.5 : /window|fireplace|cathedral/.test(s) ? 1.5 : /ledge|bat|rock|cloud|log|mushroom/.test(s) ? 0.75 : 1.25; if (/large/.test(s)) h *= 1.6; if (/sling/.test(s)) h *= 0.5; if (/\d/.test(size || "")) h *= 1.2; return Math.round(h * 4) / 4; }
const hoursFor = (name, size) => { const v = state.times && state.times[(name + "|" + size).toLowerCase()]; return v > 0 ? Number(v) : estimateHours(name, size); };

/* ---------- catalog: pieces from open orders ---------- */
let ORDERS = [], ORDER_BY_ID = new Map(), PIECE_BY_ID = new Map(), LINE_BY_UID = new Map(), CATALOG_ITEMS = [], CATALOG_COLORS = [];
const orderOf = (pid) => ORDER_BY_ID.get(PIECE_BY_ID.get(pid)?.orderId);
const customerOf = (pid) => orderOf(pid)?.customer || "";
function rebuildCatalog() {
  const orders = []; LINE_BY_UID = new Map();
  for (const o of store.open) {
    const pieces = [];
    for (const l of [...(o.lines || [])].sort((a, b) => a.line_no - b.line_no)) {
      if (lineKind(l) !== "print") continue;
      LINE_BY_UID.set(l.uid, { l, o });
      const sp = lineSpec(l); const qty = Math.max(1, Number(l.qty) || 1); const a = (l.print_state || "") === "" ? alloc.get(l.uid) || 0 : 0;
      const bin = l.packed ? "done" : l.print_state === "printing" || l.print_state === "printed" ? l.print_state : "print";
      const hours = hoursFor(sp.name, sp.size);
      for (let n = 0; n < qty; n++) pieces.push({ id: qty > 1 ? l.uid + "#" + n : l.uid, line: l.uid, qty, bin, onShelf: n < a, orderId: o.id, name: sp.name, size: sp.size, color: sp.color, hours, custom: sp.custom || (!sp.inv && isCustom(l.text)), inv: sp.inv, text: cleanText(l.text), note: l.note || "", conflict: l.conflict || "", dims: fmtSize(l) });
    }
    orders.push({ id: o.id, customer: o.customer, platform: (o.platform || []).join(", "), shipBy: shipBy(o), express: isExpress(o), pieces, o });
  }
  orders.sort((a, b) => rank(a.o, b.o));
  ORDERS = orders; ORDER_BY_ID = new Map(orders.map((o) => [o.id, o])); PIECE_BY_ID = new Map(orders.flatMap((o) => o.pieces.map((p) => [p.id, p])));
  const invParts = store.inv.map((r) => lineSpec({ notion_inventory_id: r.id }));
  CATALOG_ITEMS = [...new Set([...PIECE_BY_ID.values()].map((p) => p.name).concat(invParts.map((x) => x.name)))].filter(Boolean).sort();
  CATALOG_COLORS = [...new Set([...PIECE_BY_ID.values()].map((p) => p.color).concat(invParts.map((x) => x.color)))].filter(Boolean).sort();
}

/* ---------- state ---------- */
const SHARED = ["seq", "lanes", "pendingStock", "hoursPerDay", "batchMin", "restockWeeks", "keep", "times", "printers6"];
function freshShared() { return { v: 3, seq: 0, hoursPerDay: 12, batchMin: 3, restockWeeks: 1, keep: {}, times: {}, lanes: Object.fromEntries(PRINTERS.map((p) => [p, []])), pendingStock: {}, printers6: 1 }; }
let state = freshShared(); let VERSION = null; let loaded = false; let loadErr = ""; let planAt = 0; // when this tab last asked the server for its plan copy (and got it)
let ui = { view: "needs", ahead: 3, sort: null, openGroups: [], openColors: [], stockFormFor: null, startAt: "08:00", picks: {}, q: "", due: "all", hideShelf: false, commitMode: "new", gapAll: false, batchOpen: false, editTimeFor: null };
try { const u = JSON.parse(localStorage.getItem(UI_KEY) || "null"); if (u) ui = { ...ui, ...u }; } catch (e) {}
const persistUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {} };
function adopt(value) { const s = freshShared(); for (const k of SHARED) if (value && value[k] !== undefined) s[k] = value[k]; PRINTERS.forEach((p) => { s.lanes[p] ||= []; }); s.keep ||= {}; s.times ||= {}; s.pendingStock ||= {}; return s; }

export async function loadPlan(force = false) {
  const asked = Date.now();
  try {
    const rows = await db.readAppState([KEY], force || VERSION == null ? {} : { [KEY]: VERSION });
    // this tab changed the plan while the read was in flight (or hasn't saved yet): the server copy is behind this screen; flush() reconciles on 'stale'
    if (loaded && (pending.length || saving || db.lastWriteAt() > asked)) { refresh(); return; }
    const row = Array.isArray(rows) ? rows.find((r) => r.key === KEY) : null;
    if (!row) { if (!loaded) { state = freshShared(); VERSION = 0; } }
    else if (!row.same && (VERSION == null || row.version >= VERSION)) { state = adopt(row.value); VERSION = row.version; }
    loaded = true; loadErr = ""; planAt = asked;
  } catch (e) { loadErr = db.errText(e); }
  refresh();
}
// Every change: apply locally, then save. On 'stale', take the server's copy and re-apply only this viewer's unsaved actions.
let pending = []; let saving = false; let saveT = null; let saveErr = "";
function persist() { clearTimeout(saveT); saveT = setTimeout(flush, 250); }
async function flush() {
  if (saving || !loaded) { if (saving) persist(); return; }
  saving = true; const batch = pending.slice(); const shared = {}; SHARED.forEach((k) => (shared[k] = state[k]));
  try {
    const r = await db.setAppState(KEY, JSON.parse(JSON.stringify({ v: 3, ...shared })), VERSION || 0);
    VERSION = r.version; pending = pending.slice(batch.length); saveErr = "";
    load(); // the save derived every line's print status server-side; show it
  } catch (e) {
    if (e instanceof db.RpcError && e.stale) {
      try { const rows = await db.readAppState([KEY], {}); const row = rows.find((x) => x.key === KEY); state = row ? adopt(row.value) : freshShared(); VERSION = row ? row.version : 0;
        for (const a of pending) { try { actions[a.name](...a.args); } catch (x) { console.error(x); } }
        saving = false; saveErr = ""; persist(); render(); return;
      } catch (x) { saveErr = db.errText(x); }
    } else saveErr = db.errText(e);
    toast("⚠ Print plan not saved: " + saveErr + " — retrying", true);
    setTimeout(persist, 10000); // keep trying: the change stays in this tab until it saves
  }
  saving = false; render();
}

/* ---------- selectors ---------- */
const allBatches = () => PRINTERS.flatMap((p) => state.lanes[p].map((b) => ({ printer: p, batch: b })));
function locate(id) { for (const p of PRINTERS) { const i = state.lanes[p].findIndex((b) => b.id === id); if (i >= 0) return { printer: p, list: state.lanes[p], index: i, batch: state.lanes[p][i] }; } return null; }
const estimatedHours = (b) => sum(b.items, (i) => i.hours);
const batchHours = (b) => (b.hoursOverride != null ? b.hoursOverride : estimatedHours(b));
const nextId = (prefix) => prefix + ++state.seq;
function coveredPieceIds({ ignoreTargetsOf } = {}) {
  const covered = new Set();
  for (const p of PIECE_BY_ID.values()) if (p.bin !== "print") covered.add(p.id);
  for (const { batch: b } of allBatches()) for (const it of b.items) {
    if (b.state === B.DONE) { if (it.outcome?.to === "piece") covered.add(it.outcome.pieceId); continue; }
    if (it.pieceId) covered.add(it.pieceId);
    if (b.state === B.REVIEW && b.id !== ignoreTargetsOf && it.dest?.startsWith("piece:")) covered.add(it.dest.slice(6));
  }
  return covered;
}
const dueCut = () => (ui.due && ui.due !== "all" ? addDays(isoDay(), Number(ui.due)) : null);
const dueOk = (p) => { const c = dueCut(); if (!c) return true; const o = ORDER_BY_ID.get(p.orderId); return !!o && o.shipBy <= c; };
const openPieces = (covered = coveredPieceIds()) => [...PIECE_BY_ID.values()].filter((p) => !covered.has(p.id));
const livePicks = (covered = coveredPieceIds()) => Object.entries(ui.picks).filter(([id]) => !covered.has(id) && PIECE_BY_ID.has(id));
const pieceRun = (p) => { for (const { printer, batch: b } of allBatches()) { if (b.state !== B.PRINTING) continue; if (b.items.some((it) => it.pieceId === p.id)) return { printer, batch: b.name }; } return p.bin === "printing" ? { printer: 0 } : null; };
const invRow = (spec) => (spec.inv ? store.invById.get(spec.inv) || null : null);
const stockKey = (spec) => (spec.inv ? "inv:" + spec.inv : skuKey(spec));
function stockFor(spec) { if (spec.custom) return null; const r = invRow(spec); const pend = state.pendingStock[stockKey(spec)]?.n || 0; if (!r) return pend ? { qty: pend } : null; if (r.in_stock == null) return { qty: pend || null, note: "not tracked" }; return { qty: Number(r.in_stock) + pend }; }
const stockText = (st) => (st == null ? null : st.note || String(st.qty ?? 0));
// sales over the last 7 days, from every order (any status)
function sold7() { const since = addDays(isoDay(), -6); const byRow = {}, byGroup = {}; for (const o of store.orders) { if (!o.order_date || o.order_date < since) continue; for (const l of o.lines || []) { if (lineKind(l) !== "print") continue; const sp = lineSpec(l); const q = Number(l.qty) || 1; byGroup[groupKey(sp)] = (byGroup[groupKey(sp)] || 0) + q; if (sp.inv) byRow[sp.inv] = (byRow[sp.inv] || 0) + q; } } return { byRow, byGroup }; }
let SALES = { byRow: {}, byGroup: {} };
const sold7For = (spec) => SALES.byGroup[groupKey(spec)] || 0;
function upcomingByGroup(horizon, covered) { const out = {}; for (const o of ORDERS) { if (o.shipBy > horizon) continue; for (const p of o.pieces) { if (covered.has(p.id)) continue; const g = (out[groupKey(p)] ||= { n: 0, sizes: {} }); g.n++; g.sizes[sizeLabel(p.size)] = (g.sizes[sizeLabel(p.size)] || 0) + 1; } } return out; }
const sizeBreakdown = (sizes) => { const e = Object.entries(sizes); return e.length > 1 ? " (" + e.map(([s, n]) => `${n} ${s}`).join(", ") + ")" : ""; };
function floatPrinting(printer) { const l = state.lanes[printer]; if (!l || !l.some((b) => b.state === B.PRINTING)) return; const pr = l.filter((b) => b.state === B.PRINTING), rest = l.filter((b) => b.state !== B.PRINTING); if (pr.every((b, i) => l[i] === b)) return; l.splice(0, l.length, ...pr, ...rest); }
function startMinutes() { const [h, m] = (ui.startAt || "08:00").split(":").map(Number); return h * 60 + m; }
function laneSchedule(printer) { floatPrinting(printer); let t = startMinutes(); return state.lanes[printer].map((b, index) => { const hours = batchHours(b); const start = t; if (LIVE.has(b.state)) t += Math.round(hours * 60); return { batch: b, index, hours, start, end: t }; }); }
const GAP_BIG = 2;
function shortfalls(covered) {
  const horizon = addDays(isoDay(), ui.ahead); const groups = new Map();
  const cell = (spec) => { const g = groupKey(spec); if (!groups.has(g)) groups.set(g, new Map()); const m = groups.get(g); const b = sizeBucket(spec.size); if (!m.has(b)) m.set(b, { size: b, need: 0, queuedStock: 0, spec }); return m.get(b); };
  for (const p of openPieces(covered)) if (!p.custom && ORDER_BY_ID.get(p.orderId).shipBy <= horizon) cell(p).need++;
  for (const { batch } of allBatches()) if (batch.state !== B.DONE) for (const it of batch.items) if (!it.pieceId && groups.has(groupKey(it.spec))) cell(it.spec).queuedStock++;
  const out = new Map();
  for (const [g, sizes] of groups) { let short = 0, need = 0, shelf = 0, queued = 0; const bySize = [];
    for (const c of sizes.values()) { if (!c.need) continue; const onShelf = Math.max(0, stockFor(c.spec)?.qty || 0); const gap = Math.max(0, c.need - onShelf - c.queuedStock); need += c.need; shelf += onShelf; queued += c.queuedStock; short += gap; if (gap) bySize.push({ size: sizeLabel(c.size), gap }); }
    if (need) out.set(g, { short, need, shelf, queued, bySize, level: short >= GAP_BIG ? "big" : short ? "some" : "" }); }
  return out;
}
const gapTitle = (gap) => `${gap.need} due in the next ${plural(ui.ahead, "day")}, ${gap.shelf} on the shelf, ${gap.queued} queued for stock`;
const NOT_RESTOCKED = /starter|cocoon|plant|enclosure|mystery|substrate|moss/i;
function restockRows(covered) {
  const queued = {};
  for (const { batch } of allBatches()) if (batch.state !== B.DONE) for (const it of batch.items) if (!it.pieceId && it.spec.inv) queued[it.spec.inv] = (queued[it.spec.inv] || 0) + 1;
  return store.inv.filter((r) => r.in_stock != null && !NOT_RESTOCKED.test(r.item) && !isCustom(r.item)).map((r) => {
    const sp = lineSpec({ notion_inventory_id: r.id });
    const x = { key: r.id, name: sp.name, size: sp.size, color: sp.color, spec: sp };
    x.shelf = Math.max(0, Number(r.in_stock) || 0) + (state.pendingStock["inv:" + r.id]?.n || 0);
    x.owed = owed.get(r.id) || 0; x.queued = queued[r.id] || 0; x.sold7 = SALES.byRow[r.id] || 0; x.keep = Number(state.keep[r.id]) || 0;
    x.free = Math.max(0, x.shelf - x.owed) + x.queued; x.target = Math.max(x.keep, Math.ceil(x.sold7 * (state.restockWeeks || 0))); x.suggest = Math.max(0, x.target - x.free);
    return x;
  }).sort((a, b) => b.suggest - a.suggest || b.sold7 - a.sold7 || a.name.localeCompare(b.name));
}
function shelfPlan(covered) { const open = openPieces(covered).sort((a, b) => ORDER_BY_ID.get(a.orderId).shipBy.localeCompare(ORDER_BY_ID.get(b.orderId).shipBy)); const toPrint = []; const shelfIds = new Set(); let fromShelf = 0; for (const p of open) { if (p.onShelf && !p.custom) { fromShelf++; shelfIds.add(p.id); } else toPrint.push(p); } return { open, toPrint, fromShelf, shelfIds }; }
function summary(covered) {
  const { open, toPrint, fromShelf } = shelfPlan(covered);
  const queuedHours = sum(allBatches().filter(({ batch }) => LIVE.has(batch.state)), ({ batch }) => batchHours(batch));
  const hours = sum(toPrint, (p) => p.hours) + queuedHours; const perDay = PRINTERS.length * (state.hoursPerDay || 12); const days = hours ? Math.ceil(hours / perDay) - 1 : 0;
  const printing = sum(allBatches().filter(({ batch }) => batch.state === B.PRINTING), ({ batch }) => batch.items.length);
  const printed = sum(allBatches().filter(({ batch }) => batch.state === B.REVIEW || batch.state === B.DONE), ({ batch }) => batch.items.filter((i) => !i.outcome || i.outcome.to !== "fail").length);
  return { toPrint: toPrint.length, orders: new Set(open.map((p) => p.orderId)).size, hours, perPrinter: hours / PRINTERS.length, doneBy: hours ? addDays(isoDay(), days) : null, printing, printed, fromShelf };
}
function batchSuggestions(covered) {
  const { toPrint } = shelfPlan(covered); const groups = new Map();
  for (const p of toPrint) { if (p.custom) continue; const k = norm(p.name) + "|" + norm(sizeBucket(p.size)); if (!groups.has(k)) groups.set(k, { key: k, name: p.name, size: sizeBucket(p.size), pieces: [], colors: new Map() }); const g = groups.get(k); g.pieces.push(p); const ck = norm(p.color); const c = g.colors.get(ck) || { label: p.color || "no color listed", n: 0 }; c.n++; g.colors.set(ck, c); }
  const load = Object.fromEntries(PRINTERS.map((pr) => [pr, sum(state.lanes[pr].filter((b) => LIVE.has(b.state)), batchHours)]));
  const list = [...groups.values()].filter((g) => g.pieces.length >= (state.batchMin || 3)).map((g) => { g.orders = new Set(g.pieces.map((p) => p.orderId)).size; g.firstShip = g.pieces.map((p) => ORDER_BY_ID.get(p.orderId).shipBy).sort()[0]; g.hours = sum(g.pieces, (p) => p.hours); return g; }).sort((a, b) => a.firstShip.localeCompare(b.firstShip) || b.pieces.length - a.pieces.length);
  for (const g of list) { const pr = PRINTERS.reduce((best, x) => (load[x] < load[best] ? x : best), PRINTERS[0]); g.printer = pr; load[pr] += g.hours; }
  return list;
}
const GROUP_COLUMNS = [
  { key: "name", label: "Item & color", asc: true, value: (r) => (r.name + " " + r.color).toLowerCase() },
  { key: "needed", label: "Needed", value: (r) => r.open.length }, { key: "queued", label: "Queued", value: (r) => r.queued },
  { key: "soon", label: () => `Next ${ui.ahead} d`, value: (r) => r.soon }, { key: "short", label: "Short", value: (r) => r.gap?.short || 0 },
  { key: "stock", label: "In stock", value: (r) => r.stock?.qty ?? -1 }, { key: "sold", label: "Sold 7 d", value: (r) => r.sold7 },
  { key: "first", label: "First ships", asc: true, value: (r) => r.firstShip }, { key: "time", label: "Print time", value: (r) => r.hours },
];
function groupRows(covered) {
  const gaps = shortfalls(covered); const horizon = addDays(isoDay(), ui.ahead); const rows = new Map();
  const row = (spec) => { const k = groupKey(spec); if (!rows.has(k)) rows.set(k, { key: k, name: spec.name, color: spec.color, open: [], queued: 0, printed: 0, byPrinter: {}, ref: null }); return rows.get(k); };
  for (const { printer, batch } of allBatches()) for (const it of batch.items) { const r = row(it.spec); if (!r.ref || it.pieceId) r.ref = it.spec; if (batch.state === B.DONE) { r.printed++; continue; } r.queued++; r.byPrinter[printer] = (r.byPrinter[printer] || 0) + 1; }
  for (const p of openPieces(covered)) { if (!dueOk(p)) continue; const r = row(p); r.open.push(p); r.ref = p; }
  for (const r of rows.values()) { r.open.sort((a, b) => ORDER_BY_ID.get(a.orderId).shipBy.localeCompare(ORDER_BY_ID.get(b.orderId).shipBy)); r.firstShip = r.open.length ? ORDER_BY_ID.get(r.open[0].orderId).shipBy : NO_DATE; r.hours = sum(r.open, (p) => p.hours); r.soon = r.open.filter((p) => ORDER_BY_ID.get(p.orderId).shipBy <= horizon).length; r.sizes = {}; r.open.forEach((p) => { r.sizes[sizeLabel(p.size)] = (r.sizes[sizeLabel(p.size)] || 0) + 1; }); r.stock = stockFor(r.ref); r.sold7 = sold7For(r.ref); r.gap = gaps.get(r.key) || null; }
  const list = [...rows.values()].sort((a, b) => (!a.open.length) - (!b.open.length) || a.firstShip.localeCompare(b.firstShip) || b.open.length - a.open.length || a.name.localeCompare(b.name));
  const sort = ui.sort; const col = GROUP_COLUMNS.find((c) => c.key === sort?.key);
  if (col?.value) { list.forEach((r, i) => (r._i = i)); list.sort((a, b) => { const A = col.value(a), Bv = col.value(b); const c = typeof A === "string" ? A.localeCompare(Bv) : A - Bv; return c * sort.dir || a._i - b._i; }); }
  return list;
}

/* ---------- actions (the only code that changes shared state) ---------- */
const specOf = (x) => ({ name: x.name, size: x.size || "", color: x.color || "", inv: x.inv || null, custom: !!x.custom });
function queueReprint(it, printer, fromName) { const lane = state.lanes[printer]; if (!lane) return; let batch = lane.find((b) => b.state === B.QUEUED && /^Reprint/.test(b.name)); if (!batch) { batch = { id: nextId("b"), name: "Reprint", state: B.QUEUED, items: [] }; const i = lane.findIndex((b) => b.state === B.QUEUED); if (i < 0) lane.push(batch); else lane.splice(i, 0, batch); } const uid = nextId("r"); batch.items.push({ uid, pieceId: it.pieceId || null, spec: { ...it.spec }, hours: it.hours }); it.outcome = { ...(it.outcome || { to: "fail" }), reprint: { uid, printer } }; }
function unqueueReprint(r) { for (const p of PRINTERS) { const lane = state.lanes[p]; for (let i = lane.length - 1; i >= 0; i--) { const b = lane[i]; if (b.state !== B.QUEUED || !b.items.some((x) => x.uid === r.uid)) continue; b.items = b.items.filter((x) => x.uid !== r.uid); if (!b.items.length) lane.splice(i, 1); } } }
const actions = {
  commitPicks(picks) {
    let made = 0; const joined = [];
    for (const p of PRINTERS) { const ids = picks.filter(([, pr]) => pr === p).map(([id]) => id).filter((id) => PIECE_BY_ID.has(id)); if (!ids.length) continue;
      const newItems = ids.map((id) => { const pc = PIECE_BY_ID.get(id); return { uid: id, pieceId: id, spec: specOf(pc), hours: pc.hours }; });
      const into = ui.commitMode === "join" ? [...state.lanes[p]].reverse().find((b) => b.state === B.QUEUED) : null;
      if (into) { into.items.push(...newItems); made++; joined.push(`${into.name} on Printer ${p}`); continue; }
      const batch = { id: nextId("b"), name: "", state: B.QUEUED, items: newItems }; batch.name = "Batch " + state.seq; state.lanes[p].push(batch); made++; }
    if (joined.length) return `Added to ${joined.join(", ")}${made > joined.length ? ` + ${plural(made - joined.length, "new batch", "new batches")}` : ""}`;
    return `Committed ${plural(made, "batch", "batches")}. See Printer queues`;
  },
  queueFromBin(ids, printer, start, extra, spec) { // pieces of the lines (+ extra copies for stock); starting now gets its own batch, just queuing joins the printer's last queued batch
    const items = ids.map((id) => { const pc = PIECE_BY_ID.get(id); return { uid: id, pieceId: id, spec: specOf(pc), hours: pc.hours }; });
    const inv = spec.inv || store.inv.find((x) => { const sp = lineSpec({ notion_inventory_id: x.id }); return norm(sp.name) === norm(spec.name) && norm(sizeBucket(sp.size)) === norm(sizeBucket(spec.size)) && norm(sp.color) === norm(spec.color); })?.id || null;
    for (let n = 0; n < extra; n++) items.push({ uid: nextId("s"), pieceId: null, spec: { ...spec, inv }, hours: hoursFor(spec.name, spec.size) });
    let batch = start ? null : [...state.lanes[printer]].reverse().find((b) => b.state === B.QUEUED);
    if (batch) batch.items.push(...items); else { batch = { id: nextId("b"), name: "", state: B.QUEUED, items }; batch.name = "Batch " + state.seq; state.lanes[printer].push(batch); }
    if (start) batch.state = B.PRINTING;
    ids.forEach((id) => delete ui.picks[id]);
  },
  moveBatch(id, dir) { const at = locate(id); if (!at) return; const j = at.index + dir; if (j < 0 || j >= at.list.length) return; [at.list[at.index], at.list[j]] = [at.list[j], at.list[at.index]]; },
  stackBatch(id) { const at = locate(id); if (!at) return; const below = at.list[at.index + 1]; if (!below) return; at.batch.items.push(...below.items); at.list.splice(at.index + 1, 1); return "Stacked into " + at.batch.name; },
  sendBatch(id, printer) { printer = Number(printer); const at = locate(id); if (!at || !printer || printer === at.printer) return; at.list.splice(at.index, 1); state.lanes[printer].push(at.batch); return `${at.batch.name} moved to Printer ${printer}`; },
  renameBatch(id, name) { const at = locate(id); if (at && name.trim()) at.batch.name = name.trim(); },
  startBatch(id) { const at = locate(id); if (at) at.batch.state = B.PRINTING; },
  finishPrinting(id) { const at = locate(id); if (!at) return; at.batch.state = B.REVIEW; at.batch.items.forEach((it) => { it.dest ||= it.pieceId ? "piece:" + it.pieceId : "stock"; }); },
  backToPrinting(id) { const at = locate(id); if (!at) return; at.batch.state = B.PRINTING; at.batch.items.forEach((it) => delete it.dest); },
  setReprint(id, uid, v) { const it = locate(id)?.batch.items.find((i) => i.uid === uid); if (it) it.reprintOn = v; },
  reprintItem(id, uid, printer) { printer = Number(printer); if (!printer) return; const at = locate(id); const it = at?.batch.items.find((i) => i.uid === uid); if (!it || it.outcome?.to !== "fail") return; queueReprint(it, printer, at.batch.name); return `Reprint queued on Printer ${printer}`; },
  setDest(id, uid, dest) { const it = locate(id)?.batch.items.find((i) => i.uid === uid); if (it) it.dest = dest; },
  finalize(id) {
    const at = locate(id); if (!at) return; const tally = { piece: 0, stock: 0, fail: 0 };
    for (const it of at.batch.items) { const dest = it.dest || (it.pieceId ? "piece:" + it.pieceId : "stock");
      if (dest.startsWith("piece:")) { it.outcome = { to: "piece", pieceId: dest.slice(6) }; tally.piece++; }
      else if (dest === "stock") { it.outcome = { to: "stock" }; tally.stock++; const k = stockKey(it.spec); const pe = (state.pendingStock[k] ||= { spec: { ...it.spec }, n: 0 }); pe.n++; }
      else { it.outcome = { to: "fail" }; tally.fail++; const ro = it.reprintOn ?? String(at.printer); if (ro !== "no") { queueReprint(it, Number(ro), at.batch.name); tally.re = (tally.re || 0) + 1; } }
      delete it.dest; }
    at.batch.state = B.DONE;
    return [tally.piece && `${tally.piece} to orders`, tally.stock && `${tally.stock} to stock`, tally.fail && (tally.re ? `${tally.fail} failed, ${tally.re} reprint queued` : `${tally.fail} failed`)].filter(Boolean).join(" · ") + ". Job finalized";
  },
  reopen(id) { const at = locate(id); if (!at) return; for (const it of at.batch.items) { if (it.outcome?.to === "stock") { const k = stockKey(it.spec); if (state.pendingStock[k]) { state.pendingStock[k].n--; if (state.pendingStock[k].n <= 0) delete state.pendingStock[k]; } } if (it.outcome?.reprint) unqueueReprint(it.outcome.reprint); it.dest = it.outcome?.to === "piece" ? "piece:" + it.outcome.pieceId : it.outcome?.to; delete it.outcome; } at.batch.state = B.REVIEW; at.batch.items.forEach((it) => { it.dest ||= it.pieceId ? "piece:" + it.pieceId : "stock"; }); return "Reopened. Change where pieces go, then finalize again"; },
  removeItem(id, uid) { const at = locate(id); if (!at) return; const it = at.batch.items.find((i) => i.uid === uid); if (!it) return; at.batch.items = at.batch.items.filter((i) => i.uid !== uid); if (it.pieceId) delete ui.picks[it.pieceId]; if (!at.batch.items.length && it.pieceId) at.list.splice(at.index, 1); return it.pieceId ? "Sent back to Needs printing" : "Removed stock piece"; },
  newStockBatch(printer) { const batch = { id: nextId("b"), name: "", state: B.QUEUED, items: [] }; batch.name = "Stock batch " + state.seq; state.lanes[printer].push(batch); ui.stockFormFor = batch.id; },
  addPiece(id, pieceId) { const at = locate(id); const pc = PIECE_BY_ID.get(pieceId); if (!at || !pc) return; if (coveredPieceIds().has(pieceId)) return "That piece is already queued or printed"; at.batch.items.push({ uid: pieceId, pieceId, spec: specOf(pc), hours: pc.hours }); delete ui.picks[pieceId]; return `Added ${customerOf(pieceId)}’s ${pc.name} to ${at.batch.name}`; },
  dupItem(id, uid) { const at = locate(id); if (!at) return; const i = at.batch.items.findIndex((x) => x.uid === uid); if (i < 0) return; const it = at.batch.items[i]; at.batch.items.splice(i + 1, 0, { uid: nextId("s"), pieceId: null, spec: { ...it.spec }, hours: it.hours }); return `Added another ${it.spec.name}${it.pieceId ? " (extra goes to stock)" : ""}`; },
  addStock(id, spec, qty) { const at = locate(id); if (!at) return; qty = clamp(Number(qty) || 1, 1, 50); const r = store.inv.find((x) => { const sp = lineSpec({ notion_inventory_id: x.id }); return norm(sp.name) === norm(spec.name) && norm(sizeBucket(sp.size)) === norm(sizeBucket(spec.size)) && norm(sp.color) === norm(spec.color); }); if (r) spec = { ...spec, inv: r.id }; for (let n = 0; n < qty; n++) at.batch.items.push({ uid: nextId("s"), pieceId: null, spec, hours: hoursFor(spec.name, spec.size) }); return `Added ${qty} × ${spec.name}${spec.color ? " (" + spec.color + ")" : ""} for stock`; },
  setBatchHours(id, hours) { const at = locate(id); if (!at) return; at.batch.hoursOverride = hours == null ? null : clamp(Math.round(Number(hours) * 4) / 4, 0.25, 200); ui.editTimeFor = null; return hours == null ? `${at.batch.name} back to the estimate` : `${at.batch.name} set to ${fmtHours(batchHours(at.batch))}`; },
  setBatchMin(n) { state.batchMin = clamp(Math.round(Number(n) || 3), 2, 20); },
  queueSuggestion(key, printer, pieceIds) { printer = Number(printer); if (!printer) return; const pcs = pieceIds.map((id) => PIECE_BY_ID.get(id)).filter(Boolean); if (!pcs.length) return; const g = pcs[0]; const batch = { id: nextId("b"), name: `${g.name}${sizeBucket(g.size) ? " · " + sizeBucket(g.size) : ""} ×${pcs.length}`, state: B.QUEUED, items: pcs.map((p) => ({ uid: p.id, pieceId: p.id, spec: specOf(p), hours: p.hours })) }; state.lanes[printer].push(batch); pcs.forEach((p) => delete ui.picks[p.id]); return `Queued ${batch.name} on Printer ${printer}`; },
  setHpd(h) { state.hoursPerDay = clamp(Math.round(Number(h) || 12), 1, 24); },
  setWeeks(w) { state.restockWeeks = clamp(Number(w) || 0, 0, 8); },
  setKeep(rowId, n) { const v = clamp(Math.round(Number(n) || 0), 0, 99); if (v) state.keep[rowId] = v; else delete state.keep[rowId]; },
  restockAdd(rowId, qty, printer) { printer = Number(printer); qty = clamp(Math.round(Number(qty) || 0), 1, 50); if (!printer) return "Pick a printer first"; const r = store.invById.get(rowId); if (!r) return; const spec = lineSpec({ notion_inventory_id: r.id }); let batch = [...state.lanes[printer]].reverse().find((b) => b.state === B.QUEUED && b.items.every((i) => !i.pieceId) && /^Stock batch/.test(b.name)); if (!batch) { batch = { id: nextId("b"), name: "", state: B.QUEUED, items: [] }; batch.name = "Stock batch " + state.seq; state.lanes[printer].push(batch); } for (let n = 0; n < qty; n++) batch.items.push({ uid: nextId("s"), pieceId: null, spec, hours: hoursFor(spec.name, spec.size) }); return `Added ${qty} × ${spec.name}${spec.color ? " (" + spec.color + ")" : ""} to ${batch.name} on Printer ${printer}`; },
  dismissPending(key) { delete state.pendingStock[key]; },
  clearPending(key) { delete state.pendingStock[key]; },
};
const UNDOABLE = new Set(["commitPicks", "queueFromBin", "moveBatch", "stackBatch", "sendBatch", "startBatch", "finishPrinting", "backToPrinting", "setDest", "addPiece", "dupItem", "setReprint", "reprintItem", "finalize", "reopen", "removeItem", "queueSuggestion", "newStockBatch", "addStock", "setBatchHours", "restockAdd", "dismissPending", "renameBatch"]);
let history = [];
function dispatch(name, ...args) {
  if (UNDOABLE.has(name)) { history.push({ label: name, snap: JSON.stringify(state) }); if (history.length > 30) history.shift(); }
  const msg = actions[name](...args);
  pending.push({ name, args: JSON.parse(JSON.stringify(args)) });
  PRINTERS.forEach(floatPrinting); persist(); persistUi(); render();
  if (msg) toast(msg);
}
function undo() { const last = history.pop(); if (!last) return; state = JSON.parse(last.snap); pending.push({ name: "restore", args: [last.snap] }); persist(); render(); toast("Undid " + last.label); }
actions.restore = (snapStr) => { const s = JSON.parse(snapStr); for (const k of SHARED) if (s[k] !== undefined) state[k] = s[k]; };

/* Bin View follows the plan server-side (hq.plan_apply runs inside every plan save); this tab only tidies its own queue. */
function binCleanup() {
  if (!loaded || !store.loadedAt) return; let changed = false; const notes = [];
  for (const pr of PRINTERS) state.lanes[pr] = state.lanes[pr].filter((b) => {
    if (b.state !== B.QUEUED) return true;
    const keep = b.items.filter((it) => { if (!it.pieceId) return true; const pc = PIECE_BY_ID.get(it.pieceId); const gone = !pc; const handled = pc && (pc.bin === "printed" || pc.bin === "done") && LINE_BY_UID.get(pc.line)?.l.print_src !== "plan"; if (!gone && !handled) return true; changed = true; notes.push(`${it.spec.name}${gone ? " (order done or changed)" : " (marked " + pc.bin + " in Bin View)"}`); return false; });
    if (keep.length === b.items.length) return true; b.items = keep; return keep.length > 0;
  });
  if (changed) { pending.push({ name: "noop", args: [] }); persist(); toast("Took pieces off the queue to match Bin View: " + notes.slice(0, 3).join(", ") + (notes.length > 3 ? ` +${notes.length - 3}` : "")); }
}
actions.noop = () => {};

async function addToInventory(key) {
  const p = state.pendingStock[key]; const r = p && invRow(p.spec); if (!p || !r) return;
  const from = Number(r.in_stock) || 0;
  const ok = await confirmBox({ title: "Add to Inventory?", body: `Record ${p.n} × ${esc(r.item)} printed for stock: ${from} → ${from + p.n}.`, ok: "Add to Inventory" });
  if (!ok) return;
  try { await db.applyMoves([{ notion_id: r.id, kind: "print", qty: p.n, ref: "printplan", reason: "Printed for stock" }]); dispatch("clearPending", key); await reloadInventory(); toast(`Inventory updated: ${r.item} now ${from + p.n}`); }
  catch (e) { setErr("plan", "Couldn't add to Inventory: " + db.errText(e)); render(); }
}

/* ---------- views ---------- */
const printerOptions = (selected, { blank = "Not assigned", exclude } = {}) => `<option value="">${esc(blank)}</option>` + PRINTERS.filter((p) => p !== exclude).map((p) => `<option value="${p}" ${Number(selected) === p ? "selected" : ""}>Printer ${p}</option>`).join("");
const pickAttrs = (printer) => (printer ? `class="set" style="--pc:${printerColor(printer)}"` : "");
const pieceLabel = (spec) => `${esc(spec.name)}${spec.size ? " · " + esc(sizeLabel(spec.size)) : ""}${spec.color ? ` <span class="sub">${esc(spec.color)}</span>` : ""}`;
const stockTag = '<span class="stk">stock</span> ';
// a piece that belongs to an order opens that order's Bin View card
const orderBtn = (pid, inner) => (pid ? `<button type="button" class="pqo" data-act="showOrder" data-piece="${esc(pid)}">${inner}</button>` : inner);
async function showOrder(pid) {
  const uid = String(pid || "").split("#")[0]; const find = () => store.orders.find((o) => (o.lines || []).some((l) => l.uid === uid));
  let o = find(); if (!o) { await load({ done: true }); o = find(); }
  if (!o) { toast("That order wasn't found", true); return; }
  const m = modal(`<div class="pqorder"><div class="sub pqship">${esc(shipLabel(shipBy(o)).text.replace(/^./, (c) => c.toUpperCase()))}</div>${cardHtml(o)}</div><div class="row"><button type="button" class="btn ghost" data-close>Close</button></div>`, { label: "Order · " + o.customer });
  m.el.querySelector(`[data-line="${CSS.escape(uid)}"]`)?.classList.add("pqhit");
  m.el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) m.close(); else if (e.target.closest("[data-obedit]")) { m.close(); document.querySelector('nav.tabs [data-tab="bins"]')?.click(); openOrderForm(o); } });
}
const qTokens = () => String(ui.q || "").toLowerCase().split(/\s+/).filter(Boolean);
const pieceHay = (p) => { const o = ORDER_BY_ID.get(p.orderId) || {}; return [p.name, p.size, sizeLabel(p.size), p.color, o.customer, o.platform].join(" ").toLowerCase(); };
const matchesQ = (hay, t = qTokens()) => t.every((x) => hay.includes(x));
const noMatch = () => `<div class="empty" style="grid-column:1/-1">Nothing matches “${esc(ui.q)}”.</div>`;

function viewNeeds(covered) {
  const horizon = addDays(isoDay(), ui.ahead); const upcoming = upcomingByGroup(horizon, covered); const gaps = shortfalls(covered); const shelf = shelfPlan(covered).shelfIds; const t = qTokens();
  const orders = ORDERS.map((o) => ({ ...o, open: o.pieces.filter((p) => !covered.has(p.id) && (!t.length || matchesQ(pieceHay(p), t)) && !(ui.hideShelf && shelf.has(p.id)) && dueOk(p)) }))
    .map((o) => ({ ...o, prn: o.pieces.filter((p) => covered.has(p.id) && pieceRun(p) && (!t.length || matchesQ(pieceHay(p), t)) && dueOk(p)) })).filter((o) => o.open.length || o.prn.length);
  if (!orders.length && t.length) return noMatch();
  if (!orders.length) return '<div class="empty" style="grid-column:1/-1">Everything is queued. Switch to <b>Printer queues</b> to plan the order.</div>';
  const perDay = {}; orders.forEach((o) => { (perDay[o.shipBy] ||= { n: 0, pcs: 0 }); perDay[o.shipBy].n++; perDay[o.shipBy].pcs += o.open.filter((p) => !shelf.has(p.id)).length; });
  let lastDay = null;
  return orders.map((o) => {
    const due = shipLabel(o.shipBy); let dayHead = "";
    if (o.shipBy !== lastDay) { lastDay = o.shipBy; const d = perDay[o.shipBy]; const dt = o.shipBy < NO_DATE ? new Date(o.shipBy + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "No ship date"; dayHead = `<div class="dayhead"><b>${esc(dt)}</b>${/overdue|today|tomorrow/i.test(due.text) ? `<span class="pchip ${due.tone}">${esc(due.text.replace(/^ships /, ""))}</span>` : ""}<span class="sub">${plural(d.n, "order")} · ${plural(d.pcs, "piece")} to print</span></div>`; }
    const toPrint = o.open.filter((p) => !shelf.has(p.id)); const allShelf = !toPrint.length && o.open.length > 0;
    return dayHead + `<article class="order${allShelf ? " allshelf" : ""}"><div class="ohead"><div><h3>${esc(o.customer)}</h3><div class="chips"><span class="pchip ${due.tone}">${esc(due.text)}</span><span class="pchip">${esc(o.platform)}</span>${o.express ? '<span class="pchip express">Express</span>' : ""}</div></div><span class="sub mono">${allShelf ? "nothing to print" : fmtHours(sum(toPrint, (p) => p.hours))}</span></div>
      ${!o.open.length ? '<div class="shelfall">Everything left is printing.</div>' : allShelf ? '<div class="shelfall">Everything here is on the shelf. Pull it for packing.</div>' : `<label class="allto">Whole order to <select data-act="pickOrder" data-order="${o.id}">${printerOptions(null, { blank: "choose…" })}</select></label>`}
      <div class="items">${o.open.map((p) => { const st = stockFor(p); const up = upcoming[groupKey(p)]; const sold = sold7For(p); const picked = ui.picks[p.id]; const gap = gaps.get(groupKey(p));
        const notes = [gap?.short ? `<span class="gapnote" title="${esc(gapTitle(gap))}">Short ${gap.short} for the next ${plural(ui.ahead, "day")}</span>` : "", p.conflict ? `<span class="dup miss">${esc(p.conflict)}</span>` : "", st == null ? (p.custom ? `<span class="dup${p.dims ? "" : " miss"}">${esc(p.dims ? "Custom · " + p.dims : "Custom size missing")}</span>` : `<span class="dup">Not in Inventory</span>`) : `<span class="dup${st.qty > 0 ? " instock" : ""}">In stock: ${esc(stockText(st))}</span>`, sold ? `<span class="dup">Ordered in the last 7 days: ${sold}</span>` : "", up?.n > 1 ? `<span class="dup">${up.n} needed in the next ${plural(ui.ahead, "day")}${sizeBreakdown(up.sizes)}</span>` : ""].filter(Boolean).join("");
        if (shelf.has(p.id)) return `<div class="item onshelf"><span class="nm">${esc(p.name)}</span><span class="meta"><span>${esc(specText(p))}</span><span class="shelfnote">On the shelf · no print needed</span><span class="dup">In stock: ${esc(stockText(st))}</span></span><select data-act="pick" data-piece="${p.id}" ${pickAttrs(picked)} aria-label="Print ${esc(p.name)} anyway">${printerOptions(picked, { blank: "Pull from shelf" })}</select></div>`;
        return `<div class="item"><span class="nm">${esc(p.name)}</span><span class="meta"><span>${[specText(p) ? esc(specText(p)) : "", `<span class="mono">${fmtHours(p.hours)}</span>`].filter(Boolean).join(" · ")}</span>${notes}</span><select data-act="pick" data-piece="${p.id}" ${pickAttrs(picked)} aria-label="Printer for ${esc(p.name)}">${printerOptions(picked)}</select></div>`; }).join("")}
      ${o.prn.map((p) => { const r = pieceRun(p); return `<div class="item printing"><span class="nm">${esc(p.name)}</span><span class="meta"><span>${esc(specText(p))}</span></span>${r.printer ? `<span class="runtag">🖨 Printing on Printer ${r.printer}</span>` : `<span class="runtag">🖨 Printing · not on a printer <button type="button" class="pq-btn mini ghost" data-act="unprint" data-line="${esc(p.line)}">Not printing</button></span>`}</div>`; }).join("")}</div></article>`;
  }).join("");
}
function viewGapBanner(covered) {
  const list = [...shortfalls(covered).entries()].filter(([, g]) => g.short).sort((a, b) => b[1].short - a[1].short);
  if (!list.length) return `<div class="gapbanner ok">Shelf and queued stock cover everything shipping in the next ${plural(ui.ahead, "day")}.</div>`;
  const big = list.filter(([, g]) => g.level === "big"); const total = sum(list, ([, g]) => g.short);
  const top = (ui.gapAll ? list : list.slice(0, 6)).map(([k, g]) => { const r = groupLabel(k); return `<button type="button" class="gapchip ${g.level}" data-act="gapGo" data-key="${esc(k)}" title="${esc(gapTitle(g))}"><b>${esc(r.name)}</b>${r.color ? " " + esc(r.color) : ""} <span class="mono">−${g.short}</span></button>`; }).join("");
  return `<div class="gapbanner${big.length ? " big" : ""}"><div><b>${plural(total, "piece")} short for the next ${plural(ui.ahead, "day")}</b> <span class="sub">across ${plural(list.length, "item")}. Shelf and queued stock can't cover these.</span></div><div class="gapchips">${top}${list.length > 6 ? `<button type="button" class="gapchip" data-act="gapMore">${ui.gapAll ? "Show less" : `+${list.length - 6} more`}</button>` : ""}</div></div>`;
}
const groupLabel = (key) => { const p = [...PIECE_BY_ID.values()].find((x) => groupKey(x) === key); return p ? { name: p.name, color: p.color } : { name: key.split("|")[0], color: key.split("|")[1] }; };
function viewByItem(covered) {
  const t = qTokens(); const rows = groupRows(covered).filter((r) => !t.length || matchesQ([r.name, r.color].join(" ").toLowerCase(), t) || r.open.some((p) => matchesQ(pieceHay(p), t)));
  if (!rows.length) return t.length ? noMatch() : '<div class="empty">Nothing to print or queued.</div>';
  const sort = ui.sort; const head = GROUP_COLUMNS.map((c) => { const on = sort?.key === c.key; const label = typeof c.label === "function" ? c.label() : c.label; return `<button type="button" class="gsort${on ? " on" : ""}" data-act="sortBy" data-key="${c.key}">${esc(label)}<i>${on ? (sort.dir > 0 ? "▲" : "▼") : "↕"}</i></button>`; }).join("");
  const shelf = shelfPlan(covered).shelfIds; const shown = ui.hideShelf ? rows.filter((r) => !r.open.length || r.open.some((p) => !shelf.has(p.id))) : rows;
  if (!shown.length) return '<div class="empty">Everything left is on the shelf.</div>';
  return `<div class="ghead">${head}<span>Printer</span></div>` + shown.map((r) => {
    const nShelf = r.open.filter((p) => shelf.has(p.id)).length; const allShelf = r.open.length > 0 && nShelf === r.open.length; const picks = [...new Set(r.open.map((p) => ui.picks[p.id] || 0))]; const groupPick = !r.open.length ? 0 : picks.length === 1 ? picks[0] : "mixed";
    const due = r.open.length ? shipLabel(r.firstShip) : { text: "all queued", tone: "" }; const sizes = Object.entries(r.sizes); const showSizes = sizes.length > 1 || (sizes[0] && sizes[0][0] !== "Small");
    const queued = r.queued ? `<span class="gnum"><b class="mono">${r.queued}</b><span class="sub">${Object.entries(r.byPrinter).map(([p, n]) => `<span style="color:${printerColor(p)};font-weight:700">P${p}</span>×${n}`).join(" ")}</span></span>` : '<span class="mono">–</span>';
    const stock = stockText(r.stock); const open = ui.openGroups.includes(r.key);
    return `<details class="grp${allShelf ? " allshelf" : ""}${r.gap?.level ? " gap-" + r.gap.level : ""}" data-group="${esc(r.key)}" ${open ? "open" : ""}><summary>
      <span class="gname"><b>${esc(r.name)}</b><span class="sub">${esc(r.color || "no color listed")}</span></span>
      <span class="gnum"><b class="mono">${r.open.length - nShelf}</b>${nShelf ? `<span class="sub">+${nShelf} on shelf</span>` : ""}${showSizes ? `<span class="sub">${sizes.map(([s, n]) => `${n} ${esc(s)}`).join(", ")}</span>` : ""}</span>
      ${queued}<span class="mono">${r.soon || "–"}</span>${r.gap?.short ? `<span class="gappill" title="${esc(gapTitle(r.gap))}">−${r.gap.short}</span>` : '<span class="mono">–</span>'}<span class="mono">${stock == null ? "–" : esc(stock)}</span><span class="mono">${r.sold7 || "–"}</span>
      <span class="${due.tone}">${esc(due.text.replace(/^ships /, ""))}</span><span class="mono">${fmtHours(r.hours)}</span>
      <select data-act="pickGroup" data-group="${esc(r.key)}" ${r.open.length ? "" : "disabled"} ${groupPick && groupPick !== "mixed" ? pickAttrs(groupPick) : ""} aria-label="Printer for all ${esc(r.name)}">${printerOptions(groupPick === "mixed" ? null : groupPick, { blank: groupPick === "mixed" ? "Mixed" : "Not assigned" })}</select></summary>
      <div class="gpcs">${r.open.length ? "" : `<div class="gpc"><span class="sub">Nothing left to assign. ${r.queued} in queues${r.printed ? `, ${r.printed} printed` : ""}.</span></div>`}${r.open.filter((p) => !(ui.hideShelf && shelf.has(p.id))).map((p) => { const o = ORDER_BY_ID.get(p.orderId); const picked = ui.picks[p.id]; return `<div class="gpc"><span>${esc(o.customer)} <span class="sub">${esc(sizeLabel(p.size))} · ${esc(shipLabel(o.shipBy).text)} · ${esc(o.platform)}</span>${shelf.has(p.id) ? ' <span class="shelfnote">On the shelf</span>' : ""}${p.note ? ` <span class="sub bvnote">${esc(p.note)}</span>` : ""}</span><select data-act="pick" data-piece="${p.id}" ${pickAttrs(picked)} aria-label="Printer for ${esc(o.customer)}'s ${esc(p.name)}">${printerOptions(picked, shelf.has(p.id) ? { blank: "Pull from shelf" } : undefined)}</select></div>`; }).join("")}</div></details>`;
  }).join("");
}
function batchColor(p) { const raw = String(p.color || "").trim(); if (!raw) return { key: "~none", label: "No color listed" }; const parts = raw.split(/\s*\+\s*/); const yeti = /yeti hide|snow monster hide/i.test(p.name), floor = /floor insert|floor/i.test(p.name); if ((yeti || floor) && parts.length === 2) { const isBase = yeti ? (c) => /^white( silk)?$/i.test(c) : (c) => /^black$/i.test(c); const bi = isBase(parts[0]) && !isBase(parts[1]) ? 0 : isBase(parts[1]) && !isBase(parts[0]) ? 1 : -1; if (bi >= 0) return { key: norm(parts[1 - bi]), label: parts[1 - bi], base: /^white$/i.test(parts[bi]) ? "" : parts[bi] }; } return { key: norm(raw).replace(/\s+/g, " "), label: raw }; }
const colorKey = (p) => batchColor(p).key;
const colorPieces = (covered) => { const t = qTokens(); return openPieces(covered).filter((p) => dueOk(p) && (!t.length || matchesQ(pieceHay(p), t))); };
function viewByColor(covered) {
  const shelf = shelfPlan(covered).shelfIds; const all = colorPieces(covered); const pieces = all.filter((p) => !(ui.hideShelf && shelf.has(p.id)));
  if (!pieces.length) return qTokens().length ? noMatch() : all.length ? '<div class="empty">Everything left is on the shelf.</div>' : '<div class="empty">Nothing to print.</div>';
  const ship = (p) => ORDER_BY_ID.get(p.orderId)?.shipBy || NO_DATE;
  const pickOf = (ps) => { if (!ps.length) return 0; const v = [...new Set(ps.map((p) => ui.picks[p.id] || 0))]; return v.length === 1 ? v[0] : "mixed"; };
  const sel = (act, attrs, ps, label) => { const gp = pickOf(ps); return `<select data-act="${act}" ${attrs} ${ps.length ? "" : "disabled"} ${gp && gp !== "mixed" ? pickAttrs(gp) : ""} aria-label="${esc(label)}">${printerOptions(gp === "mixed" ? null : gp, { blank: gp === "mixed" ? "Mixed" : "Not assigned" })}</select>`; };
  const cols = new Map(); for (const p of pieces) { const b = batchColor(p); if (!cols.has(b.key)) cols.set(b.key, { key: b.key, label: b.label, pieces: [] }); cols.get(b.key).pieces.push(p); }
  const list = [...cols.values()].map((c) => { c.toPrint = c.pieces.filter((p) => !shelf.has(p.id)); c.hours = sum(c.toPrint, (p) => p.hours); c.first = c.pieces.map(ship).sort()[0]; const items = new Map(); for (const p of c.pieces) { const bc = batchColor(p); const g = norm(p.name) + "|" + norm(bc.base || ""); if (!items.has(g)) items.set(g, { key: g, name: p.name, base: bc.base || "", pieces: [] }); items.get(g).pieces.push(p); } c.items = [...items.values()].map((it) => Object.assign(it, { toPrint: it.pieces.filter((p) => !shelf.has(p.id)), first: it.pieces.map(ship).sort()[0] })).sort((a, b) => b.toPrint.length - a.toPrint.length || a.name.localeCompare(b.name)); return c; }).sort((a, b) => ((a.key === "~none") - (b.key === "~none")) || b.toPrint.length - a.toPrint.length || a.label.localeCompare(b.label));
  return list.map((c) => { const open = ui.openColors.includes(c.key); const due = shipLabel(c.first); const nShelf = c.pieces.length - c.toPrint.length;
    return `<details class="grp" data-cgroup="${esc(c.key)}" ${open ? "open" : ""}><summary style="grid-template-columns:minmax(160px,2fr) minmax(60px,.6fr) minmax(90px,1fr) 70px 150px"><span class="gname"><b>${esc(c.label)}</b><span class="sub">${plural(c.items.length, "item")}</span></span><span class="gnum"><b class="mono">${c.toPrint.length}</b>${nShelf ? `<span class="sub">+${nShelf} on shelf</span>` : ""}</span><span class="${due.tone}">${esc(due.text.replace(/^ships /, ""))}</span><span class="mono">${fmtHours(c.hours)}</span>${sel("pickColor", `data-color="${esc(c.key)}"`, c.toPrint, "Printer for all " + c.label + " pieces")}</summary>
      <div class="gpcs">${c.items.map((it) => { const ns = it.pieces.length - it.toPrint.length; return `<div class="gpc"><span><b>${esc(it.name)}</b>${it.base ? ` <span class="sub">+ ${esc(it.base)} base</span>` : ""} <span class="mono">×${it.toPrint.length}</span>${ns ? ` <span class="sub">+${ns} on shelf</span>` : ""} <span class="sub">${esc(shipLabel(it.first).text)}</span></span>${sel("pickColorItem", `data-color="${esc(c.key)}" data-group="${esc(it.key)}"`, it.toPrint, "Printer for " + it.name + " in " + c.label)}</div>`; }).join("")}</div></details>`; }).join("");
}
function viewStockForm(batchId) {
  const cov = coveredPieceIds(); const shelfIds = shelfPlan(cov).shelfIds; const open = openPieces(cov).sort((a, z) => (ORDER_BY_ID.get(a.orderId)?.shipBy || "").localeCompare(ORDER_BY_ID.get(z.orderId)?.shipBy || "") || a.name.localeCompare(z.name));
  return `<div class="sform"><div class="addh">From orders</div>${open.length ? `<div class="srow"><select data-act="addPieceSel" aria-label="Order piece to add" style="flex:1"><option value="">Choose a piece that still needs printing…</option>${open.map((p) => { const o = ORDER_BY_ID.get(p.orderId) || {}; return `<option value="${esc(p.id)}">${esc([p.name, p.size ? sizeLabel(p.size) : "", p.color].filter(Boolean).join(", "))} · ${esc(o.customer || "")} · ${esc(shipLabel(o.shipBy).text.replace(/^ships /, ""))}${shelfIds.has(p.id) ? " · on shelf" : ""}</option>`; }).join("")}</select><button type="button" class="pq-btn mini accent" data-act="addPiece" data-batch="${batchId}">Add</button></div>` : '<div class="sub">Every order piece is already queued or printed.</div>'}
    <div class="addh">For stock</div><form data-act="addStock" data-batch="${batchId}"><div class="srow"><label>Item<input name="item" list="dlItems" autocomplete="off" placeholder="e.g. Ghost Hide" required></label><label>Size<select name="size"><option>Small</option><option>Large</option><option>Sling Size</option><option value="">None</option></select></label><label>Color<input name="color" list="dlColors" autocomplete="off" placeholder="optional"></label><label class="q">Qty<input name="qty" type="number" min="1" max="50" value="1"></label></div>
    <div class="srow"><button type="submit" class="pq-btn mini accent">Add stock</button><button type="button" class="pq-btn ghost mini" data-act="toggleStockForm" data-batch="${batchId}">Done adding</button></div></form></div>`;
}
function viewReview(b) {
  const covered = coveredPieceIds({ ignoreTargetsOf: b.id }); const mine = new Set(b.items.map((i) => i.pieceId).filter(Boolean));
  return `<div class="review"><div class="rnote">Printed. Choose where each piece goes, then <b>Finalize job</b>.</div>${b.items.map((it) => {
    const dest = it.dest || (it.pieceId ? "piece:" + it.pieceId : "stock"); const takenByOthers = new Set(b.items.filter((x) => x !== it && x.dest?.startsWith("piece:")).map((x) => x.dest));
    const alternatives = openPieces(covered).filter((p) => !mine.has(p.id) && skuKey(p) === skuKey(it.spec) && !takenByOthers.has("piece:" + p.id)).sort((a, z) => ORDER_BY_ID.get(a.orderId).shipBy.localeCompare(ORDER_BY_ID.get(z.orderId).shipBy));
    const opts = [...(it.pieceId && PIECE_BY_ID.has(it.pieceId) ? [["piece:" + it.pieceId, `Its order: ${customerOf(it.pieceId)}`]] : []), ...alternatives.map((p) => { const o = ORDER_BY_ID.get(p.orderId); return ["piece:" + p.id, `${o.customer} · ${shipLabel(o.shipBy).text}`]; }), ["stock", "Add to stock"], ["fail", "Failed print"]];
    const here = locate(b.id)?.printer; const ro = it.reprintOn ?? String(here);
    const reprintSel = dest === "fail" ? `<select data-act="setReprint" data-batch="${b.id}" data-uid="${esc(it.uid)}" aria-label="Reprint ${esc(it.spec.name)}">${PRINTERS.map((p) => `<option value="${p}" ${String(p) === ro ? "selected" : ""}>Reprint on Printer ${p}${p === here ? " (this one)" : ""}</option>`).join("")}<option value="no" ${ro === "no" ? "selected" : ""}>Don't reprint</option></select>` : "";
    return `<div class="rrow ${dest === "fail" ? "rfail" : dest === "stock" ? "rstock" : ""}"><span>${it.pieceId ? "" : stockTag}${orderBtn(it.pieceId, pieceLabel(it.spec))}</span><span style="display:flex;gap:6px;flex-wrap:wrap"><select data-act="setDest" data-batch="${b.id}" data-uid="${esc(it.uid)}" aria-label="Where ${esc(it.spec.name)} goes">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === dest ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>${reprintSel}</span></div>`; }).join("")}</div>`;
}
function viewDoneItems(b) { return `<div class="bitems">${b.items.map((it) => { const o = it.outcome || {}; const label = o.to === "piece" ? "→ " + esc(customerOf(o.pieceId) || "order") : o.to === "stock" ? "→ stock" : o.to === "fail" ? (o.reprint ? `failed · reprint on Printer ${o.reprint.printer}` : "failed") : ""; const pick = o.to === "fail" && !o.reprint ? `<select data-act="reprintItem" data-batch="${b.id}" data-uid="${esc(it.uid)}" aria-label="Reprint ${esc(it.spec.name)}">${printerOptions(null, { blank: "Reprint on…" })}</select>` : ""; return `<div class="bi"><span>${orderBtn(o.to === "piece" ? o.pieceId : it.pieceId, pieceLabel(it.spec))}</span><span class="fin fin-${o.to || "none"}">${label}</span>${pick}</div>`; }).join("")}</div>`; }
function binFlag(b, it) { const pc = it.pieceId && PIECE_BY_ID.get(it.pieceId); if (!pc) return it.pieceId ? ' <span class="binflag">order no longer open</span>' : ""; const mine = LINE_BY_UID.get(pc.line)?.l.print_src === "plan"; if (b.state === B.QUEUED && pc.bin === "printing" && !mine) return ' <span class="binflag">printing in Bin View</span>'; if (b.state === B.PRINTING && pc.bin === "print" && mine) return ' <span class="binflag">Bin View says needs printing</span>'; return ""; }
function viewLiveItems(b) { return `<div class="bitems">${b.items.length ? "" : '<span class="sub">Empty. Add stock pieces below.</span>'}${b.items.map((it) => `<div class="bi"><span>${it.pieceId ? orderBtn(it.pieceId, `${pieceLabel(it.spec)} <span class="sub">· ${esc(customerOf(it.pieceId) || "order")}</span>`) : stockTag + pieceLabel(it.spec)}${binFlag(b, it)}</span><span><button type="button" data-act="dupItem" data-batch="${b.id}" data-uid="${esc(it.uid)}" title="Duplicate${it.pieceId ? " (the extra copy goes to stock)" : ""}" aria-label="Duplicate ${esc(it.spec.name)}">⧉</button><button type="button" data-act="removeItem" data-batch="${b.id}" data-uid="${esc(it.uid)}" title="${it.pieceId ? "Send back to Needs printing" : "Remove"}" aria-label="Remove ${esc(it.spec.name)}">✕</button></span></div>`).join("")}</div>`; }
function viewBatch(printer, slot, count) {
  const { batch: b, index, hours, start, end } = slot; const live = LIVE.has(b.state);
  const stateLabel = { queued: `#${index + 1} in line`, printing: "printing", review: "printed", done: "done" }[b.state];
  const when = b.state === B.DONE ? "finalized" : b.state === B.REVIEW ? "printed, waiting to finalize" : `${clock(start)} → ${clock(end)}`;
  const body = b.state === B.REVIEW ? viewReview(b) : b.state === B.DONE ? viewDoneItems(b) : viewLiveItems(b);
  const primary = { queued: `<button type="button" class="pq-btn mini" data-act="startBatch" data-batch="${b.id}">Start</button>`, printing: `<button type="button" class="pq-btn mini ghost" data-act="finishPrinting" data-batch="${b.id}">Done printing</button>`, review: `<button type="button" class="pq-btn ghost mini" data-act="backToPrinting" data-batch="${b.id}">Back to printing</button><button type="button" class="pq-btn mini accent" data-act="finalize" data-batch="${b.id}">Finalize job</button>`, done: `<button type="button" class="pq-btn mini ghost" data-act="reopen" data-batch="${b.id}">Reopen</button>` }[b.state];
  return `<div class="batch ${b.state}"><div class="bt"><input value="${esc(b.name)}" data-act="renameBatch" data-batch="${b.id}" aria-label="Batch name"><span class="state ${b.state}">${stateLabel}</span></div>
    <div class="when mono">${when} · ${fmtHours(hours)}${b.hoursOverride != null ? ' <span title="Typed-in time, estimate was ' + fmtHours(estimatedHours(b)) + '">edited</span>' : ""}</div>
    ${ui.editTimeFor === b.id ? `<form class="sform" data-act="setBatchHours" data-batch="${b.id}"><div class="srow"><label>Print time in hours (from your slicer)<input name="hours" type="number" min="0.25" max="200" step="0.25" value="${batchHours(b)}" required></label></div><div class="srow"><button type="submit" class="pq-btn mini accent">Save time</button>${b.hoursOverride != null ? `<button type="button" class="pq-btn ghost mini" data-act="useEstimate" data-batch="${b.id}">Use estimate (${fmtHours(estimatedHours(b))})</button>` : ""}<button type="button" class="pq-btn ghost mini" data-act="editTime" data-batch="${b.id}">Cancel</button></div></form>` : ""}
    ${body}${live && ui.stockFormFor === b.id ? viewStockForm(b.id) : ""}
    <div class="bctl"><button type="button" class="pq-btn ghost mini" data-act="moveBatch" data-batch="${b.id}" data-dir="-1" ${index === 0 || (b.state !== B.PRINTING && state.lanes[printer][index - 1]?.state === B.PRINTING) ? "disabled" : ""} aria-label="Move up">↑</button><button type="button" class="pq-btn ghost mini" data-act="moveBatch" data-batch="${b.id}" data-dir="1" ${index === count - 1 ? "disabled" : ""} aria-label="Move down">↓</button>${index < count - 1 ? `<button type="button" class="pq-btn ghost mini" data-act="stackBatch" data-batch="${b.id}" title="Combine with the batch below">Stack ↓</button>` : ""}<select data-act="sendBatch" data-batch="${b.id}" aria-label="Move batch to printer">${printerOptions(null, { blank: "Move to…", exclude: printer })}</select>${live ? `<button type="button" class="pq-btn ghost mini" data-act="toggleStockForm" data-batch="${b.id}">+ Add</button><button type="button" class="pq-btn ghost mini" data-act="editTime" data-batch="${b.id}">Edit time</button>` : ""}<span class="sp"></span>${primary}</div></div>`;
}
function viewQueues() { return PRINTERS.map((p) => { const slots = laneSchedule(p); const live = slots.filter((s) => LIVE.has(s.batch.state)); const hours = sum(live, (s) => s.hours); return `<section class="lane" data-lane="${p}" style="--pc:${printerColor(p)}"><div class="lhead"><h2>Printer ${p}</h2><span class="sub mono">${plural(slots.length, "batch", "batches")} · ${fmtHours(hours)}</span></div>${hours ? `<div class="bar">${live.map((s) => `<i style="flex:${s.hours}" title="${esc(s.batch.name)} · ${fmtHours(s.hours)}"></i>`).join("")}</div><div class="sub">Clear by <b class="mono">${clock(startMinutes() + Math.round(hours * 60))}</b></div>` : ""}${slots.length ? slots.map((s) => viewBatch(p, s, slots.length)).join("") : '<div class="empty">Nothing queued.</div>'}<button type="button" class="pq-btn ghost mini newstock" data-act="newStockBatch" data-printer="${p}">+ New stock batch</button></section>`; }).join(""); }
function viewBatchSuggestions(covered) {
  const list = batchSuggestions(covered); const next = list[0];
  const head = `<summary><span class="bsh"><b>Batch these</b>${next ? `<span class="sub">Print next: <b>${esc(next.name)}${next.size ? " · " + esc(next.size) : ""} ×${next.pieces.length}</b> · ${esc(shipLabel(next.firstShip).text.replace(/^ships /, ""))} · Printer ${next.printer}</span>` : '<span class="sub">nothing to batch</span>'}</span></summary>`;
  const thr = `Batch when needed at least <input type="number" min="2" max="20" value="${state.batchMin}" data-act="setBatchMin" aria-label="Batch threshold" style="width:4em;padding:2px 4px"> times.`;
  const body = list.length ? `<div class="bsnote sub">Items needed ${state.batchMin}+ times across open orders that aren't queued yet. Pieces the shelf can cover are left out. ${thr}</div><div class="bsgrid">${list.map((g) => `<div class="bscard"><div class="bstop"><b>${esc(g.name)}${g.size ? " · " + esc(g.size) : ""}</b><span class="mono">×${g.pieces.length}</span></div><div class="sub">${[...g.colors.values()].map((c) => `${esc(c.label)} ×${c.n}`).join(" · ")}</div><div class="sub">${plural(g.orders, "order")} · first ${esc(shipLabel(g.firstShip).text)} · ~${fmtHours(g.hours)}</div><div class="bsact"><select data-act="pickSuggestion" data-key="${esc(g.key)}" aria-label="Printer for this batch">${PRINTERS.map((p) => `<option value="${p}" ${p === g.printer ? "selected" : ""}>Printer ${p}${p === g.printer ? " (suggested)" : ""}</option>`).join("")}</select><button type="button" class="pq-btn mini accent" data-act="queueSuggestion" data-key="${esc(g.key)}" data-pieces="${esc(g.pieces.map((p) => p.id).join(","))}">Queue batch</button></div></div>`).join("")}</div>` : `<div class="bsnote sub">No item and size is needed ${state.batchMin}+ times outside the queues. ${thr}</div>`;
  return `<details class="bsug" data-batchbox ${ui.batchOpen ? "open" : ""}>${head}${body}</details>`;
}
function viewKpis(covered) {
  const k = summary(covered); const done = k.doneBy ? (daysFromToday(k.doneBy) === 0 ? "today" : daysFromToday(k.doneBy) === 1 ? "tomorrow" : new Date(k.doneBy + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })) : "—";
  return [["To print", k.toPrint, plural(k.orders, "open order")], ["Print time", Math.round(k.hours * 10) / 10 + " h", "~" + Math.round(k.perPrinter * 10) / 10 + " h per printer"], ["All done by", done, `${PRINTERS.length} printers, ${state.hoursPerDay} h/day`], ["Printing / printed", `${k.printing} / ${k.printed}`, (k.fromShelf ? k.fromShelf + " from shelf · " : "") + "from printer queues"]].map(([label, value, note]) => `<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`).join("");
}
function viewRestock(covered) {
  const rows = restockRows(covered); const need = rows.filter((r) => r.suggest > 0); const pend = Object.entries(state.pendingStock);
  const pendHtml = pend.length ? `<div class="pendbox"><b>Printed for stock, not in Inventory yet</b>${pend.map(([k, p]) => { const r = invRow(p.spec); return `<div class="pendrow"><span>${pieceLabel(p.spec)} <b class="mono">+${p.n}</b>${r ? ` <span class="sub">Inventory: ${r.in_stock} → ${Number(r.in_stock) + p.n}</span>` : ' <span class="sub">no matching Inventory row</span>'}</span><span>${r ? `<button type="button" class="pq-btn mini accent" data-act="addToInventory" data-key="${esc(k)}">Add to Inventory</button>` : ""} <button type="button" class="pq-btn mini ghost" data-act="dismissPending" data-key="${esc(k)}">Dismiss</button></span></div>`; }).join("")}</div>` : "";
  const head = `<div class="rhead"><span>Item &amp; color</span><span>Sold 7 d</span><span>Keep on hand</span><span>On shelf</span><span>Owed to orders</span><span>Queued for stock</span><span>Free</span><span>Suggest · Send to printer</span></div>`;
  const row = (r) => `<div class="rrowx${r.suggest ? "" : " covered"}"><span class="gname"><b>${esc(r.name)}</b><span class="sub">${esc(r.color || "no color listed")}${r.size ? " · " + esc(sizeLabel(r.size)) : ""}</span></span><span class="mono">${r.sold7 || "–"}</span><span><input type="number" min="0" max="99" value="${r.keep || ""}" placeholder="0" data-act="setKeep" data-group="${esc(r.key)}" aria-label="Keep on hand for ${esc(r.name)}"></span><span class="mono">${r.shelf}</span><span class="mono">${r.owed || "–"}</span><span class="mono">${r.queued || "–"}</span><span class="mono">${r.free}</span><span class="sendrow">${r.suggest ? `<b class="sugg mono" title="Target ${r.target} − ${r.free} free">+${r.suggest}</b>` : '<span class="sub">covered</span>'}<input type="number" min="1" max="50" value="${r.suggest || 1}" id="rq-${esc(r.key)}" aria-label="How many to print"><select data-act="restockAdd" data-group="${esc(r.key)}" aria-label="Send to printer">${printerOptions(null, { blank: "Printer…" })}</select></span></div>`;
  return pendHtml + (rows.length ? head + (need.length ? need.map(row).join("") : `<div class="empty">Nothing to restock right now with ${state.restockWeeks} week(s) of sales and your keep-on-hand numbers.</div>`) + `<details class="bsug"><summary>${plural(rows.length - need.length, "item")} covered</summary><div class="groups" style="padding:0 12px 12px">${rows.filter((r) => !r.suggest).map(row).join("")}</div></details>` : '<div class="empty">No tracked items yet.</div>');
}
function viewCommitBar(covered) { const picks = livePicks(covered); const by = {}; for (const [id, p] of picks) { (by[p] ||= { n: 0, h: 0 }); by[p].n++; by[p].h += PIECE_BY_ID.get(id).hours; } return { counts: picks.length ? PRINTERS.filter((p) => by[p]).map((p) => `<span class="pc" style="--pc:${printerColor(p)}">Printer ${p}: ${by[p].n} · ${fmtHours(by[p].h)}</span>`).join("") : '<span class="sub">No pieces assigned yet.</span>', n: picks.length }; }

/* ---------- render ---------- */
let host = null, pointerHeld = false, lastTouch = 0, bgTimer = null;
function shell() {
  return `<div class="top"><div><span class="tag">Live · Supabase</span><div class="sub">Assign each piece to a printer, commit, then stack and order the batches on each printer.</div></div>
    <nav class="views" aria-label="View">${[["needs", "Needs printing", "cNeeds"], ["byitem", "By item & color", "cGroups"], ["bycolor", "By color", "cColors"], ["queues", "Printer queues", "cQueued"], ["restock", "Restock", "cRestock"]].map(([v, l, c]) => `<button type="button" data-act="setView" data-view="${v}" aria-pressed="false">${l} <b id="${c}">0</b></button>`).join("")}<button type="button" class="pq-btn ghost mini" data-act="undo" id="undoBtn" disabled>↶ Undo</button></nav></div>
    <div id="pqErr" class="err"></div><div class="kpis" id="pqKpis"></div>
    <section id="vNeeds" hidden><div class="pqsearch"><label>Ships by <select data-act="due"><option value="all">Any time</option><option value="0">Today (and late)</option><option value="1">Tomorrow</option><option value="3">Next 3 days</option><option value="7">Next 7 days</option></select></label><label>Look ahead <input id="ahead" data-act="setAhead" type="number" min="1" max="60" style="width:4.5em;padding:4px"> days</label><label><input type="checkbox" data-act="hideShelf"> Hide shelf pieces</label><input type="search" data-act="search" placeholder="Search item, color, size, customer…" aria-label="Search pieces" autocomplete="off"></div><div id="gapNeeds"></div><div id="orders" class="orders"></div></section>
    <section id="vByItem" hidden><div class="pqsearch"><label>Ships by <select data-act="due"><option value="all">Any time</option><option value="0">Today (and late)</option><option value="1">Tomorrow</option><option value="3">Next 3 days</option><option value="7">Next 7 days</option></select></label><label><input type="checkbox" data-act="hideShelf"> Hide shelf pieces</label><input type="search" data-act="search" placeholder="Search item, color, size, customer…" aria-label="Search pieces" autocomplete="off"></div><div id="gapByItem"></div><div id="batchByItem"></div><div id="groups" class="groups"></div></section>
    <section id="vByColor" hidden><div class="pqsearch"><label>Ships by <select data-act="due"><option value="all">Any time</option><option value="0">Today (and late)</option><option value="1">Tomorrow</option><option value="3">Next 3 days</option><option value="7">Next 7 days</option></select></label><label><input type="checkbox" data-act="hideShelf"> Hide shelf pieces</label><input type="search" data-act="search" placeholder="Search color, item, customer…" aria-label="Search pieces" autocomplete="off"></div><div id="colors" class="groups"></div></section>
    <section id="vQueues" hidden><div class="settings"><label>Queue starts <input id="startAt" data-act="setStartAt" type="time" value="08:00"></label><label>Print hours per printer per day <input id="hpd" data-act="setHpd" type="number" min="1" max="24" style="width:4.5em"></label><span>Times assume each printer runs its stack back to back.</span></div><div id="batchQueues"></div><div id="lanes" class="lanes"></div></section>
    <section id="vRestock" hidden><div class="settings"><label>Keep enough on the shelf for <input id="weeks" data-act="setWeeks" type="number" min="0" max="8" step="0.5" style="width:4.5em"> week(s) of sales</label><span>or your keep-on-hand number, whichever is higher. Free = shelf left after open orders take theirs, plus stock already queued.</span></div><div id="restock" class="groups"></div></section>
    <div class="commit" id="commitBar" hidden><div class="pcounts" id="pcounts"></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label style="flex-direction:row;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font-size:.85rem">Commit into <select data-act="commitMode"><option value="new">new batches</option><option value="join">each printer’s last queued batch</option></select></label><button type="button" class="pq-btn ghost" data-act="clearPicks">Clear picks</button><button type="button" class="pq-btn accent" data-act="commitPicks" id="commitBtn">Commit to queues</button><button type="button" class="pq-btn ghost" data-act="commitGo">Commit & view queues</button></div></div>
    <datalist id="dlItems"></datalist><datalist id="dlColors"></datalist>`;
}
const setHTML = (el, html) => { if (!el || el.__html === html) return false; el.innerHTML = html; el.__html = html; return true; };
function bgRender() { clearTimeout(bgTimer); const a = document.activeElement; const choosing = a && host && host.contains(a) && (a.tagName === "SELECT" || a.tagName === "INPUT"); if (pointerHeld && Date.now() - lastTouch > 4000) pointerHeld = false; if (pointerHeld || Date.now() - lastTouch < (choosing ? 2500 : 900)) { bgTimer = setTimeout(bgRender, 500); return; } render(); }
function render() {
  if (!host) return;
  const q = (s) => host.querySelector(s);
  q("#pqErr").textContent = loadErr ? "⚠ Print plan didn't load: " + loadErr : saveErr ? "⚠ Print plan not saved: " + saveErr : store.errs.plan || "";
  const covered = coveredPieceIds(); const view = ui.view;
  host.querySelectorAll("[data-act=hideShelf]").forEach((c) => (c.checked = !!ui.hideShelf)); host.querySelectorAll("[data-act=due]").forEach((c) => (c.value = ui.due || "all")); host.querySelectorAll("[data-act=commitMode]").forEach((c) => (c.value = ui.commitMode || "new"));
  host.querySelectorAll("[data-act=search]").forEach((s) => { if (document.activeElement !== s && s.value !== (ui.q || "")) s.value = ui.q || ""; });
  host.querySelectorAll("[data-act=setView]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  const SECTIONS = { needs: "#vNeeds", byitem: "#vByItem", bycolor: "#vByColor", queues: "#vQueues", restock: "#vRestock" }; for (const [v, sel] of Object.entries(SECTIONS)) q(sel).hidden = v !== view;
  q("#cNeeds").textContent = openPieces(covered).length; q("#cGroups").textContent = new Set(openPieces(covered).map(groupKey)).size; q("#cColors").textContent = new Set(openPieces(covered).map(colorKey)).size; q("#cQueued").textContent = sum(allBatches(), ({ batch }) => batch.items.length); q("#cRestock").textContent = restockRows(covered).filter((r) => r.suggest > 0).length;
  const BODIES = { needs: "#orders", byitem: "#groups", bycolor: "#colors", queues: "#lanes", restock: "#restock" }; for (const [v, sel] of Object.entries(BODIES)) if (v !== view) setHTML(q(sel), "");
  setHTML(q("#gapNeeds"), view === "needs" ? viewGapBanner(covered) : ""); setHTML(q("#gapByItem"), view === "byitem" ? viewGapBanner(covered) : "");
  if (view === "needs") { if (document.activeElement !== q("#ahead")) q("#ahead").value = ui.ahead; setHTML(q("#orders"), viewNeeds(covered)); }
  if (view === "byitem") setHTML(q("#groups"), viewByItem(covered));
  if (view === "bycolor") setHTML(q("#colors"), viewByColor(covered));
  if (view === "queues") { if (document.activeElement !== q("#startAt")) q("#startAt").value = ui.startAt; if (document.activeElement !== q("#hpd")) q("#hpd").value = state.hoursPerDay; setHTML(q("#lanes"), viewQueues()); }
  if (view === "restock") { if (document.activeElement !== q("#weeks")) q("#weeks").value = state.restockWeeks; setHTML(q("#restock"), viewRestock(covered)); }
  setHTML(q("#pqKpis"), viewKpis(covered));
  const sugg = view === "byitem" || view === "queues" ? viewBatchSuggestions(covered) : ""; setHTML(q("#batchByItem"), view === "byitem" ? sugg : ""); setHTML(q("#batchQueues"), view === "queues" ? sugg : "");
  const ub = q("#undoBtn"); const last = history[history.length - 1]; ub.disabled = !last; ub.title = last ? "Undo " + last.label : "Nothing to undo";
  const bar = viewCommitBar(covered); q("#commitBar").hidden = !(view === "needs" || view === "byitem" || view === "bycolor"); setHTML(q("#pcounts"), bar.counts); q("#commitBtn").classList.toggle("dim", !bar.n); q("#commitBtn").textContent = bar.n ? `Commit ${plural(bar.n, "piece")} to queues` : "Commit to queues";
  q("#dlItems").innerHTML = CATALOG_ITEMS.map((n) => `<option value="${esc(n)}">`).join(""); q("#dlColors").innerHTML = CATALOG_COLORS.map((n) => `<option value="${esc(n)}">`).join("");
}
function refresh() { if (!host) return; rebuildCatalog(); SALES = sold7(); if (loaded) binCleanup(); bgRender(); }

/* ---------- events ---------- */
const uiSet = (fn) => { fn(); persistUi(); render(); };
const CLICK = { showOrder: (d) => showOrder(d.piece),
  setView: (d) => uiSet(() => { ui.view = d.view; }),
  sortBy: (d) => uiSet(() => { const col = GROUP_COLUMNS.find((c) => c.key === d.key); const first = col.asc ? 1 : -1; const s = ui.sort; ui.sort = s?.key !== d.key ? { key: d.key, dir: first } : s.dir === first ? { key: d.key, dir: -first } : null; }),
  gapGo: (d) => { ui.view = "byitem"; if (!ui.openGroups.includes(d.key)) ui.openGroups.push(d.key); ui.q = ""; ui.due = "all"; persistUi(); render(); const el = host.querySelector(`details[data-group="${CSS.escape(d.key)}"]`); if (el) { el.open = true; el.scrollIntoView({ block: "center", behavior: "smooth" }); } },
  gapMore: () => uiSet(() => { ui.gapAll = !ui.gapAll; }),
  commitPicks: () => { const picks = livePicks(); if (!picks.length) { toast("Pick a printer for at least one piece first"); return; } dispatch("commitPicks", picks); ui.picks = {}; persistUi(); render(); },
  commitGo: () => { const picks = livePicks(); if (!picks.length) { toast("Pick a printer for at least one piece first"); return; } dispatch("commitPicks", picks); ui.picks = {}; ui.view = "queues"; persistUi(); render(); },
  clearPicks: () => uiSet(() => { ui.picks = {}; }),
  undo: () => undo(),
  unprint: async (d, el) => { el.disabled = true; const L = LINE_BY_UID.get(d.line); try { await db.setLineState([{ uid: d.line, print_state: "print", print_src: "bin" }]); } catch (e) { toast("⚠ " + db.errText(e), true); } if (L) await reloadOrder(L.o.id); },
  addPiece: (d, el) => { const s = el.closest(".sform")?.querySelector("[data-act=addPieceSel]"); if (!s || !s.value) { toast("Choose a piece first"); return; } dispatch("addPiece", d.batch, s.value); },
  dupItem: (d) => dispatch("dupItem", d.batch, d.uid),
  addToInventory: (d) => addToInventory(d.key),
  dismissPending: (d) => dispatch("dismissPending", d.key),
  queueSuggestion: (d, el) => { const sel = el.closest(".bscard").querySelector("[data-act=pickSuggestion]"); dispatch("queueSuggestion", d.key, sel.value, d.pieces.split(",")); },
  editTime: (d) => uiSet(() => { ui.editTimeFor = ui.editTimeFor === d.batch ? null : d.batch; }),
  useEstimate: (d) => dispatch("setBatchHours", d.batch, null),
  moveBatch: (d) => dispatch("moveBatch", d.batch, Number(d.dir)), stackBatch: (d) => dispatch("stackBatch", d.batch), startBatch: (d) => dispatch("startBatch", d.batch), finishPrinting: (d) => dispatch("finishPrinting", d.batch), backToPrinting: (d) => dispatch("backToPrinting", d.batch), finalize: (d) => dispatch("finalize", d.batch), reopen: (d) => dispatch("reopen", d.batch), removeItem: (d) => dispatch("removeItem", d.batch, d.uid), newStockBatch: (d) => dispatch("newStockBatch", Number(d.printer)),
  toggleStockForm: (d) => uiSet(() => { ui.stockFormFor = ui.stockFormFor === d.batch ? null : d.batch; }),
};
const pickMany = (ids, printer) => { for (const id of ids) { if (printer) ui.picks[id] = Number(printer); else delete ui.picks[id]; } persistUi(); render(); };
const CHANGE = {
  commitMode: (d, el) => { ui.commitMode = el.value; persistUi(); }, due: (d, el) => uiSet(() => { ui.due = el.value; }), hideShelf: (d, el) => uiSet(() => { ui.hideShelf = el.checked; }),
  pick: (d, el) => pickMany([d.piece], el.value),
  pickOrder: (d, el) => { const c = coveredPieceIds(); const sh = shelfPlan(c).shelfIds; pickMany(ORDER_BY_ID.get(d.order).pieces.filter((p) => !c.has(p.id) && !sh.has(p.id)).map((p) => p.id), el.value); },
  pickColor: (d, el) => { const c = coveredPieceIds(); const sh = shelfPlan(c).shelfIds; pickMany(colorPieces(c).filter((p) => colorKey(p) === d.color && !sh.has(p.id)).map((p) => p.id), el.value); },
  pickColorItem: (d, el) => { const c = coveredPieceIds(); const sh = shelfPlan(c).shelfIds; pickMany(colorPieces(c).filter((p) => colorKey(p) === d.color && (norm(p.name) + "|" + norm(batchColor(p).base || "")) === d.group && !sh.has(p.id)).map((p) => p.id), el.value); },
  pickGroup: (d, el) => { const c = coveredPieceIds(); const sh = shelfPlan(c).shelfIds; pickMany(openPieces(c).filter((p) => groupKey(p) === d.group && !sh.has(p.id)).map((p) => p.id), el.value); },
  sendBatch: (d, el) => dispatch("sendBatch", d.batch, el.value), setDest: (d, el) => dispatch("setDest", d.batch, d.uid, el.value), setReprint: (d, el) => dispatch("setReprint", d.batch, d.uid, el.value), reprintItem: (d, el) => dispatch("reprintItem", d.batch, d.uid, el.value),
  renameBatch: (d, el) => { actions.renameBatch(d.batch, el.value); pending.push({ name: "renameBatch", args: [d.batch, el.value] }); persist(); },
  setAhead: (d, el) => uiSet(() => { ui.ahead = clamp(Number(el.value) || 3, 1, 60); }), setStartAt: (d, el) => uiSet(() => { ui.startAt = el.value || "08:00"; }),
  setWeeks: (d, el) => dispatch("setWeeks", el.value), setHpd: (d, el) => dispatch("setHpd", el.value), setBatchMin: (d, el) => dispatch("setBatchMin", el.value), pickSuggestion: () => {},
  setKeep: (d, el) => dispatch("setKeep", d.group, el.value),
  restockAdd: (d, el) => { const q = host.querySelector("#rq-" + CSS.escape(d.group))?.value; dispatch("restockAdd", d.group, q, el.value); el.value = ""; },
};
/* ---------- Bin View → "Add to print queue": the open pieces of these lines go on a printer ---------- */
export const laneSummary = () => PRINTERS.map((p) => ({ printer: p, queued: sum(state.lanes[p].filter((b) => b.state === B.QUEUED), (b) => b.items.length), printing: state.lanes[p].some((b) => b.state === B.PRINTING) }));
export function queueLines(lineUids, printer, start, extra = 0) {
  if (!loaded) throw new Error("The print plan hasn't loaded yet");
  printer = Number(printer); if (!PRINTERS.includes(printer)) throw new Error("Pick a printer");
  const covered = coveredPieceIds(); const ids = [...PIECE_BY_ID.values()].filter((p) => lineUids.includes(p.line) && !covered.has(p.id) && !p.onShelf).map((p) => p.id);
  extra = clamp(Math.round(Number(extra) || 0), 0, 50);
  if (!ids.length && !extra) throw new Error("Nothing left to print on these lines (already queued or on the shelf)");
  const spec = specOf(PIECE_BY_ID.get(ids[0] || [...PIECE_BY_ID.values()].find((p) => lineUids.includes(p.line))?.id) || {});
  if (!spec.name) throw new Error("Nothing to print on these lines");
  dispatch("queueFromBin", ids, printer, !!start, extra, spec);
  return ids.length + extra;
}
// unsaved plan changes in this tab (a reload would lose them)
export const planPending = () => pending.length > 0 || saving;
export function showQueues() { ui.view = "queues"; persistUi(); render(); }

export function init() {
  host = document.getElementById("pqHost"); if (!host) return; host.innerHTML = shell();
  host.addEventListener("pointerdown", () => { pointerHeld = true; lastTouch = Date.now(); }, true);
  document.addEventListener("pointerup", () => { pointerHeld = false; lastTouch = Date.now(); }, true);
  host.addEventListener("focusin", () => { lastTouch = Date.now(); }, true); host.addEventListener("keydown", () => { lastTouch = Date.now(); }, true);
  host.addEventListener("click", (e) => { const el = e.target.closest("[data-act]"); if (!el || ["SELECT", "INPUT", "FORM"].includes(el.tagName)) { if (e.target.closest("summary select")) e.preventDefault(); return; } const fn = CLICK[el.dataset.act]; if (!fn) return; try { const r = fn(el.dataset, el); if (r && r.catch) r.catch((err) => toast("Something went wrong: " + db.errText(err), true)); } catch (err) { console.error(err); toast("Something went wrong: " + (err.message || err), true); } });
  host.addEventListener("click", (e) => { if (e.target.closest("summary select")) e.preventDefault(); }, true);
  host.addEventListener("change", (e) => { pointerHeld = false; const el = e.target.closest("[data-act]"); if (el && CHANGE[el.dataset.act]) { try { CHANGE[el.dataset.act](el.dataset, el); } catch (err) { console.error(err); toast("Something went wrong: " + (err.message || err), true); } } });
  host.addEventListener("input", (e) => { const el = e.target.closest("[data-act=search]"); if (!el) return; ui.q = el.value; persistUi(); render(); });
  host.addEventListener("submit", (e) => { const tf = e.target.closest("form[data-act=setBatchHours]"); if (tf) { e.preventDefault(); dispatch("setBatchHours", tf.dataset.batch, new FormData(tf).get("hours")); return; } const form = e.target.closest("form[data-act=addStock]"); if (!form) return; e.preventDefault(); const fd = new FormData(form); const name = String(fd.get("item") || "").trim(); if (!name) return; dispatch("addStock", form.dataset.batch, { name, size: String(fd.get("size") || ""), color: String(fd.get("color") || "").trim(), inv: null, custom: false }, fd.get("qty")); });
  host.addEventListener("toggle", (e) => { const d = e.target; if (d.matches?.("details[data-batchbox]")) { ui.batchOpen = d.open; persistUi(); } if (d.matches?.("details[data-group]")) { ui.openGroups = ui.openGroups.filter((k) => k !== d.dataset.group); if (d.open) ui.openGroups.push(d.dataset.group); persistUi(); } if (d.matches?.("details[data-cgroup]")) { ui.openColors = ui.openColors.filter((k) => k !== d.dataset.cgroup); if (d.open) ui.openColors.push(d.dataset.cgroup); persistUi(); } }, true);
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !e.target.closest("input,select,textarea") && !document.getElementById("tab-print").hidden) { e.preventDefault(); undo(); } });
  onChange(refresh);
  loadPlan(true);
  render();
}
