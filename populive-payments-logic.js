/**
 * ============================================================
 * POPULIVE — PAGAMENTI VERI PER I PULSE
 * ============================================================
 * Fino ad ora, inviare una Pulse non addebitava soldi a nessuno —
 * il prezzo veniva solo scritto nel database, senza nessun
 * pagamento reale dietro. Questo file chiude quel buco.
 *
 * Il flusso, in ordine:
 *   1) L'utente sceglie drink + variante e tocca "Invia Pulse"
 *   2) Controlliamo PRIMA di tutto se non deve nemmeno pagare
 *      (account di prova, o ha una Pulse gratis settimanale
 *      disponibile) — in quel caso la Pulse nasce SUBITO, come
 *      prima, senza toccare Stripe
 *   3) Altrimenti, creiamo una vera sessione di pagamento Stripe
 *      e mandiamo l'utente a pagare con la sua carta
 *   4) SOLO quando Stripe conferma il pagamento (tramite webhook,
 *      mai fidandosi di quello che dice il telefono del cliente),
 *      la Pulse nasce davvero nel database
 *
 * Il prezzo non arriva MAI dal frontend — lo recuperiamo sempre
 * noi dal catalogo drink del locale, altrimenti chiunque potrebbe
 * mandare un prezzo finto (es. 1 centesimo) per una Pulse vera.
 * ============================================================
 */

const Stripe = require('stripe');
const { canSendDirectContact, createPulseRecord } = require('./populive-interactions-logic');
const { applyPurchaseEffect } = require('./populive-interactions-logic');

function getStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Indirizzo del frontend a cui Stripe rimanda l'utente dopo il
// pagamento (riuscito o annullato) — torna semplicemente all'app,
// che nel frattempo avrà già ricevuto la notifica reale via
// WebSocket una volta che il webhook avrà creato la Pulse.
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://populive-frontend-production.up.railway.app';

/**
 * ============================================================
 * ACQUISTO GENERICO — copre TUTTO il catalogo (iap_products):
 * Premium, crediti Like/Superlike extra, badge Verificato, e
 * qualunque cosa vorrete aggiungere in futuro. Stesso identico
 * motore della Pulse qui sotto (account di prova → Stripe →
 * conferma via webhook), solo generalizzato: non deve sapere nulla
 * di COSA sta vendendo, lo legge dal catalogo.
 * ============================================================
 */

/**
 * ============================================================
 * ACQUISTO CREDITI PULSE — prezzo PER LOCALE, non più globale
 * ============================================================
 * A differenza degli altri prodotti (Premium, Verificato, crediti
 * Like/Superlike, sempre uguali per tutta la piattaforma), il
 * prezzo di un credito Pulse dipende dall'accordo con QUEL locale
 * specifico — vuoto finché gli Architetti non lo impostano dalla
 * dashboard. Se è vuoto, l'acquisto semplicemente non è disponibile
 * per quel locale, mai un prezzo finto o un valore di ripiego.
 */
async function initiateVenuePulseCreditsPurchase({ userId, venueId, quantity }, { db }) {
  if (quantity !== 1 && quantity !== 5) {
    return { success: false, reason: 'invalid_quantity' };
  }

  const venue = await db.query(`
    SELECT name, pulse_price_cents, pulse_bundle_5_price_cents FROM venues WHERE id = $1
  `, [venueId]);
  if (!venue) return { success: false, reason: 'venue_not_found' };

  const priceCents = quantity === 1 ? venue.pulse_price_cents : venue.pulse_bundle_5_price_cents;
  if (!priceCents) {
    return { success: false, reason: 'price_not_set_for_this_venue' };
  }

  const buyer = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [userId]);

  // Account di prova: applica l'effetto subito, senza toccare Stripe.
  if (buyer?.is_test_account) {
    await db.query(`UPDATE users SET paid_pulse_credits = paid_pulse_credits + $1 WHERE id = $2`, [quantity, userId]);
    return { success: true, freeOrTest: true };
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: `${quantity} Pulse pre-pagati — ${venue.name}` },
        unit_amount: priceCents,
      },
      quantity: 1,
    }],
    metadata: {
      purchaseType: 'venue_pulse_credits', // distingue questo tipo di acquisto dagli altri due nel webhook
      userId, venueId, quantity: String(quantity),
    },
    success_url: `${FRONTEND_BASE_URL}/?purchase_sent=1`,
    cancel_url: `${FRONTEND_BASE_URL}/?purchase_cancelled=1`,
  });

  return { success: true, requiresPayment: true, checkoutUrl: session.url };
}

