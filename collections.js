// Collections: build a new collection or edit one (name, its pieces and their pinned colorways,
// enclosure-only pieces, choices like Door/Floor). The database checks and saves it in one go (hq.save_collection).
import * as db from "./supabase.js";
import { esc, sizeOptions, modal, toast, confirmBox, cat, loadCatalog, invalidateCatalog, reloadInventory } from "./orders.js";

let M = null, card = null, list = [], cur = null, orig = "", busy = false, seq = 0;
const CAT_ORDER = ["Enclosure", "Hide", "Ledge", "Climb", "Floor Insert", "Insert", "Figure", "Add-on", "Supply", "Part", "Kit", "Set"];
const snap = () => JSON.stringify(cur && { ...cur, pieces: cur.pieces.map(({ open, ...r }) => r) });
const dirty = () => !!cur && snap() !== orig;
const q = (s) => card.querySelector(s);
const prod = (id) => cat.byProduct.get(id) || null;
const colorName = (id) => (cat.colors.get(id) || {}).name || id || "";
const sizeName = (p, code) => ((p && (p.size_codes || []).find((s) => s.code === code)) || {}).name || code;
const optLabel = (code) => (code === "standard" ? "Standard" : code.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()));

function productColors(p) { // colors the catalog offers this piece in, plus every colorway it already has
  const s1 = new Set((p.offered || {})["1"] || []), s2 = new Set((p.offered || {})["2"] || []);
  for (const v of cat.variants) if (v.product_id === p.id) { const s = cat.schemes.get(v.color_scheme_id); if (s && s.color_1) { s1.add(s.color_1); if (s.color_2) s2.add(s.color_2); } }
  return { s1, s2, two: s2.size > 0 || p.category === "Floor Insert" };
}
const optionCodes = (p) => [...new Set(cat.variants.filter((v) => v.product_id === p.id).map((v) => v.option_code || "standard"))].sort((a, b) => (a === "standard" ? -1 : b === "standard" ? 1 : a.localeCompare(b)));

const rowOf = (x) => ({ key: ++seq, id: x.id ?? null, product_id: x.product_id || "", scheme: x.color_scheme_id ?? null, c1: x.color_1 || "", c2: x.color_2 || "", touched: false,
  size_code: x.size_code || "", qty: x.qty || 1, enclosure_only: !!x.enclosure_only, hadEnc: !!x.enclosure_only, choice: x.choice || "", choice_option: x.choice_option || "", option_code: x.option_code || "standard", default_option: !!x.default_option, open: !!x.choice });

/* ---------- list ---------- */
async function showList(note = "") {
  cur = null; orig = "";
  card.innerHTML = `<h3>Collections</h3><p class="sub">Loading…</p>`;
  try { [list] = await Promise.all([db.readCollections(), loadCatalog()]); } catch (e) { card.innerHTML = `<h3>Collections</h3><p class="err">⚠ ${esc(db.errText(e))}</p><div class="row"><button type="button" class="btn ghost" data-close>Close</button></div>`; return; }
  const pieces = (c) => new Set(c.pieces.map((x) => x.product_id + "|" + (x.color_scheme_id || ""))).size;
  card.innerHTML = `<div class="ce-head"><h3>Collections</h3><button type="button" class="btn mini" data-new>+ New collection</button></div>
    ${note ? `<p class="ce-note">${esc(note)}</p>` : ""}
    <div class="ce-list">${list.map((c) => `<button type="button" class="ce-item${c.archived ? " retired" : ""}" data-open="${esc(c.id)}"><b>${esc(c.name)}</b><span class="sub">${c.archived ? "Retired · " : ""}${pieces(c)} ${pieces(c) === 1 ? "piece" : "pieces"}</span></button>`).join("") || `<p class="empty">No collections yet.</p>`}</div>
    <div class="row"><button type="button" class="btn ghost" data-close>Close</button></div>`;
}

/* ---------- editor ---------- */
function openEditor(c) {
  cur = c ? { id: c.id, name: c.name, archived: c.archived, sells_accessory_set: c.sells_accessory_set, sells_enclosure: c.sells_enclosure, updated_at: c.updated_at, pieces: c.pieces.map(rowOf) }
          : { id: null, name: "", archived: false, sells_accessory_set: true, sells_enclosure: false, updated_at: null, pieces: [rowOf({})] };
  orig = snap(); render();
  setTimeout(() => { const el = c ? null : q("#ceName"); if (el) el.focus(); }, 30);
}

