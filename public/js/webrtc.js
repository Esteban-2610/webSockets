/**
 * webrtc.js
 * Videollamada P2P. Micrófono y cámara se piden por separado,
 * se pueden reintentar con los botones y se renegocian si entran tarde.
 */

class WebRTCManager {
  constructor(signalingSocket, roomId, username) {
    this.socket = signalingSocket;
    this.roomId = roomId;
    this.username = username || 'Participante';

    this.audioTrack = null;
    this.videoTrack = null;
    this.screenTrack = null;
    this.isScreenSharing = false;
    this.isAudioEnabled = false;
    this.isVideoEnabled = false;
    this.audioBusy = false;
    this.videoBusy = false;
    this.mediaAttempt = null;

    this.peerStates = new Map();
    this.remoteStreams = new Map();
    this.remoteMedia = new Map();
    this.earlyIce = new Map();
    this.meters = new Map();
    this.audioCtx = null;

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
    };

    this.localVideo = document.getElementById('local-video');
    this.localPlaceholder = document.getElementById('local-placeholder');
    this.localAvatar = document.getElementById('local-avatar');
    this.localUserLabel = document.getElementById('local-user-label');
    this.videoGrid = document.getElementById('video-grid');
    this.userCountEl = document.getElementById('user-count');
    this.statusEl = document.getElementById('media-status');

    this.localVideo.muted = true;
    this.localVideo.playsInline = true;

