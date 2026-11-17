/**
 * webrtc.js
 * Gestor de videollamada P2P (malla WebRTC estilo Google Meet)
 * con soporte para audio, video, compartir pantalla y negociación vía /signaling.
 */

class WebRTCManager {
  constructor(signalingSocket, roomId, username) {
    this.socket = signalingSocket;
    this.roomId = roomId;
    this.username = username || 'Participante';

    this.localStream = null;
    this.screenStream = null;
    this.isScreenSharing = false;

    this.isAudioEnabled = true;
    this.isVideoEnabled = true;

    // Diccionario de conexiones P2P: peerId -> RTCPeerConnection
    this.peers = new Map();
    // Diccionario de streams remotos: peerId -> MediaStream
    this.remoteStreams = new Map();

    // Servidores STUN públicos para resolución NAT
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    this.localVideo = document.getElementById('local-video');
    this.localPlaceholder = document.getElementById('local-placeholder');
    this.localAvatar = document.getElementById('local-avatar');
    this.localUserLabel = document.getElementById('local-user-label');
    this.videoGrid = document.getElementById('video-grid');
    this.userCountEl = document.getElementById('user-count');

    this.init();
  }

  async init() {
    this.localUserLabel.textContent = `${this.username} (Tú)`;
    this.localAvatar.textContent = this.username.charAt(0).toUpperCase();

    // Obtener stream de cámara y micrófono local
    await this.startLocalMedia();

    // Configurar listeners de señalización
    this.setupSignalingListeners();

    // Unirse a la sala en el namespace /signaling
    this.socket.emit('join-room', {
      roomId: this.roomId,
      username: this.username
    });
  }

