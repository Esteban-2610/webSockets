/**
 * app.js
 * Coordinador principal de la aplicación:
 * Conecta los Namespaces /board y /signaling de Socket.IO,
 * enlaza la barra de herramientas, la información de red y la interfaz de usuario.
 */

// Extraer el roomId de la URL (ruta: /room/:roomId)
function getRoomIdFromUrl() {
  const pathParts = window.location.pathname.split('/');
  const roomIndex = pathParts.indexOf('room');
  if (roomIndex !== -1 && pathParts[roomIndex + 1]) {
    return decodeURIComponent(pathParts[roomIndex + 1]);
  }
  // Alternativa por parámetro de consulta ?room=...
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('room') || 'default-room';
}

// Mostrar notificación Toast
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

document.addEventListener('DOMContentLoaded', () => {
  const roomId = getRoomIdFromUrl();
  const roomBadge = document.getElementById('room-code-badge');
  if (roomBadge) roomBadge.textContent = roomId;

  // Recuperar o solicitar datos de usuario
  let username = localStorage.getItem('board_username');
  if (!username) {
    username = prompt('Ingresa tu nombre para la sala:') || 'Participante';
    localStorage.setItem('board_username', username);
  }

  let userColor = localStorage.getItem('board_color') || '#1a73e8';

  // 1. CONEXIÓN A NAMESPACES DE SOCKET.IO
  console.log(`[App] Conectando a Namespaces para la sala: ${roomId}`);
  
  // Namespace /board para la pizarra colaborativa
  const boardSocket = io('/board');
  
  // Namespace /signaling para la señalización WebRTC
  const signalingSocket = io('/signaling');

  // Unirse a la sala en el namespace /board
  boardSocket.on('connect', () => {
    console.log('[App] Conectado al Namespace /board con socket ID:', boardSocket.id);
    boardSocket.emit('join-room', {
      roomId,
      username,
      userColor
    });
  });

  // 2. INICIALIZAR LA PIZARRA
  const whiteboard = new Whiteboard('whiteboard', 'cursor-layer', boardSocket, {
    username,
    color: userColor
  });

  // 3. INICIALIZAR WEBRTC
  let webrtcManager = null;
  signalingSocket.on('connect', () => {
    console.log('[App] Conectado al Namespace /signaling con socket ID:', signalingSocket.id);
    if (!webrtcManager) {
      webrtcManager = new WebRTCManager(signalingSocket, roomId, username);
      setupWebRTCUIControls(webrtcManager);
    }
  });

  // 4. CONFIGURAR LA BARRA DE HERRAMIENTAS (TOOLBAR)
  setupToolbarControls(whiteboard);

  // 5. BOTÓN COPIAR ENLACE
  const copyBtn = document.getElementById('btn-copy-link');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href)
        .then(() => showToast('¡Enlace de la sala copiado al portapapeles!'))
        .catch(() => showToast('Copia la URL de la barra de direcciones'));
    });
  }

  // 6. DETECTAR Y MOSTRAR IP DE RED LOCAL PARA OTRA COMPUTADORA
  fetch('/api/info')
    .then(res => res.json())
    .then(data => {
      const lanIpText = document.getElementById('lan-ip-text');
      if (lanIpText && data.localIps && data.localIps.length > 0) {
        const ip = data.localIps[0].address;
        const port = data.port;
        lanIpText.innerHTML = `Otra PC: <strong>http://${ip}:${port}/room/${roomId}</strong>`;
      }
    })
    .catch(() => {
      const el = document.getElementById('header-ip-info');
      if (el) el.style.display = 'none';
    });
});

// Enlace de controles de UI para la pizarra
function setupToolbarControls(whiteboard) {
  // Selección de herramientas
  const toolBtns = document.querySelectorAll('.tool-btn');
  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      toolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      whiteboard.currentTool = btn.getAttribute('data-tool');
    });
  });

  // Paleta de colores predefinidos
  const colorSwatches = document.querySelectorAll('.color-swatch');
  const customColorInput = document.getElementById('custom-color-picker');
  const sizePreviewDot = document.getElementById('size-preview-dot');

  colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      colorSwatches.forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      const color = swatch.getAttribute('data-color');
      whiteboard.currentColor = color;
      if (sizePreviewDot) sizePreviewDot.style.backgroundColor = color;
    });
  });

  // Color personalizado
  if (customColorInput) {
    customColorInput.addEventListener('input', (e) => {
      colorSwatches.forEach(s => s.classList.remove('active'));
      const color = e.target.value;
      whiteboard.currentColor = color;
      if (sizePreviewDot) sizePreviewDot.style.backgroundColor = color;
    });
  }

  // Control de grosor de trazo
  const brushSizeInput = document.getElementById('brush-size');
  if (brushSizeInput) {
    brushSizeInput.addEventListener('input', (e) => {
      const size = parseInt(e.target.value, 10);
      whiteboard.currentSize = size;
      if (sizePreviewDot) {
        sizePreviewDot.style.width = `${Math.min(24, Math.max(4, size))}px`;
        sizePreviewDot.style.height = `${Math.min(24, Math.max(4, size))}px`;
      }
    });
  }

  // Botón Deshacer
  const btnUndo = document.getElementById('btn-undo');
  if (btnUndo) {
    btnUndo.addEventListener('click', () => {
      whiteboard.undo();
      showToast('Último trazo deshecho');
    });
  }

  // Botón Limpiar pizarra
  const btnClear = document.getElementById('btn-clear-board');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (confirm('¿Seguro que deseas limpiar la pizarra para todos los participantes?')) {
        whiteboard.clearBoard();
        showToast('Pizarra limpiada para todos');
      }
    });
  }

  // Botón Descargar Imagen
  const btnDownload = document.getElementById('btn-download-image');
  if (btnDownload) {
    btnDownload.addEventListener('click', () => {
      const roomId = getRoomIdFromUrl();
      whiteboard.downloadImage(`pizarra-${roomId}.png`);
      showToast('Pizarra descargada como PNG');
    });
  }
}

// Enlace de controles para la videollamada WebRTC
function setupWebRTCUIControls(webrtcManager) {
  const micBtn = document.getElementById('btn-toggle-mic');
  const camBtn = document.getElementById('btn-toggle-cam');
  const screenBtn = document.getElementById('btn-toggle-screen');
  const togglePanelBtn = document.getElementById('btn-toggle-panel');
  const meetPanel = document.getElementById('meet-panel');

  if (micBtn) {
    micBtn.addEventListener('click', () => webrtcManager.toggleAudio());
  }

  if (camBtn) {
    camBtn.addEventListener('click', () => webrtcManager.toggleVideo());
  }

  if (screenBtn) {
    screenBtn.addEventListener('click', () => webrtcManager.toggleScreenShare());
  }

  if (togglePanelBtn && meetPanel) {
    togglePanelBtn.addEventListener('click', () => {
      meetPanel.classList.toggle('minimized');
    });
  }
}
