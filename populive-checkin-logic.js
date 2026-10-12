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

const { refundPulseCredit, createIgnoredCooldownBlock } = require('./populive-interactions-logic');
const { broadcastToOthers } = require('./populive-websocket-rooms');

/**
 * ============================================================
 * QUANDO SI ESCE DA UNA SERATA (ottobre 2026, D14 nella spec)
 * ============================================================
 * La presenza nella serata è il check-in, non la connessione
 * WebSocket: chi chiude l'app, la toglie dal task manager o blocca
 * il telefono resta nella serata (e nel radar degli altri). Prima
 * la disconnessione chiudeva il check-in, e su iPhone bastava
 * bloccare lo schermo per sparire dal radar (bug B24).
 *
 * Si esce SOLO per uno di questi motivi (checkins.checked_out_reason,
 * colonna della migrazione 005):
 *   'manual'        → pulsante "Esci dal locale" (leaveVenue)
 *   'other_checkin' → check-in in un'altra serata (handleCheckin)
 *   'distance'      → geofence, oltre il raggio (evaluateLocationPing)
 *   'session_end'   → fine della serata del locale (closeSession nello
 *                     scheduler: è iniziata la serata nuova, oppure
 *                     dopo la chiusura non resta più nessuno dentro)
 *   'expired'       → 24 ore dopo il check-in, in ogni caso
 *                     (expireOldCheckins): copre i locali che non
 *                     hanno una serata ogni giorno
 * NULL con checked_out_at valorizzato = chiusura per disconnessione
 * del vecchio codice (righe precedenti a ottobre 2026): si considera
 * ancora "dentro", e join_arena o la ripresa la riaprono.
 * Un check-in chiuso con un motivo si riapre solo con un nuovo QR.
 * ============================================================
 */
const CHECKIN_MAX_HOURS = 24;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

