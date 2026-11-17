/**
 * whiteboard.js
 * Lienzo colaborativo. Los trazos van en coordenadas 0-1 para que
 * coincidan entre pantallas, con trazo suave y deshacer sincronizado.
 */

class Whiteboard {
  constructor(canvasId, cursorLayerId, boardSocket, userMeta) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.cursorLayer = document.getElementById(cursorLayerId);
    this.socket = boardSocket;
    this.user = userMeta;

    this.currentTool = 'pen';
    this.currentColor = userMeta.color || '#1e1e1e';
    this.currentSize = 4;
    this.isDrawing = false;

    this.currentStroke = null;
    this.pendingPoints = [];
    this.flushScheduled = false;
    this.allStrokes = [];
    this.remoteStrokes = new Map();
    this.remoteCursors = new Map();
    this.resizeTimer = null;

    this.previewCanvas = document.createElement('canvas');
    this.previewCtx = this.previewCanvas.getContext('2d');
    this.previewCanvas.style.position = 'absolute';
    this.previewCanvas.style.top = '0';
    this.previewCanvas.style.left = '0';
    this.previewCanvas.style.pointerEvents = 'none';
    this.previewCanvas.style.zIndex = '5';
    this.canvas.parentElement.insertBefore(this.previewCanvas, this.cursorLayer);

