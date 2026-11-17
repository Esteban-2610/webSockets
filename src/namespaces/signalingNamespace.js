/**
 * Namespace /signaling
 * Gestiona el intercambio de señalización WebRTC (ofertas SDP, respuestas y candidatos ICE)
 * para establecer llamadas de audio y video P2P (mesh) entre participantes de una sala.
 */

function initSignalingNamespace(signalingNs) {
  signalingNs.on('connection', (socket) => {
    let currentRoom = null;
    let currentUsername = 'Anónimo';

    // Unirse a la sala de señalización
    socket.on('join-room', ({ roomId, username }) => {
      if (!roomId) return;
      currentRoom = roomId;
      currentUsername = username || 'Anónimo';

      socket.join(roomId);

      // Obtener lista de pares ya conectados en esta sala
      const roomClients = signalingNs.adapter.rooms.get(roomId);
      const existingPeers = [];

      if (roomClients) {
        for (const clientId of roomClients) {
          if (clientId !== socket.id) {
            existingPeers.push(clientId);
          }
        }
      }

      // Enviar al nuevo usuario la lista de pares existentes para que inicie las ofertas WebRTC
      socket.emit('existing-peers', {
        peers: existingPeers
      });

      // Notificar a los pares en la sala que se conectó un nuevo participante
      socket.to(roomId).emit('peer-joined', {
        peerId: socket.id,
        username: currentUsername
      });

      console.log(`[Signaling / ${roomId}] Par conectado: ${currentUsername} (${socket.id}). Pares previos: ${existingPeers.length}`);
    });

    // Reenvío de Oferta SDP (Peer A -> Peer B)
    socket.on('signal-offer', ({ to, offer }) => {
      signalingNs.to(to).emit('signal-offer', {
        from: socket.id,
        username: currentUsername,
        offer
      });
    });

    // Reenvío de Respuesta SDP (Peer B -> Peer A)
    socket.on('signal-answer', ({ to, answer }) => {
      signalingNs.to(to).emit('signal-answer', {
        from: socket.id,
        answer
      });
    });

    // Reenvío de Candidato ICE (Peer A <-> Peer B)
    socket.on('signal-ice-candidate', ({ to, candidate }) => {
      signalingNs.to(to).emit('signal-ice-candidate', {
        from: socket.id,
        candidate
      });
    });

    // Estado de medios (mute de micrófono o cámara apagada)
    socket.on('media-state-change', ({ type, enabled }) => {
      if (currentRoom) {
        socket.to(currentRoom).emit('peer-media-state', {
          peerId: socket.id,
          type,
          enabled
        });
      }
    });

    // Desconexión de WebRTC
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room !== socket.id) {
          socket.to(room).emit('peer-disconnected', {
            peerId: socket.id,
            username: currentUsername
          });
        }
      }
      console.log(`[Signaling] Par desconectado: ${currentUsername} (${socket.id})`);
    });
  });
}

module.exports = { initSignalingNamespace };