async function initiatePurchase({ userId, productId, arenaSessionId }, { db }) {
  const product = await db.query(`
    SELECT * FROM iap_products WHERE id = $1 AND is_active = true
  `, [productId]);
  if (!product) return { success: false, reason: 'product_not_found_or_inactive' };

  const buyer = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [userId]);

  // Account di prova: applica l'effetto subito, senza toccare Stripe.
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
      purchaseType: 'iap', // distingue questo tipo di acquisto dalla Pulse nel webhook
      userId, productId, arenaSessionId: arenaSessionId || '',
    },
    success_url: `${FRONTEND_BASE_URL}/?purchase_sent=1`,
    cancel_url: `${FRONTEND_BASE_URL}/?purchase_cancelled=1`,
  });

  return { success: true, requiresPayment: true, checkoutUrl: session.url };
}

/**
 * STEP 1 — Punto d'ingresso unico per "voglio inviare questa Pulse".
 * Decide da solo se serve pagare o no, e agisce di conseguenza.
 */
async function initiatePulsePurchase({ senderId, receiverId, arenaSessionId, drinkProductId, tier }, { db, redis, io }) {

  // Stesso controllo reale di sendInteraction — nessuno dovrebbe
  // poter "comprare" una Pulse per se stesso, né tantomeno pagare
  // davvero per farlo.
  if (senderId === receiverId) {
    return { success: false, reason: 'cannot_interact_with_self' };
  }

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 AND (arena_session_id IS NULL OR arena_session_id = $3)
  `, [receiverId, senderId, arenaSessionId]);
  // Un account di prova non deve mai restare bloccato da un
  // rifiuto/ignora precedente — altrimenti due account di prova
  // che si testano a vicenda si bloccherebbero da soli, impedendo
  // di continuare a testare (stesso principio già applicato a
  // Like/Superlike in sendInteraction).
  const purchaserTestRow = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [senderId]);
  if (blocked && !purchaserTestRow?.is_test_account) return { success: false, reason: 'blocked_by_receiver' };

  if (tier === 'super') {
    const check = await canSendDirectContact({ senderId, receiverId }, { db });
    if (!check.allowed) return { success: false, reason: check.reason };

    // Un Pulse+Superlike richiede ANCHE un Superlike vero da spendere
    // — controllo qui SUBITO (senza ancora scalarlo: lo faremo solo
    // quando la Pulse nascerà per davvero, dentro createPulseRecord,
    // per non perdere un Superlike se poi il pagamento del Pulse
    // fallisce o viene abbandonato su Stripe).
    const senderSuperlikes = await db.query(`SELECT superlike_balance FROM users WHERE id = $1`, [senderId]);
    if (!senderSuperlikes || senderSuperlikes.superlike_balance <= 0) {
      return { success: false, reason: 'superlike_balance_exhausted' };
    }
  }

  // Il prezzo e il nome del drink vengono SEMPRE recuperati qui,
  // mai passati dal frontend — è l'unico modo per essere sicuri
  // che nessuno possa "inviare" una Pulse a un prezzo inventato.
  const drink = await db.query(`
    SELECT dp.name, dp.base_price_cents, dp.sponsor_discount_cents
    FROM venue_drink_catalog vdc
    JOIN drink_products dp ON dp.id = vdc.drink_product_id
    WHERE dp.id = $1 AND dp.is_active = true
  `, [drinkProductId]);

  if (!drink) return { success: false, reason: 'drink_not_available' };

  const priceCents = drink.base_price_cents - (drink.sponsor_discount_cents || 0);

  const sender = await db.query(`
    SELECT is_test_account, free_pulses_balance, paid_pulse_credits FROM users WHERE id = $1
  `, [senderId]);

  // CASO 1 — Account di prova: mai un addebito, punto. Pensato
  // per i founder che continuano a testare l'app dopo il lancio.
  if (sender?.is_test_account) {
    const result = await createPulseRecord({
      senderId, receiverId, arenaSessionId,
      drinkName: drink.name, priceCents, tier,
      paymentStatus: 'test',
    }, { db, redis, io });
    return { ...result, freeOrTest: true };
  }

  // CASO 2 — Pulse gratis settimanale disponibile: la consumiamo
  // invece di far pagare, la Pulse nasce comunque subito.
  if (sender?.free_pulses_balance > 0) {
    await db.query(`UPDATE users SET free_pulses_balance = free_pulses_balance - 1 WHERE id = $1`, [senderId]);
    const result = await createPulseRecord({
      senderId, receiverId, arenaSessionId,
      drinkName: drink.name, priceCents, tier,
      paymentStatus: 'free',
    }, { db, redis, io });
    return { ...result, freeOrTest: true };
  }

  // CASO 2b — Crediti Pulse pre-pagati disponibili (comprati in
  // pacchetto, mai a scadenza): li consumiamo prima di chiedere un
  // nuovo pagamento — il denaro è già stato incassato in anticipo.
  if (sender?.paid_pulse_credits > 0) {
    await db.query(`UPDATE users SET paid_pulse_credits = paid_pulse_credits - 1 WHERE id = $1`, [senderId]);
    const result = await createPulseRecord({
      senderId, receiverId, arenaSessionId,
      drinkName: drink.name, priceCents, tier,
      paymentStatus: 'prepaid',
    }, { db, redis, io });
    return { ...result, freeOrTest: true };
  }

  // CASO 3 — Serve pagare per davvero. Creiamo la sessione Stripe,
  // ma la Pulse NON esiste ancora: nascerà solo quando il webhook
  // confermerà il pagamento riuscito (v. handleStripeWebhook sotto).
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: `Pulse — ${drink.name}` },
        unit_amount: priceCents,
      },
      quantity: 1,
    }],
    metadata: {
      senderId, receiverId, arenaSessionId: arenaSessionId || '',
      drinkName: drink.name, priceCents: String(priceCents), tier,
    },
    success_url: `${FRONTEND_BASE_URL}/?pulse_sent=1`,
    cancel_url: `${FRONTEND_BASE_URL}/?pulse_cancelled=1`,
  });

  return { success: true, requiresPayment: true, checkoutUrl: session.url };
}

/**
 * STEP 2 — Chiamata da Stripe stesso quando un pagamento va a buon
 * fine (o fallisce) — MAI dal frontend. È l'unica fonte affidabile
 * di verità su "il pagamento è andato davvero a buon fine".
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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const m = session.metadata;

    if (m.purchaseType === 'iap') {
      // Acquisto dal catalogo generico (Premium, crediti extra,
      // badge Verificato, ecc.) — applyPurchaseEffect sa già da
      // solo cosa fare in base al tipo di prodotto.
      await applyPurchaseEffect({
        userId: m.userId,
        productId: m.productId,
        arenaSessionId: m.arenaSessionId || null,
        externalTransactionId: session.id,
      }, { db });
    } else if (m.purchaseType === 'venue_pulse_credits') {
      // Acquisto di crediti Pulse a prezzo specifico del locale —
      // la stessa identica riga di sempre, solo che il prezzo pagato
      // (già verificato server-side al momento della creazione della
      // sessione Stripe, mai qui) veniva dal locale, non dal catalogo.
      await db.query(`
        UPDATE users SET paid_pulse_credits = paid_pulse_credits + $1 WHERE id = $2
      `, [parseInt(m.quantity), m.userId]);
    } else {
      // Acquisto di una Pulse (comportamento di sempre).
      await createPulseRecord({
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

module.exports = { initiatePulsePurchase, initiatePurchase, initiateVenuePulseCreditsPurchase, handleStripeWebhook };