async function handleCheckin({ userId, venueId, resumeSessionId }, { db, redis, io }) {
  if (!isUuid(venueId)) {
    return { success: false, reason: 'venue_not_found' };
  }

  // ------------------------------------------------------------
  // RIPRESA AUTOMATICA (bug B8, 2/10) — non è un QR scansionato:
  // l'app, riaprendosi, ritenta da sola il check-in nell'ultimo
  // locale in cui eravamo (v. getLastVenue nel frontend). Vale SOLO
  // per la serata in cui la persona era entrata davvero col QR, e
  // finché ne fa ancora parte: prima il locale memorizzato non
  // scadeva mai, e riaprendo l'app giorni dopo, da casa, si veniva
  // fatti entrare nella serata del giorno, con tanto di radar,
  // contatore soglia e report falsati.
  // Dall'ottobre 2026 (D14) la serata resta viva anche dopo l'orario
  // di chiusura, fino alla serata successiva: la ripresa cerca quindi
  // la serata memorizzata, non quella di "oggi" — alle 03:00, a
  // locale chiuso, chi era dentro è ancora dentro.
  // ------------------------------------------------------------
  if (resumeSessionId !== undefined) {
    return resumeCheckin({ userId, venueId, resumeSessionId }, { db, redis });
  }

  // ------------------------------------------------------------
  // STEP 1 — Trovare (o rifiutare) la sessione Arena di oggi
  // ------------------------------------------------------------
  let session = await findTodaySession(venueId, { db });

  if (!session) {
    // Il locale è appena entrato nel suo orario ma lo scheduler (che
    // gira ogni 5 minuti) non ha ancora creato la serata: senza
    // questo, un QR scansionato nei primi minuti dopo l'apertura
    // rispondeva "locale chiuso". Stessa procedura dello scheduler,
    // per questo solo locale (chiude anche le serate precedenti).
    const { processVenueById } = require('./populive-scheduler'); // qui e non in cima: lo scheduler importa questo file
    await processVenueById(venueId, { db, redis, io });
    session = await findTodaySession(venueId, { db });
  }

  if (!session || !session.is_open_for_checkin) {
    // Il locale non è nel suo orario. Chi però è ancora dentro la
    // serata precedente (chiusa agli ingressi ma non ancora finita,
    // D14) e riscansiona il QR resta semplicemente dentro.
    const stillInside = await db.query(
      `
      SELECT arena_sessions.id
      FROM checkins
      JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
      WHERE arena_sessions.venue_id = $1
        AND arena_sessions.closed_at IS NULL
        AND checkins.user_id = $2
        AND checkins.checked_out_at IS NULL
    `,
      [venueId, userId]
    );
    if (stillInside) {
      return resumeCheckin({ userId, venueId, resumeSessionId: stillInside.id }, { db, redis });
    }
    return { success: false, reason: 'venue_closed' };
  }

  // ------------------------------------------------------------
  // CHECK-IN IN UN'ALTRA SERATA — chi fa check-in qui non è più
  // altrove: né in un altro locale, né in una serata precedente di
  // questo stesso locale ancora non finita (D14).
  // ------------------------------------------------------------

  const leftElsewhere = await db.queryAll(
    `
    UPDATE checkins SET checked_out_at = now(), checked_out_reason = 'other_checkin'
    FROM arena_sessions
    WHERE arena_sessions.id = checkins.arena_session_id
      AND arena_sessions.closed_at IS NULL
      AND checkins.user_id = $1
      AND checkins.arena_session_id != $2
      AND checkins.checked_out_at IS NULL
    RETURNING checkins.arena_session_id
  `,
    [userId, session.id]
  );

  for (const { arena_session_id: oldSessionId } of leftElsewhere) {
    // Senza avviso al telefono stesso: è lui che sta facendo questo
    // check-in, e un "sei uscito" in arrivo adesso potrebbe chiudere
    // la serata nuova invece della vecchia.
    await announceCheckout({ userId, arenaSessionId: oldSessionId, reason: 'other_checkin' }, { db, io });
  }

  // ------------------------------------------------------------
  // CASO LIMITE 1 — Doppio check-in nella stessa sessione
  // ------------------------------------------------------------
  // Controlliamo PRIMA di scrivere qualunque cosa: se questo
  // utente ha già un check-in per questa sessione, non è un
  // errore grave — semplicemente non ripetiamo il conteggio.
  // Rispondiamo "success" comunque, così il telefono dell'utente
  // vede una schermata coerente (è già dentro), non un errore.
  const alreadyCheckedIn = await redis.sismember(`arena:${session.id}:radar`, userId);

  if (alreadyCheckedIn) {
    // Chi scansiona di nuovo il QR è fisicamente qui: se il suo
    // check-in era stato chiuso (geofence, pulsante "Esci", 24 ore —
    // v. "Quando si esce da una serata" qui sopra) si riapre adesso:
    // join_arena non riapre mai un'uscita con un motivo, il QR è
    // l'unico modo per rientrare.
    await reopenCheckinByQr(userId, session.id, { db });
    const currentCount = (await redis.get(`arena:${session.id}:checkin_count`)) || 0;
    return {
      success: true,
      alreadyIn: true, // il frontend sa di non festeggiare un "nuovo" check-in
      arenaSessionId: session.id,
      arenaActive: session.is_active,
      checkinCount: parseInt(currentCount),
      threshold: session.checkin_threshold,
    };
  }

  // ------------------------------------------------------------
  // STEP 2 — Scrivere l'evento permanente in Postgres
  // ------------------------------------------------------------
  // Il controllo Redis qui sopra da solo non basta: due richieste
  // arrivate nello stesso istante (doppio tocco, QR aperto due
  // volte, StrictMode in sviluppo) lo passano entrambe prima che una
  // delle due abbia scritto. L'arbitro vero è l'indice unico
  // (user_id, arena_session_id) — migrazione 004: chi arriva
  // secondo non inserisce niente e riceve la stessa risposta "già
  // dentro", SENZA toccare il contatore soglia (che altrimenti
  // salirebbe di due per una persona sola).
  const inserted = await db.query(
    `
    INSERT INTO checkins (user_id, arena_session_id, checked_in_at)
    VALUES ($1, $2, now())
    ON CONFLICT (user_id, arena_session_id) DO NOTHING
    RETURNING id
  `,
    [userId, session.id]
  );

  if (!inserted) {
    // La riga c'era già: o la richiesta "gemella" ha vinto la gara,
    // o Redis ha perso il set (riavvio) mentre la persona era già
    // entrata stasera. In entrambi i casi è di nuovo dentro: la riga
    // si riapre (se era stata chiusa) e il set Redis si ripristina,
    // entrambe operazioni che non fanno danni se ripetute.
    await reopenCheckinByQr(userId, session.id, { db });
    try {
      await redis.sadd(`arena:${session.id}:radar`, userId);
    } catch (err) {
      logInternalAlert('redis_unavailable_during_checkin', { venueId, sessionId: session.id, err });
    }
    const currentCount = (await redis.get(`arena:${session.id}:checkin_count`).catch(() => null)) || 0;
    return {
      success: true,
      alreadyIn: true,
      arenaSessionId: session.id,
      arenaActive: session.is_active,
      checkinCount: parseInt(currentCount),
      threshold: session.checkin_threshold,
    };
  }

  // ------------------------------------------------------------
  // STEP 2.5 — Un Pulse è legato al locale in cui è stato ricevuto.
  // Decisione presa con l'utente (14/8), due regole diverse a
  // seconda di cosa il destinatario ha fatto finora:
  //
  //   - MAI DECISA o LASCIATA IN SOSPESO (pending/ignored): appena
  //     la persona fa check-in in un locale DIVERSO, consideriamo
  //     la questione chiusa — chi l'ha mandata riceve INDIETRO un
  //     credito Pulse (mai contanti veri, un credito equivalente),
  //     e la Pulse stessa viene segnata scaduta. Prima di questo
  //     momento però, il destinatario ha sempre una finestra vera
  //     per ripensarci e accettarla comunque.
  //
  //   - GIÀ ACCETTATA (accepted): NON scade più cambiando locale —
  //     i soldi sono già "vinti" dal destinatario in quel momento.
  //     Resta semplicemente non ritirabile finché non torna nel
  //     locale giusto (il controllo vero è già a monte, al momento
  //     del riscatto — v. populive-api-server.js, confronto tra
  //     origin_venue_id e il locale in cui si prova a riscattare).
  const abandonedPulses = await db.queryAll(
    `
    SELECT p.id, p.sender_id
    FROM pulses p
    JOIN arena_sessions a ON a.id = p.arena_session_id
    WHERE p.receiver_id = $1
      AND p.status IN ('pending', 'ignored')
      AND a.venue_id != $2
  `,
    [userId, venueId]
  );

  for (const p of abandonedPulses) {
    await refundPulseCredit({ userId: p.sender_id }, { db });
    await createIgnoredCooldownBlock({ ignoredUserId: p.sender_id, ignorerUserId: userId }, { db });
  }

  if (abandonedPulses.length > 0) {
    await db.query(
      `
      UPDATE pulses SET status = 'expired'
      WHERE id = ANY($1)
    `,
      [abandonedPulses.map((p) => p.id)]
    );
  }

  // Un Superlike mai deciso e abbandonato (cambio locale) passa a
  // "scaduto" — utile per lo storico di chi l'ha inviato (Like→
  // Inviati), anche se dal 25/8 il credito non torna più indietro
  // in nessun caso (stesso principio di Tinder/Hinge, ripensato
  // rispetto alla correzione del 22/8 — la Pulse invece resta
  // rimborsabile, coinvolge un vero pagamento).
  const abandonedSuperlikes = await db.queryAll(
    `
    SELECT i.id, i.sender_id
    FROM interactions i
    JOIN arena_sessions a ON a.id = i.arena_session_id
    WHERE i.receiver_id = $1
      AND i.type = 'superlike'
      AND i.status IN ('sent', 'ignored')
      AND a.venue_id != $2
  `,
    [userId, venueId]
  );

  for (const i of abandonedSuperlikes) {
    await createIgnoredCooldownBlock({ ignoredUserId: i.sender_id, ignorerUserId: userId }, { db });
  }

  if (abandonedSuperlikes.length > 0) {
    await db.query(
      `
      UPDATE interactions SET status = 'expired'
      WHERE id = ANY($1)
    `,
      [abandonedSuperlikes.map((i) => i.id)]
    );
  }

  // Stessa regola estesa al Like semplice (26/8, richiesta esplicita
  // dell'utente) — il Like non ha un vero "status" da far scadere
  // (resta anonimo, nessun rifiuto/ignora possibile, mai un costo da
  // rimborsare) ma può restare comunque senza risposta per settimane.
  // Cerchiamo i Like ricevuti mai sfociati in un match, abbandonati
  // allo stesso identico modo (cambio locale) — solo il raffreddamento
  // si applica qui, nessuno stato da aggiornare, nessun credito.
  const abandonedLikes = await db.queryAll(
    `
    SELECT i.id, i.sender_id
    FROM interactions i
    JOIN arena_sessions a ON a.id = i.arena_session_id
    WHERE i.receiver_id = $1
      AND i.type = 'like'
      AND i.status = 'sent'
      AND a.venue_id != $2
      AND NOT EXISTS (
        SELECT 1 FROM interactions r
        WHERE r.sender_id = $1 AND r.receiver_id = i.sender_id AND r.type = 'like'
      )
  `,
    [userId, venueId]
  );

  for (const i of abandonedLikes) {
    await createIgnoredCooldownBlock({ ignoredUserId: i.sender_id, ignorerUserId: userId }, { db });
  }

  // ------------------------------------------------------------
  // STEP 3 — Aggiornare lo stato "vivo" in Redis
  // ------------------------------------------------------------
  // CASO LIMITE 2 — Redis momentaneamente irraggiungibile.
  // Il check-in in Postgres è già andato a buon fine (l'utente
  // È dentro, a tutti gli effetti "ufficiali"), ma se Redis non
  // risponde il radar live e il contatore soglia non si aggiornano
  // subito. Scelta di design: non falliamo l'intero check-in per
  // questo — l'utente non deve essere bloccato fuori dall'Arena
  // per un problema tecnico che non lo riguarda. Segnaliamo
  // l'errore (per un allarme interno al team) e rispondiamo
  // comunque "success", con un valore di conteggio "stimato"
  // finché Redis non torna disponibile.
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
    // Stima di ripiego: contiamo quanti check-in risultano già
    // in Postgres per questa sessione, così il numero mostrato
    // non torna a zero anche se Redis è giù.
    const fallback = await db.query(
      `
      SELECT COUNT(*) FROM checkins WHERE arena_session_id = $1
    `,
      [session.id]
    );
    newCount = parseInt(fallback.count);
  }

  // ------------------------------------------------------------
  // STEP 4 — L'Arena ha appena raggiunto la soglia? (solo la prima volta)
  // ------------------------------------------------------------
  const justActivated = newCount === session.checkin_threshold && !session.is_active;

  if (justActivated) {
    await db.query(
      `
      UPDATE arena_sessions
      SET is_active = true, activated_at = now()
      WHERE id = $1
    `,
      [session.id]
    );
  }

  // ------------------------------------------------------------
  // STEP 5 — Avvisare in tempo reale chi è già collegato
  // ------------------------------------------------------------
  // Se Redis non funziona, anche le stanze WebSocket in tempo
  // reale potrebbero essere compromesse: proviamo comunque a
  // notificare, ma non facciamo fallire il check-in se anche
  // questo passo non va a buon fine.
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

  // ------------------------------------------------------------
  // RISPOSTA al telefono che ha fatto lo scan
  // ------------------------------------------------------------
  return {
    success: true,
    alreadyIn: false,
    degraded: !redisOk, // il frontend può mostrare un piccolo indicatore se serve
    arenaSessionId: session.id,
    arenaActive: session.is_active || justActivated,
    checkinCount: newCount,
    threshold: session.checkin_threshold,
  };
}

