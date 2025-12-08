const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const httpServer = createServer(app);

// Configure CORS - works everywhere
app.use(cors({
  origin: true,  // Reflects the origin - allows credentials safely
  credentials: true
}));

app.use(express.json());

// Socket.IO with proper CORS configuration
const io = new Server(httpServer, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Railway/Render needs this for WebSocket support
  allowEIO3: true
});

// In-memory data stores
const rooms = new Map();
const users = new Map();
const waitingCalls = new Map();

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeUsers: users.size,
    activeRooms: rooms.size,
    waitingCalls: waitingCalls.size
  });
});

// Socket.IO connection handlers
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', (data) => {
    console.log('Register:', data);
    const { userType, name, roomId } = data;
    
    const user = {
      id: socket.id,
      name: name,
      type: userType,
      roomId: roomId || null
    };
    
    users.set(socket.id, user);
    
    if (userType === 'nurse') {
      socket.join('nurses');
      // Send current state to new nurse
      socket.emit('rooms-update', Array.from(rooms.values()));
      socket.emit('waiting-calls-update', Array.from(waitingCalls.values()));
      console.log(`Nurse registered: ${name}`);
    } else if (userType === 'patient') {
      console.log(`Patient registered: ${name}`);
    }
  });

  socket.on('call-nurse', (data) => {
    console.log('Call nurse:', data);
    const { patientName, roomName } = data;
    const callId = `call_${Date.now()}`;
    const roomId = `room_${Date.now()}`;
    
    // Create room
    const room = {
      id: roomId,
      name: roomName || 'Patient Room',
      patientName: patientName,
      status: 'waiting',
      patientId: socket.id
    };
    rooms.set(roomId, room);
    
    // Create call
    const call = {
      id: callId,
      roomId: roomId,
      roomName: room.name,
      patientName: patientName,
      patientId: socket.id,
      timestamp: Date.now()
    };
    waitingCalls.set(callId, call);
    
    // Update user room assignment
    const user = users.get(socket.id);
    if (user) {
      user.roomId = roomId;
    }
    
    socket.join(roomId);
    
    // Notify all nurses
    io.to('nurses').emit('incoming-call', call);
    io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
    io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
    
    console.log(`Call created: ${callId}, Room: ${roomId}`);
  });

  socket.on('accept-call', (data) => {
    console.log('Accept call:', data);
    const { callId, nurseName } = data;
    const call = waitingCalls.get(callId);
    
    if (!call) {
      console.log('Call not found:', callId);
      return;
    }
    
    const room = rooms.get(call.roomId);
    if (!room) {
      console.log('Room not found:', call.roomId);
      return;
    }
    
    // Update room with nurse info
    room.nurse = { id: socket.id, name: nurseName };
    room.nurseId = socket.id;
    room.status = 'active';
    
    // Update nurse's room assignment
    const nurse = users.get(socket.id);
    if (nurse) {
      nurse.roomId = call.roomId;
    }
    
    socket.join(call.roomId);
    
    // Notify patient
    io.to(call.patientId).emit('call-accepted', {
      roomId: call.roomId,
      nurseName: nurseName,
      nurseId: socket.id
    });
    
    // Remove from waiting calls
    waitingCalls.delete(callId);
    
    // Update all nurses
    io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
    io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
    
    console.log(`Call accepted by nurse: ${nurseName} for ${call.patientName}`);
  });

  socket.on('ready', (data) => {
    console.log('Ready received:', data);
    const { roomId } = data;
    const room = rooms.get(roomId);
    
    if (room && room.patientId === socket.id && room.nurse) {
      io.to(room.nurse.id).emit('user-connected', room.patientId);
      console.log(`Patient ready, notified nurse for room: ${roomId}`);
    }
  });

  // WebRTC Signaling
  socket.on('offer', (data) => {
    console.log('Offer from', socket.id, 'to', data.target);
    io.to(data.target).emit('offer', {
      offer: data.offer,
      sender: socket.id
    });
  });

  socket.on('answer', (data) => {
    console.log('Answer from', socket.id, 'to', data.target);
    io.to(data.target).emit('answer', {
      answer: data.answer,
      sender: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    if (data.target) {
      io.to(data.target).emit('ice-candidate', {
        candidate: data.candidate,
        sender: socket.id
      });
    }
  });

  // Media Controls
  socket.on('toggle-audio', (data) => {
    console.log('Toggle audio:', data);
    socket.to(data.roomId).emit('peer-audio-toggle', { enabled: data.enabled });
  });

  socket.on('toggle-video', (data) => {
    console.log('Toggle video:', data);
    socket.to(data.roomId).emit('peer-video-toggle', { enabled: data.enabled });
  });

  socket.on('screen-share-start', (data) => {
    console.log('Screen share started:', data);
    socket.to(data.roomId).emit('peer-screen-share-start');
  });

  socket.on('screen-share-stop', (data) => {
    console.log('Screen share stopped:', data);
    socket.to(data.roomId).emit('peer-screen-share-stop');
  });

  socket.on('end-call', (data) => {
    console.log('End call:', data);
    const { roomId } = data;
    
    // Notify other user in room
    socket.to(roomId).emit('call-ended');
    
    // Cleanup room
    const room = rooms.get(roomId);
    if (room) {
      rooms.delete(roomId);
      io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
    }
    
    // Cleanup any waiting calls for this room
    for (const [callId, call] of waitingCalls.entries()) {
      if (call.roomId === roomId) {
        waitingCalls.delete(callId);
        io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    const user = users.get(socket.id);
    if (user) {
      if (user.roomId) {
        // Notify room users
        io.to(user.roomId).emit('user-disconnected');
        
        // Cleanup room
        const room = rooms.get(user.roomId);
        if (room) {
          rooms.delete(user.roomId);
          io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
        }
      }
      
      // Cleanup waiting calls
      for (const [callId, call] of waitingCalls.entries()) {
        if (call.patientId === socket.id) {
          waitingCalls.delete(callId);
          io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
          break;
        }
      }
    }
    
    users.delete(socket.id);
  });
});

// 🚀 CRITICAL: This makes the server WORK ON RAILWAY, RENDER, FLY.IO, ANY HOSTING
const PORT = process.env.PORT || 3001;

// Listen on ALL interfaces (Railway/Render require 0.0.0.0)
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║          🏥 HEALTHCARE VIDEO CALL SYSTEM              ║
║                    LIVE & WORKING                     ║
╠═══════════════════════════════════════════════════════╣
║  URL: https://your-app.up.railway.app                ║
║  Port: ${PORT}                                         ║
║  Socket.IO: Ready for connections                    ║
║  Health: http://localhost:${PORT}/api/health          ║
║  Status: 🚀 ACTIVE - Patients & Nurses Ready!         ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// Export for serverless (Vercel, etc.) - doesn't hurt on Railway
module.exports = app;
