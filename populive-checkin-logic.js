/**
 * ============================================================
 * POPULIVE — LOGICA DI CHECK-IN
 * ============================================================
 * Questa funzione gira sul backend (Node.js) ogni volta che un
 * utente scansiona il QR code di un'Arena. Tocca DUE database
 * con scopi diversi, come deciso nello schema:
 *
 *   - Postgres  → storia permanente (mai persa, mai cancellata)
 *   - Redis     → stato "vivo" della serata (temporaneo, si
 *                 cancella alla chiusura dell'Arena)
 *
 * E infine avvisa in tempo reale tutti i telefoni già collegati
 * a quella stessa Arena via WebSocket.
 * ============================================================
 */

async function handleCheckin({ userId, venueId }, { db, redis, io }) {

  const session = await db.query(`
    SELECT arena_sessions.id, is_open_for_checkin, is_active, checkin_threshold
    FROM arena_sessions
    JOIN venues ON venues.id = arena_sessions.venue_id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date = current_business_date($1)
  `, [venueId]);

  if (!session || !session.is_open_for_checkin) {
    return { success: false, reason: 'venue_closed' };
  }

  const alreadyCheckedIn = await redis.sismember(
    `arena:${session.id}:radar`, userId
  );

  if (alreadyCheckedIn) {
    const currentCount = await redis.get(`arena:${session.id}:checkin_count`) || 0;
    return {
      success: true,
      alreadyIn: true,
      arenaSessionId: session.id,
      arenaActive: session.is_active,
      checkinCount: parseInt(currentCount),
      threshold: session.checkin_threshold,
    };
  }

  await db.query(`
    INSERT INTO checkins (user_id, arena_session_id, checked_in_at)
    VALUES ($1, $2, now())
  `, [userId, session.id]);

  const radarKey = `arena:${session.id}:radar`;
  const countKey = `arena:${session.id}:checkin_count`;
  let newCount;
  let redisOk = true;

  try {
    await redis.sadd(radarKey, userId);
    newCount = await redis.incr(countKey);
  } catch (err) {
    redisOk = false;
    logInternalAlert('redis_unavailable_during_checkin', { venueId, sessionId: session.id, err });
    const fallback = await db.query(`
      SELECT COUNT(*) FROM checkins WHERE arena_session_id = $1
    `, [session.id]);
    newCount = parseInt(fallback.count);
  }

  const justActivated = (newCount === session.checkin_threshold) && !session.is_active;

  if (justActivated) {
    await db.query(`
      UPDATE arena_sessions
      SET is_active = true, activated_at = now()
      WHERE id = $1
    `, [session.id]);
  }

  const room = `arena_${session.id}`;
  try {
    if (justActivated) {
      io.to(room).emit('arena_activated', {
        message: 'La classifica di stanotte è appena partita!',
      });
    }
    io.to(room).emit('radar_update', {
      type: 'new_checkin',
      userId,
      checkinCount: newCount,
      threshold: session.checkin_threshold,
    });
  } catch (err) {
    logInternalAlert('websocket_broadcast_failed', { venueId, sessionId: session.id, err });
  }

  return {
    success: true,
    alreadyIn: false,
    degraded: !redisOk,
    arenaSessionId: session.id,
    arenaActive: session.is_active || justActivated,
    checkinCount: newCount,
    threshold: session.checkin_threshold,
  };
}

module.exports = { handleCheckin };


function logInternalAlert(type, context) {
  console.error(`[ALERT] ${type}`, context);
}