// La serata "di oggi" del locale secondo i suoi orari (ora italiana,
// migrazione 006), se esiste già.
async function findTodaySession(venueId, { db }) {
  return db.query(
    `
    SELECT arena_sessions.id, is_open_for_checkin, is_active, checkin_threshold
    FROM arena_sessions
    JOIN venues ON venues.id = arena_sessions.venue_id
    WHERE arena_sessions.venue_id = $1 AND arena_sessions.session_date = current_business_date($1)
  `,
    [venueId]
  );
}

// Ripresa di una serata in cui si è già dentro (v. handleCheckin):
// riesce solo se la serata non è finita, se il check-in non è stato
// chiuso con un motivo e se non sono passate 24 ore dal check-in.
// Non scrive niente, salvo riaprire una chiusura per disconnessione
// del vecchio codice (motivo NULL, v. "Quando si esce da una serata").
async function resumeCheckin({ userId, venueId, resumeSessionId }, { db, redis }) {
  if (!isUuid(resumeSessionId)) {
    return { success: false, reason: 'session_expired' };
  }

  const row = await db.query(
    `
    SELECT arena_sessions.is_active, venues.checkin_threshold,
      checkins.checked_out_at, checkins.checked_out_reason
    FROM checkins
    JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
    JOIN venues ON venues.id = arena_sessions.venue_id
    WHERE checkins.user_id = $1
      AND checkins.arena_session_id = $2
      AND arena_sessions.venue_id = $3
      AND arena_sessions.closed_at IS NULL
      AND checkins.checked_in_at > now() - $4 * INTERVAL '1 hour'
  `,
    [userId, resumeSessionId, venueId, CHECKIN_MAX_HOURS]
  );

  if (!row || row.checked_out_reason !== null) {
    return { success: false, reason: 'session_expired' };
  }

  if (row.checked_out_at !== null) {
    await db.query(
      `
      UPDATE checkins SET checked_out_at = NULL
      WHERE user_id = $1 AND arena_session_id = $2 AND checked_out_reason IS NULL
    `,
      [userId, resumeSessionId]
    );
  }

  const currentCount = (await redis.get(`arena:${resumeSessionId}:checkin_count`).catch(() => null)) || 0;
  return {
    success: true,
    alreadyIn: true,
    arenaSessionId: resumeSessionId,
    arenaActive: row.is_active,
    checkinCount: parseInt(currentCount),
    threshold: row.checkin_threshold,
  };
}

