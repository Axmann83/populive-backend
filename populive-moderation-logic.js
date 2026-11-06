const { blockBothDirectionsPermanently } = require('./populive-interactions-logic');
const { announceCheckout } = require('./populive-checkin-logic');
const { notifyUser } = require('./populive-push');

/**
 * ============================================================
 * POPULIVE — SEGNALAZIONI, BLOCCO, SOSPENSIONE (B2, novembre 2026)
 * ============================================================
 * Regola 1.2 di Apple per le app con contenuti degli utenti: chi usa
 * l'app deve poter segnalare un profilo, una foto o una chat e
 * bloccare una persona; chi gestisce l'app deve agire sulle
 * segnalazioni (Apple indica 24 ore). Decisioni dell'utente (D-B2,
 * 1/11): tre motivi più un testo facoltativo; le controllano gli
 * Architetti dalla dashboard; "sospendi" impedisce l'accesso; il
 * blocco nasconde la chat a chi blocca e ferma i nuovi messaggi.
 *
 * Il blocco riusa quello che c'era già dal "Blocca" della chat
 * (22/8): righe 'user_blocked' nelle due direzioni nella tabella
 * blocks, che tutti gli invii (Like, Superlike, Pulse, visite) e il
 * radar (blocked-pairs) controllano già. In più user_blocks ricorda
 * CHI ha bloccato chi, per l'elenco nelle Impostazioni e per
 * sbloccare (migrazione 008).
 * ============================================================
 */

const REPORT_REASONS = ['adult_content', 'harassment', 'fake_or_spam'];
const REPORT_CONTEXTS = ['profile', 'photo', 'chat'];
const MAX_DETAILS_LENGTH = 1000;
const CHAT_SNAPSHOT_MESSAGES = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

// ------------------------------------------------------------
// BLOCCO
// ------------------------------------------------------------

/**
 * Blocca una persona, da qualunque punto (profilo, chat). Le due
 * persone non si vedono più (radar, classifiche, Bacheca Storica,
 * profilo), non possono più mandarsi niente, e le chat aperte tra
 * loro si chiudono — una chat chiusa sparisce dall'elenco di
 * entrambi e non accetta nuovi messaggi.
 */
async function blockUser({ blockerId, blockedId }, { db, io }) {
  if (!isUuid(blockedId)) return { success: false, reason: 'invalid_user' };
  if (blockerId === blockedId) return { success: false, reason: 'cannot_block_self' };

  const target = await db.query(`SELECT id FROM users WHERE id = $1`, [blockedId]);
  if (!target) return { success: false, reason: 'user_not_found' };

  await db.query(
    `
    INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING
  `,
    [blockerId, blockedId]
  );
  await blockBothDirectionsPermanently({ userAId: blockerId, userBId: blockedId, reason: 'user_blocked' }, { db });

  const closed = await db.queryAll(
    `
    UPDATE chat_conversations SET closed_at = now()
    WHERE closed_at IS NULL
      AND ((user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1))
    RETURNING id
  `,
    [blockerId, blockedId]
  );

  // Alla persona bloccata non si dice MAI "sei stato bloccato" (stesso
  // principio del rifiuto): la chat si chiude come a fine serata e
  // l'altra persona sparisce in silenzio dal suo radar e dalla
  // classifica (pair_hidden, senza nessun messaggio a schermo). A chi
  // blocca arrivano gli stessi eventi, per gli altri suoi dispositivi.
  for (const { id: conversationId } of closed) {
    io.to(`user_${blockedId}`).emit('chat_closed', { conversationId, reason: 'blocked' });
    io.to(`user_${blockerId}`).emit('chat_closed', { conversationId, reason: 'blocked' });
  }
  io.to(`user_${blockedId}`).emit('pair_hidden', { userId: blockerId });
  io.to(`user_${blockerId}`).emit('pair_hidden', { userId: blockedId });

  return { success: true, closedConversationIds: closed.map((c) => c.id) };
}

