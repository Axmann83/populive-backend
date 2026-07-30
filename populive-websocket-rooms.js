/**
 * ============================================================
 * POPULIVE — STANZE WEBSOCKET PER LE ARENE
 * ============================================================
 */

const { Server } = require('socket.io');

function setupWebSocket(httpServer, { redis, db }) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {

    socket.on('join_arena', async ({ arenaSessionId, userId }) => {

      leaveAllArenaRooms(socket);

      const room = `arena_${arenaSessionId}`;
      socket.join(room);

      socket.join(`user_${userId}`);

      socket.data.userId = userId;
      socket.data.arenaSessionId = arenaSessionId;

      socket.to(room).emit('presence_update', {
        type: 'joined',
        userId,
      });

      // Filtriamo per USERID, non solo per socket.id — un refresh
      // della pagina, una seconda scheda, o una riconnessione che
      // lascia per un attimo la vecchia connessione ancora aperta
      // potrebbero altrimenti far comparire la stessa persona
      // (se stessa) nel proprio radar, permettendole di toccarsi
      // da sola e mandarsi Like/Superlike/Rosa — un vero bug, non
      // solo un dettaglio estetico.
      const existingSocketIds = io.sockets.adapter.rooms.get(room) || new Set();
      const existingUserIds = [];
      for (const socketId of existingSocketIds) {
        const otherSocket = io.sockets.sockets.get(socketId);
        if (otherSocket?.data?.userId && otherSocket.data.userId !== userId) {
          existingUserIds.push(otherSocket.data.userId);
        }
      }
      socket.emit('radar_snapshot', { userIds: existingUserIds });

      socket.emit('joined_arena_ack', { arenaSessionId });
    });

    socket.on('join_private_room', ({ userId }) => {
      socket.join(`user_${userId}`);
      socket.data.userId = userId;
    });

    socket.on('disconnect', async () => {
      const { userId, arenaSessionId } = socket.data;
      if (!arenaSessionId) return;

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
