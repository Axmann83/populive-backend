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
 * Bevande più richieste — dai dati delle Pulse riscattate.
 * NOTA: riflette solo le consumazioni passate tramite Pulse, non
 * l'intero consumo del locale (che non vediamo) — va presentato
 * al locale con questa precisazione, non come "il totale di cosa
 * si beve qui", ma come "tendenza tra chi usa PopuLive".
 */
async function getPopularDrinks({ venueId, fromDate, toDate }, { db }) {
  const rows = await db.query(`
    SELECT pulses.drink_type, COUNT(*) AS redemptions
    FROM pulses
    JOIN arena_sessions ON arena_sessions.id = pulses.arena_session_id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date BETWEEN $2 AND $3
      AND pulses.status = 'redeemed'
    GROUP BY pulses.drink_type
    ORDER BY redemptions DESC
  `, [venueId, fromDate, toDate]);

  const totalSample = rows.reduce((sum, r) => sum + parseInt(r.redemptions), 0);
  if (totalSample < MIN_SAMPLE_SIZE) {
    return { available: false, reason: 'sample_too_small', minRequired: MIN_SAMPLE_SIZE };
  }

  return { available: true, drinks: rows, totalSample };
}


/**
 * Rapporto uomini/donne e affluenza serale nel tempo — la prima
 * versione di questa funzione prometteva il rapporto di genere nel
 * commento ma non lo calcolava davvero (scritta prima che
 * esistesse gender_for_stats) — corretto ora che il dato c'è
 * per davvero, riusando la stessa logica già in uso per "Esplora
 * locali" lato utente.
 */
