/**
 * ============================================================
 * POPULIVE — VENUE INSIGHTS (report aggregati per i locali)
 * ============================================================
 */

const MIN_SAMPLE_SIZE = 10;


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
}


async function generateVenueReport({ venueId, fromDate, toDate }, { db }) {
  const [arrivals, dwellTime, drinks, attendance] = await Promise.all([
    getArrivalTimeDistribution({ venueId, fromDate, toDate }, { db }),
    getAverageDwellTime({ venueId, fromDate, toDate }, { db }),
    getPopularDrinks({ venueId, fromDate, toDate }, { db }),
    getAttendanceTrend({ venueId, fromDate, toDate }, { db }),
  ]);

  return { arrivals, dwellTime, drinks, attendance, generatedAt: new Date() };
}


async function getPopularVenuesNow({ limit = 10 }, { db }) {
  const rows = await db.queryAll(`
    SELECT
      v.id, v.name, v.category,
      COUNT(c.id) AS checkin_count,
      ars.is_active,
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
      genderStats: sharedTotal > 0 ? {
        sharedTotal,
        malePct: Math.round((male / sharedTotal) * 100),
        femalePct: Math.round((female / sharedTotal) * 100),
        otherPct: Math.round((other / sharedTotal) * 100),
      } : null,
    };
  });
}


module.exports = {
  MIN_SAMPLE_SIZE,
  getArrivalTimeDistribution,
  getAverageDwellTime,
  getPopularDrinks,
  getAttendanceTrend,
  generateVenueReport,
  getPopularVenuesNow,
};
