// Inventory: shelf view (tiles per variation), list view (end-of-day count), counts and adjustments through apply_moves.
import * as db from "./supabase.js";
import { $, esc, plural, store, onChange, owed, splitName, sizeLabel, toast, modal, reloadInventory, setErr, shipBy, fmtDay, cleanText, invRowOf, eff, lineKind } from "./orders.js";

const PRODUCT_ORDER = ["Cosmic", "Galaxy", "Gothic", "Haunted", "Neon Halloween", "Woodland", "Yeti", "Ocean", "Christmas", "Celestial Bat"];
const TAIL = ["Floor Inserts", "Hides", "Supplies"];
const SIZE_ORDER = ["Sling Size", "Small", "Standard", "Large", "Custom", ""];
const typeOf = (n) => (/climb|wall|tree|tower/i.test(n) ? "Wall climbs" : /floor|insert|substrate|wrap|panel/i.test(n) ? "Floor inserts" : /ledge|rock|cloud|window|bat\b/i.test(n) ? "Ledges" : /enclosure|kit|feeder|bowl/i.test(n) ? "Supplies" : "Hides");
function collOf(r, type) { const c = r.collection || ""; if (/^floor/i.test(c) || (type === "Floor inserts" && (!c || c === "Natural"))) return "Floor Inserts"; if (!c || c === "Natural" || c === "Other") return type === "Supplies" ? "Supplies" : "Hides"; return c; }
function itemName(base, coll) { let n = base; for (const pre of [coll, ...PRODUCT_ORDER, "Floor Insert", "Floor"]) { const m = n.match(new RegExp("^" + pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*-\\s*(.+)$", "i")); if (m) { n = m[1]; break; } } return n.trim() || base; }

let host = null;
let mode = "shelf", filter = "all", coll = "all", LGROUP = "coll", openV = null, panelMode = "count";
try { mode = localStorage.getItem("spood.inv.mode") === "list" ? "list" : "shelf"; LGROUP = localStorage.getItem("spood.inv.group") === "type" ? "type" : "coll"; } catch (e) {}
const edits = new Map(); // id -> new count typed in list view (not saved yet)
const touched = new Set(); const OPENC = new Set(), OPENI = new Set();
let saving = false;

function committedTo(r) { const out = []; for (const o of store.open) for (const l of o.lines || []) { if (l.notion_inventory_id !== r.id) continue; const e = eff(l); if (e.st === "shelf" || (e.st === "packed" && e.from === "shelf") || e.a) out.push({ customer: o.customer, qty: e.a || Number(l.qty) || 1, shipBy: shipBy(o) }); } return out; }
function build() {
  const V = store.inv.map((r) => { const sp = splitName(r.item); const type = typeOf(r.item); const c = collOf(r, type); const item = itemName(sp.base, c); const need = owed.get(r.id) || 0; const stock = r.in_stock; const used = stock == null ? 0 : Math.min(Math.max(0, stock), need);
    return { id: r.id, r, item, base: sp.base, size: sp.size, color: sp.color, coll: c, type, stock, val: edits.has(r.id) ? edits.get(r.id) : stock, need, used, tracked: stock != null }; });
  const by = new Map(); const ITEMS = [];
  V.forEach((v) => { const k = v.coll + "|" + v.item.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+hide$/, "").trim(); if (!by.has(k)) { by.set(k, { key: k, name: v.item, coll: v.coll, type: v.type, vars: [] }); ITEMS.push(by.get(k)); } const it = by.get(k); if (v.item.length > it.name.length) it.name = v.item; it.vars.push(v); });
  ITEMS.forEach((it) => { it.vars.forEach((v) => (v.item = it.name)); it.vars.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size) || String(a.color).localeCompare(String(b.color))); });
  ITEMS.sort((a, b) => a.name.localeCompare(b.name));
  const present = new Set(V.map((v) => v.coll));
  const COLLS = [...PRODUCT_ORDER.filter((c) => present.has(c)), ...[...present].filter((c) => !PRODUCT_ORDER.includes(c) && !TAIL.includes(c)).sort(), ...TAIL.filter((c) => present.has(c))];
  return { V, ITEMS, COLLS };
}
let D = { V: [], ITEMS: [], COLLS: [] };
const status = (v) => (!v.tracked ? "nt" : v.need > v.used ? "short" : (v.val ?? 0) <= 0 ? "out" : "ok");
const label = (v) => [v.size ? sizeLabel(v.size) : "", v.color].filter(Boolean).join(" · ") || "One style";
const shortBy = (v) => Math.max(0, v.need - v.used);
function passes(v) { const q = (host.querySelector("#q")?.value || "").trim().toLowerCase(); if (q && !(v.base + " " + v.size + " " + v.color + " " + v.coll).toLowerCase().includes(q)) return false; if (filter === "short") return status(v) === "short"; if (filter === "out") return v.tracked && (v.val ?? 0) === 0; if (filter === "changed") return edits.has(v.id); return true; }
function setCount(v, raw) { if (raw === "" || raw == null) return; const n = Math.max(0, Math.round(Number(raw) || 0)); if (n === v.stock) edits.delete(v.id); else edits.set(v.id, n); touched.add(v.id); }

function renderFilters() { const c = { all: D.V.length, short: 0, out: 0, changed: edits.size }; D.V.forEach((v) => { const s = status(v); if (s === "short") c.short++; if (v.tracked && (v.val ?? 0) === 0) c.out++; }); host.querySelector("#filters").innerHTML = [["all", "All items", c.all, ""], ["short", "Short for orders", c.short, "short"], ["out", "Out of stock", c.out, "out"], ["changed", "Changed, not saved", c.changed, "low"]].map(([k, l, n, cls]) => `<button type="button" class="fchip ${cls}" data-filter="${k}" aria-pressed="${filter === k}"><b class="mono">${n}</b><span>${l}</span></button>`).join(""); }
function renderRail() { const sb = {}, nb = {}; D.V.forEach((v) => { if (status(v) === "short") sb[v.coll] = (sb[v.coll] || 0) + 1; nb[v.coll] = (nb[v.coll] || 0) + 1; }); host.querySelector("#rail").innerHTML = [["all", "All collections"]].concat(D.COLLS.map((c) => [c, c])).map(([k, l]) => { const s = k === "all" ? Object.values(sb).reduce((a, b) => a + b, 0) : sb[k] || 0; return `<button type="button" data-coll="${esc(k)}" aria-current="${coll === k}"><span>${esc(l)}</span>${s ? `<span class="dot" title="${s} short for orders">${s}</span>` : `<span class="cnt">${k === "all" ? D.V.length : nb[k] || 0}</span>`}</button>`; }).join(""); }
function tile(v) { const s = status(v); const sh = s === "short" ? shortBy(v) : 0; return `<button type="button" class="tile ${s}${edits.has(v.id) ? " changed" : ""}" data-v="${esc(v.id)}" aria-label="${esc(v.item + " " + label(v) + ": " + (v.tracked ? v.val : "not tracked") + " on shelf")}"><span class="tl">${v.size && v.color ? `<em>${esc(sizeLabel(v.size))}</em>${esc(v.color)}` : esc(label(v))}${sh ? `<span class="need">short ${sh}</span>` : ""}${v.used ? `<span class="held" title="${v.used} promised to open orders">${v.used} committed · ${Math.max(0, (v.val || 0) - v.used)} free</span>` : ""}</span><span class="tn">${v.tracked ? v.val : "–"}</span></button>`; }
function renderShelf() {
  const list = D.ITEMS.filter((it) => coll === "all" || it.coll === coll).map((it) => ({ it, vs: it.vars.filter(passes) })).filter((x) => x.vs.length);
  const by = {}; list.forEach((x) => (by[x.it.coll] ||= []).push(x)); const keys = D.COLLS.filter((c) => by[c]);
  host.querySelector("#list").innerHTML = keys.length ? keys.map((c) => { const xs = by[c]; const pcs = xs.reduce((a, x) => a + x.it.vars.reduce((s, v) => s + Math.max(0, v.val || 0), 0), 0);
    return `<section class="coll"><h2>${esc(c)} <small>${plural(xs.length, "item")} · ${pcs} on shelf</small></h2><div class="items">` + xs.map(({ it, vs }) => `<div class="item"><div class="iname"><b>${esc(it.name)}</b><small>${esc(it.type.replace(/s$/, "").replace(/^Supplie$/, "Supply"))}${it.vars.length > 1 ? " · " + it.vars.length + " variations" : ""}</small></div><div class="tiles">${vs.map(tile).join("")}<button type="button" class="tile add" data-addvar="${esc(it.key)}" aria-label="Add a color or size of ${esc(it.name)}"><span class="tl">+ Add a color<br>or size</span></button></div><div class="itot"><b class="mono">${it.vars.reduce((s, v) => s + Math.max(0, v.val || 0), 0)}</b><small>on shelf</small></div></div>`).join("") + `</div></section>`; }).join("") : `<p class="sub">Nothing matches. Clear the search or pick "All items".</p>`;
}
function renderList() {
  const vs = D.ITEMS.flatMap((it) => it.vars).filter((v) => v.tracked && passes(v)); const searching = !!((host.querySelector("#q")?.value || "").trim() || filter !== "all");
  const TYPES = ["Hides", "Wall climbs", "Ledges", "Floor inserts", "Supplies"]; const gk = (v) => (LGROUP === "coll" ? v.coll : v.type); const secs = {}; vs.forEach((v) => (secs[gk(v)] ||= []).push(v));
  const why = (v) => { const t = []; if (v.used > 0) t.push(`${v.used} committed · ${Math.max(0, (v.val || 0) - v.used)} free`); if (v.need > v.used) t.push(`${v.need - v.used} short for orders`); return t.length ? `<span class="sub">${t.join(" · ")}</span>` : ""; };
  const step = (v) => `<span class="cstep"><button type="button" data-cstep="-1" data-id="${esc(v.id)}" aria-label="One less">−</button><input id="n-${esc(v.id)}" data-count="${esc(v.id)}" inputmode="numeric" value="${v.val ?? ""}" aria-label="On the shelf: ${esc(v.item + " " + label(v))}"><button type="button" data-cstep="1" data-id="${esc(v.id)}" aria-label="One more">+</button></span>`;
  const rowOf = (v, nested) => `<div class="crow${edits.has(v.id) ? " done" : ""}"><span class="clab">${nested ? `<b>${esc(label(v))}</b>` : `<b>${esc(v.item)}</b>${label(v) !== "One style" ? ` <span class="sub">${esc(label(v))}</span>` : ""}`} ${why(v)}</span><span class="was mono">was ${v.stock ?? "–"}</span>${step(v)}</div>`;
  const itemsOf = (list) => { const g = new Map(); list.forEach((v) => { const k = v.coll + "|" + v.item; if (!g.has(k)) g.set(k, []); g.get(k).push(v); }); return [...g.entries()].map(([k, vs2]) => { if (vs2.length === 1) return rowOf(vs2[0]) + addPill(vs2[0]); const tot = vs2.reduce((a, v) => a + Math.max(0, v.val || 0), 0), was = vs2.reduce((a, v) => a + Math.max(0, v.stock || 0), 0); return `<details class="csec" data-citem="${esc(k)}" ${searching || OPENI.has(k) ? "open" : ""} style="margin:4px 0"><summary><span>${esc(vs2[0].item)} <span class="sub">${vs2.length} variations</span></span><span class="cmeta mono">${was} → ${tot}</span></summary>${vs2.map((v) => rowOf(v, true)).join("")}${addPill(vs2[0])}</details>`; }).join(""); };
  const order = LGROUP === "coll" ? D.COLLS : TYPES;
  host.querySelector("#countView").innerHTML = `<div class="count"><div class="ctool"><div class="viewtabs" role="group" aria-label="Group by"><button type="button" data-lgroup="coll" aria-pressed="${LGROUP === "coll"}">Collection</button><button type="button" data-lgroup="type" aria-pressed="${LGROUP === "type"}">Item type</button></div><span class="sub">${edits.size ? `${edits.size} changed, not saved` : "Enter moves to the next box"}</span></div><div class="crow" style="border:0"><span></span><span class="was">Saved</span><span class="sub" style="text-align:center">On shelf now</span></div>` +
    (order.filter((c) => secs[c]).map((c) => { const list = secs[c]; const ch = list.filter((v) => edits.has(v.id)).length; const key = LGROUP + ":" + c; return `<details class="csec" data-csec="${esc(key)}" ${searching || OPENC.has(key) ? "open" : ""}><summary><span>${esc(c)}</span><span class="cmeta">${ch ? `${ch} changed` : ""}</span></summary>${itemsOf(list)}</details>`; }).join("") || `<p class="sub" style="padding:14px">Nothing matches.</p>`) + `</div>` +
    (edits.size ? `<div class="csave"><span>${plural(edits.size, "count")} changed</span><button type="button" class="btn ghost mini" id="cundo">Undo all</button><button type="button" class="btn" id="csave" ${saving ? "disabled" : ""}>${saving ? "Saving…" : "Save counts"}</button></div>` : "");
}
function renderPanel() {
  const v = openV && D.V.find((x) => x.id === openV); const panel = host.querySelector("#panel"), scrim = host.querySelector("#scrim");
  if (!v) { openV = null; panel.innerHTML = ""; panel.hidden = true; scrim.hidden = true; return; }
  const it = D.ITEMS.find((x) => x.vars.includes(v)); const s = status(v); const sh = s === "short" ? shortBy(v) : 0; const com = committedTo(v.r); const err = store.errs["inv:" + v.id];
  panel.hidden = false; scrim.hidden = false;
  panel.innerHTML = `<div class="ptop"><div><div class="sub">${esc(it.coll)} · ${esc(it.type.replace(/s$/, "").replace(/^Supplie$/, "Supply"))}</div><h3>${esc(it.name)}</h3></div><span><button type="button" class="btn ghost mini" id="pedit">Edit</button> <button type="button" class="x" id="close" aria-label="Close">✕</button></span></div>
    ${it.vars.length > 1 ? `<div class="pvars" role="group" aria-label="Variation">${it.vars.map((x) => `<button type="button" data-v="${esc(x.id)}" aria-current="${x.id === v.id}">${esc(label(x))} · ${x.tracked ? x.stock : "–"}</button>`).join("")}</div>` : ""}
    <div class="sub" style="text-align:center;font-weight:700">${esc(label(v))}${v.r.sku ? ` · <span class="mono">${esc(v.r.sku)}</span>` : ""}</div>
    ${!v.tracked ? `<div class="sub" style="text-align:center">This item isn't tracked, so it has no shelf count.</div>` : `
    <div class="viewtabs" role="group" aria-label="What to record" style="align-self:center"><button type="button" data-pmode="count" aria-pressed="${panelMode === "count"}">Count the shelf</button><button type="button" data-pmode="adjust" aria-pressed="${panelMode === "adjust"}">Adjust</button></div>
    ${panelMode === "count" ? `<div class="big"><button type="button" data-pstep="-1" aria-label="One less">−</button><input id="pcount" inputmode="numeric" value="${v.val ?? ""}" aria-label="On the shelf"><button type="button" data-pstep="1" aria-label="One more">+</button></div>
      <div class="sub" style="text-align:center">Saved count: <b class="mono">${v.stock}</b>${edits.has(v.id) ? ` → <b class="mono">${v.val}</b>` : ""}</div>
      <div class="psave"><button type="button" class="btn" id="psave" ${edits.has(v.id) && !saving ? "" : "disabled"}>${saving ? "Saving…" : edits.has(v.id) ? "Save count" : "No change"}</button>${edits.has(v.id) ? `<button type="button" class="btn ghost mini" id="pundo">Undo</button>` : ""}</div>`
    : `<form class="adj" id="adjForm"><div class="srow"><label>Change<select id="adjKind"><option value="print">+ Printed for stock</option><option value="return">+ Returned</option><option value="scrap">− Scrapped / broken</option><option value="adjust">± Correction</option></select></label><label>How many<input id="adjQty" type="number" min="1" max="99" value="1" inputmode="numeric"></label></div><div class="srow"><label style="flex:2">Reason <span style="text-transform:none;letter-spacing:0">(optional)</span><input id="adjReason" autocomplete="off"></label></div><div class="srow"><button type="submit" class="btn" id="adjSave" ${saving ? "disabled" : ""}>${saving ? "Saving…" : "Record"}</button><span class="sub">Shelf now <b class="mono">${v.stock}</b></span></div></form>`}
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <div class="facts"><div class="fact"><span>Committed to orders</span><b class="mono">${v.used}</b></div><div class="fact"><span>Free on the shelf</span><b class="mono">${Math.max(0, (v.val || 0) - v.used)}</b></div>${sh ? `<div class="fact short"><span>Short for orders</span><b class="mono">${sh}</b></div>` : ""}<div class="fact"><span>Open orders need</span><b class="mono">${v.need}</b></div></div>
    ${com.length ? `<div class="pcom"><b>Committed to customer orders</b><ul>${com.map((x) => `<li>${esc(String(x.customer).replace(/\s*\*+\s*$/, ""))}${x.qty > 1 ? " ×" + x.qty : ""} <span class="sub">ships ${esc(fmtDay(x.shipBy))}</span></li>`).join("")}</ul><div class="sub" style="margin-top:4px">Still counted on the shelf until the order is marked Done.</div></div>` : ""}`}
    <div class="sub">${v.r.note ? esc(v.r.note) : ""}</div>`;
  setTimeout(() => { const f = panel.querySelector("#pcount,#adjQty"); if (f && document.activeElement !== f && !panel.contains(document.activeElement)) { f.focus(); if (f.select) f.select(); } }, 20);
}
export function render() {
  if (!host) return; D = build();
  host.querySelector("#mShelf").setAttribute("aria-pressed", String(mode === "shelf")); host.querySelector("#mList").setAttribute("aria-pressed", String(mode === "list"));
  host.querySelector("#shelf").hidden = mode !== "shelf"; host.querySelector("#countView").hidden = mode !== "list";
  const st = $("#invStatus"); if (st) st.textContent = store.err ? "⚠ " + store.err : store.loadedAt ? `${plural(store.inv.length, "item")} · counts from Supabase` : "";
  if (!store.loadedAt) { host.querySelector("#list").innerHTML = '<p class="sub">Loading your items…</p>'; return; }
  renderFilters(); if (mode === "shelf") { renderRail(); renderShelf(); } else renderList(); renderPanel();
}
let soon = null;
function softRender() { clearTimeout(soon); const a = document.activeElement; if (a && host.contains(a) && a.matches("[data-count], #pcount, #q")) { soon = setTimeout(softRender, 600); return; } render(); }

async function saveCounts(ids) {
  const moves = ids.filter((id) => edits.has(id)).map((id) => ({ notion_id: id, kind: "count", qty: edits.get(id), reason: "Shelf count" }));
  if (!moves.length) return; saving = true; render();
  try { const res = await db.applyMoves(moves); for (const m of moves) { edits.delete(m.notion_id); touched.delete(m.notion_id); setErr("inv:" + m.notion_id, ""); } toast(`Saved ${plural(moves.length, "count")}${Array.isArray(res) && res.some((r) => r.status === "duplicate") ? " (some were already recorded)" : ""}`); }
  catch (e) { const t = db.errText(e); for (const m of moves) setErr("inv:" + m.notion_id, t); toast("⚠ Counts not saved: " + t, true); }
  saving = false; await reloadInventory(); render();
}
async function saveAdjust(v, kind, qty, reason) {
  const n = Math.max(1, Math.min(99, Math.round(Number(qty) || 0))); const signed = kind === "scrap" ? -n : kind === "adjust" ? (/^-/.test(String(qty)) ? -n : n) : n;
  saving = true; render();
  try { await db.applyMoves([{ notion_id: v.id, kind, qty: signed, reason: reason || null, ref: "inventory" }]); setErr("inv:" + v.id, ""); toast(`${v.item} ${label(v)}: ${signed > 0 ? "+" : ""}${signed} recorded`); }
  catch (e) { setErr("inv:" + v.id, db.errText(e)); }
  saving = false; await reloadInventory(); render();
}

const addPill = (v) => { const it = D.ITEMS.find((x) => x.vars.includes(v)); return it ? `<div class="crow addrow"><button type="button" class="btn ghost mini" data-addvar="${esc(it.key)}">+ Add variation</button></div>` : ""; };

/* ---------- Add a color or size: a new variant of an item already on the shelf (hq.add_variant, then a starting count) ---------- */
let OPTS = null;
async function options() { if (!OPTS) OPTS = await db.catalogOptions(); return OPTS; }
function productOf(it, opts) { // the catalog product behind this item: the longest product id that prefixes a variation's sku
  let best = null; for (const v of it.vars) { const sku = v.r.sku || ""; for (const p of opts.products || []) if (sku === p.id || sku.startsWith(p.id + "-")) if (!best || p.id.length > best.id.length) best = p; }
  return best;
}
async function addVariation(it) {
  const m = modal(`<h3>Add a color or size</h3><p class="sub">Loading the catalog…</p>`, { label: "Add a color or size" });
  const card = m.el.querySelector(".obmodal-card");
  let opts; try { opts = await options(); } catch (e) { card.innerHTML = `<h3>Add a color or size</h3><p class="err">⚠ ${esc(db.errText(e))}</p><div class="row"><button type="button" class="btn ghost" data-close>Close</button></div>`; card.querySelector("[data-close]").onclick = m.close; return; }
  const prod = productOf(it, opts); const v0 = it.vars[0];
  const collName = v0.r.collection || (prod && prod.collections && prod.collections.length ? ((opts.collections || []).find((c) => c.id === prod.collections[0]) || {}).name : "") || "";
  const twoColors = (prod && prod.category === "Floor Insert") || /floor|checker/i.test(it.name + " " + v0.base);
  const sizes = [...new Set([...(prod ? prod.sizes || [] : []), ...it.vars.map((v) => v.size).filter(Boolean), "Small", "Large"])];
  const colors = (opts.colors || []).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const existing = new Set(it.vars.map((v) => (sizeLabel(v.size || "Standard") + "|" + (v.color || "")).toLowerCase()));
  const sel = (id, list, cur) => `<select id="${id}">${list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("")}<option value="__other">Other…</option></select>`;
  card.innerHTML = `<h3>Add a color or size</h3><p class="sub"><b>${esc(prod ? prod.name : it.name)}</b>${collName ? " · " + esc(collName) : ""}</p>
    <p class="sub">On the shelf now: ${it.vars.map((v) => esc(label(v))).join(", ")}</p>
    <form class="addvar"><div class="srow"><label>Size${sel("avSize", sizes, sizeLabel(v0.size || "Small"))}<input id="avSizeOther" placeholder="Size name" hidden></label>
    <label>Color${twoColors ? " 1" : ""}${sel("avC1", ["(none)", ...colors], "(none)")}<input id="avC1Other" placeholder="Color name" hidden></label>
    ${twoColors ? `<label>Color 2${sel("avC2", ["(none)", ...colors], "(none)")}<input id="avC2Other" placeholder="Color name" hidden></label>` : ""}
    <label>Starting count<input id="avCount" type="number" min="0" max="999" value="0" inputmode="numeric"></label></div>
    <p class="err" id="avErr"></p><div class="row"><button type="submit" class="btn accent" id="avSave">Add</button><button type="button" class="btn ghost" data-close>Cancel</button></div></form>`;
  const q = (s) => card.querySelector(s); const err = (t) => { q("#avErr").textContent = t || ""; };
  card.querySelectorAll("select").forEach((s) => { s.onchange = () => { const o = q("#" + s.id + "Other"); if (o) { o.hidden = s.value !== "__other"; if (!o.hidden) o.focus(); } err(""); }; });
  q("[data-close]").onclick = m.close;
  const val = (id) => { const s = q("#" + id); if (!s) return ""; const v = s.value === "__other" ? q("#" + id + "Other").value.trim() : s.value; return v === "(none)" ? "" : v; };
  q("form").onsubmit = async (e) => {
    e.preventDefault(); err("");
    const size = val("avSize"), c1 = val("avC1"), c2 = twoColors ? val("avC2") : ""; const n = Math.max(0, Math.round(Number(q("#avCount").value) || 0));
    if (!size) return err("Pick or type a size."); if (c2 && !c1) return err("Pick Color 1 first.");
    const colorLabel = [c1, c2].filter(Boolean).join(" + ");
    if (existing.has((sizeLabel(size) + "|" + colorLabel).toLowerCase())) return err(`${label({ size, color: colorLabel })} is already on the shelf.`);
    const isNew = []; if (!sizes.includes(size)) isNew.push("size"); for (const c of [c1, c2]) if (c && !colors.includes(c)) isNew.push("color:" + c);
    const inventory_name = `${v0.base} (${[size, colorLabel].filter(Boolean).join(", ")})`;
    const payload = { product: prod ? prod.name : it.name, collection: collName || null, size, color_1: c1 || null, color_2: c2 || null, inventory_name, new: isNew };
    const btn = q("#avSave"); btn.disabled = true; btn.textContent = "Adding…";
    let r; try { r = await db.addVariant(payload); } catch (x) { btn.disabled = false; btn.textContent = "Add"; return err(db.errText(x)); }
    if (n > 0) { try { await db.applyMoves([{ notion_id: r.notion_id, kind: "count", qty: n, reason: "Starting count", ref: "inventory" }]); } catch (x) { await reloadInventory(); render(); btn.disabled = false; btn.textContent = "Add"; return err(`Added ${inventory_name}, but the starting count was not saved: ${db.errText(x)}. Count it from its tile.`); } }
    m.close(); toast(`Added ${inventory_name}${n ? ` · ${n} on shelf` : ""}${r.created && r.created.length ? ` (new ${r.created.join(", ")})` : ""}`);
    await reloadInventory(); openV = r.notion_id; render();
  };
}

/* ---------- Add a brand-new item (piece) through add_variant, then its starting count ---------- */
async function newItem() {
  const m = modal(`<h3>Add item</h3><p class="sub">Loading the catalog…</p>`, { label: "Add item" }); const card = m.el.querySelector(".obmodal-card");
  let opts; try { opts = await options(); } catch (e) { card.innerHTML = `<h3>Add item</h3><p class="err">⚠ ${esc(db.errText(e))}</p>`; return; }
  const colls = (opts.collections || []).map((c) => c.name); const cats = opts.categories || ["Hide", "Ledge", "Climb", "Floor Insert", "Insert", "Part", "Add-on", "Supply"];
  const colors = (opts.colors || []).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const sel = (id, list, first) => `<select id="${id}">${first ? `<option value="">${first}</option>` : ""}${list.map((x) => `<option>${esc(x)}</option>`).join("")}<option value="__other">Other…</option></select><input id="${id}Other" hidden>`;
  card.innerHTML = `<h3>Add item</h3><form class="addvar">
    <div class="srow"><label style="flex:2 1 220px">Name<input id="nName" placeholder="e.g. Mushroom Ledge" required></label><label>Collection${sel("nColl", colls, "(none)")}</label><label>Type<select id="nCat">${cats.filter((c) => !/^(Kit|Set|Enclosure)$/.test(c)).map((c) => `<option>${esc(c)}</option>`).join("")}</select></label></div>
    <div class="srow"><label>Size${sel("nSize", ["Small", "Large", "Sling"], "")}</label><label>Color${sel("nC1", colors, "(none)")}</label><label id="nC2wrap" hidden>Color 2${sel("nC2", colors, "(none)")}</label><label>Starting count<input id="nCount" type="number" min="0" max="999" value="0" inputmode="numeric"></label></div>
    <p class="err" id="nErr"></p><div class="row"><button type="submit" class="btn accent" id="nSave">Add</button><button type="button" class="btn ghost" data-close>Cancel</button></div></form>`;
  const q = (s) => card.querySelector(s); const err = (t) => { q("#nErr").textContent = t || ""; };
  q("[data-close]").onclick = m.close; q("#nSize").value = "Small";
  card.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => { const o = q("#" + s.id + "Other"); if (o) { o.hidden = s.value !== "__other"; if (!o.hidden) o.focus(); } q("#nC2wrap").hidden = q("#nCat").value !== "Floor Insert"; err(""); }));
  const val = (id) => { const s = q("#" + id); return s.value === "__other" ? q("#" + id + "Other").value.trim() : s.value; };
  setTimeout(() => q("#nName").focus(), 30);
  q("form").onsubmit = async (e) => {
    e.preventDefault(); err("");
    const name = q("#nName").value.trim(), coll = val("nColl"), cat = q("#nCat").value, size = val("nSize"), c1 = val("nC1"), c2 = cat === "Floor Insert" ? val("nC2") : ""; const n = Math.max(0, Math.round(Number(q("#nCount").value) || 0));
    if (!name) return err("Give it a name."); if (!size) return err("Pick or type a size."); if (c2 && !c1) return err("Pick Color 1 first.");
    const colorLabel = [c1, c2].filter(Boolean).join(" + ");
    const inventory_name = `${coll ? coll + " - " : ""}${name} (${[size, colorLabel].filter(Boolean).join(", ")})`;
    if (store.inv.some((r) => r.item.toLowerCase() === inventory_name.toLowerCase())) return err(`${inventory_name} is already in Inventory.`);
    const isNew = ["product", "size"]; if (coll && !colls.includes(coll)) isNew.push("collection"); for (const c of [c1, c2]) if (c && !colors.includes(c)) isNew.push("color:" + c);
    const btn = q("#nSave"); btn.disabled = true; btn.textContent = "Adding…";
    let r; try { r = await db.addVariant({ product: name, collection: coll || null, category: cat, size, color_1: c1 || null, color_2: c2 || null, inventory_name, new: isNew }); }
    catch (x) { btn.disabled = false; btn.textContent = "Add"; return err(db.errText(x)); }
    OPTS = null; // catalog changed
    if (n > 0) { try { await db.applyMoves([{ notion_id: r.notion_id, kind: "count", qty: n, reason: "Starting count", ref: "inventory" }]); } catch (x) { await reloadInventory(); render(); btn.disabled = false; btn.textContent = "Add"; return err(`Added ${inventory_name}, but the starting count was not saved: ${db.errText(x)}. Count it from its tile.`); } }
    m.close(); toast(`Added ${inventory_name}${n ? ` · ${n} on shelf` : ""}`); await reloadInventory(); openV = r.notion_id; render();
  };
}

