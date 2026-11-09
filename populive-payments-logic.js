/**
 * ============================================================
 * POPULIVE — PAGAMENTI CON STRIPE
 * ============================================================
 * Due cose si pagano con Stripe:
 *
 *   1) LE PULSE DELLA SERATA (novembre 2026, M11 nella spec; piano in
 *      SPEC-acquisti-in-app.md, "Pulse via Stripe"). Una Pulse è una
 *      consumazione vera al bancone del locale (un bene fisico, per
 *      questo Stripe e non l'In-App Purchase di Apple e Google). Si
 *      comprano N Pulse per la serata in cui si è dentro, al prezzo
 *      di quella serata; valgono solo lì e fino alla chiusura del
 *      locale. Il flusso:
 *        a) l'app chiede N Pulse (initiateNightPulsePurchase): si
 *           crea una riga 'pending' e una sessione di Stripe Checkout;
 *        b) Stripe conferma il pagamento col webhook (mai fidarsi del
 *           telefono): finalizeNightCheckout accredita il saldo della
 *           serata una volta sola, anche se il webhook arriva due
 *           volte; se la serata nel frattempo è finita, rimborsa;
 *        c) al ritorno da Stripe l'app chiede di controllare
 *           (syncPendingNightPurchases), che legge da Stripe lo stato
 *           vero e usa la stessa finalizeNightCheckout: il saldo si
 *           aggiorna anche se il webhook tarda.
 *      Prima (fino al novembre 2026) c'erano la Pulse pagata al
 *      momento dell'invio al prezzo del drink, i pacchetti da 1 e 5
 *      per locale, i crediti validi ovunque e per sempre e le Pulse
 *      gratis settimanali: tutto tolto (N2, N4, N5).
 *
 *   2) IL CATALOGO GENERICO (iap_products: Premium, crediti Like e
 *      Superlike, badge Verificato), invariato. Sull'app andrà
 *      sull'In-App Purchase (RevenueCat, sospeso: v. la spec).
 *
 * Il prezzo non arriva MAI dal frontend: lo leggiamo sempre noi.
 * ============================================================
 */

const Stripe = require('stripe');
const { applyPurchaseEffect } = require('./populive-interactions-logic');
const { MAX_PULSES_PER_PURCHASE, creditNightPurchase, formatRomeTime } = require('./populive-pulse-nights');
const { notifyUser } = require('./populive-push');

function getStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Indirizzo del frontend a cui Stripe rimanda l'utente dopo il
// pagamento (riuscito o annullato). L'app, al ritorno, chiede al
// server di controllare l'acquisto (syncPendingNightPurchases).
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://populive-frontend-production.up.railway.app';

// Quanto resta aperta la pagina di pagamento di Stripe (il minimo che
// Stripe accetta): oltre, l'acquisto è abbandonato. Corta apposta, per
// ridurre i pagamenti che arrivano a serata finita.
const CHECKOUT_EXPIRES_MINUTES = 30;

/**
 * ============================================================
 * PULSE DELLA SERATA — a) inizio dell'acquisto
 * ============================================================
 * Solo con un check-in aperto in quella serata, in un locale partner
 * e prima della chiusura. Account di prova: accredito subito, senza
 * Stripe (come prima).
 */
