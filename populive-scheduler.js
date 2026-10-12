/**
 * ============================================================
 * POPULIVE — MOTORE A ORARI (job schedulato)
 * ============================================================
 * Finora avevamo scritto SOLO la logica che risponde alla domanda
 * "che giorno/serata è, per questo locale?" (current_business_date,
 * funzione SQL). Qui scriviamo il pezzo che mancava: chi controlla
 * PERIODICAMENTE tutti i locali e decide se è ora di aprire o
 * chiudere la loro Arena — senza che nessuno debba farlo a mano.
 *
 * Il modo giusto di farlo girare in produzione: un piccolo processo
 * a parte (non dentro le richieste HTTP normali) che chiama
 * runSchedulerTick() ogni pochi minuti, per sempre, finché il
 * server è acceso.
 * ============================================================
 */

const { closeConversationsForSession, purgeExpiredChatMessages } = require('./populive-chat-logic');
const {
  evaluatePendingDiscoveryMarkers,
  awardTopTalentBonuses,
  awardTopTableActivityBonuses,
} = require('./populive-connector-engine');
const { refundAbandonedPulsesForSession } = require('./populive-interactions-logic');
const { expireOldCheckins } = require('./populive-checkin-logic');

const TICK_INTERVAL_MS = 5 * 60 * 1000; // ogni 5 minuti — abbastanza spesso da non far
// aspettare troppo un locale che sta per aprire,
// abbastanza raro da non sovraccaricare il database

/**
 * Un singolo "giro" del motore — controlla ogni locale e decide
 * se aprire una nuova sessione, chiuderne una in corso, o non fare
 * nulla (siamo nel mezzo di una finestra già gestita).
 */
async function runSchedulerTick({ db, redis, io }) {
  // Prima delle serate: chi ha fatto check-in da più di 24 ore esce
  // (D14), così una serata rimasta vuota finisce già in questo giro.
  try {
    await expireOldCheckins({ db, io });
  } catch (err) {
    console.error('[scheduler] errore nelle uscite dopo 24 ore:', err);
  }

  const venues = await db.queryAll(`SELECT id, default_open_time, default_close_time FROM venues`);

  for (const venue of venues) {
    try {
      await processVenue(venue, { db, redis, io });
    } catch (err) {
      // Un locale con un problema non deve bloccare gli altri —
      // stesso principio "fail gracefully" di tutto il resto del
      // codice. Logghiamo e andiamo avanti con il prossimo.
      console.error(`[scheduler] errore sul locale ${venue.id}:`, err);
    }
  }

  // Job del Top Connector: valuta i marker di scoperta più vecchi
  // della finestra di tempo — non ha bisogno di girare per ogni
  // locale singolarmente, controlla tutto il database in un colpo.
  try {
    await evaluatePendingDiscoveryMarkers({ db, io });
  } catch (err) {
    console.error('[scheduler] errore nella valutazione discovery marker:', err);
  }

  // Pulizia messaggi chat: cancella il CONTENUTO dei messaggi delle
  // conversazioni chiuse da più di 30 giorni — ultimo pezzo mancante
  // dell'archivio di sicurezza. Anche questo controlla tutto il
  // database in un colpo, non serve farlo per singolo locale.
  try {
    await purgeExpiredChatMessages({ db });
  } catch (err) {
    console.error('[scheduler] errore nella pulizia messaggi chat scaduti:', err);
  }

  // Pulse gratis settimanale: un'unica query copre tutti gli
  // utenti insieme, non serve girare uno per uno. Chi ha già 2
  // Pulse gratis (il tetto massimo) resta escluso E il suo
  // contatore non avanza — così, appena ne spende una e si libera
  // spazio, viene ricaricato subito al giro successivo invece di
  // dover aspettare altri 7 giorni interi.
  try {
    await grantWeeklyFreePulses({ db });
  } catch (err) {
    console.error("[scheduler] errore nell'assegnazione Pulse gratis settimanali:", err);
  }

  // Saldo Superlike: stesso principio della Pulse gratis — parte da
  // 5, si ricarica di +5 a settimana se non lo finisci, mai oltre
  // il tetto di 10 (né per accumulo gratuito né per acquisto).
  try {
    await grantWeeklySuperlikes({ db });
  } catch (err) {
    console.error('[scheduler] errore nella ricarica saldo Superlike settimanale:', err);
  }
}

