// Items: edit everything about a piece in one place: its name, the other names it answers to, type, default color and flags,
// its sizes (with filament and print time), the colors it is offered in, and every variation (inventory name, size, color, note,
// remove / bring back, and the order wording learned for it). The database checks and saves it in one go (hq.save_item).
import * as db from "./supabase.js";
import { esc, modal, toast, confirmBox, cat, loadCatalog, invalidateCatalog, reloadInventory, SIZE_OPTIONS } from "./orders.js";

let M = null, card = null, cur = null, orig = "", busy = false, viaList = false, listQ = "", seq = 0, focusVar = null;
const OPEN = new Set(); // which fold-outs are open, kept across re-draws
const q = (s) => card.querySelector(s);
const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");
const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); // as the database compares names (hq.name_key)
const colorName = (id) => (cat.colors.get(id) || {}).name || id || "";
const allColors = () => [...cat.colors.values()].sort((a, b) => a.name.localeCompare(b.name));
const optLabel = (code) => (cur && cur.id === "enclosure" ? (code === "standard" ? "Latch" : code === "magnetic" ? "Magnetic" : code) : code === "standard" ? "Standard" : code.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()));
const sizeRef = (s) => s.code || "new:" + s.k;
const sizeOf = (ref) => cur.sizes.find((s) => sizeRef(s) === ref) || null;

/* ---------- the piece as the editor holds it ---------- */
function fromServer(r) {
  return {
    id: r.id, stamp: r.stamp, name: r.name, name0: r.name, keepOld: true, category: r.category, aliases: [...(r.aliases || [])], description: r.description || "",
    tracked: !!r.tracked, picks_color: !!r.picks_color, addon: !!r.addon, printed: r.printed !== false, catOther: false, collections: r.collections || [],
    def: { c1: r.default_color_1 || "", c2: r.default_color_2 || "", touched: false },
    sizes: (r.sizes || []).map((s) => ({ k: ++seq, code: s.code, name: s.name, name0: s.name, g: s.filament_g ?? "", min: s.print_minutes ?? "", profile: s.print_profile || "", archived: !!s.archived })),
    colors: { 1: [...((r.colors || {})["1"] || [])], 2: [...((r.colors || {})["2"] || [])] },
    vars: (r.variants || []).map((v) => ({ id: v.id, notion_id: v.notion_id, sku: v.sku, label: v.label || "", note: v.note || "",
      size: v.size_code, size0: v.size_code, c1: v.color_1 || "", c2: v.color_2 || "", c10: v.color_1 || "", c20: v.color_2 || "", scheme0: v.color_scheme_id, colorName0: v.color_name || "",
      opt: v.option_code || "standard", opt0: v.option_code || "standard", archived: !!v.archived, archived0: !!v.archived, on_hand: v.on_hand, open_lines: v.open_lines || 0, learned: v.learned || [] })),
    forget: [],
  };
}
const nameChanged = () => !!clean(cur.name) && clean(cur.name) !== cur.name0;
// the old name stays on as another name when the piece is renamed, unless the person takes it off
const aliasesOut = () => { const out = [...cur.aliases]; if (cur.keepOld && key(cur.name) !== key(cur.name0) && clean(cur.name) && !out.some((a) => a.toLowerCase() === cur.name0.toLowerCase())) out.push(cur.name0); return out; };
const twoColors = () => cur.category === "Floor Insert" || cur.colors[2].length > 0 || !!cur.def.c2 || cur.vars.some((v) => v.c2);
const colorChanged = (v) => v.c1 !== v.c10 || v.c2 !== v.c20;

/* ---------- a variation's name: the item's name plus its size, color and option (the database builds it the same way, hq.variant_name) ---------- */
function vname(v) {
  const s = sizeOf(v.size); const sn = s ? clean(s.name) : "";
  const col = colorChanged(v) ? [v.c1, v.c2].filter((c) => c && c !== "shop-choice").map(colorName).join(" + ") : /^(standard|shop-choice)$/.test(v.scheme0) ? "" : v.colorName0;
  const parts = [sn && !/^standard$/i.test(sn) ? sn : "", col, v.opt !== "standard" ? optLabel(v.opt) : ""].filter(Boolean);
  return (clean(cur.name) || cur.name0) + (parts.length ? ` (${parts.join(", ")})` : "");
}
function relabel() { for (const v of cur.vars) v.label = vname(v); }
function syncLabels() { relabel(); for (const v of cur.vars) { const el = q(`[data-var="${v.id}"] [data-f=label]`); if (el && el.textContent !== v.label) el.textContent = v.label; } }

