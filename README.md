# 🎨 Pizarra Colaborativa & Meet en Tiempo Real

Aplicación web de pizarra compartida en tiempo real y videollamada P2P estilo Google Meet, diseñada para colaborar entre diferentes computadoras y dispositivos.

---

## 🛠️ Tecnologías y Conceptos Clave

- **WebSockets (Socket.IO):**
  - **Namespaces:**
    - `/board`: Sincronización del lienzo en tiempo real (trazos, figuras, borrador, historial de trazos en memoria para nuevos usuarios y cursores colaborativos en vivo con etiquetas de nombre).
    - `/signaling`: Señalización e intercambio SDP/ICE para WebRTC.
  - **Rooms (Salas):** Aislamiento dinámico por sala (`join-room`). Solo los usuarios que comparten el mismo código de sala interactúan en la pizarra y se conectan a la llamada.
- **WebRTC:**
  - Comunicación Peer-to-Peer (malla WebRTC) para transmisión de audio, video y compartir pantalla en vivo.
  - Servidores STUN públicos de Google (`stun:stun.l.google.com:19302`) para atravesar NAT en conexiones multidispositivo.
- **Frontend (Vanilla JS + HTML5 Canvas):**
  - Soporte de alta densidad de píxeles (HiDPI / Retina).
  - Trazos suaves con curvas continuas.
  - Figuras geométricas con previsualización en vivo: Línea, Rectángulo, Círculo.
  - Paleta de colores, selector personalizado y control de grosor.
  - Deshacer (Undo), Limpiar pizarra y Exportar imagen PNG.

---

## 🚀 Cómo Iniciar el Proyecto

### 1. Iniciar el servidor
En la terminal del proyecto, ejecuta:

```bash
pnpm start
# o con recarga automática:
pnpm run dev
```

El servidor imprimirá en consola:
- Tu acceso local: `http://localhost:3000`
- Tu IP en la red local (para la otra computadora): `http://192.168.x.x:3000`

---

## 💻 Cómo Probarlo Entre Dos Computadoras

1. **En la Computadora A (Servidor):**
   - Inicia el servidor con `pnpm start`.
   - Abre tu navegador en `http://localhost:3000`.
   - Ingresa tu nombre, elige tu color de cursor y presiona **"Crear Nueva Sala"**.
   - Haz clic en **"Copiar enlace"** en la barra superior.

2. **En la Computadora B (Segunda máquina en la misma red Wi-Fi o red local):**
   - Asegúrate de estar conectado a la misma red Wi-Fi.
   - Abre en el navegador la dirección IP con el puerto que te muestra el servidor (por ejemplo: `http://192.168.3.112:3000/room/tu-codigo-de-sala`).
   - Ingresa el nombre del segundo participante.
   - ¡Listo! Podrás ver los trazos y el puntero del mouse del otro usuario en tiempo real, además de iniciar la videollamada y compartir pantalla.

> [!NOTE]
> Para probarlo en una sola máquina antes de pasar a otra PC, puedes abrir una pestaña normal en Chrome y otra pestaña en modo incógnito (o en otro navegador como Firefox o Edge) en `http://localhost:3000`.

---

## 📁 Estructura del Proyecto

```
webSockets/
├── src/
│   ├── server.js                   # Servidor Express, Socket.IO y detección de IP LAN
│   └── namespaces/
│       ├── boardNamespace.js       # Lógica del namespace /board (trazos, historial, cursores)
│       └── signalingNamespace.js   # Lógica del namespace /signaling (WebRTC SDP y candidatos ICE)
├── public/
│   ├── index.html                  # Página de inicio (crear sala / unirse con código)
│   ├── room.html                   # Sala principal: Pizarra + Videollamada Meet
│   ├── css/
│   │   └── style.css               # Estilos modernos Google Meet & Material Design
│   └── js/
│       ├── whiteboard.js           # Motor de dibujo en Canvas y cursores
│       ├── webrtc.js               # Gestor P2P de videollamada y medios
│       └── app.js                  # Coordinador y enlace a sockets
├── package.json
└── README.md
```