async function grantWeeklySuperlikes({ db }) {
  await db.query(`
    UPDATE users
    SET superlike_balance = LEAST(superlike_balance + 5, 10),
        last_superlike_grant_at = last_superlike_grant_at + INTERVAL '7 days'
    WHERE last_superlike_grant_at <= now() - INTERVAL '7 days'
      AND superlike_balance < 10
  `);
}

async function grantWeeklyFreePulses({ db }) {
  await db.query(`
    UPDATE users
    SET free_pulses_balance = LEAST(free_pulses_balance + 1, 2),
        last_free_pulse_grant_at = last_free_pulse_grant_at + INTERVAL '7 days'
    WHERE last_free_pulse_grant_at <= now() - INTERVAL '7 days'
      AND free_pulses_balance < 2
  `);
}

/**
 * ============================================================
 * I TRE MOMENTI DI UNA SERATA (ottobre 2026, D14 nella spec)
 * ============================================================
 *   1. APERTA AGLI INGRESSI — dentro l'orario del locale
 *      (is_open_for_checkin = true): si entra col QR.
 *   2. CHIUSA AGLI INGRESSI — fuori orario (is_open_for_checkin =
 *      false, closed_at ancora NULL): niente nuovi check-in, ma chi
 *      c'è resta dentro, radar e interazioni compresi. Decisione
 *      dell'utente: una palestra 06:00-02:00 che apre l'11/10 tiene
 *      dentro chi c'era anche dalle 02:00 alle 06:00 del 12/10.
 *   3. FINITA (closed_at valorizzato, closeSession): quando inizia la
 *      serata nuova dello stesso locale, oppure quando dopo l'orario
 *      non resta più nessuno dentro (tutti usciti, o dopo 24 ore dal
 *      check-in: v. expireOldCheckins). Solo qui si chiudono chat,
 *      rimborsi delle Pulse e bonus di fine serata.
 * Un locale chiuso anche solo un secondo tra un giorno e l'altro ha
 * quindi due serate distinte; uno aperto 24 ore su 24 (apertura =
 * chiusura, es. 06:00-06:00) cambia serata ogni giorno all'orario di
 * apertura. Gli orari sono sempre ora italiana (migrazione 006).
 * ============================================================
 */
async function processVenue(venue, { db, redis, io }) {
  const isWithinWindow = await isVenueWithinOpenWindow(venue, { db });

  if (isWithinWindow) {
    await ensureSessionOpen(venue, { db });
  } else {
    await closeSessionEntries(venue, { db });
  }

  // Una serata nuova chiude le precedenti (anche più d'una: bug B9,
  // 2/10, un server spento proprio nelle ore di chiusura lasciava le
  // serate vecchie aperte per sempre accanto a quella nuova — check-in
  // mai chiusi, bonus mai assegnati, Pulse mai rimborsate).
  await closeSupersededSessions(venue, { db, redis, io });

  // Dopo l'orario, una serata senza più nessuno dentro è finita.
  await closeEmptySessions(venue, { db, redis, io });
}

// Stesso giro per un solo locale, usato dal check-in quando un QR
// arriva prima che lo scheduler abbia creato la serata appena aperta.
async function processVenueById(venueId, { db, redis, io }) {
  const venue = await db.query(`SELECT id, default_open_time, default_close_time FROM venues WHERE id = $1`, [venueId]);
  if (venue) await processVenue(venue, { db, redis, io });
}

/**
 * Siamo dentro l'orario operativo del locale in questo momento, in
 * ora italiana (prima era l'ora del database, cioè UTC: v.
 * migrazione 006)? Gestisce anche i locali che attraversano la
 * mezzanotte (chiusura "prima" dell'apertura nel quadrante
 * dell'orologio) e quelli aperti 24 ore (apertura = chiusura), che
 * prima non risultavano mai aperti.
 */
