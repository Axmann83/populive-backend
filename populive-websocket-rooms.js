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
      // eventi che riguardano solo lui (es. "hai ricevuto una Rosa"),
      // che non devono arrivare a tutti quelli che sono nel locale.
      socket.join(`user_${userId}`);

      // Teniamo traccia di chi è cosa, per la disconnessione pulita
      // (vedi più sotto) e per poter rispondere a domande tipo
      // "quanti siamo collegati in questa stanza in questo momento?"
      socket.data.userId = userId;
      socket.data.arenaSessionId = arenaSessionId;

      // Avvisiamo il resto della stanza che questa persona è entrata
      // nel radar "vivo" (distinto dal check-in stesso, che è già
      // stato gestito da handleCheckin — qui stiamo solo aprendo
      // il canale di aggiornamenti in tempo reale)
      socket.to(room).emit('presence_update', {
        type: 'joined',
        userId,
      });

      // IMPORTANTE — il pezzo che mancava: chi ENTRA ora deve anche
      // sapere chi c'era GIÀ prima di lui. socket.to(room) avvisa
      // solo chi era già dentro, mai il nuovo arrivato — senza
      // questo, il secondo che entra vedrebbe comunque "0 persone
      // connesse" finché non arriva un terzo, invece di vedere subito
      // il primo. Mandiamo un istantanea di chi è già presente,
      // SOLO a questo socket appena entrato.
      const existingSocketIds = io.sockets.adapter.rooms.get(room) || new Set();
      const existingUserIds = [];
      for (const socketId of existingSocketIds) {
        if (socketId === socket.id) continue; // non includere se stesso
        const otherSocket = io.sockets.sockets.get(socketId);
        if (otherSocket?.data?.userId) existingUserIds.push(otherSocket.data.userId);
      }
      socket.emit('radar_snapshot', { userIds: existingUserIds });

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

      await db.query(`
        UPDATE checkins
        SET checked_out_at = now()
        WHERE user_id = $1 AND arena_session_id = $2 AND checked_out_at IS NULL
      `, [userId, arenaSessionId]);

      socket.to(room).emit('presence_update', {
        type: 'left',
        userId,
      });
    });

    function leaveAllArenaRooms(socket) {
      const rooms = [...socket.rooms].filter(r => r.startsWith('arena_'));
      rooms.forEach(r => socket.leave(r));
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