/* ---------- Edit an item: name and note (update_variant), or remove it (archive_variant, only at 0 on the shelf) ---------- */
function editItem(v) {
  const m = modal(`<h3>Edit item</h3><form class="addvar"><div class="srow"><label style="flex:1 1 100%">Name<input id="eName" value="${esc(v.r.item)}" required></label></div>
    <div class="srow"><label style="flex:1 1 100%">Note<input id="eNote" value="${esc(v.r.note || "")}" placeholder="Optional"></label></div>
    <p class="err" id="eErr"></p><div class="row"><button type="submit" class="btn accent" id="eSave">Save</button><button type="button" class="btn ghost" data-close>Cancel</button><span style="flex:1"></span><button type="button" class="btn ghost" id="eDel">Remove item</button></div></form>`, { label: "Edit item" });
  const q = (s) => m.el.querySelector(s); const err = (t) => { q("#eErr").textContent = t || ""; };
  q("[data-close]").onclick = m.close;
  q("form").onsubmit = async (e) => { e.preventDefault(); err(""); q("#eSave").disabled = true;
    try { await db.updateVariant({ id: v.id, inventory_name: q("#eName").value.trim(), note: q("#eNote").value, updated_at: v.r.updated_at }); m.close(); toast("Saved " + q("#eName").value.trim()); await reloadInventory(); render(); }
    catch (x) { err(db.errText(x)); q("#eSave").disabled = false; } };
  q("#eDel").onclick = async () => { if (q("#eDel").dataset.sure !== "1") { q("#eDel").dataset.sure = "1"; q("#eDel").textContent = "Tap again to remove"; return; } err("");
    try { await db.archiveVariant(v.id); m.close(); toast("Removed " + v.r.item); openV = null; await reloadInventory(); render(); }
    catch (x) { err(db.errText(x)); q("#eDel").dataset.sure = ""; q("#eDel").textContent = "Remove item"; } };
}

