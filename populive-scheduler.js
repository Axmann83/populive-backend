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
const { evaluatePendingDiscoveryMarkers } = require('./populive-connector-engine');

const TICK_INTERVAL_MS = 5 * 60 * 1000; // ogni 5 minuti — abbastanza spesso da non far
                                          // aspettare troppo un locale che sta per aprire,
                                          // abbastanza raro da non sovraccaricare il database

/**
 * Un singolo "giro" del motore — controlla ogni locale e decide
 * se aprire una nuova sessione, chiuderne una in corso, o non fare
 * nulla (siamo nel mezzo di una finestra già gestita).
 */
async function runSchedulerTick({ db, redis, io }) {
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
    console.error('[scheduler] errore nell\'assegnazione Pulse gratis settimanali:', err);
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

async function processVenue(venue, { db, redis, io }) {
  const isWithinWindow = await isVenueWithinOpenWindow(venue, { db });

  if (isWithinWindow) {
    await ensureSessionOpen(venue, { db, io });
  } else {
    await closeSessionIfOpen(venue, { db, redis, io });
  }
}

/**
 * Siamo dentro l'orario operativo del locale in questo momento?
 * Gestisce anche i locali che attraversano la mezzanotte (chiusura
 * "prima" dell'apertura nel quadrante dell'orologio).
 */
async function isVenueWithinOpenWindow(venue, { db }) {
  const row = await db.query(`SELECT LOCALTIME AS now_time`, []);
  const nowTime = row.now_time; // "HH:MM:SS"

  const { default_open_time: open, default_close_time: close } = venue;

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
 * la creiamo. Se esiste già, non facciamo nulla — evitiamo di
 * "riaprire" per errore una sessione già gestita.
 */
async function ensureSessionOpen(venue, { db, io }) {
  const dateRow = await db.query(`SELECT current_business_date($1) AS bdate`, [venue.id]);
  const businessDate = dateRow.bdate;

  const existing = await db.query(`
    SELECT id FROM arena_sessions WHERE venue_id = $1 AND session_date = $2
  `, [venue.id, businessDate]);

  if (existing) return; // già aperta, niente da fare

  await db.query(`
    INSERT INTO arena_sessions (venue_id, session_date, opened_at, is_open_for_checkin, is_active)
    VALUES ($1, $2, now(), true, false)
  `, [venue.id, businessDate]);

  // Non serve avvisare nessuno via WebSocket qui — non c'è ancora
  // nessuno collegato a una sessione che non esisteva un attimo fa.
}

/**
 * Se una sessione di questo locale è ancora "aperta" ma siamo fuori
 * dall'orario operativo, la chiudiamo: blocchiamo nuovi check-in,
 * congeliamo la classifica locale, chiudiamo le chat di quella
 * sessione (rispettando il doppio consenso "conserva"), e puliamo
 * lo stato vivo in Redis — i punti restano per sempre nel ledger,
 * solo il "vivo" della serata sparisce.
 */
async function closeSessionIfOpen(venue, { db, redis, io }) {
  const openSession = await db.query(`
    SELECT id FROM arena_sessions
    WHERE venue_id = $1 AND is_open_for_checkin = true AND closed_at IS NULL
    ORDER BY opened_at DESC LIMIT 1
  `, [venue.id]);

  if (!openSession) return; // niente da chiudere

  await db.query(`
    UPDATE arena_sessions
    SET is_open_for_checkin = false, closed_at = now()
    WHERE id = $1
  `, [openSession.id]);

  // Chat: rispetta il doppio consenso "conserva" già costruito —
  // chiude solo quelle senza consenso reciproco.
  await closeConversationsForSession(openSession.id, { db });

  // Pulizia dello stato "vivo" in Redis — il radar in tempo reale
  // e il contatore soglia di questa sessione non servono più.
  try {
    await redis.del(`arena:${openSession.id}:radar`);
    await redis.del(`arena:${openSession.id}:checkin_count`);
  } catch (err) {
    // Anche se Redis avesse un problema in questo istante, la
    // chiusura "ufficiale" in Postgres è già avvenuta — coerente
    // col principio fail-gracefully: il dato vivo si pulirà da
    // solo alla prossima scrittura, non è permanente comunque.
    console.error(`[scheduler] pulizia Redis fallita per sessione ${openSession.id}:`, err);
  }

  // Avvisiamo chi è ancora collegato alla stanza che l'Arena ha
  // chiuso — utile per aggiornare l'interfaccia (es. "buonanotte,
  // la classifica di stanotte è congelata").
  io.to(`arena_${openSession.id}`).emit('arena_closed', { arenaSessionId: openSession.id });
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

module.exports = { startScheduler, runSchedulerTick };
