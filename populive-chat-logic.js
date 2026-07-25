/**
 * ============================================================
 * POPULIVE — CHAT 1-A-1
 * ============================================================
 * Si apre solo dopo uno sblocco (mai spontaneamente), si chiude
 * all'uso a fine sessione. Ogni messaggio è privato — notificato
 * SOLO al destinatario via WebSocket, mai trasmesso alla stanza
 * condivisa dell'Arena.
 * ============================================================
 */

async function openChatConversation({ userAId, userBId, arenaSessionId, unlockedVia }, { db, io }) {
  const [a, b] = [userAId, userBId].sort();

  const existing = await db.query(`
    SELECT id FROM chat_conversations
    WHERE arena_session_id = $1 AND user_a_id = $2 AND user_b_id = $3
  `, [arenaSessionId, a, b]);

  if (existing) return { conversationId: existing.id, alreadyExisted: true };

  const conv = await db.query(`
    INSERT INTO chat_conversations (arena_session_id, user_a_id, user_b_id, unlocked_via)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [arenaSessionId, a, b, unlockedVia]);

  return { conversationId: conv.id, alreadyExisted: false };
}

async function sendMessage({ conversationId, senderId, body }, { db, io }) {
  const conv = await db.query(`SELECT * FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.closed_at) return { success: false, reason: 'conversation_closed' };
  if (conv.user_a_id !== senderId && conv.user_b_id !== senderId) {
    return { success: false, reason: 'not_a_participant' };
  }

  const receiverId = conv.user_a_id === senderId ? conv.user_b_id : conv.user_a_id;

  const blocked = await db.query(`
    SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2
  `, [receiverId, senderId]);
  if (blocked) return { success: false, reason: 'blocked' };

  if (!body || body.trim().length === 0 || body.length > 1000) {
    return { success: false, reason: 'invalid_message' };
  }

  const msg = await db.query(`
    INSERT INTO chat_messages (conversation_id, sender_id, body)
    VALUES ($1, $2, $3)
    RETURNING id, created_at
  `, [conversationId, senderId, body.trim()]);

  io.to(`user_${receiverId}`).emit('chat_message', {
    conversationId,
    messageId: msg.id,
    senderId,
    body: body.trim(),
    createdAt: msg.created_at,
  });

  return { success: true, messageId: msg.id, createdAt: msg.created_at };
}

async function getMessages({ conversationId, requesterId }, { db }) {
  const conv = await db.query(`SELECT * FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== requesterId && conv.user_b_id !== requesterId) {
    return { success: false, reason: 'not_a_participant' };
  }

  const messages = await db.queryAll(`
    SELECT id, sender_id, body, created_at FROM chat_messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC
  `, [conversationId]);

  const myWantsKeep = conv.user_a_id === requesterId ? conv.user_a_wants_keep : conv.user_b_wants_keep;
  const theirWantsKeep = conv.user_a_id === requesterId ? conv.user_b_wants_keep : conv.user_a_wants_keep;

  return {
    success: true,
    messages,
    isClosed: !!conv.closed_at,
    myWantsKeep,
    theirWantsKeep,
  };
}

async function setChatKeepPreference({ conversationId, userId, wantsKeep }, { db, io }) {
  const conv = await db.query(`SELECT * FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    return { success: false, reason: 'not_a_participant' };
  }

  const column = conv.user_a_id === userId ? 'user_a_wants_keep' : 'user_b_wants_keep';
  await db.query(`UPDATE chat_conversations SET ${column} = $1 WHERE id = $2`, [wantsKeep, conversationId]);

  const otherUserId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;

  const sessionAlreadyEnded = await isSessionEnded(conv.arena_session_id, { db });
  if (!wantsKeep && sessionAlreadyEnded && conv.closed_at === null) {
    await db.query(`UPDATE chat_conversations SET closed_at = now() WHERE id = $1`, [conversationId]);
    io.to(`user_${userId}`).emit('chat_closed', { conversationId, reason: 'preference_withdrawn' });
    io.to(`user_${otherUserId}`).emit('chat_closed', { conversationId, reason: 'preference_withdrawn' });
    return { success: true, chatNowClosed: true };
  }

  return { success: true, chatNowClosed: false };
}

async function isSessionEnded(arenaSessionId, { db }) {
  const session = await db.query(`
    SELECT is_open_for_checkin FROM arena_sessions WHERE id = $1
  `, [arenaSessionId]);
  return session ? !session.is_open_for_checkin : true;
}

async function closeConversationsForSession(arenaSessionId, { db }) {
  await db.query(`
    UPDATE chat_conversations SET closed_at = now()
    WHERE arena_session_id = $1
      AND closed_at IS NULL
      AND NOT (user_a_wants_keep AND user_b_wants_keep)
  `, [arenaSessionId]);
}

async function purgeExpiredChatMessages({ db }) {
  await db.queryAll(`
    DELETE FROM chat_messages
    WHERE conversation_id IN (
      SELECT id FROM chat_conversations
      WHERE closed_at IS NOT NULL AND closed_at < now() - INTERVAL '30 days'
    )
  `);
  return { purged: true };
}

module.exports = { openChatConversation, sendMessage, getMessages, closeConversationsForSession, setChatKeepPreference, purgeExpiredChatMessages };
