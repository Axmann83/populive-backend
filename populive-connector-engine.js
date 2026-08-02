/**
 * ============================================================
 * POPULIVE — TOP CONNECTOR
 * ============================================================
 * Due motori, come da documento originale, entrambi SEMPRE
 * scoped alla singola arena_session — nessun vantaggio permanente.
 *
 *   A) Motore Fisico: Squad via QR — i punti dei membri si
 *      riflettono (in parte) al Connector.
 *   B) Motore Algoritmico: il Connector "scopre" un profilo con
 *      un voto; se quel profilo esplode entro una finestra di
 *      tempo, arriva un bonus retroattivo — QUESTO richiede un
 *      job schedulato reale, non è "una colonna in più" come
 *      stimato nel documento originale.
 * ============================================================
 */

const { awardPoints } = require('./populive-points-engine');

const SQUAD_REFLECTION_SHARE = 0.15; // quanto dei punti di un membro si riflette al Connector
const DISCOVERY_WINDOW_HOURS = 2;
const DISCOVERY_SURGE_THRESHOLD = 20; // punti guadagnati dal "discovered" per considerarlo un'esplosione
const CONNECTOR_TOP_PERCENTILE = 0.05; // top 5% dell'Arena
const SPENDER_TOP_PERCENTILE = 0.05;   // stesso principio, per la spesa al tavolo


// ------------------------------------------------------------
// TOP SPENDER — stesso principio del Top Connector: calcolato
// PER SESSIONE, mai un badge permanente. Si basa sui punti che
// arrivano da 'table_spending_threshold' in QUESTA arena_session.
// ------------------------------------------------------------
async function recalculateTopSpenders(arenaSessionId, { db }) {
  await db.query(`
    WITH spending_totals AS (
      SELECT user_id, SUM(points) AS spend_points
      FROM points_ledger
      WHERE arena_session_id = $1 AND source = 'table_spending_threshold'
      GROUP BY user_id
    ),
    ranked AS (
      SELECT user_id, PERCENT_RANK() OVER (ORDER BY spend_points DESC) AS pct
      FROM spending_totals
    )
    INSERT INTO spender_status (user_id, arena_session_id, is_top_spender)
    SELECT user_id, $1, (pct <= $2) FROM ranked
    ON CONFLICT (user_id, arena_session_id)
    DO UPDATE SET is_top_spender = EXCLUDED.is_top_spender
  `, [arenaSessionId, SPENDER_TOP_PERCENTILE]);
}

async function getSpenderStatus({ userId, arenaSessionId }, { db }) {
  const row = await db.query(`
    SELECT is_top_spender FROM spender_status
    WHERE user_id = $1 AND arena_session_id = $2
  `, [userId, arenaSessionId]);
  return { isTopSpender: row ? row.is_top_spender : false };
}


// ------------------------------------------------------------
// A) MOTORE FISICO — Squad via QR
// ------------------------------------------------------------
async function joinSquad({ connectorId, memberId, arenaSessionId, tableQrCode, wantsToBeConnector }, { db }) {
  if (connectorId === memberId) return { success: false, reason: 'cannot_join_own_squad' };

  // Se questo tavolo ha già una squadra (qualcuno l'ha scansionato
  // prima), riusiamo il suo connector_id — così ogni nuovo arrivato
  // al tavolo eredita lo stesso collegamento, senza doverlo ridecidere.
  let resolvedConnectorId = connectorId;
  if (tableQrCode && resolvedConnectorId === undefined) {
    const existing = await db.query(`
      SELECT connector_id FROM squad_memberships
      WHERE arena_session_id = $1 AND table_qr_code = $2
      LIMIT 1
    `, [arenaSessionId, tableQrCode]);

    if (existing) {
      // Tavolo già esistente: si eredita la scelta già fatta da chi
      // ha aperto la sessione, nessuna nuova domanda per chi arriva dopo.
      resolvedConnectorId = existing.connector_id;
    } else if (wantsToBeConnector) {
      // Primo arrivo a questo tavolo, e ha risposto "sì" alla domanda
      // "vuoi essere il Top Connector di questo gruppo?" — non serve
      // essere GIÀ Top Connector: lo status vero (badge, voto x1.5)
      // arriva più tardi se i punti accumulati bastano, questo è solo
      // il momento in cui SCEGLIE di provarci.
      resolvedConnectorId = memberId;
    }
  }

  await db.query(`
    INSERT INTO squad_memberships (connector_id, member_id, arena_session_id, table_qr_code)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (member_id, arena_session_id) DO NOTHING
  `, [resolvedConnectorId || null, memberId, arenaSessionId, tableQrCode || null]);

  return { success: true, linkedToConnector: !!resolvedConnectorId };
}