async function isVenueWithinOpenWindow(venue, { db }) {
  const row = await db.query(`SELECT to_char(now() AT TIME ZONE 'Europe/Rome', 'HH24:MI:SS') AS now_time`, []);
  const nowTime = row.now_time; // "HH:MM:SS"

  const { default_open_time: open, default_close_time: close } = venue;

  if (close === open) {
    return true; // aperto 24 ore su 24
  }
  if (close < open) {
    // Attraversa la mezzanotte (es. 22:00-06:00): dentro la finestra
    // se siamo dopo l'apertura di sera OPPURE prima della chiusura
    // di mattina.
    return nowTime >= open || nowTime < close;
  }
  // Caso normale, stesso giorno di calendario (es. 19:00-24:00)
  return nowTime >= open && nowTime < close;
}

/**
 * Se non esiste ancora una sessione per la serata di oggi (secondo
 * current_business_date, che risolve già il problema mezzanotte),
 * la creiamo. Se esiste già e non è finita, si riaprono gli ingressi
 * (es. il locale ha allungato l'orario dalla Dashboard); una serata
 * finita non si riapre mai.
 */
async function ensureSessionOpen(venue, { db }) {
  const dateRow = await db.query(`SELECT current_business_date($1) AS bdate`, [venue.id]);
  const businessDate = dateRow.bdate;

  const existing = await db.query(
    `
    SELECT id, is_open_for_checkin, closed_at FROM arena_sessions WHERE venue_id = $1 AND session_date = $2
  `,
    [venue.id, businessDate]
  );

  if (existing) {
    if (!existing.is_open_for_checkin && existing.closed_at === null) {
      await db.query(`UPDATE arena_sessions SET is_open_for_checkin = true WHERE id = $1`, [existing.id]);
    }
    return;
  }

  // ON CONFLICT: lo scheduler e un check-in arrivato nello stesso
  // istante (processVenueById) possono provare a crearla insieme.
  await db.query(
    `
    INSERT INTO arena_sessions (venue_id, session_date, opened_at, is_open_for_checkin, is_active)
    VALUES ($1, $2, now(), true, false)
    ON CONFLICT (venue_id, session_date) DO NOTHING
  `,
    [venue.id, businessDate]
  );

  // Non serve avvisare nessuno via WebSocket qui — non c'è ancora
  // nessuno collegato a una sessione che non esisteva un attimo fa.
}

// Fuori orario: niente più nuovi ingressi, ma la serata non finisce
// (v. "I tre momenti di una serata").
async function closeSessionEntries(venue, { db }) {
  await db.query(
    `
    UPDATE arena_sessions SET is_open_for_checkin = false
    WHERE venue_id = $1 AND is_open_for_checkin = true AND closed_at IS NULL
  `,
    [venue.id]
  );
}

// Finisce ogni serata non ancora finita di questo locale che sia più
// vecchia dell'ultima creata.
async function closeSupersededSessions(venue, { db, redis, io }) {
  const superseded = await db.queryAll(
    `
    SELECT id FROM arena_sessions
    WHERE venue_id = $1 AND closed_at IS NULL
      AND session_date < (SELECT MAX(session_date) FROM arena_sessions WHERE venue_id = $1)
    ORDER BY opened_at
  `,
    [venue.id]
  );

  for (const session of superseded) {
    await closeSession(session.id, { db, redis, io });
  }
}

// Finisce ogni serata chiusa agli ingressi in cui non c'è più nessuno
// con un check-in aperto.
async function closeEmptySessions(venue, { db, redis, io }) {
  const empty = await db.queryAll(
    `
    SELECT id FROM arena_sessions
    WHERE venue_id = $1 AND is_open_for_checkin = false AND closed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM checkins
        WHERE checkins.arena_session_id = arena_sessions.id AND checkins.checked_out_at IS NULL
      )
    ORDER BY opened_at
  `,
    [venue.id]
  );

  for (const session of empty) {
    await closeSession(session.id, { db, redis, io });
  }
}