function productSelect(r) {
  const groups = new Map(); for (const p of (cat.opts.products || [])) { const k = p.category || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const keys = [...groups.keys()].sort((a, b) => (CAT_ORDER.indexOf(a) + 1 || 99) - (CAT_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const missing = r.product_id && !prod(r.product_id) ? `<option value="${esc(r.product_id)}" selected>${esc(r.product_id)} (removed)</option>` : "";
  return `<select data-f="product_id" aria-label="Piece"><option value="">Pick a piece…</option><option value="__new">+ New piece…</option>${missing}${keys.map((k) => `<optgroup label="${esc(k)}">${groups.get(k).sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${esc(p.id)}" ${p.id === r.product_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`).join("")}</select>`;
}
function colorSelect(r, p, slot) {
  const pc = productColors(p); const mine = slot === 1 ? pc.s1 : pc.s2; const val = slot === 1 ? r.c1 : r.c2;
  const all = [...cat.colors.values()].sort((a, b) => a.name.localeCompare(b.name));
  const opt = (c) => `<option value="${esc(c.id)}" ${c.id === val ? "selected" : ""}>${esc(c.name)}</option>`;
  const made = all.filter((c) => mine.has(c.id)), other = all.filter((c) => !mine.has(c.id));
  const first = slot === 1 ? (r.scheme === "standard" && !r.touched ? `<option value="__std" selected>Standard</option>` : "") + `<option value="" ${!val && !(r.scheme === "standard" && !r.touched) ? "selected" : ""}>Any color</option>` : `<option value="">None</option>`;
  return `<select data-f="c${slot}" aria-label="Color ${slot}">${first}${made.length ? `<optgroup label="Made in">${made.map(opt).join("")}</optgroup><optgroup label="Other colors">${other.map(opt).join("")}</optgroup>` : all.map(opt).join("")}</select>`;
}
function pieceRow(r, i) {
  const p = prod(r.product_id);
  const sizes = p ? p.size_codes || [] : []; const opts = p ? optionCodes(p) : [];
  const pcs = p && productColors(p); const two = p && (pcs.two || r.c2);
  const hasColor = p && (pcs.s1.size > 0 || p.picks_color || r.c1 || (r.scheme && r.scheme !== "standard"));
  const choiceNames = [...new Set(["Door", "Floor", ...cur.pieces.map((x) => x.choice).filter(Boolean)])];
  const optNames = [...new Set(cur.pieces.filter((x) => x.choice && x.choice === r.choice).map((x) => x.choice_option).filter(Boolean))];
  return `<div class="ce-row" data-row="${r.key}">
    <div class="ce-line"><label class="ce-piece">Piece ${productSelect(r)}</label><label class="ce-qty">Qty<input data-f="qty" type="number" min="1" max="99" inputmode="numeric" value="${esc(r.qty)}"></label><button type="button" class="ce-x" data-del aria-label="Remove piece">×</button></div>
    ${p ? `<div class="ce-line">
      ${hasColor ? `<label>Color${two ? " 1" : ""}${colorSelect(r, p, 1)}</label>` : ""}
      ${hasColor && two ? `<label>Color 2${colorSelect(r, p, 2)}</label>` : ""}
      ${sizes.length > 1 || r.size_code ? `<label>Size<select data-f="size_code"><option value="">Any size</option>${sizes.map((s) => `<option value="${esc(s.code)}" ${s.code === r.size_code ? "selected" : ""}>${esc(s.name)}</option>`).join("")}${r.size_code && !sizes.some((s) => s.code === r.size_code) ? `<option value="${esc(r.size_code)}" selected>${esc(sizeName(p, r.size_code))}</option>` : ""}</select></label>` : ""}
      ${opts.length > 1 || r.option_code !== "standard" ? `<label>Option<select data-f="option_code">${[...new Set([...opts, r.option_code])].map((o) => `<option value="${esc(o)}" ${o === r.option_code ? "selected" : ""}>${esc(optLabel(o))}</option>`).join("")}</select></label>` : ""}
    </div>
    <div class="ce-line ce-flags">
      ${r.hadEnc ? `<button type="button" class="ce-tog" data-tog="enclosure_only" aria-pressed="${r.enclosure_only}">Complete enclosure only</button>` : ""}
      <button type="button" class="ce-tog" data-tog="open" aria-pressed="${r.open}">Choice</button>
      ${r.open ? `<label>Choice<input data-f="choice" list="ceChoices${i}" value="${esc(r.choice)}" placeholder="Floor"><datalist id="ceChoices${i}">${choiceNames.map((n) => `<option value="${esc(n)}">`).join("")}</datalist></label>
        <label>Option<input data-f="choice_option" list="ceOpts${i}" value="${esc(r.choice_option)}" placeholder="Substrate"><datalist id="ceOpts${i}">${optNames.map((n) => `<option value="${esc(n)}">`).join("")}</datalist></label>
        <label class="ce-def"><span><input type="checkbox" data-f="default_option" ${r.default_option ? "checked" : ""}> Default</span></label>` : ""}
    </div>` : ""}
  </div>`;
}
function render(err = "") {
  if (!cur) return;
  const enc = cur.pieces.filter((r) => r.enclosure_only).length;
  card.innerHTML = `<div class="ce-head"><button type="button" class="btn ghost mini" data-back>‹ Collections</button>${cur.archived ? `<span class="chip hold">Retired</span>` : ""}</div>
    <form class="addvar ce" novalidate>
      <div class="srow"><label style="flex:2 1 220px">Name<input id="ceName" value="${esc(cur.name)}" placeholder="e.g. Mushroom Forest" autocomplete="off"></label></div>
      <h4 class="ce-h">Pieces <span class="sub">${cur.pieces.length}${enc ? ` · ${enc} only with the enclosure` : ""}</span></h4>
      <div class="ce-rows">${cur.pieces.map(pieceRow).join("")}</div>
      <button type="button" class="btn ghost mini" data-add>+ Add piece</button>
      <p class="err" id="ceErr" ${err ? "" : "hidden"}>${esc(err)}</p>
      <div class="row ce-foot">${cur.id ? `<button type="button" class="btn ghost" data-retire>${cur.archived ? "Bring back" : "Retire"}</button><span style="flex:1"></span>` : ""}<button type="button" class="btn ghost" data-back>Cancel</button><button type="submit" class="btn accent" ${busy ? "disabled" : ""}>${busy ? "Saving…" : cur.id ? "Save" : "Create"}</button></div>
    </form>`;
}
const rowByEl = (el) => { const k = Number(el.closest("[data-row]")?.dataset.row); return cur.pieces.find((r) => r.key === k); };
function setErr(t) { const e = q("#ceErr"); if (e) { e.textContent = t || ""; e.hidden = !t; if (t) e.scrollIntoView({ block: "nearest" }); } }

function payload() {
  return { id: cur.id, name: cur.name.trim(), archived: cur.archived, sells_accessory_set: cur.sells_accessory_set, sells_enclosure: cur.sells_enclosure, ...(cur.updated_at ? { updated_at: cur.updated_at } : {}),
    pieces: cur.pieces.filter((r) => r.product_id).map((r) => ({ id: r.id, product_id: r.product_id, qty: Math.max(1, Math.round(Number(r.qty) || 1)), size_code: r.size_code || null,
      enclosure_only: r.enclosure_only, option_code: r.option_code || "standard",
      choice: r.open ? r.choice.trim() || null : null, choice_option: r.open ? r.choice_option.trim() || null : null, default_option: r.open && r.default_option,
      ...(r.touched ? (r.c1 === "__std" ? { color_scheme_id: "standard" } : { color_1: r.c1 || null, color_2: r.c1 ? r.c2 || null : null }) : { color_scheme_id: r.scheme }) })) };
}
async function save() {
  if (busy) return; setErr("");
  if (!cur.name.trim()) { setErr("Give the collection a name."); return q("#ceName").focus(); }
  if (!cur.archived && !cur.sells_accessory_set && !cur.sells_enclosure) return setErr("Pick how it's sold.");
  if (!cur.pieces.some((r) => r.product_id)) return setErr("Add at least one piece.");
  const half = cur.pieces.find((r) => r.open && (!r.choice.trim() !== !r.choice_option.trim())); if (half) return setErr(`${(prod(half.product_id) || {}).name || "A piece"}: a choice needs both its name and the option.`);
  busy = true; render();
  let r; try { r = await db.saveCollection(payload()); }
  catch (e) { busy = false; render(db.errText(e)); return; }
  busy = false; invalidateCatalog(); cur = null; orig = "";
  const w = (r.warnings || []); toast(`${r.created ? "Created" : "Saved"} ${r.name}${w.length ? " · " + w.join(" · ") : ""}`, w.length > 0);
  reloadInventory().catch(() => {});
  await showList();
}

/* ---------- a piece the catalog doesn't have yet: made through add_variant (product + its first size/colorway), then picked on this row ---------- */
function newPiece(row) {
  const cats = ((cat.opts.categories || []).length ? cat.opts.categories : ["Hide", "Ledge", "Climb", "Floor Insert", "Insert", "Figure", "Part", "Enclosure", "Add-on", "Supply"]).filter((c) => !/^(Kit|Set)$/.test(c));
  const colors = [...cat.colors.values()].sort((a, b) => a.name.localeCompare(b.name));
  const copt = colors.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  const m = modal(`<h3>New piece</h3><form class="addvar">
    <div class="srow"><label style="flex:2 1 220px">Name<input id="npName" placeholder="e.g. Mushroom Ledge" autocomplete="off"></label><label>Type<select id="npCat">${cats.map((c) => `<option ${c === "Ledge" ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label></div>
    <div class="srow"><label>Size<select id="npSize">${sizeOptions([], "Small", true).replace(/<option value="__other">.*$/, "")}</select></label>
      <label>Color<select id="npC1"><option value="">(none)</option>${copt}</select></label><label id="npC2w" hidden>Color 2<select id="npC2"><option value="">(none)</option>${copt}</select></label>
      <label>On the shelf<input id="npCount" type="number" min="0" max="999" value="0" inputmode="numeric"></label></div>
    <p class="err" id="npErr" hidden></p><div class="row"><button type="button" class="btn ghost" data-np-close>Cancel</button><button type="submit" class="btn accent" id="npSave">Add piece</button></div></form>`, { label: "New piece" });
  const g = (s) => m.el.querySelector(s); const err = (t) => { g("#npErr").textContent = t || ""; g("#npErr").hidden = !t; };
  const two = () => { g("#npC2w").hidden = g("#npCat").value !== "Floor Insert"; };
  g("#npCat").onchange = two; g("form").oninput = () => err(""); g("[data-np-close]").onclick = m.close; setTimeout(() => g("#npName").focus(), 30);
  g("form").onsubmit = async (e) => {
    e.preventDefault(); err("");
    const name = g("#npName").value.trim().replace(/\s+/g, " "), category = g("#npCat").value, size = g("#npSize").value;
    const c1 = g("#npC1").value, c2 = g("#npC2w").hidden ? "" : g("#npC2").value; const n = Math.max(0, Math.round(Number(g("#npCount").value) || 0));
    if (!name) return err("Give the piece a name.");
    if (c2 && !c1) return err("Pick Color 1 first.");
    const key = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); // as the database compares names
    const same = (cat.opts.products || []).find((p) => key(p.name) === key(name) || (p.aliases || []).some((a) => key(a) === key(name)));
    if (same) return err(`${same.name} is already in the catalog. Pick it from the list.`);
    const colorLabel = [c1, c2].filter(Boolean).map(colorName).join(" + ");
    const base = cur && cur.name.trim() ? `${cur.name.trim()} - ${name}` : name;
    const inventory_name = `${base} (${[size, colorLabel].filter(Boolean).join(", ")})`;
    const btn = g("#npSave"); btn.disabled = true; btn.textContent = "Adding…";
    let r; try { r = await db.addVariant({ product: name, category, size, color_1: c1 ? colorName(c1) : null, color_2: c2 ? colorName(c2) : null, inventory_name, new: ["product", "size"] }); }
    catch (x) { btn.disabled = false; btn.textContent = "Add piece"; return err(db.errText(x)); }
    invalidateCatalog();
    try { await loadCatalog(true); } catch (x) { /* the piece is made; the row is filled once the catalog reads */ }
    const v = cat.varById.get(String(r.variant_id)); const pid = v ? v.product_id : ((cat.opts.products || []).find((p) => p.name.toLowerCase() === name.toLowerCase()) || {}).id;
    let note = "";
    if (n > 0) { try { await db.applyMoves([{ notion_id: r.notion_id, kind: "count", qty: n, reason: "Starting count", ref: "inventory" }]); } catch (x) { note = ` · the shelf count wasn't saved (${db.errText(x)}); count it in Inventory`; } }
    m.close(); reloadInventory().catch(() => {});
    if (pid && cur && cur.pieces.includes(row)) { Object.assign(row, { product_id: pid, scheme: null, c1: "", c2: "", touched: true, size_code: "", option_code: "standard" }); render(); }
    toast(`Added ${inventory_name} to the catalog${note}`, !!note || !pid);
  };
}

async function leave() { if (!dirty()) return true; return confirmBox({ title: "Discard changes?", body: "Your edits to this collection aren't saved.", ok: "Discard" }); }

export async function open() {
  if (M) return;
  busy = false;
  M = modal(`<h3>Collections</h3>`, { label: "Collections", wide: true, guard: async () => { const ok = await leave(); if (ok) M = null; return ok; } });
  card = M.el.querySelector(".obmodal-card"); card.classList.add("ce-card");
  card.addEventListener("click", async (e) => { const t = e.target; let b;
    if (t.closest("[data-close]")) { M.close(); M = null; return; }
    if (t.closest("[data-new]")) { openEditor(null); return; }
    if ((b = t.closest("[data-open]"))) { const c = list.find((x) => x.id === b.dataset.open); if (c) openEditor(c); return; }
    if (!cur) return;
    if (t.closest("[data-back]")) { if (await leave()) showList(); return; }
    if (t.closest("[data-add]")) { cur.pieces.push(rowOf({})); render(); const rows = card.querySelectorAll("[data-row] select[data-f=product_id]"); const el = rows[rows.length - 1]; if (el) { el.focus(); el.scrollIntoView({ block: "center" }); } return; }
    if (t.closest("[data-del]")) { const r = rowByEl(t); cur.pieces = cur.pieces.filter((x) => x !== r); if (!cur.pieces.length) cur.pieces.push(rowOf({})); render(); return; }
    if ((b = t.closest("[data-tog]"))) { const r = rowByEl(b); const k = b.dataset.tog; r[k] = !r[k]; render(); if (k === "open" && r.open) { const el = card.querySelector(`[data-row="${r.key}"] [data-f=choice]`); if (el) el.focus(); } return; }
    if (t.closest("[data-retire]")) {
      if (!cur.archived && !(await confirmBox({ title: `Retire ${cur.name}?`, body: "It leaves the Order Desk and stops labeling inventory. Orders and items keep their names, and you can bring it back.", ok: "Retire" }))) return;
      cur.archived = !cur.archived; save(); return;
    }
  });
  card.addEventListener("input", (e) => { if (!cur) return; const t = e.target;
    if (t.id === "ceName") { cur.name = t.value; return; }
    const f = t.dataset.f; if (!f) return; const r = rowByEl(t);
    if (f === "qty" || f === "choice" || f === "choice_option") r[f] = t.value;
  });
  card.addEventListener("change", (e) => { if (!cur) return; const t = e.target; const f = t.dataset.f; if (!f) return; const r = rowByEl(t);
    if (f === "product_id" && t.value === "__new") { t.value = r.product_id; newPiece(r); return; }
    if (f === "product_id") { r.product_id = t.value; r.scheme = null; r.c1 = ""; r.c2 = ""; r.touched = true; r.size_code = ""; r.option_code = "standard"; render(); return; }
    if (f === "c1" || f === "c2") { r[f] = t.value; r.touched = true; if (f === "c1" && (!t.value || t.value === "__std")) r.c2 = ""; render(); return; }
    if (f === "size_code" || f === "option_code") { r[f] = t.value; return; }
    if (f === "default_option") { r.default_option = t.checked; if (t.checked) for (const x of cur.pieces) if (x !== r && x.choice.trim().toLowerCase() === r.choice.trim().toLowerCase()) x.default_option = false; render(); return; }
  });
  card.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && cur) { e.preventDefault(); } });
  await showList();
}
