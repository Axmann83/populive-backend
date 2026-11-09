/**
 * ============================================================
 * POPULIVE — CHAT 1-A-1
 * ============================================================
 * Si apre solo dopo uno sblocco (mai spontaneamente) e resta anche
 * dopo la serata (M4); si chiude solo con un blocco. Ogni messaggio è privato — notificato
 * SOLO al destinatario via WebSocket, mai trasmesso alla stanza
 * condivisa dell'Arena.
 * ============================================================
 */

const { notifyUser } = require('./populive-push');

/**
 * Va chiamata dai punti del codice dove chat_unlocked diventa true:
 *   - respondToPulse, quando una Pulse viene accettata
 *   - sendInteraction/accettazione di un Superlike semplice
 * Crea la conversazione se non esiste già per questa coppia in
 * questa sessione (evita duplicati con lo UNIQUE dello schema).
 */
async function openChatConversation({ userAId, userBId, arenaSessionId, unlockedVia }, { db }) {
  // Normalizziamo l'ordine per rispettare lo UNIQUE (arena_session_id,
  // user_a_id, user_b_id) indipendentemente da chi dei due chiama per primo.
  const [a, b] = [userAId, userBId].sort();

  const existing = await db.query(
    `
    SELECT id FROM chat_conversations
    WHERE arena_session_id = $1 AND user_a_id = $2 AND user_b_id = $3
  `,
    [arenaSessionId, a, b]
  );

  if (existing) return { conversationId: existing.id, alreadyExisted: true };

  const conv = await db.query(
    `
    INSERT INTO chat_conversations (arena_session_id, user_a_id, user_b_id, unlocked_via)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `,
    [arenaSessionId, a, b, unlockedVia]
  );

  return { conversationId: conv.id, alreadyExisted: false };
}

/**
 * ============================================================
 * MESSAGGIO DIRETTO DEGLI ARCHITETTI, SENZA MATCH (26/8)
 * ============================================================
 * Nato per contattare direttamente chi si nota emergere in
 * classifica (es. per proporgli di diventare Instant Influencer) —
 * SOLO per i 5 Architetti veri, mai per un utente normale. La
 * sicurezza vera sta nel middleware requireArchitect sull'endpoint
 * che chiama questa funzione, non qui dentro.
 *
 * Funzione SEPARATA da openChatConversation (non riusata così
 * com'è) per un motivo preciso: quella confronta arena_session_id
 * con "= $1", che in SQL non trova MAI una riga con NULL (NULL non
 * è mai uguale a NULL) — usandola qui con arena_session_id nullo
 * (queste chat non sono legate a nessuna serata specifica) avrebbe
 * creato una nuova conversazione duplicata ogni volta invece di
 * ritrovare quella già aperta.
 * ============================================================
 */
async function openAdminChat({ architettoId, targetUserId }, { db }) {
  const [a, b] = [architettoId, targetUserId].sort();

  const existing = await db.query(
    `
    SELECT id FROM chat_conversations
    WHERE arena_session_id IS NULL AND user_a_id = $1 AND user_b_id = $2 AND unlocked_via = 'admin_direct'
  `,
    [a, b]
  );

  if (existing) return { conversationId: existing.id, alreadyExisted: true };

  const conv = await db.query(
    `
    INSERT INTO chat_conversations (arena_session_id, user_a_id, user_b_id, unlocked_via)
    VALUES (NULL, $1, $2, 'admin_direct')
    RETURNING id
  `,
    [a, b]
  );

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

  // NIENTE controllo blocchi qui apposta (bug vero trovato dal
  // vivo, 22/8): una conversazione già aperta È di per sé
  // l'autorizzazione a parlare — è nata proprio da un match vero.
  // Il blocco permanente bidirezionale aggiunto la notte scorsa
  // contro l'abuso dei punti (blockBothDirectionsPermanently, in
  // populive-interactions-logic.js) scatta ESATTAMENTE nello stesso
  // momento in cui si apre la chat, dato che entrambi nascono dalla
  // stessa accettazione — controllarlo anche qui avrebbe reso ogni
  // singola chat muta fin dal primo messaggio, per chiunque. Quel
  // blocco serve a impedire NUOVE interazioni (Like/Superlike/
  // Pulse), mai i messaggi di una chat già esistente.

  if (!body || body.trim().length === 0 || body.length > 1000) {
    return { success: false, reason: 'invalid_message' };
  }

  const msg = await db.query(
    `
    INSERT INTO chat_messages (conversation_id, sender_id, body)
    VALUES ($1, $2, $3)
    RETURNING id, created_at
  `,
    [conversationId, senderId, body.trim()]
  );

  // Notifica privata SOLO al destinatario — mai alla stanza
  // condivisa dell'Arena, un messaggio è sempre un fatto privato.
  io.to(`user_${receiverId}`).emit('chat_message', {
    conversationId,
    messageId: msg.id,
    senderId,
    body: body.trim(),
    createdAt: msg.created_at,
  });
  // Push senza il testo del messaggio (decisione dell'utente, D3):
  // solo chi ha scritto. Senza await, non blocca mai l'invio.
  notifyUser({ userId: receiverId, event: 'message', senderId, revealSender: true, data: { conversationId } }, { db });

  return { success: true, messageId: msg.id, createdAt: msg.created_at };
}

