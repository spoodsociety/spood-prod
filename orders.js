// Orders: shared store (orders + inventory), line rules, Bin View, order form, customers.
import * as db from "./supabase.js";

/* ===================== helpers ===================== */
export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const plural = (n, w, m = w + "s") => `${n} ${n === 1 ? w : m}`;
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDay(d); };
export const NO_DATE = "9999-12-31";
export const dayLabel = (iso) => { if (!iso || iso === NO_DATE) return "no date"; const t = isoDay(); if (iso === t) return "today"; if (iso === addDays(t, 1)) return "tomorrow"; return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); };
export const fmtDay = (iso) => (!iso || iso === NO_DATE ? "no date" : new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }));
export const fmtWhen = (ts) => { if (!ts) return ""; const d = new Date(ts); return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
export const cleanText = (t) => String(t || "").replace(/^[\s•·\-–—*]+/, "").replace(/\s+/g, " ").trim();
export const normName = (s) => String(s || "").toLowerCase().replace(/\s*\*+\s*$/, "").replace(/\s+/g, " ").trim();
export const toks = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9+]+/g, " ").trim().split(" ").filter(Boolean);

let toastT = 0;
export function toast(msg, bad = false) { const t = $("#toast"); if (!t) return; t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, Math.min(10000, Math.max(bad ? 6000 : 2400, String(msg).length * 60))); }

// guard: called before an Escape or backdrop close; return false to keep the dialog open (unsaved edits)
export function modal(html, { label = "Dialog", wide = false, guard = null } = {}) {
  const d = document.createElement("div"); d.className = "obmodal"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", label);
  d.innerHTML = `<div class="obmodal-card${wide ? " wide" : ""}">${html}</div>`;
  const close = () => { d.remove(); document.removeEventListener("keydown", key); };
  const soft = async () => { if (!guard || (await guard()) !== false) close(); };
  const key = (e) => { if (e.key === "Escape" && d === $("#modalHost").lastElementChild) soft(); };
  d.addEventListener("click", (e) => { if (e.target === d) soft(); });
  document.addEventListener("keydown", key); $("#modalHost").appendChild(d);
  return { el: d, close };
}
export function confirmBox({ title, body, ok = "OK", danger = false }) {
  return new Promise((res) => {
    const m = modal(`<h3>${esc(title)}</h3><p>${body}</p><div class="row"><button type="button" class="btn ghost" data-no>Cancel</button><button type="button" class="btn${danger ? "" : " accent"}" data-yes>${esc(ok)}</button></div>`, { label: title });
    m.el.querySelector("[data-no]").onclick = () => { m.close(); res(false); };
    m.el.querySelector("[data-yes]").onclick = () => { m.close(); res(true); };
    m.el.querySelector("[data-no]").focus();
  });
}

/* ===================== store ===================== */
export const store = { orders: [], open: [], inv: [], invById: new Map(), sources: [], loadedAt: null, doneAt: null, err: "", errs: {}, listeners: new Set(), busy: new Set() };
export const onChange = (fn) => { store.listeners.add(fn); return () => store.listeners.delete(fn); };
// a screen that fails to draw must say so, not freeze on stale content
export function emit() { for (const fn of store.listeners) { try { fn(); } catch (e) { console.error(e); toast("⚠ A screen couldn't update: " + ((e && e.message) || e) + " — reload the page", true); } } }
export const setErr = (key, msg) => { if (msg) store.errs[key] = msg; else delete store.errs[key]; };

// Open orders are small and change all day: every refresh reads them. Done orders are the bulk (hundreds, growing) and only change
// through this app, so they are read once in the background, then only on demand (Done list, Refresh); marking Done / Undo updates one order.
let loadSeq = 0;
export async function load({ done = false } = {}) {
  const started = Date.now(); const seq = ++loadSeq;
  try {
    const [open, doneRows, inv, opts, srcs] = await Promise.all([db.readOrders("open"), done ? db.readOrders("done") : null, db.inventoryRows(), cat.opts && !cat.stale ? null : db.catalogOptions(), db.unlinkedSources().catch((e) => { console.error(e); return null; })]);
    // something was saved (or a newer read started) while this read was in flight: this copy is already behind what the screen shows
    if (seq !== loadSeq) return;
    if (db.lastWriteAt() > started) { return load({ done }); }
    if (opts) indexCatalog(opts);
    const openList = Array.isArray(open) ? open : []; const openIds = new Set(openList.map((o) => o.id));
    const doneList = (Array.isArray(doneRows) ? doneRows : store.orders.filter((o) => o.status === "Done")).filter((o) => !openIds.has(o.id));
    if (Array.isArray(doneRows)) store.doneAt = new Date();
    store.orders = [...openList, ...doneList];
    store.inv = Array.isArray(inv) ? inv : [];
    if (Array.isArray(srcs)) store.sources = srcs;
    store.invById = new Map(store.inv.map((r) => [r.id, r]));
    store.loadedAt = new Date(); store.err = "";
    recompute();
  } catch (e) { store.err = db.errText(e); }
  emit();
}
export async function reloadOrder(id) {
  const started = Date.now();
  try { const o = await db.readOrder(id); if (db.lastWriteAt() > started) return reloadOrder(id); const i = store.orders.findIndex((x) => x.id === id); if (o) { if (i >= 0) store.orders[i] = o; else store.orders.push(o); } else if (i >= 0) store.orders.splice(i, 1); recompute(); }
  catch (e) { store.err = db.errText(e); }
  emit();
}
export async function reloadInventory() { const started = Date.now(); try { const [inv, opts] = await Promise.all([db.inventoryRows(), db.catalogOptions()]); if (db.lastWriteAt() > started) return reloadInventory(); indexCatalog(opts); store.inv = Array.isArray(inv) ? inv : []; store.invById = new Map(store.inv.map((r) => [r.id, r])); recompute(); } catch (e) { store.err = db.errText(e); } emit(); }

/* ===================== order & line rules ===================== */
export const isExpress = (o) => /express/i.test(o.ship_type || "");
export const shipBy = (o) => o.ship_by || NO_DATE;
// Who gets a piece: soonest ship date first; express first on the same day; then the order the server lists them in (created first).
export function rank(a, b) { return shipBy(a).localeCompare(shipBy(b)) || (isExpress(b) ? 1 : 0) - (isExpress(a) ? 1 : 0) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id); }
export const OB_PICK = ["Not started", "Ready to Pack", "Packing", "Done"];
export const obPick = (st) => { st = String(st || "").replace(/\*/g, ""); return OB_PICK.includes(st) ? st : st === "Ready to Ship" ? "Packing" : st === "Printing" ? "Not started" : "Not started"; };
export const NSTAT = { "Not started": "gray", "Ready to Pack": "blue", Packing: "yellow", Done: "green" };
export const NPLAT = { Etsy: "orange", Shopify: "green", TikTok: "pink", "TikTok - LIVE": "pink", "In person": "brown" };
export const platColor = (p) => NPLAT[p] || (/tiktok/i.test(p) ? "pink" : /etsy/i.test(p) ? "orange" : /shopify/i.test(p) ? "green" : "gray");