// Il "Blocca" dentro una chat: stessa cosa, la persona è l'altra
// della conversazione.
async function blockUserInConversation({ conversationId, blockerId }, { db, io }) {
  if (!isUuid(conversationId)) return { success: false, reason: 'conversation_not_found' };
  const conv = await db.query(`SELECT user_a_id, user_b_id FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== blockerId && conv.user_b_id !== blockerId) {
    return { success: false, reason: 'not_a_participant' };
  }
  const blockedId = conv.user_a_id === blockerId ? conv.user_b_id : conv.user_a_id;
  return blockUser({ blockerId, blockedId }, { db, io });
}

/**
 * Sblocca (dalle Impostazioni). Le due persone tornano a potersi
 * vedere e contattare; le chat chiuse dal blocco non si riaprono.
 * Le righe 'user_blocked' di blocks si tolgono solo se non resta un
 * blocco anche nell'altra direzione; un rifiuto esplicito (motivo
 * 'rejection', che il blocco non sovrascrive mai) resta com'era.
 */
async function unblockUser({ blockerId, blockedId }, { db }) {
  if (!isUuid(blockedId)) return { success: false, reason: 'invalid_user' };

  const removed = await db.query(
    `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING blocked_id`,
    [blockerId, blockedId]
  );
  if (!removed) return { success: true, notBlocked: true };

  const reverse = await db.query(`SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
    blockedId,
    blockerId,
  ]);
  if (!reverse) {
    await db.query(
      `
      DELETE FROM blocks
      WHERE reason = 'user_blocked'
        AND ((blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1))
    `,
      [blockerId, blockedId]
    );
  }
  return { success: true };
}

// Persone bloccate da me (elenco delle Impostazioni, per sbloccare).
async function getBlockedUsers({ userId }, { db }) {
  const rows = await db.queryAll(
    `
    SELECT u.id, u.display_name, u.photo_url, u.avatar_emoji, ub.created_at
    FROM user_blocks ub
    JOIN users u ON u.id = ub.blocked_id
    WHERE ub.blocker_id = $1
    ORDER BY ub.created_at DESC
  `,
    [userId]
  );
  return rows.map((r) => ({
    userId: r.id,
    displayName: r.display_name,
    photoUrl: r.photo_url,
    avatarEmoji: r.avatar_emoji || '🙂',
    blockedAt: r.created_at,
  }));
}

// Chi ha un blocco manuale con me, in una qualunque direzione: le
// classifiche (pubbliche, senza accesso) li tolgono nel telefono.
async function getUserBlockPairIds({ userId }, { db }) {
  const rows = await db.queryAll(
    `
    SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1
  `,
    [userId]
  );
  return [...new Set(rows.map((r) => (r.blocker_id === userId ? r.blocked_id : r.blocker_id)))];
}

// ------------------------------------------------------------
// SEGNALAZIONI
// ------------------------------------------------------------

/**
 * Nuova segnalazione. Da una chat basta la conversazione (la persona
 * segnalata è l'altra); da un profilo serve reportedUserId. Si
 * conserva una "fotografia" di cosa c'era (nome e foto del profilo,
 * ultimi messaggi della chat), così chi controlla vede quello che è
 * stato segnalato anche se nel frattempo cambia. Agli Architetti
 * arriva una push.
 */
