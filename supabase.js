// Data layer: one supabase-js client on schema hq. Reads and writes go through RPCs only.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm";

export const URL = "https://hkllbpipcfzzppbgkzrh.supabase.co";
export const KEY = "sb_publishable_Vd1J6IVnTCP6zRR3CPz9gg_UWx1juTH";
export const sb = createClient(URL, KEY, { db: { schema: "hq" } });

/* ---------- who is signed in (Supabase Auth; the database refuses every call without a session) ---------- */
let user = null;
export const me = () => (user ? String((user.user_metadata && user.user_metadata.name) || user.email.split("@")[0]) : "");
export const email = () => (user ? user.email : "");
export async function session() { const { data } = await sb.auth.getSession(); user = data.session ? data.session.user : null; return user; }
export function onAuth(cb) { sb.auth.onAuthStateChange((event, s) => { user = s ? s.user : null; cb(event, user); }); }
const authErr = (e) => { const m = String((e && e.message) || e || ""); if (/not on the shop list|Database error saving new user/i.test(m)) return "That email isn't on the shop list."; if (/Invalid login credentials/i.test(m)) return "Wrong email or password."; if (/Email not confirmed/i.test(m)) return "Confirm your email first (check your inbox), then sign in."; return m || "Sign-in failed"; };
export async function signIn(em, password) { const { data, error } = await sb.auth.signInWithPassword({ email: em.trim().toLowerCase(), password }); if (error) throw new Error(authErr(error)); user = data.user; return user; }
export async function signUp(em, password, name) {
  const { data, error } = await sb.auth.signUp({ email: em.trim().toLowerCase(), password, options: { data: { name: name.trim() }, emailRedirectTo: location.href.split("#")[0] } });
  if (error) throw new Error(authErr(error));
  user = data.session ? data.user : null; return { user, needsConfirm: !data.session };
}
export async function resetPassword(em) { const { error } = await sb.auth.resetPasswordForEmail(em.trim().toLowerCase(), { redirectTo: location.href.split("#")[0] }); if (error) throw new Error(authErr(error)); }
export async function setPassword(password) { const { error } = await sb.auth.updateUser({ password }); if (error) throw new Error(authErr(error)); }
export async function signOut() { await sb.auth.signOut(); user = null; }

/* ---------- op ids: one per attempt, so a retry of the same payload is a no-op server-side ---------- */
export const opId = (prefix = "sp") => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

/* ---------- errors ---------- */
export class RpcError extends Error {
  constructor(fn, err) {
    const raw = String((err && (err.message || err.details)) || err || "unknown error");
    super(raw.replace(/^[A-Z0-9]+:\s*/, ""));
    this.fn = fn; this.code = err && err.code; this.raw = raw; this.hint = err && err.hint;
    this.stale = /^stale:|\bstale\b/i.test(raw) || this.code === "40001";
    this.alreadyDone = /already Done/i.test(raw);
    this.gone = /no longer exists/i.test(raw);
  }
}
export const errText = (e) => (e instanceof RpcError ? e.message : String((e && e.message) || e || "Something went wrong"));

/* when this tab last wrote: a read that started before a write and finished after it is older than what the screen shows, and is thrown away */
const READS = new Set(["read_orders", "inventory_rows", "catalog_options", "resolve_lines", "read_app_state", "pick_collection"]);
let writeAt = 0;
export const lastWriteAt = () => writeAt;
export async function rpc(fn, args = {}) {
  let res;
  if (!READS.has(fn)) writeAt = Date.now();
  try { res = await sb.rpc(fn, args); }
  catch (e) { throw new RpcError(fn, { message: "Couldn't reach Supabase: " + ((e && e.message) || e) }); }
  if (res.error) throw new RpcError(fn, res.error);
  return res.data;
}

