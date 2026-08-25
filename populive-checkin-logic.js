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

const { refundPulseCredit } = require('./populive-interactions-logic');

async function handleCheckin({ userId, venueId }, { db, redis, io }) {

  // ------------------------------------------------------------
  // STEP 1 — Trovare (o rifiutare) la sessione Arena di oggi
  // ------------------------------------------------------------
  const session = await db.query(`
    SELECT arena_sessions.id, is_open_for_checkin, is_active, checkin_threshold
    FROM arena_sessions
    JOIN venues ON venues.id = arena_sessions.venue_id
    WHERE arena_sessions.venue_id = $1
      AND arena_sessions.session_date = current_business_date($1)
  `, [venueId]);

  if (!session || !session.is_open_for_checkin) {
    // Il locale non ha ancora aperto secondo i suoi orari,
    // oppure ha già chiuso per stasera.
    return { success: false, reason: 'venue_closed' };
  }

  // ------------------------------------------------------------
  // CASO LIMITE 1 — Doppio check-in nella stessa sessione
  // ------------------------------------------------------------
  // Controlliamo PRIMA di scrivere qualunque cosa: se questo
  // utente ha già un check-in per questa sessione, non è un
  // errore grave — semplicemente non ripetiamo il conteggio.
  // Rispondiamo "success" comunque, così il telefono dell'utente
  // vede una schermata coerente (è già dentro), non un errore.
  const alreadyCheckedIn = await redis.sismember(
    `arena:${session.id}:radar`, userId
  );

  if (alreadyCheckedIn) {
    const currentCount = await redis.get(`arena:${session.id}:checkin_count`) || 0;
    return {
      success: true,
      alreadyIn: true,                 // il frontend sa di non festeggiare un "nuovo" check-in
      arenaSessionId: session.id,
      arenaActive: session.is_active,
      checkinCount: parseInt(currentCount),
      threshold: session.checkin_threshold,
    };
  }

  // ------------------------------------------------------------
  // STEP 2 — Scrivere l'evento permanente in Postgres
  // ------------------------------------------------------------
  await db.query(`
    INSERT INTO checkins (user_id, arena_session_id, checked_in_at)
    VALUES ($1, $2, now())
  `, [userId, session.id]);

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
  const abandonedPulses = await db.queryAll(`
    SELECT p.id, p.sender_id
    FROM pulses p
    JOIN arena_sessions a ON a.id = p.arena_session_id
    WHERE p.receiver_id = $1
      AND p.status IN ('pending', 'ignored')
      AND a.venue_id != $2
  `, [userId, venueId]);

  for (const p of abandonedPulses) {
    await refundPulseCredit({ userId: p.sender_id }, { db });
  }

  if (abandonedPulses.length > 0) {
    await db.query(`
      UPDATE pulses SET status = 'expired'
      WHERE id = ANY($1)
    `, [abandonedPulses.map((p) => p.id)]);
  }

  // Un Superlike mai deciso e abbandonato (cambio locale) passa a
  // "scaduto" — utile per lo storico di chi l'ha inviato (Like→
  // Inviati), anche se dal 25/8 il credito non torna più indietro
  // in nessun caso (stesso principio di Tinder/Hinge, ripensato
  // rispetto alla correzione del 22/8 — la Pulse invece resta
  // rimborsabile, coinvolge un vero pagamento).
  const abandonedSuperlikes = await db.queryAll(`
    SELECT i.id
    FROM interactions i
    JOIN arena_sessions a ON a.id = i.arena_session_id
    WHERE i.receiver_id = $1
      AND i.type = 'superlike'
      AND i.status IN ('sent', 'ignored')
      AND a.venue_id != $2
  `, [userId, venueId]);

  if (abandonedSuperlikes.length > 0) {
    await db.query(`
      UPDATE interactions SET status = 'expired'
      WHERE id = ANY($1)
    `, [abandonedSuperlikes.map((i) => i.id)]);
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
    const fallback = await db.query(`
      SELECT COUNT(*) FROM checkins WHERE arena_session_id = $1
    `, [session.id]);
    newCount = parseInt(fallback.count);
  }

  // ------------------------------------------------------------
  // STEP 4 — L'Arena ha appena raggiunto la soglia? (solo la prima volta)
  // ------------------------------------------------------------
  const justActivated = (newCount === session.checkin_threshold) && !session.is_active;

  if (justActivated) {
    await db.query(`
      UPDATE arena_sessions
      SET is_active = true, activated_at = now()
      WHERE id = $1
    `, [session.id]);
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
    degraded: !redisOk,               // il frontend può mostrare un piccolo indicatore se serve
    arenaSessionId: session.id,
    arenaActive: session.is_active || justActivated,
    checkinCount: newCount,
    threshold: session.checkin_threshold,
  };
}

module.exports = { handleCheckin };

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
  nightclub:    { openTime: '22:00:00', closeTime: '06:00:00', checkinThreshold: 20 },
  ristorante:   { openTime: '19:00:00', closeTime: '24:00:00', checkinThreshold: 15 },
  palestra:     { openTime: '06:00:00', closeTime: '24:00:00', checkinThreshold: 10 },
  cocktail_bar: { openTime: '17:00:00', closeTime: '22:00:00', checkinThreshold: 15 },
  retail:       { openTime: '09:00:00', closeTime: '20:00:00', checkinThreshold: 10 },
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
  const minUsers = Number.isInteger(minUsersForLocalRanking) && minUsersForLocalRanking >= 1
    ? minUsersForLocalRanking
    : 5;

  const venue = await db.query(`
    INSERT INTO venues (name, area, latitude, longitude, checkin_threshold, is_partner, venue_type, default_open_time, default_close_time, min_users_for_local_ranking)
    VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9)
    RETURNING id
  `, [name.trim(), area || null, latitude, longitude, defaults.checkinThreshold, venueType, defaults.openTime, defaults.closeTime, minUsers]);

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
      genderStats: sharedTotal > 0 ? {
        sharedTotal,
        malePct: Math.round((male / sharedTotal) * 100),
        femalePct: Math.round((female / sharedTotal) * 100),
        otherPct: Math.round((other / sharedTotal) * 100),
      } : null,
    };
  });
}

module.exports = { handleCheckin, createVirtualVenue, getAllVenuesForMap };


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
