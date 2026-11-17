const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');

const { initBoardNamespace } = require('./namespaces/boardNamespace');
const { initSignalingNamespace } = require('./namespaces/signalingNamespace');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;

function isIPv4(net) {
  return net.family === 'IPv4' || net.family === 4;
}

function isVirtualInterface(name) {
  return /vpn|wsl|hyper-v|virtual|vethernet|docker|tunnel|vbox|vmware|bluetooth|loopback|npcap|tailscale|zerotier|hamachi|pseudo/i.test(name);
}

function getLocalIps() {
  const networkInterfaces = os.networkInterfaces();
  const localIps = [];

  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name] || []) {
      if (isIPv4(net) && !net.internal) {
        localIps.push({ interface: name, address: net.address });
      }
    }
  }

  const physical = localIps.filter((net) => !isVirtualInterface(net.interface));
  return physical.length ? physical : localIps;
}

async function ensureCertificate(ips) {
  const dir = path.join(__dirname, '../.certs');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const metaPath = path.join(dir, 'meta.json');
  const wanted = ['127.0.0.1', ...ips].sort().join(',');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.ips === wanted) {
      return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath)
      };
    }
  }

  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip }))
  ];

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(metaPath, JSON.stringify({ ips: wanted }));

  return { cert: pems.cert, key: pems.private };
}

function printBanner(localIps, httpsReady) {
  console.log('====================================================');
  console.log('Servidor de Pizarra y WebRTC en ejecucion');
  console.log(`Local:        http://localhost:${PORT}`);
  if (httpsReady) {
    console.log(`Local seguro: https://localhost:${HTTPS_PORT}`);
  }

  for (const net of localIps) {
    console.log(`Otra PC:      http://${net.address}:${PORT}`);
    if (httpsReady) {
      console.log(`Camara/mic:   https://${net.address}:${HTTPS_PORT}`);
    }
  }

  if (httpsReady) {
    console.log('La primera vez el navegador avisa del certificado.');
    console.log('Entra en Avanzado y continua. Sin eso no hay camara ni microfono en la otra PC.');
  }
  console.log('====================================================');
}

async function start() {
  const localIps = getLocalIps();
  let httpsReady = false;

  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/room/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/room.html'));
  });

  app.get('/api/info', (req, res) => {
    const ips = getLocalIps();
    const host = ips[0]?.address;
    res.json({
      port: PORT,
      httpsPort: httpsReady ? HTTPS_PORT : null,
      localIps: ips,
      suggestedUrl: httpsReady && host
        ? `https://${host}:${HTTPS_PORT}`
        : `http://localhost:${PORT}`
    });
  });

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  const boardNs = io.of('/board');
  initBoardNamespace(boardNs);

  const signalingNs = io.of('/signaling');
  initSignalingNamespace(signalingNs);

  let httpsServer = null;
  try {
    const credentials = await ensureCertificate(localIps.map((net) => net.address));
    httpsServer = https.createServer(credentials, app);
    io.engine.attach(httpsServer);
    io.attachServe(httpsServer);
    httpsReady = true;
  } catch (err) {
    console.error('No se pudo iniciar HTTPS. Camara y microfono solo funcionaran en localhost.');
    console.error(err);
  }

  await new Promise((resolve) => httpServer.listen(PORT, '0.0.0.0', resolve));

  if (httpsServer) {
    await new Promise((resolve, reject) => {
      httpsServer.once('error', reject);
      httpsServer.listen(HTTPS_PORT, '0.0.0.0', resolve);
    });
  }

  printBanner(localIps, httpsReady);
}

start().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