// In quale serata risulta dentro questa persona, adesso? (D14, 12/10)
// All'avvio l'app ricorda la serata solo nella propria memoria
// locale: un secondo dispositivo con lo stesso account, dati dell'app
// cancellati o un telefono nuovo risultavano fuori anche se per il
// server erano dentro. Senza serata memorizzata, l'app chiede qui e
// riprende quella (stesse regole di resumeCheckin).
async function getCurrentCheckin({ userId }, { db }) {
  const row = await db.query(
    `
    SELECT arena_sessions.id AS arena_session_id, arena_sessions.venue_id
    FROM checkins
    JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
    WHERE checkins.user_id = $1
      AND checkins.checked_out_at IS NULL
      AND arena_sessions.closed_at IS NULL
      AND checkins.checked_in_at > now() - $2 * INTERVAL '1 hour'
    ORDER BY checkins.checked_in_at DESC
    LIMIT 1
  `,
    [userId, CHECKIN_MAX_HOURS]
  );
  return {
    success: true,
    current: row ? { venueId: row.venue_id, arenaSessionId: row.arena_session_id } : null,
  };
}

// Un QR vero riapre sempre il check-in della serata, qualunque fosse
// il motivo della chiusura. Dopo l'uscita per le 24 ore l'orologio
// riparte da adesso, altrimenti il check-in scadrebbe di nuovo al
// giro successivo dello scheduler.
async function reopenCheckinByQr(userId, sessionId, { db }) {
  await db.query(
    `
    UPDATE checkins
    SET checked_out_at = NULL, checked_out_reason = NULL,
      checked_in_at = CASE WHEN checked_out_reason = 'expired' THEN now() ELSE checked_in_at END
    WHERE user_id = $1 AND arena_session_id = $2 AND checked_out_at IS NOT NULL
  `,
    [userId, sessionId]
  );
}