async function getMessages({ conversationId, requesterId }, { db }) {
  const conv = await db.query(`SELECT * FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== requesterId && conv.user_b_id !== requesterId) {
    return { success: false, reason: 'not_a_participant' };
  }

  // Chat eliminata da chi la legge (M4): solo i messaggi arrivati dopo.
  const messages = await db.queryAll(
    `
    SELECT m.id, m.sender_id, m.body, m.created_at FROM chat_messages m
    LEFT JOIN conversation_deletions d ON d.conversation_id = m.conversation_id AND d.user_id = $2
    WHERE m.conversation_id = $1 AND (d.deleted_at IS NULL OR m.created_at > d.deleted_at)
    ORDER BY m.created_at ASC
  `,
    [conversationId, requesterId]
  );

  return {
    success: true,
    messages,
    isClosed: !!conv.closed_at,
  };
}

/**
 * ============================================================
 * ELIMINARE UNA CHAT SOLO PER SÉ (M4, novembre 2026)
 * ============================================================
 * Le chat si conservano sempre: a fine serata non si chiudono più
 * (prima si chiudevano senza il "Conserva" di entrambi, con
 * l'interruttore chat_keep_required acceso; tolti tutti e due il
 * 09/11, deciso il 01/11). Chi non vuole più vederne una la elimina:
 * sparisce SOLO dal suo elenco, l'altra persona continua a vederla
 * e può scrivere. Come su WhatsApp: se l'altra scrive dopo, la chat
 * torna nell'elenco di chi l'ha eliminata, con i soli messaggi
 * successivi (getMessages, getMyActiveConversations). Eliminarla di
 * nuovo sposta deleted_at in avanti. I messaggi restano nel database
 * per l'altra persona e per le segnalazioni (B2).
 * ============================================================
 */
async function deleteConversationForUser({ conversationId, userId }, { db }) {
  const conv = await db.query(`SELECT user_a_id, user_b_id FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    return { success: false, reason: 'not_a_participant' };
  }
  await db.query(
    `
    INSERT INTO conversation_deletions (conversation_id, user_id, deleted_at)
    VALUES ($1, $2, now())
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET deleted_at = now()
  `,
    [conversationId, userId]
  );
  return { success: true };
}

/**
 * Cancellazione fisica dei messaggi 30 giorni dopo la chiusura di
 * una conversazione — l'ultimo pezzo mancante dell'archivio di
 * sicurezza di cui parlavamo: fino a 30 giorni i messaggi restano
 * disponibili internamente per gestire eventuali segnalazioni di
 * abuso, oltre quella finestra il CONTENUTO viene cancellato per
 * davvero (minimizzazione dati). La riga della conversazione resta
 * (chi ha parlato con chi, quando, come si è sbloccata) — è solo
 * metadato, non contenuto sensibile, utile per statistiche leggere
 * senza dover conservare cosa si sono detti.
 */
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

/**
 * Tutte le conversazioni ANCORA ACCESSIBILI per questa persona in
 * questo momento — letta sempre fresca dal database vero, mai dalla
 * sola memoria del telefono. Risolve un problema reale: prima non
 * esisteva NESSUN modo di ritrovare una chat dopo un aggiornamento
 * della pagina —
 * lo stato di "quale chat ho aperto" viveva solo nella sessione del
 * browser, sparendo ad ogni refresh.
 *
 * Per ogni chat anche quanti messaggi dell'altra persona non sono
 * ancora stati letti e l'anteprima dell'ultimo — il solo pallino
 * totale sulla scheda Chat non diceva CHI aveva scritto (segnalato
 * dal vivo). Stesso criterio di "non letto" di getUnreadChatCount.
 * Ordinate per ultima attività, come in qualsiasi app di messaggi.
 */
