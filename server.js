const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.static(path.join(__dirname)));

// ══════════════════════════════════════
// MODERAZIONE
// ══════════════════════════════════════
const PAROLE_VIETATE = [
  'cazzo','vaffanculo','frocio','negro','troia','puttana','bastardo',
  'imbecille','ritardato','suicid','ammazzati','ucciditi','razzist',
  'terrorist','stupro','pezzo di merda','odio','vattene a fanculo',
  'gay di merda','negro di merda'
];
function isTossico(t) {
  const l = t.toLowerCase();
  return PAROLE_VIETATE.some(p => l.includes(p));
}
function uid() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// ══════════════════════════════════════
// STATO
// ══════════════════════════════════════
const bannatiIP  = new Set();
const bannatiID  = new Set();

// segnali[id] = { id, text, time, seekerSocketId, taken }
const segnali = new Map();

// rooms[segnaleId] = { seekerSocketId, listenerSocketId, closedBy: Set }
const rooms = new Map();

// eco words
let ecoWords = [
  { id: uid(), word: 'Ascoltato',  time: Date.now() - 3600000 },
  { id: uid(), word: 'Leggero',    time: Date.now() - 7200000 },
  { id: uid(), word: 'Vivo',       time: Date.now() - 10800000 },
  { id: uid(), word: 'Speranza',   time: Date.now() - 14400000 },
  { id: uid(), word: 'Grato',      time: Date.now() - 18000000 },
  { id: uid(), word: 'Capito',     time: Date.now() - 21600000 },
  { id: uid(), word: 'Sollievo',   time: Date.now() - 25200000 },
  { id: uid(), word: 'Meno solo',  time: Date.now() - 28800000 },
];

// statistiche
let stats = { date: oggi(), aiutoChiesto: 3, aiutoDato: 0, chatsCompletate: 0 };

function oggi() {
  return new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function resetStats() {
  const d = oggi();
  if (stats.date !== d) stats = { date: d, aiutoChiesto: 0, aiutoDato: 0, chatsCompletate: 0 };
}

// Segnali demo iniziali
['Ho passato una settimana difficile e non so con chi parlarne.',
 'Mi sento solo, anche in mezzo alla gente. Qualcuno capisce?',
 'Sto attraversando un momento di cambiamento difficile.']
.forEach((text, i) => {
  const id = uid() + uid();
  segnali.set(id, { id, text, time: Date.now() - (i+1)*120000, seekerSocketId: null, taken: false });
});

// ══════════════════════════════════════
// TTL: rimuovi segnali dopo 5 ore
// ══════════════════════════════════════
const TTL = 5 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of segnali) {
    if (!s.taken && (now - s.time) > TTL) {
      segnali.delete(id);
      changed = true;
    }
  }
  if (changed) io.emit('feed_aggiornato', getFeed());
}, 60 * 1000);

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════
function getFeed() {
  return Array.from(segnali.values())
    .filter(s => !s.taken)
    .sort((a, b) => b.time - a.time)
    .slice(0, 20);
}

function getSocket(id) {
  return id ? io.sockets.sockets.get(id) : null;
}

// ══════════════════════════════════════
// REST API
// ══════════════════════════════════════
app.get('/api/segnali', (_, res) => res.json(getFeed()));
app.get('/api/battito', (_, res) => { resetStats(); res.json(stats); });
app.get('/api/eco',     (_, res) => res.json(ecoWords.slice(-120)));
app.get('/api/health',  (_, res) => res.json({ ok: true, segnali: segnali.size, rooms: rooms.size }));