async function createReport({ reporterId, reportedUserId, context, conversationId, reason, details }, { db }) {
  if (!REPORT_REASONS.includes(reason)) return { success: false, reason: 'invalid_reason' };
  if (!REPORT_CONTEXTS.includes(context)) return { success: false, reason: 'invalid_context' };

  let targetId = reportedUserId;
  let conversation = null;
  if (context === 'chat') {
    if (!isUuid(conversationId)) return { success: false, reason: 'conversation_not_found' };
    conversation = await db.query(`SELECT id, user_a_id, user_b_id FROM chat_conversations WHERE id = $1`, [
      conversationId,
    ]);
    if (!conversation) return { success: false, reason: 'conversation_not_found' };
    if (conversation.user_a_id !== reporterId && conversation.user_b_id !== reporterId) {
      return { success: false, reason: 'not_a_participant' };
    }
    targetId = conversation.user_a_id === reporterId ? conversation.user_b_id : conversation.user_a_id;
  }

  if (!isUuid(targetId)) return { success: false, reason: 'invalid_user' };
  if (targetId === reporterId) return { success: false, reason: 'cannot_report_self' };

  const target = await db.query(
    `SELECT display_name, photo_url, photo_urls, avatar_emoji, bio FROM users WHERE id = $1`,
    [targetId]
  );
  if (!target) return { success: false, reason: 'user_not_found' };

  // Una sola segnalazione aperta per persona, motivo e punto: chi
  // tocca due volte non crea doppioni nella dashboard (si aggiorna il
  // testo, se ne ha aggiunto uno).
  const cleanDetails = typeof details === 'string' ? details.trim().slice(0, MAX_DETAILS_LENGTH) || null : null;
  const existing = await db.query(
    `
    SELECT id FROM user_reports
    WHERE reporter_id = $1 AND reported_user_id = $2 AND reason = $3 AND context = $4 AND status = 'open'
  `,
    [reporterId, targetId, reason, context]
  );
  if (existing) {
    if (cleanDetails) {
      await db.query(`UPDATE user_reports SET details = $2 WHERE id = $1`, [existing.id, cleanDetails]);
    }
    return { success: true, reportId: existing.id, alreadyReported: true };
  }

  const snapshot = {
    displayName: target.display_name,
    photoUrls: target.photo_urls?.length ? target.photo_urls : target.photo_url ? [target.photo_url] : [],
    avatarEmoji: target.avatar_emoji,
    bio: target.bio,
  };
  if (conversation) {
    const messages = await db.queryAll(
      `
      SELECT sender_id, body, created_at FROM (
        SELECT sender_id, body, created_at FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      ) last_messages
      ORDER BY created_at ASC
    `,
      [conversation.id, CHAT_SNAPSHOT_MESSAGES]
    );
    snapshot.messages = messages.map((m) => ({
      fromReported: m.sender_id === targetId,
      body: m.body,
      sentAt: m.created_at,
    }));
  }

  const report = await db.query(
    `
    INSERT INTO user_reports (reporter_id, reported_user_id, context, conversation_id, reason, details, snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `,
    [reporterId, targetId, context, conversation?.id || null, reason, cleanDetails, JSON.stringify(snapshot)]
  );

  const architects = await db.queryAll(`SELECT user_id FROM architects`);
  for (const { user_id: architectId } of architects) {
    if (architectId !== reporterId) notifyUser({ userId: architectId, event: 'report' }, { db });
  }

  return { success: true, reportId: report.id };
}

// ------------------------------------------------------------
// DASHBOARD DEGLI ARCHITETTI
// ------------------------------------------------------------

/**
 * Elenco per la dashboard: le aperte (le più vecchie prima, sono le
 * più urgenti) o le già decise (le più recenti prima). Per ogni
 * segnalazione: chi segnala, chi è segnalato (con le foto di adesso,
 * se è sospeso, quante segnalazioni ha in tutto) e la fotografia del
 * momento della segnalazione.
 */
async function listReports({ status = 'open' }, { db }) {
  const open = status === 'open';
  const rows = await db.queryAll(
    `
    SELECT r.id, r.context, r.reason, r.details, r.snapshot, r.status, r.created_at, r.reviewed_at,
           r.reporter_id, reporter.display_name AS reporter_name,
           r.reported_user_id, reported.display_name AS reported_name, reported.photo_url AS reported_photo_url,
           reported.photo_urls AS reported_photo_urls, reported.avatar_emoji AS reported_avatar_emoji,
           reported.suspended_at AS reported_suspended_at, reported.deleted_at AS reported_deleted_at,
           reviewer.display_name AS reviewer_name,
           (SELECT count(*) FROM user_reports all_reports WHERE all_reports.reported_user_id = r.reported_user_id)
             AS reported_total_reports
    FROM user_reports r
    JOIN users reporter ON reporter.id = r.reporter_id
    JOIN users reported ON reported.id = r.reported_user_id
    LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
    WHERE (r.status = 'open') = $1
    ORDER BY CASE WHEN $1 THEN r.created_at END ASC, r.reviewed_at DESC NULLS LAST
    LIMIT 200
  `,
    [open]
  );
  const openCountRow = await db.query(`SELECT count(*) AS open_count FROM user_reports WHERE status = 'open'`);

  return {
    success: true,
    openCount: Number(openCountRow?.open_count || 0),
    reports: rows.map((r) => ({
      id: r.id,
      context: r.context,
      reason: r.reason,
      details: r.details,
      snapshot: r.snapshot,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
      reviewerName: r.reviewer_name,
      reporter: { userId: r.reporter_id, displayName: r.reporter_name },
      reported: {
        userId: r.reported_user_id,
        displayName: r.reported_name,
        photoUrls: r.reported_photo_urls?.length
          ? r.reported_photo_urls
          : r.reported_photo_url
            ? [r.reported_photo_url]
            : [],
        avatarEmoji: r.reported_avatar_emoji,
        suspended: !!r.reported_suspended_at,
        deleted: !!r.reported_deleted_at,
        totalReports: Number(r.reported_total_reports),
      },
    })),
  };
}