async function initiateNightPulsePurchase({ userId, arenaSessionId, quantity }, { db }) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PULSES_PER_PURCHASE) {
    return { success: false, reason: 'invalid_quantity' };
  }

  const night = await db.query(
    `
    SELECT a.id, a.pulse_price_cents, a.pulse_deadline,
           a.pulse_deadline > now() AND a.closed_at IS NULL AND a.pulses_expired_at IS NULL AS is_open,
           v.name AS venue_name, v.is_partner,
           EXISTS (
             SELECT 1 FROM checkins c
             WHERE c.user_id = $1 AND c.arena_session_id = a.id AND c.checked_out_at IS NULL
           ) AS is_checked_in
    FROM arena_sessions a
    JOIN venues v ON v.id = a.venue_id
    WHERE a.id = $2
  `,
    [userId, arenaSessionId]
  );
  if (!night) return { success: false, reason: 'session_not_found' };
  if (!night.is_partner) return { success: false, reason: 'pulses_not_available_here' };
  if (!night.is_open) return { success: false, reason: 'pulse_night_ended' };
  if (!night.is_checked_in) return { success: false, reason: 'not_checked_in' };
  if (!night.pulse_price_cents || night.pulse_price_cents <= 0) {
    return { success: false, reason: 'price_not_set' };
  }

  const unitPriceCents = night.pulse_price_cents;
  const totalCents = unitPriceCents * quantity;
  const buyer = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [userId]);

  const purchase = await db.query(
    `
    INSERT INTO pulse_purchases (user_id, arena_session_id, quantity, unit_price_cents, total_cents)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `,
    [userId, arenaSessionId, quantity, unitPriceCents, totalCents]
  );

  // Account di prova: mai un addebito, il saldo sale subito.
  if (buyer?.is_test_account) {
    const credited = await creditNightPurchase({ purchaseId: purchase.id, newStatus: 'test' }, { db });
    return {
      success: true,
      freeOrTest: true,
      available: credited ? parseInt(credited.available) : null,
    };
  }

  const closingTime = formatRomeTime(night.pulse_deadline);
  const stripe = getStripeClient();
  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        // Niente payment_method_types: Stripe propone i metodi accesi
        // nella dashboard (carta, Apple Pay, Google Pay…).
        line_items: [
          {
            price_data: {
              currency: 'eur',
              product_data: {
                name: `Pulse — drink al bancone di ${night.venue_name}, validi stasera`,
                description:
                  `Un Pulse è una consumazione da ritirare al bancone di ${night.venue_name}. ` +
                  `Validi solo stasera in questo locale: scadono alla chiusura (${closingTime}) e non vengono rimborsati.`,
              },
              unit_amount: unitPriceCents,
            },
            quantity,
          },
        ],
        client_reference_id: purchase.id,
        metadata: {
          purchaseType: 'pulse_night', // distingue questo acquisto dal catalogo nel webhook
          pulsePurchaseId: purchase.id,
          userId,
          arenaSessionId,
          quantity: String(quantity),
        },
        payment_intent_data: {
          description: `${quantity} Pulse — ${night.venue_name}`,
          metadata: { pulsePurchaseId: purchase.id },
        },
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_MINUTES * 60,
        success_url: `${FRONTEND_BASE_URL}/?pulse_purchase=done`,
        cancel_url: `${FRONTEND_BASE_URL}/?pulse_purchase=cancelled`,
      },
      // Stessa riga, stessa sessione: un doppio tocco non crea due pagamenti.
      { idempotencyKey: `pulse_purchase_${purchase.id}` }
    );
  } catch (err) {
    console.error('[stripe] creazione del Checkout fallita:', err.message);
    await db.query(`UPDATE pulse_purchases SET status = 'expired' WHERE id = $1`, [purchase.id]);
    return { success: false, reason: 'payment_unavailable' };
  }

  await db.query(`UPDATE pulse_purchases SET stripe_checkout_session_id = $1 WHERE id = $2`, [session.id, purchase.id]);

  return { success: true, requiresPayment: true, checkoutUrl: session.url };
}

/**
 * ============================================================
 * PULSE DELLA SERATA — b) pagamento confermato (webhook o ritorno)
 * ============================================================
 * Riceve la sessione di Checkout così come la manda Stripe. Pagata e
 * serata ancora aperta → saldo accreditato (una volta sola). Pagata a
 * serata finita (es. pagina di Stripe lasciata aperta fino alla
 * chiusura) → rimborso automatico. Ripetibile senza effetti doppi.
 */
