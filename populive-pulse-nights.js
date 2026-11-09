/**
 * ============================================================
 * POPULIVE — PULSE DELLA SERATA (saldo, prezzo, fine serata)
 * ============================================================
 * Novembre 2026 (M11, piano in SPEC-acquisti-in-app.md, "Pulse via
 * Stripe"). Una Pulse è una consumazione vera al bancone del locale:
 * si compra con Stripe per UNA serata di UN locale, al prezzo di
 * quella serata (arena_sessions.pulse_price_cents), e vale fino
 * all'orario di chiusura (arena_sessions.pulse_deadline, N6).
 *
 * Qui solo i mattoni del saldo, senza Stripe e senza la logica delle
 * Pulse (quella resta in populive-interactions-logic.js, che usa
 * questo file: niente dipendenze circolari):
 *   - pulse_night_balances: comprate + restituite - usate - scadute;
 *   - ogni modifica è UNA query atomica, così due invii nello stesso
 *     istante non possono spendere la stessa Pulse due volte (il
 *     CHECK della tabella fa da ultima rete).
 * ============================================================
 */

const { notifyUser } = require('./populive-push');

// Quante Pulse si possono comprare in un solo pagamento.
const MAX_PULSES_PER_PURCHASE = 10;

// Disponibili per una riga di pulse_night_balances, scritto per esteso
// in ogni query (db:validate legge le query così come sono):
// purchased + returned - used - expired.

/**
 * Prezzo, fine serata e saldo di una persona per una serata. Usata
 * dall'app (schermata "Compra Pulse", saldo nel radar e nell'invio).
 */
