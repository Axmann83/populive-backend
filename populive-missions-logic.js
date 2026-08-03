/**
 * ============================================================
 * POPULIVE — MISSIONI SPONSORIZZATE
 * ============================================================
 * Create SOLO dai founder, a mano via Supabase — nessun pannello
 * di creazione nell'app (stesso principio già usato per Instant
 * Influencer). Questo file gestisce il lato "consumo": la persona
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

module.exports = { completeMission, getMissionPreview };
