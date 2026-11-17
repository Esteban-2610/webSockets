/**
 * whiteboard.js
 * Motor del lienzo HTML5 Canvas para dibujo colaborativo de alta resolución,
 * renderizado de formas geométricas, borrador, sincronización de trazos y cursores remotos.
 */

class Whiteboard {
  constructor(canvasId, cursorLayerId, boardSocket, userMeta) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.cursorLayer = document.getElementById(cursorLayerId);
    this.socket = boardSocket;
    this.user = userMeta; // { username, color }

    // Estado de herramientas
    this.currentTool = 'pen'; // 'pen', 'line', 'rect', 'circle', 'eraser'
    this.currentColor = '#1e1e1e';
    this.currentSize = 4;
    this.isDrawing = false;
    this.startX = 0;
    this.startY = 0;
    this.lastX = 0;
    this.lastY = 0;

    // Buffer del trazo actual para guardar y sincronizar
    this.currentStroke = null;
    this.allStrokes = []; // Historial local de todos los trazos

    // Trazos en curso de otros usuarios: userId -> strokeData
    this.remoteStrokes = new Map();

    // Elementos DOM de cursores de otros usuarios: userId -> DOMElement
    this.remoteCursors = new Map();

    // Canvas temporal para previsualizar figuras geométricas (línea, rectángulo, círculo)
    this.previewCanvas = document.createElement('canvas');
    this.previewCtx = this.previewCanvas.getContext('2d');
    this.previewCanvas.style.position = 'absolute';
    this.previewCanvas.style.top = '0';
    this.previewCanvas.style.left = '0';
    this.previewCanvas.style.pointerEvents = 'none';
    this.canvas.parentElement.appendChild(this.previewCanvas);