    this.initCanvasSize();
    this.bindEvents();
    this.setupSocketEvents();
  }

  initCanvasSize(attempt = 0) {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();

    if ((rect.width < 2 || rect.height < 2) && attempt < 10) {
      requestAnimationFrame(() => this.initCanvasSize(attempt + 1));
      return;
    }

    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.max(1, Math.round(this.width * dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.previewCanvas.width = this.canvas.width;
    this.previewCanvas.height = this.canvas.height;
    this.previewCanvas.style.width = `${this.width}px`;
    this.previewCanvas.style.height = `${this.height}px`;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redrawAll();
    this.redrawPreview();
    this.repositionCursors();
  }

  toNorm(x, y) {
    return {
      x: this.width ? x / this.width : 0,
      y: this.height ? y / this.height : 0
    };
  }

  toPx(stroke, x, y) {
    if (stroke && stroke.norm) {
      return { x: x * this.width, y: y * this.height };
    }
    return { x, y };
  }

  getCoordinates(e) {
    const rect = this.canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : (e.changedTouches ? e.changedTouches[0] : e);
    return {
      x: point.clientX - rect.left,
      y: point.clientY - rect.top
    };
  }

  bindEvents() {
    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.initCanvasSize(), 80);
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.handleStart(e);
    });

    window.addEventListener('pointermove', (e) => this.handleMove(e));
    window.addEventListener('pointerup', (e) => this.handleEnd(e));
    window.addEventListener('pointercancel', (e) => this.handleEnd(e));

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    let lastCursorSend = 0;
    this.canvas.addEventListener('pointermove', (e) => {
      const now = Date.now();
      if (now - lastCursorSend < 30) return;
      lastCursorSend = now;
      const coords = this.getCoordinates(e);
      const norm = this.toNorm(coords.x, coords.y);
      this.socket.volatile.emit('cursor-move', norm);
    });

    this.canvas.addEventListener('pointerleave', () => {
      this.socket.volatile.emit('cursor-move', { x: -1, y: -1 });
    });
  }

  newStrokeId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  handleStart(e) {
    const { x, y } = this.getCoordinates(e);
    const norm = this.toNorm(x, y);
    this.isDrawing = true;
    this.pendingPoints = [];

    this.currentStroke = {
      id: this.newStrokeId(),
      userId: this.socket.id,
      tool: this.currentTool,
      color: this.currentColor,
      size: this.currentTool === 'eraser' ? this.currentSize * 2 : this.currentSize,
      norm: true,
      points: [{ x: norm.x, y: norm.y }],
      shape: null
    };

    this.socket.emit('draw-start', {
      strokeId: this.currentStroke.id,
      tool: this.currentStroke.tool,
      color: this.currentStroke.color,
      size: this.currentStroke.size,
      x: norm.x,
      y: norm.y
    });

    this.redrawPreview();
  }

  handleMove(e) {
    if (!this.isDrawing || !this.currentStroke) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) return;

    const { x, y } = this.getCoordinates(e);
    const norm = this.toNorm(x, y);
    const points = this.currentStroke.points;
    const last = points[points.length - 1];
    const dx = (norm.x - last.x) * this.width;
    const dy = (norm.y - last.y) * this.height;
    if (Math.hypot(dx, dy) < 1.2) return;

    if (this.currentTool === 'pen' || this.currentTool === 'eraser') {
      points.push(norm);
      this.pendingPoints.push(norm);
    } else {
      this.currentStroke.shape = {
        startX: points[0].x,
        startY: points[0].y,
        endX: norm.x,
        endY: norm.y
      };
    }

    this.scheduleFlush();
    this.redrawPreview();
  }

  scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      if (!this.currentStroke) return;
      if (this.currentStroke.shape) {
        this.socket.emit('draw-step', { shape: this.currentStroke.shape });
        return;
      }
      if (!this.pendingPoints.length) return;
      const points = this.pendingPoints;
      this.pendingPoints = [];
      this.socket.emit('draw-step', { points });
    });
  }

  handleEnd(e) {
    if (!this.isDrawing || !this.currentStroke) return;
    this.isDrawing = false;

    if (e && (e.clientX != null || e.changedTouches)) {
      const { x, y } = this.getCoordinates(e.changedTouches ? e.changedTouches[0] : e);
      const norm = this.toNorm(x, y);
      if (this.currentTool === 'pen' || this.currentTool === 'eraser') {
        this.currentStroke.points.push(norm);
      } else {
        const start = this.currentStroke.points[0];
        this.currentStroke.shape = {
          startX: start.x,
          startY: start.y,
          endX: norm.x,
          endY: norm.y
        };
      }
    }

    const stroke = this.currentStroke;
    this.currentStroke = null;
    this.pendingPoints = [];
    this.allStrokes.push(stroke);

    if (stroke.tool === 'eraser') this.redrawAll();
    else this.drawStroke(this.ctx, stroke);

    this.redrawPreview();
    this.socket.emit('draw-end', { stroke });
  }

  drawShape(ctx, tool, x1, y1, x2, y2) {
    ctx.beginPath();
    if (tool === 'line') {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (tool === 'rect') {
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else if (tool === 'circle') {
      const radiusX = Math.abs(x2 - x1) / 2;
      const radiusY = Math.abs(y2 - y1) / 2;
      const centerX = Math.min(x1, x2) + radiusX;
      const centerY = Math.min(y1, y2) + radiusY;
      ctx.ellipse(centerX, centerY, Math.max(radiusX, 0.5), Math.max(radiusY, 0.5), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawSmooth(ctx, points) {
    if (!points.length) return;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  drawStroke(ctx, stroke) {
    if (!stroke) return;
    ctx.save();
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;

    if (stroke.shape) {
      const start = this.toPx(stroke, stroke.shape.startX, stroke.shape.startY);
      const end = this.toPx(stroke, stroke.shape.endX, stroke.shape.endY);
      this.drawShape(ctx, stroke.tool, start.x, start.y, end.x, end.y);
    } else if (stroke.points && stroke.points.length) {
      const pixels = stroke.points.map((point) => this.toPx(stroke, point.x, point.y));
      this.drawSmooth(ctx, pixels);
    }

    ctx.restore();
  }

  redrawAll() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (const stroke of this.allStrokes) this.drawStroke(this.ctx, stroke);
  }

  redrawPreview() {
    this.previewCtx.clearRect(0, 0, this.width, this.height);
    if (this.currentStroke) this.drawPreviewStroke(this.currentStroke);
    for (const stroke of this.remoteStrokes.values()) this.drawPreviewStroke(stroke);
  }

  drawPreviewStroke(stroke) {
    if (stroke.tool === 'eraser') {
      this.previewCtx.save();
      this.previewCtx.globalAlpha = 0.35;
      this.previewCtx.strokeStyle = '#e53935';
      this.previewCtx.fillStyle = '#e53935';
      this.previewCtx.lineWidth = stroke.size;
      this.previewCtx.lineCap = 'round';
      this.previewCtx.lineJoin = 'round';
      const pixels = (stroke.points || []).map((point) => this.toPx(stroke, point.x, point.y));
      this.drawSmooth(this.previewCtx, pixels);
      this.previewCtx.restore();
      return;
    }
    this.drawStroke(this.previewCtx, stroke);
  }

  setupSocketEvents() {
    this.socket.on('init-state', ({ strokes, users }) => {
      this.allStrokes = strokes || [];
      this.redrawAll();
      (users || []).forEach((user) => {
        this.updateRemoteCursor(user.id, user.username, user.color, user.x, user.y);
      });
    });

    this.socket.on('draw-start', (data) => {
      this.remoteStrokes.set(data.userId, {
        id: data.strokeId,
        userId: data.userId,
        tool: data.tool,
        color: data.color,
        size: data.size,
        norm: true,
        points: [{ x: data.x, y: data.y }],
        shape: null
      });
      this.redrawPreview();
    });

    this.socket.on('draw-step', (data) => {
      const stroke = this.remoteStrokes.get(data.userId);
      if (!stroke) return;
      if (data.points) stroke.points.push(...data.points);
      if (data.x != null && data.y != null) stroke.points.push({ x: data.x, y: data.y });
      if (data.shape) stroke.shape = data.shape;
      this.redrawPreview();
    });

    this.socket.on('draw-end', ({ userId, stroke }) => {
      this.remoteStrokes.delete(userId);
      if (stroke && !this.allStrokes.some((item) => item.id === stroke.id)) {
        this.allStrokes.push(stroke);
        if (stroke.tool === 'eraser') this.redrawAll();
        else this.drawStroke(this.ctx, stroke);
      }
      this.redrawPreview();
    });

    this.socket.on('draw-cancel', ({ userId }) => {
      this.remoteStrokes.delete(userId);
      this.redrawPreview();
    });

    this.socket.on('undo', ({ strokeId }) => {
      const index = this.allStrokes.findIndex((stroke) => stroke.id === strokeId);
      if (index === -1) return;
      this.allStrokes.splice(index, 1);
      this.redrawAll();
    });

    this.socket.on('board-cleared', () => {
      this.allStrokes = [];
      this.remoteStrokes.clear();
      this.redrawAll();
      this.redrawPreview();
    });

    this.socket.on('cursor-update', ({ userId, username, color, x, y }) => {
      this.updateRemoteCursor(userId, username, color, x, y);
    });

    this.socket.on('user-left', ({ userId }) => {
      this.removeRemoteCursor(userId);
      this.remoteStrokes.delete(userId);
      this.redrawPreview();
    });
  }

  updateRemoteCursor(userId, username, color, x, y) {
    if (x < 0 || y < 0) {
      this.removeRemoteCursor(userId);
      return;
    }

    const px = x <= 1 && y <= 1 ? x * this.width : x;
    const py = x <= 1 && y <= 1 ? y * this.height : y;

    let cursorEl = this.remoteCursors.get(userId);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'user-cursor';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'cursor-pointer-svg');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.86a.5.5 0 0 0-.85.35z');
      path.setAttribute('fill', color || '#1a73e8');
      path.setAttribute('stroke', '#ffffff');
      path.setAttribute('stroke-width', '1.5');
      svg.appendChild(path);

      const tag = document.createElement('div');
      tag.className = 'cursor-tag';
      tag.style.backgroundColor = color || '#1a73e8';
      tag.textContent = username || 'Participante';

      cursorEl.append(svg, tag);
      this.cursorLayer.appendChild(cursorEl);
      this.remoteCursors.set(userId, cursorEl);
    }

    cursorEl.dataset.nx = String(x);
    cursorEl.dataset.ny = String(y);
    cursorEl.style.left = `${px}px`;
    cursorEl.style.top = `${py}px`;
  }

  repositionCursors() {
    for (const cursorEl of this.remoteCursors.values()) {
      const x = Number(cursorEl.dataset.nx);
      const y = Number(cursorEl.dataset.ny);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) continue;
      const px = x <= 1 && y <= 1 ? x * this.width : x;
      const py = x <= 1 && y <= 1 ? y * this.height : y;
      cursorEl.style.left = `${px}px`;
      cursorEl.style.top = `${py}px`;
    }
  }

  removeRemoteCursor(userId) {
    const cursorEl = this.remoteCursors.get(userId);
    if (!cursorEl) return;
    cursorEl.remove();
    this.remoteCursors.delete(userId);
  }

  clearBoard() {
    this.socket.emit('clear-board');
    this.allStrokes = [];
    this.remoteStrokes.clear();
    this.currentStroke = null;
    this.isDrawing = false;
    this.redrawAll();
    this.redrawPreview();
  }

  undo() {
    if (this.currentStroke) {
      const strokeId = this.currentStroke.id;
      this.isDrawing = false;
      this.currentStroke = null;
      this.pendingPoints = [];
      this.redrawPreview();
      this.socket.emit('draw-cancel', { strokeId });
      return true;
    }

    for (let i = this.allStrokes.length - 1; i >= 0; i--) {
      if (this.allStrokes[i].userId === this.socket.id) {
        const strokeId = this.allStrokes[i].id;
        this.allStrokes.splice(i, 1);
        this.redrawAll();
        this.socket.emit('undo', { strokeId });
        return true;
      }
    }
    return false;
  }

  downloadImage(filename = 'pizarra-colaborativa.png') {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this.canvas.width;
    exportCanvas.height = this.canvas.height;
    const ctx = exportCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(this.canvas, 0, 0);

    const link = document.createElement('a');
    link.download = filename;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }
}