export function open(id, pmode = "adjust") { mode = "shelf"; openV = id; panelMode = pmode; render(); const el = host && host.querySelector(`.tile[data-v="${CSS.escape(id)}"]`); if (el) el.scrollIntoView({ block: "center" }); }

export function init() {
  host = document.getElementById("invHost"); if (!host) return;
  host.innerHTML = `<div class="viewbar"><div class="viewtabs" role="group" aria-label="View"><button type="button" id="mShelf" data-mode="shelf" aria-pressed="true"><span aria-hidden="true">▦</span><span>Shelf view</span></button><button type="button" id="mList" data-mode="list" aria-pressed="false"><span aria-hidden="true">☰</span><span>List view</span></button></div><span style="flex:1"></span><button type="button" class="btn" id="newItem">+ Add item</button></div>
    <div class="filters" id="filters" role="group" aria-label="Show"></div>
    <div class="search"><input type="search" id="q" placeholder="Search item, color or size" aria-label="Search inventory"></div>
    <div class="body" id="shelf"><nav class="rail" id="rail" aria-label="Collections"></nav><div class="list" id="list"></div></div>
    <div id="countView" hidden></div>
    <div class="scrim" id="scrim" hidden></div><aside class="panel" id="panel" hidden aria-label="Item details"></aside>`;
  host.addEventListener("click", (e) => { const t = e.target; let b;
    if ((b = t.closest("[data-mode]"))) { mode = b.dataset.mode; try { localStorage.setItem("spood.inv.mode", mode); } catch (x) {} openV = null; render(); return; }
    if ((b = t.closest("[data-filter]"))) { filter = b.dataset.filter; render(); return; }
    if ((b = t.closest("[data-coll]"))) { coll = b.dataset.coll; render(); return; }
    if ((b = t.closest("[data-lgroup]"))) { LGROUP = b.dataset.lgroup; try { localStorage.setItem("spood.inv.group", LGROUP); } catch (x) {} render(); return; }
    if ((b = t.closest("[data-pmode]"))) { panelMode = b.dataset.pmode; render(); return; }
    if ((b = t.closest("[data-addvar]"))) { const it = D.ITEMS.find((x) => x.key === b.dataset.addvar); if (it) addVariation(it); return; }
    if ((b = t.closest("[data-v]"))) { openV = b.dataset.v; render(); return; }
    if ((b = t.closest("[data-pstep]"))) { const v = D.V.find((x) => x.id === openV); if (!v) return; setCount(v, Math.max(0, (v.val || 0) + Number(b.dataset.pstep))); render(); return; }
    if ((b = t.closest("[data-cstep]"))) { const v = D.V.find((x) => x.id === b.dataset.id); const inp = host.querySelector("#n-" + CSS.escape(v.id)); const cur = inp && inp.value !== "" ? Number(inp.value) : v.stock || 0; setCount(v, Math.max(0, cur + Number(b.dataset.cstep))); const y = window.scrollY; render(); window.scrollTo(0, y); return; }
    if (t.closest("#newItem")) { newItem(); return; }
    if (t.closest("#pedit")) { const v = D.V.find((x) => x.id === openV); if (v) editItem(v); return; }
    if (t.closest("#close") || t.id === "scrim") { openV = null; render(); return; }
    if (t.closest("#psave")) { saveCounts([openV]); return; }
    if (t.closest("#pundo")) { edits.delete(openV); touched.delete(openV); render(); return; }
    if (t.closest("#csave")) { saveCounts([...edits.keys()]); return; }
    if (t.closest("#cundo")) { edits.clear(); touched.clear(); render(); return; }
  });
  host.addEventListener("submit", (e) => { const f = e.target.closest("#adjForm"); if (!f) return; e.preventDefault(); const v = D.V.find((x) => x.id === openV); if (!v) return; saveAdjust(v, f.querySelector("#adjKind").value, f.querySelector("#adjQty").value, f.querySelector("#adjReason").value.trim()); });
  host.addEventListener("change", (e) => { if (e.target.id === "pcount") { const v = D.V.find((x) => x.id === openV); if (v) { setCount(v, e.target.value); render(); } } });
  host.addEventListener("keydown", (e) => { const inp = e.target.closest && e.target.closest("[data-count]"); if (inp && e.key === "Enter") { e.preventDefault(); const v = D.V.find((x) => x.id === inp.dataset.count); setCount(v, inp.value); const all = [...host.querySelectorAll("[data-count]")]; const nx = all[all.indexOf(inp) + 1]; if (nx) { const sec = nx.closest("[data-csec]"); if (sec) OPENC.add(sec.dataset.csec); const it = nx.closest("[data-citem]"); if (it) OPENI.add(it.dataset.citem); } render(); if (nx) { const el = host.querySelector("#" + CSS.escape(nx.id)); if (el) { el.focus(); el.select(); el.scrollIntoView({ block: "center" }); } } } if (e.key === "Enter" && e.target.id === "pcount") { e.preventDefault(); const v = D.V.find((x) => x.id === openV); if (v) { setCount(v, e.target.value); render(); } } });
  host.addEventListener("focusout", (e) => { const inp = e.target.closest && e.target.closest("[data-count]"); if (inp && inp.value !== "") { const v = D.V.find((x) => x.id === inp.dataset.count); if (v && String(v.val) !== inp.value) { setCount(v, inp.value); setTimeout(softRender, 0); } } });
  host.addEventListener("toggle", (e) => { const d = e.target; if (!d.dataset) return; if (d.dataset.csec) d.open ? OPENC.add(d.dataset.csec) : OPENC.delete(d.dataset.csec); if (d.dataset.citem) d.open ? OPENI.add(d.dataset.citem) : OPENI.delete(d.dataset.citem); }, true);
  host.querySelector("#q").addEventListener("input", render);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openV) { openV = null; render(); } });
  onChange(softRender); render();
}