    this.init();
  }

  init() {
    this.localUserLabel.textContent = `${this.username} (Tú)`;
    this.localAvatar.textContent = this.username.charAt(0).toUpperCase();
    this.updateControlsUI();
    this.setupSignalingListeners();
    this.mediaAttempt = this.startLocalMedia();

    document.addEventListener('pointerdown', () => this.enablePlayback(), { once: true });

    this.socket.emit('join-room', {
      roomId: this.roomId,
      username: this.username
    });
  }

  setStatus(message) {
    if (this.statusEl) this.statusEl.textContent = message;
  }

  refreshStatus() {
    if (this.audioTrack && (this.videoTrack || this.isScreenSharing)) {
      this.setStatus(this.isScreenSharing ? 'Compartiendo pantalla. Micrófono activo.' : 'Micrófono y cámara activos.');
      return;
    }
    if (this.audioTrack) {
      this.setStatus('Micrófono activo. Pulsa la cámara para encenderla.');
      return;
    }
    if (this.videoTrack || this.isScreenSharing) {
      this.setStatus('Cámara activa. Pulsa el micrófono para encenderlo.');
      return;
    }
    this.setStatus('Pulsa el micrófono o la cámara para activarlos.');
  }

  mediaError(kind, err) {
    const name = err?.name || '';
    console.warn(`[WebRTC] ${kind}:`, name, err?.message || err);
    if (!window.isSecureContext || name === 'SecurityError') {
      this.setStatus('En otra PC el navegador bloquea cámara y micrófono por HTTP. Abre el enlace HTTPS y acepta el certificado.');
      return;
    }
    if (name === 'NotAllowedError') {
      this.setStatus(`Permiso de ${kind} bloqueado. Actívalo en el candado de la barra y pulsa el botón otra vez.`);
      return;
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      this.setStatus(`No se encontró ${kind} en este equipo.`);
      return;
    }
    if (name === 'NotReadableError') {
      this.setStatus(`${kind} está en uso por otra aplicación.`);
      return;
    }
    this.setStatus(`No se pudo abrir ${kind}.`);
  }

  async startLocalMedia() {
    if (!window.isSecureContext) {
      this.mediaError('cámara y micrófono', { name: 'SecurityError' });
      this.updateControlsUI();
      return;
    }

    this.audioBusy = true;
    this.videoBusy = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const audio = stream.getAudioTracks()[0];
      const video = stream.getVideoTracks()[0];
      if (audio) await this.adoptAudio(audio);
      if (video) await this.adoptVideo(video, true);
      this.refreshStatus();
      this.enablePlayback();
    } catch (err) {
      this.audioBusy = false;
      this.videoBusy = false;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        this.mediaError('cámara y micrófono', err);
        this.updateControlsUI();
        return;
      }
      await this.ensureAudio();
      await this.ensureVideo();
    } finally {
      this.audioBusy = false;
      this.videoBusy = false;
    }
  }

  async ensureAudio() {
    if (this.audioBusy) return;
    if (this.audioTrack && this.audioTrack.readyState === 'live') {
      this.isAudioEnabled = true;
      this.audioTrack.enabled = true;
      this.broadcast('audio', true);
      this.updateControlsUI();
      return;
    }
    if (!window.isSecureContext) {
      this.mediaError('micrófono', { name: 'SecurityError' });
      return;
    }

    this.audioBusy = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      const track = stream.getAudioTracks()[0];
      if (!track) {
        const error = new Error('sin pista de audio');
        error.name = 'NotFoundError';
        throw error;
      }
      await this.adoptAudio(track);
      this.refreshStatus();
      this.enablePlayback();
    } catch (err) {
      this.isAudioEnabled = false;
      this.mediaError('micrófono', err);
      this.updateControlsUI();
    } finally {
      this.audioBusy = false;
    }
  }

  async ensureVideo() {
    if (this.videoBusy) return;
    if (this.isScreenSharing) {
      await this.stopScreenShare();
    }
    if (this.videoTrack && this.videoTrack.readyState === 'live') {
      this.isVideoEnabled = true;
      this.videoTrack.enabled = true;
      this.showLocalVideo(this.videoTrack, true);
      this.broadcast('video', true);
      this.updateControlsUI();
      return;
    }
    if (!window.isSecureContext) {
      this.mediaError('cámara', { name: 'SecurityError' });
      return;
    }

    this.videoBusy = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        const error = new Error('sin pista de video');
        error.name = 'NotFoundError';
        throw error;
      }
      await this.adoptVideo(track, true);
      this.refreshStatus();
    } catch (err) {
      this.isVideoEnabled = false;
      this.mediaError('cámara', err);
      this.updateControlsUI();
    } finally {
      this.videoBusy = false;
    }
  }

  async adoptAudio(track) {
    this.releaseTrack(this.audioTrack);
    this.audioTrack = track;
    this.isAudioEnabled = true;
    track.enabled = true;
    track.onended = () => {
      if (this.audioTrack !== track) return;
      this.audioTrack = null;
      this.isAudioEnabled = false;
      this.stopMeter('local');
      this.updateControlsUI();
    };
    await this.replaceKind('audio', track);
    this.watchLevel('local', new MediaStream([track]), 'local-video-box');
    this.broadcast('audio', true);
    this.updateControlsUI();
  }

  async adoptVideo(track, mirror) {
    this.releaseTrack(this.videoTrack);
    this.videoTrack = track;
    this.isVideoEnabled = true;
    track.enabled = true;
    track.onended = () => {
      if (this.videoTrack !== track) return;
      this.videoTrack = null;
      this.isVideoEnabled = false;
      this.showLocalVideo(null, true);
      this.updateControlsUI();
    };
    this.showLocalVideo(track, mirror);
    await this.replaceKind('video', track);
    this.broadcast('video', true);
    this.updateControlsUI();
  }

  releaseTrack(track) {
    if (!track) return;
    track.onended = null;
    track.stop();
  }

  async replaceKind(kind, track) {
    const jobs = [];
    for (const state of this.peerStates.values()) {
      const transceiver = kind === 'audio' ? state.audioTransceiver : state.videoTransceiver;
      if (transceiver) jobs.push(transceiver.sender.replaceTrack(track));
    }
    await Promise.all(jobs);
  }

  showLocalVideo(track, mirror) {
    if (!track) {
      this.localVideo.srcObject = null;
      this.localPlaceholder.style.display = 'flex';
      this.localVideo.classList.remove('sharing');
      return;
    }
    this.localVideo.srcObject = new MediaStream([track]);
    this.localVideo.classList.toggle('sharing', !mirror);
    this.localPlaceholder.style.display = 'none';
    this.localVideo.play().catch(() => {});
  }

  broadcast(type, enabled) {
    this.socket.emit('media-state-change', { type, enabled });
  }

  setupSignalingListeners() {
    this.socket.on('existing-peers', async ({ peers }) => {
      for (const peer of peers || []) {
        const peerId = typeof peer === 'string' ? peer : peer.id;
        const username = typeof peer === 'string' ? 'Participante' : (peer.username || 'Participante');
        await this.createPeerConnection(peerId, true, username);
      }
      this.updateUserCount();
    });

    this.socket.on('peer-joined', async ({ peerId, username }) => {
      await this.createPeerConnection(peerId, false, username);
      this.updateUserCount();
      if (username && typeof showToast === 'function') showToast(`${username} se unió a la llamada`);
    });

    this.socket.on('signal-offer', (payload) => this.onOffer(payload));
    this.socket.on('signal-answer', (payload) => this.onAnswer(payload));

    this.socket.on('signal-ice-candidate', ({ from, candidate }) => {
      if (!candidate) return;
      const state = this.peerStates.get(from);
      if (!state) {
        const queued = this.earlyIce.get(from) || [];
        queued.push(candidate);
        this.earlyIce.set(from, queued);
        return;
      }
      this.queueIce(state, candidate);
    });

    this.socket.on('peer-media-state', ({ peerId, type, enabled }) => {
      const current = this.remoteMedia.get(peerId) || { audio: true, video: true };
      current[type] = enabled;
      this.remoteMedia.set(peerId, current);
      this.updateRemoteMediaStateUI(peerId, type, enabled);
    });

    this.socket.on('peer-disconnected', ({ peerId, username }) => {
      this.closePeer(peerId);
      if (username && typeof showToast === 'function') showToast(`${username} salió de la llamada`);
    });
  }

  async createPeerConnection(peerId, isInitiator, username = 'Participante') {
    if (this.peerStates.has(peerId)) {
      const existing = this.peerStates.get(peerId);
      if (username) existing.username = username;
      return existing;
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    const state = {
      peerId,
      pc,
      username,
      polite: !isInitiator,
      makingOffer: false,
      iceQueue: [],
      mediaReady: false,
      negotiateLater: false,
      audioTransceiver: null,
      videoTransceiver: null
    };
    this.peerStates.set(peerId, state);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.socket.emit('signal-ice-candidate', {
        to: peerId,
        candidate: event.candidate
      });
    };

    pc.ontrack = (event) => this.onRemoteTrack(state, event);

    pc.onnegotiationneeded = () => {
      if (!state.mediaReady) {
        state.negotiateLater = true;
        return;
      }
      this.negotiate(state);
    };

    pc.onconnectionstatechange = () => {
      const connectionState = pc.connectionState;
      console.log(`[WebRTC] ${peerId}: ${connectionState}`);
      if (connectionState === 'failed') {
        try { pc.restartIce(); } catch (err) { console.warn('[WebRTC] restartIce', err); }
      }
      if (connectionState === 'closed') this.closePeer(peerId);
    };

    state.audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    state.videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });

    if (this.mediaAttempt) {
      await Promise.race([
        this.mediaAttempt,
        new Promise((resolve) => setTimeout(resolve, 2500))
      ]);
    }

    const videoTrack = this.isScreenSharing ? this.screenTrack : this.videoTrack;
    const jobs = [];
    if (this.audioTrack) jobs.push(state.audioTransceiver.sender.replaceTrack(this.audioTrack));
    if (videoTrack) jobs.push(state.videoTransceiver.sender.replaceTrack(videoTrack));
    await Promise.all(jobs);

    const early = this.earlyIce.get(peerId) || [];
    this.earlyIce.delete(peerId);
    state.iceQueue.push(...early);

    state.mediaReady = true;
    if (state.negotiateLater) await this.negotiate(state);
    this.updateUserCount();
    return state;
  }

  async negotiate(state) {
    if (state.makingOffer || !this.peerStates.has(state.peerId)) return;
    try {
      state.makingOffer = true;
      if (state.pc.signalingState !== 'stable') return;
      const offer = await state.pc.createOffer();
      if (state.pc.signalingState !== 'stable') return;
      await state.pc.setLocalDescription(offer);
      this.socket.emit('signal-offer', {
        to: state.peerId,
        offer: state.pc.localDescription
      });
    } catch (err) {
      console.error('[WebRTC] Error creando oferta', err);
    } finally {
      state.makingOffer = false;
    }
  }

  async onOffer({ from, username, offer }) {
    const state = await this.createPeerConnection(from, false, username);
    if (username) state.username = username;
    const pc = state.pc;
    const collision = state.makingOffer || pc.signalingState !== 'stable';
    if (!state.polite && collision) return;

    try {
      if (collision) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription(offer);
      await this.flushIce(state);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('signal-answer', {
        to: from,
        answer: pc.localDescription
      });
    } catch (err) {
      console.error('[WebRTC] Error procesando oferta', err);
    }
  }

  async onAnswer({ from, answer }) {
    const state = this.peerStates.get(from);
    if (!state) return;
    try {
      await state.pc.setRemoteDescription(answer);
      await this.flushIce(state);
    } catch (err) {
      console.error('[WebRTC] Error procesando respuesta', err);
    }
  }

  queueIce(state, candidate) {
    if (!state.pc.remoteDescription || state.pc.remoteDescription.type === 'rollback') {
      state.iceQueue.push(candidate);
      return;
    }
    state.pc.addIceCandidate(candidate).catch((err) => {
      console.warn('[WebRTC] Candidato ICE ignorado', err.message);
    });
  }

  async flushIce(state) {
    const queued = state.iceQueue.splice(0);
    for (const candidate of queued) {
      try {
        await state.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[WebRTC] Candidato ICE en cola ignorado', err.message);
      }
    }
  }

  onRemoteTrack(state, event) {
    let stream = this.remoteStreams.get(state.peerId);
    if (!stream) {
      stream = event.streams[0] || new MediaStream();
      this.remoteStreams.set(state.peerId, stream);
    }
    if (!stream.getTracks().some((track) => track.id === event.track.id)) {
      stream.addTrack(event.track);
    }

    this.renderRemoteVideo(state.peerId, state.username, stream);

    const refresh = () => {
      this.syncRemoteTile(state.peerId);
      if (event.track.kind === 'audio') {
        this.watchLevel(state.peerId, stream, `remote-tile-${state.peerId}`);
      }
    };
    event.track.onunmute = refresh;
    event.track.onmute = refresh;
    event.track.onended = refresh;
    refresh();
  }

  renderRemoteVideo(peerId, username, stream) {
    let tile = document.getElementById(`remote-tile-${peerId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = `remote-tile-${peerId}`;

      const video = document.createElement('video');
      video.id = `remote-video-${peerId}`;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');

      const placeholder = document.createElement('div');
      placeholder.className = 'video-placeholder';
      placeholder.id = `remote-placeholder-${peerId}`;
      const avatar = document.createElement('div');
      avatar.className = 'user-avatar';
      avatar.textContent = (username || 'U').charAt(0).toUpperCase();
      placeholder.appendChild(avatar);

      const footer = document.createElement('div');
      footer.className = 'video-footer';
      const name = document.createElement('span');
      name.className = 'user-name';
      name.textContent = username || 'Participante';
      const indicator = document.createElement('div');
      indicator.className = 'audio-indicator';
      indicator.id = `remote-audio-ind-${peerId}`;
      indicator.textContent = '🎤';
      footer.append(name, indicator);

      tile.append(video, placeholder, footer);
      this.videoGrid.appendChild(tile);
    } else {
      const name = tile.querySelector('.user-name');
      if (name && username) name.textContent = username;
    }

    const videoEl = tile.querySelector('video');
    if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
    videoEl.play().catch(() => {
      this.setStatus('Pulsa la pantalla una vez para escuchar el audio.');
    });
    this.syncRemoteTile(peerId);
  }

  syncRemoteTile(peerId) {
    const stream = this.remoteStreams.get(peerId);
    const prefs = this.remoteMedia.get(peerId) || { audio: true, video: true };
    const placeholder = document.getElementById(`remote-placeholder-${peerId}`);
    const indicator = document.getElementById(`remote-audio-ind-${peerId}`);
    if (!stream) return;

    const videoTrack = stream.getVideoTracks().find((track) => track.readyState === 'live');
    const videoVisible = Boolean(prefs.video && videoTrack && videoTrack.enabled && !videoTrack.muted);
    if (placeholder) placeholder.style.display = videoVisible ? 'none' : 'flex';

    const audioTrack = stream.getAudioTracks().find((track) => track.readyState === 'live');
    const audioOn = Boolean(prefs.audio && audioTrack && audioTrack.enabled);
    if (indicator) {
      indicator.textContent = audioOn ? '🎤' : '🔇';
      indicator.classList.toggle('muted', !audioOn);
    }
  }

  closePeer(peerId) {
    const state = this.peerStates.get(peerId);
    if (!state) return;
    this.peerStates.delete(peerId);
    this.remoteStreams.delete(peerId);
    this.remoteMedia.delete(peerId);
    this.earlyIce.delete(peerId);
    this.stopMeter(peerId);
    try { state.pc.close(); } catch (err) { /* ya cerrada */ }
    document.getElementById(`remote-tile-${peerId}`)?.remove();
    this.updateUserCount();
  }

  async toggleAudio() {
    this.enablePlayback();
    if (this.audioTrack && this.isAudioEnabled) {
      this.releaseTrack(this.audioTrack);
      this.audioTrack = null;
      this.isAudioEnabled = false;
      this.stopMeter('local');
      await this.replaceKind('audio', null);
      this.broadcast('audio', false);
      this.updateControlsUI();
      this.setStatus('Micrófono apagado.');
      return;
    }
    await this.ensureAudio();
  }

  async toggleVideo() {
    this.enablePlayback();
    if (this.isScreenSharing) {
      await this.stopScreenShare();
      await this.ensureVideo();
      return;
    }
    if (this.videoTrack && this.isVideoEnabled) {
      this.releaseTrack(this.videoTrack);
      this.videoTrack = null;
      this.isVideoEnabled = false;
      this.showLocalVideo(null, true);
      await this.replaceKind('video', null);
      this.broadcast('video', false);
      this.updateControlsUI();
      this.setStatus('Cámara apagada.');
      return;
    }
    await this.ensureVideo();
  }

  async toggleScreenShare() {
    this.enablePlayback();
    if (this.isScreenSharing) {
      await this.stopScreenShare();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      if (!track) return;

      this.releaseTrack(this.videoTrack);
      this.videoTrack = null;
      this.screenTrack = track;
      this.isScreenSharing = true;
      this.isVideoEnabled = false;
      track.onended = () => this.stopScreenShare();

      await this.replaceKind('video', track);
      this.showLocalVideo(track, false);
      this.broadcast('video', true);
      document.getElementById('btn-toggle-screen')?.classList.add('sharing');
      this.updateControlsUI();
      this.setStatus('Compartiendo pantalla.');
    } catch (err) {
      if (err.name !== 'NotAllowedError') this.setStatus('No se pudo compartir la pantalla.');
    }
  }

  async stopScreenShare() {
    if (!this.isScreenSharing && !this.screenTrack) return;
    if (this.screenTrack) {
      this.screenTrack.onended = null;
      this.screenTrack.stop();
      this.screenTrack = null;
    }
    this.isScreenSharing = false;
    document.getElementById('btn-toggle-screen')?.classList.remove('sharing');
    await this.replaceKind('video', null);
    this.showLocalVideo(null, true);
    this.broadcast('video', false);
    this.updateControlsUI();
    this.refreshStatus();
  }

  updateRemoteMediaStateUI(peerId, type, enabled) {
    this.syncRemoteTile(peerId);
    if (type === 'audio' && !enabled) {
      document.getElementById(`remote-tile-${peerId}`)?.classList.remove('speaking');
    }
  }

  updateControlsUI() {
    const micBtn = document.getElementById('btn-toggle-mic');
    const camBtn = document.getElementById('btn-toggle-cam');
    const indicator = document.getElementById('local-audio-indicator');

    if (micBtn) micBtn.classList.toggle('off', !this.isAudioEnabled);
    if (camBtn) camBtn.classList.toggle('off', !this.isVideoEnabled && !this.isScreenSharing);
    if (indicator) {
      indicator.textContent = this.isAudioEnabled ? '🎤' : '🔇';
      indicator.classList.toggle('muted', !this.isAudioEnabled);
    }
  }

  updateUserCount() {
    if (!this.userCountEl) return;
    this.userCountEl.textContent = String(1 + this.peerStates.size);
  }

  enablePlayback() {
    document.querySelectorAll('#video-grid video').forEach((video) => {
      video.play().catch(() => {});
    });
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  getAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.audioCtx) this.audioCtx = new AudioCtx();
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  watchLevel(id, stream, tileId) {
    if (!stream.getAudioTracks().length) return;
    this.stopMeter(id);
    const ctx = this.getAudioContext();
    if (!ctx) return;

    let source;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch (err) {
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const meter = { source, raf: 0 };

    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const level = sum / data.length / 255;
      const tile = document.getElementById(tileId);
      if (tile) tile.classList.toggle('speaking', level > 0.08);
      meter.raf = requestAnimationFrame(tick);
    };

    meter.raf = requestAnimationFrame(tick);
    this.meters.set(id, meter);
  }

  stopMeter(id) {
    const meter = this.meters.get(id);
    if (!meter) return;
    cancelAnimationFrame(meter.raf);
    try { meter.source.disconnect(); } catch (err) { /* ya desconectado */ }
    this.meters.delete(id);
    if (id === 'local') {
      document.getElementById('local-video-box')?.classList.remove('speaking');
    }
  }
}