async function getAttendanceTrend({ venueId, fromDate, toDate }, { db }) {
  const rows = await db.query(`
    SELECT
      arena_sessions.session_date,
      COUNT(DISTINCT checkins.user_id) AS attendees,
      COUNT(DISTINCT checkins.user_id) FILTER (WHERE u.gender_for_stats = 'male') AS male_attendees,
      COUNT(DISTINCT checkins.user_id) FILTER (WHERE u.gender_for_stats = 'female') AS female_attendees,
      COUNT(DISTINCT checkins.user_id) FILTER (WHERE u.gender_for_stats = 'other') AS other_attendees
    FROM arena_sessions
    LEFT JOIN checkins ON checkins.arena_session_id = arena_sessions.id
    LEFT JOIN users u ON u.id = checkins.user_id
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
  const [arrivals, dwellTime, drinks, attendance, socialInteractions, returnRate, peakAttendance] = await Promise.all([
    getArrivalTimeDistribution({ venueId, fromDate, toDate }, { db }),
    getAverageDwellTime({ venueId, fromDate, toDate }, { db }),
    getPopularDrinks({ venueId, fromDate, toDate }, { db }),
    getAttendanceTrend({ venueId, fromDate, toDate }, { db }),
    getSocialInteractionsCount({ venueId, fromDate, toDate }, { db }),
    getReturnRate({ venueId, fromDate, toDate }, { db }),
    getPeakConcurrentAttendance({ venueId, fromDate, toDate }, { db }),
  ]);

  return { arrivals, dwellTime, drinks, attendance, socialInteractions, returnRate, peakAttendance, generatedAt: new Date() };
}


/**
 * ============================================================
 * LOCALI PIÙ POPOLARI ORA — sostituisce i dati dimostrativi di
 * ExploreMap.jsx con numeri veri: quanti check-in ha ricevuto
 * ciascun locale nella serata di business corrente (che gestisce
 * già da sola il problema mezzanotte). SOLO dati aggregati, mai
 * profili individuali — stessa regola di sempre per questo tipo
 * di vista.
 *
 * Il rapporto uomini/donne è calcolato SOLO su chi ha scelto di
 * condividere il dato in fase di registrazione (gender_for_stats,
 * facoltativo) — mai un valore forzato per chi non l'ha condiviso.
 * ============================================================
 */
async function getPopularVenuesNow({ limit = 10 }, { db }) {
  const rows = await db.queryAll(`
    SELECT
      v.id, v.name, v.category,
      COUNT(c.id) AS checkin_count,
      ars.is_active,
      -- Conteggio SOLO di chi ha scelto di condividere il dato —
      -- mai un valore inventato per chi non l'ha fatto. Restano
      -- fuori dal conteggio, non vengono forzati in una categoria.
      COUNT(u.id) FILTER (WHERE u.gender_for_stats = 'male') AS male_count,
      COUNT(u.id) FILTER (WHERE u.gender_for_stats = 'female') AS female_count,
      COUNT(u.id) FILTER (WHERE u.gender_for_stats = 'other') AS other_count
    FROM venues v
    JOIN arena_sessions ars
      ON ars.venue_id = v.id
      AND ars.session_date = current_business_date(v.id)
      AND ars.is_open_for_checkin = true
    LEFT JOIN checkins c ON c.arena_session_id = ars.id
    LEFT JOIN users u ON u.id = c.user_id
    GROUP BY v.id, v.name, v.category, ars.is_active
    HAVING COUNT(c.id) > 0
    ORDER BY checkin_count DESC
    LIMIT $1
  `, [limit]);

  return rows.map((r) => {
    const male = parseInt(r.male_count) || 0;
    const female = parseInt(r.female_count) || 0;
    const other = parseInt(r.other_count) || 0;
    const sharedTotal = male + female + other;

    return {
      venueId: r.id,
      name: r.name,
      category: r.category,
      checkinCount: parseInt(r.checkin_count),
      arenaActive: r.is_active,
      // Percentuali calcolate SOLO su chi ha condiviso — se nessuno
      // lo ha fatto, il frontend semplicemente non mostra questa
      // parte (sharedTotal = 0 lo segnala chiaramente).
      genderStats: sharedTotal > 0 ? {
        sharedTotal,
        malePct: Math.round((male / sharedTotal) * 100),
        femalePct: Math.round((female / sharedTotal) * 100),
        otherPct: Math.round((other / sharedTotal) * 100),
      } : null,
    };
  });
}


/**
 * ============================================================
 * BACHECA STORICA
 * ============================================================
 * Chi ha fatto check-in in QUESTO locale negli ultimi 7 giorni —
 * per chi ha visto qualcuno dal vivo ma non ha fatto in tempo a
 * interagire quella sera stessa. Riusa il consenso GIÀ ESISTENTE
 * "appears_in_historical_search" (raccolto in registrazione/
 * Impostazioni, ma mai usato finora da nessuna parte) — solo chi
 * lo ha attivo compare in questa ricerca. Il proprio profilo non
 * compare mai a se stessi, e chi si è bloccato a vicenda resta
 * escluso, stessa regola di sempre.
 * ============================================================
 */
const HISTORICAL_BOARD_DAYS = 7;

async function getVenueHistoricalCheckins({ venueId, requesterId }, { db }) {
  const rows = await db.queryAll(`
    SELECT DISTINCT ON (u.id)
      u.id, u.display_name, u.photo_url, u.avatar_emoji, c.checked_in_at
    FROM checkins c
    JOIN arena_sessions a ON a.id = c.arena_session_id
    JOIN users u ON u.id = c.user_id
    WHERE a.venue_id = $1
      AND c.checked_in_at >= now() - INTERVAL '${HISTORICAL_BOARD_DAYS} days'
      AND u.appears_in_historical_search = true
      AND u.id != $2
      AND NOT EXISTS (
        SELECT 1 FROM blocks
        WHERE (blocker_id = $2 AND blocked_id = u.id)
           OR (blocker_id = u.id AND blocked_id = $2)
      )
    ORDER BY u.id, c.checked_in_at DESC
  `, [venueId, requesterId]);

  return rows
    .sort((a, b) => new Date(b.checked_in_at) - new Date(a.checked_in_at))
    .map((r) => ({
      userId: r.id,
      displayName: r.display_name,
      photoUrl: r.photo_url,
      avatarEmoji: r.avatar_emoji || '🙂',
      lastSeenAt: r.checked_in_at,
    }));
}


/**
 * Interazioni sociali generate nel locale — quanti Like/Superlike
 * sono stati scambiati lì dentro. Un argomento di vendita che
 * nessun locale tradizionale può offrire: non solo "quante persone
 * sono venute", ma "quante connessioni vere sono nate qui".
 */
async function getSocialInteractionsCount({ venueId, fromDate, toDate }, { db }) {
  const result = await db.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE type = 'like') AS likes,
      COUNT(*) FILTER (WHERE type = 'superlike') AS superlikes
    FROM interactions
    JOIN arena_sessions ON arena_sessions.id = interactions.arena_session_id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date BETWEEN $2 AND $3
  `, [venueId, fromDate, toDate]);

  const total = parseInt(result.total) || 0;
  if (total < MIN_SAMPLE_SIZE) {
    return { available: false, reason: 'sample_too_small', minRequired: MIN_SAMPLE_SIZE };
  }

  return {
    available: true,
    total,
    likes: parseInt(result.likes) || 0,
    superlikes: parseInt(result.superlikes) || 0,
  };
}


/**
 * Tasso di ritorno — quante persone sono tornate almeno una
 * seconda volta nell'intervallo considerato. Segnale forte di
 * fedeltà, utile in un pitch commerciale quanto (o più) del
 * numero grezzo di presenze.
 */