async function finalizeNightCheckout(checkoutSession, { db, io }) {
  const purchaseId = checkoutSession.metadata?.pulsePurchaseId || checkoutSession.client_reference_id;
  if (!purchaseId) return { outcome: 'not_a_pulse_purchase' };
  if (checkoutSession.payment_status !== 'paid') return { outcome: 'not_paid_yet' };

  const paymentIntentId =
    typeof checkoutSession.payment_intent === 'string'
      ? checkoutSession.payment_intent
      : checkoutSession.payment_intent?.id || null;

  const credited = await creditNightPurchase({ purchaseId, newStatus: 'paid', paymentIntentId }, { db });
  if (credited) {
    const available = parseInt(credited.available);
    io?.to(`user_${credited.user_id}`).emit('pulse_balance_updated', {
      arenaSessionId: credited.arena_session_id,
      available,
    });
    return { outcome: 'credited', available };
  }

  const purchase = await db.query(
    `
    SELECT pp.id, pp.status, pp.user_id, pp.arena_session_id, v.name AS venue_name
    FROM pulse_purchases pp
    JOIN arena_sessions a ON a.id = pp.arena_session_id
    JOIN venues v ON v.id = a.venue_id
    WHERE pp.id = $1
  `,
    [purchaseId]
  );
  if (!purchase) {
    console.warn(`[stripe] pagamento per un acquisto di Pulse sconosciuto: ${purchaseId}`);
    return { outcome: 'unknown_purchase' };
  }
  if (purchase.status === 'paid' || purchase.status === 'refunded' || purchase.status === 'test') {
    return { outcome: 'already_handled' };
  }

  // Pagato, ma la serata è finita: niente Pulse, soldi indietro. La
  // chiave di idempotenza fa sì che due webhook insieme non facciano
  // due rimborsi; lo stato si scrive solo a rimborso riuscito, così se
  // Stripe non risponde il webhook fallisce e Stripe lo ritenta.
  if (!paymentIntentId) throw new Error(`pagamento senza payment_intent per l'acquisto ${purchaseId}`);
  const stripe = getStripeClient();
  await stripe.refunds.create(
    { payment_intent: paymentIntentId, metadata: { pulsePurchaseId: purchaseId, reason: 'pulse_night_ended' } },
    { idempotencyKey: `pulse_purchase_refund_${purchaseId}` }
  );
  await db.query(
    `
    UPDATE pulse_purchases
    SET status = 'refunded', refunded_at = now(), stripe_payment_intent_id = $2
    WHERE id = $1 AND status IN ('pending', 'expired')
  `,
    [purchaseId, paymentIntentId]
  );
  console.info(`[stripe] acquisto di Pulse ${purchaseId} pagato a serata finita: rimborsato`);

  io?.to(`user_${purchase.user_id}`).emit('pulse_purchase_refunded', {
    arenaSessionId: purchase.arena_session_id,
    venueName: purchase.venue_name,
  });
  notifyUser(
    { userId: purchase.user_id, event: 'pulse_purchase_refunded', extra: { venueName: purchase.venue_name } },
    { db }
  );
  return { outcome: 'refunded' };
}

/**
 * ============================================================
 * PULSE DELLA SERATA — c) ritorno da Stripe
 * ============================================================
 * L'app torna da Stripe (o l'utente chiude la pagina di pagamento):
 * per ogni acquisto ancora 'pending' delle ultime ore leggiamo da
 * Stripe lo stato vero. Pagato → stessa strada del webhook; pagina
 * scaduta → acquisto abbandonato. Il saldo nell'app si aggiorna anche
 * se il webhook non è ancora arrivato (o in locale, senza webhook).
 */
async function syncPendingNightPurchases({ userId, since }, { db, io }) {
  const pending = await db.queryAll(
    `
    SELECT id, stripe_checkout_session_id, arena_session_id
    FROM pulse_purchases
    WHERE user_id = $1 AND status = 'pending' AND stripe_checkout_session_id IS NOT NULL
      AND created_at > now() - interval '6 hours'
    ORDER BY created_at
  `,
    [userId]
  );

  const results = [];
  if (pending.length > 0) {
    const stripe = getStripeClient();
    for (const p of pending) {
      try {
        const session = await stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id);
        if (session.payment_status === 'paid') {
          results.push((await finalizeNightCheckout(session, { db, io })).outcome);
        } else if (session.status === 'expired') {
          await markCheckoutExpired(session.id, { db });
          results.push('expired');
        } else {
          results.push('open');
        }
      } catch (err) {
        console.error(`[stripe] controllo dell'acquisto ${p.id} fallito:`, err.message);
        results.push('error');
      }
    }
  }

  // Esito degli acquisti avviati da quando l'app ha aperto la pagina
  // di Stripe (since): il webhook di solito arriva prima del ritorno
  // nell'app, e l'evento socket (accredito o rimborso a serata finita)
  // parte mentre si è ancora sulla pagina di pagamento. Solo quelli
  // nati da allora, non un rimborso di un acquisto precedente.
  const sinceDate = parseSince(since);
  if (sinceDate) {
    const outcomes = await db.queryAll(
      `
      SELECT DISTINCT status FROM pulse_purchases
      WHERE user_id = $1 AND created_at >= $2 AND status IN ('paid', 'refunded')
    `,
      [userId, sinceDate]
    );
    for (const o of outcomes) {
      const outcome = o.status === 'paid' ? 'credited' : 'refunded';
      if (!results.includes(outcome)) results.push(outcome);
    }
  }

  return { success: true, checked: pending.length, results };
}