/**
 * Va chiamata OGNI VOLTA che un membro di una squad guadagna punti
 * (like/superlike/pulse ricevuti, spesa) — riflette una quota al
 * Connector della sua squad, se ne ha una per questa sessione.
 */
async function reflectPointsToConnector({ memberId, arenaSessionId, memberPointsEarned }, { db, io }) {
  const membership = await db.query(`
    SELECT connector_id FROM squad_memberships
    WHERE member_id = $1 AND arena_session_id = $2
  `, [memberId, arenaSessionId]);

  if (!membership) return { reflected: false };

  const reflectedPoints = Math.round(memberPointsEarned * SQUAD_REFLECTION_SHARE);
  if (reflectedPoints <= 0) return { reflected: false };

  await db.query(`
    INSERT INTO points_ledger (user_id, arena_session_id, points, source)
    VALUES ($1, $2, $3, 'squad_reflection')
  `, [membership.connector_id, arenaSessionId, reflectedPoints]);

  await updateContributionPoints({ userId: membership.connector_id, arenaSessionId, delta: reflectedPoints }, { db });

  io.to(`arena_${arenaSessionId}`).emit('points_update', {
    userId: membership.connector_id,
    points: reflectedPoints,
    source: 'squad_reflection',
  });

  return { reflected: true, reflectedPoints };
}


// ------------------------------------------------------------
// B) MOTORE ALGORITMICO — scoperta predittiva
// ------------------------------------------------------------
/**
 * Chiamata quando un utente con status Connector (per questa
 * sessione) invia un like/Pulse a qualcuno — piazza il "marker".
 * La valutazione vera avviene più tardi, nel job schedulato.
 */
async function placeDiscoveryMarker({ connectorId, discoveredUserId, arenaSessionId }, { db }) {
  const status = await getConnectorStatus({ userId: connectorId, arenaSessionId }, { db });
  if (!status.isTopConnector) return { placed: false, reason: 'not_a_connector_this_session' };

  const currentPoints = await getLocalPoints({ userId: discoveredUserId, arenaSessionId }, { db });

  await db.query(`
    INSERT INTO connector_discovery_markers
      (connector_id, discovered_user_id, arena_session_id, points_at_vote_time)
    VALUES ($1, $2, $3, $4)
  `, [connectorId, discoveredUserId, arenaSessionId, currentPoints]);

  return { placed: true };
}

/**
 * IL JOB SCHEDULATO — va eseguito periodicamente (es. ogni 15
 * minuti) da un worker separato, non dentro una richiesta HTTP.
 * Controlla tutti i marker più vecchi della finestra di tempo e
 * non ancora valutati, assegna il bonus se il profilo è "esploso".
 */
async function evaluatePendingDiscoveryMarkers({ db, io }) {
  const cutoff = new Date(Date.now() - DISCOVERY_WINDOW_HOURS * 60 * 60 * 1000);

  const pendingMarkers = await db.queryAll(`
    SELECT * FROM connector_discovery_markers
    WHERE evaluated_at IS NULL AND created_at <= $1
  `, [cutoff]);

  for (const marker of pendingMarkers) {
    const currentPoints = await getLocalPoints(
      { userId: marker.discovered_user_id, arenaSessionId: marker.arena_session_id }, { db }
    );
    const surge = currentPoints - marker.points_at_vote_time;
    const didSurge = surge >= DISCOVERY_SURGE_THRESHOLD;

    if (didSurge) {
      await awardPoints({
        receiverId: marker.connector_id,
        arenaSessionId: marker.arena_session_id,
        source: 'connector_discovery_bonus',
      }, { db, io });
      // NOTA: awardPoints usa BASE_POINTS per source — per un valore
      // dedicato, aggiungere la relativa voce a BASE_POINTS nel
      // motore punti invece di duplicare qui la scrittura sul ledger.
    }

    await db.query(`
      UPDATE connector_discovery_markers
      SET evaluated_at = now(), bonus_awarded = $1
      WHERE id = $2
    `, [didSurge, marker.id]);
  }

  return { evaluated: pendingMarkers.length };
}


// ------------------------------------------------------------
// STATO CONNECTOR — sempre per singola sessione, mai permanente
// ------------------------------------------------------------
async function updateContributionPoints({ userId, arenaSessionId, delta }, { db }) {
  await db.query(`
    INSERT INTO connector_status (user_id, arena_session_id, contribution_points)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, arena_session_id)
    DO UPDATE SET contribution_points = connector_status.contribution_points + $3
  `, [userId, arenaSessionId, delta]);

  await recalculateTopConnectors(arenaSessionId, { db });
}