async function getMyActiveConversations({ userId }, { db }) {
  const rows = await db.queryAll(
    `
    SELECT c.id, c.user_a_id, c.user_b_id, last_msg.body AS last_message_body,
      last_msg.sender_id AS last_message_sender_id, last_msg.created_at AS last_message_at,
      (
        SELECT COUNT(*) FROM chat_messages m
        WHERE m.conversation_id = c.id
          AND m.sender_id != $1
          AND m.created_at > GREATEST(
            COALESCE(
              CASE WHEN c.user_a_id = $1 THEN c.user_a_last_read_at ELSE c.user_b_last_read_at END,
              '1970-01-01'::timestamptz
            ),
            COALESCE(d.deleted_at, '1970-01-01'::timestamptz)
          )
      ) AS unread_count
    FROM chat_conversations c
    LEFT JOIN conversation_deletions d ON d.conversation_id = c.id AND d.user_id = $1
    LEFT JOIN LATERAL (
      SELECT body, sender_id, created_at FROM chat_messages
      WHERE conversation_id = c.id AND (d.deleted_at IS NULL OR created_at > d.deleted_at)
      ORDER BY created_at DESC
      LIMIT 1
    ) last_msg ON true
    WHERE (c.user_a_id = $1 OR c.user_b_id = $1) AND c.closed_at IS NULL
      -- eliminata da questa persona (M4): torna solo con un messaggio nuovo
      AND (d.deleted_at IS NULL OR last_msg.created_at IS NOT NULL)
    ORDER BY COALESCE(last_msg.created_at, c.created_at) DESC
  `,
    [userId]
  );

  return rows.map((r) => ({
    conversationId: r.id,
    withUserId: r.user_a_id === userId ? r.user_b_id : r.user_a_id,
    unreadCount: parseInt(r.unread_count) || 0,
    lastMessage: r.last_message_body
      ? { body: r.last_message_body, fromMe: r.last_message_sender_id === userId, at: r.last_message_at }
      : null,
  }));
}

/**
 * Segna come "letta" una conversazione per QUESTA persona — va
 * chiamata quando apre davvero quella chat specifica, non solo
 * quando naviga sul Centro Chat in generale.
 */
async function markConversationRead({ conversationId, userId }, { db }) {
  const conv = await db.query(`SELECT user_a_id, user_b_id FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    return { success: false, reason: 'not_a_participant' };
  }
  const column = conv.user_a_id === userId ? 'user_a_last_read_at' : 'user_b_last_read_at';
  await db.query(`UPDATE chat_conversations SET ${column} = now() WHERE id = $1`, [conversationId]);
  return { success: true };
}

/**
 * Quante conversazioni hanno DAVVERO qualcosa di nuovo da vedere —
 * non il totale delle chat aperte (che restava sul pallino anche a
 * chat già letta e in corso, un bug vero segnalato dal vivo), solo
 * quelle con un messaggio dell'ALTRA persona arrivato dopo l'ultima
 * volta che questa persona ha aperto proprio QUELLA chat.
 */
async function getUnreadChatCount({ userId }, { db }) {
  const row = await db.query(
    `
    SELECT COUNT(*) AS total FROM chat_conversations c
    LEFT JOIN conversation_deletions d ON d.conversation_id = c.id AND d.user_id = $1
    WHERE (c.user_a_id = $1 OR c.user_b_id = $1) AND c.closed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM chat_messages m
        WHERE m.conversation_id = c.id
          AND m.sender_id != $1
          AND m.created_at > GREATEST(
            COALESCE(
              CASE WHEN c.user_a_id = $1 THEN c.user_a_last_read_at ELSE c.user_b_last_read_at END,
              '1970-01-01'::timestamptz
            ),
            COALESCE(d.deleted_at, '1970-01-01'::timestamptz)
          )
      )
  `,
    [userId]
  );
  return parseInt(row?.total) || 0;
}

module.exports = {
  openChatConversation,
  openAdminChat,
  sendMessage,
  getMessages,
  deleteConversationForUser,
  purgeExpiredChatMessages,
  getMyActiveConversations,
  markConversationRead,
  getUnreadChatCount,
};