// ══════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════
io.on('connection', socket => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  const fp = socket.handshake.auth?.fp || '';

  // Controlla ban
  if (bannatiIP.has(ip) || bannatiID.has(fp)) {
    socket.emit('bannato');
    socket.disconnect(true);
    return;
  }

  socket.anonId = 'A' + uid();
  socket.emit('connesso', { anonId: socket.anonId });
  socket.emit('battito_update', stats);

  // ─────────────────────────────────
  // LANCIA SEGNALE (seeker)
  // ─────────────────────────────────
  socket.on('lancia_segnale', ({ text, fp }) => {
    resetStats();
    if (bannatiIP.has(ip) || bannatiID.has(fp)) { socket.emit('bannato'); socket.disconnect(true); return; }
    if (!text || text.trim().length < 3) return;
    if (isTossico(text)) {
      bannatiIP.add(ip); if (fp) bannatiID.add(fp);
      socket.emit('bannato'); socket.disconnect(true); return;
    }

    const id = uid() + uid();
    const segnale = { id, text: text.trim().slice(0, 300), time: Date.now(), seekerSocketId: socket.id, taken: false };
    segnali.set(id, segnale);

    // Crea la room e il seeker entra subito
    rooms.set(id, { seekerSocketId: socket.id, listenerSocketId: null, closedBy: new Set() });
    socket.join(id);
    socket.currentRoom = id;
    socket.ruolo = 'seeker';

    stats.aiutoChiesto++;
    io.emit('nuovo_segnale', segnale);
    io.emit('battito_update', stats);

    // Conferma al seeker con l'id della sua room
    socket.emit('segnale_lanciato', { segnaleId: id });
  });

  // ─────────────────────────────────
  // ENTRA COME ASCOLTATORE
  // ─────────────────────────────────
  socket.on('entra_chat', ({ segnaleId }) => {
    resetStats();
    const segnale = segnali.get(segnaleId);

    // Segnale non esiste o già preso
    if (!segnale || segnale.taken) {
      socket.emit('segnale_non_disponibile');
      return;
    }

    // Segna come preso → sparisce dal feed per tutti
    segnale.taken = true;
    io.emit('segnale_rimosso', segnaleId);

    // Entra nella room
    let room = rooms.get(segnaleId);
    if (!room) {
      room = { seekerSocketId: segnale.seekerSocketId, listenerSocketId: null, closedBy: new Set() };
      rooms.set(segnaleId, room);
      // Il seeker potrebbe essersi disconnesso nel frattempo
      // ma la room esiste comunque per ricevere messaggi
    }
    room.listenerSocketId = socket.id;
    socket.join(segnaleId);
    socket.currentRoom = segnaleId;
    socket.ruolo = 'ascoltatore';

    stats.aiutoDato++;
    io.emit('battito_update', stats);

    // Notifica l'ascoltatore
    socket.emit('chat_pronta', { ruolo: 'ascoltatore' });

    // Notifica il seeker che qualcuno è arrivato
    const seekerSocket = getSocket(room.seekerSocketId);
    if (seekerSocket) {
      seekerSocket.emit('ascoltatore_arrivato', { segnaleId });
    }

    // Messaggio di sistema a tutta la room
    io.to(segnaleId).emit('msg_sistema', { text: 'La connessione è stabilita. La chat è aperta. 🌿' });
  });

  // ─────────────────────────────────
  // MESSAGGIO
  // ─────────────────────────────────
  socket.on('messaggio', ({ segnaleId, text, fp }) => {
    if (bannatiIP.has(ip) || bannatiID.has(fp)) { socket.emit('bannato'); socket.disconnect(true); return; }
    if (!text || !text.trim()) return;

    if (isTossico(text)) {
      bannatiIP.add(ip); if (fp) bannatiID.add(fp);
      io.to(segnaleId).emit('msg_bloccato');
      socket.emit('bannato'); socket.disconnect(true); return;
    }

    io.to(segnaleId).emit('messaggio', {
      id: uid(),
      text: text.trim().slice(0, 500),
      anonId: socket.anonId,
      ruolo: socket.ruolo,
      time: Date.now()
    });
  });

  // ─────────────────────────────────
  // ADDIO GENTILE
  // ─────────────────────────────────
  socket.on('addio_gentile', ({ segnaleId }) => {
    const ADDIO = "Hey, purtroppo devo andare. Spero che un'altra anima ti presti ascolto. 🌿";

    io.to(segnaleId).emit('messaggio', {
      id: uid(), text: ADDIO,
      anonId: socket.anonId, ruolo: socket.ruolo,
      time: Date.now(), isAddio: true
    });

    const room = rooms.get(segnaleId);
    if (room) {
      room.closedBy.add(socket.id);
      io.to(segnaleId).emit('addio_ricevuto', { da: socket.ruolo });

      // Chiedi l'eco al seeker
      const seekerSocket = getSocket(room.seekerSocketId);
      if (seekerSocket) seekerSocket.emit('chiedi_eco');

      // Disintegrazione dopo 8 secondi
      setTimeout(() => {
        resetStats();
        stats.chatsCompletate++;
        io.to(segnaleId).emit('chat_disintegrata', { stats: { ...stats } });
        io.emit('battito_update', stats);
        rooms.delete(segnaleId);
        segnali.delete(segnaleId);
      }, 8000);
    }
  });

  // ─────────────────────────────────
  // ECO WORD
  // ─────────────────────────────────
  socket.on('invia_eco', ({ word }) => {
    if (!word || typeof word !== 'string') return;
    const clean = word.trim().replace(/[^a-zA-ZÀ-ÿ\s]/g, '').slice(0, 20);
    if (!clean || isTossico(clean)) return;
    const eco = { id: uid(), word: clean, time: Date.now() };
    ecoWords.push(eco);
    if (ecoWords.length > 500) ecoWords = ecoWords.slice(-500);
    io.emit('nuova_eco', eco);
  });

  // ─────────────────────────────────
  // DISCONNESSIONE
  // ─────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.currentRoom) {
      io.to(socket.currentRoom).emit('msg_sistema', {
        text: socket.ruolo === 'ascoltatore'
          ? "L'ascoltatore si è disconnesso. Puoi aspettare un altro o chiudere."
          : "Chi aveva lanciato il segnale si è disconnesso."
      });
    }
  });
});

// ══════════════════════════════════════
// START
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('✅  ascolta RE — DEFINITIVO');
  console.log(`👉  http://localhost:${PORT}`);
  console.log('');
});
