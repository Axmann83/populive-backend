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

function setupWebSocket(httpServer, { redis, db }) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },  // da restringere al dominio vero in produzione
  });

  io.on('connection', (socket) => {

    // ------------------------------------------------------------
    // Il telefono, appena connesso, dichiara "sono nell'Arena X"
    // ------------------------------------------------------------
    socket.on('join_arena', async ({ arenaSessionId, userId }) => {

      // Un telefono può essere in UNA sola Arena alla volta:
      // se era già in una stanza precedente (es. ha cambiato
      // locale, o l'app si è riconnessa), lo togliamo da lì prima.
      leaveAllArenaRooms(socket);

      const room = `arena_${arenaSessionId}`;
      socket.join(room);

      // Oltre alla stanza condivisa dell'Arena, ogni telefono entra
      // anche nella SUA stanza privata personale — serve per gli
      // eventi che riguardano solo lui (es. "hai ricevuto una Pulse"),
      // che non devono arrivare a tutti quelli che sono nel locale.
      socket.join(`user_${userId}`);

      // Teniamo traccia di chi è cosa, per la disconnessione pulita
      // (vedi più sotto) e per poter rispondere a domande tipo
      // "quanti siamo collegati in questa stanza in questo momento?"
      socket.data.userId = userId;
      socket.data.arenaSessionId = arenaSessionId;

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
      // Filtriamo per USERID, non solo per socket.id — un refresh
      // della pagina, una seconda scheda, o una riconnessione che
      // lascia per un attimo la vecchia connessione ancora aperta
      // potrebbero altrimenti far comparire la stessa persona
      // (se stessa) nel proprio radar, permettendole di toccarsi
      // da sola e mandarsi Like/Superlike/Pulse — un vero bug, non
      // solo un dettaglio estetico.
      //
      // Filtriamo ANCHE chi ha il Ghost Mode attivo — invisibile di
      // default a chiunque, salvo la rivelazione mirata via
      // interazione (evento a parte, mai qui).
      const existingSocketIds = io.sockets.adapter.rooms.get(room) || new Set();
      const existingUserIdsSet = new Set(); // un utente può avere più di una connessione attiva nella stessa stanza (es. proprio durante un refresh, la vecchia connessione resta aperta un attimo mentre la nuova si apre) — un Set evita di contarlo/mostrarlo più volte
      for (const socketId of existingSocketIds) {
        const otherSocket = io.sockets.sockets.get(socketId);
        if (otherSocket?.data?.userId && otherSocket.data.userId !== userId && !otherSocket.data.isGhost) {
          existingUserIdsSet.add(otherSocket.data.userId);
        }
      }
      socket.emit('radar_snapshot', { userIds: [...existingUserIdsSet] });

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
    // Disconnessione (app chiusa, telefono spento, uscito dal locale)
    // ------------------------------------------------------------
    socket.on('disconnect', async () => {
      const { userId, arenaSessionId } = socket.data;
      if (!arenaSessionId) return; // non era mai entrato in nessuna Arena

      const room = `arena_${arenaSessionId}`;

      // Registriamo una stima di "orario di uscita" — utile SOLO in
      // forma aggregata per i report ai locali (v. populive-venue-insights.js),
      // mai mostrata come dato individuale. È una stima "best effort":
      // se l'app si chiude bruscamente (batteria scarica, crash) il
      // disconnect può arrivare con qualche minuto di ritardo, non è
      // un dato al secondo — sufficiente per medie, non per singoli casi.
      await db.query(`
        UPDATE checkins
        SET checked_out_at = now()
        WHERE user_id = $1 AND arena_session_id = $2 AND checked_out_at IS NULL
      `, [userId, arenaSessionId]);

      // Avvisiamo gli altri che questa persona non è più "vivamente"
      // collegata — utile per un radar accurato (es. per non mostrare
      // come "presente ora" chi ha già chiuso l'app), anche se il suo
      // check-in storico in Postgres resta comunque per sempre.
      //
      // Stessa regola del "joined": chi è in Ghost Mode non ha mai
      // avvisato nessuno di essere entrato, quindi non ha senso
      // avvisare che è uscito — nessuno stava "vedendo" la sua
      // presenza da togliere.
      if (!socket.data.isGhost) {
        broadcastToOthers(io, room, userId, 'presence_update', {
          type: 'left',
          userId,
        });
      }
    });

    function leaveAllArenaRooms(socket) {
      const rooms = [...socket.rooms].filter(r => r.startsWith('arena_'));
      rooms.forEach(r => socket.leave(r));
    }

    // Manda un evento a chiunque sia nella stanza, ESCLUDENDO ogni
    // connessione che appartiene allo STESSO utente — non solo la
    // connessione esatta da cui parte l'evento. Serve proprio a
    // evitare che una seconda scheda/dispositivo con lo stesso
    // account veda "il proprio ingresso" comparire nel radar come
    // se fosse un'altra persona.
    function broadcastToOthers(io, room, excludeUserId, eventName, payload) {
      const socketIds = io.sockets.adapter.rooms.get(room) || new Set();
      for (const socketId of socketIds) {
        const target = io.sockets.sockets.get(socketId);
        if (target?.data?.userId && target.data.userId !== excludeUserId) {
          target.emit(eventName, payload);
        }
      }
    }
  });

  return io;
}

module.exports = { setupWebSocket };


/**
 * ============================================================
 * NOTA: perché "presence" (chi è collegato ORA) è diverso
 * dal check-in registrato in Postgres.
 * ============================================================
 * Un utente può aver fatto check-in (evento storico permanente)
 * ma aver chiuso l'app cinque minuti dopo — è ancora "nell'Arena"
 * per la classifica e i punti, ma non è più "presente" nel radar
 * in tempo reale che gli altri vedono in questo istante. I due
 * concetti restano volutamente separati:
 *   - checkins (Postgres)          → per sempre, per punti/storico
 *   - radar live (Redis + presence WebSocket) → solo finché l'app
 *     resta aperta, si aggiorna in tempo reale
 * ============================================================
 */
