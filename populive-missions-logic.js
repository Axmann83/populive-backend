/**
 * ============================================================
 * POPULIVE — MISSIONI SPONSORIZZATE
 * ============================================================
 * Create dagli Architetti, ora DIRETTAMENTE dalla dashboard (prima
 * si andava a mano su Supabase + uno strumento HTML separato per
 * il QR — integrati qui, stesso principio di sempre: un servizio
 * a pagamento diretto, mai un pannello per i locali stessi). Questo
 * file gestisce sia la creazione sia il lato "consumo": la persona
 * scansiona il QR stampato e messo dal negozio sponsor, l'app
 * registra il completamento e assegna i punti.
 *
 * Per ORA basta la presenza (il QR stesso è già la prova — puoi
 * scansionarlo solo se sei fisicamente lì). Punti bonus legati a
 * una spesa minima sono un'estensione futura, non ancora costruita.
 *
 * I punti guadagnati sono SEMPRE globali, mai locali — una missione
 * non è legata a un'Arena/serata specifica come il resto del
 * gioco, quindi non ha senso farla contare per la classifica di
 * stanotte di un locale che magari non c'entra nulla.
 * ============================================================
 */

/**
 * Crea una nuova missione sponsorizzata — chiamata dalla dashboard,
 * mai da un locale o da un utente normale.
 */
async function createMission({ sponsorName, venueId, claimText, bonusPoints, radiusMeters, hashtagFilter, dateFrom, dateTo }, { db }) {
  if (!sponsorName || !venueId || !claimText || !bonusPoints || !dateFrom || !dateTo) {
    return { success: false, reason: 'missing_fields' };
  }

  const mission = await db.query(`
    INSERT INTO sponsored_missions (sponsor_name, venue_id, claim_text, bonus_points, radius_meters, hashtag_filter, date_from, date_to, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
    RETURNING id
  `, [
    sponsorName, venueId, claimText, bonusPoints,
    radiusMeters || 2000,
    hashtagFilter && hashtagFilter.length > 0 ? hashtagFilter : null,
    dateFrom, dateTo,
  ]);

  return { success: true, missionId: mission.id };
}

/**
 * Tutte le missioni esistenti, con il nome del locale sponsor già
 * unito — per la lista nella dashboard (creare + rivedere il QR
 * di una già esistente, senza dover tornare su Supabase).
 */
async function getAllMissions({}, { db }) {
  const missions = await db.queryAll(`
    SELECT sm.id, sm.sponsor_name, sm.claim_text, sm.bonus_points, sm.is_active,
           sm.date_from, sm.date_to, sm.created_at, v.name AS venue_name
    FROM sponsored_missions sm
    JOIN venues v ON v.id = sm.venue_id
    ORDER BY sm.created_at DESC
  `);

  return missions.map((m) => ({
    missionId: m.id,
    sponsorName: m.sponsor_name,
    venueName: m.venue_name,
    claimText: m.claim_text,
    bonusPoints: m.bonus_points,
    isActive: m.is_active,
    dateFrom: m.date_from,
    dateTo: m.date_to,
  }));
}

async function completeMission({ missionId, userId }, { db, io }) {
  const mission = await db.query(`
    SELECT id, sponsor_name, claim_text, bonus_points, is_active, date_from, date_to
    FROM sponsored_missions WHERE id = $1
  `, [missionId]);

  if (!mission) return { success: false, reason: 'mission_not_found' };
  if (!mission.is_active) return { success: false, reason: 'mission_inactive' };

  const now = new Date();
  if (now < new Date(mission.date_from) || now > new Date(mission.date_to)) {
    return { success: false, reason: 'mission_not_in_window' };
  }

  const already = await db.query(`
    SELECT 1 FROM mission_completions WHERE mission_id = $1 AND user_id = $2
  `, [missionId, userId]);
  if (already) return { success: false, reason: 'already_completed' };

  await db.query(`
    INSERT INTO mission_completions (mission_id, user_id) VALUES ($1, $2)
  `, [missionId, userId]);

  await db.query(`
    INSERT INTO points_ledger (user_id, arena_session_id, points, source, counts_toward_local)
    VALUES ($1, NULL, $2, 'mission_completed', false)
  `, [userId, mission.bonus_points]);

  io.to(`user_${userId}`).emit('points_update', {
    userId, points: mission.bonus_points, source: 'mission_completed',
  });

  return {
    success: true,
    bonusPoints: mission.bonus_points,
    sponsorName: mission.sponsor_name,
    claimText: mission.claim_text,
  };
}

