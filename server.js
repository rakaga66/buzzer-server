const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ===== Application State =====
// rooms: rootMap -> roomCode -> Object
const rooms = new Map();

function getOrCreateRoom(roomCode) {
    if (!rooms.has(roomCode)) {
        rooms.set(roomCode, {
            code: roomCode,
            firstBuzzer: null,    // { id, name, team, time }
            buzzerLocked: false,
            hostSocketId: null,
            users: new Map()      // socketId -> { name, team }
        });
    }
    return rooms.get(roomCode);
}

// ===== Socket.io =====
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    let currentRoom = null;

    // 1. Host (7roof Game) joins to control a room
    socket.on('host-join', (roomCode) => {
        const rc = String(roomCode).toUpperCase().trim();
        if (!rc) return;

        socket.join(rc);
        currentRoom = rc;
        const room = getOrCreateRoom(rc);
        room.hostSocketId = socket.id;
        
        console.log(`Host joined room [${rc}]`);
        
        // Send initial state to host
        socket.emit('room-state', {
            users: Object.fromEntries(room.users),
            firstBuzzer: room.firstBuzzer,
            buzzerLocked: room.buzzerLocked
        });
    });

    // 2. Player joins from mobile/buzzer ui
    socket.on('join-room', (data) => {
        if (!data || !data.roomCode) return;
        const rc = String(data.roomCode).toUpperCase().trim();
        const safeName = String(data.name || '').trim().slice(0, 30) || 'مجهول';
        const team = String(data.team || 'team1'); // 'team1' or 'team2'

        socket.join(rc);
        currentRoom = rc;
        const room = getOrCreateRoom(rc);
        
        room.users.set(socket.id, { name: safeName, team });
        console.log(`Player [${safeName}] joined room [${rc}] on team [${team}]`);

        // Send confirmation to the player
        socket.emit('joined', {
            roomCode: rc,
            firstBuzzer: room.firstBuzzer,
            buzzerLocked: room.buzzerLocked,
            users: Object.fromEntries(room.users)
        });

        // Notify entire room (including host) about updated users
        io.to(rc).emit('users-update', Object.fromEntries(room.users));
    });

    // 3. Player hits the Buzzer
    socket.on('buzz', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        if (room.buzzerLocked) return; // Already buzzed

        const user = room.users.get(socket.id);
        if (!user) return;

        room.firstBuzzer = { 
            id: socket.id, 
            name: user.name, 
            team: user.team, 
            time: Date.now() 
        };
        room.buzzerLocked = true;

        console.log(`BUZZ in [${currentRoom}] by [${user.name}]`);

        // Broadcast to everyone in the room (Host + Players)
        io.to(currentRoom).emit('buzzed', room.firstBuzzer);
    });

    // 4. Host (or admin) resets the buzzer for the next round/question
    socket.on('reset-buzzes', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        room.firstBuzzer = null;
        room.buzzerLocked = false;
        
        console.log(`Buzzer RESET in [${currentRoom}]`);
        io.to(currentRoom).emit('reset');
    });

    // 5. Client disconnects
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (room) {
            // If it was host
            if (room.hostSocketId === socket.id) {
                room.hostSocketId = null;
            }
            // If it was a player
            if (room.users.has(socket.id)) {
                room.users.delete(socket.id);
                // Notify room about updated roster
                io.to(currentRoom).emit('users-update', Object.fromEntries(room.users));
            }

            // Cleanup empty rooms (optional, but good practice)
            if (room.users.size === 0 && !room.hostSocketId) {
                rooms.delete(currentRoom);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔔 Buzzer server running at http://localhost:${PORT}`);
});
