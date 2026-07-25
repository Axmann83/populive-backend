/**
 * ============================================================
 * POPULIVE — LETTURA CLASSIFICHE (locale e globale)
 * ============================================================
 * Finora avevamo scritto solo la logica che GENERA punti
 * (points_ledger). Qui li leggiamo aggregati, in due modi:
 *   - Locale: somma filtrata per una singola arena_session
 *   - Globale: somma di TUTTA la storia di un utente
 * Nessuna tabella "classifica" separata da mantenere sincronizzata:
 * entrambe le viste derivano dalla stessa tabella points_ledger,
 * quindi non possono mai andare "fuori sincrono" tra loro.
 * ============================================================
 */

async function getLocalRanking({ arenaSessionId }, { db }) {
  const rows = await db.queryAll(`
    SELECT
      u.id AS user_id,
      u.display_name,
      u.avatar_emoji,
      u.photo_url,
      COALESCE(SUM(pl.points), 0) AS local_points,
      cs.is_top_connector,
      ss.is_top_spender
    FROM users u
    LEFT JOIN points_ledger pl
      ON pl.user_id = u.id
      AND pl.arena_session_id = $1
      AND pl.counts_toward_local = true
    LEFT JOIN connector_status cs
      ON cs.user_id = u.id AND cs.arena_session_id = $1
    LEFT JOIN spender_status ss
      ON ss.user_id = u.id AND ss.arena_session_id = $1
    JOIN checkins c
      ON c.user_id = u.id AND c.arena_session_id = $1
    GROUP BY u.id, u.display_name, u.avatar_emoji, u.photo_url, cs.is_top_connector, ss.is_top_spender
    ORDER BY local_points DESC
  `, [arenaSessionId]);

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    displayName: r.display_name,
    avatarEmoji: r.avatar_emoji,
    photoUrl: r.photo_url,
    points: parseInt(r.local_points),
    isTopConnector: !!r.is_top_connector,
    isTopSpender: !!r.is_top_spender,
  }));
}

async function getGlobalRanking({ limit = 100 }, { db }) {
  const rows = await db.queryAll(`
    SELECT
      u.id AS user_id,
      u.display_name,
      u.avatar_emoji,
      u.photo_url,
      COALESCE(SUM(pl.points), 0) AS global_points,
      fb.user_id IS NOT NULL AS is_founder
    FROM users u
    LEFT JOIN points_ledger pl ON pl.user_id = u.id
    LEFT JOIN founder_bracelets fb ON fb.user_id = u.id
    GROUP BY u.id, u.display_name, u.avatar_emoji, u.photo_url, fb.user_id
    ORDER BY global_points DESC
    LIMIT $1
  `, [limit]);

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    displayName: r.display_name,
    avatarEmoji: r.avatar_emoji,
    photoUrl: r.photo_url,
    points: parseInt(r.global_points),
    isFounder: r.is_founder,
  }));
}

/**
 * Posizione e punti di UN utente specifico — utile per mostrare
 * "tu sei #4" senza dover scaricare tutta la classifica quando
 * serve solo il proprio piazzamento (es. nella scheda profilo).
 * Usa query mirate (non scansiona l'intera classifica), quindi
 * resta veloce anche con centinaia di migliaia di utenti.
 */
async function getUserRankingSummary({ userId, arenaSessionId, viewerId }, { db }) {
  // Se chi guarda non è il proprietario del profilo, rispettiamo la
  // sua scelta di autopresentazione — se ha disattivato la visibilità,
  // restituiamo un risultato "nascosto" invece dei numeri veri.
  if (viewerId && viewerId !== userId) {
    const prefs = await db.query(`SELECT show_ranking_on_profile FROM users WHERE id = $1`, [userId]);
    if (prefs && prefs.show_ranking_on_profile === false) {
      return { hidden: true, localRank: null, localPoints: null, globalRank: null, globalPoints: null };
    }
  }

  const localPointsRow = await db.query(`
    SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger
    WHERE user_id = $1 AND arena_session_id = $2 AND counts_toward_local = true
  `, [userId, arenaSessionId]);
  const localPoints = parseInt(localPointsRow.total) || 0;

  const localRankRow = await db.query(`
    SELECT COUNT(*) + 1 AS rank
    FROM (
      SELECT user_id, SUM(points) AS pts
      FROM points_ledger
      WHERE arena_session_id = $1 AND counts_toward_local = true
      GROUP BY user_id
      HAVING SUM(points) > $2
    ) higher_ranked
  `, [arenaSessionId, localPoints]);

  const globalPointsRow = await db.query(`
    SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger WHERE user_id = $1
  `, [userId]);
  const globalPoints = parseInt(globalPointsRow.total) || 0;

  const globalRankRow = await db.query(`
    SELECT COUNT(*) + 1 AS rank
    FROM (
      SELECT user_id, SUM(points) AS pts
      FROM points_ledger
      GROUP BY user_id
      HAVING SUM(points) > $1
    ) higher_ranked
  `, [globalPoints]);

  return {
    hidden: false,
    localRank: localPoints > 0 ? parseInt(localRankRow.rank) : null,
    localPoints,
    globalRank: globalPoints > 0 ? parseInt(globalRankRow.rank) : null,
    globalPoints,
  };
}

module.exports = { getLocalRanking, getGlobalRanking, getUserRankingSummary };
