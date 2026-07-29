/**
 * ============================================================
 * POPULIVE — MOTORE A ORARI (job schedulato)
 * ============================================================
 */

const { closeConversationsForSession, purgeExpiredChatMessages } = require('./populive-chat-logic');
const { evaluatePendingDiscoveryMarkers } = require('./populive-connector-engine');

const TICK_INTERVAL_MS = 5 * 60 * 1000;

async function runSchedulerTick({ db, redis, io }) {
  const venues = await db.queryAll(`SELECT id, default_open_time, default_close_time FROM venues`);

  for (const venue of venues) {
    try {
      await processVenue(venue, { db, redis, io });
    } catch (err) {
      console.error(`[scheduler] errore sul locale ${venue.id}:`, err);
    }
  }

  try {
    await evaluatePendingDiscoveryMarkers({ db, io });
  } catch (err) {
    console.error('[scheduler] errore nella valutazione discovery marker:', err);
  }

  try {
    await purgeExpiredChatMessages({ db });
  } catch (err) {
    console.error('[scheduler] errore nella pulizia messaggi chat scaduti:', err);
  }

  try {
    await grantWeeklyFreeRoses({ db });
  } catch (err) {
    console.error('[scheduler] errore nell\'assegnazione Rose gratis settimanali:', err);
  }

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

async function grantWeeklyFreeRoses({ db }) {
  await db.query(`
    UPDATE users
    SET free_roses_balance = LEAST(free_roses_balance + 1, 2),
        last_free_rose_grant_at = last_free_rose_grant_at + INTERVAL '7 days'
    WHERE last_free_rose_grant_at <= now() - INTERVAL '7 days'
      AND free_roses_balance < 2
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

async function isVenueWithinOpenWindow(venue, { db }) {
  const row = await db.query(`SELECT LOCALTIME AS now_time`, []);
  const nowTime = row.now_time;

  const { default_open_time: open, default_close_time: close } = venue;

  if (close < open) {
    return nowTime >= open || nowTime < close;
  }
  return nowTime >= open && nowTime < close;
}

async function ensureSessionOpen(venue, { db, io }) {
  const dateRow = await db.query(`SELECT current_business_date($1) AS bdate`, [venue.id]);
  const businessDate = dateRow.bdate;

  const existing = await db.query(`
    SELECT id FROM arena_sessions WHERE venue_id = $1 AND session_date = $2
  `, [venue.id, businessDate]);

  if (existing) return;

  await db.query(`
    INSERT INTO arena_sessions (venue_id, session_date, opened_at, is_open_for_checkin, is_active)
    VALUES ($1, $2, now(), true, false)
  `, [venue.id, businessDate]);
}

async function closeSessionIfOpen(venue, { db, redis, io }) {
  const openSession = await db.query(`
    SELECT id FROM arena_sessions
    WHERE venue_id = $1 AND is_open_for_checkin = true AND closed_at IS NULL
    ORDER BY opened_at DESC LIMIT 1
  `, [venue.id]);

  if (!openSession) return;

  await db.query(`
    UPDATE arena_sessions
    SET is_open_for_checkin = false, closed_at = now()
    WHERE id = $1
  `, [openSession.id]);

  await closeConversationsForSession(openSession.id, { db });

  try {
    await redis.del(`arena:${openSession.id}:radar`);
    await redis.del(`arena:${openSession.id}:checkin_count`);
  } catch (err) {
    console.error(`[scheduler] pulizia Redis fallita per sessione ${openSession.id}:`, err);
  }

  io.to(`arena_${openSession.id}`).emit('arena_closed', { arenaSessionId: openSession.id });
}

function startScheduler({ db, redis, io }) {
  runSchedulerTick({ db, redis, io });
  const intervalId = setInterval(() => runSchedulerTick({ db, redis, io }), TICK_INTERVAL_MS);
  return () => clearInterval(intervalId);
}

module.exports = { startScheduler, runSchedulerTick };
