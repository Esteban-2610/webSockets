/**
 * Namespace /board
 * Gestiona la sincronización de la pizarra en tiempo real,
 * las salas (rooms), los trazos, los cursores y el historial para nuevos integrantes.
 */

function initBoardNamespace(boardNs) {
  // Almacenamiento en memoria para cada sala: roomId -> { strokes: [], users: Map() }
  const roomStates = new Map();

  function getOrCreateRoom(roomId) {
    if (!roomStates.has(roomId)) {
      roomStates.set(roomId, {
        strokes: [], // Historial de trazos guardados
        users: new Map() // socketId -> { username, color, x, y }
      });
    }
    return roomStates.get(roomId);
  }

  boardNs.on('connection', (socket) => {
    let currentRoom = null;
    let currentUser = null;

    // Unirse a una sala específica de la pizarra
    socket.on('join-room', ({ roomId, username, userColor }) => {
      if (!roomId) return;
      currentRoom = roomId;
      currentUser = {
        id: socket.id,
        username: username || 'Anónimo',
        color: userColor || '#4285F4',
        x: -100,
        y: -100
      };

      // Unir socket a la Room en Socket.IO
      socket.join(roomId);

      const room = getOrCreateRoom(roomId);
      room.users.set(socket.id, currentUser);

      // Enviar el estado actual de la pizarra y lista de usuarios al nuevo usuario
      socket.emit('init-state', {
        strokes: room.strokes,
        users: Array.from(room.users.values()).filter(u => u.id !== socket.id)
      });

      // Notificar a los demás usuarios de la sala
      socket.to(roomId).emit('user-joined', currentUser);

      console.log(`[Board / ${roomId}] Usuario unido: ${currentUser.username} (${socket.id})`);
    });

    // Eventos de dibujo en tiempo real
    socket.on('draw-start', (data) => {
      if (!currentRoom) return;
      socket.to(currentRoom).emit('draw-start', {
        userId: socket.id,
        ...data
      });
    });

    socket.on('draw-step', (data) => {
      if (!currentRoom) return;
      socket.to(currentRoom).emit('draw-step', {
        userId: socket.id,
        ...data
      });
    });

    socket.on('draw-end', (data) => {
      if (!currentRoom) return;
      socket.to(currentRoom).emit('draw-end', {
        userId: socket.id
      });

      // Guardar el trazo completado en el historial de la sala
      if (data && data.stroke) {
        const room = getOrCreateRoom(currentRoom);
        room.strokes.push(data.stroke);
        
        // Limitar historial a últimos 2000 trazos por seguridad de memoria
        if (room.strokes.length > 2000) {
          room.strokes.shift();
        }
      }
    });

    // Limpiar toda la pizarra
    socket.on('clear-board', () => {
      if (!currentRoom) return;
      const room = getOrCreateRoom(currentRoom);
      room.strokes = [];
      boardNs.to(currentRoom).emit('board-cleared');
      console.log(`[Board / ${currentRoom}] Pizarra limpiada por ${currentUser?.username}`);
    });

    // Sincronización de cursores colaborativos en vivo (estilo Meet/Figma)
    socket.on('cursor-move', ({ x, y }) => {
      if (!currentRoom || !currentUser) return;
      currentUser.x = x;
      currentUser.y = y;

      socket.to(currentRoom).emit('cursor-update', {
        userId: socket.id,
        username: currentUser.username,
        color: currentUser.color,
        x,
        y
      });
    });

    // Desconexión
    socket.on('disconnect', () => {
      if (currentRoom && roomStates.has(currentRoom)) {
        const room = roomStates.get(currentRoom);
        room.users.delete(socket.id);

        // Notificar que el cursor y usuario se retiraron
        socket.to(currentRoom).emit('user-left', {
          userId: socket.id,
          username: currentUser?.username
        });

        // Limpiar la sala si ya no queda nadie después de un tiempo
        if (room.users.size === 0) {
          // Opcional: conservar historial o limpiar tras inactividad
        }
      }
      console.log(`[Board] Usuario desconectado: ${currentUser?.username || socket.id}`);
    });
  });
}

module.exports = { initBoardNamespace };
