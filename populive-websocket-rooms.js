/**
 * ============================================================
 * POPULIVE — STANZE WEBSOCKET PER LE ARENE
 * ============================================================
 * Usiamo Socket.IO (libreria sopra i WebSocket) perché gestisce
 * da solo alcuni problemi fastidiosi: riconnessione automatica
 * se il telefono perde per un attimo il segnale, fallback su
 * altre tecnologie se il WebSocket puro non è disponibile sulla
 * rete del locale, e — quello che ci interessa qui — il concetto
 * di "stanza" già pronto all'uso.
 * ============================================================
 */

const { Server } = require('socket.io');

// Stesso controllo di populive-checkin-logic.js (che però importa
// questo file: copiato qui per non creare un import circolare). Un id
// non valido farebbe fallire la query su Postgres.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

function setupWebSocket(httpServer, { db }) {
  const io = new Server(httpServer, {
    cors: { origin: '*' }, // da restringere al dominio vero in produzione
  });

  io.on('connection', (socket) => {
    // ------------------------------------------------------------
    // Il telefono, appena connesso, dichiara "sono nell'Arena X"
    // ------------------------------------------------------------
    socket.on('join_arena', async ({ arenaSessionId, userId }) => {
      if (!isUuid(arenaSessionId) || !isUuid(userId)) return;

      // Fuori dalla serata (uscito per distanza, col pulsante "Esci",
      // per un check-in altrove, dopo 24 ore, o serata finita — v.
      // "Quando si esce da una serata" in populive-checkin-logic.js), o
      // mai entrato: una riconnessione non basta a rientrare nel radar
      // — niente stanza, niente "è entrato" agli altri, check-in che
      // resta chiuso. Il telefono viene avvisato e torna alla schermata
      // del QR: solo una nuova scansione (handleCheckin) lo riapre.
      //
      // Questo controllo va fatto PRIMA di uscire dalle stanze: tra
      // "esci" ed "entra" non deve esserci nessuna attesa (bug B7, 28/9:
      // allora una disconnessione in quell'istante chiudeva il
      // check-in; oggi non più, ma il socket resterebbe comunque per
      // un attimo senza ricevere gli eventi del radar).
      const checkin = await db.query(
        `
        SELECT checkins.checked_out_reason, arena_sessions.closed_at
        FROM checkins
        JOIN arena_sessions ON arena_sessions.id = checkins.arena_session_id
        WHERE checkins.user_id = $1 AND checkins.arena_session_id = $2
      `,
        [userId, arenaSessionId]
      );
      let deniedReason = null;
      if (!checkin) deniedReason = 'not_checked_in';
      else if (checkin.closed_at !== null) deniedReason = 'session_end';
      else if (checkin.checked_out_reason !== null) deniedReason = checkin.checked_out_reason;

      // Un telefono può essere in UNA sola Arena alla volta:
      // se era già in una stanza precedente (es. ha cambiato
      // locale, o l'app si è riconnessa), lo togliamo da lì prima.
      leaveAllArenaRooms(socket);

      // Oltre alla stanza condivisa dell'Arena, ogni telefono entra
      // anche nella SUA stanza privata personale — serve per gli
      // eventi che riguardano solo lui (es. "hai ricevuto una Pulse"),
      // che non devono arrivare a tutti quelli che sono nel locale.
      socket.join(`user_${userId}`);

      if (deniedReason) {
        socket.data.userId = userId;
        socket.data.arenaSessionId = null;
        socket.emit('arena_access_denied', { arenaSessionId, reason: deniedReason });
        return;
      }

      const room = `arena_${arenaSessionId}`;
      socket.join(room);

      // Teniamo traccia di chi è cosa (Ghost Mode, esclusione di sé
      // stessi dagli avvisi, v. broadcastToOthers).
      socket.data.userId = userId;
      socket.data.arenaSessionId = arenaSessionId;

      // Un check-in chiuso per disconnessione dal vecchio codice
      // (motivo NULL, prima dell'ottobre 2026) si riapre: per il
      // codice di oggi la disconnessione non è un'uscita (D14).
      await db.query(
        `
        UPDATE checkins SET checked_out_at = NULL
        WHERE user_id = $1 AND arena_session_id = $2
          AND checked_out_at IS NOT NULL AND checked_out_reason IS NULL
      `,
        [userId, arenaSessionId]
      );

      // GHOST MODE — impostazione permanente del profilo, mai legata
      // a una sola serata. Chi la attiva resta invisibile al resto
      // del radar: niente avviso "è entrato" per gli altri, e più
      // sotto viene tolto anche dall'istantanea che chiunque altro
      // riceve. Torna visibile SOLO se invia lui stesso
      // un'interazione a qualcuno (gestito in populive-interactions-logic.js,
      // non qui).
      const selfRow = await db.query(`SELECT ghost_mode_enabled FROM users WHERE id = $1`, [userId]);
      const isGhost = !!selfRow?.ghost_mode_enabled;
      socket.data.isGhost = isGhost;

      // Avvisiamo il resto della stanza che questa persona è entrata
      // nel radar "vivo" (distinto dal check-in stesso, che è già
      // stato gestito da handleCheckin — qui stiamo solo aprendo
      // il canale di aggiornamenti in tempo reale).
      //
      // NON usiamo socket.to(room) qui — quel metodo esclude SOLO
      // questa esatta connessione, non altre schede/dispositivi
      // collegati con lo STESSO account. Con socket.to(room), una
      // seconda scheda con lo stesso utente riceverebbe comunque
      // l'avviso "è entrato [tuo id]", facendoti comparire nel tuo
      // stesso radar. broadcastToOthers esclude per USERID vero.
      if (!isGhost) {
        broadcastToOthers(io, room, userId, 'presence_update', {
          type: 'joined',
          userId,
        });
      }

      // IMPORTANTE — il pezzo che mancava: chi ENTRA ora deve anche
      // sapere chi c'era GIÀ prima di lui. socket.to(room) avvisa
      // solo chi era già dentro, mai il nuovo arrivato — senza
      // questo, il secondo che entra vedrebbe comunque "0 persone
      // connesse" finché non arriva un terzo, invece di vedere subito
      // il primo. Mandiamo un istantanea di chi è già presente,
      // SOLO a questo socket appena entrato.
      //
      // Dall'ottobre 2026 (D14) "presente" vuol dire check-in aperto,
      // non connessione aperta: l'elenco viene dal DB, quindi contiene
      // anche chi ha l'app chiusa o il telefono bloccato. Senza sé
      // stessi (mai toccarsi da soli e mandarsi Like/Superlike/Pulse)
      // e senza chi ha il Ghost Mode attivo — invisibile di default a
      // chiunque, salvo la rivelazione mirata via interazione (evento
      // a parte, mai qui). I blocchi li filtra il telefono.
      const present = await db.queryAll(
        `
        SELECT checkins.user_id
        FROM checkins
        JOIN users ON users.id = checkins.user_id
        WHERE checkins.arena_session_id = $1
          AND checkins.checked_out_at IS NULL
          AND checkins.user_id != $2
          AND users.ghost_mode_enabled IS NOT TRUE
      `,
        [arenaSessionId, userId]
      );
      socket.emit('radar_snapshot', { userIds: present.map((row) => row.user_id) });

      // Confermiamo al telefono stesso che è entrato correttamente
      socket.emit('joined_arena_ack', { arenaSessionId });
    });

    // Evento dedicato per chi vuole solo la propria stanza privata
    // (es. la finestra della chat, aperta indipendentemente dal
    // radar) — senza dover "entrare" in un'Arena che magari non è
    // rilevante in quel momento.
    socket.on('join_private_room', ({ userId }) => {
      socket.join(`user_${userId}`);
      socket.data.userId = userId;
    });

    // ------------------------------------------------------------
    // Disconnessione (app chiusa, telefono bloccato, rete persa)
    // ------------------------------------------------------------
    // Nessun gestore, di proposito (ottobre 2026, D14): chi ha fatto
    // check-in resta nella serata, e nel radar degli altri, anche con
    // l'app chiusa o tolta dal task manager. Prima qui il check-in si
    // chiudeva e gli altri ricevevano "left": su iPhone bastava
    // bloccare lo schermo per sparire dal radar (bug B24). I motivi
    // per uscire sono in "Quando si esce da una serata"
    // (populive-checkin-logic.js); socket.io toglie da solo il socket
    // dalle stanze.

    function leaveAllArenaRooms(socket) {
      const rooms = [...socket.rooms].filter((r) => r.startsWith('arena_'));
      rooms.forEach((r) => socket.leave(r));
    }
  });

  return io;
}

