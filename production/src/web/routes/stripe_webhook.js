
// Stripe webhook handler with support for Payment Links custom_fields
// Events handled: checkout.session.completed (credit), charge.refunded (debit + optional ban),
// charge.dispute.created / charge.dispute.closed (optional ban)

const cfg = require('../../utils/config');
const { db } = require('../../utils/store_sqlite');

function ensureTables(){
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS webhook_events(
      id TEXT PRIMARY KEY,
      receivedAt INTEGER
    );`);
  } catch (e) { console.warn('[webhook] ensureTables failed', e?.message); }
}

function toInt(x){
  const n = parseInt(x, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function banServer(guildId, reason){
  try {
    db.prepare('UPDATE servers SET isBanned=1, banReason=?, bannedAt=? WHERE guildId=?')
      .run(reason || 'banned', Date.now(), guildId);
    return true;
  } catch (e) {
    console.warn('[ban] failed', e?.message);
    return false;
  }
}

// Pull guild/server id from metadata or Payment Links custom_fields
function extractGuildId(session){
  let gid = (session?.metadata?.guildId || '').toString();
  if (!gid && Array.isArray(session?.custom_fields)){
    try {
      const f = session.custom_fields.find(f => {
        const key = (f.key || '').toLowerCase();
        const name = (f.name || '').toLowerCase();
        const label = (f.label?.custom || '').toLowerCase();
        return key === 'guildid' || name === 'guildid' || label.includes('server id') || label.includes('guild id');
      });
      if (f){
        gid = (f.text?.value || f.value || '').toString();
      }
    } catch { }
  }
  return gid;
}

// Sum tokens from session line items using billing.tokenProductMap (and optional metadata.tokens)
async function computeTokensFromSession(stripe, session){
  let tokens = toInt(session?.metadata?.tokens);
  if (tokens) return tokens;
  const tokenMap = (cfg?.billing?.tokenProductMap) || {};
  try {
    const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    if (Array.isArray(li?.data)){
      for (const it of li.data){
        const priceId = it?.price?.id || it?.price || it?.price_id || it?.id;
        const qty = toInt(it?.quantity || 1);
        if (priceId && tokenMap[priceId]) tokens += tokenMap[priceId] * qty;
      }
    }
  } catch (e) {
    console.warn('[webhook] listLineItems failed', e?.message);
  }
  return tokens || 0;
}

module.exports = async function stripeWebhook(req, res){
  ensureTables();

  const stripeKey = cfg?.billing?.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
  if (!stripeKey){
    return res.status(501).json({ ok: false, error: 'stripe_not_configured' });
  }

  let stripe;
  try {
    stripe = require('stripe')(stripeKey);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'stripe_sdk_missing' });
  }

  const sig = req.headers['stripe-signature'];
  const signingSecret = cfg?.billing?.stripe?.signingSecret;
  if (!sig || !signingSecret) {
    return res.status(400).json({ ok: false, error: 'missing_signature' });
  }

  let event;
  try {
    // IMPORTANT: This handler assumes express.raw has been applied for this route
    // e.g., app.post('/api/tokens/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhook)
    event = stripe.webhooks.constructEvent(req.body, sig, signingSecret);
  } catch (err) {
    console.error('[webhook] signature verification failed', err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency
  try {
    const id = event?.id;
    if (id) {
      const seen = db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(id);
      if (seen) return res.json({ ok: true, duplicate: true, type: event.type });
      db.prepare('INSERT OR IGNORE INTO webhook_events(id, receivedAt) VALUES (?, ?)').run(id, Date.now());
    }
  } catch (e) {
    console.warn('[webhook] idempotency error', e?.message);
  }

  const obj = event?.data?.object || {};
  const type = event?.type || '';

  const autoBanOnRefund = (cfg?.billing?.autoBanOnRefund !== false);
  const autoBanOnDispute = (cfg?.billing?.autoBanOnDispute || 'created'); // 'created' | 'lost' | 'never'

  async function handleCheckoutCompleted() {
    const session = obj;
    const guildId = extractGuildId(session);
    if (!guildId) return { ok: false, error: 'missing_guildId' };
    const tokens = await computeTokensFromSession(stripe, session);
    if (!tokens) return { ok: false, error: 'missing_amount' };
    // Ensure server exists (insert if not)
    try { db.prepare('INSERT OR IGNORE INTO servers(guildId) VALUES (?)').run(guildId); } catch { }
    db.prepare('UPDATE servers SET tokens = COALESCE(tokens,0) + ? WHERE guildId=?').run(tokens, guildId);
    const after = db.prepare('SELECT tokens FROM servers WHERE guildId=?').get(guildId)?.tokens ?? 0;
    return { ok: true, guildId, credited: tokens, tokens: after };
  }

  async function handleChargeRefunded() {
    // Try to locate the Checkout Session to compute tokens and guildId
    let guildId = (obj?.metadata?.guildId || '').toString();
    let tokens = toInt(obj?.metadata?.tokens);
    const pi = obj?.payment_intent || obj?.id;
    try {
      if (pi){
        const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
        const session = sessions?.data?.[0];
        if (session){
          if (!guildId) guildId = extractGuildId(session);
          if (!tokens) tokens = await computeTokensFromSession(stripe, session);
        }
      }
    } catch (e) {
      console.warn('[webhook] locate session for refund failed', e?.message);
    }
    if (!guildId || !tokens) return { ok: false, error: 'missing_data' };
    const exists = db.prepare('SELECT 1 FROM servers WHERE guildId=?').get(guildId);
    if (!exists) return { ok: false, error: 'unknown_guild' };
    db.prepare('UPDATE servers SET tokens = MAX(0, COALESCE(tokens,0) - ?) WHERE guildId=?').run(tokens, guildId);
    if (autoBanOnRefund) banServer(guildId, 'refund');
    const after = db.prepare('SELECT tokens FROM servers WHERE guildId=?').get(guildId)?.tokens ?? 0;
    return { ok: true, guildId, removed: tokens, tokens: after, banned: !!autoBanOnRefund };
  }

  async function handleDisputeCreated() {
    // Ban immediately if configured
    const pi = obj?.payment_intent;
    let guildId = (obj?.metadata?.guildId || '').toString();
    try {
      if (!guildId && pi){
        const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
        const session = sessions?.data?.[0];
        if (session) guildId = extractGuildId(session);
      }
    } catch (e) {}
    if (!guildId) return { ok: false, error: 'missing_guildId' };
    if (autoBanOnDispute === 'created'){ banServer(guildId, 'chargeback'); return { ok: true, guildId, banned: true, reason:'chargeback' }; }
    return { ok: true, guildId, banned: false };
  }

  async function handleDisputeClosed() {
    // Ban if lost and configured
    const status = obj?.status; // 'won'|'lost'
    const pi = obj?.payment_intent;
    let guildId = (obj?.metadata?.guildId || '').toString();
    try {
      if (!guildId && pi){
        const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
        const session = sessions?.data?.[0];
        if (session) guildId = extractGuildId(session);
      }
    } catch (e) {}
    if (!guildId) return { ok: false, error: 'missing_guildId' };
    if (autoBanOnDispute === 'lost' && status === 'lost'){ banServer(guildId, 'chargeback_lost'); return { ok: true, guildId, banned: true, reason:'chargeback_lost' }; }
    return { ok: true, guildId, banned: false, status };
  }

  try {
    let result;
    switch (type) {
      case 'checkout.session.completed':
        result = await handleCheckoutCompleted(); break;
      case 'charge.refunded':
        result = await handleChargeRefunded(); break;
      case 'charge.dispute.created':
        result = await handleDisputeCreated(); break;
      case 'charge.dispute.closed':
        result = await handleDisputeClosed(); break;
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        result = { ok: true, no_change: true }; break;
      default:
        result = { ok: true, ignored: true, type };
    }
    return res.json(result);
  } catch (e) {
    console.error('[webhook] unhandled error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};
