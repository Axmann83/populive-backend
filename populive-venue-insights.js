/**
 * ============================================================
 * POPULIVE — VENUE INSIGHTS (report aggregati per i locali)
 * ============================================================
 * Regola non negoziabile: OGNI funzione qui restituisce solo dati
 * aggregati (medie, conteggi, distribuzioni) — mai righe legate a
 * un singolo utente. Un locale non deve mai poter risalire al
 * comportamento di una persona specifica tramite questi report.
 *
 * Protezione aggiuntiva: se il campione è troppo piccolo (es. una
 * serata con solo 3 persone), anche un dato "aggregato" rischia di
 * essere di fatto individuale — "il drink più popolare stasera"
 * con 3 persone vuol dire "cosa ha bevuto una di loro". Sotto la
 * soglia MIN_SAMPLE_SIZE, il report semplicemente non genera quel
 * dato, invece di mostrare un numero fuorviante o rischioso.
 * ============================================================
 */

const MIN_SAMPLE_SIZE = 10;


/**
 * Distribuzione oraria degli arrivi — utile al locale per capire
 * quando davvero si riempie (spesso diverso da quando "dovrebbe").
 */
async function getArrivalTimeDistribution({ venueId, fromDate, toDate }, { db }) {
  const rows = await db.query(`
    SELECT EXTRACT(HOUR FROM checked_in_at) AS hour, COUNT(*) AS arrivals
    FROM checkins
    JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date BETWEEN $2 AND $3
    GROUP BY hour
    ORDER BY hour
  `, [venueId, fromDate, toDate]);

  const totalSample = rows.reduce((sum, r) => sum + parseInt(r.arrivals), 0);
  if (totalSample < MIN_SAMPLE_SIZE) {
    return { available: false, reason: 'sample_too_small', minRequired: MIN_SAMPLE_SIZE };
  }

  return { available: true, distribution: rows, totalSample };
}


/**
 * Permanenza media (quanto tempo restano, in media, gli utenti) —
 * calcolata solo sui check-in che hanno un checked_out_at valido
 * (una disconnessione mai registrata, es. per un crash, non entra
 * nel calcolo — meglio un dato su un campione più piccolo ma
 * corretto, che uno gonfiato da stime sbagliate).
 */
async function getAverageDwellTime({ venueId, fromDate, toDate }, { db }) {
  const result = await db.query(`
    SELECT
      COUNT(*) AS sample_size,
      AVG(EXTRACT(EPOCH FROM (checked_out_at - checked_in_at)) / 60) AS avg_minutes
    FROM checkins
    JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date BETWEEN $2 AND $3
      AND checked_out_at IS NOT NULL
  `, [venueId, fromDate, toDate]);

  if (result.sample_size < MIN_SAMPLE_SIZE) {
    return { available: false, reason: 'sample_too_small', minRequired: MIN_SAMPLE_SIZE };
  }

  return { available: true, avgMinutes: Math.round(result.avg_minutes), sampleSize: result.sample_size };
}


/**
 * Bevande più richieste — dai dati delle Rose riscattate.
 * NOTA: riflette solo le consumazioni passate tramite Rosa, non
 * l'intero consumo del locale (che non vediamo) — va presentato
 * al locale con questa precisazione, non come "il totale di cosa
 * si beve qui", ma come "tendenza tra chi usa PopuLive".
 */
async function getPopularDrinks({ venueId, fromDate, toDate }, { db }) {
  const rows = await db.query(`
    SELECT roses.drink_type, COUNT(*) AS redemptions
    FROM roses
    JOIN arena_sessions ON arena_sessions.id = roses.arena_session_id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date BETWEEN $2 AND $3
      AND roses.status = 'redeemed'
    GROUP BY roses.drink_type
    ORDER BY redemptions DESC
  `, [venueId, fromDate, toDate]);

  const totalSample = rows.reduce((sum, r) => sum + parseInt(r.redemptions), 0);
  if (totalSample < MIN_SAMPLE_SIZE) {
    return { available: false, reason: 'sample_too_small', minRequired: MIN_SAMPLE_SIZE };
  }

  return { available: true, drinks: rows, totalSample };
}


/**
 * Rapporto uomini/donne e affluenza serale nel tempo — riusa gli
 * stessi principi delle card "esplora locali" già costruite lato
 * utente, qui però su un intervallo di date invece che sulla sola
 * serata corrente.
 */
async function getAttendanceTrend({ venueId, fromDate, toDate }, { db }) {
  const rows = await db.query(`
    SELECT
      arena_sessions.session_date,
      COUNT(DISTINCT checkins.user_id) AS attendees
    FROM arena_sessions
    LEFT JOIN checkins ON checkins.arena_session_id = arena_sessions.id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date BETWEEN $2 AND $3
    GROUP BY arena_sessions.session_date
    ORDER BY arena_sessions.session_date
  `, [venueId, fromDate, toDate]);

  return { available: true, trend: rows };
  // Nota: qui NON applichiamo la soglia minima campione perché il
  // dato è già "quante persone in totale quella sera", non
  // scomponibile per singolo individuo — resta aggregato di per sé.
}


/**
 * Report completo, pensato per essere mostrato al proprietario del
 * locale (o usato nel pitch commerciale per convincerlo a diventare
 * partner). Unisce le quattro funzioni sopra in un'unica risposta.
 */
async function generateVenueReport({ venueId, fromDate, toDate }, { db }) {
  const [arrivals, dwellTime, drinks, attendance] = await Promise.all([
    getArrivalTimeDistribution({ venueId, fromDate, toDate }, { db }),
    getAverageDwellTime({ venueId, fromDate, toDate }, { db }),
    getPopularDrinks({ venueId, fromDate, toDate }, { db }),
    getAttendanceTrend({ venueId, fromDate, toDate }, { db }),
  ]);

  return { arrivals, dwellTime, drinks, attendance, generatedAt: new Date() };
}

module.exports = {
  MIN_SAMPLE_SIZE,
  getArrivalTimeDistribution,
  getAverageDwellTime,
  getPopularDrinks,
  getAttendanceTrend,
  generateVenueReport,
};
