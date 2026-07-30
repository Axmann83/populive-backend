/**
 * ============================================================
 * POPULIVE — PAGAMENTI VERI PER LE ROSE
 * ============================================================
 */

const Stripe = require('stripe');
const { canSendDirectContact, createRosaRecord } = require('./populive-interactions-logic');
const { applyPurchaseEffect } = require('./populive-interactions-logic');

function getStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://populive-frontend-production.up.railway.app';

async function initiatePurchase({ userId, productId, arenaSessionId }, { db }) {
  const product = await db.query(`
    SELECT * FROM iap_products WHERE id = $1 AND is_active = true
  `, [productId]);
  if (!product) return { success: false, reason: 'product_not_found_or_inactive' };

  const buyer = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [userId]);

  if (buyer?.is_test_account) {
    const result = await applyPurchaseEffect({
      userId, productId, arenaSessionId,
      externalTransactionId: `test_${Date.now()}`,
    }, { db });
    return { ...result, freeOrTest: true };
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: product.display_name, description: product.description || undefined },
        unit_amount: product.price_cents,
      },
      quantity: 1,
    }],
    metadata: {
      purchaseType: 'iap',
      userId, productId, arenaSessionId: arenaSessionId || '',
    },
    success_url: `${FRONTEND_BASE_URL}/?purchase_sent=1`,
    cancel_url: `${FRONTEND_BASE_URL}/?purchase_cancelled=1`,
  });

  return { success: true, requiresPayment: true, checkoutUrl: session.url };
}

async function initiateRosaPurchase({ senderId, receiverId, arenaSessionId, drinkProductId, tier }, { db, redis, io }) {

  // Stesso controllo reale di sendInteraction — nessuno dovrebbe
  // poter "comprare" una Rosa per se stesso, né tantomeno pagare
  // davvero per farlo.
  if (senderId === receiverId) {
    return { success: false, reason: 'cannot_interact_with_self' };
  }

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2
  `, [receiverId, senderId]);
  if (blocked) return { success: false, reason: 'blocked_by_receiver' };

  if (tier === 'super') {
    const check = await canSendDirectContact({ senderId, receiverId }, { db });
    if (!check.allowed) return { success: false, reason: check.reason };
  }

  const drink = await db.query(`
    SELECT dp.name, dp.base_price_cents, dp.sponsor_discount_cents
    FROM venue_drink_catalog vdc
    JOIN drink_products dp ON dp.id = vdc.drink_product_id
    WHERE dp.id = $1 AND dp.is_active = true
  `, [drinkProductId]);

  if (!drink) return { success: false, reason: 'drink_not_available' };

  const priceCents = drink.base_price_cents - (drink.sponsor_discount_cents || 0);

  const sender = await db.query(`
    SELECT is_test_account, free_roses_balance FROM users WHERE id = $1
  `, [senderId]);

  if (sender?.is_test_account) {
    const result = await createRosaRecord({
      senderId, receiverId, arenaSessionId,
      drinkName: drink.name, priceCents, tier,
      paymentStatus: 'test',
    }, { db, redis, io });
    return { ...result, freeOrTest: true };
  }

  if (sender?.free_roses_balance > 0) {
    await db.query(`UPDATE users SET free_roses_balance = free_roses_balance - 1 WHERE id = $1`, [senderId]);
    const result = await createRosaRecord({
      senderId, receiverId, arenaSessionId,
      drinkName: drink.name, priceCents, tier,
      paymentStatus: 'free',
    }, { db, redis, io });
    return { ...result, freeOrTest: true };
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: `Rosa — ${drink.name}` },
        unit_amount: priceCents,
      },
      quantity: 1,
    }],
    metadata: {
      senderId, receiverId, arenaSessionId: arenaSessionId || '',
      drinkName: drink.name, priceCents: String(priceCents), tier,
    },
    success_url: `${FRONTEND_BASE_URL}/?rosa_sent=1`,
    cancel_url: `${FRONTEND_BASE_URL}/?rosa_cancelled=1`,
  });

  return { success: true, requiresPayment: true, checkoutUrl: session.url };
}

async function handleStripeWebhook(rawBody, signature, { db, redis, io }) {
  const stripe = getStripeClient();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] firma webhook non valida:', err.message);
    return { statusCode: 400 };
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const m = session.metadata;

    if (m.purchaseType === 'iap') {
      await applyPurchaseEffect({
        userId: m.userId,
        productId: m.productId,
        arenaSessionId: m.arenaSessionId || null,
        externalTransactionId: session.id,
      }, { db });
    } else {
      await createRosaRecord({
        senderId: m.senderId,
        receiverId: m.receiverId,
        arenaSessionId: m.arenaSessionId || null,
        drinkName: m.drinkName,
        priceCents: parseInt(m.priceCents),
        tier: m.tier,
        paymentStatus: 'paid',
        stripeCheckoutSessionId: session.id,
      }, { db, redis, io });
    }
  }

  return { statusCode: 200 };
}

module.exports = { initiateRosaPurchase, initiatePurchase, handleStripeWebhook };