/* ---------- list of every piece ---------- */
async function showList() {
  cur = null; orig = ""; viaList = true;
  card.innerHTML = `<h3>Items</h3><p class="sub">Loading…</p>`;
  try { await loadCatalog(true); } catch (e) { card.innerHTML = `<h3>Items</h3><p class="err">⚠ ${esc(db.errText(e))}</p><div class="row"><button type="button" class="btn ghost" data-close>Close</button></div>`; return; }
  card.innerHTML = `<div class="ce-head"><h3>Items</h3></div><div class="ie-q"><input type="search" id="ieQ" placeholder="Search" aria-label="Search items" value="${esc(listQ)}"></div><div class="ce-list" id="ieList"></div><div class="row"><button type="button" class="btn ghost" data-close>Close</button></div>`;
  drawList();
}
function drawList() {
  const n = new Map(); for (const v of cat.variants) n.set(v.product_id, (n.get(v.product_id) || 0) + 1);
  const k = listQ.trim().toLowerCase();
  const ps = (cat.opts.products || []).filter((p) => !k || [p.name, p.category, ...(p.aliases || []), ...(p.collections || []).map((id) => (cat.colls.get(id) || {}).name || "")].join(" ").toLowerCase().includes(k)).sort((a, b) => a.name.localeCompare(b.name));
  q("#ieList").innerHTML = ps.map((p) => `<button type="button" class="ce-item" data-open="${esc(p.id)}"><b>${esc(p.name)}</b><span class="sub">${esc(p.category || "")} · ${n.get(p.id) || 0} ${n.get(p.id) === 1 ? "variation" : "variations"}</span></button>`).join("") || `<p class="empty">Nothing matches.</p>`;
}

/* ---------- editor ---------- */
async function openEditor(id) {
  card.innerHTML = `<h3>Edit item</h3><p class="sub">Loading…</p>`;
  let r; try { [r] = await Promise.all([db.readItem(id), loadCatalog()]); if (!r) throw new Error("That item no longer exists"); }
  catch (e) { card.innerHTML = `<h3>Edit item</h3><p class="err">⚠ ${esc(db.errText(e))}</p><div class="row"><button type="button" class="btn ghost" ${viaList ? "data-back" : "data-close"}>${viaList ? "Back" : "Close"}</button></div>`; return; }
  cur = fromServer(r); orig = snap(); OPEN.clear(); render();
  if (focusVar) { const v = cur.vars.find((x) => x.notion_id === focusVar); focusVar = null; const el = v && q(`[data-var="${v.id}"]`); if (el) { el.classList.add("ie-here"); el.scrollIntoView({ block: "center" }); } }
}
const snap = () => JSON.stringify(cur && payload());
const dirty = () => !!cur && snap() !== orig;