/**
 * ============================================================
 * PULSANTE "ESCI DAL LOCALE" (ottobre 2026, D14)
 * ============================================================
 * Visto che chiudere l'app non fa più uscire dalla serata, chi se ne
 * va può dirlo esplicitamente. Si rientra solo con un nuovo QR.
 * ============================================================
 */
async function leaveVenue({ userId, arenaSessionId }, { db, io }) {
  if (!isUuid(arenaSessionId)) {
    return { success: false, reason: 'invalid_session' };
  }

  const closed = await db.query(
    `
    UPDATE checkins
    SET checked_out_at = COALESCE(checked_out_at, now()), checked_out_reason = 'manual'
    WHERE user_id = $1 AND arena_session_id = $2 AND checked_out_reason IS NULL
    RETURNING id
  `,
    [userId, arenaSessionId]
  );

  if (!closed) {
    return { success: true, alreadyOut: true };
  }

  await announceCheckout({ userId, arenaSessionId, reason: 'manual', notifySelf: true }, { db, io });
  return { success: true, checkedOut: true };
}

/**
 * ============================================================
 * USCITA DOPO 24 ORE (ottobre 2026, D14) — chiamata dallo scheduler
 * ============================================================
 * In ogni caso, 24 ore dopo il check-in si esce dalla serata:
 * decisione dell'utente, per i locali che non fanno una serata ogni
 * giorno (es. solo il sabato), dove "fino alla serata successiva"
 * vorrebbe dire restare dentro una settimana. Conta anche una
 * chiusura per disconnessione del vecchio codice (motivo NULL), che
 * altrimenti resterebbe riapribile; solo nelle serate non ancora
 * finite, lo storico non si tocca.
 * ============================================================
 */
async function expireOldCheckins({ db, io }) {
  const expired = await db.queryAll(
    `
    UPDATE checkins
    SET checked_out_at = COALESCE(checkins.checked_out_at, now()), checked_out_reason = 'expired'
    FROM arena_sessions
    WHERE arena_sessions.id = checkins.arena_session_id
      AND arena_sessions.closed_at IS NULL
      AND checkins.checked_out_reason IS NULL
      AND checkins.checked_in_at < now() - $1 * INTERVAL '1 hour'
    RETURNING checkins.user_id, checkins.arena_session_id
  `,
    [CHECKIN_MAX_HOURS]
  );

  for (const { user_id: userId, arena_session_id: arenaSessionId } of expired) {
    await announceCheckout({ userId, arenaSessionId, reason: 'expired', notifySelf: true }, { db, io });
  }
  return expired.length;
}