// Manda un evento a chiunque sia nella stanza, ESCLUDENDO ogni
// connessione che appartiene allo STESSO utente — non solo la
// connessione esatta da cui parte l'evento. Serve proprio a
// evitare che una seconda scheda/dispositivo con lo stesso
// account veda "il proprio ingresso" comparire nel radar come
// se fosse un'altra persona.
//
// Spostata fuori da setupWebSocket (18/9) e esportata: serve anche
// fuori dal mondo WebSocket puro, per il check-in che decade da
// solo per distanza (v. populive-checkin-logic.js) — stesso identico
// avviso "left" già usato alla disconnessione, riusato invece che
// duplicato.
function broadcastToOthers(io, room, excludeUserId, eventName, payload) {
  const socketIds = io.sockets.adapter.rooms.get(room) || new Set();
  for (const socketId of socketIds) {
    const target = io.sockets.sockets.get(socketId);
    if (target?.data?.userId && target.data.userId !== excludeUserId) {
      target.emit(eventName, payload);
    }
  }
}

module.exports = { setupWebSocket, broadcastToOthers };

/**
 * ============================================================
 * NOTA: "presence" nel radar = check-in aperto (ottobre 2026, D14)
 * ============================================================
 * In origine il radar mostrava solo chi aveva l'app aperta in quel
 * momento (connessione WebSocket viva), e chiudere l'app chiudeva il
 * check-in. Decisione dell'utente: chi ha fatto check-in resta nella
 * serata, e nel radar degli altri, anche con l'app chiusa; ne esce
 * solo per i motivi elencati in populive-checkin-logic.js. Il
 * WebSocket resta il canale degli aggiornamenti in tempo reale
 * ("joined"/"left", eventi privati), non decide più chi c'è.
 * ============================================================
 */