const colorOpts = (val, none) => `<option value="">${none}</option>` + allColors().map((c) => `<option value="${esc(c.id)}" ${c.id === val ? "selected" : ""}>${esc(c.name)}</option>`).join("") + (val && !cat.colors.get(val) ? `<option value="${esc(val)}" selected>${esc(val)}</option>` : "");
const chip = (text, attr) => `<span class="ie-chip">${esc(text)}<button type="button" ${attr} aria-label="Remove ${esc(text)}">×</button></span>`;
function aliasChips() {
  const old = cur.keepOld && key(cur.name) !== key(cur.name0) && clean(cur.name) && !cur.aliases.some((a) => a.toLowerCase() === cur.name0.toLowerCase());
  return cur.aliases.map((a, i) => chip(a, `data-delalias="${i}"`)).join("") + (old ? chip(cur.name0, "data-delold") : "") + `<input id="ieAlias" placeholder="Add a name" autocomplete="off" aria-label="Add another name">`;
}
function sizeRow(s) {
  if (s.archived) return `<div class="ce-row ie-gone" data-size="${s.k}"><div class="ce-line"><span class="ie-gname">${esc(s.name)}</span><button type="button" class="btn ghost mini" data-backsize>Bring back</button></div></div>`;
  return `<div class="ce-row" data-size="${s.k}"><div class="ce-line">
    <label class="ie-sn">Size<input data-f="name" value="${esc(s.name)}" list="ieSizeNames" autocomplete="off"></label>
    <label class="ie-num">Filament g<input data-f="g" inputmode="decimal" value="${esc(s.g)}"></label>
    <label class="ie-num">Print min<input data-f="min" inputmode="numeric" value="${esc(s.min)}"></label>
    <label class="ie-prof">Profile<input data-f="profile" value="${esc(s.profile)}" autocomplete="off"></label>
    <button type="button" class="ce-x" data-delsize aria-label="Remove size">×</button></div></div>`;
}
function offered(slot) {
  const ids = cur.colors[slot]; const rest = allColors().filter((c) => !ids.includes(c.id));
  return `<div class="ie-chips">${ids.map((id) => chip(colorName(id), `data-delcolor="${slot}:${esc(id)}"`)).join("")}<select data-addcolor="${slot}" aria-label="Add a color"><option value="">Add a color…</option>${rest.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></div>`;
}
function varRow(v, two, opts) {
  const sizes = cur.sizes.filter((s) => !s.archived || sizeRef(s) === v.size);
  const facts = [v.sku, v.on_hand != null ? `${v.on_hand} on shelf` : "", v.open_lines ? `${v.open_lines} on open orders` : ""].filter(Boolean).join(" · ");
  return `<div class="ce-row" data-var="${v.id}">
    <div class="ce-line"><b class="ie-vname" data-f="label">${esc(v.label)}</b><button type="button" class="ce-x" data-delvar aria-label="Remove variation">×</button></div>
    <div class="ce-line">
      <label>Size<select data-f="size">${sizes.map((s) => `<option value="${esc(sizeRef(s))}" ${sizeRef(s) === v.size ? "selected" : ""}>${esc(clean(s.name) || "New size")}</option>`).join("")}</select></label>
      <label>Color${two ? " 1" : ""}<select data-f="c1">${colorOpts(v.c1, "None")}</select></label>
      ${two ? `<label>Color 2<select data-f="c2">${colorOpts(v.c2, "None")}</select></label>` : ""}
      ${opts.length > 1 || v.opt !== "standard" ? `<label>${cur.id === "enclosure" ? "Door" : "Option"}<select data-f="opt">${[...new Set([...opts, v.opt])].map((o) => `<option value="${esc(o)}" ${o === v.opt ? "selected" : ""}>${esc(optLabel(o))}</option>`).join("")}</select></label>` : ""}
      <label style="flex:2 1 160px">Note<input data-f="note" value="${esc(v.note)}" autocomplete="off"></label>
    </div>
    <div class="sub ie-facts">${esc(facts)}</div>
    ${v.learned.length ? `<details class="ie-det" data-det="l${v.id}" ${OPEN.has("l" + v.id) ? "open" : ""}><summary>Order wording <span class="sub">${v.learned.length}</span></summary><div class="ie-chips">${v.learned.map((a) => chip(a.text, `data-forget="${esc(a.key)}"`)).join("")}</div></details>` : ""}
  </div>`;
}
function render(err = "") {
  if (!cur) return;
  const top = card.scrollTop; const two = twoColors();
  const live = cur.vars.filter((v) => !v.archived), gone = cur.vars.filter((v) => v.archived);
  const opts = [...new Set(cur.vars.flatMap((v) => [v.opt0, v.opt]))].sort((a, b) => (a === "standard" ? -1 : b === "standard" ? 1 : a.localeCompare(b)));
  const cats = [...new Set([...(cat.opts.categories || []), cur.catOther ? "" : cur.category].filter(Boolean))];
  const nCol = cur.colors[1].length + cur.colors[2].length;
  card.innerHTML = `<div class="ce-head">${viaList ? `<button type="button" class="btn ghost mini" data-back>‹ Items</button>` : `<h3>Edit item</h3>`}<span class="sub">${esc(cur.collections.join(", "))}</span></div>
    <form class="addvar ce ie" novalidate>
      <div class="srow"><label style="flex:2 1 220px">Name<input id="ieName" value="${esc(cur.name)}" autocomplete="off"></label><label>Type<select id="ieCat">${cats.map((c) => `<option ${!cur.catOther && c === cur.category ? "selected" : ""}>${esc(c)}</option>`).join("")}<option value="__other" ${cur.catOther ? "selected" : ""}>Other…</option></select></label>${cur.catOther ? `<label>New type<input id="ieCatNew" value="${esc(cur.category)}" maxlength="40" autocomplete="off"></label>` : ""}</div>
      <div class="ie-field"><span>Also called</span><div class="ie-chips" id="ieAliases">${aliasChips()}</div></div>
      <div class="srow"><label>Default color<select data-def="c1">${colorOpts(cur.def.c1, "None")}</select></label>${two ? `<label>Default color 2<select data-def="c2">${colorOpts(cur.def.c2, "None")}</select></label>` : ""}<label style="flex:2 1 200px">Note<input id="ieDesc" value="${esc(cur.description)}" autocomplete="off"></label></div>
      <div class="ce-line ce-flags"><button type="button" class="ce-tog" data-flag="picks_color" aria-pressed="${cur.picks_color}">Customer picks color</button><button type="button" class="ce-tog" data-flag="tracked" aria-pressed="${cur.tracked}">Tracked in inventory</button><button type="button" class="ce-tog" data-flag="printed" aria-pressed="${cur.printed}">We print it</button><button type="button" class="ce-tog" data-flag="addon" aria-pressed="${cur.addon}">Add-ons bar</button></div>
      <h4 class="ce-h">Sizes</h4>
      <div class="ce-rows">${cur.sizes.map(sizeRow).join("")}</div>
      <datalist id="ieSizeNames">${[...SIZE_OPTIONS, "Standard"].map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
      <button type="button" class="btn ghost mini" data-addsize>+ Add size</button>
      <details class="ie-det ie-colors" data-det="colors" ${OPEN.has("colors") ? "open" : ""}><summary>Colors offered <span class="sub">${nCol}</span></summary>
        ${two ? `<div class="ie-field"><span>Color 1</span>${offered(1)}</div><div class="ie-field"><span>Color 2</span>${offered(2)}</div>` : offered(1)}</details>
      <h4 class="ce-h">Variations <span class="sub">${live.length}</span></h4>
      <div class="ce-rows">${live.map((v) => varRow(v, two, opts)).join("") || `<p class="empty">None.</p>`}</div>
      ${gone.length ? `<details class="ie-det" data-det="gone" ${OPEN.has("gone") ? "open" : ""}><summary>Removed <span class="sub">${gone.length}</span></summary><div class="ce-rows">${gone.map((v) => `<div class="ce-row ie-gone" data-var="${v.id}"><div class="ce-line"><span class="ie-gname">${esc(v.label || v.sku)}</span><button type="button" class="btn ghost mini" data-backvar>Bring back</button></div></div>`).join("")}</div></details>` : ""}
      <p class="err" id="ieErr" ${err ? "" : "hidden"}>${esc(err)}</p>
      <div class="row ce-foot"><button type="button" class="btn ghost" ${viaList ? "data-back" : "data-close"}>Cancel</button><button type="submit" class="btn accent" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Save"}</button></div>
    </form>`;
  card.scrollTop = top;
  if (err) q("#ieErr").scrollIntoView({ block: "nearest" });
}
function setErr(t) { const e = q("#ieErr"); if (e) { e.textContent = t || ""; e.hidden = !t; if (t) e.scrollIntoView({ block: "nearest" }); } }