    this.initCanvasSize();
    this.bindEvents();
    this.setupSocketEvents();
  }

  // Ajuste de resolución para pantallas de alta densidad (Retina / 4K)
  initCanvasSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.previewCanvas.width = this.width * dpr;
    this.previewCanvas.height = this.height * dpr;
    this.previewCanvas.style.width = `${this.width}px`;
    this.previewCanvas.style.height = `${this.height}px`;

    this.ctx.scale(dpr, dpr);
    this.previewCtx.scale(dpr, dpr);
    this.redrawAll();
  }

  // Redibujar todo el historial de trazos
  redrawAll() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (const stroke of this.allStrokes) {
      this.drawCompletedStroke(stroke);
    }
  }

  // Obtener coordenadas normalizadas relativas al canvas
  getCoordinates(e) {
    const rect = this.canvas.getBoundingClientRect();
    let clientX, clientY;

    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  bindEvents() {
    window.addEventListener('resize', () => this.initCanvasSize());

    // Eventos de ratón
    this.canvas.addEventListener('mousedown', (e) => this.handleStart(e));
    window.addEventListener('mousemove', (e) => this.handleMove(e));
    window.addEventListener('mouseup', (e) => this.handleEnd(e));

    // Eventos táctiles (tablets, móviles)
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.handleStart(e);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      this.handleMove(e);
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      this.handleEnd(e);
    });

    // Control de cursores: throttled para no saturar socket
    let lastCursorSend = 0;
    this.canvas.addEventListener('mousemove', (e) => {
      const now = Date.now();
      if (now - lastCursorSend > 30) {
        lastCursorSend = now;
        const coords = this.getCoordinates(e);
        this.socket.emit('cursor-move', { x: coords.x, y: coords.y });
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.socket.emit('cursor-move', { x: -100, y: -100 });
    });
  }

  handleStart(e) {
    const { x, y } = this.getCoordinates(e);
    this.isDrawing = true;
    this.startX = x;
    this.startY = y;
    this.lastX = x;
    this.lastY = y;

    this.currentStroke = {
      tool: this.currentTool,
      color: this.currentTool === 'eraser' ? '#ffffff' : this.currentColor,
      size: this.currentTool === 'eraser' ? this.currentSize * 2 : this.currentSize,
      points: [{ x, y }]
    };

    if (this.currentTool === 'pen' || this.currentTool === 'eraser') {
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.currentStroke.size / 2, 0, Math.PI * 2);
      this.ctx.fillStyle = this.currentStroke.color;
      this.ctx.fill();
    }

    // Emitir inicio de trazo a otros usuarios
    this.socket.emit('draw-start', {
      tool: this.currentStroke.tool,
      color: this.currentStroke.color,
      size: this.currentStroke.size,
      x,
      y
    });
  }

  handleMove(e) {
    if (!this.isDrawing) return;
    const { x, y } = this.getCoordinates(e);

    if (this.currentTool === 'pen' || this.currentTool === 'eraser') {
      this.ctx.lineWidth = this.currentStroke.size;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.strokeStyle = this.currentStroke.color;

      this.ctx.beginPath();
      this.ctx.moveTo(this.lastX, this.lastY);
      this.ctx.lineTo(x, y);
      this.ctx.stroke();

      this.currentStroke.points.push({ x, y });
      this.lastX = x;
      this.lastY = y;

      this.socket.emit('draw-step', { x, y });
    } else {
      // Previsualización para formas geométricas (línea, rectángulo, círculo)
      this.previewCtx.clearRect(0, 0, this.width, this.height);
      this.drawShape(this.previewCtx, this.currentTool, this.startX, this.startY, x, y, this.currentStroke.color, this.currentStroke.size);
    }
  }

  handleEnd(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    let endX = this.lastX;
    let endY = this.lastY;

    if (e && (e.clientX || (e.changedTouches && e.changedTouches[0]))) {
      const coords = this.getCoordinates(e.changedTouches ? e.changedTouches[0] : e);
      endX = coords.x;
      endY = coords.y;
    }

    if (this.currentTool !== 'pen' && this.currentTool !== 'eraser') {
      this.previewCtx.clearRect(0, 0, this.width, this.height);
      // Dibujar la figura final en el canvas principal
      this.drawShape(this.ctx, this.currentTool, this.startX, this.startY, endX, endY, this.currentStroke.color, this.currentStroke.size);
      this.currentStroke.shape = {
        startX: this.startX,
        startY: this.startY,
        endX,
        endY
      };
    }

    this.allStrokes.push(this.currentStroke);

    // Enviar fin de trazo con el objeto completo para almacenamiento en el servidor
    this.socket.emit('draw-end', {
      stroke: this.currentStroke
    });

    this.currentStroke = null;
  }

  // Dibujar figuras geométricas
  drawShape(ctx, tool, x1, y1, x2, y2, color, size) {
    ctx.lineWidth = size;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    if (tool === 'line') {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (tool === 'rect') {
      const width = x2 - x1;
      const height = y2 - y1;
      ctx.strokeRect(x1, y1, width, height);
    } else if (tool === 'circle') {
      const radiusX = Math.abs(x2 - x1) / 2;
      const radiusY = Math.abs(y2 - y1) / 2;
      const centerX = Math.min(x1, x2) + radiusX;
      const centerY = Math.min(y1, y2) + radiusY;
      ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Dibujar un trazo completado (recuperado del historial del servidor)
  drawCompletedStroke(stroke) {
    if (!stroke) return;
    if (stroke.shape) {
      this.drawShape(
        this.ctx,
        stroke.tool,
        stroke.shape.startX,
        stroke.shape.startY,
        stroke.shape.endX,
        stroke.shape.endY,
        stroke.color,
        stroke.size
      );
    } else if (stroke.points && stroke.points.length > 0) {
      this.ctx.lineWidth = stroke.size;
      this.ctx.strokeStyle = stroke.color;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      this.ctx.beginPath();
      this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        this.ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      this.ctx.stroke();
    }
  }

  // Configuración de eventos recibidos por Socket.IO en el Namespace /board
  setupSocketEvents() {
    // Inicialización del estado completo (al entrar a la sala)
    this.socket.on('init-state', ({ strokes, users }) => {
      this.allStrokes = strokes || [];
      this.redrawAll();

      if (users) {
        users.forEach(u => this.updateRemoteCursor(u.id, u.username, u.color, u.x, u.y));
      }
    });

    // Inicio de trazo remoto de otro usuario
    this.socket.on('draw-start', (data) => {
      this.remoteStrokes.set(data.userId, {
        tool: data.tool,
        color: data.color,
        size: data.size,
        lastX: data.x,
        lastY: data.y,
        startX: data.x,
        startY: data.y
      });
    });

    // Paso de trazo continuo remoto
    this.socket.on('draw-step', (data) => {
      const stroke = this.remoteStrokes.get(data.userId);
      if (!stroke) return;

      if (stroke.tool === 'pen' || stroke.tool === 'eraser') {
        this.ctx.lineWidth = stroke.size;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.strokeStyle = stroke.color;

        this.ctx.beginPath();
        this.ctx.moveTo(stroke.lastX, stroke.lastY);
        this.ctx.lineTo(data.x, data.y);
        this.ctx.stroke();

        stroke.lastX = data.x;
        stroke.lastY = data.y;
      }
    });

    // Fin de trazo remoto
    this.socket.on('draw-end', (data) => {
      this.remoteStrokes.delete(data.userId);
    });

    // Pizarra limpiada para todos
    this.socket.on('board-cleared', () => {
      this.allStrokes = [];
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.previewCtx.clearRect(0, 0, this.width, this.height);
    });

    // Actualización de cursor colaborativo de otro usuario
    this.socket.on('cursor-update', ({ userId, username, color, x, y }) => {
      this.updateRemoteCursor(userId, username, color, x, y);
    });

    // Usuario desconectado de la sala
    this.socket.on('user-left', ({ userId }) => {
      this.removeRemoteCursor(userId);
    });
  }

  // Renderizar o mover cursor de otro usuario en pantalla
  updateRemoteCursor(userId, username, color, x, y) {
    if (x < 0 || y < 0) {
      this.removeRemoteCursor(userId);
      return;
    }

    let cursorEl = this.remoteCursors.get(userId);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'user-cursor';
      cursorEl.innerHTML = `
        <svg class="cursor-pointer-svg" width="20" height="20" viewBox="0 0 24 24" fill="${color}">
          <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.86a.5.5 0 0 0-.85.35z" stroke="#ffffff" stroke-width="1.5"/>
        </svg>
        <div class="cursor-tag" style="background-color: ${color};">${username}</div>
      `;
      this.cursorLayer.appendChild(cursorEl);
      this.remoteCursors.set(userId, cursorEl);
    }

    cursorEl.style.left = `${x}px`;
    cursorEl.style.top = `${y}px`;
  }

  removeRemoteCursor(userId) {
    const cursorEl = this.remoteCursors.get(userId);
    if (cursorEl) {
      cursorEl.remove();
      this.remoteCursors.delete(userId);
    }
  }

  // Limpiar pizarra local y solicitar limpieza global
  clearBoard() {
    this.socket.emit('clear-board');
    this.allStrokes = [];
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.previewCtx.clearRect(0, 0, this.width, this.height);
  }

  // Deshacer último trazo local
  undo() {
    if (this.allStrokes.length > 0) {
      this.allStrokes.pop();
      this.redrawAll();
    }
  }

  // Descargar el lienzo como imagen PNG
  downloadImage(filename = 'pizarra-colaborativa.png') {
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }
}
