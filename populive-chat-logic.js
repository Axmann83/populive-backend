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

/**
 * Va chiamata dai punti del codice dove chat_unlocked diventa true:
 *   - respondToPulse, quando accept su tier 'super'
 *   - attemptGuess, quando il match riesce (tier 'like')
 *   - sendInteraction/accettazione di un Superlike semplice
 * Crea la conversazione se non esiste già per questa coppia in
 * questa sessione (evita duplicati con lo UNIQUE dello schema).
 */
async function openChatConversation({ userAId, userBId, arenaSessionId, unlockedVia }, { db, io }) {
  // Normalizziamo l'ordine per rispettare lo UNIQUE (arena_session_id,
  // user_a_id, user_b_id) indipendentemente da chi dei due chiama per primo.
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

  const msg = await db.query(`
    INSERT INTO chat_messages (conversation_id, sender_id, body)
    VALUES ($1, $2, $3)
    RETURNING id, created_at
  `, [conversationId, senderId, body.trim()]);

  // Notifica privata SOLO al destinatario — mai alla stanza
  // condivisa dell'Arena, un messaggio è sempre un fatto privato.
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

/**
 * Imposta la preferenza "conserva questa chat oltre la serata" per
 * UNA delle due parti. Bilaterale e sempre revocabile:
 *   - resta viva oltre la sessione solo se ENTRAMBI hanno scelto "conserva"
 *   - se una chat già conservata (closed_at ancora null dopo la fine
 *     della sessione originale) perde il consenso di una delle due
 *     parti, si chiude SUBITO per entrambi, non alla prossima serata
 */
async function setChatKeepPreference({ conversationId, userId, wantsKeep }, { db, io }) {
  const conv = await db.query(`SELECT * FROM chat_conversations WHERE id = $1`, [conversationId]);
  if (!conv) return { success: false, reason: 'conversation_not_found' };
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    return { success: false, reason: 'not_a_participant' };
  }

  const column = conv.user_a_id === userId ? 'user_a_wants_keep' : 'user_b_wants_keep';
  await db.query(`UPDATE chat_conversations SET ${column} = $1 WHERE id = $2`, [wantsKeep, conversationId]);

  const otherUserId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;

  // Enforcement in tempo reale: se questa chat era già stata
  // "conservata" (sessione originale finita, closed_at ancora null
  // grazie al doppio consenso) e adesso una delle due parti ripensa
  // la scelta, chiudiamo SUBITO, senza aspettare nulla. Vale solo se
  // l'interruttore "richiedi Conserva esplicito" è acceso — a
  // interruttore spento questo bottone non è nemmeno mostrato in
  // ChatWindow.jsx, ma controlliamo anche qui per sicurezza (26/8).
  const keepRequiredFlag = await db.query(`SELECT is_enabled FROM feature_flags WHERE feature_key = 'chat_keep_required'`);
  const keepRequired = keepRequiredFlag ? keepRequiredFlag.is_enabled : true;
  const sessionAlreadyEnded = keepRequired && await isSessionEnded(conv.arena_session_id, { db });
  if (!wantsKeep && sessionAlreadyEnded && conv.closed_at === null) {
    // Stesso declassamento del blocco "da match" già applicato in
    // closeConversationsForSession, per lo stesso identico motivo —
    // qui capita quando qualcuno ritira il consenso DOPO che la
    // serata originale è già finita, un punto di chiusura diverso
    // ma concettualmente lo stesso evento.
    await db.query(`
      UPDATE blocks SET arena_session_id = $3
      WHERE reason = 'match' AND arena_session_id IS NULL
        AND ((blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1))
    `, [conv.user_a_id, conv.user_b_id, conv.arena_session_id]);

    await db.query(`UPDATE chat_conversations SET closed_at = now() WHERE id = $1`, [conversationId]);
    io.to(`user_${userId}`).emit('chat_closed', { conversationId, reason: 'preference_withdrawn' });
    io.to(`user_${otherUserId}`).emit('chat_closed', { conversationId, reason: 'preference_withdrawn' });
    return { success: true, chatNowClosed: true };
  }

  return { success: true, chatNowClosed: false };
}

// Controlla se la sessione a cui appartiene questa chat è già finita
// (utile per capire se siamo nella fase "oltre la serata originale").
async function isSessionEnded(arenaSessionId, { db }) {
  const session = await db.query(`
    SELECT is_open_for_checkin FROM arena_sessions WHERE id = $1
  `, [arenaSessionId]);
  return session ? !session.is_open_for_checkin : true;
}

/**
 * Chiamata dal "motore a orari" alla chiusura di ogni Arena — chiude
 * ALL'USO le conversazioni di quella sessione, MA rispetta il doppio
 * consenso: se entrambe le parti hanno scelto "conserva", la chat
 * resta aperta anche oltre la fine della serata (i messaggi restano
 * comunque nel database per l'archivio di sicurezza in ogni caso).
 */