const num = (x) => (String(x ?? "").trim() === "" ? null : Number(String(x).trim()));
function payload() {
  const p = { id: cur.id, stamp: cur.stamp, name: clean(cur.name), category: clean(cur.category), aliases: aliasesOut(), description: cur.description.trim(),
    tracked: cur.tracked, picks_color: cur.picks_color, addon: cur.addon, printed: cur.printed,
    sizes: cur.sizes.filter((s) => s.code || (!s.archived && clean(s.name))).map((s) => ({ code: s.code, name: clean(s.name), filament_g: num(s.g), print_minutes: num(s.min), print_profile: s.profile.trim(), ...(s.code ? { archived: s.archived } : {}) })),
    colors: { 1: cur.colors[1], 2: cur.colors[2] },
    variants: cur.vars.map((v) => { const s = sizeOf(v.size); const o = { id: v.id, note: v.note.trim(), size_code: s ? s.code || key(s.name) : v.size0, option_code: v.opt, archived: v.archived };
      if (colorChanged(v)) { o.color_1 = v.c1; o.color_2 = v.c1 ? v.c2 : ""; } return o; }),
    forget: cur.forget };
  if (cur.def.touched) { p.default_color_1 = cur.def.c1; p.default_color_2 = cur.def.c1 ? cur.def.c2 : ""; }
  return p;
}
function check() { // what the person can fix before the database is asked
  if (!clean(cur.name)) return "Give the item a name.";
  if (!clean(cur.category)) return "Give the item a type.";
  for (const s of cur.sizes) { if (s.archived) continue;
    if (s.code && !clean(s.name)) return "A size needs a name.";
    for (const [f, l] of [["g", "Filament"], ["min", "Print time"]]) { const n = num(s[f]); if (n != null && !(n > 0)) return `${clean(s.name) || "Size"}: ${l} must be a number above 0.`; } }
  const names = cur.sizes.filter((s) => !s.archived && clean(s.name)).map((s) => key(s.name)); if (new Set(names).size !== names.length) return "A size is listed twice.";
  for (const v of cur.vars) { if (v.archived) continue;
    const s = sizeOf(v.size); if (!s || s.archived || !clean(s.name)) return `${v.label || v.sku}: pick a size.`;
    if (v.c2 && !v.c1) return `${v.label || v.sku}: pick Color 1 first.`; }
  const seen = new Set(); for (const v of cur.vars) { const k = [key((sizeOf(v.size) || {}).name || v.size), v.c1, v.c2, v.opt].join("|"); if (seen.has(k)) return `${v.label || v.sku}: that size and color is here twice.`; seen.add(k); }
  return "";
}
async function save() {
  if (busy) return; relabel();
  const bad = check(); if (bad) return setErr(bad);
  busy = true; render();
  let r; try { r = await db.saveItem(payload()); }
  catch (e) { busy = false; render(db.errText(e).replace(/^stale:\s*/i, "")); return; }
  busy = false; cur = null; orig = "";
  const w = r.warnings || []; toast(`Saved ${r.name}${w.length ? " · " + w.join(" · ") : ""}`, w.length > 0);
  invalidateCatalog();
  if (viaList) { reloadInventory().catch(() => {}); await showList(); } else { M.close(); M = null; await reloadInventory(); }
}
async function leave() { if (!dirty()) return true; return confirmBox({ title: "Discard changes?", body: "Your edits to this item aren't saved.", ok: "Discard" }); }

