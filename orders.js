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

export function modal(html, { label = "Dialog", wide = false } = {}) {
  const d = document.createElement("div"); d.className = "obmodal"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", label);
  d.innerHTML = `<div class="obmodal-card${wide ? " wide" : ""}">${html}</div>`;
  const close = () => { d.remove(); document.removeEventListener("keydown", key); };
  const key = (e) => { if (e.key === "Escape") close(); };
  d.addEventListener("click", (e) => { if (e.target === d) close(); });
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
export const store = { orders: [], open: [], inv: [], invById: new Map(), loadedAt: null, err: "", errs: {}, listeners: new Set(), busy: new Set() };
export const onChange = (fn) => { store.listeners.add(fn); return () => store.listeners.delete(fn); };
export function emit() { for (const fn of store.listeners) { try { fn(); } catch (e) { console.error(e); } } }
export const setErr = (key, msg) => { if (msg) store.errs[key] = msg; else delete store.errs[key]; };

export async function load() {
  try {
    const [orders, inv] = await Promise.all([db.readOrders("all"), db.inventoryRows()]);
    store.orders = Array.isArray(orders) ? orders : [];
    store.inv = Array.isArray(inv) ? inv : [];
    store.invById = new Map(store.inv.map((r) => [r.id, r]));
    store.loadedAt = new Date(); store.err = "";
    recompute();
  } catch (e) { store.err = db.errText(e); }
  emit();
}
export async function reloadOrder(id) {
  try { const o = await db.readOrder(id); const i = store.orders.findIndex((x) => x.id === id); if (o) { if (i >= 0) store.orders[i] = o; else store.orders.push(o); } else if (i >= 0) store.orders.splice(i, 1); recompute(); }
  catch (e) { store.err = db.errText(e); }
  emit();
}
export async function reloadInventory() { try { const inv = await db.inventoryRows(); store.inv = Array.isArray(inv) ? inv : []; store.invById = new Map(store.inv.map((r) => [r.id, r])); recompute(); } catch (e) { store.err = db.errText(e); } emit(); }

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
  const t = cleanText(l.text);
  if (isEncText(t)) return "enc";
  if (l.match === "untracked") return "stock";
  if (NOT_PRINTED.test(t) && !/\b(hide|ledge|climb|floor|insert|cauldron|bowl|feeder)\b/i.test(t.replace(/starter\s*kit/i, ""))) return "stock";
  return "print";
}
export const isCustom = (t) => /custom|\d+(\.\d+)?\s*(cm|mm|in\b|inch|"|”|″)|\d\s*[x×]\s*\d/i.test(String(t || ""));
export const invRowOf = (l) => (l.notion_inventory_id ? store.invById.get(l.notion_inventory_id) : null) || null;

// Inventory item names: "Gothic - Web Climb (Small, Black)" -> base, size, color
export const SIZES = ["Small", "Large", "Sling Size", "Standard", "Custom", "Default Size"];
export function splitName(name) {
  const m = String(name || "").match(/^(.*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/);
  if (!m) return { base: String(name || "").trim(), size: "", color: "" };
  const parts = m[2].split(/,\s*(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
  const sizes = parts.filter((p) => SIZES.some((s) => s.toLowerCase() === p.toLowerCase()));
  const colors = parts.filter((p) => !sizes.includes(p));
  return { base: m[1].trim(), size: sizes[0] || "", color: colors.join(" + ") };
}
export const sizeLabel = (s) => (!s || /^(standard|default size)$/i.test(s) ? "Small" : s === "Sling Size" ? "Sling" : s);

// spec from a line: inventory row name when matched, else the line text itself
export function lineSpec(l) {
  const r = invRowOf(l);
  if (r) { const sp = splitName(r.item); return { name: sp.base, size: sp.size, color: sp.color, inv: r.id, custom: false }; }
  const t = cleanText(l.text).replace(/^\d{1,2}\s*[x×]?\s+(?=[a-z])/i, "");
  const parts = /\s[-–]\s/.test(t) ? t.split(/\s[-–]\s/) : t.split(/\s*,\s*/);
  const name = parts.shift().replace(/\(.*?\)/g, "").trim(); const det = parts.join(", ");
  const sz = (det.match(/sling(?:\s*size)?|small|large|standard/i) || [""])[0];
  const color = det.replace(/sling(?:\s*size)?|small|large|standard|custom/ig, "").replace(/^[,\s]+|[,\s]+$/g, "").replace(/,\s*,/g, ",").trim();
  return { name, size: sz ? (sz.toLowerCase().startsWith("sling") ? "Sling Size" : sz[0].toUpperCase() + sz.slice(1).toLowerCase()) : (isCustom(t) ? "Custom" : ""), color, inv: null, custom: isCustom(t) };
}

/* Shelf allocation: what the shelf covers, in ship-date order. Stock numbers come from the server; this only hands them out. */
export const alloc = new Map(); // uid -> qty from shelf
export const owed = new Map();  // inv id -> pieces open orders need from it
export function recompute() {
  store.open = store.orders.filter((o) => o.status !== "Done").sort(rank);
  alloc.clear(); owed.clear();
  const left = new Map(); for (const r of store.inv) if (r.in_stock != null) left.set(r.id, Math.max(0, Number(r.in_stock) || 0));
  for (const o of store.open) for (const l of o.lines || []) {
    const r = invRowOf(l); if (!r || r.in_stock == null) continue;
    const kind = lineKind(l);
    if (kind === "print" && (l.print_state || "") !== "" ) continue;          // printed / printing / needs printing: never from the shelf
    if (kind === "print" && l.packed && l.packed_from === "print") continue;  // packed a fresh print
    if (kind === "print" && isCustom(l.text)) continue;
    owed.set(r.id, (owed.get(r.id) || 0) + (Number(l.qty) || 1));
    const have = left.get(r.id) || 0; const take = Math.min(have, Number(l.qty) || 1);
    if (take > 0) { alloc.set(l.uid, take); left.set(r.id, have - take); }
  }
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
    const done = await act(key, async () => { const r = await db.saveWithRetry(o.id, (p) => ({ ...p, status: "Done" }), { done: true, moves: mv }); recentDone.unshift({ id: o.id, customer: o.customer, prev: obPick(o.status), at: Date.now(), epoch: r && r.epoch }); }, { reload: o.id });
    if (done) toast(`${o.customer} → Done${mv.length ? ". Took " + plural(mv.reduce((a, m) => a + m.qty, 0), "piece") + " off the shelf" : ""}`);
    await reloadInventory();
    return done;
  }
  const ok = await act(key, () => db.saveWithRetry(o.id, (p) => ({ ...p, status })), { reload: o.id });
  if (ok) toast(`${o.customer} → ${status}`);
  return ok;
}
export const recentDone = [];
export async function undoDone(id) {
  const q = recentDone.find((x) => x.id === id); const status = q && q.prev && q.prev !== "Done" ? q.prev : "Not started";
  const ok = await act("o:" + id, () => db.saveWithRetry(id, (p) => ({ ...p, status }), { undo: true }), { reload: id });
  if (ok) { const i = recentDone.findIndex((x) => x.id === id); if (i >= 0) recentDone.splice(i, 1); toast(((q && q.customer) || "Order") + " is back on the board. Shelf pieces were put back"); await reloadInventory(); }
  else toast("Undo didn't save: " + (store.errs["o:" + id] || ""), true);
  return ok;
}

/* ===================== Bin View ===================== */
const BIN = { days: [], open: null, stOpen: null, layout: "cols", pinned: {} };
try { BIN.layout = localStorage.getItem("spood.bin.layout") || "cols"; } catch (e) {}
const SV = (d, cls) => `<span class="bvicon ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
const IC = { run: '<path d="M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z"/><path d="M12 7v5l3 2"/>', done: '<path d="M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>', shelf: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/>', out: '<path d="M20 11a8 8 0 0 0-14.9-4"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 4"/><path d="M20 20v-4h-4"/>', shelfunit: '<path d="M4 3v18"/><path d="M20 3v18"/><path d="M4 9h16"/><path d="M4 15h16"/><path d="M4 21h16"/>' };
const LAB = { print: "Needs printing", printing: "Printing", printed: "Printed", shelf: "Pull from shelf", packed: "Packed", out: "Out of stock", none: "", head: "" };
const encHead = (t) => { const m = cleanText(t).match(/^(?:(\w+)\s+)?(?:complete\s+)?enclosure(s)?\s*[-–:]?\s*(large|small)?/i); if (!m) return cleanText(t); const n = { two: 2, three: 3, four: 4 }[String(m[1] || "").toLowerCase()] || (/^\d+$/.test(m[1] || "") ? m[1] : ""); return (n ? n + " " : "") + (m[3] ? m[3].toUpperCase() + " " : "") + "ENCLOSURE" + (m[2] || n ? "S" : ""); };

// lines on other open orders holding the same item that's printed/printing/on the shelf (latest ship date first)
function takeFrom(o, l) {
  const r = invRowOf(l); const me = normName(cleanText(l.text)); const out = [];
  for (const x of store.open) { if (x.id === o.id) continue; for (const m of x.lines || []) { const same = (r && m.notion_inventory_id === r.id) || normName(cleanText(m.text)) === me; if (!same || m.packed) continue; const e = eff(m); if (e.st === "printed" || e.st === "printing" || e.st === "shelf") out.push({ o: x, l: m, st: e.st }); } }
  return out.sort((a, b) => shipBy(b.o).localeCompare(shipBy(a.o)));
}
export const hooks = {}; // set by the page: { lanes: () => [{printer, queued, printing}], queue: (lineUids, printer, start) => count }
function queueDialog(o, l) {
  const like = alsoPrint(o, l); const lanes = hooks.lanes ? hooks.lanes() : [];
  const m = modal(`<h3>Add to print queue</h3><p class="sub">${esc(cleanText(l.text))} · ${esc(o.customer)}</p>
    <form class="namebox"><label class="sub">Printer<select id="qPrinter">${lanes.map((x) => `<option value="${x.printer}">Printer ${x.printer}${x.printing ? " · printing" : ""}${x.queued ? ` · ${x.queued} queued` : ""}</option>`).join("")}</select></label>
    ${like.length ? `<label class="allto"><input type="checkbox" id="qLike" checked> Also queue ${plural(like.length, "like item")} from other orders</label>` : ""}
    <label class="allto"><input type="checkbox" id="qStart" checked> Start printing now</label>
    <p class="err" id="qErr"></p><div class="row"><button type="submit" class="btn accent">Queue</button><button type="button" class="btn ghost" data-close>Cancel</button></div></form>`, { label: "Add to print queue" });
  const q = (s) => m.el.querySelector(s); q("[data-close]").onclick = m.close;
  q("form").onsubmit = (e) => { e.preventDefault(); const uids = [l.uid, ...(q("#qLike") && q("#qLike").checked ? like.map((x) => x.l.uid) : [])];
    try { const n = hooks.queue(uids, q("#qPrinter").value, q("#qStart").checked); m.close(); toast(`${plural(n, "piece")} → Printer ${q("#qPrinter").value}${q("#qStart").checked ? ", printing" : ", queued"}`); } catch (err) { q("#qErr").textContent = err.message; } };
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

function lineHtml(o, l) {
  const e = eff(l); const kind = e.kind; const head = kind === "enc"; const key = l.uid; const open = BIN.open === key; const busy = store.busy.has("l:" + key);
  const canMark = kind === "print"; const packable = canPack(l); const pull = e.st === "shelf" || (e.st === "packed" && e.from === "shelf");
  const cls = (e.st === "packed" ? "s-packed " + (e.from === "shelf" ? "s-shelf" : "s-done") : e.st === "print" ? "s-print" : e.st === "printing" ? "s-printing" : e.st === "printed" ? "s-done" : e.st === "shelf" ? "s-shelf" : e.st === "out" ? "s-out" : "") + (head ? " s-head" : "");
  const r = invRowOf(l); const qty = Number(l.qty) || 1;
  const name = r ? splitName(r.item) : null; const label = head ? encHead(l.text) : (qty > 1 ? qty + " × " : "") + (name ? name.base + (name.size || name.color ? ` (${[name.size, name.color].filter(Boolean).join(", ")})` : "") : cleanText(l.text).replace(/^\d{1,2}\s*[x×]?\s+(?=[a-z])/i, ""));
  const icon = e.st === "packed" ? "" : e.st === "printing" ? SV(IC.run, "f-run") : e.st === "printed" ? SV(IC.done, "f-done") : e.st === "shelf" ? SV(IC.shelf, "f-shelf") : e.st === "out" ? SV(IC.out, "f-out") : "";
  const sub = e.st === "out" ? `<span class="bvsub">${(r && Number(r.in_stock) > 0 ? "Reserved for earlier orders" : "Out of stock")}${e.a ? ` · ${e.a} of ${qty} on the shelf` : ""}</span>` : e.part ? `<span class="bvsub">${e.a} of ${qty} on the shelf · print ${qty - e.a}</span>` : (l.match === "unmatched" && !head ? `<span class="bvsub">Not in the catalog</span>` : "");
  const tip = `${e.st === "packed" ? "Packed" : LAB[e.st] || ""}${l.state_by ? " · " + l.state_by : ""}\nOrder says: ${cleanText(l.text)}`;
  const box = `<input type="checkbox" class="npack" data-pack="${key}" data-oid="${o.id}" data-from="${pull ? "shelf" : "print"}" ${l.packed ? "checked" : ""} ${packable && !busy ? "" : "disabled"} aria-label="Packed: ${esc(cleanText(l.text))}" title="${packable ? "Packed" : "Mark it printed or pull it from the shelf before packing"}">`;
  const dot = (e.st === "print" || e.st === "printing") && !l.packed ? `<button type="button" class="bvst" data-binopen="${key}" aria-label="${LAB[e.st]}: change status" tabindex="-1"></button>` : "";
  const text = canMark ? `<button type="button" class="ntext" data-binopen="${key}" aria-haspopup="menu" aria-expanded="${open}" title="${esc(tip)}">${esc(label)}${icon}</button>` : `<span class="ntext" title="${esc(tip)}">${head ? `<span class="nenc">${esc(label)}</span>` : esc(label) + icon}</span>`;
  const stockBubble = head && r && r.in_stock != null && !l.packed ? (() => { const n = Number(r.in_stock) || 0; const need = owed.get(r.id) || 0; if (e.st === "shelf") return ""; return `<span class="bvstock ${n < 1 ? "out" : ""}" title="${n} ${esc(r.item)} on the shelf, ${need} open orders need one">${SV(IC.shelfunit, "")}${n}</span>`; })() : "";
  const opt = (st, lab, on) => `<button type="button" role="menuitemradio" aria-checked="${!!on}" data-ls="${st}" data-uid="${key}" data-oid="${o.id}" class="nm-${st || "reset"}">${on ? "✓ " : ""}${lab}</button>`;
  const pkOpt = `<button type="button" role="menuitemcheckbox" aria-checked="${!!l.packed}" data-packbtn="${key}" data-oid="${o.id}" data-from="${pull ? "shelf" : "print"}" data-set="${l.packed ? "0" : "1"}" class="nm-pack">${l.packed ? "✓ Packed (tap to unpack)" : "Mark as packed"}</button>`;
  let menu = "";
  if (canMark && open && !busy) {
    const invOpt = r && r.in_stock != null ? `<button type="button" role="menuitem" data-invadj="${esc(r.id)}">▦ Adjust inventory…</button>` : "";
    const queueOpt = hooks.queue && (e.st === "print" || e.st === "printing") && !l.packed && !l.print_src ? `<button type="button" role="menuitem" data-queue="${key}" data-oid="${o.id}">⊞ Add to print queue…</button>` : "";
    if (pull && !l.packed) menu = pkOpt + opt("nostock", "Change to print", false) + `<button type="button" role="menuitem" data-oeline="${key}" data-oid="${o.id}">✎ Change item…</button>` + invOpt;
    else {
      const tk = e.st === "print" && !l.packed ? takeFrom(o, l) : []; const also = e.st === "print" && !l.packed ? alsoPrint(o, l) : null;
      menu = opt(e.forced ? "nostock" : "print", "Needs printing", e.st === "print") + opt("printing", "Printing", e.st === "printing") + queueOpt + opt("printed", "Done", e.st === "printed")
        + (e.st === "print" && !l.packed ? `<button type="button" role="menuitem" class="nm-take" data-take="${key}" data-oid="${o.id}">⇄ Take from another order${tk.length ? ` (${tk.length})` : ""}</button>` : "")
        + (packable ? pkOpt : "") + ((l.print_state || "") !== "" ? opt("", "Reset (shelf if in stock)", false) : "")
        + `<button type="button" role="menuitem" data-oeline="${key}" data-oid="${o.id}">✎ Change item…</button>` + invOpt
        + (also ? `<div class="nm-also" role="none"><div class="nm-alsoh">${also.length ? "Also needs printing · " + also.length : "No other orders need this printed"}</div>${also.map((x) => `<button type="button" role="menuitem" class="nm-alsoi" data-alsogo="${x.l.uid}"><span>${esc(x.o.customer)}</span><span>${esc(dayLabel(shipBy(x.o)))}</span></button>`).join("")}</div>` : "");
    }
    menu = `<div class="nmenu" role="menu" aria-label="Status for ${esc(cleanText(l.text))}">${menu}</div>`;
  }
  const err = store.errs["l:" + key] ? `<div class="err lerr">${esc(store.errs["l:" + key])}</div>` : "";
  return `<div class="nline ${cls}" data-line="${key}">${dot || box}${text}${stockBubble}${sub}${busy ? `<span class="bvsub">Saving…</span>` : ""}${err}${menu}</div>`;
}

export function cardHtml(o) {
  const cur = obPick(o.status); const busy = store.busy.has("o:" + o.id); const plats = o.platform || [];
  const lines = [...(o.lines || [])].sort((a, b) => a.line_no - b.line_no);
  // enclosure headings first, then everything else in order
  const ordered = [...lines.filter((l) => lineKind(l) === "enc"), ...lines.filter((l) => lineKind(l) !== "enc")];
  const hint = !busy && BIN.stOpen !== o.id ? statusHint(o) : null;
  const left = unpacked(o);
  const det = ((o.collections || []).length ? `<div class="nprop">${o.collections.map((c) => `<span class="np np-purple">${esc(c)}</span>`).join("")}</div>` : "") + (o.order_number ? `<div class="sub">#${esc(o.order_number)}</div>` : "") + (o.state ? `<div class="sub">${esc(o.state)}</div>` : "");
  const pin = !!BIN.pinned[o.id];
  const err = store.errs["o:" + o.id] ? `<div class="err">${esc(store.errs["o:" + o.id])}</div>` : "";
  return `<article class="ncard" data-ob="${o.id}">
    <div class="ncard-t"><button type="button" class="nedit" data-obedit="${o.id}" title="Edit the order">${esc(o.customer)}<span class="nedit-i" aria-hidden="true">✎</span></button>${o.repeat_customer || /\*\s*$/.test(o.customer) ? '<span class="np np-yellow" title="Repeat customer">★</span>' : ""}${isExpress(o) ? '<span class="np np-red">Express</span>' : ""}${det ? `<button type="button" class="nsthint" data-det="${o.id}" aria-expanded="${pin}">details${pin ? " ▴" : " ▾"}</button>` : ""}</div>
    ${det && pin ? `<div class="ndet">${det}</div>` : ""}
    <div class="nprop nstatwrap"><div class="nstatrow"><button type="button" class="np np-${NSTAT[cur] || "gray"} nstat" data-stopen="${o.id}" aria-haspopup="menu" aria-expanded="${BIN.stOpen === o.id}" ${busy ? "disabled" : ""} title="Change order status"><i></i>${esc(cur)}${busy ? " · saving…" : " ▾"}</button>${plats.map((p) => `<span class="np np-${platColor(p)}">${esc(p)}</span>`).join("")}
      ${hint ? (hint.note ? `<span class="nsthint warn" title="${esc(hint.tip)}" role="img" aria-label="${esc(hint.tip)}">!</span>` : `<button type="button" class="nsthint" data-hint="${esc(hint.to)}" data-oid="${o.id}" title="${esc(hint.tip)}">→ ${esc(hint.to)}</button>`) : ""}</div>
      ${BIN.stOpen === o.id && !busy ? `<div class="nmenu nstatmenu" role="menu" aria-label="Order status for ${esc(o.customer)}">${OB_PICK.map((x) => { const lock = x === "Done" && left && x !== cur; return `<button type="button" role="menuitemradio" aria-checked="${x === cur}" data-ost="${esc(x)}" data-oid="${o.id}" ${lock ? "disabled" : ""}>${x === cur ? "✓ " : ""}${esc(x)}${lock ? ` <span class="sub">(pack ${left} more)</span>` : ""}</button>`; }).join("")}</div>` : ""}</div>
    ${o.important ? `<div class="nprop nimp">${esc(o.important)}</div>` : ""}
    ${err}
    <div class="nlines">${ordered.map((l) => lineHtml(o, l)).join("") || '<div class="sub">No items on this order.</div>'}</div>
    ${(o.freebie || []).length ? `<div class="sub">🎁 ${o.freebie.map(esc).join(", ")}</div>` : ""}
    <div class="ncard-f">${o.order_date ? `Ordered ${esc(fmtDay(o.order_date))}` : ""}<span style="flex:1"></span>v${o.version}</div>
  </article>`;
}

export function binRender() {
  const box = $("#binList"); if (!box) return;
  const st = $("#binStatus");
  if (st) st.textContent = store.err ? "⚠ " + store.err : store.loadedAt ? `${plural(store.open.length, "open order")} · synced ${store.loadedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · refreshes every 20 s` : "Reading orders…";
  const sel = $("#binPlat"); if (sel) { const plats = [...new Set(store.orders.flatMap((o) => o.platform || []))].sort(); const cur = sel.value; sel.innerHTML = `<option value="">All platforms</option>` + plats.map((p) => `<option ${p === cur ? "selected" : ""}>${esc(p)}</option>`).join(""); }
  document.querySelectorAll("[data-binlay]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.binlay === BIN.layout)));
  if (!store.loadedAt) return;
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
  box.innerHTML = undoHtml + `<div class="nboard${BIN.layout === "rows" ? " rows" : ""}">${cols.map((c) => `<section class="ncol ${c.k < today ? "over" : c.k === today ? "today" : ""}"><header><span class="nday">${esc(colLab(c.k))}</span><span class="ncount">${plural(c.list.length, "order")}</span>${c.k < today ? '<span class="np np-red">Overdue</span>' : c.k === today ? '<span class="np np-yellow">Today</span>' : c.k === addDays(today, 1) ? '<span class="np np-blue">Tomorrow</span>' : ""}</header><div class="ncards">${c.list.map(cardHtml).join("")}</div></section>`).join("")}</div>`;
}

function binWire() {
  const box = $("#binList");
  $("#binSearch").oninput = binRender; $("#binPlat").onchange = binRender;
  $("#binDays").addEventListener("click", (e) => { const b = e.target.closest("[data-day]"); if (!b) return; const k = b.dataset.day; if (k === "all") BIN.days = []; else BIN.days = BIN.days.includes(k) ? BIN.days.filter((x) => x !== k) : [...BIN.days, k]; binRender(); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-binlay]"); if (!b) return; BIN.layout = b.dataset.binlay; try { localStorage.setItem("spood.bin.layout", BIN.layout); } catch (x) {} binRender(); });
  document.addEventListener("click", (e) => { if ((BIN.open || BIN.stOpen) && !e.target.closest(".nmenu,[data-binopen],[data-stopen]")) { BIN.open = null; BIN.stOpen = null; binRender(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (BIN.open || BIN.stOpen)) { BIN.open = null; BIN.stOpen = null; binRender(); } });
  const orderOf = (id) => store.orders.find((x) => x.id === id);
  box.addEventListener("click", async (e) => {
    const t = e.target;
    let b;
    if ((b = t.closest("[data-undo]"))) { b.disabled = true; undoDone(b.dataset.undo); return; }
    if ((b = t.closest("[data-det]"))) { BIN.pinned[b.dataset.det] = !BIN.pinned[b.dataset.det]; binRender(); return; }
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
    c.orders.push(o); (o.platform || []).forEach((p) => c.platforms.add(p)); if (o.state) c.states.add(o.state); if (o.handle) c.handles.add(o.handle); if (o.repeat_customer || /\*\s*$/.test(o.customer)) c.repeat = true;
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
    if ((b = e.target.closest("[data-custnew]"))) { const c = all.find((x) => x.key === b.dataset.custnew); if (!c) return; document.querySelector('nav.tabs [data-tab="bins"]').click(); openOrderForm(null, null, { customer: c.name, platform: c.last.platform || [], state: [...c.states][0] || "", handle: [...c.handles][0] || "", repeat_customer: true }); }
  };
}

/* ===================== order form (new / edit) ===================== */
const PLATFORMS = () => [...new Set(["Etsy", "Shopify", "TikTok", "TikTok - LIVE", "In person", ...store.orders.flatMap((o) => o.platform || [])])];
const F = { form: null, orig: null, errors: [], review: null, busy: false, focus: null };
const blank = (pre = {}) => ({ id: null, version: null, customer: "", repeat_customer: false, handle: "", platform: [], order_number: "", shipping_number: "", order_date: isoDay(), ship_by: "", ship_type: "Standard", status: "Not started", important: "", summary: "", state: "", lines: [], ...pre });
const fromOrder = (o) => ({ id: o.id, version: o.version, customer: o.customer || "", repeat_customer: !!o.repeat_customer, handle: o.handle || "", platform: [...(o.platform || [])], order_number: o.order_number || "", shipping_number: o.shipping_number || "", order_date: o.order_date || "", ship_by: o.ship_by || "", ship_type: o.ship_type || "Standard", status: o.status, important: o.important || "", summary: o.summary || "", state: o.state || "",
  lines: [...(o.lines || [])].sort((a, b) => a.line_no - b.line_no).map((l) => ({ uid: l.uid, text: cleanText(l.text), qty: Number(l.qty) || 1, inv: l.notion_inventory_id || "", untracked: l.match === "untracked", group_uid: l.group_uid || null, print_state: l.print_state, packed: l.packed })) });
const snap = (f) => JSON.stringify(f);

export function openOrderForm(order = null, focusUid = null, pre = null) {
  F.form = order ? fromOrder(order) : blank(pre || {}); F.orig = snap(F.form); F.errors = []; F.review = null; F.focus = focusUid;
  $("#odBinsCard").hidden = false; $("#odTitle").textContent = order ? "Edit order · " + order.customer : "New order";
  formRender(); $("#odBinsCard").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => { const el = focusUid ? $(`#odHost [data-k][data-uid="${focusUid}"] .li-text`) : $("#odHost #fCustomer"); if (el) el.focus(); }, 60);
}
function closeForm() { F.form = null; $("#odBinsCard").hidden = true; $("#odHost").innerHTML = ""; }

function searchInv(q) { const qt = toks(q); if (!qt.length) return []; const out = [];
  for (const r of store.inv) { const nt = toks(r.item + " " + (r.collection || "")); if (qt.every((w) => nt.some((x) => x.startsWith(w)))) out.push({ r, sc: qt.length / nt.length + (r.in_stock > 0 ? .01 : 0) }); }
  return out.sort((a, b) => b.sc - a.sc || a.r.item.localeCompare(b.r.item)).slice(0, 14); }
function matchInv(text) { const t = new Set(toks(text.replace(/\([^)]*\)/g, " "))); let best = null;
  for (const r of store.inv) { const nt = toks(r.item).filter((w) => !["the", "a", "and", "set", "hide", "piece"].includes(w)); if (!nt.length) continue; const hit = nt.filter((w) => t.has(w)).length; const sc = hit / nt.length + (hit === nt.length ? 1 : 0) - (nt.length - hit) * .05; if (!best || sc > best.sc) best = { r, sc, full: hit === nt.length }; }
  return best && best.sc >= 0.5 ? best : null; }

function lineRowHtml(l, i) {
  const r = l.inv ? store.invById.get(l.inv) : null; const q = Number(l.qty) || 1;
  const flag = r ? `<small>${esc(r.collection || "")}${r.in_stock != null ? ` · ${r.in_stock} on shelf` : " · not tracked"}${l.print_state ? ` · <b>${esc(LAB[l.print_state] || l.print_state)}</b>` : ""}${l.packed ? " · packed" : ""}</small>` : l.untracked ? `<small>Not tracked (plants, extras)</small>` : isEncText(l.text) ? `<small>Enclosure heading</small>` : `<small><span class="flag">Not in the catalog</span>${(() => { const m = matchInv(l.text); return m ? ` <button type="button" class="btn ghost mini" data-use="${i}" data-inv="${m.r.id}">Use “${esc(m.r.item)}”</button>` : ""; })()}</small>`;
  return `<div class="line" data-k="${i}" ${l.uid ? `data-uid="${l.uid}"` : ""}><div class="nm ta"><input class="li-text" data-l="${i}" data-lf="text" value="${esc(l.text)}" autocomplete="off" aria-label="Item ${i + 1}" placeholder="Type an item name"><div class="ta-list" hidden></div>${flag}</div>
    <input type="number" min="1" max="99" value="${q}" data-l="${i}" data-lf="qty" aria-label="Quantity">
    <div class="szc"><label class="utk"><input type="checkbox" data-l="${i}" data-lf="untracked" ${l.untracked ? "checked" : ""}> Not tracked</label></div>
    <button type="button" class="x" data-del="${i}" aria-label="Remove item ${i + 1}">✕</button></div>`;
}
function formRender() {
  const f = F.form; if (!f) return; const host = $("#odHost");
  const plats = PLATFORMS(); const custs = customers();
  const pieces = f.lines.reduce((a, l) => a + (Number(l.qty) || 1), 0);
  host.innerHTML = `<div class="od">
    <div class="grid2">
      <div class="ta"><label class="f">Customer<input id="fCustomer" data-f="customer" value="${esc(f.customer)}" autocomplete="off" placeholder="Name"></label><div class="ta-list" hidden></div></div>
      <label class="f">Handle <span class="opt">(optional)</span><input data-f="handle" value="${esc(f.handle)}" autocomplete="off" placeholder="@username"></label>
      <label class="f">Order # <span class="opt">(optional)</span><input data-f="order_number" value="${esc(f.order_number)}" autocomplete="off"></label>
      <label class="f">State <span class="opt">(optional)</span><input data-f="state" value="${esc(f.state)}" autocomplete="off" placeholder="AL"></label>
    </div>
    <div><div class="sub" style="margin-bottom:6px;font-weight:700">Platform <span class="opt" style="font-weight:500">(required)</span></div><div class="pills${!f.platform.length && F.errors.some((x) => /platform/i.test(x)) ? " srcmiss" : ""}" role="group" aria-label="Platform">${plats.map((p) => `<button type="button" data-plat="${esc(p)}" aria-pressed="${f.platform.includes(p)}">${esc(p)}</button>`).join("")}</div></div>
    <div class="grid2">
      <label class="f">Order date<input type="date" data-f="order_date" value="${esc(f.order_date)}"></label>
      <label class="f">Ship by<input type="date" data-f="ship_by" value="${esc(f.ship_by)}"></label>
      <label class="f">Shipping<select data-f="ship_type"><option ${f.ship_type === "Standard" ? "selected" : ""}>Standard</option><option ${f.ship_type === "Express" ? "selected" : ""}>Express</option></select></label>
      <label class="f">Shipping # <span class="opt">(optional)</span><input data-f="shipping_number" value="${esc(f.shipping_number)}" autocomplete="off"></label>
    </div>
    <div class="grid2">
      <label class="f">Important <span class="opt">(shows in red on the card)</span><input data-f="important" value="${esc(f.important)}" autocomplete="off"></label>
      <label class="f">Notes <span class="opt">(optional)</span><input data-f="summary" value="${esc(f.summary)}" autocomplete="off"></label>
      <label class="utk" style="align-self:end;padding-bottom:12px"><input type="checkbox" data-f="repeat_customer" ${f.repeat_customer ? "checked" : ""}> Repeat customer</label>
    </div>
    <div class="row"><h3>Items <span class="sub">(${plural(pieces, "piece")})</span></h3>${f.lines.length ? `<button type="button" class="btn ghost mini" data-act="clearItems">Clear items</button>` : ""}</div>
    ${f.lines.length ? `<div class="lhead" aria-hidden="true"><span>Item</span><span>Qty</span><span></span><span></span></div>` : ""}
    <div class="lines">${f.lines.map(lineRowHtml).join("") || `<div class="empty">No items yet. Search below, or paste a list.</div>`}</div>
    <div class="ta"><label class="f">Add an item<input id="addItem" autocomplete="off" placeholder="Type a name, e.g. web climb — or press Enter to add it as written"></label><div class="ta-list" hidden></div></div>
    <details class="more" ${F.review ? "open" : ""}><summary>Paste a list instead</summary>${pasteHtml()}</details>
    <div class="savebar"><div class="errors">${F.errors.map((e) => `<span>${esc(e)}</span>`).join("") || `<span class="sub" style="color:var(--muted);font-weight:500">${f.id ? "Lines keep their printing and packed checks." : "Shelf stock is handed out by ship date; the rest shows as needs printing."}</span>`}</div>
      <button type="button" class="btn ghost" data-act="cancel">Cancel</button><button type="button" class="btn accent" data-act="save" ${F.busy ? "disabled" : ""}>${F.busy ? "Saving…" : f.id ? "Save changes" : "Save order"}</button></div>
  </div>`;
  wireForm(host, custs);
}
function pasteHtml() {
  const r = F.review;
  if (!r) return `<p class="sub" style="margin-top:0">One item per line. "2x Ghost Hide" or "2 Ghost Hide" sets a quantity.</p><label class="f">Pasted list<textarea id="pasteText" placeholder="2x Ghost Hide&#10;Coffin Hide - Black&#10;Floor Insert - Checkered, Small"></textarea></label><div class="row" style="justify-content:flex-start"><button type="button" class="btn mini" data-act="reviewPaste">Review list</button></div>`;
  return `<div class="rev">${r.lines.map((l, i) => `<div class="revline"><div class="orig">${esc(l.raw)}</div><input type="number" min="1" max="99" value="${l.qty}" data-r="${i}" data-rf="qty" aria-label="Quantity"><div><select data-r="${i}" data-rf="inv" aria-label="Catalog item"><option value="">Keep as written (not in catalog)</option>${l.cands.map((c) => `<option value="${c.id}" ${c.id === l.inv ? "selected" : ""}>${esc(c.item)}</option>`).join("")}</select>${l.flags.map((x) => `<div class="flag${/no match/i.test(x) ? " bad" : ""}">⚠ ${esc(x)}</div>`).join("")}</div><label class="utk"><input type="checkbox" data-r="${i}" data-rf="untracked" ${l.untracked ? "checked" : ""}> Not tracked</label><button type="button" class="x" data-rdel="${i}" aria-label="Drop this line">✕</button></div>`).join("")}
    <div class="row" style="justify-content:flex-start"><button type="button" class="btn accent mini" data-act="importPaste">Add these to the order</button><button type="button" class="btn ghost mini" data-act="editPaste">Edit the text</button></div></div>`;
}
function reviewPaste(text) {
  const lines = String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((raw) => {
    let s = cleanText(raw), qty = 1, m;
    if ((m = s.match(/^(\d{1,3})\s*[x×]\s*/i)) || (m = s.match(/^(\d{1,3})\s+(?=[a-z])/i))) { qty = +m[1]; s = s.slice(m[0].length); }
    else if ((m = s.match(/\s*[x×]\s*(\d{1,3})\s*$/i))) { qty = +m[1]; s = s.slice(0, m.index).trim(); }
    const t = new Set(toks(s.replace(/\([^)]*\)/g, " "))); const cands = [];
    for (const r of store.inv) { const nt = toks(r.item).filter((w) => !["the", "a", "and", "set", "hide", "piece"].includes(w)); if (!nt.length) continue; const hit = nt.filter((w) => t.has(w)).length; const sc = hit / nt.length + (hit === nt.length ? 1 : 0); if (sc >= 0.5) cands.push({ id: r.id, item: r.item, sc }); }
    cands.sort((a, b) => b.sc - a.sc); const top = cands[0]; const flags = [];
    let inv = ""; if (top && top.sc >= 1) { const ties = cands.filter((c) => c.sc >= top.sc - .001); if (ties.length === 1) inv = top.id; else flags.push("Matches more than one item: pick one"); } else flags.push(cands.length ? "No exact match; pick the item or keep as written" : "No match in the catalog");
    return { raw, text: s, qty, inv, cands: cands.slice(0, 6), untracked: /\bplants?\b|cocoon|substrate|moss/i.test(s) && !inv, flags };
  });
  F.review = { text, lines };
}
function wireForm(host, custs) {
  const f = F.form;
  const read = () => { host.querySelectorAll("[data-f]").forEach((el) => { const k = el.dataset.f; f[k] = el.type === "checkbox" ? el.checked : el.value; }); host.querySelectorAll("[data-l]").forEach((el) => { const l = f.lines[+el.dataset.l]; if (!l) return; const k = el.dataset.lf; if (k === "qty") l.qty = Math.max(1, Math.min(99, Math.floor(+el.value) || 1)); else if (k === "untracked") l.untracked = el.checked; else if (k === "text") { if (l.text !== el.value) { l.text = el.value; const r = l.inv && store.invById.get(l.inv); if (r && r.item !== el.value) l.inv = ""; } } }); };
  // typeahead
  const ta = (input, list, items, pick) => {
    const show = () => { const q = input.value.trim(); const hits = q ? items(q) : []; if (!hits.length) { list.hidden = true; return; } list.innerHTML = hits.map((h, i) => `<button type="button" data-i="${i}" class="${i === 0 ? "on" : ""}">${h.html}</button>`).join(""); list.hidden = false; list._hits = hits; };
    input.addEventListener("input", show); input.addEventListener("focus", show);
    input.addEventListener("keydown", (e) => { const hits = list._hits || []; if (list.hidden || !hits.length) return; const on = [...list.children].findIndex((b) => b.classList.contains("on")); if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = Math.max(0, Math.min(hits.length - 1, on + (e.key === "ArrowDown" ? 1 : -1))); [...list.children].forEach((b, i) => b.classList.toggle("on", i === n)); } else if (e.key === "Enter" && on >= 0 && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); pick(hits[on]); } else if (e.key === "Escape") list.hidden = true; });
    list.addEventListener("mousedown", (e) => { const b = e.target.closest("[data-i]"); if (b) { e.preventDefault(); pick((list._hits || [])[+b.dataset.i]); } });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
  };
  const cIn = host.querySelector("#fCustomer");
  if (cIn) ta(cIn, cIn.closest(".ta").querySelector(".ta-list"), (q) => { const n = normName(q); return custs.filter((c) => normName([c.name, ...c.handles].join(" ")).includes(n)).slice(0, 8).map((c) => ({ c, html: `<span><b>${esc(c.name)}</b>${c.handles.size ? ` <span class="sub">${esc([...c.handles].join(", "))}</span>` : ""}</span><span class="sub">${plural(c.orders.length, "order")}${c.states.size ? " · " + esc([...c.states][0]) : ""}</span>` })); }, (h) => { read(); f.customer = h.c.name; f.repeat_customer = true; if (!f.platform.length && h.c.last.platform) f.platform = [...h.c.last.platform]; if (!f.state) f.state = [...h.c.states][0] || ""; if (!f.handle) f.handle = [...h.c.handles][0] || ""; formRender(); });
  const invHits = (q) => searchInv(q).map((h) => ({ r: h.r, html: `<span>${esc(h.r.item)}</span><span class="sub">${esc(h.r.collection || "")}${h.r.in_stock != null ? ` · ${h.r.in_stock} on shelf` : ""}</span>` }));
  const addIn = host.querySelector("#addItem");
  const addLine = (text, inv) => { read(); f.lines.push({ text, qty: 1, inv: inv || "", untracked: false }); formRender(); setTimeout(() => { const el = $("#odHost #addItem"); if (el) el.focus(); }, 30); };
  ta(addIn, addIn.closest(".ta").querySelector(".ta-list"), invHits, (h) => addLine(h.r.item, h.r.id));
  addIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && addIn.value.trim() && (addIn.closest(".ta").querySelector(".ta-list").hidden)) { e.preventDefault(); addLine(addIn.value.trim(), ""); } });
  host.querySelectorAll(".li-text").forEach((inp) => ta(inp, inp.closest(".ta").querySelector(".ta-list"), invHits, (h) => { read(); const l = f.lines[+inp.dataset.l]; l.text = h.r.item; l.inv = h.r.id; l.untracked = false; formRender(); }));
  host.onchange = (e) => { const t = e.target; if (t.matches("[data-f],[data-l]")) { read(); if (t.dataset.lf === "text" || t.dataset.lf === "untracked") formRender(); } if (t.matches("[data-r]")) { const l = F.review.lines[+t.dataset.r]; const k = t.dataset.rf; if (k === "qty") l.qty = Math.max(1, +t.value || 1); else if (k === "inv") l.inv = t.value; else if (k === "untracked") l.untracked = t.checked; } };
  host.onclick = async (e) => {
    const t = e.target; let b;
    if ((b = t.closest("[data-plat]"))) { read(); const p = b.dataset.plat; f.platform = f.platform.includes(p) ? f.platform.filter((x) => x !== p) : [...f.platform, p]; formRender(); return; }
    if ((b = t.closest("[data-del]"))) { read(); f.lines.splice(+b.dataset.del, 1); formRender(); return; }
    if ((b = t.closest("[data-use]"))) { read(); const l = f.lines[+b.dataset.use]; const r = store.invById.get(b.dataset.inv); if (l && r) { l.text = r.item; l.inv = r.id; l.untracked = false; } formRender(); return; }
    if ((b = t.closest("[data-rdel]"))) { F.review.lines.splice(+b.dataset.rdel, 1); formRender(); return; }
    const act = (t.closest("[data-act]") || {}).dataset?.act; if (!act) return;
    if (act === "clearItems") { read(); f.lines = []; formRender(); }
    if (act === "cancel") { if (snap(f) !== F.orig && !(await confirmBox({ title: "Discard changes?", body: "This order hasn't been saved.", ok: "Discard", danger: true }))) return; closeForm(); }
    if (act === "reviewPaste") { read(); reviewPaste(host.querySelector("#pasteText").value); formRender(); }
    if (act === "editPaste") { const txt = F.review.text; F.review = null; formRender(); const ta2 = $("#odHost #pasteText"); if (ta2) ta2.value = txt; }
    if (act === "importPaste") { read(); for (const l of F.review.lines) { const r = l.inv && store.invById.get(l.inv); f.lines.push({ text: r ? r.item : l.text, qty: l.qty, inv: r ? r.id : "", untracked: !!l.untracked && !r }); } F.review = null; formRender(); }
    if (act === "save") { read(); await saveForm(); }
  };
}
function validate(f) {
  const errs = []; if (!f.customer.trim()) errs.push("Add the customer's name"); if (!f.platform.length) errs.push("Pick the platform the order came from"); if (!f.ship_by) errs.push("Pick a ship-by date"); if (!f.lines.length) errs.push("Add at least one item");
  f.lines.forEach((l, i) => { if (!String(l.text).trim()) errs.push(`Line ${i + 1} has no text`); });
  return errs;
}
async function saveForm() {
  const f = F.form; F.errors = validate(f); if (F.errors.length) { formRender(); return; }
  F.busy = true; formRender();
  const fields = ["customer", "repeat_customer", "handle", "platform", "order_number", "shipping_number", "order_date", "ship_by", "ship_type", "important", "summary", "state"];
  const orig = JSON.parse(F.orig);
  const linesOf = (ff) => { const uids = new Set(ff.lines.map((l) => l.uid).filter(Boolean)); return ff.lines.map((l) => { const out = { text: String(l.text).trim(), qty: Number(l.qty) || 1 }; if (l.uid) out.uid = l.uid; if (l.inv) out.notion_inventory_id = l.inv; if (l.untracked && !l.inv) out.untracked = true; if (l.group_uid && uids.has(l.group_uid)) out.group_uid = l.group_uid; return out; }); };
  const collections = [...new Set(f.lines.map((l) => (l.inv && store.invById.get(l.inv) || {}).collection).filter(Boolean))];
  try {
    if (!f.id) {
      const p = { customer: f.customer.trim(), repeat_customer: !!f.repeat_customer, handle: f.handle.trim() || null, platform: f.platform, order_number: f.order_number.trim() || null, shipping_number: f.shipping_number.trim() || null, order_date: f.order_date || null, ship_by: f.ship_by, ship_type: f.ship_type, status: "Not started", notes: f.lines.map((l) => l.text).join("\n"), important: f.important.trim() || null, summary: f.summary.trim() || null, freebie: [], items: [], collections, order_type: [], state: f.state.trim().toUpperCase() || null, lines: linesOf(f) };
      const r = await db.saveOrder(p); F.busy = false;
      if (r && Array.isArray(r.duplicates) && r.duplicates.length) toast(`Saved. Order #${f.order_number} is also on: ${r.duplicates.map((d) => d.customer).join(", ")}`, true); else toast(`Saved ${f.customer.trim()}${r && r.unmatched ? ` · ${plural(r.unmatched, "line")} not in the catalog` : ""}`);
      closeForm(); await load(); return;
    }
    // edit: apply only what changed, on top of the freshest copy of the order
    const changed = fields.filter((k) => JSON.stringify(f[k]) !== JSON.stringify(orig[k]));
    const linesChanged = JSON.stringify(linesOf(f)) !== JSON.stringify(linesOf(orig));
    if (!changed.length && !linesChanged) { F.busy = false; closeForm(); toast("No changes"); return; }
    const r = await db.saveWithRetry(f.id, (p) => {
      const out = { ...p };
      for (const k of changed) { let v = f[k]; if (typeof v === "string") { v = v.trim(); if (k === "state") v = v.toUpperCase(); if (!v && k !== "customer") v = null; } out[k] = v; }
      if (linesChanged) { out.lines = linesOf(f); out.collections = collections; out.notes = f.lines.map((l) => l.text).join("\n"); }
      return out;
    });
    F.busy = false; toast(`Saved ${f.customer.trim()}${r && r.unmatched ? ` · ${plural(r.unmatched, "line")} not in the catalog` : ""}`); closeForm(); await reloadOrder(f.id);
  } catch (e) { F.busy = false; F.errors = [db.errText(e)]; formRender(); }
}

/* ===================== boot for this module ===================== */
export function init() {
  binWire();
  $("#binNew").onclick = () => openOrderForm(null);
  $("#odClose").onclick = async () => { if (F.form && snap(F.form) !== F.orig && !(await confirmBox({ title: "Discard changes?", body: "This order hasn't been saved.", ok: "Discard", danger: true }))) return; closeForm(); };
  onChange(() => { binRender(); custRender(); });
}
