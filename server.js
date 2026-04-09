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

const PAROLE_VIETATE = [
  'cazzo','vaffanculo','frocio','negro','troia','puttana','bastardo',
  'imbecille','ritardato','suicid','ammazzati','ucciditi','razzist',
  'terrorist','stupro','pezzo di merda','odio','vattene a fanculo',
  'gay di merda','negro di merda'
];
function isTossico(t) { return PAROLE_VIETATE.some(p => t.toLowerCase().includes(p)); }
function uid() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

const bannatiIP = new Set();
const bannatiID = new Set();
const segnali   = new Map();
const rooms     = new Map();
const ascDisponibili = new Map();
let onlineCount = 0;

let ecoWords = [
  { id:uid(), word:'Ascoltato',  time:Date.now()-3600000  },
  { id:uid(), word:'Leggero',    time:Date.now()-7200000  },
  { id:uid(), word:'Vivo',       time:Date.now()-10800000 },
  { id:uid(), word:'Speranza',   time:Date.now()-14400000 },
  { id:uid(), word:'Grato',      time:Date.now()-18000000 },
  { id:uid(), word:'Capito',     time:Date.now()-21600000 },
  { id:uid(), word:'Sollievo',   time:Date.now()-25200000 },
  { id:uid(), word:'Meno solo',  time:Date.now()-28800000 },
  { id:uid(), word:'Respirare',  time:Date.now()-32400000 },
  { id:uid(), word:'Grazie',     time:Date.now()-36000000 },
];

let stats = { date: oggi(), aiutoChiesto: 3, aiutoDato: 0, chatsCompletate: 0 };

