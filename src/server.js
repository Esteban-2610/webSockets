const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { initBoardNamespace } = require('./namespaces/boardNamespace');
const { initSignalingNamespace } = require('./namespaces/signalingNamespace');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../public')));

// Ruta amigable para unirse a una sala específica: /room/:roomId
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/room.html'));
});

// Endpoint para obtener la IP de la máquina en la red local (para conectar otra PC)
app.get('/api/info', (req, res) => {
  const networkInterfaces = os.networkInterfaces();
  const localIps = [];

  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      // Filtrar IPv4 y que no sea loopback interno (127.0.0.1)
      if (net.family === 'IPv4' && !net.internal) {
        localIps.push({ interface: name, address: net.address });
      }
    }
  }

  res.json({
    port: PORT,
    localIps,
    suggestedUrl: localIps.length > 0 ? `http://${localIps[0].address}:${PORT}` : `http://localhost:${PORT}`
  });
});

// Inicializar Namespaces de Socket.IO
const boardNs = io.of('/board');
initBoardNamespace(boardNs);

const signalingNs = io.of('/signaling');
initSignalingNamespace(signalingNs);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Servidor de Pizarra y WebRTC en ejecución`);
  console.log(`📍 Local:   http://localhost:${PORT}`);

  const networkInterfaces = os.networkInterfaces();
  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`🌐 En tu red (otra PC): http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`====================================================`);
});
