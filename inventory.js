// Inventory: shelf view (tiles per variation), list view (end-of-day count), counts and adjustments through apply_moves.
import * as db from "./supabase.js";
import { $, esc, plural, store, onChange, owed, splitName, sizeLabel, toast, reloadInventory, setErr, shipBy, fmtDay, cleanText, invRowOf, eff, lineKind } from "./orders.js";

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
    return `<section class="coll"><h2>${esc(c)} <small>${plural(xs.length, "item")} · ${pcs} on shelf</small></h2><div class="items">` + xs.map(({ it, vs }) => `<div class="item"><div class="iname"><b>${esc(it.name)}</b><small>${esc(it.type.replace(/s$/, "").replace(/^Supplie$/, "Supply"))}${it.vars.length > 1 ? " · " + it.vars.length + " variations" : ""}</small></div><div class="tiles">${vs.map(tile).join("")}</div><div class="itot"><b class="mono">${it.vars.reduce((s, v) => s + Math.max(0, v.val || 0), 0)}</b><small>on shelf</small></div></div>`).join("") + `</div></section>`; }).join("") : `<p class="sub">Nothing matches. Clear the search or pick "All items".</p>`;
}
function renderList() {
  const vs = D.ITEMS.flatMap((it) => it.vars).filter((v) => v.tracked && passes(v)); const searching = !!((host.querySelector("#q")?.value || "").trim() || filter !== "all");
  const TYPES = ["Hides", "Wall climbs", "Ledges", "Floor inserts", "Supplies"]; const gk = (v) => (LGROUP === "coll" ? v.coll : v.type); const secs = {}; vs.forEach((v) => (secs[gk(v)] ||= []).push(v));
  const why = (v) => { const t = []; if (v.used > 0) t.push(`${v.used} committed · ${Math.max(0, (v.val || 0) - v.used)} free`); if (v.need > v.used) t.push(`${v.need - v.used} short for orders`); return t.length ? `<span class="sub">${t.join(" · ")}</span>` : ""; };
  const step = (v) => `<span class="cstep"><button type="button" data-cstep="-1" data-id="${esc(v.id)}" aria-label="One less">−</button><input id="n-${esc(v.id)}" data-count="${esc(v.id)}" inputmode="numeric" value="${v.val ?? ""}" aria-label="On the shelf: ${esc(v.item + " " + label(v))}"><button type="button" data-cstep="1" data-id="${esc(v.id)}" aria-label="One more">+</button></span>`;
  const rowOf = (v, nested) => `<div class="crow${edits.has(v.id) ? " done" : ""}"><span class="clab">${nested ? `<b>${esc(label(v))}</b>` : `<b>${esc(v.item)}</b>${label(v) !== "One style" ? ` <span class="sub">${esc(label(v))}</span>` : ""}`} ${why(v)}</span><span class="was mono">was ${v.stock ?? "–"}</span>${step(v)}</div>`;
  const itemsOf = (list) => { const g = new Map(); list.forEach((v) => { const k = v.coll + "|" + v.item; if (!g.has(k)) g.set(k, []); g.get(k).push(v); }); return [...g.entries()].map(([k, vs2]) => { if (vs2.length === 1) return rowOf(vs2[0]); const tot = vs2.reduce((a, v) => a + Math.max(0, v.val || 0), 0), was = vs2.reduce((a, v) => a + Math.max(0, v.stock || 0), 0); return `<details class="csec" data-citem="${esc(k)}" ${searching || OPENI.has(k) ? "open" : ""} style="margin:4px 0"><summary><span>${esc(vs2[0].item)} <span class="sub">${vs2.length} variations</span></span><span class="cmeta mono">${was} → ${tot}</span></summary>${vs2.map((v) => rowOf(v, true)).join("")}</details>`; }).join(""); };
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
  panel.innerHTML = `<div class="ptop"><div><div class="sub">${esc(it.coll)} · ${esc(it.type.replace(/s$/, "").replace(/^Supplie$/, "Supply"))}</div><h3>${esc(it.name)}</h3></div><button type="button" class="x" id="close" aria-label="Close">✕</button></div>
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

export function init() {
  host = document.getElementById("invHost"); if (!host) return;
  host.innerHTML = `<div class="viewbar"><div class="viewtabs" role="group" aria-label="View"><button type="button" id="mShelf" data-mode="shelf" aria-pressed="true"><span aria-hidden="true">▦</span><span>Shelf view</span></button><button type="button" id="mList" data-mode="list" aria-pressed="false"><span aria-hidden="true">☰</span><span>List view</span></button></div></div>
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
    if ((b = t.closest("[data-v]"))) { openV = b.dataset.v; render(); return; }
    if ((b = t.closest("[data-pstep]"))) { const v = D.V.find((x) => x.id === openV); if (!v) return; setCount(v, Math.max(0, (v.val || 0) + Number(b.dataset.pstep))); render(); return; }
    if ((b = t.closest("[data-cstep]"))) { const v = D.V.find((x) => x.id === b.dataset.id); const inp = host.querySelector("#n-" + CSS.escape(v.id)); const cur = inp && inp.value !== "" ? Number(inp.value) : v.stock || 0; setCount(v, Math.max(0, cur + Number(b.dataset.cstep))); const y = window.scrollY; render(); window.scrollTo(0, y); return; }
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