/**
 * Ricalcola chi è "Top Connector" in QUESTA sessione (top 5% per
 * Punti Contribuzione) — si azzera e si ricalcola da zero ogni
 * sera, mai un badge che si porta dietro da una serata all'altra.
 */
async function recalculateTopConnectors(arenaSessionId, { db }) {
  await db.query(`
    WITH ranked AS (
      SELECT id, PERCENT_RANK() OVER (ORDER BY contribution_points DESC) AS pct
      FROM connector_status
      WHERE arena_session_id = $1
    )
    UPDATE connector_status
    SET is_top_connector = (ranked.pct <= $2)
    FROM ranked
    WHERE connector_status.id = ranked.id
  `, [arenaSessionId, CONNECTOR_TOP_PERCENTILE]);
}

async function getConnectorStatus({ userId, arenaSessionId }, { db }) {
  const row = await db.query(`
    SELECT contribution_points, is_top_connector FROM connector_status
    WHERE user_id = $1 AND arena_session_id = $2
  `, [userId, arenaSessionId]);
  return row
    ? { contributionPoints: row.contribution_points, isTopConnector: row.is_top_connector }
    : { contributionPoints: 0, isTopConnector: false };
}

async function getLocalPoints({ userId, arenaSessionId }, { db }) {
  const row = await db.query(`
    SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger
    WHERE user_id = $1 AND arena_session_id = $2 AND counts_toward_local = true
  `, [userId, arenaSessionId]);
  return row.total || 0;
}

module.exports = {
  joinSquad,
  reflectPointsToConnector,
  placeDiscoveryMarker,
  evaluatePendingDiscoveryMarkers,
  getConnectorStatus,
  getSpenderStatus,
  awardTableSpendingBonus,
};

/**
 * ============================================================
 * BONUS SPESA AL TAVOLO — soglia fissa, mai proporzionale
 * ============================================================
 * Va chiamata quando arriva la conferma di una spesa per un tavolo
 * (via PR/Concierge in fase pilota, via webhook Stripe quando la
 * fintech sarà attiva — il canale non cambia questa funzione).
 *
 * La soglia e il bonus NON sono valori passati da fuori: si leggono
 * sempre dalla configurazione del locale (venues.spending_threshold_cents
 * / spending_bonus_points), personalizzabile per singolo locale dalla
 * dashboard — mai un valore fisso uguale per tutti i locali.
 */
async function awardTableSpendingBonus({ arenaSessionId, tableQrCode, venueId, spentCents }, { db, io }) {
  const venue = await db.query(`
    SELECT spending_threshold_cents, spending_bonus_points FROM venues WHERE id = $1
  `, [venueId]);

  if (!venue || !venue.spending_threshold_cents) {
    return { success: false, reason: 'venue_has_no_spending_threshold_configured' };
  }
  if (spentCents < venue.spending_threshold_cents) {
    return { success: false, reason: 'below_threshold', threshold: venue.spending_threshold_cents };
  }

  // Idempotenza: se questo tavolo ha già ricevuto il bonus stasera
  // (es. la spesa viene ri-confermata più volte durante la serata),
  // non lo assegniamo una seconda volta.
  const alreadyAwarded = await db.query(`
    SELECT 1 FROM points_ledger pl
    JOIN squad_memberships sm ON sm.member_id = pl.user_id AND sm.arena_session_id = pl.arena_session_id
    WHERE sm.table_qr_code = $1 AND pl.arena_session_id = $2 AND pl.source = 'table_spending_threshold'
    LIMIT 1
  `, [tableQrCode, arenaSessionId]);
  if (alreadyAwarded) return { success: false, reason: 'already_awarded_tonight' };

  const members = await db.queryAll(`
    SELECT DISTINCT member_id FROM squad_memberships
    WHERE arena_session_id = $1 AND table_qr_code = $2
  `, [arenaSessionId, tableQrCode]);

  if (members.length === 0) return { success: false, reason: 'no_squad_found_for_table' };

  const perPersonPoints = Math.round(venue.spending_bonus_points / members.length);

  for (const member of members) {
    await db.query(`
      INSERT INTO points_ledger (user_id, arena_session_id, points, source)
      VALUES ($1, $2, $3, 'table_spending_threshold')
    `, [member.member_id, arenaSessionId, perPersonPoints]);

    io.to(`arena_${arenaSessionId}`).emit('points_update', {
      userId: member.member_id,
      points: perPersonPoints,
      source: 'table_spending_threshold',
    });
  }

  await recalculateTopSpenders(arenaSessionId, { db });

  return { success: true, membersRewarded: members.length, perPersonPoints };
}