  // Capturar cámara y micrófono local con manejo elegante de errores
  async startLocalMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      this.localVideo.srcObject = this.localStream;
      this.localPlaceholder.style.display = 'none';
      console.log('[WebRTC] Medios locales obtenidos correctamente.');
    } catch (err) {
      console.warn('[WebRTC] No se pudo acceder a cámara/micrófono:', err.message);
      // Fallback: Si no tiene cámara o micrófono, crear stream ficticio para no bloquear la llamada
      this.localPlaceholder.style.display = 'flex';
      this.isVideoEnabled = false;
      this.isAudioEnabled = false;
      this.updateControlsUI();
    }
  }

  setupSignalingListeners() {
    // 1. Recibir lista de pares existentes al unirse
    this.socket.on('existing-peers', ({ peers }) => {
      console.log('[WebRTC] Pares existentes recibidos:', peers);
      this.updateUserCount();
      for (const peerId of peers) {
        // Como nosotros somos los recién llegados a este par, iniciamos la oferta (isInitiator = true)
        this.createPeerConnection(peerId, true);
      }
    });

    // 2. Nuevo par conectado a la sala
    this.socket.on('peer-joined', ({ peerId, username }) => {
      console.log(`[WebRTC] Nuevo par conectado: ${username} (${peerId})`);
      this.updateUserCount();
      // El nuevo par nos enviará su oferta, nosotros preparamos la conexión pasiva (isInitiator = false)
      this.createPeerConnection(peerId, false, username);
      showToast(`${username} se ha unido a la llamada`);
    });

    // 3. Recibir oferta SDP
    this.socket.on('signal-offer', async ({ from, username, offer }) => {
      console.log(`[WebRTC] Recibida oferta de: ${username || from}`);
      let pc = this.peers.get(from);
      if (!pc) {
        pc = this.createPeerConnection(from, false, username);
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.socket.emit('signal-answer', {
          to: from,
          answer
        });
      } catch (err) {
        console.error('[WebRTC] Error procesando oferta:', err);
      }
    });

    // 4. Recibir respuesta SDP
    this.socket.on('signal-answer', async ({ from, answer }) => {
      console.log(`[WebRTC] Recibida respuesta de: ${from}`);
      const pc = this.peers.get(from);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error('[WebRTC] Error procesando respuesta:', err);
        }
      }
    });

    // 5. Recibir candidato ICE
    this.socket.on('signal-ice-candidate', async ({ from, candidate }) => {
      const pc = this.peers.get(from);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('[WebRTC] Error agregando candidato ICE:', err);
        }
      }
    });

    // 6. Notificación de estado de medios de un par
    this.socket.on('peer-media-state', ({ peerId, type, enabled }) => {
      this.updateRemoteMediaStateUI(peerId, type, enabled);
    });

    // 7. Par desconectado
    this.socket.on('peer-disconnected', ({ peerId, username }) => {
      console.log(`[WebRTC] Par desconectado: ${username || peerId}`);
      this.closePeer(peerId);
      this.updateUserCount();
      if (username) showToast(`${username} salió de la llamada`);
    });
  }

  // Crear o configurar conexión RTCPeerConnection con un par específico
  createPeerConnection(peerId, isInitiator, peerUsername = 'Participante') {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(peerId, pc);

    // Añadir tracks locales al par (video y audio)
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Manejo de candidatos ICE
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal-ice-candidate', {
          to: peerId,
          candidate: event.candidate
        });
      }
    };

    // Manejo de stream entrante del par remoto
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Track remoto recibido de: ${peerId}`, event.streams[0]);
      const remoteStream = event.streams[0];
      this.remoteStreams.set(peerId, remoteStream);
      this.renderRemoteVideo(peerId, peerUsername, remoteStream);
    };

    // Cambio de estado de conexión
    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Conexión con ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closePeer(peerId);
      }
    };

    // Si es el iniciador, genera la oferta inicial
    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.socket.emit('signal-offer', {
            to: peerId,
            offer
          });
        } catch (err) {
          console.error('[WebRTC] Error creando oferta:', err);
        }
      };
    }

    return pc;
  }

  // Renderizar la miniatura de video del participante remoto en el panel Meet
  renderRemoteVideo(peerId, username, stream) {
    let tile = document.getElementById(`remote-tile-${peerId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = `remote-tile-${peerId}`;

      tile.innerHTML = `
        <video id="remote-video-${peerId}" autoplay playsinline></video>
        <div class="video-placeholder" id="remote-placeholder-${peerId}" style="display:none;">
          <div class="user-avatar">${(username || 'U').charAt(0).toUpperCase()}</div>
        </div>
        <div class="video-footer">
          <span class="user-name">${username || 'Participante'}</span>
          <div class="audio-indicator" id="remote-audio-ind-${peerId}">🎤</div>
        </div>
      `;

      this.videoGrid.appendChild(tile);
    }

    const videoEl = tile.querySelector('video');
    videoEl.srcObject = stream;
  }

  // Cerrar y limpiar conexión de un par
  closePeer(peerId) {
    if (this.peers.has(peerId)) {
      this.peers.get(peerId).close();
      this.peers.delete(peerId);
    }
    this.remoteStreams.delete(peerId);

    const tile = document.getElementById(`remote-tile-${peerId}`);
    if (tile) tile.remove();
  }

  // Alternar Micrófono
  toggleAudio() {
    if (!this.localStream) return;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      this.isAudioEnabled = !this.isAudioEnabled;
      audioTrack.enabled = this.isAudioEnabled;

      const ind = document.getElementById('local-audio-indicator');
      if (this.isAudioEnabled) {
        ind.textContent = '🎤';
        ind.classList.remove('muted');
      } else {
        ind.textContent = '🔇';
        ind.classList.add('muted');
      }

      this.socket.emit('media-state-change', {
        type: 'audio',
        enabled: this.isAudioEnabled
      });

      this.updateControlsUI();
    }
  }

  // Alternar Cámara
  toggleVideo() {
    if (!this.localStream) return;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      this.isVideoEnabled = !this.isVideoEnabled;
      videoTrack.enabled = this.isVideoEnabled;
      this.localPlaceholder.style.display = this.isVideoEnabled ? 'none' : 'flex';

      this.socket.emit('media-state-change', {
        type: 'video',
        enabled: this.isVideoEnabled
      });

      this.updateControlsUI();
    }
  }

  // Compartir Pantalla
  async toggleScreenShare() {
    if (!this.isScreenSharing) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = this.screenStream.getVideoTracks()[0];

        // Reemplazar el track de video en todas las conexiones activas
        for (const [peerId, pc] of this.peers.entries()) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(screenTrack);
          }
        }

        // Mostrar en el video local
        this.localVideo.srcObject = this.screenStream;
        this.isScreenSharing = true;
        document.getElementById('btn-toggle-screen').classList.add('off');

        screenTrack.onended = () => {
          this.stopScreenShare();
        };
      } catch (err) {
        console.warn('Compartir pantalla cancelado o no disponible:', err);
      }
    } else {
      this.stopScreenShare();
    }
  }

  stopScreenShare() {
    if (!this.isScreenSharing) return;
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
    }

    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      for (const [peerId, pc] of this.peers.entries()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender && videoTrack) {
          sender.replaceTrack(videoTrack);
        }
      }
      this.localVideo.srcObject = this.localStream;
    }

    this.isScreenSharing = false;
    document.getElementById('btn-toggle-screen').classList.remove('off');
  }

  updateRemoteMediaStateUI(peerId, type, enabled) {
    if (type === 'audio') {
      const ind = document.getElementById(`remote-audio-ind-${peerId}`);
      if (ind) {
        ind.textContent = enabled ? '🎤' : '🔇';
        ind.classList.toggle('muted', !enabled);
      }
    } else if (type === 'video') {
      const placeholder = document.getElementById(`remote-placeholder-${peerId}`);
      if (placeholder) {
        placeholder.style.display = enabled ? 'none' : 'flex';
      }
    }
  }

  updateControlsUI() {
    const micBtn = document.getElementById('btn-toggle-mic');
    const camBtn = document.getElementById('btn-toggle-cam');

    if (micBtn) {
      micBtn.classList.toggle('off', !this.isAudioEnabled);
    }
    if (camBtn) {
      camBtn.classList.toggle('off', !this.isVideoEnabled);
    }
  }

  updateUserCount() {
    // 1 (nosotros) + número de pares activos
    const total = 1 + this.peers.size;
    if (this.userCountEl) {
      this.userCountEl.textContent = total;
    }
  }
}