// Ora di inizio del pagamento mandata dall'app (millisecondi): solo
// nelle ultime 6 ore, con un minuto di margine per l'orologio del
// telefono.
function parseSince(since) {
  if (since === null || since === undefined || since === '') return null;
  const ms = Number(since);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const clamped = Math.max(ms - 60 * 1000, Date.now() - 6 * 60 * 60 * 1000);
  return new Date(Math.min(clamped, Date.now()));
}

async function markCheckoutExpired(checkoutSessionId, { db }) {
  await db.query(
    `UPDATE pulse_purchases SET status = 'expired' WHERE stripe_checkout_session_id = $1 AND status = 'pending'`,
    [checkoutSessionId]
  );
}

/**
 * ============================================================
 * CATALOGO GENERICO (iap_products) — invariato
 * ============================================================
 */
async function initiatePurchase({ userId, productId, arenaSessionId }, { db }) {
  const product = await db.query(
    `
    SELECT * FROM iap_products WHERE id = $1 AND is_active = true
  `,
    [productId]
  );
  if (!product) return { success: false, reason: 'product_not_found_or_inactive' };

  const buyer = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [userId]);

  // Account di prova: applica l'effetto subito, senza toccare Stripe.
  if (buyer?.is_test_account) {
    const result = await applyPurchaseEffect(
      {
        userId,
        productId,
        arenaSessionId,
        externalTransactionId: `test_${Date.now()}`,
      },
      { db }
    );
    return { ...result, freeOrTest: true };
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'eur',
          product_data: { name: product.display_name, description: product.description || undefined },
          unit_amount: product.price_cents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      purchaseType: 'iap', // distingue questo tipo di acquisto dalle Pulse nel webhook
      userId,
      productId,
      arenaSessionId: arenaSessionId || '',
    },
    success_url: `${FRONTEND_BASE_URL}/?purchase_sent=1`,
    cancel_url: `${FRONTEND_BASE_URL}/?purchase_cancelled=1`,
  });

  return { success: true, requiresPayment: true, checkoutUrl: session.url };
}

/**
 * ============================================================
 * WEBHOOK DI STRIPE — chiamato da Stripe, MAI dal frontend
 * ============================================================
 * È l'unica fonte affidabile su "il pagamento è andato a buon fine".
 * Ogni ramo è ripetibile: Stripe può mandare lo stesso evento più
 * volte, e lo rimanda se rispondiamo con un errore.
 */
async function handleStripeWebhook(rawBody, signature, { db, redis, io }) {
  const stripe = getStripeClient();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] firma webhook non valida:', err.message);
    return { statusCode: 400 };
  }

  const session = event.data.object;
  const m = session?.metadata || {};

  switch (event.type) {
    // Pagamento concluso. Con i metodi "differiti" (es. bonifico SEPA)
    // completed arriva ancora da pagare e il pagamento vero arriva
    // dopo con async_payment_succeeded: finalizeNightCheckout accredita
    // solo quando payment_status è 'paid'.
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (m.purchaseType === 'pulse_night') {
        await finalizeNightCheckout(session, { db, redis, io });
      } else if (m.purchaseType === 'iap' && event.type === 'checkout.session.completed') {
        // Catalogo generico (Premium, crediti, Verificato). Doppioni
        // evitati con l'id della sessione di Stripe.
        const already = await db.query(`SELECT 1 FROM user_purchases WHERE external_transaction_id = $1`, [session.id]);
        if (!already) {
          await applyPurchaseEffect(
            {
              userId: m.userId,
              productId: m.productId,
              arenaSessionId: m.arenaSessionId || null,
              externalTransactionId: session.id,
            },
            { db }
          );
        }
      }
      break;

    // Pagina di pagamento scaduta o pagamento differito fallito:
    // l'acquisto è abbandonato, nessun saldo.
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      if (m.purchaseType === 'pulse_night') await markCheckoutExpired(session.id, { db });
      break;

    default:
      break;
  }

  return { statusCode: 200 };
}

module.exports = {
  initiateNightPulsePurchase,
  syncPendingNightPurchases,
  finalizeNightCheckout,
  initiatePurchase,
  handleStripeWebhook,
};