async function getPulseNightInfo({ userId, arenaSessionId }, { db }) {
  const night = await db.query(
    `
    SELECT a.id, a.pulse_price_cents, a.pulse_deadline, a.closed_at, a.pulses_expired_at,
           a.pulse_deadline > now() AND a.closed_at IS NULL AND a.pulses_expired_at IS NULL AS is_open,
           v.id AS venue_id, v.name AS venue_name, v.is_partner,
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

  const balance = await getNightBalance({ userId, arenaSessionId }, { db });

  return {
    success: true,
    arenaSessionId: night.id,
    venueId: night.venue_id,
    venueName: night.venue_name,
    priceCents: night.pulse_price_cents,
    deadline: night.pulse_deadline,
    isOpen: night.is_open,
    // Solo i locali con un accordo firmato danno davvero la
    // consumazione al bancone: negli altri le Pulse non si vendono.
    isAvailable: night.is_partner === true,
    canBuy: night.is_partner === true && night.is_open && night.is_checked_in,
    maxPerPurchase: MAX_PULSES_PER_PURCHASE,
    available: balance.available,
    // Drink ricevuti, accettati e non ancora ritirati stasera: servono
    // all'avviso di fine serata e al testo per chi riceve.
    toCollect: await countPulsesToCollect({ userId, arenaSessionId }, { db }),
  };
}

async function getNightBalance({ userId, arenaSessionId }, { db }) {
  const row = await db.query(
    `
    SELECT purchased, used, returned, expired, purchased + returned - used - expired AS available
    FROM pulse_night_balances
    WHERE user_id = $1 AND arena_session_id = $2
  `,
    [userId, arenaSessionId]
  );
  return {
    purchased: row?.purchased || 0,
    used: row?.used || 0,
    returned: row?.returned || 0,
    expired: row?.expired || 0,
    available: row ? parseInt(row.available) : 0,
  };
}

async function countPulsesToCollect({ userId, arenaSessionId }, { db }) {
  const row = await db.query(
    `
    SELECT COUNT(*) AS n FROM pulses
    WHERE receiver_id = $1 AND arena_session_id = $2 AND status = 'accepted'
  `,
    [userId, arenaSessionId]
  );
  return parseInt(row?.n) || 0;
}

/**
 * Scala UNA Pulse dal saldo della serata, solo se ce n'è almeno una e
 * la serata non è finita. Una sola query: niente doppia spesa.
 * Ritorna { ok: true, priceCents } o { ok: false, reason }.
 * Il prezzo registrato sulla Pulse è quello medio pagato stasera
 * (uguale al prezzo della serata, salvo che l'Architetto l'abbia
 * cambiato dopo un acquisto: le Pulse già comprate tengono il loro).
 */
async function consumeNightPulse({ userId, arenaSessionId }, { db }) {
  const row = await db.query(
    `
    UPDATE pulse_night_balances b
    SET used = b.used + 1, updated_at = now()
    FROM arena_sessions a
    WHERE b.user_id = $1 AND b.arena_session_id = $2 AND a.id = b.arena_session_id
      AND b.purchased + b.returned - b.used - b.expired > 0
      AND a.pulse_deadline > now() AND a.pulses_expired_at IS NULL
    RETURNING b.purchased + b.returned - b.used - b.expired AS available, a.pulse_price_cents
  `,
    [userId, arenaSessionId]
  );

  if (!row) {
    const night = await db.query(
      `SELECT pulse_deadline > now() AND pulses_expired_at IS NULL AS is_open FROM arena_sessions WHERE id = $1`,
      [arenaSessionId]
    );
    if (!night) return { ok: false, reason: 'session_not_found' };
    return { ok: false, reason: night.is_open ? 'no_pulses_left' : 'pulse_night_ended' };
  }

  const paid = await db.query(
    `
    SELECT ROUND(SUM(total_cents)::numeric / NULLIF(SUM(quantity), 0)) AS avg_cents
    FROM pulse_purchases
    WHERE user_id = $1 AND arena_session_id = $2 AND status IN ('paid', 'test')
  `,
    [userId, arenaSessionId]
  );

  return {
    ok: true,
    available: parseInt(row.available),
    priceCents: parseInt(paid?.avg_cents) || row.pulse_price_cents,
  };
}

/**
 * Rimette UNA Pulse nel saldo della serata di chi l'ha inviata (Pulse
 * rifiutata, N3, o invio fallito dopo averla scalata). Dopo la fine
 * della serata non torna più: sarebbe già scaduta.
 */
async function returnNightPulse({ userId, arenaSessionId }, { db }) {
  const row = await db.query(
    `
    UPDATE pulse_night_balances b
    SET returned = b.returned + 1, updated_at = now()
    FROM arena_sessions a
    WHERE b.user_id = $1 AND b.arena_session_id = $2 AND a.id = b.arena_session_id
      AND a.pulse_deadline > now() AND a.pulses_expired_at IS NULL
    RETURNING b.purchased + b.returned - b.used - b.expired AS available
  `,
    [userId, arenaSessionId]
  );
  return { returned: !!row, available: row ? parseInt(row.available) : null };
}

/**
 * Aggiunge al saldo le Pulse di un acquisto, segnandolo pagato, in
 * UNA query: se l'acquisto è già stato accreditato (webhook arrivato
 * due volte, o ritorno dall'app arrivato prima del webhook) non
 * succede niente. Non accredita se la serata è già finita: in quel
 * caso il chiamante rimborsa (v. populive-payments-logic.js).
 * Ritorna la riga del saldo aggiornata, o null.
 */
async function creditNightPurchase({ purchaseId, newStatus, paymentIntentId = null }, { db }) {
  return db.query(
    `
    WITH p AS (
      UPDATE pulse_purchases pp
      SET status = $2, paid_at = now(), stripe_payment_intent_id = COALESCE($3, pp.stripe_payment_intent_id)
      FROM arena_sessions a
      WHERE pp.id = $1 AND pp.status IN ('pending', 'expired') AND a.id = pp.arena_session_id
        AND a.pulse_deadline > now() AND a.pulses_expired_at IS NULL
      RETURNING pp.user_id, pp.arena_session_id, pp.quantity
    )
    INSERT INTO pulse_night_balances (user_id, arena_session_id, purchased)
    SELECT user_id, arena_session_id, quantity FROM p
    ON CONFLICT (user_id, arena_session_id) DO UPDATE
      SET purchased = pulse_night_balances.purchased + EXCLUDED.purchased, updated_at = now()
    RETURNING user_id, arena_session_id, purchased + returned - used - expired AS available
  `,
    [purchaseId, newStatus, paymentIntentId]
  );
}

/**
 * Fine della serata per le Pulse (N6): saldi azzerati e Pulse non
 * ritirate scadute. Chiamata dallo scheduler per ogni serata arrivata
 * all'orario di chiusura e da closeSession (per sicurezza). Una volta
 * sola per serata: prima si "prenota" la serata (pulses_expired_at),
 * poi si azzera. Ritorna gli id delle Pulse mai decise (il chiamante
 * mette il raffreddamento tra le due persone) e chi è da avvisare.
 */
async function expireNightPulses(arenaSessionId, { db }) {
  const claimed = await db.query(
    `
    UPDATE arena_sessions SET pulses_expired_at = now()
    WHERE id = $1 AND pulses_expired_at IS NULL
    RETURNING id
  `,
    [arenaSessionId]
  );
  if (!claimed) return { alreadyDone: true, undecided: [], affectedUserIds: [] };

  const zeroed = await db.queryAll(
    `
    UPDATE pulse_night_balances
    SET expired = expired + (purchased + returned - used - expired), updated_at = now()
    WHERE arena_session_id = $1 AND purchased + returned - used - expired > 0
    RETURNING user_id
  `,
    [arenaSessionId]
  );

  // Mai decise (pending/ignored): scadono come prima a fine serata.
  // Accettate e non ritirate al bancone: scadono anche loro (P3; fino
  // al novembre 2026 restavano ritirabili per sempre).
  const expiredPulses = await db.queryAll(
    `
    WITH target AS (
      SELECT id, status FROM pulses
      WHERE arena_session_id = $1 AND status IN ('pending', 'ignored', 'accepted')
      FOR UPDATE
    )
    UPDATE pulses p SET status = 'expired'
    FROM target t
    WHERE p.id = t.id
    RETURNING p.id, p.sender_id, p.receiver_id, t.status AS previous_status
  `,
    [arenaSessionId]
  );

  const affected = new Set(zeroed.map((r) => r.user_id));
  for (const p of expiredPulses) {
    affected.add(p.sender_id);
    affected.add(p.receiver_id);
  }

  return { alreadyDone: false, expiredPulses, affectedUserIds: [...affected] };
}

/**
 * Avviso un'ora prima della fine (P2, P4): a chi ha ancora Pulse da
 * usare o drink da ritirare in una serata che chiude entro 60 minuti.
 * Una volta sola per serata (pulse_reminder_sent_at "prenota" l'invio
 * anche con più server accesi insieme). Socket per l'app aperta, push
 * per l'app chiusa.
 */
async function sendEndOfNightReminders({ db, io }) {
  const nights = await db.queryAll(
    `
    SELECT a.id, a.pulse_deadline, v.name AS venue_name
    FROM arena_sessions a
    JOIN venues v ON v.id = a.venue_id
    WHERE a.pulse_reminder_sent_at IS NULL AND a.pulses_expired_at IS NULL
      AND a.pulse_deadline > now() AND a.pulse_deadline <= now() + interval '60 minutes'
  `,
    []
  );

  let notified = 0;
  for (const night of nights) {
    const claimed = await db.query(
      `UPDATE arena_sessions SET pulse_reminder_sent_at = now() WHERE id = $1 AND pulse_reminder_sent_at IS NULL RETURNING id`,
      [night.id]
    );
    if (!claimed) continue;

    const people = await db.queryAll(
      `
      SELECT u.id AS user_id,
             COALESCE(b.purchased + b.returned - b.used - b.expired, 0) AS pulses_left,
             (SELECT COUNT(*) FROM pulses p
              WHERE p.receiver_id = u.id AND p.arena_session_id = $1 AND p.status = 'accepted') AS to_collect
      FROM users u
      LEFT JOIN pulse_night_balances b ON b.user_id = u.id AND b.arena_session_id = $1
      WHERE u.id IN (
        SELECT user_id FROM pulse_night_balances
        WHERE arena_session_id = $1 AND purchased + returned - used - expired > 0
        UNION
        SELECT receiver_id FROM pulses WHERE arena_session_id = $1 AND status = 'accepted'
      )
    `,
      [night.id]
    );

    const closingTime = formatRomeTime(night.pulse_deadline);
    for (const person of people) {
      const pulsesLeft = parseInt(person.pulses_left) || 0;
      const toCollect = parseInt(person.to_collect) || 0;
      if (pulsesLeft === 0 && toCollect === 0) continue;

      const payload = {
        arenaSessionId: night.id,
        venueName: night.venue_name,
        deadline: night.pulse_deadline,
        closingTime,
        pulsesLeft,
        toCollect,
      };
      io.to(`user_${person.user_id}`).emit('pulse_night_ending', payload);
      notifyUser(
        {
          userId: person.user_id,
          event: 'pulse_night_ending',
          data: { arenaSessionId: night.id },
          extra: payload,
        },
        { db }
      );
      notified++;
    }
  }
  return { nights: nights.length, notified };
}

// "02:00" in ora italiana, per i testi (avviso, push).
function formatRomeTime(date) {
  return new Date(date).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  MAX_PULSES_PER_PURCHASE,
  getPulseNightInfo,
  getNightBalance,
  consumeNightPulse,
  returnNightPulse,
  creditNightPurchase,
  expireNightPulses,
  sendEndOfNightReminders,
  formatRomeTime,
};
