// Today: one screen that reads the open orders, the print plan and the shelf, and says what needs a person.
// READ-ONLY. It calls no save function. Orders and shelf counts come from the copy Bin View already loaded
// (orders.js `store`); the print plan is read with read_app_state, the same read Print Plan uses.
// Every button here only switches to another tab.
import * as db from "../supabase.js";
import { esc, plural, isoDay, addDays, NO_DATE, store, onChange, eff, lineKind, shipBy, isExpress, obPick, NSTAT, platColor, invRowOf } from "../orders.js";

const KEY = "printplan2/main";
const PRINTERS = [1, 2, 3, 4, 5, 6];
const LIVE = new Set(["queued", "printing"]);
let host = null, panel = null, plan = null, planVersion = null, planErr = "", planAt = 0, reading = false;

const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
const fmtHours = (h) => { const m = Math.round(h * 60); const s = (m >= 60 ? Math.floor(m / 60) + "h " : "") + (m % 60 ? (m % 60) + "m" : ""); return s.trim() || "0m"; };
const longDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
const shortDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" });
const visible = () => !!panel && !panel.hidden;

/* ---------- the print plan: read only ---------- */
async function readPlan() {
  if (reading) return; reading = true;
  try {
    const rows = await db.readAppState([KEY], planVersion == null ? {} : { [KEY]: planVersion });
    const row = Array.isArray(rows) ? rows.find((r) => r.key === KEY) : null;
    if (row && !row.same) { plan = row.value || null; planVersion = row.version; }
    else if (!row && planVersion == null) { plan = null; planVersion = 0; }
    planErr = ""; planAt = Date.now();
  } catch (e) { planErr = db.errText(e); }
  reading = false; render();
}
const lanes = () => PRINTERS.map((p) => ({ printer: p, batches: ((plan && plan.lanes && plan.lanes[p]) || []).filter((b) => b && b.state !== "done") }));
const batchHours = (b) => (b.hoursOverride != null ? Number(b.hoursOverride) : sum(b.items || [], (i) => Number(i.hours) || 0));
function batchLabel(b) {
  const names = new Map(); for (const it of b.items || []) { const n = (it.spec && it.spec.name) || "Piece"; names.set(n, (names.get(n) || 0) + 1); }
  const list = [...names.entries()]; if (!list.length) return b.name || "Empty batch";
  return list.slice(0, 2).map(([n, c]) => n + " ×" + c).join(", ") + (list.length > 2 ? ", +" + (list.length - 2) + " more" : "");
}

/* ---------- orders: the same rules Bin View uses (orders.js eff) ---------- */
function orderSum(o) {
  const L = (o.lines || []).filter((l) => lineKind(l) !== "enc");
  const s = { total: L.length, ready: 0, toPrint: 0, printing: 0, out: 0, packed: 0, conflicts: 0, unmatched: 0 };
  for (const l of o.lines || []) { if (l.conflict) s.conflicts++; if (l.match === "unmatched") s.unmatched++; }
  for (const l of L) {
    const st = eff(l).st;
    if (l.packed) s.packed++;
    if (l.packed || ["printed", "shelf", "out", "none"].includes(st)) s.ready++; // same test as Bin View's "Ready to Pack" hint
    else if (st === "print") s.toPrint++; else if (st === "printing") s.printing++;
    if (!l.packed && st === "out") s.out++;
  }
  s.isReady = s.total > 0 && s.ready === s.total;
  return s;
}
// pieces still to print, and how many of them are already on a printer's queue
function pieceCounts() {
  const queued = new Map(); // line uid -> pieces sitting in a queued or printing batch
  for (const ln of lanes()) for (const b of ln.batches) if (LIVE.has(b.state)) for (const it of b.items || []) { const uid = String(it.pieceId || "").split("#")[0]; if (uid) queued.set(uid, (queued.get(uid) || 0) + 1); }
  let toPrint = 0, printing = 0, notQueued = 0;
  for (const o of store.open) for (const l of o.lines || []) {
    if (l.packed || lineKind(l) !== "print") continue;
    const e = eff(l), qty = Math.max(1, Number(l.qty) || 1);
    if (e.st === "printing") printing += qty;
    if (e.st === "print") { const n = Math.max(0, qty - (e.part ? e.a : 0)); toPrint += n; notQueued += Math.max(0, n - (queued.get(l.uid) || 0)); }
  }
  return { toPrint, printing, notQueued };
}
function mostNeeded() {
  const inQueue = new Map();
  for (const ln of lanes()) for (const b of ln.batches) if (LIVE.has(b.state)) for (const it of b.items || []) { const id = it.spec && it.spec.inv; if (id) inQueue.set(id, (inQueue.get(id) || 0) + 1); }
  return store.inv.filter((r) => r.in_stock != null && Number(r.owed) > Number(r.in_stock)).map((r) => ({ r, need: Number(r.owed), have: Number(r.in_stock), queued: inQueue.get(r.id) || 0 }))
    .sort((a, b) => (b.need - b.have) - (a.need - a.have) || String(a.r.name).localeCompare(String(b.r.name)));
}