// Dopo un'uscita dalla serata: i socket della persona escono dalla
// stanza del radar (niente più presenze e classifica del locale), gli
// altri ricevono "left" (non per il Ghost Mode, che non aveva mai
// avvisato di essere entrato) e, se richiesto, il telefono della
// persona riceve "arena_left" e torna alla schermata del QR. La
// stanza privata user_<id> resta (notifiche).
async function announceCheckout({ userId, arenaSessionId, reason, notifySelf = false }, { db, io }) {
  try {
    io.in(`user_${userId}`).socketsLeave(`arena_${arenaSessionId}`);

    const ghostRow = await db.query(`SELECT ghost_mode_enabled FROM users WHERE id = $1`, [userId]);
    if (!ghostRow?.ghost_mode_enabled) {
      broadcastToOthers(io, `arena_${arenaSessionId}`, userId, 'presence_update', { type: 'left', userId });
    }

    if (notifySelf) {
      io.to(`user_${userId}`).emit('arena_left', { arenaSessionId, reason });
    }
  } catch (err) {
    logInternalAlert('websocket_checkout_announce_failed', { userId, arenaSessionId, reason, err });
  }
}

/**
 * ============================================================
 * DECADIMENTO DEL CHECK-IN PER DISTANZA (geofencing, 18/9)
 * ============================================================
 * Il telefono chiama questo endpoint quando l'app torna in primo
 * piano (MAI in background continuo — niente permesso "sempre"
 * dato al sistema operativo, niente consumo batteria extra, niente
 * terzo consenso di posizione da aggiungere oltre a quello già
 * usato per le missioni sponsorizzate). Se la distanza dal locale
 * supera il raggio, il check-in decade da solo (motivo 'distance',
 * v. "Quando si esce da una serata"). Dall'ottobre 2026 (D14) è
 * l'unico controllo sull'uscita fisica dal locale: chiudere l'app
 * non fa più uscire, quindi chi se ne va con l'app chiusa resta
 * dentro finché non la riapre (o fino a fine serata / 24 ore).
 *
 * Di proposito NON salviamo MAI la posizione ricevuta da nessuna
 * parte — stesso principio già scritto nello schema per questa
 * tabella ("nessuna colonna GPS grezza, di proposito"): la
 * calcoliamo al volo dentro la query e la buttiamo via, non
 * diventa mai uno storico.
 *
 * Riusa la stessa formula di distanza (legge sferica dei coseni)
 * già scritta per "missioni vicino a te" in
 * populive-missions-logic.js, invece di inventarne una diversa.
 * ============================================================
 */
const GEOFENCE_RADIUS_METERS = 2000; // 2 km (ottobre 2026: 200 m era troppo poco), uguale per tutti i locali — in
// futuro potrebbe diventare una colonna per-locale
// (un locale all'aperto molto grande potrebbe volerlo
// più largo di uno piccolo al chiuso)