export const isEncText = (t) => /complete enclosure|^\W*(?:\d+\s+|two\s+|three\s+)?enclosures?\b/i.test(cleanText(t)) && !/floor|insert|climb|hide|ledge|background|wrap|magnetic/i.test(t);
const NOT_PRINTED = /starter\s*kit|c[ao]+c+o+n|\bplants?\b|substrate|moss|mystery|magnetic background|figurine|add[- ]?on\b(?!.*\b(hide|ledge|climb|floor|insert|cauldron|bowl|feeder)\b)/i;
export function lineKind(l) {
  if (l.kind === "enc" || l.kind === "stock" || l.kind === "print") return l.kind; // the server decides (hq.line_kind); the text rules below are the fallback
  const t = cleanText(l.text);
  if (encVar(l) || isEncText(t)) return "enc";
  if (l.match === "untracked") return "stock";
  if (NOT_PRINTED.test(t) && !/\b(hide|ledge|climb|floor|insert|cauldron|bowl|feeder)\b/i.test(t.replace(/starter\s*kit/i, ""))) return "stock";
  return "print";
}
// a custom-size line's measurements, as entered: "5.9 × 9.84 in", "fits 4.7 × 4.7 in"
const numStr = (n) => String(Number(n)).replace(/\.0+$/, "");
export const fmtSize = (l) => { const ns = [l.size_1, l.size_2, l.size_3].filter((n) => n != null && n !== "").map(numStr); return ns.length ? `${l.size_basis === "enclosure" ? "fits " : ""}${ns.join(" × ")} ${l.size_unit || "in"}` : ""; };
export const SIZE_FIELDS = ["size_1", "size_2", "size_3", "size_unit", "size_basis"];
export const isCustom = (t) => /custom|\d+(\.\d+)?\s*(cm|mm|in\b|inch|"|”|″)|\d\s*[x×]\s*\d/i.test(String(t || ""));
export const invRowOf = (l) => (l.notion_inventory_id ? store.invById.get(l.notion_inventory_id) : null) || null;
// the enclosure variant a line is linked to, from its catalog sku: enclosure-small, enclosure-large, enclosure-small-magnetic
export const encVar = (l) => { const m = String(l.sku || "").match(/^enclosure-(small|large)(?:-(\w+))?$/i); return m ? { size: m[1].toLowerCase(), opt: (m[2] || "").toLowerCase() } : null; };

// Inventory item names: "Gothic - Web Climb (Small, Black)" -> base, size, color
export const SIZES = ["Small", "Large", "Sling Size", "Standard", "Custom", "Default Size"];
// `size` is the catalog's size for that item (inventory_rows.size), so a size outside the usual list ("Mini") is still read as a size.
export function splitName(name, size) {
  const m = String(name || "").match(/^(.*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/);
  if (!m) return { base: String(name || "").trim(), size: "", color: "" };
  const parts = m[2].split(/,\s*(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
  const known = size ? [...SIZES, size] : SIZES;
  const sizes = parts.filter((p) => known.some((s) => s.toLowerCase() === p.toLowerCase()));
  const colors = parts.filter((p) => !sizes.includes(p));
  return { base: m[1].trim(), size: sizes[0] || "", color: colors.join(" + ") };
}
export const sizeLabel = (s) => (!s || /^(standard|default size)$/i.test(s) ? "Small" : s === "Sling Size" ? "Sling" : s);

// spec from a line: inventory row name when matched, else the line text itself
export function lineSpec(l) {
  const r = invRowOf(l);
  if (r) { const sp = splitName(r.item, r.size); return { name: sp.base, size: sp.size, color: sp.color, inv: r.id, custom: /^custom$/i.test(sp.size) }; }
  const t = cleanText(l.text).replace(/^\d{1,2}\s*[x×]?\s+(?=[a-z])/i, "");
  const parts = /\s[-–]\s/.test(t) ? t.split(/\s[-–]\s/) : t.split(/\s*,\s*/);
  const name = parts.shift().replace(/\(.*?\)/g, "").trim(); const det = parts.join(", ");
  const sz = (det.match(/sling(?:\s*size)?|small|large|standard/i) || [""])[0];
  const color = det.replace(/sling(?:\s*size)?|small|large|standard|custom/ig, "").replace(/^[,\s]+|[,\s]+$/g, "").replace(/,\s*,/g, ",").trim();
  return { name, size: sz ? (sz.toLowerCase().startsWith("sling") ? "Sling Size" : sz[0].toUpperCase() + sz.slice(1).toLowerCase()) : (isCustom(t) ? "Custom" : ""), color, inv: null, custom: isCustom(t) };
}

/* Shelf allocation comes from the server (hq.shelf_alloc, inside read_orders / inventory_rows): every tab sees the same answer and
   Mark Done takes stock by the same rule. The browser only reads it. */
export const alloc = new Map(); // uid -> qty from shelf
export const owed = new Map();  // inv id -> pieces open orders need from it
export function recompute() {
  store.open = store.orders.filter((o) => o.status !== "Done").sort(rank);
  alloc.clear(); owed.clear();
  for (const o of store.open) for (const l of o.lines || []) if (Number(l.alloc) > 0) alloc.set(l.uid, Number(l.alloc));
  for (const r of store.inv) if (Number(r.owed) > 0) owed.set(r.id, Number(r.owed));
}
export const free = (invId) => { const r = store.invById.get(invId); return r && r.in_stock != null ? Math.max(0, (Number(r.in_stock) || 0) - (owed.get(invId) || 0)) : null; };

/* Effective state of a line, as Bin View shows it */
export function eff(l) {
  const kind = lineKind(l);
  if (l.packed) return { st: "packed", from: l.packed_from || "print", kind };
  const a = alloc.get(l.uid) || 0; const qty = Number(l.qty) || 1;
  if (kind === "print") {
    const ps = l.print_state || "";
    if (ps === "printing" || ps === "printed") return { st: ps, kind };
    if (ps === "print" || ps === "nostock") return { st: "print", kind, forced: ps === "nostock" };
    if (a >= qty) return { st: "shelf", kind, a };
    if (a > 0) return { st: "print", kind, a, part: true };
    return { st: "print", kind };
  }
  // enclosure headings and stock items
  const r = invRowOf(l);
  if (!r) return { st: kind === "enc" ? "head" : "none", kind };
  if (r.in_stock == null) return { st: kind === "enc" ? "head" : "none", kind };
  if (a >= qty) return { st: "shelf", kind, a };
  return { st: "out", kind, a };
}
export const canPack = (l) => { const e = eff(l); return e.st === "packed" || e.st === "shelf" || e.st === "printed" || e.kind !== "print" || e.st === "out"; };
export const unpacked = (o) => (o.lines || []).filter((l) => !l.packed).length;
// stock that comes off the shelf when this order is marked Done
export function movesFor(o) {
  const out = new Map();
  for (const l of o.lines || []) { const r = invRowOf(l); if (!r || r.in_stock == null) continue; const e = eff(l); const n = e.st === "shelf" ? (Number(l.qty) || 1) : e.st === "packed" && e.from === "shelf" ? (Number(l.qty) || 1) : e.st === "out" && e.a > 0 ? e.a : e.part ? e.a : 0; if (n > 0) out.set(r.id, (out.get(r.id) || 0) + n); }
  return [...out.entries()].map(([notion_id, qty]) => ({ notion_id, qty }));
}

/* ===================== writes with per-item error handling ===================== */
export async function act(key, fn, { reload = null } = {}) {
  if (store.busy.has(key)) return false;
  store.busy.add(key); setErr(key, ""); emit();
  try { await fn(); setErr(key, ""); return true; }
  catch (e) { const t = db.errText(e); setErr(key, t); console.error(e); return false; }
  finally { store.busy.delete(key); if (reload) await reloadOrder(reload); else emit(); }
}
export const setLine = (orderId, uid, patch) => act("l:" + uid, () => db.setLineState([{ uid, ...patch }]), { reload: orderId });
export const setLines = (orderId, lines) => act("o:" + orderId, () => db.setLineState(lines), { reload: orderId });

export async function setStatus(o, status) {
  const key = "o:" + o.id;
  if (status === "Done") {
    const left = unpacked(o); if (left) { setErr(key, `Pack all items first: ${plural(left, "item")} not ticked packed`); emit(); return false; }
    const mv = movesFor(o);
    const what = mv.length ? `<br><br>Comes off the shelf: ${mv.map((m) => `${m.qty} × ${esc((store.invById.get(m.notion_id) || {}).item || m.notion_id)}`).join(", ")}.` : "<br><br>Nothing comes off the shelf (every piece was printed fresh).";
    const ok = await confirmBox({ title: "Mark order Done?", body: `${esc(o.customer)} will be marked <b>Done</b> (shipped) and leave the board.${what}`, ok: "Yes, mark Done" });
    if (!ok) { emit(); return false; }
    let short = [];
    const done = await act(key, async () => { const r = await db.saveWithRetry(o.id, (p) => ({ ...p, status: "Done" }), { done: true, moves: mv }); short = (r && Array.isArray(r.short)) ? r.short : []; recentDone.unshift({ id: o.id, customer: o.customer, prev: obPick(o.status), at: Date.now(), epoch: r && r.epoch }); }, { reload: o.id });
    // the server takes only what the shelf has (a count never goes below zero); anything it couldn't take is a count that was already wrong
    if (done && short.length) toast(`${o.customer} → Done. Shelf was already short, not taken: ${short.map((s) => `${s.wanted - s.taken} × ${s.item}`).join(", ")}. Recount those.`, true);
    else if (done) toast(`${o.customer} → Done${mv.length ? ". Took " + plural(mv.reduce((a, m) => a + m.qty, 0), "piece") + " off the shelf" : ""}`);
    await reloadInventory();
    return done;
  }
  const ok = await act(key, () => db.saveWithRetry(o.id, (p) => ({ ...p, status })), { reload: o.id });
  if (ok) toast(`${o.customer} → ${status}`);
  return ok;
}
export const recentDone = [];
export async function undoDone(id) {
  const q = recentDone.find((x) => x.id === id); const o = store.orders.find((x) => x.id === id);
  const prev = (q && q.prev) || (o && o.done_prev); const status = prev && obPick(prev) !== "Done" ? obPick(prev) : "Not started";
  const ok = await act("o:" + id, () => db.saveWithRetry(id, (p) => ({ ...p, status }), { undo: true }), { reload: id });
  if (ok) { const i = recentDone.findIndex((x) => x.id === id); if (i >= 0) recentDone.splice(i, 1); toast(((q && q.customer) || (o && o.customer) || "Order") + " is back on the board. Shelf pieces were put back"); await reloadInventory(); }
  else toast("Undo didn't save: " + (store.errs["o:" + id] || ""), true);
  return ok;
}

/* ===================== Bin View ===================== */
const BIN = { days: [], open: null, stOpen: null, layout: "cols", pinned: {}, mode: "open", doneOpen: new Set(), doneLimit: 40 };
// the background refresh waits while a person is in the middle of something: a menu is open, a field has focus, or they touched the page in the last few seconds
let lastTouch = 0;
document.addEventListener("pointerdown", () => { lastTouch = Date.now(); }, true);
document.addEventListener("keydown", () => { lastTouch = Date.now(); }, true);
export const uiBusy = () => { const a = document.activeElement; return !!(BIN.open || BIN.stOpen || F.form || document.querySelector(".obmodal") || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox") || Date.now() - lastTouch < 4000); };
try { BIN.layout = localStorage.getItem("spood.bin.layout") || "cols"; } catch (e) {}
const SV = (d, cls) => `<span class="bvicon ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
const IC = { run: '<path d="M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z"/><path d="M12 7v5l3 2"/>', done: '<path d="M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>', shelf: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/>', out: '<path d="M20 11a8 8 0 0 0-14.9-4"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 4"/><path d="M20 20v-4h-4"/>', shelfunit: '<path d="M4 3v18"/><path d="M20 3v18"/><path d="M4 9h16"/><path d="M4 15h16"/><path d="M4 21h16"/>',
  tag: '<path d="M3 12V3h9l9 9-9 9z"/><path d="M7.5 7.5h.01"/><path d="M13 12h5M15.5 9.5v5"/>', gift: '<rect x="3" y="8" width="18" height="5"/><path d="M5 13v8h14v-8"/><path d="M12 8v13"/><path d="M12 8c-2-4-6-4-6-1s6 1 6 1c2-4 6-4 6-1s-6 1-6 1"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.2 9.5l6.1-.9z"/>', crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>' };
const SVF = (d) => `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// Repeat-customer marks as in HQ: ★ outline at 2+ order days, filled at 3+, two at 5+; crown at 2+ enclosures bought
let CUSTSTAT = { at: 0, map: new Map() };
function custBadge(name) {
  if (CUSTSTAT.at !== store.loadedAt) { const m = new Map(); for (const o of store.orders) { const k = normName(o.customer); if (!k) continue; let c = m.get(k); if (!c) { c = { days: new Set(), encl: 0 }; m.set(k, c); } c.days.add(o.order_date || String(o.created_at).slice(0, 10)); c.encl += (o.lines || []).filter((l) => lineKind(l) === "enc").length; } CUSTSTAT = { at: store.loadedAt, map: m }; }
  const c = CUSTSTAT.map.get(normName(name)); const n = c ? c.days.size : 0; const big = c && c.encl >= 2;
  const lvl = n >= 5 ? 3 : n >= 3 ? 2 : n >= 2 ? 1 : 0;
  const rep = lvl ? ` <span class="bvrep l${lvl}" role="img" aria-label="${lvl === 3 ? "Top customer" : "Repeat customer"}, ${n} orders" data-tip="${lvl === 3 ? "Top customer" : "Repeat customer"} · ${n} orders">${lvl === 1 ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC.star}</svg>` : lvl === 2 ? SVF(IC.star) : SVF(IC.star) + SVF(IC.star)}</span>` : "";
  const crown = big ? ` <span class="bvrep big" role="img" aria-label="Big customer, ${c.encl} enclosures" data-tip="Big customer · ${c.encl} enclosures">${SVF(IC.crown)}</span>` : "";
  return rep + crown;
}
// glue the icons to the last word so they never wrap onto a line of their own (HQ's .bvglue)
const glue = (label, icons) => { const m = String(label).match(/^(.*?)(\S+)\s*$/); return m ? `${esc(m[1])}<span class="bvglue">${esc(m[2])}${icons}</span>` : esc(label) + icons; };
const LAB = { print: "Needs printing", printing: "Printing", printed: "Printed", shelf: "Pull from shelf", packed: "Packed", out: "Out of stock", none: "", head: "" };
// heading for an enclosure line: size from the linked variant, else from the text; door type as a chip
const encHead = (l) => { const t = cleanText(l.text); const m = t.match(/^(?:(\w+)\s+)?(?:complete\s+)?enclosure(s)?/i) || []; const n = Number(l.qty) > 1 ? Number(l.qty) : { two: 2, three: 3, four: 4 }[String(m[1] || "").toLowerCase()] || (/^\d+$/.test(m[1] || "") ? Number(m[1]) : 0); const v = encVar(l); const size = v ? v.size : ((t.match(/\b(large|small)\b/i) || [])[1] || "").toLowerCase(); return (n ? n + " " : "") + (size ? size[0].toUpperCase() + size.slice(1) + " " : "") + "Enclosure" + (n > 1 || m[2] ? "s" : ""); };
// door pill (same look for Latch and Magnetic): the picked variant decides; an unlinked line goes by its words. A text/pick
// disagreement is the server's conflict ("Text says Magnetic", shown under the line), so the chip is plain and never hedges.
// Only sizes offered with both doors get a pill (Small today); the Large comes in latch only, so it shows none.
const encDoor = (l) => { const v = encVar(l); const t = cleanText(l.text); const size = v ? v.size : ((t.match(/\b(large|small)\b/i) || [])[1] || "").toLowerCase(); if (size === "large") return ""; const door = v ? (v.opt === "magnetic" ? "magnetic" : "latch") : /magnet/i.test(t) ? "magnetic" : /latch/i.test(t) ? "latch" : ""; return door ? `<span class="ndoor">${door === "magnetic" ? "Magnetic" : "Latch"}</span>` : ""; };

// lines on other open orders holding the same item that's printed/printing/on the shelf (latest ship date first)
function takeFrom(o, l) {
  const r = invRowOf(l); const me = normName(cleanText(l.text)); const out = [];
  for (const x of store.open) { if (x.id === o.id) continue; for (const m of x.lines || []) { const same = (r && m.notion_inventory_id === r.id) || normName(cleanText(m.text)) === me; if (!same || m.packed) continue; const e = eff(m); if (e.st === "printed" || e.st === "printing" || e.st === "shelf") out.push({ o: x, l: m, st: e.st }); } }
  return out.sort((a, b) => shipBy(b.o).localeCompare(shipBy(a.o)));
}
export const hooks = {}; // set by the page: { lanes: () => [{printer, queued, printing}], queue: (lineUids, printer, start, extra) => count }
function queueDialog(o, l) {
  const like = alsoPrint(o, l); const lanes = hooks.lanes ? hooks.lanes() : [];
  const m = modal(`<h3>Printing</h3><p class="sub">${esc(cleanText(l.text))} · ${esc(o.customer)}</p>
    <form class="namebox"><label class="sub">Printer<select id="qPrinter">${lanes.map((x) => `<option value="${x.printer}">Printer ${x.printer}${x.printing ? " · printing" : ""}${x.queued ? ` · ${x.queued} queued` : ""}</option>`).join("")}</select></label>
    ${like.length ? `<div class="qlike"><div class="sub">Also print for</div>${like.map((x) => `<label class="allto"><input type="checkbox" data-like="${x.l.uid}" checked><span><b>${esc(x.o.customer)}</b>${Number(x.l.qty) > 1 ? ` ×${Number(x.l.qty)}` : ""} <span class="sub">· ships ${esc(dayLabel(shipBy(x.o)))}</span></span></label>`).join("")}</div>` : ""}
    <label class="allto">Extra copies for stock <input type="number" id="qExtra" value="0" min="0" max="50" inputmode="numeric" style="width:4.5em;padding:6px 10px;border-radius:999px"></label>
    <p class="err" id="qErr"></p><div class="row"><button type="submit" class="btn accent">Start printing</button><button type="submit" class="btn ghost" data-go>Start & view queue</button><button type="button" class="btn ghost" data-close>Cancel</button></div></form>`, { label: "Add to print queue" });
  const q = (s) => m.el.querySelector(s); q("[data-close]").onclick = m.close;
  q("form").onsubmit = (e) => { e.preventDefault(); const go = e.submitter && e.submitter.hasAttribute("data-go"); const uids = [l.uid, ...[...m.el.querySelectorAll("[data-like]:checked")].map((c) => c.dataset.like)]; const extra = Math.max(0, Math.min(50, Math.round(Number(q("#qExtra").value) || 0)));
    try { const n = hooks.queue(uids, q("#qPrinter").value, true, extra); m.close(); toast(`${plural(n, "piece")} printing on Printer ${q("#qPrinter").value}${extra ? ` (${extra} for stock)` : ""}`); if (go) document.dispatchEvent(new CustomEvent("spood:printqueue")); } catch (err) { q("#qErr").textContent = err.message; } };
}
function alsoPrint(o, l) {
  const r = invRowOf(l); const me = normName(cleanText(l.text)); const out = [];
  for (const x of store.open) for (const m of x.lines || []) { if (m.uid === l.uid || m.packed) continue; const same = (r && m.notion_inventory_id === r.id) || normName(cleanText(m.text)) === me; if (!same) continue; if (eff(m).st === "print") out.push({ o: x, l: m }); }
  return out.sort((a, b) => shipBy(a.o).localeCompare(shipBy(b.o)));
}
function statusHint(o) {
  const L = (o.lines || []).filter((l) => lineKind(l) !== "enc"); const cur = obPick(o.status);
  const packed = (o.lines || []).filter((l) => l.packed).length; const left = unpacked(o);
  const st = (l) => eff(l).st; const toPrint = L.filter((l) => !l.packed && st(l) === "print").length, printing = L.filter((l) => !l.packed && st(l) === "printing").length;
  const ready = L.length > 0 && L.every((l) => l.packed || ["printed", "shelf", "out", "none"].includes(st(l)));
  if (packed && !left && cur !== "Done") return { to: "Done", tip: "Everything is packed" };
  if (packed && (cur === "Not started" || cur === "Ready to Pack")) return { to: "Packing", tip: plural(packed, "item") + " packed" };
  if (!packed && ready && cur === "Not started") return { to: "Ready to Pack", tip: "Everything is printed or on the shelf" };
  if ((cur === "Ready to Pack" || cur === "Packing") && (toPrint || printing)) { const n = toPrint + printing; return { note: "!", tip: `Says ${cur}, but ${n} item${n === 1 ? " isn't" : "s aren't"} printed yet` }; }
  return null;
}

// catalog tags on a line's item: the collections that pin this exact design + colorway (e.g. Neon Halloween)
const lineTag = (l) => { if (lineKind(l) === "enc") return ""; const r = invRowOf(l); return r && r.tags ? String(r.tags).trim() : ""; };
// one label on the card when every tagged line on the order is the same special version; otherwise each line carries its own
const orderTag = (o) => { const tags = (o.lines || []).map(lineTag).filter(Boolean); return tags.length > 1 && tags.every((t) => t === tags[0]) ? tags[0] : ""; };

function lineHtml(o, l, cardTag = "") {
  const e = eff(l); const kind = e.kind; const head = kind === "enc"; const key = l.uid; const open = BIN.open === key; const busy = store.busy.has("l:" + key);
  const canMark = kind === "print"; const packable = canPack(l); const pull = e.st === "shelf" || (e.st === "packed" && e.from === "shelf");
  const cls = (e.st === "packed" ? "s-packed " + (e.from === "shelf" ? "s-shelf" : "s-done") : e.st === "print" ? "s-print" : e.st === "printing" ? "s-printing" : e.st === "printed" ? "s-done" : e.st === "shelf" ? "s-shelf" : e.st === "out" ? "s-out" : "") + (head ? " s-head" : "");
  const r = invRowOf(l); const qty = Number(l.qty) || 1;
  const tag = lineTag(l);
  // the catalog's own name for the item (product name + size/color); a special version shows as a label, not a prefix
  const label = head ? encHead(l) : (qty > 1 ? qty + " × " : "") + (r ? r.name || r.item : cleanText(l.text).replace(/^\d{1,2}\s*[x×]?\s+(?=[a-z])/i, ""));
  const tagHtml = tag && tag !== cardTag ? `<span class="bvtag">${esc(tag)}</span>` : "";
  const stIcon = e.st === "packed" ? "" : e.st === "printing" ? SV(IC.run, "f-run") : e.st === "printed" ? SV(IC.done, "f-done") : e.st === "shelf" ? SV(IC.shelf, "f-shelf") : e.st === "out" ? SV(IC.out, "f-out") : "";
  const said = cleanText(l.text); const freeNames = (o.freebie || []).map((f) => normName(f)).filter(Boolean);
  const marks = (l.tag === "addon" || (!l.tag && /add-?on/i.test(said)) ? `<span class="bvtype t-addon" role="img" aria-label="Add-on" data-tip="Add-on">${SVF(IC.tag).replace('fill="currentColor"', 'fill="none"')}</span>` : "")
    + (l.tag === "gift" || freeNames.some((f) => normName(said).includes(f) || f.includes(normName(said))) ? `<span class="bvtype t-free" role="img" aria-label="Freebie" data-tip="Freebie">${SVF(IC.gift).replace('fill="currentColor"', 'fill="none"')}</span>` : "");
  const icon = marks + stIcon;
  const sub = e.st === "out" && !head ? `<span class="bvsub">${(r && Number(r.in_stock) > 0 ? "Reserved for earlier orders" : "Out of stock")}${e.a ? ` · ${e.a} of ${qty} on the shelf` : ""}</span>` : e.part ? `<span class="bvsub">${e.a} of ${qty} on the shelf · print ${qty - e.a}</span>` : (l.match === "unmatched" && !head ? `<button type="button" class="ninvfind" data-oeline="${key}" data-oid="${o.id}">Not in catalog</button>` : "");
  const noteHtml = l.note ? `<span class="bvsub bvnote">${esc(l.note)}</span>` : "";
  const cv = l.variant_id != null ? cat.varById.get(String(l.variant_id)) : null; const customLine = !head && (cv ? cv.size_code === "custom" : !r && isCustom(l.text));
  const dims = customLine ? fmtSize(l) : "";
  const dimsHtml = (dims ? `<span class="bvsub bvdims">${esc(dims)}</span>` : customLine ? `<span class="bvsub bvmiss">Custom size missing</span>` : "") + (l.conflict ? `<span class="bvsub bvmiss">${esc(l.conflict)}</span>` : "");
  const tip = `${e.st === "packed" ? "Packed" : LAB[e.st] || ""}${l.state_by ? " · " + l.state_by : ""}\nOrder says: ${cleanText(l.text)}`;
  const box = head ? `<input type="checkbox" class="npack" data-pack="${key}" data-oid="${o.id}" data-from="${pull ? "shelf" : "print"}" ${l.packed ? "checked" : ""} ${packable && !busy ? "" : "disabled"} aria-label="Packed: ${esc(cleanText(l.text))}">`
    : `<span class="bvbox" data-tip="${l.packed ? "Packed" : packable ? "Mark packed" : "Can't pack yet"}"><input type="checkbox" class="npack" data-pack="${key}" data-oid="${o.id}" data-from="${pull ? "shelf" : "print"}" ${l.packed ? "checked" : ""} ${packable && !busy ? "" : "disabled"} aria-label="Packed: ${esc(cleanText(l.text))}"></span>`;
  const dot = (e.st === "print" || e.st === "printing") && !l.packed ? `<button type="button" class="bvst" data-binopen="${key}" aria-label="${LAB[e.st]}: change status" tabindex="-1"></button>` : "";
  const text = canMark ? `<button type="button" class="ntext" data-binopen="${key}" aria-haspopup="menu" aria-expanded="${open}" data-tip="${esc(tip)}">${tagHtml}${glue(label, icon)}</button>` : `<span class="ntext" ${head ? "" : `data-tip="${esc(tip)}"`}>${head ? `<span class="nenc">${esc(label)}</span>${encDoor(l)}` : tagHtml + glue(label, icon)}</span>`;
  const stockBubble = head && r && r.in_stock != null && !l.packed ? (() => { const n = Number(r.in_stock) || 0; const need = owed.get(r.id) || 0; if (e.st === "shelf") return ""; return `<span class="bvstock ${n < 1 ? "out" : ""}" title="${n < 1 ? "Out of stock" : n + " on the shelf"} · ${need} open orders need one">${SV(IC.shelfunit, "")}${n}${n < 1 ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-label="Out of stock"><path d="M12 3 2.5 20h19z"/><path d="M12 9v5"/><path d="M12 17.5h.01"/></svg>` : ""}</span>`; })() : "";
  const opt = (st, lab, on) => `<button type="button" role="menuitemradio" aria-checked="${!!on}" data-ls="${st}" data-uid="${key}" data-oid="${o.id}" class="nm-${st || "reset"}">${on ? "✓ " : ""}${lab}</button>`;
  const pkOpt = `<button type="button" role="menuitemcheckbox" aria-checked="${!!l.packed}" data-packbtn="${key}" data-oid="${o.id}" data-from="${pull ? "shelf" : "print"}" data-set="${l.packed ? "0" : "1"}" class="nm-pack">${l.packed ? "✓ Packed (tap to unpack)" : "Mark as packed"}</button>`;
  let menu = "";
  if (canMark && open && !busy) {
    const invOpt = r && r.in_stock != null ? `<button type="button" role="menuitem" data-invadj="${esc(r.id)}">▦ Adjust inventory…</button>` : "";
    const printingOpt = hooks.queue && e.st !== "printing" && !l.packed ? `<button type="button" role="menuitem" data-queue="${key}" data-oid="${o.id}" class="nm-printing">Printing…</button>` : opt("printing", "Printing", e.st === "printing");
    if (pull && !l.packed) menu = pkOpt + opt("nostock", "Change to print", false) + `<button type="button" role="menuitem" data-oeline="${key}" data-oid="${o.id}">✎ Change item…</button>` + invOpt;
    else {
      const tk = e.st === "print" && !l.packed ? takeFrom(o, l) : []; const also = e.st === "print" && !l.packed ? alsoPrint(o, l) : null;
      menu = opt(e.forced ? "nostock" : "print", "Needs printing", e.st === "print") + printingOpt + opt("printed", "Done", e.st === "printed")
        + (e.st === "print" && !l.packed ? `<button type="button" role="menuitem" class="nm-take" data-take="${key}" data-oid="${o.id}">⇄ Take from another order${tk.length ? ` (${tk.length})` : ""}</button>` : "")
        + (packable ? pkOpt : "") + ((l.print_state || "") !== "" ? opt("", "Reset (shelf if in stock)", false) : "")
        + `<button type="button" role="menuitem" data-oeline="${key}" data-oid="${o.id}">✎ Change item…</button>` + invOpt
        + (also ? `<div class="nm-also" role="none"><div class="nm-alsoh">${also.length ? "Also needs printing · " + also.length : "No other orders need this printed"}</div>${also.map((x) => `<button type="button" role="menuitem" class="nm-alsoi" data-alsogo="${x.l.uid}"><span>${esc(x.o.customer)}</span><span>${esc(dayLabel(shipBy(x.o)))}</span></button>`).join("")}</div>` : "");
    }
    menu = `<div class="nmenu" role="menu" aria-label="Status for ${esc(cleanText(l.text))}">${menu}</div>`;
  }
  const err = store.errs["l:" + key] ? `<div class="err lerr">${esc(store.errs["l:" + key])}</div>` : "";
  return `<div class="nline ${cls}" data-line="${key}">${dot || box}${text}${stockBubble}${sub}${dimsHtml}${noteHtml}${busy ? `<span class="bvsub">Saving…</span>` : ""}${err}${menu}</div>`;
}

// a sale item as the platform reported it: "2 × Silk Cocoon Hide — Set of 3 · Back Mount"
const srcTitle = (t) => { const s = String(t || ""); const i = s.indexOf(" | "); return (i > 0 ? s.slice(i + 3) : s).replace(/,?\s*(Enclosure Decor|Enclosure Accessor(y|ies)).*$/i, "").trim() || s; };
export const srcItemHtml = (it) => `<div class="nsrcline"><b>${Number(it.qty) > 1 ? esc(it.qty) + " × " : ""}${esc(srcTitle(it.title))}</b>${(it.variations || []).length ? `<span class="nsrcvar">${it.variations.map(([k, v]) => `<span title="${esc(k)}">${esc(v)}</span>`).join("")}</span>` : ""}${it.personalization ? `<span class="nsrcvar"><span>${esc(it.personalization)}</span></span>` : ""}</div>`;
export const confirmReview = (o) => act("o:" + o.id, () => db.confirmReview(o.id), { reload: o.id });
// the sale(s) behind an order, shown under the status row: always the number; the items while the order awaits review
const sourcesHtml = (o) => {
  const ss = o.sources || []; if (!ss.length) return "";
  const pending = o.review === "pending"; const busy = store.busy.has("o:" + o.id);
  return `<div class="nsrc${pending ? " pending" : ""}"><div class="nsrchead">${ss.map((s) => `<span class="np np-${platColor(s.platform)}">${esc(s.platform)} #${esc(s.number)}</span>`).join("")}${pending ? `<span class="np np-orange">Review</span><button type="button" class="btn mini accent" data-review="${o.id}" ${busy ? "disabled" : ""}>Confirmed</button>` : ""}</div>${pending ? ss.map((s) => `${(s.items || []).map(srcItemHtml).join("")}${s.note ? `<div class="nsrcnote">${esc(s.note)}</div>` : ""}`).join("") : ""}</div>`;
};

export function cardHtml(o) {
  const cur = obPick(o.status); const busy = store.busy.has("o:" + o.id); const plats = o.platform || [];
  const lines = [...(o.lines || [])].sort((a, b) => a.line_no - b.line_no);
  // enclosure headings first, then everything else in order
  const ordered = [...lines.filter((l) => lineKind(l) === "enc"), ...lines.filter((l) => lineKind(l) !== "enc")];
  const hint = !busy && BIN.stOpen !== o.id ? statusHint(o) : null;
  const left = unpacked(o);
  const det = ((o.collections || []).length ? `<div class="nprop">${o.collections.map((c) => `<span class="np np-purple">${esc(c)}</span>`).join("")}</div>` : "") + (o.order_number ? `<div class="sub">#${esc(o.order_number)}</div>` : "") + (o.state ? `<div class="sub">${esc(o.state)}</div>` : "");
  const pin = !!BIN.pinned[o.id]; const cardTag = orderTag(o);
  const err = store.errs["o:" + o.id] ? `<div class="err">${esc(store.errs["o:" + o.id])}</div>` : "";
  return `<article class="ncard" data-ob="${o.id}">
    <div class="ncard-t"><button type="button" class="nedit" data-obedit="${o.id}" title="Edit the order">${esc(o.customer)}<span class="nedit-i" aria-hidden="true">✎</span></button>${custBadge(o.customer)}${isExpress(o) ? '<span class="np np-red">Express</span>' : ""}${det ? `<button type="button" class="ndetails" data-det="${o.id}" aria-expanded="${pin}" title="Hover to peek, click to keep open">details${pin ? " ▴" : " ▾"}</button>` : ""}</div>
    ${o.handle ? `<div class="nhandle">${esc(o.handle).split("\n").map((x) => x.trim()).filter(Boolean).join(" · ")}</div>` : ""}
    ${det ? `<div class="ndet${pin ? " pinned" : ""}">${det}</div>` : ""}
    <div class="nprop nstatwrap"><div class="nstatrow"><button type="button" class="np np-${NSTAT[cur] || "gray"} nstat" data-stopen="${o.id}" aria-haspopup="menu" aria-expanded="${BIN.stOpen === o.id}" ${busy ? "disabled" : ""} title="Change order status"><i></i>${esc(cur)}${busy ? " · saving…" : " ▾"}</button>${plats.map((p) => `<span class="np np-${platColor(p)}">${esc(p)}</span>`).join("")}${cardTag ? `<span class="np np-purple">${esc(cardTag)}</span>` : ""}
      ${hint ? (hint.note ? `<span class="nsthint warn" title="${esc(hint.tip)}" role="img" aria-label="${esc(hint.tip)}">!</span>` : `<button type="button" class="nsthint" data-hint="${esc(hint.to)}" data-oid="${o.id}" title="${esc(hint.tip)}">→ ${esc(hint.to)}</button>`) : ""}</div>
      ${BIN.stOpen === o.id && !busy ? `<div class="nmenu nstatmenu" role="menu" aria-label="Order status for ${esc(o.customer)}">${OB_PICK.map((x) => { const lock = x === "Done" && left && x !== cur; return `<button type="button" role="menuitemradio" aria-checked="${x === cur}" data-ost="${esc(x)}" data-oid="${o.id}" ${lock ? "disabled" : ""}>${x === cur ? "✓ " : ""}${esc(x)}${lock ? ` <span class="sub">(pack ${left} more)</span>` : ""}</button>`; }).join("")}</div>` : ""}</div>
    ${sourcesHtml(o)}
    ${o.important ? `<div class="nimp">${esc(o.important).split("\n").map((x) => x.trim()).filter(Boolean).join("<br>")}</div>` : ""}
    ${o.summary ? `<div class="nnotes">${esc(o.summary).split("\n").map((x) => x.trim()).filter(Boolean).join("<br>")}</div>` : ""}
    ${err}
    <div class="nlines">${ordered.map((l) => lineHtml(o, l, cardTag)).join("") || '<div class="sub">No items on this order.</div>'}</div>
    ${(o.freebie || []).length ? `<div class="sub nfree"><span class="bvtype t-free" aria-hidden="true">${SVF(IC.gift).replace('fill="currentColor"', 'fill="none"')}</span> ${o.freebie.map(esc).join(", ")}</div>` : ""}
    <div class="ncard-f">${o.order_date ? `Ordered ${esc(fmtDay(o.order_date))}` : ""}<span style="flex:1"></span>v${o.version}</div>
  </article>`;
}

// Redrawing the board must not move it: keep the column scroll and the page position across every refresh and click.
export function binRender() {
  const box = $("#binList"); if (!box) return;
  const board = box.querySelector(".nboard"); const left = board ? board.scrollLeft : 0; const top = window.scrollY;
  binDraw(box);
  const nb = box.querySelector(".nboard"); if (nb && left) nb.scrollLeft = left;
  if (window.scrollY !== top) window.scrollTo(0, top);
}
function binDraw(box) {
  const st = $("#binStatus");
  const nocat = store.open.reduce((n, o) => n + (o.lines || []).filter((l) => l.match === "unmatched" && !isEncText(l.text)).length, 0);
  const review = store.open.filter((o) => o.review === "pending").length;
  if (st) st.textContent = store.err ? "⚠ " + store.err : store.loadedAt ? `${plural(store.open.length, "open order")}${nocat ? ` · ⚠ ${plural(nocat, "line")} not in the catalog` : ""}${review ? ` · ${review} to review` : ""} · synced ${store.loadedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · refreshes every 20 s` : "Reading orders…";
  const ns = $("#binSources"); if (ns) { const s = store.sources || []; ns.hidden = !s.length || BIN.mode === "done"; ns.innerHTML = s.length ? `<div class="nsrchead"><span class="np np-orange">⚠ ${plural(s.length, "sale")} not entered</span></div>${s.map((x) => `<div class="nsrcsale"><div class="nsrchead"><b>${esc(x.buyer || "")}</b><span class="np np-${platColor(x.platform)}">${esc(x.platform)} #${esc(x.number)}</span><span class="sub">ordered ${esc(fmtDay(x.order_date))}${x.ship_by ? ` · ship by ${esc(fmtDay(x.ship_by))}` : ""}</span><button type="button" class="btn ghost mini" data-srcnew="${x.id}">+ Enter order</button></div>${(x.items || []).map(srcItemHtml).join("")}${x.note ? `<div class="nsrcnote">${esc(x.note)}</div>` : ""}</div>`).join("")}` : ""; }
  const sel = $("#binPlat"); if (sel) { const plats = [...new Set(store.orders.flatMap((o) => o.platform || []))].sort(); const cur = sel.value; sel.innerHTML = `<option value="">All platforms</option>` + plats.map((p) => `<option ${p === cur ? "selected" : ""}>${esc(p)}</option>`).join(""); }
  document.querySelectorAll("[data-binlay]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.binlay === BIN.layout)));
  document.querySelectorAll("[data-binmode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.binmode === BIN.mode)));
  const done = BIN.mode === "done";
  for (const el of [$("#binDays"), $("#binLay"), $('[data-fold="bininvhow"]')]) if (el) el.hidden = done;
  if (done && st && !store.err && store.loadedAt) st.textContent = store.doneAt ? `${plural(store.orders.length - store.open.length, "done order")} · synced ${store.doneAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Reading done orders…";
  if (!store.loadedAt) return;
  if (done) { doneRender(box); return; }
  const today = isoDay(); const dk = (o) => (shipBy(o) < today ? "overdue" : shipBy(o));
  const all = store.open;
  const days = [...new Set(all.map(dk))]; BIN.days = BIN.days.filter((k) => days.includes(k)); const selDays = new Set(BIN.days);
  const lab = (k) => (k === "overdue" ? "Overdue" : k === NO_DATE ? "No date" : dayLabel(k).replace(/^./, (c) => c.toUpperCase()));
  $("#binDays").innerHTML = [["all", "All", all.length], ...days.map((k) => [k, lab(k), all.filter((o) => dk(o) === k).length])].map(([k, l, n]) => `<button type="button" data-day="${esc(k)}" aria-pressed="${k === "all" ? !selDays.size : selDays.has(k)}" class="${k === "overdue" ? "bad" : k === today ? "warn" : ""}">${esc(l)} <b>${n}</b></button>`).join("");
  const q = ($("#binSearch").value || "").trim().toLowerCase(), pf = ($("#binPlat").value || "").toLowerCase();
  const list = all.filter((o) => (!selDays.size || selDays.has(dk(o))) && (!pf || (o.platform || []).some((p) => p.toLowerCase().includes(pf))) && (!q || [o.customer, o.important, o.order_number, o.state, ...(o.lines || []).map((l) => l.text)].join(" ").toLowerCase().includes(q)));
  const undo = recentDone.filter((x) => Date.now() - x.at < 120000);
  const undoHtml = undo.length ? `<div class="card binundo"><b>Recently marked Done</b>${undo.map((u) => `<div class="binundo-row"><span>${esc(u.customer)}</span><button type="button" class="btn ghost mini" data-undo="${u.id}">Undo</button></div>`).join("")}</div>` : "";
  if (!list.length) { box.innerHTML = undoHtml + `<div class="card"><div class="empty">${all.length ? "No orders match." : "Bin View is empty. Nothing to pack."}</div></div>`; return; }
  const cols = []; list.forEach((o) => { const k = shipBy(o); let c = cols.find((x) => x.k === k); if (!c) { c = { k, list: [] }; cols.push(c); } c.list.push(o); });
  const colLab = (k) => (k === NO_DATE ? "No ship date" : new Date(k + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const rows = BIN.layout === "rows";
  box.innerHTML = undoHtml + (rows ? "" : '<div class="nscroll"><div></div></div>') + `<div class="nboard${rows ? " rows" : ""}">${cols.map((c) => `<section class="ncol ${c.k < today ? "over" : c.k === today ? "today" : ""}"><header><span class="nday">${esc(colLab(c.k))}</span><span class="ncount">${plural(c.list.length, "order")}</span>${c.k < today ? '<span class="np np-red">Overdue</span>' : c.k === today ? '<span class="np np-yellow">Today</span>' : c.k === addDays(today, 1) ? '<span class="np np-blue">Tomorrow</span>' : ""}</header><div class="ncards">${c.list.map(cardHtml).join("")}</div></section>`).join("")}</div>`;
  if (!rows) binScrollbar(box.querySelector(".nscroll"), box.querySelector(".nboard"));
}

// Done orders, newest first, grouped by the day they were marked Done (Notion imports: their ship date).
const doneKey = (o) => (o.done_at ? isoDay(new Date(o.done_at)) : shipBy(o));
function doneRender(box) {
  const q = ($("#binSearch").value || "").trim().toLowerCase(), pf = ($("#binPlat").value || "").toLowerCase();
  const all = store.orders.filter((o) => o.status === "Done");
  const list = all.filter((o) => (!pf || (o.platform || []).some((p) => p.toLowerCase().includes(pf))) && (!q || [o.customer, o.important, o.order_number, o.state, o.shipping_number, ...(o.lines || []).map((l) => l.text)].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => doneKey(b).localeCompare(doneKey(a)) || String(b.done_at || "").localeCompare(String(a.done_at || "")) || rank(b, a));
  if (!list.length) { box.innerHTML = `<div class="card"><div class="empty">${all.length ? "No done orders match." : "No orders marked Done yet."}</div></div>`; return; }
  const shown = list.slice(0, BIN.doneLimit); const groups = [];
  for (const o of shown) { const k = doneKey(o); let g = groups[groups.length - 1]; if (!g || g.k !== k) groups.push((g = { k, list: [] })); g.list.push(o); }
  const lab = (k) => (k === NO_DATE ? "No date" : dayLabel(k).replace(/^./, (c) => c.toUpperCase()));
  const row = (o) => {
    const busy = store.busy.has("o:" + o.id); const open = BIN.doneOpen.has(o.id); const err = store.errs["o:" + o.id];
    const lines = [...(o.lines || [])].sort((a, b) => a.line_no - b.line_no); const n = lines.reduce((a, l) => a + (Number(l.qty) || 1), 0);
    const when = o.done_at ? `${new Date(o.done_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}${o.done_by ? " · " + esc(o.done_by) : ""}` : `ship by ${esc(fmtDay(shipBy(o)))}`;
    return `<div class="donerow"><div class="donerow-t"><button type="button" class="dname" data-donetog="${o.id}" aria-expanded="${open}">${esc(o.customer)}</button>${(o.platform || []).map((p) => `<span class="np np-${platColor(p)}">${esc(p)}</span>`).join("")}<span class="sub">${plural(n, "item")} · ${when}</span><button type="button" class="btn ghost mini" data-doneundo="${o.id}" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Undo"}</button></div>
      ${err ? `<div class="err">${esc(err)}</div>` : ""}
      ${open ? `<div class="sub">${[o.order_number ? "#" + esc(o.order_number) : "", o.state ? esc(o.state) : "", o.shipping_number ? "Ship # " + esc(o.shipping_number) : "", o.order_date ? "Ordered " + esc(fmtDay(o.order_date)) : ""].filter(Boolean).join(" · ")}</div><ul class="donelines">${lines.map((l) => `<li>${Number(l.qty) > 1 && !/^\d/.test(cleanText(l.text)) ? l.qty + " × " : ""}${esc(cleanText(l.text))}${l.note ? ` <span class="sub">(${esc(l.note)})</span>` : ""}</li>`).join("") || '<li class="sub">No items</li>'}</ul>` : ""}</div>`;
  };
  box.innerHTML = `<div class="card donelist">${groups.map((g) => `<section class="doneday"><h3>${esc(lab(g.k))}<span class="sub">${plural(g.list.length, "order")}</span></h3>${g.list.map(row).join("")}</section>`).join("")}
    ${list.length > shown.length ? `<button type="button" class="btn ghost" data-donemore>Show ${Math.min(40, list.length - shown.length)} more of ${list.length - shown.length}</button>` : ""}</div>`;
}

// Thin scrollbar above the column board, kept in step with the board's own horizontal scroll.
function binScrollbar(bar, board) {
  const track = bar.firstElementChild; let lock = false;
  const size = () => { track.style.width = board.scrollWidth + "px"; bar.style.display = board.scrollWidth > board.clientWidth + 1 ? "" : "none"; };
  const follow = (from, to) => () => { if (lock) return; lock = true; to.scrollLeft = from.scrollLeft; lock = false; };
  bar.addEventListener("scroll", follow(bar, board)); board.addEventListener("scroll", follow(board, bar));
  size(); if (typeof ResizeObserver !== "undefined") { const ro = new ResizeObserver(size); ro.observe(board); board.querySelectorAll(".ncol").forEach((c) => ro.observe(c)); }
}

function binWire() {
  const box = $("#binList");
  const srcBox = $("#binSources"); if (srcBox) srcBox.addEventListener("click", (e) => { const b = e.target.closest("[data-srcnew]"); if (!b) return; const s = (store.sources || []).find((x) => String(x.id) === b.dataset.srcnew); if (s) openOrderForm(null, null, formFromSource(s)); });
  $("#binSearch").oninput = () => { BIN.doneLimit = 40; binRender(); }; $("#binPlat").onchange = () => { BIN.doneLimit = 40; binRender(); };
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-binmode]"); if (!b || BIN.mode === b.dataset.binmode) return; BIN.mode = b.dataset.binmode; BIN.doneLimit = 40; BIN.open = null; BIN.stOpen = null; binRender(); if (BIN.mode === "done") load({ done: true }); });
  $("#binDays").addEventListener("click", (e) => { const b = e.target.closest("[data-day]"); if (!b) return; const k = b.dataset.day; if (k === "all") BIN.days = []; else BIN.days = BIN.days.includes(k) ? BIN.days.filter((x) => x !== k) : [...BIN.days, k]; binRender(); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-binlay]"); if (!b) return; BIN.layout = b.dataset.binlay; try { localStorage.setItem("spood.bin.layout", BIN.layout); } catch (x) {} binRender(); });
  document.addEventListener("click", (e) => { if ((BIN.open || BIN.stOpen) && !e.target.closest(".nmenu,[data-binopen],[data-stopen]")) { BIN.open = null; BIN.stOpen = null; binRender(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (BIN.open || BIN.stOpen)) { BIN.open = null; BIN.stOpen = null; binRender(); } });
  const orderOf = (id) => store.orders.find((x) => x.id === id);
  box.addEventListener("click", async (e) => {
    const t = e.target;
    let b;
    if ((b = t.closest("[data-undo]"))) { b.disabled = true; undoDone(b.dataset.undo); return; }
    if ((b = t.closest("[data-donetog]"))) { const id = b.dataset.donetog; if (BIN.doneOpen.has(id)) BIN.doneOpen.delete(id); else BIN.doneOpen.add(id); binRender(); return; }
    if ((b = t.closest("[data-donemore]"))) { BIN.doneLimit += 40; binRender(); return; }
    if ((b = t.closest("[data-doneundo]"))) { const o = orderOf(b.dataset.doneundo); if (!o) return; const to = o.done_prev && obPick(o.done_prev) !== "Done" ? obPick(o.done_prev) : "Not started";
      if (await confirmBox({ title: "Put back on the board?", body: `${esc(o.customer)} goes back to <b>${esc(to)}</b>. Any pieces it took off the shelf go back to Inventory.`, ok: "Put back" })) undoDone(o.id); return; }
    if ((b = t.closest("[data-det]"))) { BIN.pinned[b.dataset.det] = !BIN.pinned[b.dataset.det]; binRender(); return; }
    if ((b = t.closest("[data-review]"))) { const o = orderOf(b.dataset.review); if (o) confirmReview(o); return; }
    if ((b = t.closest("[data-obedit]"))) { e.stopPropagation(); openOrderForm(orderOf(b.dataset.obedit)); return; }
    if ((b = t.closest("[data-oeline]"))) { e.stopPropagation(); BIN.open = null; openOrderForm(orderOf(b.dataset.oid), b.dataset.oeline); return; }
    if ((b = t.closest("[data-stopen]"))) { e.stopPropagation(); BIN.open = null; BIN.stOpen = BIN.stOpen === b.dataset.stopen ? null : b.dataset.stopen; binRender(); return; }
    if ((b = t.closest("[data-ost]"))) { e.stopPropagation(); const o = orderOf(b.dataset.oid); BIN.stOpen = null; if (!o || obPick(o.status) === b.dataset.ost) { binRender(); return; } setStatus(o, b.dataset.ost); return; }
    if ((b = t.closest("[data-hint]"))) { e.stopPropagation(); const o = orderOf(b.dataset.oid); if (o) setStatus(o, b.dataset.hint); return; }
    if ((b = t.closest("[data-binopen]"))) { e.stopPropagation(); BIN.stOpen = null; BIN.open = BIN.open === b.dataset.binopen ? null : b.dataset.binopen; binRender(); return; }
    if ((b = t.closest("[data-alsogo]"))) { e.stopPropagation(); const n = box.querySelector(`[data-line="${b.dataset.alsogo}"]`); if (n) { n.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }); n.closest(".ncard").classList.add("flash"); setTimeout(() => n.closest(".ncard").classList.remove("flash"), 1600); } return; }
    if ((b = t.closest("[data-take]"))) { e.stopPropagation(); BIN.open = null; binRender(); takeOpen(orderOf(b.dataset.oid), b.dataset.take); return; }
    if ((b = t.closest("[data-queue]"))) { e.stopPropagation(); const o = orderOf(b.dataset.oid); const l = (o.lines || []).find((x) => x.uid === b.dataset.queue); BIN.open = null; binRender(); if (l) queueDialog(o, l); return; }
    if ((b = t.closest("[data-invadj]"))) { e.stopPropagation(); BIN.open = null; binRender(); document.dispatchEvent(new CustomEvent("spood:inventory", { detail: { id: b.dataset.invadj, mode: "adjust" } })); return; }
    if ((b = t.closest("[data-ls]"))) { e.stopPropagation(); const o = orderOf(b.dataset.oid); BIN.open = null; const uid = b.dataset.uid, st = b.dataset.ls; const l = (o.lines || []).find((x) => x.uid === uid); const patch = { print_state: st, print_src: "bin" }; if (l && l.packed && (st === "print" || st === "printing" || st === "nostock")) Object.assign(patch, { packed: false }); setLine(o.id, uid, patch); return; }
    if ((b = t.closest("[data-packbtn]"))) { e.stopPropagation(); BIN.open = null; setLine(b.dataset.oid, b.dataset.packbtn, b.dataset.set === "1" ? { packed: true, packed_from: b.dataset.from } : { packed: false }); return; }
  });
  box.addEventListener("mouseover", (e) => { const b = e.target.closest("[data-det]"); if (b) b.closest(".ncard").classList.add("dethover"); });
  box.addEventListener("mouseout", (e) => { const c = e.target.closest(".ncard"); if (c && !c.contains(e.relatedTarget)) c.classList.remove("dethover"); });
  box.addEventListener("change", (e) => { const b = e.target.closest("[data-pack]"); if (!b) return; BIN.open = null; setLine(b.dataset.oid, b.dataset.pack, b.checked ? { packed: true, packed_from: b.dataset.from } : { packed: false }); });
}

function takeOpen(o, uid) {
  const l = (o.lines || []).find((x) => x.uid === uid); if (!l) return;
  const list = takeFrom(o, l);
  const m = modal(`<h3>Take from another order</h3><p>For <b>${esc(o.customer)}</b>: ${esc(cleanText(l.text))}</p>
    <div class="il-list">${list.map((c, i) => `<button type="button" data-pick="${i}"><span><b>${esc(c.o.customer)}</b> <span class="sub">· ships ${esc(dayLabel(shipBy(c.o)))}</span><br><span class="sub">${esc(cleanText(c.l.text))}</span></span><span class="tk tk-${c.st}">${c.st === "printed" ? "Printed" : c.st === "shelf" ? "From shelf" : "Printing"}</span></button>`).join("") || '<p class="sub" style="padding:10px">No other open order has this item printed, printing or on the shelf right now.</p>'}</div>
    <p class="sub" style="margin:8px 0 12px;font-size:.85rem">The order you take from goes back to <b>needs printing</b> for that piece.</p>
    <div class="row"><button type="button" class="btn ghost" data-no>Cancel</button></div>`, { label: "Take from another order" });
  m.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-no]")) { m.close(); return; }
    const b = e.target.closest("[data-pick]"); if (!b) return; const c = list[+b.dataset.pick]; m.close();
    // the taken line gets our state; ours becomes theirs. Shelf pulls are decided by ship date, so a shelf piece is taken by forcing theirs to print.
    const mine = c.st === "shelf" ? { uid, print_state: "", print_src: "bin" } : { uid, print_state: c.st, print_src: "bin" };
    const theirs = { uid: c.l.uid, print_state: c.st === "shelf" ? "nostock" : "print", print_src: "bin" };
    const ok = await act("l:" + uid, () => db.setLineState([mine, theirs]));
    await reloadOrder(o.id); await reloadOrder(c.o.id);
    if (ok) toast(`Moved ${cleanText(l.text)} from ${c.o.customer} to ${o.customer}. ${c.o.customer}'s goes back to needs printing.`);
  });
}

/* ===================== customers (derived from orders) ===================== */
export function customers() {
  const map = new Map();
  for (const o of store.orders) {
    const k = normName(o.customer); if (!k) continue;
    let c = map.get(k); if (!c) { c = { key: k, name: o.customer.replace(/\s*\*+\s*$/, ""), orders: [], platforms: new Set(), states: new Set(), handles: new Set(), repeat: false }; map.set(k, c); }
    c.orders.push(o); (o.platform || []).forEach((p) => c.platforms.add(p)); if (o.state) c.states.add(o.state); if (o.handle) c.handles.add(o.handle); if (o.repeat_customer) c.repeat = true;
  }
  for (const c of map.values()) { c.orders.sort((a, b) => String(b.order_date || b.created_at).localeCompare(String(a.order_date || a.created_at))); c.last = c.orders[0]; c.open = c.orders.filter((o) => o.status !== "Done").length; }
  return [...map.values()].sort((a, b) => String(b.last.order_date || b.last.created_at).localeCompare(String(a.last.order_date || a.last.created_at)));
}
const CUST = { q: "", open: null };
export function custRender() {
  const host = $("#custHost"); if (!host) return;
  if (!store.loadedAt) { host.innerHTML = `<div class="empty">${store.err ? "⚠ " + esc(store.err) : "Customers show here once orders load."}</div>`; return; }
  const all = customers(); const q = normName(CUST.q); const qt = q.split(" ").filter(Boolean);
  const list = qt.length ? all.filter((c) => { const hay = normName([c.name, ...c.handles, ...c.states, ...c.platforms].join(" ")); return qt.every((w) => hay.includes(w)); }) : all;
  const open = CUST.open && all.find((c) => c.key === CUST.open);
  const lineLabel = (o) => (o.lines || []).slice().sort((a, b) => a.line_no - b.line_no).map((l) => `${Number(l.qty) > 1 ? l.qty + "× " : ""}${esc(cleanText(l.text).replace(/^\d{1,2}\s*[x×]?\s+(?=[a-z])/i, ""))}`).join("<br>");
  const detail = open ? `<div class="card" style="box-shadow:none">
      <div class="row"><div><h3 style="font:400 1.3rem var(--display)">${esc(open.name)}</h3><div class="sub">${plural(open.orders.length, "order")}${open.open ? ` · ${open.open} open` : ""}${open.states.size ? " · " + esc([...open.states].join(", ")) : ""}${open.handles.size ? " · " + esc([...open.handles].join(", ")) : ""}${open.repeat ? " · repeat customer" : ""}</div></div>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn mini" data-custnew="${esc(open.key)}">New order</button><button type="button" class="btn ghost mini" data-custopen="">Close</button></div></div>
      <div class="tw"><table class="t"><thead><tr><th>Ship by</th><th>Platform</th><th>Items</th><th>Status</th></tr></thead><tbody>${open.orders.map((o) => `<tr><td>${esc(fmtDay(o.ship_by))}${o.order_number ? `<br><span class="sub mono">#${esc(o.order_number)}</span>` : ""}</td><td>${(o.platform || []).map(esc).join(", ")}</td><td>${lineLabel(o)}</td><td>${o.status === "Done" ? '<span class="chip ok">Done</span>' : `<span class="chip watch">${esc(o.status)}</span>`}</td></tr>`).join("")}</tbody></table></div></div>` : "";
  host.innerHTML = `<div class="row"><h2>Customers</h2><span class="sub">${plural(all.length, "customer")} · from every order</span></div>
    ${detail}
    <div class="row" style="justify-content:flex-start"><input id="custQ" type="search" value="${esc(CUST.q)}" placeholder="Search by name, handle, state or platform" style="max-width:380px;flex:1"></div>
    ${list.length > 150 ? `<div class="sub">Showing the 150 most recent. Search to find others.</div>` : ""}
    ${list.length ? `<div class="tw"><table class="t"><thead><tr><th>Name</th><th>Platforms</th><th>State</th><th class="num">Orders</th><th>Last order</th><th></th></tr></thead><tbody>${list.slice(0, 150).map((c) => `<tr><td><b>${esc(c.name)}</b>${c.repeat ? ' <span class="np np-yellow" title="Repeat customer">★</span>' : ""}${c.handles.size ? `<br><span class="sub">${esc([...c.handles].join(", "))}</span>` : ""}</td><td>${[...c.platforms].map((p) => `<span class="np np-${platColor(p)}">${esc(p)}</span>`).join(" ")}</td><td>${esc([...c.states].join(", "))}</td><td class="num">${c.orders.length}${c.open ? ` <span class="sub">(${c.open} open)</span>` : ""}</td><td>${esc(fmtDay(c.last.order_date || c.last.ship_by))}</td><td><div class="row" style="flex-wrap:nowrap;justify-content:flex-end"><button type="button" class="btn ghost mini" data-custopen="${esc(c.key)}">Open</button><button type="button" class="btn mini" data-custnew="${esc(c.key)}">New order</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${all.length ? "No customer matches that search." : "No customers yet."}</div>`}`;
  const qi = $("#custQ"); if (qi) { qi.oninput = () => { CUST.q = qi.value; const pos = qi.selectionStart; custRender(); const n = $("#custQ"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }; }
  host.onclick = (e) => {
    let b;
    if ((b = e.target.closest("[data-custopen]"))) { CUST.open = b.dataset.custopen || null; custRender(); return; }
    if ((b = e.target.closest("[data-custnew]"))) { const c = all.find((x) => x.key === b.dataset.custnew); if (!c) return; document.querySelector('nav.tabs [data-tab="bins"]').click(); openOrderForm(null, null, { customer: c.name, platform: c.last.platform || [], state: [...c.states][0] || "", handle: [...c.handles][0] || "" }); }
  };
}

/* ===================== catalog: products, sizes, colors, variants (hq.catalog_options) ===================== */
export const cat = { opts: null, byProduct: new Map(), variants: [], varByKey: new Map(), varByNotion: new Map(), varById: new Map(), schemes: new Map(), colors: new Map(), colls: new Map() };
const vkey = (p, s, c, o) => [p, s || "standard", c || "standard", o || "standard"].join("|");
export function indexCatalog(o) {
  cat.opts = o || {}; cat.stale = false; cat.at = Date.now(); const P = cat.opts.products || [];
  cat.byProduct = new Map(P.map((p) => [p.id, p])); cat.schemes = new Map((cat.opts.color_schemes || []).map((s) => [s.id, s]));
  cat.colors = new Map((cat.opts.colors || []).map((c) => [c.id, c])); cat.colls = new Map((cat.opts.collections || []).map((c) => [c.id, c]));
  cat.variants = cat.opts.variants || []; cat.varByKey = new Map(); cat.varByNotion = new Map(); cat.varById = new Map();
  for (const v of cat.variants) { cat.varByKey.set(vkey(v.product_id, v.size_code, v.color_scheme_id, v.option_code), v); if (v.notion_id) cat.varByNotion.set(v.notion_id, v); cat.varById.set(String(v.id), v); }
}
export async function loadCatalog(force = false) { if (cat.opts && !force && !cat.stale) return cat.opts; indexCatalog(await db.catalogOptions()); return cat.opts; }
export const invalidateCatalog = () => { cat.stale = true; };
const colorName = (id) => (id && cat.colors.get(id) ? cat.colors.get(id).name : id || "");
const sizeName = (p, code) => { const s = p && (p.size_codes || []).find((x) => x.code === code); return s ? s.name : code ? code[0].toUpperCase() + code.slice(1) : ""; };
const schemeFor = (c1, c2) => { if (!c1) return "standard"; for (const s of cat.schemes.values()) { if ((s.color_1 === c1 && (s.color_2 || null) === (c2 || null)) || (c2 && s.color_1 === c2 && s.color_2 === c1)) return s.id; } return [c1, c2].filter(Boolean).join("-"); };
const schemeColors = (id) => { const s = id && cat.schemes.get(id); return s ? { c1: s.color_1 || "", c2: s.color_2 || "" } : !id || id === "standard" ? { c1: "", c2: "" } : (() => { const parts = cat.colors.has(id) ? [id] : [...cat.colors.keys()].filter((k) => id === k || id.startsWith(k + "-") || id.endsWith("-" + k)); return { c1: parts[0] || "", c2: parts[1] || "" }; })(); };
// colors a product is offered in: the catalog's chart (product_colors) plus every colorway it already has
function productColors(p) {
  const s1 = new Set(((p.offered || {})["1"] || [])), s2 = new Set(((p.offered || {})["2"] || []));
  for (const v of cat.variants) if (v.product_id === p.id && v.color_scheme_id !== "standard") { const c = schemeColors(v.color_scheme_id); if (c.c1) s1.add(c.c1); if (c.c2) s2.add(c.c2); }
  const any = s1.size || s2.size || p.picks_color;
  return { any, s1: [...s1], s2: [...s2], two: s2.size > 0 || /floor|insert/i.test(p.category || "") && s1.size > 0 };
}
// a product made in one size gets it; one made in several gets no size until a person picks one (the form never chooses)
const defaultSize = (p, want) => { const codes = (p.size_codes || []).map((s) => s.code); if (want && codes.includes(want)) return want; return codes.length === 1 ? codes[0] : codes.length ? "" : "standard"; };
// pick line -> what the catalog says (mirrors hq.pick_variant; the server has the last word on save)
export function pickState(l) {
  const p = cat.byProduct.get(l.product_id); if (!p) return { status: "unresolved", reason: "no product" };
  const size = l.size_code || defaultSize(p); if (!size) return { status: "unresolved", reason: "needs size" };
  if (!(p.size_codes || []).some((s) => s.code === size)) return { status: "unresolved", reason: "size not offered", size };
  const c1 = l.c1 || "", c2 = l.c2 && l.c2 !== c1 ? l.c2 : ""; const opt = l.option_code || "standard"; let scheme;
  const pc = productColors(p);
  if (c1) scheme = schemeFor(c1, c2);
  else {
    scheme = p.default_scheme || "";
    if (!scheme) { const at = [...new Set(cat.variants.filter((v) => v.product_id === p.id && v.size_code === size && v.option_code === opt).map((v) => v.color_scheme_id))];
      if (at.length === 1) scheme = at[0]; else { const all = [...new Set(cat.variants.filter((v) => v.product_id === p.id && v.option_code === opt).map((v) => v.color_scheme_id))]; if (all.length === 1) scheme = all[0]; else if (p.picks_color || all.length > 1 || pc.s1.length || pc.s2.length) return { status: "unresolved", reason: "needs color" }; else scheme = "standard"; } }
  }
  const v = cat.varByKey.get(vkey(p.id, size, scheme, opt));
  if (v) return { status: "variant", v, name: v.name, size, scheme };
  if (opt !== "standard") return { status: "unresolved", reason: "option not offered", option: opt };
  const offered = (id) => pc.s1.includes(id) || pc.s2.includes(id);
  if (c1 && !(cat.variants.some((x) => x.product_id === p.id && x.color_scheme_id === scheme) || (((p.offered || {})["1"] || []).length + ((p.offered || {})["2"] || []).length > 0 && offered(c1) && (!c2 || offered(c2))))) return { status: "unresolved", reason: "color not offered", size, scheme };
  const parts = [size !== "standard" ? sizeName(p, size) : "", scheme !== "standard" ? (cat.schemes.get(scheme) || {}).name || [colorName(c1), colorName(c2)].filter(Boolean).join(" + ") : ""].filter(Boolean);
  const prefix = (cat.variants.find((x) => x.product_id === p.id && x.name && x.name.includes(" (")) || {}).name; const base = prefix ? prefix.split(" (")[0] : (cat.variants.find((x) => x.product_id === p.id) || {}).name || p.name;
  return { status: "creatable", name: base + (parts.length ? ` (${parts.join(", ")})` : ""), size, scheme };
}
// the order's words against the pick (mirrors hq.line_check; the server has the last word on save): "Text says Large", "Text says Hot Pink", or ""
function textCheck(said, l, p) {
  if (!said || !p) return "";
  const key = "-" + said.toLowerCase().replace(/\(matte\)/g, " matte").replace(/[^a-z0-9]+/g, "-") + "-";
  let sz = /-(large|lg)-/.test(key) ? "large" : /-(small|sm|standard|regular|reg)-/.test(key) ? "small" : isCustom(said) ? "custom" : "";
  if (l.size_code === "custom" && isCustom(said)) sz = ""; if (p.id === "enclosure" && sz === "custom") sz = "";
  if (sz && l.size_code && sz !== l.size_code && !(sz === "small" && l.size_code === "standard")) return "Text says " + (sz === "custom" ? "custom size" : sz[0].toUpperCase() + sz.slice(1));
  if (p.id === "enclosure") { const door = /-magnet/.test(key) ? "magnetic" : /-latch/.test(key) ? "standard" : ""; if (door && door !== (l.option_code || "standard")) return "Text says " + (door === "magnetic" ? "Magnetic" : "Latch"); }
  if (!productColors(p).any) return "";
  let k = key; const bad = [];
  const names = [...cat.colors.values()].flatMap((c) => [c.name, ...(c.aliases || [])].map((nm) => [c, "-" + nm.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-"])).sort((a, b) => b[1].length - a[1].length);
  for (const [c, ck] of names) if (k.includes(ck)) { k = k.split(ck).join("-"); if (c.id !== l.c1 && c.id !== l.c2 && !bad.includes(c)) bad.push(c); }
  return bad.length ? "Text says " + bad.map((c) => c.name).join(" + ") : "";
}
const pickWord = (st) => {
  if (!st) return "";
  if (st.status === "variant") return ""; if (st.status === "creatable") return "New in the catalog on save";
  switch (st.reason) { case "needs size": return "Needs a size"; case "needs color": return "Needs a color"; case "color not offered": return "Not offered in that color — add it in Inventory"; case "size not offered": return `Not made in ${st.size}`; case "option not offered": return `No ${st.option} version`; default: return "Not in the catalog"; }
};
// a saved order line -> form line (pick when the catalog knows the item, else text)
function lineFromSaved(l) {
  const v = (l.notion_inventory_id && cat.varByNotion.get(l.notion_inventory_id)) || (l.variant_id != null && cat.varById.get(String(l.variant_id))) || null;
  const base = { uid: l.uid, qty: Number(l.qty) || 1, note: l.note || "", tag: l.tag || "", group_uid: l.group_uid || null, print_state: l.print_state, packed: l.packed, size_1: l.size_1 ?? "", size_2: l.size_2 ?? "", size_3: l.size_3 ?? "", size_unit: l.size_unit || "in", size_basis: l.size_basis || "piece" };
  if (v) { const c = schemeColors(v.color_scheme_id); return { ...base, kind: "pick", product_id: v.product_id, size_code: v.size_code, c1: c.c1, c2: c.c2, option_code: v.option_code || "standard", untracked: false, said: normName(cleanText(l.text)) === normName(v.name) ? "" : cleanText(l.text) }; }
  return { ...base, kind: "text", text: cleanText(l.text), inv: l.notion_inventory_id || "", untracked: l.match === "untracked" };
}
const pickLine = (product_id, extra = {}) => { const p = cat.byProduct.get(product_id); const d = p && p.default_scheme ? schemeColors(p.default_scheme) : { c1: "", c2: "" }; return { kind: "pick", product_id, size_code: p ? defaultSize(p, extra.size_code) : "standard", c1: d.c1, c2: d.c2, option_code: "standard", qty: 1, note: "", tag: "", untracked: false, ...extra }; };
const isEncLine = (l) => (l.kind === "pick" ? l.product_id === "enclosure" : isEncText(l.text));

/* ===================== order form (new / edit) ===================== */
const PLATFORMS = () => [...new Set(["Etsy", "Shopify", "TikTok", "TikTok - LIVE", "In person", ...store.orders.flatMap((o) => o.platform || [])])];
const F = { form: null, orig: null, errors: [], review: null, busy: false, focus: null, custOpen: false };
const blank = (pre = {}) => ({ id: null, version: null, customer: "", handle: "", platform: [], order_number: "", shipping_number: "", order_date: isoDay(), ship_by: "", ship_type: "Standard", status: "Not started", important: "", summary: "", state: "", collection: "", choices: {}, lines: [], ...pre });
const fromOrder = (o) => {
  const lines = [...(o.lines || [])].sort((a, b) => a.line_no - b.line_no).map(lineFromSaved);
  const coll = (o.collections || []).map((n) => [...cat.colls.values()].find((c) => c.name === n || c.id === n)).filter(Boolean)[0];
  return { id: o.id, version: o.version, customer: o.customer || "", handle: o.handle || "", platform: [...(o.platform || [])], order_number: o.order_number || "", shipping_number: o.shipping_number || "", order_date: o.order_date || "", ship_by: o.ship_by || "", ship_type: o.ship_type || "Standard", status: o.status, important: o.important || "", summary: o.summary || "", state: o.state || "", collection: coll ? coll.id : "", choices: {}, lines };
};
const snap = (f) => JSON.stringify(f);
const encSize = (f) => { const e = f.lines.find((l) => l.kind === "pick" && l.product_id === "enclosure"); return e ? e.size_code : ""; };
const encDoorOf = (f) => { const e = f.lines.find((l) => l.kind === "pick" && l.product_id === "enclosure"); return e ? e.option_code || "standard" : "standard"; };
// door options the catalog has for an enclosure size (standard = latch door); a size with only one door shows no choice
const encDoors = (size) => [...new Set(cat.variants.filter((v) => v.product_id === "enclosure" && v.size_code === size && !v.archived).map((v) => v.option_code || "standard"))].sort((a, b) => (a === "standard" ? -1 : 1) - (b === "standard" ? -1 : 1));

// a sale as the platform reported it -> a new order to review: one text line per item (title + the chosen variations), the buyer note as order notes
export function formFromSource(s) {
  const lines = (s.items || []).map((it) => ({ kind: "text", text: [srcTitle(it.title), ...(it.variations || []).map(([, v]) => v), it.personalization || ""].filter(Boolean).join(" - "), qty: Number(it.qty) || 1, note: "", tag: "", untracked: false, src: "paste" }));
  return { customer: s.buyer || "", platform: [s.platform], order_number: s.number, order_date: s.order_date || isoDay(), ship_by: s.ship_by || "", state: s.state || "", summary: s.note || "", lines, source_id: s.id };
}
export function openOrderForm(order = null, focusUid = null, pre = null) {
  const start = () => {
    F.form = order ? fromOrder(order) : blank(pre || {}); F.orig = snap(F.form); F.errors = []; F.review = null; F.focus = focusUid; F.custOpen = false;
    $("#odBinsCard").hidden = false; $("#odTitle").textContent = order ? "Edit order · " + order.customer : "New order";
    formRender(); $("#odBinsCard").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { const el = focusUid ? $(`#odHost [data-k][data-uid="${focusUid}"] input`) : $("#odHost #fCustomer"); if (el) el.focus(); }, 60);
  };
  // the catalog is cached for the session; an item another person added since (pick_variant, Inventory) isn't in it yet, so re-read it when a line points at an unknown item
  const unknown = order && (order.lines || []).some((l) => l.variant_id != null && !cat.varById.get(String(l.variant_id)));
  // and re-read it when it is a few minutes old, so collections and items added on another device show up
  if (cat.opts && !cat.stale && !unknown && Date.now() - (cat.at || 0) < 180000) return start();
  $("#odBinsCard").hidden = false; $("#odHost").innerHTML = `<div class="empty">Loading the catalog…</div>`;
  loadCatalog(true).then(start).catch((e) => { $("#odHost").innerHTML = `<div class="err">⚠ ${esc(db.errText(e))}</div>`; });
}
function closeForm() { F.form = null; $("#odBinsCard").hidden = true; $("#odHost").innerHTML = ""; }

// search for the "Add an item" box: every typed word must start a word of the product's name, an alias, its category or collection
function searchProducts(q) { const qt = toks(q); if (!qt.length) return []; const out = [];
  for (const p of cat.opts.products || []) { if (p.archived) continue; const names = [p.name, ...(p.aliases || [])]; const collN = (p.collections || []).map((id) => (cat.colls.get(id) || {}).name || "").join(" ");
    let best = 0; for (const nm of names) { const nt = toks(nm + " " + (p.category || "") + " " + collN); if (qt.every((w) => nt.some((x) => x.startsWith(w)))) best = Math.max(best, qt.length / nt.length); }
    if (best) out.push({ p, sc: best }); }
  return out.sort((a, b) => b.sc - a.sc || a.p.name.localeCompare(b.p.name)).slice(0, 12); }
const stockOf = (st) => { const v = st && st.v; const r = v && v.notion_id ? store.invById.get(v.notion_id) : null; return r ? (r.in_stock != null ? `${r.in_stock} on shelf` : "not tracked") : ""; };

const tagBtns = (i, l) => `<span class="tags"><button type="button" class="tagbtn" data-tag="gift" data-l="${i}" aria-pressed="${l.tag === "gift"}" title="Gift">🎁 Gift</button><button type="button" class="tagbtn" data-tag="addon" data-l="${i}" aria-pressed="${l.tag === "addon"}" title="Add-on">+ Add-on</button></span>`;
// measurements for a custom-size pick: as entered, in the order the customer gave them
function sizeRow(l, i, p) {
  const ph = /floor|insert/i.test((p && p.category) || "") ? ["W", "L", ""] : ["W", "H", "D"];
  const num = (k, j) => `<input type="number" inputmode="decimal" step="0.01" min="0" data-l="${i}" data-lf="${k}" value="${esc(l[k] ?? "")}" placeholder="${ph[j]}" aria-label="Size ${j + 1}">`;
  return `<div class="szrow"><span class="szl">Custom</span>${num("size_1", 0)}<span>×</span>${num("size_2", 1)}<span>×</span>${num("size_3", 2)}<select data-l="${i}" data-lf="size_unit" aria-label="Unit"><option value="in" ${l.size_unit !== "cm" ? "selected" : ""}>in</option><option value="cm" ${l.size_unit === "cm" ? "selected" : ""}>cm</option></select><select data-l="${i}" data-lf="size_basis" aria-label="What the size is"><option value="piece" ${l.size_basis !== "enclosure" ? "selected" : ""}>piece size</option><option value="enclosure" ${l.size_basis === "enclosure" ? "selected" : ""}>fits enclosure</option></select></div>`;
}
function lineRowHtml(l, i) {
  const q = Number(l.qty) || 1; const state = l.print_state ? ` · <b>${esc(LAB[l.print_state] || l.print_state)}</b>` : ""; const packed = l.packed ? " · packed" : "";
  const noteIn = `<input class="li-note" data-l="${i}" data-lf="note" value="${esc(l.note || "")}" autocomplete="off" aria-label="Note for item ${i + 1}" placeholder="Notes">`;
  const del = `<button type="button" class="x" data-del="${i}" aria-label="Remove item ${i + 1}">✕</button>`;
  if (l.kind === "pick") {
    const p = cat.byProduct.get(l.product_id); const st = pickState(l); const pc = p ? productColors(p) : { any: false, s1: [], s2: [] };
    const sizes = p ? p.size_codes || [] : [];
    const sizeSel = sizes.length > 1 ? `<select data-l="${i}" data-lf="size_code" aria-label="Size">${l.size_code ? "" : `<option value="" selected>—</option>`}${sizes.map((s) => `<option value="${esc(s.code)}" ${s.code === l.size_code ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>` : `<span class="na">One size</span>`;
    const opt = (ids, cur) => `<option value="">—</option>${ids.map((id) => `<option value="${esc(id)}" ${id === cur ? "selected" : ""}>${esc(colorName(id))}</option>`).join("")}`;
    const others = (ids, cur) => { const rest = [...cat.colors.values()].filter((c) => !ids.includes(c.id)); return rest.length ? `<optgroup label="Other colors">${rest.map((c) => `<option value="${esc(c.id)}" ${c.id === cur ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>` : ""; };
    const colorSel = !pc.any ? `<span class="na">One color</span>` : `<div class="colorpair"><select data-l="${i}" data-lf="c1" aria-label="Color 1">${opt(pc.s1, l.c1)}${others(pc.s1, l.c1)}</select>${pc.two ? `<select data-l="${i}" data-lf="c2" aria-label="Color 2">${opt(pc.s2, l.c2)}${others(pc.s2, l.c2)}</select>` : ""}</div>`;
    const word = pickWord(st); const ok = st.status === "variant" || st.status === "creatable";
    const says = l.said ? textCheck(l.said, l, p) : "";
    const small = [says ? `“${esc(l.said)}”` : "", p && p.collections && p.collections.length ? esc((cat.colls.get(p.collections[0]) || {}).name || "") : "", esc(stockOf(st)), l.option_code && l.option_code !== "standard" ? esc(l.option_code) : "", l.src ? esc({ collection: "from collection", addon: "add-on", repeat: "from a past order", paste: "pasted" }[l.src] || "") : ""].filter(Boolean).join(" · ");
    return `<div class="line pick${l.tag ? " t-" + l.tag : ""}" data-k="${i}" ${l.uid ? `data-uid="${l.uid}"` : ""}><div class="nm"><span class="pname"><span class="ta"><input class="li-prod" data-pl="${i}" value="${esc(p ? p.name : l.product_id)}" data-was="${esc(p ? p.name : l.product_id)}" autocomplete="off" aria-label="Item ${i + 1}"><span class="ta-list" hidden></span></span>${tagBtns(i, l)}</span><small>${small}${state}${packed}</small>${word ? `<span class="flag${ok ? " ok" : ""}">${esc(word)}</span>${st.reason === "color not offered" ? `<button type="button" class="btn ghost mini" data-addcat="${i}">Add to catalog</button>` : ""}` : ""}${says ? `<span class="row" style="justify-content:flex-start;gap:6px"><span class="flag">${esc(says)}</span><button type="button" class="btn ghost mini" data-keeppick="${i}" title="The pick is right; the order's words move to the line note">Keep pick</button></span>` : ""}</div>
      <input type="number" min="1" max="99" value="${q}" data-l="${i}" data-lf="qty" aria-label="Quantity">
      <div class="szc">${sizeSel}</div><div class="clc">${colorSel}</div><div class="ntc">${noteIn}</div>${del}${l.size_code === "custom" ? sizeRow(l, i, p) : ""}</div>`;
  }
  const x = RES.get((l.text || "").trim());
  const flag = l.untracked ? `<span class="flag ok">Not tracked</span>` : isEncText(l.text) ? `<span class="flag ok">Enclosure heading</span>` : `<span class="flag${x && ["variant", "creatable", "untracked"].includes(x.status) ? " ok" : ""}">${esc(resolveWord(x))}</span>${x && x.status !== "variant" ? `<button type="button" class="btn ghost mini" data-addcat="${i}">Add to catalog</button>` : ""}`;
  return `<div class="line text${l.tag ? " t-" + l.tag : ""}" data-k="${i}" ${l.uid ? `data-uid="${l.uid}"` : ""}><div class="nm ta"><input class="li-text" data-l="${i}" data-lf="text" value="${esc(l.text)}" autocomplete="off" aria-label="Item ${i + 1}" placeholder="Item as written"><div class="ta-list" hidden></div><small>Not a catalog item${state}${packed}</small><span class="row" style="justify-content:flex-start;gap:6px">${flag}${tagBtns(i, l)}<button type="button" class="btn ghost mini" data-tonotes="${i}" title="Not something to pack: move it to the order notes">→ order notes</button></span></div>
    <input type="number" min="1" max="99" value="${q}" data-l="${i}" data-lf="qty" aria-label="Quantity">
    <div class="szc"><label class="utk"><input type="checkbox" data-l="${i}" data-lf="untracked" ${l.untracked ? "checked" : ""}> Not tracked</label></div><div class="clc"></div><div class="ntc">${noteIn}</div>${del}</div>`;
}

/* What the database will do with a free-text line on save (hq.resolve_lines). Cached by text; a failed check is not cached as a verdict. */
const RES = new Map(); let RES_FAIL_AT = 0;
const resolveFailed = (todo, e) => { RES_FAIL_AT = Date.now(); for (const t of todo) RES.set(t, { status: "error" }); toast("Couldn't check lines against the catalog: " + db.errText(e), true); };
const resolveWord = (x) => {
  if (!x) return "Checking…";
  if (x.status === "error") return "Couldn't check — retrying";
  if (x.status === "variant") return "✓ Matches on save";
  if (x.status === "creatable") return "New in the catalog on save";
  if (x.status === "untracked") return "Not tracked";
  if (x.status === "heading") return "Enclosure heading";
  switch (x.reason) {
    case "needs color": return "Needs a color";
    case "color not offered": return "Not offered in that color — add it in Inventory";
    case "unknown color": return `Unknown color: ${(x.unknown || []).join(", ")}`;
    case "size not offered": return `Not made in ${x.size || "that size"}`;
    case "ambiguous product": return "Which piece? Pick one";
    case "custom size for a product without one": return "No custom size for this piece";
    default: return "Not in the catalog";
  }
};
function resolvePending(host) {
  const f = F.form; if (!f) return;
  if (RES_FAIL_AT && Date.now() - RES_FAIL_AT > 8000) { for (const [t, x] of RES) if (x.status === "error") RES.delete(t); RES_FAIL_AT = 0; }
  const todo = [...new Set(f.lines.filter((l) => l.kind === "text" && !l.untracked && !isEncText(l.text) && (l.text || "").trim() && !RES.has(l.text.trim())).map((l) => l.text.trim()))];
  if (!todo.length) { if (RES_FAIL_AT) setTimeout(() => { if (F.form === f) formRender(); }, 8500); return; }
  db.resolveLines(todo).then((res) => { for (const t of todo) RES.set(t, (res && res[t]) || { status: "unresolved" }); if (F.form === f) formRender(); }).catch((e) => { resolveFailed(todo, e); if (F.form === f) formRender(); });
}

function custCard(f, custs) {
  const n = normName(f.customer); if (!n) return "";
  const c = custs.find((x) => x.key === n || [...x.handles].some((h) => normName(h) === n));
  if (!c) return `<div class="custcard"><span class="chip">New customer</span></div>`;
  const past = c.orders.filter((o) => o.id !== f.id);
  const items = (o) => (o.lines || []).slice().sort((a, b) => a.line_no - b.line_no).map((l) => `${Number(l.qty) > 1 ? l.qty + "× " : ""}${esc(cleanText(l.text))}`).join("<br>");
  return `<div class="custcard"><div class="row"><div><b>${esc(c.name)}</b><div class="sub">${plural(past.length, "past order")}${c.states.size ? " · " + esc([...c.states].join(", ")) : ""}${c.handles.size ? " · " + esc([...c.handles].join(", ")) : ""}${[...c.platforms].length ? " · " + esc([...c.platforms].join(", ")) : ""}</div></div></div>
    ${past.length ? `<details class="more" ${F.custOpen ? "open" : ""} data-custfold><summary>Past orders (${past.length})</summary><div class="tw"><table class="t"><thead><tr><th>Ship by</th><th>Platform</th><th>Items</th><th></th></tr></thead><tbody>${past.slice(0, 5).map((o) => `<tr><td>${esc(fmtDay(o.ship_by))}${o.order_number ? `<br><span class="sub mono">#${esc(o.order_number)}</span>` : ""}</td><td>${(o.platform || []).map(esc).join(", ")}</td><td>${items(o)}</td><td><button type="button" class="btn ghost mini" data-reorder="${esc(o.id)}">Use these items</button></td></tr>`).join("")}</tbody></table></div>${past.length > 5 ? `<div class="sub">${past.length - 5} older on the Customers tab.</div>` : ""}</details>` : ""}</div>`;
}

// redrawing the form keeps the field the person is in (and their place on the page): a pick or a tag tap must not drop focus
const focusKey = (el) => { if (!el || !el.dataset) return ""; const d = el.dataset; if (el.id) return "#" + el.id; if (d.f) return `[data-f="${d.f}"]`; if (d.l != null && d.lf) return `[data-l="${d.l}"][data-lf="${d.lf}"]`; return ""; }; // not the item search box: refocusing it would reopen its list
function formRender() {
  const f = F.form; if (!f) return; const host = $("#odHost");
  const a = document.activeElement; const key = host.contains(a) ? focusKey(a) : ""; const sel = key && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null; const top = window.scrollY;
  formDraw(f, host);
  if (key) { const el = host.querySelector(key); if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } } }
  if (window.scrollY !== top) window.scrollTo(0, top);
}
function formDraw(f, host) {
  const plats = PLATFORMS(); const custs = customers();
  const pieces = f.lines.reduce((a, l) => a + (Number(l.qty) || 1), 0);
  const enc = encSize(f); const encP = cat.byProduct.get("enclosure"); const encSizes = encP ? encP.size_codes || [] : [];
  const colls = [...cat.colls.values()].filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name));
  const coll = f.collection ? cat.colls.get(f.collection) : null;
  const choices = coll ? (enc ? coll.enclosure_choices : coll.choices) || {} : {};
  const addons = (cat.opts.products || []).filter((p) => p.addon != null ? p.addon : /^(Add-on|Kit|Supply)$/.test(p.category || "")).sort((a, b) => a.name.localeCompare(b.name)); // products.addon flags the bar; category only for a catalog read before that flag existed
  host.innerHTML = `<div class="od">
    <div class="grid2">
      <div class="ta"><label class="f">Customer<input id="fCustomer" data-f="customer" value="${esc(f.customer)}" autocomplete="off" placeholder="Name or handle"></label><div class="ta-list" hidden></div></div>
      <label class="f">Order # <span class="opt">(optional)</span><input data-f="order_number" value="${esc(f.order_number)}" autocomplete="off"></label>
      <label class="f">Ship by<input type="date" data-f="ship_by" value="${esc(f.ship_by)}"></label>
    </div>
    <div id="odCust">${custCard(f, custs)}</div>
    <div><div class="lbl">Platform <span class="opt">(required)</span></div><div class="pills${!f.platform.length && F.errors.some((x) => /platform/i.test(x)) ? " srcmiss" : ""}" role="group" aria-label="Platform">${plats.map((p) => `<button type="button" data-plat="${esc(p)}" aria-pressed="${f.platform.includes(p)}">${esc(p)}</button>`).join("")}</div></div>
    <div class="grid2">
      <label class="f">Handle <span class="opt">(optional)</span><input data-f="handle" value="${esc(f.handle)}" autocomplete="off" placeholder="@username"></label>
      <label class="f">State <span class="opt">(optional)</span><input data-f="state" value="${esc(f.state)}" autocomplete="off" placeholder="AL"></label>
      <label class="f">Order date<input type="date" data-f="order_date" value="${esc(f.order_date)}"></label>
      <label class="f">Shipping<select data-f="ship_type"><option ${f.ship_type === "Standard" ? "selected" : ""}>Standard</option><option ${f.ship_type === "Express" ? "selected" : ""}>Express</option></select></label>
      <label class="f">Shipping # <span class="opt">(optional)</span><input data-f="shipping_number" value="${esc(f.shipping_number)}" autocomplete="off"></label>
    </div>
    <div class="grid2">
      <label class="f">Important <span class="opt">(red banner on the card)</span><input data-f="important" value="${esc(f.important)}" autocomplete="off"></label>
      <label class="f fwide">Order notes <span class="opt">(context for the order, not a packable item)</span><textarea data-f="summary" rows="2">${esc(f.summary)}</textarea></label>
    </div>
    ${encSizes.length ? `<div><div class="lbl">Enclosure</div><div class="seg" role="group" aria-label="Enclosure"><button type="button" data-enc="" aria-pressed="${!enc}">None</button>${encSizes.map((s) => `<button type="button" data-enc="${esc(s.code)}" aria-pressed="${enc === s.code}">${esc(s.name)}</button>`).join("")}</div>${enc && encDoors(enc).length > 1 ? `<div class="seg" role="group" aria-label="Door" style="margin-left:8px">${encDoors(enc).map((d) => `<button type="button" data-door="${esc(d)}" aria-pressed="${encDoorOf(f) === d}">${d === "magnetic" ? "Magnetic" : "Latch"}</button>`).join("")}</div>` : ""}</div>` : ""}
    <div class="grid2">
      <label class="f">Collection<select data-f="collection"><option value="">None</option>${colls.map((c) => `<option value="${esc(c.id)}" ${c.id === f.collection ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
      ${Object.keys(choices).map((k) => `<div><div class="lbl">${esc(k)}</div><div class="pills">${(choices[k] || []).map((o) => `<button type="button" data-choice="${esc(k)}" data-opt="${esc(o)}" aria-pressed="${(f.choices[k] || (coll.defaults || {})[k]) === o}">${esc(o)}</button>`).join("")}</div></div>`).join("")}
    </div>
    ${addons.length ? `<div><div class="lbl">Add-ons</div><div class="pills">${addons.map((p) => `<button type="button" class="add" data-addon="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div></div>` : ""}
    <div class="row"><h3>Items <span class="sub">(${plural(pieces, "piece")})</span></h3>${f.lines.length ? `<button type="button" class="btn ghost mini" data-act="clearItems">Clear items</button>` : ""}</div>
    ${f.lines.length ? `<div class="lhead" aria-hidden="true"><span>Item</span><span>Qty</span><span>Size</span><span>Color</span><span>Notes</span><span></span></div>` : ""}
    <div class="lines">${f.lines.map(lineRowHtml).join("") || `<div class="empty">No items yet. Pick a collection, an enclosure, an add-on, or search below.</div>`}</div>
    <div class="ta"><label class="f">Add an item<input id="addItem" autocomplete="off" placeholder="Type a name, e.g. web climb"></label><div class="ta-list" hidden></div></div>
    <details class="more" ${F.review ? "open" : ""}><summary>Paste a list instead</summary>${pasteHtml()}</details>
    <div class="savebar"><div class="errors">${F.errors.map((e) => `<span>${esc(e)}</span>`).join("") || `<span class="sub" style="color:var(--muted);font-weight:500">${f.id ? "Lines keep their printing and packed checks unless the item changes." : "Shelf stock is handed out by ship date; the rest shows as needs printing."}</span>`}</div>
      <button type="button" class="btn ghost" data-act="cancel">Cancel</button><button type="button" class="btn accent" data-act="save" ${F.busy ? "disabled" : ""}>${F.busy ? "Saving…" : f.id ? "Save changes" : "Save order"}</button></div>
  </div>`;
  wireForm(host, custs);
  resolvePending(host);
}
function pasteHtml() {
  const r = F.review;
  if (!r) return `<p class="sub" style="margin-top:0">One item per line. "2x Ghost Hide" or "2 Ghost Hide" sets a quantity.</p><label class="f">Pasted list<textarea id="pasteText" placeholder="2x Ghost Hide&#10;Coffin Hide - Black&#10;Floor Insert - Checkered, Small"></textarea></label><div class="row" style="justify-content:flex-start"><button type="button" class="btn mini" data-act="reviewPaste" ${F.busy ? "disabled" : ""}>${F.busy ? "Checking…" : "Review list"}</button></div>`;
  return `<div class="rev">${r.lines.map((l, i) => { const st = l.line.kind === "pick" ? pickState(l.line) : null; const word = l.line.kind === "pick" ? (st.status === "variant" ? "✓ " + st.name : pickWord(st)) : l.line.untracked ? "Not tracked" : resolveWord(RES.get(l.line.text.trim()));
    return `<div class="revline"><div class="orig">${esc(l.raw)}</div><input type="number" min="1" max="99" value="${l.line.qty}" data-r="${i}" data-rf="qty" aria-label="Quantity"><div class="flag${/✓|Not tracked|New in/.test(word) ? " ok" : " bad"}">${esc(word)}</div><button type="button" class="x" data-rdel="${i}" aria-label="Drop this line">✕</button></div>`; }).join("")}
    <div class="row" style="justify-content:flex-start"><button type="button" class="btn accent mini" data-act="importPaste">Add these to the order</button><button type="button" class="btn ghost mini" data-act="editPaste">Edit the text</button></div></div>`;
}
// a resolve_lines verdict -> form line
function lineFromResolved(text, qty, x) {
  const dims = x && x.dims ? { size_1: x.dims.size_1 ?? "", size_2: x.dims.size_2 ?? "", size_3: x.dims.size_3 ?? "", size_unit: x.dims.size_unit || "in", size_basis: x.dims.size_basis || "piece" } : {};
  if (x && x.status === "variant" && cat.varById.get(String(x.variant_id))) { const v = cat.varById.get(String(x.variant_id)); const c = schemeColors(v.color_scheme_id); return { kind: "pick", product_id: v.product_id, size_code: v.size_code, c1: c.c1, c2: c.c2, option_code: v.option_code || "standard", qty, note: "", untracked: false, src: "paste", said: text, ...dims }; }
  if (x && x.product_id && cat.byProduct.get(x.product_id)) { const a = x.add || {}; const byName = (nm) => { const k = normName(nm); const c = nm && [...cat.colors.values()].find((c) => normName(c.name) === k || (c.aliases || []).some((al) => normName(al) === k)); return c ? c.id : ""; };
    const c = x.color_scheme_id && cat.schemes.get(x.color_scheme_id) ? schemeColors(x.color_scheme_id) : { c1: byName(a.color_1), c2: byName(a.color_2) };
    return { ...pickLine(x.product_id, { size_code: x.size_code }), c1: c.c1, c2: c.c2, qty, src: "paste", said: text, ...dims }; }
  return { kind: "text", text, qty, note: "", untracked: !!(x && x.status === "untracked") || (/\bplants?\b|cocoon|substrate|moss/i.test(text) && !(x && x.status === "variant")), src: "paste" };
}
async function reviewPaste(text) {
  const raws = String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const parsed = raws.map((raw) => { let s = cleanText(raw), qty = 1, m;
    if ((m = s.match(/^(\d{1,3})\s*[x×]\s*/i)) || (m = s.match(/^(\d{1,3})\s+(?=[a-z])/i))) { qty = +m[1]; s = s.slice(m[0].length); }
    else if ((m = s.match(/\s*[x×]\s*(\d{1,3})\s*$/i))) { qty = +m[1]; s = s.slice(0, m.index).trim(); }
    return { raw, text: s, qty }; });
  const todo = [...new Set(parsed.map((p) => p.text).filter((t) => t && !RES.has(t)))];
  if (todo.length) { try { const res = await db.resolveLines(todo); for (const t of todo) RES.set(t, (res && res[t]) || { status: "unresolved" }); } catch (e) { resolveFailed(todo, e); } }
  F.review = { text, lines: parsed.map((p) => ({ raw: p.raw, line: lineFromResolved(p.text, p.qty, RES.get(p.text)) })) };
}
// the collection's pieces as form lines (hq.pick_collection); the enclosure line is kept in step with the Enclosure switch
async function applyCollection(f) {
  const coll = f.collection ? cat.colls.get(f.collection) : null; if (!coll) return;
  const enc = encSize(f); const door = encDoorOf(f); const form = enc && coll.sells_enclosure ? "enclosure" : coll.sells_accessory_set ? "accessory" : "enclosure";
  const choices = { ...(form === "enclosure" ? coll.defaults || {} : {}), ...f.choices };
  const res = await db.pickCollection({ collection: coll.id, form, size: enc || undefined, choices });
  const fresh = (res.lines || []).map((x) => { const c = x.color_scheme_id ? schemeColors(x.color_scheme_id) : { c1: "", c2: "" }; return { kind: "pick", product_id: x.product_id, size_code: x.size || (x.product_id === "enclosure" ? enc : undefined), c1: c.c1, c2: c.c2, option_code: x.product_id === "enclosure" && encDoors(x.size || enc).includes(door) ? door : x.option || "standard", qty: Number(x.qty) || 1, note: "", untracked: false, src: x.product_id === "enclosure" ? "enclosure" : "collection" }; })
    .map((l) => ({ ...l, size_code: l.size_code || defaultSize(cat.byProduct.get(l.product_id) || {}, enc) }));
  const kept = f.lines.filter((l) => l.src !== "collection" && !(l.kind === "pick" && l.product_id === "enclosure" && fresh.some((x) => x.product_id === "enclosure")));
  if (form === "enclosure" && enc && !fresh.some((x) => x.product_id === "enclosure")) fresh.unshift(pickLine("enclosure", { size_code: enc, src: "enclosure" }));
  f.lines = [...fresh.filter((x) => x.product_id === "enclosure"), ...kept.filter(isEncLine), ...fresh.filter((x) => x.product_id !== "enclosure"), ...kept.filter((l) => !isEncLine(l))];
}
function setDoor(f, door) { const e = f.lines.find((l) => l.kind === "pick" && l.product_id === "enclosure"); if (e) e.option_code = door; }
function setEnclosure(f, size) {
  const i = f.lines.findIndex((l) => l.kind === "pick" && l.product_id === "enclosure");
  if (!size) { if (i >= 0) f.lines.splice(i, 1); return; }
  if (i >= 0) { f.lines[i].size_code = size; if (!encDoors(size).includes(f.lines[i].option_code || "standard")) f.lines[i].option_code = "standard"; } else f.lines.unshift(pickLine("enclosure", { size_code: size, src: "enclosure" }));
  for (const l of f.lines) if (l.kind === "pick" && l.product_id !== "enclosure") { const p = cat.byProduct.get(l.product_id); if (p && (p.size_codes || []).some((s) => s.code === size) && l.size_code !== "custom") l.size_code = size; }
}

function wireForm(host, custs) {
  const f = F.form;
  const read = () => { host.querySelectorAll("[data-f]").forEach((el) => { const k = el.dataset.f; f[k] = el.type === "checkbox" ? el.checked : el.value; }); host.querySelectorAll("[data-l][data-lf]").forEach((el) => { const l = f.lines[+el.dataset.l]; if (!l) return; const k = el.dataset.lf; if (k === "qty") l.qty = Math.max(1, Math.min(99, Math.floor(+el.value) || 1)); else if (k === "untracked") l.untracked = el.checked; else if (k === "note") l.note = el.value; else if (k === "text") { l.text = el.value; } else l[k] = el.value; }); };
  // typeahead
  const ta = (input, list, items, pick) => {
    const show = () => { const q = input.value.trim(); const hits = q ? items(q) : []; if (!hits.length) { list.hidden = true; return; } list.innerHTML = hits.map((h, i) => `<button type="button" data-i="${i}" class="${i === 0 ? "on" : ""}">${h.html}</button>`).join(""); list.hidden = false; list._hits = hits; };
    input.addEventListener("input", show); input.addEventListener("focus", show);
    input.addEventListener("keydown", (e) => { const hits = list._hits || []; if (list.hidden || !hits.length) return; const on = [...list.children].findIndex((b) => b.classList.contains("on")); if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = Math.max(0, Math.min(hits.length - 1, on + (e.key === "ArrowDown" ? 1 : -1))); [...list.children].forEach((b, i) => b.classList.toggle("on", i === n)); } else if (e.key === "Enter" && on >= 0 && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); pick(hits[on]); } else if (e.key === "Escape") list.hidden = true; });
    list.addEventListener("mousedown", (e) => { const b = e.target.closest("[data-i]"); if (b) { e.preventDefault(); pick((list._hits || [])[+b.dataset.i]); } });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
  };
  const cIn = host.querySelector("#fCustomer");
  if (cIn) { ta(cIn, cIn.closest(".ta").querySelector(".ta-list"), (q) => { const n = normName(q); if (custs.some((c) => c.key === n)) return []; return custs.filter((c) => normName([c.name, ...c.handles].join(" ")).includes(n)).slice(0, 8).map((c) => ({ c, html: `<span><b>${esc(c.name)}</b>${c.handles.size ? ` <span class="sub">${esc([...c.handles].join(", "))}</span>` : ""}</span><span class="sub">${plural(c.orders.length, "order")}${c.states.size ? " · " + esc([...c.states][0]) : ""}</span>` })); }, (h) => { read(); f.customer = h.c.name; if (!f.platform.length && h.c.last.platform) f.platform = [...h.c.last.platform]; if (!f.state) f.state = [...h.c.states][0] || ""; if (!f.handle) f.handle = [...h.c.handles][0] || ""; formRender(); });
    cIn.addEventListener("input", () => { f.customer = cIn.value; const c = host.querySelector("#odCust"); if (c) c.innerHTML = custCard(f, custs); }); }
  const prodHits = (q) => searchProducts(q).map((h) => ({ p: h.p, html: `<span>${esc(h.p.name)}</span><span class="sub">${esc(h.p.category || "")}${h.p.collections && h.p.collections.length ? " · " + esc(h.p.collections.map((id) => (cat.colls.get(id) || {}).name || id).join(", ")) : ""}</span>` }));
  const addIn = host.querySelector("#addItem");
  const addLine = (line) => { read(); f.lines.push(line); formRender(); setTimeout(() => { const el = $("#odHost #addItem"); if (el) el.focus(); }, 30); };
  ta(addIn, addIn.closest(".ta").querySelector(".ta-list"), prodHits, (h) => addLine(pickLine(h.p.id, { size_code: encSize(f) || undefined })));
  addIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && addIn.value.trim() && (addIn.closest(".ta").querySelector(".ta-list").hidden)) { e.preventDefault(); const hits = searchProducts(addIn.value); if (hits.length === 1) addLine(pickLine(hits[0].p.id, { size_code: encSize(f) || undefined })); else addLine({ kind: "text", text: addIn.value.trim(), qty: 1, note: "", untracked: false }); } });
  host.querySelectorAll(".li-text").forEach((inp) => ta(inp, inp.closest(".ta").querySelector(".ta-list"), prodHits, (h) => { read(); const i = +inp.dataset.l; const old = f.lines[i]; f.lines[i] = { ...pickLine(h.p.id, { size_code: encSize(f) || undefined }), uid: old.uid, qty: old.qty, note: old.note, group_uid: old.group_uid, print_state: old.print_state, packed: old.packed, said: cleanText(old.text) }; formRender(); }));
  // change a catalog line's item in place: keeps qty, notes, tag and its place; the old piece's print/pack status doesn't carry over (save_order resets it)
  host.querySelectorAll(".li-prod").forEach((inp) => { ta(inp, inp.closest(".ta").querySelector(".ta-list"), prodHits, (h) => { read(); const i = +inp.dataset.pl; const old = f.lines[i]; if (!old || h.p.id === old.product_id) { formRender(); return; }
    const keep = (h.p.size_codes || []).some((s) => s.code === old.size_code) ? old.size_code : encSize(f) || undefined;
    f.lines[i] = { ...pickLine(h.p.id, { size_code: keep }), uid: old.uid, qty: old.qty, note: old.note, tag: old.tag, group_uid: old.group_uid, src: old.src, said: old.said || "" }; formRender(); });
    inp.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== inp) inp.value = inp.dataset.was; }, 150)); });
  host.onchange = async (e) => { const t = e.target;
    if (t.matches("[data-f='collection']")) { const prev = f.collection; read(); const next = f.collection; f.collection = prev;
      if (next && f.lines.some((l) => l.src !== "collection" && l.src !== "enclosure") && !(await confirmBox({ title: "Replace the items?", body: "The collection's pieces replace what's listed now.", ok: "Replace" }))) { formRender(); return; }
      f.collection = next; f.choices = {}; if (!next) f.lines = f.lines.filter((l) => l.src !== "collection"); else { f.lines = f.lines.filter((l) => l.src === "collection" || l.src === "enclosure"); try { await applyCollection(f); } catch (x) { f.collection = prev; toast(db.errText(x), true); } } formRender(); return; }
    if (t.matches("[data-f],[data-l]")) { read(); if (t.dataset.lf && !["qty", "note", "size_1", "size_2", "size_3"].includes(t.dataset.lf)) formRender(); } if (t.matches("[data-r]")) { const l = F.review.lines[+t.dataset.r]; const k = t.dataset.rf; if (k === "qty") l.line.qty = Math.max(1, +t.value || 1); } };
  host.ontoggle = (e) => { if (e.target.matches("[data-custfold]")) F.custOpen = e.target.open; };
  host.onclick = async (e) => {
    const t = e.target; let b;
    if ((b = t.closest("[data-plat]"))) { read(); const p = b.dataset.plat; f.platform = f.platform.includes(p) ? f.platform.filter((x) => x !== p) : [...f.platform, p]; formRender(); return; }
    if ((b = t.closest("[data-door]"))) { read(); setDoor(f, b.dataset.door); formRender(); return; }
    if ((b = t.closest("[data-enc]"))) { read(); setEnclosure(f, b.dataset.enc); if (f.collection) { try { await applyCollection(f); } catch (x) { toast(db.errText(x), true); } } formRender(); return; }
    if ((b = t.closest("[data-choice]"))) { read(); f.choices = { ...f.choices, [b.dataset.choice]: b.dataset.opt }; try { await applyCollection(f); } catch (x) { toast(db.errText(x), true); } formRender(); return; }
    if ((b = t.closest("[data-addon]"))) { read(); f.lines.push(pickLine(b.dataset.addon, { src: "addon", tag: "addon" })); formRender(); return; }
    if ((b = t.closest("[data-reorder]"))) { read(); const o = store.orders.find((x) => x.id === b.dataset.reorder); if (!o) return; const lines = [...(o.lines || [])].sort((x, y) => x.line_no - y.line_no).map(lineFromSaved).map((l) => ({ ...l, uid: undefined, group_uid: null, print_state: undefined, packed: undefined, src: "repeat" }));
      if (f.lines.length && !(await confirmBox({ title: "Replace the items?", body: "The past order's items replace what's listed now.", ok: "Replace" }))) return; f.lines = lines; formRender(); return; }
    if ((b = t.closest("[data-tag]"))) { read(); const l = f.lines[+b.dataset.l]; if (l) l.tag = l.tag === b.dataset.tag ? "" : b.dataset.tag; formRender(); return; }
    if ((b = t.closest("[data-del]"))) { read(); f.lines.splice(+b.dataset.del, 1); formRender(); return; }
    if ((b = t.closest("[data-keeppick]"))) { read(); const l = f.lines[+b.dataset.keeppick]; if (l && l.said) { l.note = [l.note, "Order said: " + l.said].map((x) => String(x || "").trim()).filter(Boolean).join(" · "); l.said = ""; } formRender(); return; }
    if ((b = t.closest("[data-tonotes]"))) { read(); const l = f.lines[+b.dataset.tonotes]; const txt = [cleanText(l.text), l.note].map((x) => String(x || "").trim()).filter(Boolean).join(" — "); f.summary = [f.summary.trim(), txt].filter(Boolean).join("\n"); f.lines.splice(+b.dataset.tonotes, 1); formRender(); return; }
    if ((b = t.closest("[data-addcat]"))) { read(); const i = +b.dataset.addcat; const l = f.lines[i]; if (!l) return;
      const p = l.kind === "pick" ? cat.byProduct.get(l.product_id) : null; const x = l.kind === "text" ? RES.get(l.text.trim()) || {} : {}; const a = x.add || {};
      const pre = l.kind === "pick" ? { text: p ? p.name : "", product: p ? p.name : "", size: p ? sizeName(p, l.size_code) : "", color_1: colorName(l.c1), color_2: colorName(l.c2) } : { text: l.text, product: a.product || "", size: a.size || "", color_1: a.color_1 || "", color_2: a.color_2 || "" };
      import("./inventory.js").then(({ addToCatalog }) => addToCatalog(pre, async (id) => { if (F.form !== f) return; await loadCatalog(true); const ln = f.lines[i]; const v = cat.varByNotion.get(id); if (ln && v) { const c = schemeColors(v.color_scheme_id); f.lines[i] = { ...ln, kind: "pick", product_id: v.product_id, size_code: v.size_code, c1: c.c1, c2: c.c2, option_code: v.option_code || "standard", untracked: false, said: ln.kind === "text" ? cleanText(ln.text) : ln.said || "" }; delete f.lines[i].text; } if (ln && ln.kind === "text") RES.delete(ln.text.trim()); formRender(); })); return; }
    if ((b = t.closest("[data-rdel]"))) { F.review.lines.splice(+b.dataset.rdel, 1); formRender(); return; }
    const act = (t.closest("[data-act]") || {}).dataset?.act; if (!act) return;
    if (act === "clearItems") { read(); f.lines = []; formRender(); }
    if (act === "cancel") { if (snap(f) !== F.orig && !(await confirmBox({ title: "Discard changes?", body: "This order hasn't been saved.", ok: "Discard", danger: true }))) return; closeForm(); }
    if (act === "reviewPaste") { read(); const txt = host.querySelector("#pasteText").value; F.busy = true; formRender(); await reviewPaste(txt); F.busy = false; formRender(); }
    if (act === "editPaste") { const txt = F.review.text; F.review = null; formRender(); const ta2 = $("#odHost #pasteText"); if (ta2) ta2.value = txt; }
    if (act === "importPaste") { read(); for (const l of F.review.lines) f.lines.push(l.line); F.review = null; formRender(); }
    if (act === "save") { read(); await saveForm(); }
  };
}
function validate(f) {
  const errs = []; if (!f.customer.trim()) errs.push("Add the customer's name"); if (!f.platform.length) errs.push("Pick the platform the order came from"); if (!f.ship_by) errs.push("Pick a ship-by date"); if (!f.lines.length) errs.push("Add at least one item");
  f.lines.forEach((l, i) => { if (l.kind === "text" && !String(l.text).trim()) errs.push(`Line ${i + 1} has no text`); if (l.kind === "pick" && l.size_code === "custom" && !(Number(l.size_1) > 0)) errs.push(`Line ${i + 1}: custom size needs its measurements`); if (l.kind === "pick" && !l.size_code && ((cat.byProduct.get(l.product_id) || {}).size_codes || []).length > 1) errs.push(`Line ${i + 1}: pick a size`); });
  return errs;
}
// form lines -> save_order lines. Catalog picks carry a variant id; a pick the catalog doesn't have yet is made first (hq.pick_variant make).
async function linesForSave(ff, make = true) {
  const uids = new Set(ff.lines.map((l) => l.uid).filter(Boolean)); const out = [];
  for (const l of ff.lines) {
    const o = { qty: Number(l.qty) || 1 }; if (l.uid) o.uid = l.uid; if (l.tag) o.tag = l.tag; if (l.note && l.note.trim()) o.note = l.note.trim(); if (l.group_uid && uids.has(l.group_uid)) o.group_uid = l.group_uid;
    if (l.kind === "pick") {
      let st = pickState(l);
      if (st.status === "creatable" && make) { const r = await db.pickVariant({ product_id: l.product_id, size_code: st.size, color_1: l.c1 || null, color_2: l.c2 || null, option_code: l.option_code || "standard", make: true }); if (r && r.status === "variant") { st = { status: "variant", name: r.name, v: { id: r.variant_id } }; invalidateCatalog(); } else throw new Error(`${(cat.byProduct.get(l.product_id) || {}).name || l.product_id}: ${pickWord({ status: "unresolved", ...(r || {}) }) || (r && r.error) || "couldn't be added to the catalog"}`); }
      // the line's text is what the order said; the catalog name only when the line never had words (the server checks the pick against the words)
      if (st.status === "variant") { o.text = l.said || st.name; o.variant_id = st.v.id; }
      else { const p = cat.byProduct.get(l.product_id) || { name: l.product_id }; const parts = [l.size_code && l.size_code !== "standard" ? sizeName(p, l.size_code) : "", [colorName(l.c1), colorName(l.c2)].filter(Boolean).join(" + ")].filter(Boolean); o.text = l.said || p.name + (parts.length ? ` (${parts.join(", ")})` : ""); }
      const cz = l.size_code === "custom"; o.size_1 = cz && l.size_1 !== "" ? Number(l.size_1) : null; o.size_2 = cz && l.size_2 !== "" ? Number(l.size_2) : null; o.size_3 = cz && l.size_3 !== "" ? Number(l.size_3) : null; o.size_unit = cz ? l.size_unit || "in" : "in"; o.size_basis = cz ? l.size_basis || "piece" : "piece";
    } else { o.text = String(l.text).trim(); if (l.inv) o.notion_inventory_id = l.inv; if (l.untracked && !l.inv) o.untracked = true; }
    out.push(o);
  }
  return out;
}
async function saveForm() {
  const f = F.form; F.errors = validate(f); if (F.errors.length) { formRender(); return; }
  F.busy = true; formRender();
  const fields = ["customer", "handle", "platform", "order_number", "shipping_number", "order_date", "ship_by", "ship_type", "important", "summary", "state"];
  const orig = JSON.parse(F.orig);
  const collName = f.collection && cat.colls.get(f.collection) ? [cat.colls.get(f.collection).name] : [];
  try {
    const lines = await linesForSave(f);
    const collections = [...new Set([...collName, ...lines.map((l) => { const v = l.variant_id != null && cat.varById.get(String(l.variant_id)); const p = v && cat.byProduct.get(v.product_id); return p && p.collections && p.collections.length ? (cat.colls.get(p.collections[0]) || {}).name : null; }).filter(Boolean)])];
    if (!f.id) {
      const p = { customer: f.customer.trim(), handle: f.handle.trim() || null, platform: f.platform, order_number: f.order_number.trim() || null, shipping_number: f.shipping_number.trim() || null, order_date: f.order_date || null, ship_by: f.ship_by, ship_type: f.ship_type, status: "Not started", notes: lines.map((l) => l.text).join("\n"), important: f.important.trim() || null, summary: f.summary.trim() || null, freebie: [], items: [], collections, order_type: [], state: f.state.trim().toUpperCase() || null, lines };
      p.freebie = lines.filter((l) => l.tag === "gift").map((l) => l.text);
      const r = await db.saveOrder(p); F.busy = false;
      // entered from a sale: link the sale to the new order (the order then carries the Review flag until confirmed)
      if (f.source_id && r && r.id) { try { await db.linkSource(f.source_id, r.id); } catch (x) { toast("Saved, but the sale could not be linked: " + db.errText(x), true); } }
      if (r && Array.isArray(r.duplicates) && r.duplicates.length) toast(`Saved. Order #${f.order_number} is also on: ${r.duplicates.map((d) => d.customer).join(", ")}`, true); else toast(`Saved ${f.customer.trim()}${r && r.unmatched ? ` · ${plural(r.unmatched, "line")} not in the catalog` : ""}`);
      closeForm(); await load(); if (cat.stale) await loadCatalog(); return;
    }
    // edit: apply only what changed, on top of the freshest copy of the order
    const changed = fields.filter((k) => JSON.stringify(f[k]) !== JSON.stringify(orig[k]));
    const origLines = (await linesForSave(orig, false)).map((l) => JSON.stringify(l)).join("\n"); const linesChanged = lines.map((l) => JSON.stringify(l)).join("\n") !== origLines;
    if (!changed.length && !linesChanged) { F.busy = false; closeForm(); toast("No changes"); return; }
    const r = await db.saveWithRetry(f.id, (p) => {
      const out = { ...p };
      for (const k of changed) { let v = f[k]; if (typeof v === "string") { v = v.trim(); if (k === "state") v = v.toUpperCase(); if (!v && k !== "customer") v = null; } out[k] = v; }
      if (linesChanged) { out.lines = lines; out.collections = collections; out.notes = lines.map((l) => l.text).join("\n"); out.freebie = lines.filter((l) => l.tag === "gift").map((l) => l.text); }
      return out;
    });
    F.busy = false;
    if (r && Array.isArray(r.duplicates) && r.duplicates.length) toast(`Saved. Order #${f.order_number} is also on: ${r.duplicates.map((d) => d.customer).join(", ")}`, true); else toast(`Saved ${f.customer.trim()}${r && r.unmatched ? ` · ${plural(r.unmatched, "line")} not in the catalog` : ""}`);
    closeForm(); await reloadOrder(f.id); if (cat.stale) await loadCatalog();
  } catch (e) { F.busy = false; F.errors = [db.errText(e)]; formRender(); }
}

/* ===================== boot for this module ===================== */
export function init() {
  binWire();
  $("#binNew").onclick = () => openOrderForm(null);
  $("#odClose").onclick = async () => { if (F.form && snap(F.form) !== F.orig && !(await confirmBox({ title: "Discard changes?", body: "This order hasn't been saved.", ok: "Discard", danger: true }))) return; closeForm(); };
  onChange(() => { binRender(); custRender(); });
}
