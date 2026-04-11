const express = require('express');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== قاعدة بيانات في الذاكرة =====
const licenses = new Map(); // key: activationCode -> { username, used, usedAt, createdAt }
const sessions = new Map(); // key: sessionToken -> { username, expiresAt }
const rooms = new Map();    // key: roomCode -> { locked: boolean, hostId: string, players: Map }

// ===== مفتاح المدير (غيّره!) =====
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'hojas-admin-2024';

// ===== دوال مساعدة =====
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function isValidSession(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return session;
}

function authMiddleware(req, res, next) {
    const token = req.headers['x-session-token'] || req.query.token;
    const session = isValidSession(token);
    if (!session) return res.status(401).json({ error: 'غير مصرح' });
    req.user = session;
    next();
}

// ===== API التفعيل =====
app.post('/api/login', (req, res) => {
    const { username, activationCode } = req.body;
    if (!username || !activationCode) return res.status(400).json({ error: 'يرجى إدخال اليوزر ورقم التفعيل' });

    const cleanUsername = username.trim().toLowerCase();
    const cleanCode = activationCode.trim().toUpperCase();
    const license = licenses.get(cleanCode);

    if (!license) return res.status(403).json({ error: 'رقم التفعيل غير صحيح' });
    if (license.username !== cleanUsername) return res.status(403).json({ error: 'هذا الرقم غير مخصص لهذا المستخدم' });

    const token = generateToken();
    if (!license.used) {
        license.used = true;
        license.usedAt = new Date().toISOString();
    }
    
    sessions.set(token, {
        username: cleanUsername,
        expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000)
    });

    res.json({ success: true, token, username: cleanUsername });
});

app.get('/api/verify', authMiddleware, (req, res) => {
    res.json({ valid: true, username: req.user.username });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['x-session-token'];
    if (token) sessions.delete(token);
    res.json({ success: true });
});

// ===== API لوحة التحكم =====
function adminAuth(req, res, next) {
    const secret = req.headers['x-admin-secret'] || req.query.secret;
    if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'غير مصرح' });
    next();
}

app.post('/api/admin/generate-license', adminAuth, (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'يرجى إدخال اليوزر' });
    const cleanUsername = username.trim().toLowerCase();
    let code;
    do {
        const part1 = crypto.randomBytes(3).toString('hex').toUpperCase();
        const part2 = crypto.randomBytes(3).toString('hex').toUpperCase();
        code = `HOJAS-${part1}-${part2}`;
    } while (licenses.has(code));

    licenses.set(code, {
        username: cleanUsername,
        used: false,
        usedAt: null,
        createdAt: new Date().toISOString()
    });
    res.json({ success: true, code, username: cleanUsername });
});

app.get('/api/admin/licenses', adminAuth, (req, res) => {
    const list = [];
    licenses.forEach((data, code) => list.push({ code, ...data }));
    res.json(list);
});

// ===== SOCKET.IO REAL-TIME LOGIC =====
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // Host (Main Game) joins
    socket.on('host-join', (roomCode) => {
        const cleanCode = roomCode.trim().toUpperCase();
        socket.join(cleanCode);
        socket.isHost = true;
        socket.roomCode = cleanCode;

        if (!rooms.has(cleanCode)) {
            rooms.set(cleanCode, { locked: false, hostId: socket.id, players: new Map() });
        } else {
            rooms.get(cleanCode).hostId = socket.id;
        }
        console.log(`Host joined room: ${cleanCode}`);
    });

    // Player (Mobile) joins
    socket.on('join-room', (data) => {
        const { roomCode, name, team } = data;
        if (!roomCode) return;

        const cleanCode = roomCode.trim().toUpperCase();
        socket.join(cleanCode);
        socket.userName = name;
        socket.userTeam = team;
        socket.roomCode = cleanCode;

        if (!rooms.has(cleanCode)) {
            rooms.set(cleanCode, { locked: false, hostId: null, players: new Map() });
        }
        const room = rooms.get(cleanCode);
        room.players.set(socket.id, { name, team });

        console.log(`Player ${name} (${team}) joined room: ${cleanCode}`);

        // Notify room members
        io.to(cleanCode).emit('joined', {
            name,
            team,
            buzzerLocked: room.locked
        });
    });

    // Handle Buzzer Press
    socket.on('buzz', () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        if (room.locked) return; // Already buzzed

        room.locked = true;
        console.log(`Buzzer hit by ${socket.userName} in ${roomCode}`);

        // Broadcast winner to everybody in the room
        io.to(roomCode).emit('buzzed', {
            id: socket.id,
            name: socket.userName || "لاعب مجهول",
            team: socket.userTeam || "team1"
        });
    });

    // Handle Reset (from Host)
    socket.on('reset-buzzes', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms.has(roomCode)) {
            rooms.get(roomCode).locked = false;
            rooms.get(roomCode).timedOutTeams = []; // إعادة ضبط قائمة الفرق المنتهية وقتها
            console.log(`Buzzers reset for room: ${roomCode}`);
            io.to(roomCode).emit('reset');
        }
    });

    // انتهى وقت فريق → التبديل للفريق الآخر
    socket.on('team-timeout', (data) => {
        const { roomCode, timedOutTeam, team1Name, team2Name } = data;
        if (!roomCode || !rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        if (!room.timedOutTeams) room.timedOutTeams = [];

        // إضافة هذا الفريق لقائمة المنتهيين
        if (!room.timedOutTeams.includes(timedOutTeam)) {
            room.timedOutTeams.push(timedOutTeam);
        }

        const nextTeam = timedOutTeam === 'team1' ? 'team2' : 'team1';
        const nextTeamName = timedOutTeam === 'team1' ? team2Name : team1Name;

        // إذا انتهى وقت كلا الفريقين → إعادة الضبط الكاملة تلقائياً
        if (room.timedOutTeams.length >= 2) {
            room.locked = false;
            room.timedOutTeams = [];
            console.log(`Both teams timed out in ${roomCode} — auto-reset`);
            io.to(roomCode).emit('reset');
        } else {
            // إرسال تبديل الفريق
            console.log(`Switching to ${nextTeam} in ${roomCode}`);
            io.to(roomCode).emit('switch-team', {
                nextTeam,
                nextTeamName
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomCode && rooms.has(socket.roomCode)) {
            const room = rooms.get(socket.roomCode);
            if (socket.isHost) {
                room.hostId = null;
            } else {
                room.players.delete(socket.id);
            }
        }
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`🚀 Buzzer Server running on port ${PORT}`);
});