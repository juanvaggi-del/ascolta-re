const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CONFIGURAZIONE SOCKET.IO PER IL CLOUD
const io = new Server(server, { 
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    } 
});

app.use(cors());
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════
// MODERAZIONE & UTILITY
// ═══════════════════════════════════
const PAROLE_VIETATE = ['cazzo','vaffanculo','frocio','negro','troia','puttana','bastardo','imbecille','ritardato','suicid','ammazzati','ucciditi','razzist','terrorist','stupro','pezzo di merda','odio','vattene a fanculo'];
function isTossico(t){ const l=t.toLowerCase(); return PAROLE_VIETATE.some(p=>l.includes(p)); }
function nuovoId(){ return 'U'+crypto.randomBytes(4).toString('hex').toUpperCase(); }

// ═══════════════════════════════════
// STATO GLOBALE (In memoria)
// ═══════════════════════════════════
let segnali = [
  { id:crypto.randomUUID(), text:"Ho passato una settimana difficile...", time:Date.now(), anonId:nuovoId(), taken:false },
  { id:crypto.randomUUID(), text:"Mi sento solo, qualcuno capisce?", time:Date.now(), anonId:nuovoId(), taken:false }
];
let ecoWords = [{ id:crypto.randomUUID(), word:'Ascoltato', time:Date.now() }];
let stats = { aiutoChiesto: 2, aiutoDato: 0, chatsCompletate: 0 };

// ═══════════════════════════════════
// API REST
// ═══════════════════════════════════
app.get('/api/segnali', (_, res) => res.json(segnali.filter(s => !s.taken).reverse()));
app.get('/api/health', (_, res) => res.json({ status: 'running' }));

// ═══════════════════════════════════
// LOGICA WEBSOCKET
// ═══════════════════════════════════
io.on('connection', (socket) => {
    socket.anonId = nuovoId();
    socket.emit('connesso', { anonId: socket.anonId });
    socket.emit('battito_update', stats);

    // Lancia Segnale
    socket.on('lancia_segnale', ({ text }) => {
        if (!text || isTossico(text)) return;
        const s = { id: crypto.randomUUID(), text: text.trim(), time: Date.now(), anonId: socket.anonId, taken: false };
        segnali.push(s);
        stats.aiutoChiesto++;
        io.emit('nuovo_segnale', s);
        io.emit('battito_update', stats);
    });

    // Messaggistica semplice
    socket.on('messaggio', ({ segnaleId, text }) => {
        if (isTossico(text)) return;
        io.to(segnaleId).emit('messaggio', {
            text: text.trim(),
            anonId: socket.anonId,
            time: Date.now()
        });
    });

    socket.on('join_room', (id) => {
        socket.join(id);
    });
});

// ═══════════════════════════════════
// IL MOTORE (FIX RAILWAY)
// ═══════════════════════════════════
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    -------------------------------------------
    🚀 ASCOLTA.RE ENGINE ONLINE
    📍 Porta assegnata: ${PORT}
    🏠 Modalità: PROD (Railway)
    -------------------------------------------
    `);
});