async function getReturnRate({ venueId, fromDate, toDate }, { db }) {
  const result = await db.query(`
    SELECT
      COUNT(*) AS total_visitors,
      COUNT(*) FILTER (WHERE visit_count > 1) AS returning_visitors
    FROM (
      SELECT checkins.user_id, COUNT(DISTINCT arena_sessions.session_date) AS visit_count
      FROM checkins
      JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
      WHERE arena_sessions.venue_id = $1
        AND arena_sessions.session_date BETWEEN $2 AND $3
      GROUP BY checkins.user_id
    ) visits
  `, [venueId, fromDate, toDate]);

  const totalVisitors = parseInt(result.total_visitors) || 0;
  if (totalVisitors < MIN_SAMPLE_SIZE) {
    return { available: false, reason: 'sample_too_small', minRequired: MIN_SAMPLE_SIZE };
  }

  const returningVisitors = parseInt(result.returning_visitors) || 0;
  return {
    available: true,
    totalVisitors,
    returningVisitors,
    returnRatePct: Math.round((returningVisitors / totalVisitors) * 100),
  };
}


/**
 * Picco di presenze simultanee — non il totale della serata, ma
 * il momento esatto di massimo affollamento. Approssimato con
 * "fotografie" ogni 30 minuti (quante persone risultano dentro in
 * quel momento, tra chi ha fatto check-in e non ha ancora fatto
 * check-out) — non è un dato al secondo, ma sufficiente per capire
 * quando davvero un locale "esplode".
 */
async function getPeakConcurrentAttendance({ venueId, fromDate, toDate }, { db }) {
  const rows = await db.query(`
    WITH hourly_snapshots AS (
      SELECT
        a.session_date,
        snap_time,
        COUNT(c.id) AS concurrent_count
      FROM arena_sessions a
      CROSS JOIN LATERAL generate_series(
        a.opened_at,
        a.opened_at + INTERVAL '8 hours',
        INTERVAL '30 minutes'
      ) AS snap_time
      LEFT JOIN checkins c
        ON c.arena_session_id = a.id
        AND c.checked_in_at <= snap_time
        AND (c.checked_out_at IS NULL OR c.checked_out_at > snap_time)
      WHERE a.venue_id = $1
        AND a.session_date BETWEEN $2 AND $3
      GROUP BY a.session_date, snap_time
    )
    SELECT session_date, MAX(concurrent_count) AS peak
    FROM hourly_snapshots
    GROUP BY session_date
    ORDER BY session_date
  `, [venueId, fromDate, toDate]);

  if (rows.length === 0) {
    return { available: false, reason: 'sample_too_small', minRequired: MIN_SAMPLE_SIZE };
  }

  const peaks = rows.map((r) => parseInt(r.peak) || 0);
  const allTimeHigh = Math.max(...peaks);
  const avgPeak = Math.round(peaks.reduce((sum, p) => sum + p, 0) / peaks.length);

  return { available: true, allTimeHigh, avgPeakPerNight: avgPeak, nightlyPeaks: rows };
}


/**
 * Report commissioni per locale — quante Pulse sono state
 * riscattate lì (contate tutte, non solo negli ultimi 30 giorni,
 * dato che serve sapere il totale da girare, non solo l'andamento
 * recente) e quanto spetta al locale in base alla percentuale
 * d'accordo. Il valore di riferimento per Pulse è il prezzo
 * ATTUALE del pacchetto singolo (pulse_single_1) — un'approssimazione
 * dichiarata, dato che i crediti possono venire da fonti diverse
 * (gratis, pre-pagati, acquistati), non un calcolo esatto centesimo
 * per centesimo.
 */
async function getCommissionsReport({}, { db }) {
  const referencePrice = await db.query(`
    SELECT price_cents FROM iap_products WHERE sku = 'pulse_single_1' AND is_active = true
  `);
  const pricePerPulseCents = referencePrice?.price_cents || 0;

  const rows = await db.queryAll(`
    SELECT
      v.id, v.name, v.commission_venue_pct,
      COUNT(p.id) AS redeemed_count
    FROM venues v
    LEFT JOIN pulses p ON p.redeemed_venue_id = v.id AND p.status = 'redeemed'
    WHERE v.is_partner = true
    GROUP BY v.id, v.name, v.commission_venue_pct
    ORDER BY redeemed_count DESC
  `);

  return rows.map((r) => {
    const redeemedCount = parseInt(r.redeemed_count) || 0;
    const totalCents = redeemedCount * pricePerPulseCents;
    const venuePct = r.commission_venue_pct;
    const venueOwedCents = Math.round(totalCents * (venuePct / 100));

    return {
      venueId: r.id,
      venueName: r.name,
      commissionVenuePct: venuePct,
      redeemedCount,
      venueOwedCents,
    };
  });
}


module.exports = {
  MIN_SAMPLE_SIZE,
  getArrivalTimeDistribution,
  getAverageDwellTime,
  getPopularDrinks,
  getAttendanceTrend,
  getSocialInteractionsCount,
  getReturnRate,
  getPeakConcurrentAttendance,
  getCommissionsReport,
  generateVenueReport,
  getPopularVenuesNow,
  getVenueHistoricalCheckins,
};