/* ---------- reads ---------- */
export const readOrders = (status = "all", id = null) => rpc("read_orders", id ? { p_status: status, p_id: id } : { p_status: status });
export const readOrder = async (id) => { const a = await readOrders("all", id); return Array.isArray(a) && a[0] ? a[0] : null; };
export const inventoryRows = () => rpc("inventory_rows");
export const catalogOptions = () => rpc("catalog_options");
// resolve_lines: what save_order will do with each line text ({text: {status, reason?, sku?, add?}}); read-only
export const resolveLines = (texts) => rpc("resolve_lines", { p_texts: texts });
// pick_variant: the catalog item for {product_id, size_code, color_1, color_2, option_code}; make:true creates it when the colorway is offered
export const pickVariant = (p) => rpc("pick_variant", { p, p_by: me() || null });
// pick_collection: the lines a collection adds ({collection, form: accessory|enclosure, size, choices}); read-only
export const pickCollection = (p) => rpc("pick_collection", { p });
export const updateVariant = async (p) => { const r = await rpc("update_variant", { p }); return Array.isArray(r) ? r[0] : r; };
export const archiveVariant = (id) => rpc("archive_variant", { p_id: id });
// sales as the platform reported them (hq.source_orders): the ones with no order yet; confirm an imported order's review; link a sale to an order
export const unlinkedSources = () => rpc("unlinked_sources");
export const confirmReview = (id) => rpc("confirm_review", { p_order_id: id, p_by: by() });
export const linkSource = (sourceId, orderId) => rpc("link_source", { p_source_id: sourceId, p_order_id: orderId, p_by: by() });
export const dismissSource = (sourceId, why) => rpc("dismiss_source", { p_source_id: sourceId, p_why: why, p_by: by() });
export const readAppState = (keys = null, known = {}) => rpc("read_app_state", { keys, known });

/* ---------- writes (every one carries op_id and p_by) ---------- */
const by = () => me() || null;
export const saveOrder = (p) => rpc("save_order", { p: { op_id: opId("save"), ...p }, p_by: by() });
export const completeOrder = (p, moves) => rpc("complete_order", { p: { op_id: opId("done"), ...p }, p_moves: moves, p_by: by() });
export const undoOrderDone = (p) => rpc("undo_order_done", { p: { op_id: opId("undo"), ...p }, p_by: by() });
export const setLineState = (lines) => rpc("set_line_state", { p: { op_id: opId("line"), lines }, p_by: by() });
// add_variant: {product, collection?, size?, color_1?, color_2?, inventory_name?, new?: ["size","color:<name>"]}; the server makes the id and hands it back as notion_id
export async function addVariant(p) { const r = await rpc("add_variant", { p }); return Array.isArray(r) ? r[0] : r; }
export const applyMoves = (moves) => rpc("apply_moves", { p_moves: moves.map((m) => ({ op_id: opId("mv"), ...m })), p_by: by(), p_source: "hq" });
export const setAppState = (key, value, version) => rpc("set_app_state", { p: { op_id: opId("state"), key, value, version }, p_by: by() });

/* ---------- order payload: the jsonb shape save_order expects, built from a read_orders row ---------- */
const arr = (a) => (Array.isArray(a) ? a : []);
export function orderPayload(o) {
  return {
    id: o.id, version: o.version,
    customer: o.customer, repeat_customer: !!o.repeat_customer, handle: o.handle || null,
    platform: arr(o.platform), order_number: o.order_number || null, shipping_number: o.shipping_number || null,
    order_date: o.order_date || null, ship_by: o.ship_by || null, ship_type: o.ship_type || "Standard",
    status: o.status || "Not started", notes: o.notes ?? null, important: o.important || null, summary: o.summary || null,
    freebie: arr(o.freebie), items: arr(o.items), collections: arr(o.collections), order_type: arr(o.order_type), state: o.state || null,
    lines: arr(o.lines).map(linePayload),
  };
}
export function linePayload(l) {
  const out = { text: l.text, qty: Number(l.qty) || 1 };
  if (l.uid) out.uid = l.uid;
  if (l.note) out.note = l.note;
  if (l.tag) out.tag = l.tag;
  if (l.variant_id != null && l.variant_id !== "") out.variant_id = l.variant_id;
  else if (l.notion_inventory_id) out.notion_inventory_id = l.notion_inventory_id;
  if (l.match === "untracked" || l.untracked) out.untracked = true;
  if (l.group_uid) out.group_uid = l.group_uid;
  else if (l.group_index) out.group_index = l.group_index;
  return out;
}

/* Save with the stale rule: on 'stale', re-read the order and re-apply only the fields this change touches. */
export async function saveWithRetry(id, apply, { done = false, moves = null, undo = false } = {}) {
  let fresh = await readOrder(id);
  if (!fresh) throw new RpcError("save_order", { message: "This order no longer exists" });
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = apply(orderPayload(fresh), fresh);
    try {
      if (done) return await completeOrder(p, moves || []);
      if (undo) return await undoOrderDone(p);
      return await saveOrder(p);
    } catch (e) {
      if (!(e instanceof RpcError) || !e.stale || attempt === 3) throw e;
      fresh = await readOrder(id);
      if (!fresh) throw new RpcError("save_order", { message: "This order no longer exists" });
    }
  }
}