/* ---------- what needs a person ---------- */
function needs(sums, pc) {
  const out = [], t = isoDay();
  const add = (title, detail, label, go, arg, red) => out.push({ title, detail, label, go, arg: arg || "", red: !!red });
  if (store.err) add("Orders could not be read", store.err, "", "", "", true);
  if (planErr) add("The print plan could not be read", planErr, "", "", "", true);
  const late = store.open.filter((o) => shipBy(o) < t);
  if (late.length) add(plural(late.length, "order is", "orders are") + " overdue", late.slice(0, 3).map((o) => o.customer).join(", ") + (late.length > 3 ? " and " + (late.length - 3) + " more" : ""), "Open", "bins", late[0].id, true);
  const src = (store.sources || []).length;
  if (src) add(plural(src, "sale") + " not entered yet", "Read in from a shop, waiting to become an order", "Open", "bins");
  const review = store.open.filter((o) => o.review === "pending");
  if (review.length) add(plural(review.length, "order") + " to review", "Read in from a shop. Check it came through right", "Open", "bins", review[0].id);
  const conf = store.open.filter((o) => sums.get(o.id).conflicts);
  if (conf.length) add(plural(sum(conf, (o) => sums.get(o.id).conflicts), "line disagrees", "lines disagree") + " with what the order said", conf.slice(0, 3).map((o) => o.customer).join(", "), "Open", "bins", conf[0].id);
  const unm = store.open.filter((o) => sums.get(o.id).unmatched);
  if (unm.length) add(plural(sum(unm, (o) => sums.get(o.id).unmatched), "line is", "lines are") + " not matched to an item", unm.slice(0, 3).map((o) => o.customer).join(", "), "Open", "bins", unm[0].id);
  for (const ln of lanes()) { const n = ln.batches.filter((b) => b.state === "review").length; if (n) add("Printer " + ln.printer + " has " + plural(n, "batch", "batches") + " printed, waiting to finalize", ln.batches.filter((b) => b.state === "review").map(batchLabel).join("; "), "Open plan", "print"); }
  if (plan && pc.notQueued) add(plural(pc.notQueued, "piece is", "pieces are") + " not on a printer yet", "Out of " + pc.toPrint + " still to print", "Open plan", "print");
  const outNames = new Map();
  for (const o of store.open) for (const l of o.lines || []) if (!l.packed && lineKind(l) !== "enc" && eff(l).st === "out") { const r = invRowOf(l); const n = (r && r.name) || "Stock item"; outNames.set(n, (outNames.get(n) || 0) + (Number(l.qty) || 1)); }
  if (outNames.size) add("The shelf is out of " + plural(outNames.size, "stock item") + " that open orders need", [...outNames.entries()].slice(0, 3).map(([n, c]) => n + " ×" + c).join(", ") + (outNames.size > 3 ? " and " + (outNames.size - 3) + " more" : ""), "Inventory", "inventory");
  return out;
}