/**
 * ============================================================
 * DECLASSAMENTO BLOCCO "DA MATCH" — chat non salvata (25/8)
 * ============================================================
 * Problema reale discusso con l'utente: il blocco anti-abuso da
 * match (v. blockBothDirectionsPermanently in populive-interactions-
 * logic.js) nasce SEMPRE permanente al momento del match, a
 * prescindere da cosa succede poi alla chat — ma "non salvare la
 * chat" è spesso una scelta PASSIVA (distrazione, batteria scarica,
 * fine serata frettolosa), non un rifiuto vero. Trattarla come
 * permanente quanto un vero rifiuto/blocco non ha senso.
 *
 * Soluzione: quando una chat sta per chiudersi perché NON salvata
 * da entrambi, se il blocco tra quelle due persone è ANCORA "solo
 * da match" (mai rinforzato da un rifiuto o da un blocco manuale
 * vero — la gerarchia rejection > user_blocked > match resta
 * intatta) lo si declassa da permanente a valido SOLO per quella
 * sessione — proprio come un Pulse/Superlike lasciato "in
 * sospeso". Il declassamento riusa lo stesso meccanismo di
 * controllo già esistente ovunque nell'app (arena_session_id
 * NULL = permanente, valorizzato = vale solo per QUELLA sessione)
 * — non serve nessuna logica nuova di lettura, solo questo unico
 * punto di scrittura in più.
 * ============================================================
 */
async function closeConversationsForSession(arenaSessionId, { db }) {
  // Semplificazione per le prime serate test (26/8, richiesta
  // esplicita): se l'interruttore "richiedi Conserva esplicito" è
  // spento in dashboard, le chat NON si chiudono mai da sole a fine
  // serata — si comportano come su Tinder/Hinge, si conservano di
  // default. L'unico modo per finirla resta il "Blocca" vero (mai
  // toccato da questo interruttore). Tutto il resto costruito il
  // 25/8 (declassamento del blocco da match, promemoria "Ci siamo
  // già incontrati") resta pronto e corretto per quando l'interruttore
  // verrà riacceso — semplicemente non si attiva mai finché non c'è
  // nessuna chat da chiudere.
  const keepRequiredFlag = await db.query(`SELECT is_enabled FROM feature_flags WHERE feature_key = 'chat_keep_required'`);
  const keepRequired = keepRequiredFlag ? keepRequiredFlag.is_enabled : true;
  if (!keepRequired) return;

  const toClose = await db.queryAll(`
    SELECT user_a_id, user_b_id FROM chat_conversations
    WHERE arena_session_id = $1
      AND closed_at IS NULL
      AND NOT (user_a_wants_keep AND user_b_wants_keep)
  `, [arenaSessionId]);

  for (const pair of toClose) {
    await db.query(`
      UPDATE blocks SET arena_session_id = $3
      WHERE reason = 'match' AND arena_session_id IS NULL
        AND ((blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1))
    `, [pair.user_a_id, pair.user_b_id, arenaSessionId]);
  }

  await db.query(`
    UPDATE chat_conversations SET closed_at = now()
    WHERE arena_session_id = $1
      AND closed_at IS NULL
      AND NOT (user_a_wants_keep AND user_b_wants_keep)
  `, [arenaSessionId]);
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
 * della pagina, anche se "Conserva" era stato scelto da entrambi —
 * lo stato di "quale chat ho aperto" viveva solo nella sessione del
 * browser, sparendo ad ogni refresh.
 */
async function getMyActiveConversations({ userId }, { db }) {
  const rows = await db.queryAll(`
    SELECT id, user_a_id, user_b_id
    FROM chat_conversations
    WHERE (user_a_id = $1 OR user_b_id = $1) AND closed_at IS NULL
    ORDER BY created_at DESC
  `, [userId]);

  return rows.map((r) => ({
    conversationId: r.id,
    withUserId: r.user_a_id === userId ? r.user_b_id : r.user_a_id,
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
  const row = await db.query(`
    SELECT COUNT(*) AS total FROM chat_conversations c
    WHERE (c.user_a_id = $1 OR c.user_b_id = $1) AND c.closed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM chat_messages m
        WHERE m.conversation_id = c.id
          AND m.sender_id != $1
          AND m.created_at > COALESCE(
            CASE WHEN c.user_a_id = $1 THEN c.user_a_last_read_at ELSE c.user_b_last_read_at END,
            '1970-01-01'::timestamptz
          )
      )
  `, [userId]);
  return parseInt(row?.total) || 0;
}

module.exports = { openChatConversation, sendMessage, getMessages, closeConversationsForSession, setChatKeepPreference, purgeExpiredChatMessages, getMyActiveConversations, markConversationRead, getUnreadChatCount };