function oggi() {
  return new Date().toLocaleDateString('it-IT', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function resetStats() {
  const d = oggi();
  if (stats.date !== d) stats = { date:d, aiutoChiesto:0, aiutoDato:0, chatsCompletate:0 };
}
function broadcastOnline() {
  io.emit('online_count', { count: onlineCount, ascoltatori: ascDisponibili.size });
}

['Ho passato una settimana difficile e non so con chi parlarne.',
 'Mi sento solo anche in mezzo alla gente. Qualcuno capisce?',
 'Sto attraversando un momento di cambiamento difficile.']
.forEach((text, i) => {
  const id = uid()+uid();
  segnali.set(id, { id, text, time: Date.now()-(i+1)*180000, seekerSocketId:null, taken:false });
});

const TTL = 5 * 60 * 60 * 1000;
setInterval(() => {
  let changed = false;
  for (const [id, s] of segnali) {
    if (!s.taken && (Date.now()-s.time) > TTL) { segnali.delete(id); changed = true; }
  }
  if (changed) io.emit('feed_aggiornato', getFeed());
}, 60000);

function getFeed() {
  return Array.from(segnali.values())
    .filter(s => !s.taken)
    .sort((a, b) => b.time - a.time)
    .slice(0, 20);
}
function getSocket(id) { return id ? io.sockets.sockets.get(id) : null; }
function getIP(socket) {
  return (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || socket.handshake.address;
}

app.get('/api/segnali',  (_, res) => res.json(getFeed()));
app.get('/api/battito',  (_, res) => { resetStats(); res.json(stats); });
app.get('/api/eco',      (_, res) => res.json(ecoWords.slice(-120)));
app.get('/api/presenza', (_, res) => res.json({ online: onlineCount, ascoltatori: ascDisponibili.size }));
app.get('/api/health',   (_, res) => res.json({ ok:true }));

io.on('connection', socket => {
  const ip = getIP(socket);
  const fp = socket.handshake.auth?.fp || '';

  if (bannatiIP.has(ip) || bannatiID.has(fp)) {
    socket.emit('bannato'); socket.disconnect(true); return;
  }

  onlineCount++;
  socket.anonId = 'A'+uid();
  socket.emit('connesso', { anonId: socket.anonId });
  socket.emit('battito_update', stats);
  broadcastOnline();

  socket.on('lancia_segnale', ({ text, fp }) => {
    resetStats();
    if (bannatiIP.has(ip) || bannatiID.has(fp)) { socket.emit('bannato'); socket.disconnect(true); return; }
    if (!text || text.trim().length < 3) return;
    if (isTossico(text)) {
      bannatiIP.add(ip); if (fp) bannatiID.add(fp);
      socket.emit('bannato'); socket.disconnect(true); return;
    }
    const id = uid()+uid();
    const s = { id, text:text.trim().slice(0,300), time:Date.now(), seekerSocketId:socket.id, taken:false };
    segnali.set(id, s);
    rooms.set(id, { seekerSocketId:socket.id, listenerSocketId:null, closedBy:new Set() });
    socket.join(id);
    socket.currentRoom = id;
    socket.ruolo = 'seeker';
    stats.aiutoChiesto++;
    io.emit('nuovo_segnale', s);
    io.emit('battito_update', stats);
    socket.emit('segnale_lanciato', { segnaleId: id });
  });

  socket.on('sono_disponibile', () => {
    ascDisponibili.set(socket.id, { anonId: socket.anonId, since: Date.now() });
    socket.isDisponibile = true;
    broadcastOnline();
    socket.emit('disponibilita_confermata');
  });

  socket.on('non_disponibile', () => {
    ascDisponibili.delete(socket.id);
    socket.isDisponibile = false;
    broadcastOnline();
  });

  socket.on('entra_chat', ({ segnaleId }) => {
    resetStats();
    const seg = segnali.get(segnaleId);
    if (!seg || seg.taken) { socket.emit('segnale_non_disponibile'); return; }
    seg.taken = true;
    io.emit('segnale_rimosso', segnaleId);
    let room = rooms.get(segnaleId);
    if (!room) {
      room = { seekerSocketId: seg.seekerSocketId, listenerSocketId:null, closedBy:new Set() };
      rooms.set(segnaleId, room);
    }
    room.listenerSocketId = socket.id;
    socket.join(segnaleId);
    socket.currentRoom = segnaleId;
    socket.ruolo = 'ascoltatore';
    ascDisponibili.delete(socket.id);
    socket.isDisponibile = false;
    stats.aiutoDato++;
    io.emit('battito_update', stats);
    broadcastOnline();
    socket.emit('chat_pronta', { ruolo:'ascoltatore' });
    const sk = getSocket(room.seekerSocketId);
    if (sk) sk.emit('ascoltatore_arrivato', { segnaleId });
    io.to(segnaleId).emit('msg_sistema', { text:'La connessione è stabilita. La chat è aperta. 🌿' });
  });

  socket.on('typing_start', ({ segnaleId }) => {
    socket.to(segnaleId).emit('partner_typing', { typing:true });
  });
  socket.on('typing_stop', ({ segnaleId }) => {
    socket.to(segnaleId).emit('partner_typing', { typing:false });
  });

  socket.on('messaggio', ({ segnaleId, text, fp }) => {
    if (bannatiIP.has(ip) || bannatiID.has(fp)) { socket.emit('bannato'); socket.disconnect(true); return; }
    if (!text || !text.trim()) return;
    if (isTossico(text)) {
      bannatiIP.add(ip); if (fp) bannatiID.add(fp);
      io.to(segnaleId).emit('msg_bloccato');
      socket.emit('bannato'); socket.disconnect(true); return;
    }
    socket.to(segnaleId).emit('partner_typing', { typing:false });
    io.to(segnaleId).emit('messaggio', {
      id:uid(), text:text.trim().slice(0,500),
      anonId:socket.anonId, ruolo:socket.ruolo, time:Date.now()
    });
  });

  socket.on('addio_gentile', ({ segnaleId }) => {
    const ADDIO = "Hey, purtroppo devo andare. Spero che un'altra anima ti presti ascolto. 🌿";
    io.to(segnaleId).emit('messaggio', {
      id:uid(), text:ADDIO, anonId:socket.anonId,
      ruolo:socket.ruolo, time:Date.now(), isAddio:true
    });
    const room = rooms.get(segnaleId);
    if (room) {
      room.closedBy.add(socket.id);
      io.to(segnaleId).emit('addio_ricevuto', { da:socket.ruolo });
      const sk = getSocket(room.seekerSocketId);
      if (sk) sk.emit('chiedi_eco');
      setTimeout(() => {
        resetStats();
        stats.chatsCompletate++;
        io.to(segnaleId).emit('chat_disintegrata', { stats:{ ...stats } });
        io.emit('battito_update', stats);
        rooms.delete(segnaleId);
        segnali.delete(segnaleId);
      }, 8000);
    }
  });

  socket.on('invia_eco', ({ word }) => {
    if (!word || typeof word !== 'string') return;
    const clean = word.trim().replace(/[^a-zA-ZÀ-ÿ\s]/g,'').slice(0,20);
    if (!clean || isTossico(clean)) return;
    const eco = { id:uid(), word:clean, time:Date.now() };
    ecoWords.push(eco);
    if (ecoWords.length > 500) ecoWords = ecoWords.slice(-500);
    io.emit('nuova_eco', eco);
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount-1);
    ascDisponibili.delete(socket.id);
    broadcastOnline();
    if (socket.currentRoom) {
      io.to(socket.currentRoom).emit('msg_sistema', {
        text: socket.ruolo === 'ascoltatore'
          ? "L'ascoltatore si è disconnesso. Puoi aspettare o chiudere con 🌿 Saluta."
          : "Chi aveva lanciato il segnale si è disconnesso."
      });
      socket.to(socket.currentRoom).emit('partner_typing', { typing:false });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅  ascolta RE — ULTIMATE\n👉  http://localhost:${PORT}\n`);
});