/* ---------- draw ---------- */
function shipRow(o, s, t) {
  const cur = obPick(o.status), late = shipBy(o) < t;
  const state = s.isReady ? "Ready to pack" : [s.toPrint ? s.toPrint + " to print" : "", s.printing ? s.printing + " printing" : ""].filter(Boolean).join(", ") || "Not ready";
  return `<div class="tship"><button type="button" class="tname" data-go="bins" data-arg="${esc(o.id)}">${esc(o.customer)}</button>
    <span class="tplat">${(o.platform || []).map((p) => `<span class="np np-${platColor(p)}">${esc(p)}</span>`).join("")}${isExpress(o) ? '<span class="np np-red">Express</span>' : ""}${late ? '<span class="np np-red">Overdue</span>' : ""}</span>
    <span class="tprog"><span class="tbar"><i style="width:${s.total ? Math.round((s.ready / s.total) * 100) : 0}%"></i></span><span class="sub">${s.ready} of ${s.total}</span></span>
    <span class="tstat"><span class="np np-${NSTAT[cur] || "gray"}"><i></i>${esc(cur)}</span><span class="sub${s.isReady ? " tok" : ""}">${esc(state)}</span></span></div>`;
}
function printerCard(ln) {
  const printing = ln.batches.filter((b) => b.state === "printing"), queued = ln.batches.filter((b) => b.state === "queued"), review = ln.batches.filter((b) => b.state === "review");
  const qPieces = sum(queued, (b) => (b.items || []).length), qHours = sum(queued, batchHours);
  const head = printing[0];
  return `<div class="tprinter${review.length ? " act" : ""}"><div class="tprow"><span class="tpn" style="background:var(--p${ln.printer})">${ln.printer}</span>
    <b>${head ? esc(batchLabel(head)) : review.length ? "Printed, waiting to finalize" : "No batch running"}</b><span style="flex:1"></span>${head ? `<span class="np np-blue"><i></i>Printing</span>` : ""}</div>
    <div class="sub">${head ? plural((head.items || []).length, "piece") + ", " + fmtHours(batchHours(head)) + " print" + (printing.length > 1 ? ", +" + (printing.length - 1) + " more printing" : "") + ". " : ""}${queued.length ? plural(queued.length, "batch", "batches") + " waiting, " + plural(qPieces, "piece") + ", " + fmtHours(qHours) : "Nothing waiting"}</div></div>`;
}
function render() {
  if (!host || !visible()) return;
  if (!store.loadedAt && !store.err) { host.innerHTML = '<div class="card"><div class="empty">Reading orders…</div></div>'; return; }
  const t = isoDay(), open = store.open, sums = new Map(open.map((o) => [o.id, orderSum(o)])), pc = pieceCounts(), nd = needs(sums, pc);
  const due = open.filter((o) => shipBy(o) <= t), dated = open.filter((o) => shipBy(o) > t && shipBy(o) !== NO_DATE);
  const nextDay = dated.length ? dated.map(shipBy).sort()[0] : null;
  const shipList = due.length ? due : nextDay ? open.filter((o) => shipBy(o) === nextDay) : [];
  const readyN = shipList.filter((o) => sums.get(o.id).isReady).length;
  const ls = lanes(), printingN = ls.filter((l) => l.batches.some((b) => b.state === "printing")).length, waitingN = sum(ls, (l) => l.batches.filter((b) => b.state === "queued").length);
  const days = []; for (let i = 0; i < 7; i++) { const d = addDays(t, i); days.push({ label: i ? shortDay(d) : "Today", n: open.filter((o) => shipBy(o) === d).length, now: !i }); }
  const overdue = open.filter((o) => shipBy(o) < t).length; if (overdue) days.unshift({ label: "Overdue", n: overdue, bad: true });
  const later = open.filter((o) => shipBy(o) > addDays(t, 6)).length; if (later) days.push({ label: "Later", n: later });
  const dmax = Math.max(1, ...days.map((d) => d.n));
  const need = mostNeeded();
  const kpi = (label, value, note, act) => `<div class="kpi"><span>${label}</span><b${act ? ' class="tact"' : ""}>${value}</b><small>${note}</small></div>`;
  host.innerHTML = `
    <div class="kpis">
      ${kpi("Ship today", due.length, due.length ? `${readyN} ready to pack${overdue ? ", " + overdue + " overdue" : ""}` : nextDay ? `Next: ${esc(longDay(nextDay))}, ${plural(open.filter((o) => shipBy(o) === nextDay).length, "order")}` : "No open orders with a ship date")}
      ${kpi("Needs a person", nd.length, nd.length ? esc(nd[0].title) : "All clear", nd.length)}
      ${kpi("Printing now", plan ? `${printingN} of ${PRINTERS.length}` : "…", plan ? (waitingN ? plural(waitingN, "batch", "batches") + " waiting" : "No batch is waiting") : planErr ? "Plan not read" : "Reading the plan…")}
      ${kpi("Pieces to print", pc.toPrint, (pc.printing ? pc.printing + " printing now. " : "") + (!plan ? "" : pc.notQueued ? pc.notQueued + " not on a printer yet" : pc.toPrint ? "All on a printer's queue" : "Nothing to print"))}
    </div>
    <div class="tcols"><div class="tmain">
      <div class="card"><div class="row"><h2>Needs you</h2>${nd.length ? `<span class="chip watch">${nd.length}</span>` : ""}</div>
        ${nd.length ? nd.map((n) => `<div class="tneed${n.red ? " red" : ""}"><i></i><div><b>${esc(n.title)}</b><span class="sub">${esc(n.detail)}</span></div>${n.go ? `<button type="button" class="btn ghost mini" data-go="${n.go}" data-arg="${esc(n.arg)}">${esc(n.label)}</button>` : ""}</div>`).join("") : '<div class="empty">Nothing is waiting on you.</div>'}</div>
      <div class="card"><div class="row"><h2>${due.length ? "Shipping today" : nextDay ? "Shipping next: " + esc(longDay(nextDay)) : "Shipping"}</h2><span class="sub">${shipList.length ? `${readyN} of ${plural(shipList.length, "order")} ready to pack` : ""}</span></div>
        ${shipList.length ? `<div class="tscroll">${shipList.map((o) => shipRow(o, sums.get(o.id), t)).join("")}</div>` : '<div class="empty">No open orders.</div>'}</div>
      <div class="card"><div class="row"><h2>Orders to ship</h2><span class="sub">${plural(open.length, "open order")}</span></div>
        <div class="tbars" style="grid-template-columns:repeat(${days.length},minmax(0,1fr))">${days.map((d) => `<div><b>${d.n}</b><i class="${d.bad ? "bad" : d.now ? "now" : ""}" style="height:${Math.max(4, Math.round((d.n / dmax) * 96))}px"></i><span class="sub">${esc(d.label)}</span></div>`).join("")}</div></div>
    </div><div class="tside">
      <div class="card"><div class="row"><h2>Printers</h2><button type="button" class="btn ghost mini" data-go="print">Open plan</button></div>
        ${plan ? ls.map(printerCard).join("") : `<div class="empty">${planErr ? "⚠ " + esc(planErr) : "Reading the plan…"}</div>`}</div>
      <div class="card"><div class="row"><h2>Most needed</h2><span class="sub">${need.length ? plural(need.length, "item") + " short" : ""}</span></div>
        ${need.length ? need.slice(0, 8).map((x) => `<div class="tli"><div><b>${esc(x.r.name)}</b><span class="sub">${x.need} needed, ${x.have} on the shelf</span></div><span class="sub tq">${x.queued ? x.queued + " queued" : ""}</span></div>`).join("") + (need.length > 8 ? `<div class="sub">and ${need.length - 8} more</div>` : "") : '<div class="empty">The shelf covers every open order.</div>'}</div>
    </div></div>
    <div class="sub">Today only reads. It changes nothing. Orders and shelf as of ${store.loadedAt ? esc(store.loadedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })) : "…"}${planAt ? ", plan as of " + esc(new Date(planAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })) : ""}.</div>`;
}

/* ---------- moving to another tab (the only thing a button here does) ---------- */
function go(tab, arg) {
  if (tab === "print") { document.dispatchEvent(new CustomEvent("spood:printqueue")); return; }
  const b = document.querySelector(`nav.tabs button[data-tab="${tab}"]`); if (!b) return;
  b.click();
  if (tab === "bins" && arg) setTimeout(() => { const c = document.querySelector(`.ncard[data-ob="${CSS.escape(arg)}"]`); if (!c) return; c.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }); c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 1600); }, 80);
}

export function init() {
  panel = document.getElementById("tab-today"); host = document.getElementById("todayHost"); if (!host) return;
  host.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) go(b.dataset.go, b.dataset.arg); });
  const refresh = () => { if (!visible()) return; render(); if (Date.now() - planAt > 8000) readPlan(); };
  onChange(refresh);
  const tab = document.querySelector('nav.tabs button[data-tab="today"]'); if (tab) tab.addEventListener("click", () => setTimeout(refresh, 0));
  refresh();
}