/**
 * Dettagli pubblici di una missione — usata per mostrare il claim
 * ("recati da X per Y punti") PRIMA che la persona confermi,
 * scansionando il QR ma senza aver ancora completato nulla.
 */
async function getMissionPreview({ missionId }, { db }) {
  const mission = await db.query(`
    SELECT id, sponsor_name, claim_text, bonus_points, is_active, date_from, date_to
    FROM sponsored_missions WHERE id = $1
  `, [missionId]);

  if (!mission) return { success: false, reason: 'mission_not_found' };

  return {
    success: true,
    mission: {
      missionId: mission.id,
      sponsorName: mission.sponsor_name,
      claimText: mission.claim_text,
      bonusPoints: mission.bonus_points,
      isActive: mission.is_active,
      dateFrom: mission.date_from,
      dateTo: mission.date_to,
    },
  };
}

/**
 * Missioni attive VICINO a una persona — la parte di "scoperta"
 * che sostituisce la notifica push (impossibile su iPhone in
 * Europa): una lista dentro l'app, non un avviso che arriva da
 * solo. Usa l'ULTIMA posizione nota della persona (registrata solo
 * quando ha attivato il consenso "Ricevi missioni sponsorizzate" —
 * potrebbe non essere aggiornatissima, non un GPS continuo, coerente
 * con la scelta di non chiedere il permesso più spesso del dovuto).
 * Se non ha mai attivato il consenso o non ha una posizione nota,
 * la lista è semplicemente vuota — mai un errore.
 */
async function getMissionsNearUser({ userId }, { db }) {
  const user = await db.query(`
    SELECT last_latitude, last_longitude, sponsored_missions_enabled
    FROM users WHERE id = $1
  `, [userId]);

  if (!user || !user.sponsored_missions_enabled || user.last_latitude === null || user.last_longitude === null) {
    return { success: true, missions: [] };
  }

  const missions = await db.queryAll(`
    WITH candidates AS (
      SELECT sm.id, sm.sponsor_name, sm.claim_text, sm.bonus_points, sm.radius_meters, v.name AS venue_name,
        6371000 * acos(LEAST(1, GREATEST(-1,
          cos(radians($1)) * cos(radians(v.latitude)) * cos(radians(v.longitude) - radians($2)) +
          sin(radians($1)) * sin(radians(v.latitude))
        ))) AS distance_meters
      FROM sponsored_missions sm
      JOIN venues v ON v.id = sm.venue_id
      WHERE sm.is_active = true
        AND now() BETWEEN sm.date_from AND sm.date_to
        AND NOT EXISTS (
          SELECT 1 FROM mission_completions mc WHERE mc.mission_id = sm.id AND mc.user_id = $3
        )
        AND (
          sm.hashtag_filter IS NULL
          OR EXISTS (
            SELECT 1 FROM user_hashtags uh
            JOIN hashtags h ON h.id = uh.hashtag_id
            WHERE uh.user_id = $3 AND h.name = ANY(sm.hashtag_filter)
          )
        )
    )
    SELECT * FROM candidates
    WHERE distance_meters <= radius_meters
    ORDER BY distance_meters ASC
  `, [user.last_latitude, user.last_longitude, userId]);

  return {
    success: true,
    missions: missions.map((m) => ({
      missionId: m.id,
      sponsorName: m.sponsor_name,
      venueName: m.venue_name,
      claimText: m.claim_text,
      bonusPoints: m.bonus_points,
      distanceMeters: Math.round(m.distance_meters),
    })),
  };
}

module.exports = { createMission, getAllMissions, getMissionsNearUser, completeMission, getMissionPreview };