/**
 * Decisione su una segnalazione: "dismiss" = archiviata (nessuna
 * violazione), "suspend" = violazione confermata, account sospeso.
 * Sospendere chiude anche tutte le altre segnalazioni aperte sulla
 * stessa persona, che non hanno più niente da decidere.
 */
async function resolveReport({ reportId, architectId, action }, { db, io }) {
  if (!isUuid(reportId)) return { success: false, reason: 'report_not_found' };
  if (!['dismiss', 'suspend'].includes(action)) return { success: false, reason: 'invalid_action' };

  const report = await db.query(`SELECT id, reported_user_id, status FROM user_reports WHERE id = $1`, [reportId]);
  if (!report) return { success: false, reason: 'report_not_found' };
  if (report.status !== 'open') return { success: false, reason: 'already_resolved' };

  if (action === 'dismiss') {
    await db.query(
      `UPDATE user_reports SET status = 'dismissed', reviewed_at = now(), reviewed_by = $2 WHERE id = $1`,
      [reportId, architectId]
    );
    return { success: true };
  }

  const suspended = await suspendUser({ userId: report.reported_user_id, architectId }, { db, io });
  if (!suspended.success) return suspended;
  await db.query(
    `
    UPDATE user_reports SET status = 'reviewed', reviewed_at = now(), reviewed_by = $2
    WHERE reported_user_id = $1 AND status = 'open'
  `,
    [report.reported_user_id, architectId]
  );
  return { success: true };
}

/**
 * Sospensione: l'account non può più entrare (verifyOtp) né usare
 * l'app (requireOnboarded e gli altri controlli d'accesso), sparisce
 * da classifiche, Bacheca Storica e profili, ed esce dalla serata in
 * cui si trova (gli altri lo vedono uscire dal radar). Il telefono
 * riceve 'account_suspended' e torna al login. Un Architetto non si
 * può sospendere da qui (per non chiudere fuori dalla dashboard chi
 * la gestisce).
 */
async function suspendUser({ userId, architectId }, { db, io }) {
  const isArchitect = await db.query(`SELECT 1 FROM architects WHERE user_id = $1`, [userId]);
  if (isArchitect) return { success: false, reason: 'cannot_suspend_architect' };

  await db.query(`UPDATE users SET suspended_at = COALESCE(suspended_at, now()), suspended_by = $2 WHERE id = $1`, [
    userId,
    architectId,
  ]);

  const closedCheckins = await db.queryAll(
    `
    UPDATE checkins
    SET checked_out_at = COALESCE(checked_out_at, now()), checked_out_reason = 'suspended'
    WHERE user_id = $1 AND checked_out_reason IS NULL
    RETURNING arena_session_id
  `,
    [userId]
  );
  for (const { arena_session_id: arenaSessionId } of closedCheckins) {
    await announceCheckout({ userId, arenaSessionId, reason: 'suspended', notifySelf: true }, { db, io });
  }

  // Niente più push sul telefono di un account sospeso.
  await db.query(`DELETE FROM push_tokens WHERE user_id = $1`, [userId]);
  io.to(`user_${userId}`).emit('account_suspended', {});
  return { success: true };
}

async function unsuspendUser({ userId }, { db }) {
  if (!isUuid(userId)) return { success: false, reason: 'invalid_user' };
  await db.query(`UPDATE users SET suspended_at = NULL, suspended_by = NULL WHERE id = $1`, [userId]);
  return { success: true };
}

module.exports = {
  REPORT_REASONS,
  blockUser,
  blockUserInConversation,
  unblockUser,
  getBlockedUsers,
  getUserBlockPairIds,
  createReport,
  listReports,
  resolveReport,
  suspendUser,
  unsuspendUser,
};