// La fine vera e propria di UNA serata (momento 3): blocchiamo nuovi
// check-in, congeliamo la classifica locale, chiudiamo le chat di
// quella sessione (rispettando il doppio consenso "conserva"),
// rimborsiamo chi ha inviato una Pulse mai decisa dal destinatario, e
// puliamo lo stato vivo in Redis — i punti restano per sempre nel
// ledger, solo il "vivo" della serata sparisce.
async function closeSession(sessionId, { db, redis, io }) {
  await db.query(
    `
    UPDATE arena_sessions
    SET is_open_for_checkin = false, closed_at = now()
    WHERE id = $1
  `,
    [sessionId]
  );

  await db.query(
    `
    UPDATE checkins SET checked_out_at = now(), checked_out_reason = 'session_end'
    WHERE arena_session_id = $1 AND checked_out_at IS NULL
  `,
    [sessionId]
  );

  // Chat: rispetta il doppio consenso "conserva" già costruito —
  // chiude solo quelle senza consenso reciproco.
  await closeConversationsForSession(sessionId, { db });

  // Pulse mai decise (pending/ignored) — buco trovato dal vivo:
  // restare nello stesso locale per sempre, senza mai scansionare
  // un altro QR, avrebbe permesso di rimandare la decisione a
  // tempo indeterminato. A fine serata la questione si chiude
  // comunque, con lo stesso rimborso già previsto per il cambio
  // locale. Le Pulse GIÀ accettate non c'entrano, restano valide
  // come deciso in precedenza.
  await refundAbandonedPulsesForSession(sessionId, { db });

  // Bonus "talent scout" di fine serata (17/9) — i Connector dei tre
  // tavoli diversi con dentro la persona più popolare della sera.
  // Va fatto QUI, una volta sola alla chiusura vera, mai durante la
  // serata (altrimenti "chi è il più popolare" cambierebbe in corsa).
  try {
    await awardTopTalentBonuses(sessionId, { db, io });
  } catch (err) {
    console.error(`[scheduler] errore nel bonus talent scout per sessione ${sessionId}:`, err);
  }

  // Bonus "tavolo più attivo" di fine serata (19/9) — stesso identico
  // momento del Talent Scout qui sopra, mai durante la serata. Diverso
  // dal Talent Scout: premia la somma di TUTTO il tavolo, non il
  // singolo membro più popolare, e si divide tra tutti i partecipanti
  // invece di andare solo al Connector — v. populive-connector-engine.js.
  try {
    await awardTopTableActivityBonuses(sessionId, { db, io });
  } catch (err) {
    console.error(`[scheduler] errore nel bonus tavolo più attivo per sessione ${sessionId}:`, err);
  }

  // Pulizia dello stato "vivo" in Redis — il radar in tempo reale
  // e il contatore soglia di questa sessione non servono più.
  try {
    await redis.del(`arena:${sessionId}:radar`);
    await redis.del(`arena:${sessionId}:checkin_count`);
    // Blocco tavoli (19/9) — stesso principio: stato vivo, sparisce
    // con la sessione, mai bisogno di sapere in anticipo quali tavoli
    // erano stati chiusi durante la serata.
    await redis.del(`arena:${sessionId}:locked_tables`);
  } catch (err) {
    // Anche se Redis avesse un problema in questo istante, la
    // chiusura "ufficiale" in Postgres è già avvenuta — coerente
    // col principio fail-gracefully: il dato vivo si pulirà da
    // solo alla prossima scrittura, non è permanente comunque.
    console.error(`[scheduler] pulizia Redis fallita per sessione ${sessionId}:`, err);
  }

  // Avvisiamo chi è ancora collegato alla stanza che l'Arena ha
  // chiuso — utile per aggiornare l'interfaccia (es. "buonanotte,
  // la classifica di stanotte è congelata").
  io.to(`arena_${sessionId}`).emit('arena_closed', { arenaSessionId: sessionId });
}

/**
 * Avvia il motore — da chiamare UNA VOLTA all'avvio del server,
 * non dentro una richiesta HTTP.
 */
function startScheduler({ db, redis, io }) {
  runSchedulerTick({ db, redis, io }); // un primo giro subito, non aspettare 5 minuti
  const intervalId = setInterval(() => runSchedulerTick({ db, redis, io }), TICK_INTERVAL_MS);
  return () => clearInterval(intervalId); // utile nei test, per fermarlo in modo pulito
}

module.exports = { startScheduler, runSchedulerTick, processVenueById };
