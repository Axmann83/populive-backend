/**
 * ============================================================
 * POPULIVE — LETTURA CLASSIFICHE (locale e globale)
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

async function getUserRankingSummary({ userId, arenaSessionId, viewerId }, { db }) {
  const profile = await db.query(`SELECT display_name, photo_url, avatar_emoji FROM users WHERE id = $1`, [userId]);
  const displayName = profile?.display_name || null;
  const photoUrl = profile?.photo_url || null;
  const avatarEmoji = profile?.avatar_emoji || '🙂';

  if (viewerId && viewerId !== userId) {
    const prefs = await db.query(`SELECT show_ranking_on_profile FROM users WHERE id = $1`, [userId]);
    if (prefs && prefs.show_ranking_on_profile === false) {
      return { hidden: true, localRank: null, localPoints: null, globalRank: null, globalPoints: null, displayName, photoUrl, avatarEmoji };
    }
  }

  const hasValidSession = arenaSessionId && arenaSessionId.length > 0;

  let localPoints = 0;
  let localRankRow = { rank: null };
  if (hasValidSession) {
    const localPointsRow = await db.query(`
      SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger
      WHERE user_id = $1 AND arena_session_id = $2 AND counts_toward_local = true
    `, [userId, arenaSessionId]);
    localPoints = parseInt(localPointsRow.total) || 0;

    localRankRow = await db.query(`
      SELECT COUNT(*) + 1 AS rank
      FROM (
        SELECT user_id, SUM(points) AS pts
        FROM points_ledger
        WHERE arena_session_id = $1 AND counts_toward_local = true
        GROUP BY user_id
        HAVING SUM(points) > $2
      ) higher_ranked
    `, [arenaSessionId, localPoints]);
  }

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
    localRank: hasValidSession && localPoints > 0 ? parseInt(localRankRow.rank) : null,
    localPoints,
    globalRank: globalPoints > 0 ? parseInt(globalRankRow.rank) : null,
    globalPoints,
    displayName,
    photoUrl,
    avatarEmoji,
  };
}

async function getWelcomeBackSummary({ userId }, { db }) {
  const user = await db.query(`SELECT last_seen_at FROM users WHERE id = $1`, [userId]);
  if (!user) return { success: false, reason: 'user_not_found' };

  const since = user.last_seen_at;

  const pointsRow = await db.query(`
    SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger
    WHERE user_id = $1 AND created_at > $2
  `, [userId, since]);
  const pointsEarned = parseInt(pointsRow.total) || 0;

  const newLikes = await db.query(`
    SELECT COUNT(*) FROM interactions
    WHERE receiver_id = $1 AND type = 'like' AND created_at > $2
  `, [userId, since]);

  const newSuperlikes = await db.query(`
    SELECT COUNT(*) FROM interactions
    WHERE receiver_id = $1 AND type = 'superlike' AND created_at > $2
  `, [userId, since]);

  const newRoses = await db.query(`
    SELECT COUNT(*) FROM roses
    WHERE receiver_id = $1 AND created_at > $2
  `, [userId, since]);

  await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);

  const hasNews = pointsEarned > 0 || newLikes > 0 || newSuperlikes > 0 || newRoses > 0;

  return {
    success: true,
    hasNews,
    pointsEarned,
    newLikes: parseInt(newLikes) || 0,
    newSuperlikes: parseInt(newSuperlikes) || 0,
    newRoses: parseInt(newRoses) || 0,
  };
}


module.exports = { getLocalRanking, getGlobalRanking, getUserRankingSummary, getWelcomeBackSummary };