function addAlias(raw) { let added = false; for (const part of String(raw).split(",")) { const a = clean(part); if (!a || key(a) === key(cur.name)) continue; if (cur.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) continue; cur.aliases.push(a); added = true; } return added; }
function redrawAliases(focus) { q("#ieAliases").innerHTML = aliasChips(); if (focus) q("#ieAlias").focus(); }

// open() lists every piece; open({ product, focus }) goes straight to one (focus = the inventory id of the variation to show)
export async function open({ product = null, focus = null } = {}) {
  if (M) return;
  busy = false; viaList = !product; focusVar = focus;
  M = modal(`<h3>Items</h3>`, { label: "Items", wide: true, guard: async () => { const ok = await leave(); if (ok) M = null; return ok; } });
  card = M.el.querySelector(".obmodal-card"); card.classList.add("ce-card");
  const varOf = (el) => { const id = el.closest("[data-var]")?.dataset.var; return cur.vars.find((v) => String(v.id) === id); };
  const sizeOfEl = (el) => { const k = Number(el.closest("[data-size]")?.dataset.size); return cur.sizes.find((s) => s.k === k); };
  card.addEventListener("click", async (e) => { const t = e.target; let b;
    if (t.closest("[data-close]")) { if (await leave()) { M.close(); M = null; } return; }
    if ((b = t.closest("[data-open]"))) { openEditor(b.dataset.open); return; }
    if (!cur) return;
    if (t.closest("[data-back]")) { if (await leave()) showList(); return; }
    if ((b = t.closest("[data-flag]"))) { cur[b.dataset.flag] = !cur[b.dataset.flag]; b.setAttribute("aria-pressed", String(cur[b.dataset.flag])); return; }
    if ((b = t.closest("[data-delalias]"))) { cur.aliases.splice(Number(b.dataset.delalias), 1); redrawAliases(); return; }
    if (t.closest("[data-delold]")) { cur.keepOld = false; redrawAliases(); return; }
    if (t.closest("[data-addsize]")) { const s = { k: ++seq, code: null, name: "", name0: "", g: "", min: "", profile: "", archived: false }; cur.sizes.push(s); render(); const el = q(`[data-size="${s.k}"] [data-f=name]`); if (el) el.focus(); return; }
    if (t.closest("[data-delsize]")) { const s = sizeOfEl(t); const used = cur.vars.filter((v) => !v.archived && v.size === sizeRef(s)).length;
      if (used) return setErr(`${clean(s.name) || "That size"} still has ${used === 1 ? "a variation" : used + " variations"}. Change or remove ${used === 1 ? "it" : "them"} first.`);
      if (cur.sizes.filter((x) => !x.archived).length < 2) return setErr("An item needs at least one size.");
      if (s.code) s.archived = true; else cur.sizes = cur.sizes.filter((x) => x !== s); render(); return; }
    if (t.closest("[data-backsize]")) { sizeOfEl(t).archived = false; render(); return; }
    if ((b = t.closest("[data-delcolor]"))) { const [slot, id] = b.dataset.delcolor.split(":"); cur.colors[slot] = cur.colors[slot].filter((x) => x !== id); OPEN.add("colors"); render(); return; }
    if (t.closest("[data-delvar]")) { const v = varOf(t);
      if (v.on_hand) return setErr(`${v.label || v.sku} still has ${v.on_hand} on the shelf. Count it to 0 first.`);
      if (v.open_lines) return setErr(`${v.label || v.sku} is on ${v.open_lines === 1 ? "an open order" : v.open_lines + " open order lines"}. Change those first.`);
      v.archived = true; OPEN.add("gone"); render(); return; }
    if (t.closest("[data-backvar]")) { const v = varOf(t); v.archived = false; const s = sizeOf(v.size); if (s) s.archived = false; render(); return; }
    if ((b = t.closest("[data-forget]"))) { const v = varOf(b); cur.forget.push(b.dataset.forget); v.learned = v.learned.filter((a) => a.key !== b.dataset.forget); OPEN.add("l" + v.id); render(); return; }
  });
  card.addEventListener("input", (e) => { const t = e.target;
    if (t.id === "ieQ") { listQ = t.value; drawList(); return; }
    if (!cur) return;
    if (t.id === "ieName") { cur.name = t.value; syncLabels(); const el = q("#ieAlias"); if (document.activeElement !== el) redrawAliases(); return; }
    if (t.id === "ieDesc") { cur.description = t.value; return; }
    if (t.id === "ieCatNew") { cur.category = t.value; return; }
    const f = t.dataset.f; if (!f) return;
    if (t.closest("[data-size]")) { const s = sizeOfEl(t); s[f] = t.value; if (f === "name") { syncLabels(); for (const o of card.querySelectorAll(`[data-f=size] option[value="${CSS.escape(sizeRef(s))}"]`)) o.textContent = clean(s.name) || "New size"; } return; }
    const v = varOf(t); if (!v) return;
    if (f === "note") v.note = t.value;
  });
  card.addEventListener("change", (e) => { if (!cur) return; const t = e.target;
    if (t.id === "ieCat") { cur.catOther = t.value === "__other"; cur.category = cur.catOther ? "" : t.value; render(); if (cur.catOther) { const el = q("#ieCatNew"); if (el) el.focus(); } return; }
    if (t.id === "ieAlias") { if (addAlias(t.value)) redrawAliases(false); else t.value = ""; return; }
    if (t.dataset.def) { cur.def[t.dataset.def] = t.value; cur.def.touched = true; if (!cur.def.c1) cur.def.c2 = ""; render(); return; }
    if (t.dataset.addcolor) { if (t.value) { cur.colors[t.dataset.addcolor].push(t.value); OPEN.add("colors"); render(); } return; }
    const f = t.dataset.f; const v = f && varOf(t); if (!v) return;
    if (f === "size" || f === "opt") { v[f] = t.value; syncLabels(); return; }
    if (f === "c1" || f === "c2") { v[f] = t.value; if (!v.c1) v.c2 = ""; relabel(); render(); return; }
  });
  card.addEventListener("keydown", (e) => { if (e.key !== "Enter" || e.target.tagName !== "INPUT") return; e.preventDefault(); if (cur && e.target.id === "ieAlias" && addAlias(e.target.value)) redrawAliases(true); });
  card.addEventListener("toggle", (e) => { const d = e.target; if (d.dataset && d.dataset.det) d.open ? OPEN.add(d.dataset.det) : OPEN.delete(d.dataset.det); }, true);
  card.addEventListener("submit", (e) => { e.preventDefault(); if (cur) { const a = q("#ieAlias"); if (a && a.value) addAlias(a.value); save(); } });
  if (product) await openEditor(product); else await showList();
}