async function evaluateLocationPing({ userId, arenaSessionId, latitude, longitude }, { db, io }) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return { success: false, reason: 'invalid_coordinates' };
  }

  // Un account di prova non viene mai messo fuori per distanza
  // (richiesta dell'utente, ottobre 2026): serve a provare un locale
  // con persone che sono altrove. Stesso principio dei limiti che gli
  // account di prova già saltano nelle interazioni.
  const testRow = await db.query(`SELECT is_test_account FROM users WHERE id = $1`, [userId]);
  if (testRow?.is_test_account) {
    return { success: true, skipped: true, reason: 'test_account' };
  }

  // Il check-in di questo utente in questa serata non ancora finita
  // (anche dopo l'orario di chiusura, D14), se non è già chiuso con un
  // motivo. Conta anche un check-in chiuso per DISCONNESSIONE dal
  // vecchio codice (motivo NULL, bug B24): su iPhone il background
  // faceva cadere il socket e il server chiudeva il check-in; al
  // ritorno questo controllo trovava "già uscito" e non faceva niente,
  // e subito dopo join_arena lo riapriva anche a chilometri dal locale.
  const checkin = await db.query(
    `
    SELECT
      checkins.id,
      venues.latitude AS venue_lat,
      venues.longitude AS venue_lng,
      6371000 * acos(LEAST(1, GREATEST(-1,
        cos(radians($3)) * cos(radians(venues.latitude)) * cos(radians(venues.longitude) - radians($4)) +
        sin(radians($3)) * sin(radians(venues.latitude))
      ))) AS distance_meters
    FROM checkins
    JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
    JOIN venues ON venues.id = arena_sessions.venue_id
    WHERE checkins.user_id = $1
      AND checkins.arena_session_id = $2
      AND arena_sessions.closed_at IS NULL
      AND checkins.checked_out_reason IS NULL
  `,
    [userId, arenaSessionId, latitude, longitude]
  );

  if (!checkin) {
    return { success: true, alreadyOut: true };
  }

  if (checkin.venue_lat === null || checkin.venue_lng === null) {
    // Locale senza coordinate registrate (raro, ma possibile per un
    // locale virtuale creato senza precisione) — meglio non decidere
    // piuttosto che decidere alla cieca.
    return { success: true, skipped: true, reason: 'venue_missing_coordinates' };
  }

  const distanceMeters = Math.round(checkin.distance_meters);

  if (distanceMeters <= GEOFENCE_RADIUS_METERS) {
    return { success: true, withinRange: true, distanceMeters };
  }

  // Oltre il raggio: il check-in decade davvero, col motivo
  // 'distance' (migrazione 005): una riconnessione (join_arena) non
  // lo riapre, per rientrare serve scansionare di nuovo il QR. Se era
  // già chiuso per disconnessione dal vecchio codice si tiene l'ora di
  // allora e cambia solo il motivo.
  await db.query(
    `
    UPDATE checkins
    SET checked_out_at = COALESCE(checked_out_at, now()), checked_out_reason = 'distance'
    WHERE id = $1
  `,
    [checkin.id]
  );

  // NON tocchiamo né il set Redis "già entrato in questa sessione"
  // né il contatore soglia (checkin_count): quel dato serve solo a
  // non ricontare un secondo check-in nella stessa serata, resta
  // valido a prescindere da quanto la persona si allontani e magari
  // torni più tardi — coerente con "l'Arena non si disattiva mai
  // una volta partita" già deciso altrove.
  // Il telefono che ha mandato la posizione legge già la risposta:
  // niente "arena_left" anche a lui.
  await announceCheckout({ userId, arenaSessionId, reason: 'distance' }, { db, io });

  return { success: true, checkedOut: true, distanceMeters };
}

/**
 * ============================================================
 * CREAZIONE LOCALE VIRTUALE (da un utente qualunque)
 * ============================================================
 * Era solo un'intenzione di design segnata a parole tempo fa, mai
 * davvero costruita — la scriviamo ora per davvero. Chiunque può
 * creare un locale "virtuale" (senza accordo, is_partner=false):
 * orari SEMPRE quelli di default della categoria, mai quelli veri
 * del locale — coerenza con tutti gli altri locali virtuali,
 * incentivo implicito a diventare partner veri se vogliono orari
 * su misura.
 * ============================================================
 */
const VIRTUAL_VENUE_DEFAULTS = {
  nightclub: { openTime: '22:00:00', closeTime: '06:00:00', checkinThreshold: 20 },
  ristorante: { openTime: '19:00:00', closeTime: '24:00:00', checkinThreshold: 15 },
  palestra: { openTime: '06:00:00', closeTime: '24:00:00', checkinThreshold: 10 },
  cocktail_bar: { openTime: '17:00:00', closeTime: '22:00:00', checkinThreshold: 15 },
  retail: { openTime: '09:00:00', closeTime: '20:00:00', checkinThreshold: 10 },
};

async function createVirtualVenue({ name, area, latitude, longitude, venueType, minUsersForLocalRanking }, { db }) {
  const defaults = VIRTUAL_VENUE_DEFAULTS[venueType];
  if (!defaults) return { success: false, reason: 'invalid_venue_type' };
  if (!name || !name.trim()) return { success: false, reason: 'name_required' };
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return { success: false, reason: 'invalid_coordinates' };
  }

  // Soglia minima per la classifica locale — facoltativa: se chi
  // crea il locale non ufficiale non la specifica, usiamo lo stesso
  // valore di default della colonna (5), risolto qui in JavaScript
  // perché DEFAULT non è utilizzabile dentro un COALESCE in SQL.
  const minUsers =
    Number.isInteger(minUsersForLocalRanking) && minUsersForLocalRanking >= 1 ? minUsersForLocalRanking : 5;

  const venue = await db.query(
    `
    INSERT INTO venues (name, area, latitude, longitude, checkin_threshold, is_partner, venue_type, default_open_time, default_close_time, min_users_for_local_ranking)
    VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9)
    RETURNING id
  `,
    [
      name.trim(),
      area || null,
      latitude,
      longitude,
      defaults.checkinThreshold,
      venueType,
      defaults.openTime,
      defaults.closeTime,
      minUsers,
    ]
  );

  return { success: true, venueId: venue.id };
}

