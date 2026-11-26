// Razorpay auto-pay for KanpurGym gym subscriptions.
// Secrets (Supabase → Edge Functions → Secrets): RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
// RAZORPAY_WEBHOOK_SECRET, RAZORPAY_PLAN_MONTHLY, RAZORPAY_PLAN_YEARLY.
// The website calls it with the owner's login; Razorpay calls it (?webhook) with a signed message.
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
// Settings come from the super admin panel (Settings → Razorpay); the Supabase secrets are a fallback.
let KEY_ID = "", KEY_SECRET = "", HOOK_SECRET = "", HOOK_SECRET_OTHER = "";
let PLANS: Record<string, string> = {};
let PRICES: Record<string, number> = { monthly: 800, yearly: 4999 };
async function loadConfig() {
  let c: Record<string, string> = {};
  try { c = (await svc("config", {})) ?? {}; } catch (_) { /* fall back to secrets */ }
  KEY_ID = c.key_id || env("RAZORPAY_KEY_ID");
  KEY_SECRET = c.key_secret || env("RAZORPAY_KEY_SECRET");
  HOOK_SECRET = c.webhook_secret || env("RAZORPAY_WEBHOOK_SECRET");
  HOOK_SECRET_OTHER = c.webhook_secret_other || "";
  if (c.price_month) PRICES = { monthly: Number(c.price_month), yearly: Number(c.price_year) };
  PLANS = { monthly: c.plan_monthly || env("RAZORPAY_PLAN_MONTHLY"), yearly: c.plan_yearly || env("RAZORPAY_PLAN_YEARLY") };
  // a key ID entered in the panel only works with its own secret
  if (c.key_id && !c.key_secret && c.key_id !== env("RAZORPAY_KEY_ID")) KEY_SECRET = "";
}
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)?kanpurgym\.com$|^http:\/\/([a-z0-9-]+\.)?kg\.localhost(:\d+)?$/;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return ORIGIN_OK.test(o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" }
    : {};
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function rzp(path: string, method = "GET", body?: unknown) {
  const r = await fetch("https://api.razorpay.com/v1" + path, {
    method,
    headers: { Authorization: "Basic " + btoa(KEY_ID + ":" + KEY_SECRET), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("razorpay: " + (data?.error?.description ?? r.status));
  return data;
}
async function svc(action: string, input: Record<string, unknown>) {
  const { data, error } = await db.rpc("rzp_service", { p_action: action, p_in: input });
  if (error) throw new Error("db: " + error.message);
  return data;
}

// ---------------------------------------------------------------- Razorpay → us (signed webhook)
async function webhook(req: Request): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get("x-razorpay-signature") ?? "";
  // test and live webhooks have their own secrets; accept either
  let signed = false;
  for (const sec of [HOOK_SECRET, HOOK_SECRET_OTHER]) if (sec && sameText(await hmacHex(sec, raw), sig)) signed = true;
  if (!signed) return new Response("bad signature", { status: 401 });
  const ev = JSON.parse(raw);
  const sub = ev?.payload?.subscription?.entity;
  const pay = ev?.payload?.payment?.entity;
  const order = ev?.payload?.order?.entity;
  if (ev.event === "order.paid" && order?.notes?.kind === "one_time" && pay?.id) {
    const r = await svc("paid_once", { gym_id: Number(order.notes.gym_id), payment_id: pay.id, amount: Math.round(order.amount_paid / 100), plan: order.notes.plan });
    console.log("one-time", order.id, pay.id, JSON.stringify(r));
    return new Response("ok", { status: 200 });
  }
  if (!sub?.id) return new Response("ignored", { status: 200 });
  if (ev.event === "subscription.charged" && pay?.id && pay.status === "captured") {
    const r = await svc("charged", { sub_id: sub.id, payment_id: pay.id, amount: Math.round(pay.amount / 100), period_end: sub.current_end });
    console.log("charged", sub.id, pay.id, JSON.stringify(r));
  } else {
    await svc("status", { sub_id: sub.id, status: String(sub.status ?? ev.event.split(".")[1]) });
  }
  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------- website → us (gym owner logged in)
async function app(req: Request): Promise<Response> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json(req, { ok: false, error: "login_required" });
  const body = await req.json().catch(() => ({}));
  const slug = String(body.gym ?? "");
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug)) return json(req, { ok: false, error: "gym_not_found" });
  const g = await svc("gym_for", { slug, uid: u.user.id });
  if (!g) return json(req, { ok: false, error: "gym_not_found" });
  if (!g.is_owner && !g.is_admin) return json(req, { ok: false, error: "forbidden" });
  if (!KEY_ID || !KEY_SECRET) return json(req, { ok: false, error: "autopay_not_ready" });

  if (body.action === "start") {
    if (!(await svc("autopay_on", {}))) return json(req, { ok: false, error: "autopay_not_ready" });
    const plan = body.plan === "yearly" ? "yearly" : "monthly";
    if (!PLANS[plan]) return json(req, { ok: false, error: "autopay_not_ready" });
    if (g.rzp_sub_id && ["active", "authenticated", "pending"].includes(g.rzp_status)) return json(req, { ok: false, error: "autopay_already_on" });
    // reuse a set-up that was opened but not finished, if it is for the same plan
    if (g.rzp_sub_id && g.rzp_status === "created" && g.rzp_plan === plan) return json(req, { ok: true, key: KEY_ID, subscription_id: g.rzp_sub_id });
    // the first charge happens when the free trial / current paid period ends
    const ends = [g.trial_ends, g.paid_until].filter(Boolean).sort().pop() as string;
    const startAt = Math.floor(new Date(ends + "T06:00:00+05:30").getTime() / 1000);
    const nowS = Math.floor(Date.now() / 1000);
    const sub = await rzp("/subscriptions", "POST", {
      plan_id: PLANS[plan], total_count: plan === "yearly" ? 10 : 120, quantity: 1, customer_notify: 1,
      ...(startAt > nowS + 3600 ? { start_at: startAt } : {}),
      notes: { gym: slug, gym_id: String(g.id) },
    });
    await svc("set_sub", { gym_id: g.id, sub_id: sub.id, plan, status: sub.status });
    return json(req, { ok: true, key: KEY_ID, subscription_id: sub.id, first_charge: startAt > nowS + 3600 ? ends : null });
  }

  if (body.action === "order") {
    // one-time payment for one month or one year (no auto-pay)
    if (!(await svc("autopay_on", {}))) return json(req, { ok: false, error: "autopay_not_ready" });
    const plan = body.plan === "yearly" ? "yearly" : "monthly";
    const order = await rzp("/orders", "POST", {
      amount: Math.round(PRICES[plan] * 100), currency: "INR", receipt: `g${g.id}-${Date.now()}`.slice(0, 40),
      notes: { kind: "one_time", gym: slug, gym_id: String(g.id), plan },
    });
    return json(req, { ok: true, key: KEY_ID, order_id: order.id, amount: order.amount });
  }

  if (body.action === "order_verify") {
    const okSig = sameText(await hmacHex(KEY_SECRET, `${body.order_id}|${body.payment_id}`), String(body.signature ?? ""));
    if (!okSig) return json(req, { ok: false, error: "verify_failed" });
    const order = await rzp("/orders/" + encodeURIComponent(String(body.order_id)));
    if (order?.notes?.gym_id !== String(g.id) || order?.notes?.kind !== "one_time") return json(req, { ok: false, error: "verify_failed" });
    const pay = await rzp("/payments/" + encodeURIComponent(String(body.payment_id)));
    if (pay.status !== "captured" || pay.order_id !== order.id) return json(req, { ok: false, error: "payment_pending" });
    const r = await svc("paid_once", { gym_id: g.id, payment_id: pay.id, amount: Math.round(pay.amount / 100), plan: order.notes.plan });
    return json(req, { ok: true, paid_until: r?.paid_until });
  }

  if (body.action === "verify") {
    // Razorpay Checkout returns a signed receipt after the owner approves auto-pay
    const ok = g.rzp_sub_id && sameText(await hmacHex(KEY_SECRET, `${body.payment_id}|${g.rzp_sub_id}`), String(body.signature ?? ""));
    if (!ok) return json(req, { ok: false, error: "verify_failed" });
    const sub = await rzp("/subscriptions/" + g.rzp_sub_id);
    await svc("status", { sub_id: g.rzp_sub_id, status: sub.status });
    return json(req, { ok: true, status: sub.status });
  }

  if (body.action === "sync" && g.rzp_sub_id) {
    const sub = await rzp("/subscriptions/" + g.rzp_sub_id);
    await svc("status", { sub_id: g.rzp_sub_id, status: sub.status });
    return json(req, { ok: true, status: sub.status });
  }

  if (body.action === "cancel" && g.rzp_sub_id) {
    let status = "cancelled";
    try { status = (await rzp(`/subscriptions/${g.rzp_sub_id}/cancel`, "POST", { cancel_at_cycle_end: 0 })).status; }
    catch (e) { if (!/cancel/i.test(String(e))) throw e; }
    await svc("status", { sub_id: g.rzp_sub_id, status });
    return json(req, { ok: true, status });
  }
  return json(req, { ok: false, error: "bad_action" });
}

// ---------------------------------------------------------------- payment page on kanpurgym.com → us (no login needed: Razorpay's signature proves the payment)
async function payVerify(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const pid = String(body.payment_id ?? ""), sig = String(body.signature ?? "");
  if (!/^pay_[A-Za-z0-9]+$/.test(pid) || !KEY_SECRET) return json(req, { ok: false, error: "verify_failed" });
  if (body.order_id) {
    const oid = String(body.order_id);
    if (!sameText(await hmacHex(KEY_SECRET, `${oid}|${pid}`), sig)) return json(req, { ok: false, error: "verify_failed" });
    const order = await rzp("/orders/" + encodeURIComponent(oid));
    if (order?.notes?.kind !== "one_time") return json(req, { ok: false, error: "verify_failed" });
    const pay = await rzp("/payments/" + encodeURIComponent(pid));
    if (pay.status !== "captured" || pay.order_id !== order.id) return json(req, { ok: false, error: "payment_pending" });
    const r = await svc("paid_once", { gym_id: Number(order.notes.gym_id), payment_id: pay.id, amount: Math.round(pay.amount / 100), plan: order.notes.plan });
    return json(req, { ok: true, kind: "once", paid_until: r?.paid_until });
  }
  if (body.subscription_id) {
    const sid = String(body.subscription_id);
    if (!sameText(await hmacHex(KEY_SECRET, `${pid}|${sid}`), sig)) return json(req, { ok: false, error: "verify_failed" });
    const sub = await rzp("/subscriptions/" + encodeURIComponent(sid));
    await svc("status", { sub_id: sid, status: sub.status });
    return json(req, { ok: true, kind: "autopay", status: sub.status });
  }
  return json(req, { ok: false, error: "verify_failed" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return new Response("Not found", { status: 404 });
  const isHook = new URL(req.url).searchParams.has("webhook");
  try {
    await loadConfig();
    if (isHook) return await webhook(req);
    if (new URL(req.url).searchParams.has("pay")) return await payVerify(req);
    return await app(req);
  } catch (e) {
    console.error(String(e));
    if (isHook) return new Response("error", { status: 500 }); // Razorpay will retry
    return json(req, { ok: false, error: /razorpay/.test(String(e)) ? "razorpay_error" : "server_error" }, 200);
  }
});