/**
 * Tutti i locali per la mappa "sfoglia" — partner e virtuali
 * insieme. Solo per i partner (is_partner=true, "network ufficiale")
 * mostriamo affluenza/popolarità e il badge Verificato — un locale
 * virtuale non ha nessuno che lo gestisce davvero dall'altra parte,
 * quindi non ha senso fargli vedere numeri che non controlla.
 */
async function getAllVenuesForMap({}, { db }) {
  const venues = await db.queryAll(`
    SELECT
      v.id, v.name, v.latitude, v.longitude, v.venue_type, v.is_partner,
      COALESCE(c.checkin_count, 0) AS checkin_count,
      COALESCE(c.male_count, 0) AS male_count,
      COALESCE(c.female_count, 0) AS female_count,
      COALESCE(c.other_count, 0) AS other_count,
      COALESCE(a.is_active, false) AS arena_active,
      a.id AS arena_session_id
    FROM venues v
    LEFT JOIN arena_sessions a
      ON a.venue_id = v.id AND a.session_date = current_business_date(v.id)
    LEFT JOIN LATERAL (
      SELECT
        COUNT(chk.id) AS checkin_count,
        COUNT(u.id) FILTER (WHERE u.gender_for_stats = 'male') AS male_count,
        COUNT(u.id) FILTER (WHERE u.gender_for_stats = 'female') AS female_count,
        COUNT(u.id) FILTER (WHERE u.gender_for_stats = 'other') AS other_count
      FROM arena_sessions a2
      JOIN checkins chk ON chk.arena_session_id = a2.id
      LEFT JOIN users u ON u.id = chk.user_id
      WHERE a2.venue_id = v.id AND a2.session_date = current_business_date(v.id)
    ) c ON true
  `);

  return venues.map((v) => {
    // Popolarità/affluenza mostrata SOLO per i locali del network
    // ufficiale — per gli altri il dato non ha nessun significato
    // reale (nessuno lo gestisce davvero dall'altra parte).
    if (!v.is_partner) {
      return {
        venueId: v.id,
        name: v.name,
        latitude: v.latitude,
        longitude: v.longitude,
        venueType: v.venue_type,
        isPartner: false,
        checkinCount: null,
        genderStats: null,
        arenaActive: false,
      };
    }

    const male = parseInt(v.male_count) || 0;
    const female = parseInt(v.female_count) || 0;
    const other = parseInt(v.other_count) || 0;
    const sharedTotal = male + female + other;

    return {
      venueId: v.id,
      name: v.name,
      latitude: v.latitude,
      longitude: v.longitude,
      venueType: v.venue_type,
      isPartner: true,
      checkinCount: parseInt(v.checkin_count),
      arenaActive: v.arena_active,
      arenaSessionId: v.arena_active ? v.arena_session_id : null,
      // Percentuali calcolate SOLO su chi ha condiviso — se nessuno
      // lo ha fatto, il frontend semplicemente non mostra questa
      // parte (sharedTotal = 0 lo segnala chiaramente), stessa
      // regola già usata in "Esplora".
      genderStats:
        sharedTotal > 0
          ? {
              sharedTotal,
              malePct: Math.round((male / sharedTotal) * 100),
              femalePct: Math.round((female / sharedTotal) * 100),
              otherPct: Math.round((other / sharedTotal) * 100),
            }
          : null,
    };
  });
}

module.exports = {
  handleCheckin,
  createVirtualVenue,
  getAllVenuesForMap,
  evaluateLocationPing,
  leaveVenue,
  getCurrentCheckin,
  expireOldCheckins,
  isUuid,
};

/**
 * ============================================================
 * logInternalAlert — segnala un problema al team (Slack, email,
 * sistema di monitoring...), senza interrompere l'esperienza
 * dell'utente. Da collegare a uno strumento vero (es. Sentry)
 * quando si passa alla produzione.
 * ============================================================
 */
function logInternalAlert(type, context) {
  console.error(`[ALERT] ${type}`, context);
}

/**
 * ============================================================
 * NOTA: current_business_date(venueId)
 * ============================================================
 * Questa è la funzione (da scrivere a parte) che risolve il
 * problema di cui parlavamo per le discoteche a cavallo della
 * mezzanotte: restituisce la session_date corretta anche se
 * sono le 3 del mattino, guardando default_open_time /
 * default_close_time del locale. La logica esatta la scriviamo
 * quando costruiamo il "motore a orari" — qui la richiamiamo
 * solo come funzione già pronta, per tenere il check-in leggibile.
 * ============================================================
 */
