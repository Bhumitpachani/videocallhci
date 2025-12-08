const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const httpServer = createServer(app);

// Configure CORS
app.use(cors({
  origin: '*',
  credentials: true
}));

app.use(express.json());

// Socket.IO with CORS
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Store data
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

// Socket.IO handlers
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', (data) => {
    console.log('Register:', data);
    const { userType, name, roomId } = data;
    
    users.set(socket.id, {
      id: socket.id,
      name: name,
      type: userType,
      roomId: roomId || null
    });

    if (userType === 'nurse') {
      socket.join('nurses');
      io.to(socket.id).emit('rooms-update', Array.from(rooms.values()));
      io.to(socket.id).emit('waiting-calls-update', Array.from(waitingCalls.values()));
    } else if (userType === 'patient') {
      console.log('Patient registered:', name);
    }
  });

  socket.on('call-nurse', (data) => {
    console.log('Call nurse:', data);
    const { patientName, roomName } = data;
    const callId = `call_${Date.now()}`;
    const roomId = `room_${Date.now()}`;
    
    const room = {
      id: roomId,
      name: roomName || 'Patient Room',
      patientName: patientName,
      status: 'waiting',
      patientId: socket.id
    };
    rooms.set(roomId, room);
    
    const call = {
      id: callId,
      roomId: roomId,
      roomName: roomName || 'Patient Room',
      patientName: patientName,
      patientId: socket.id,
      timestamp: Date.now()
    };
    waitingCalls.set(callId, call);
    
    const user = users.get(socket.id);
    if (user) {
      user.roomId = roomId;
    }
    socket.join(roomId);
    
    io.to('nurses').emit('incoming-call', call);
    io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
    io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
    
    console.log('Call created:', callId, 'Room:', roomId);
  });

  socket.on('accept-call', (data) => {
    console.log('Accept call:', data);
    const { callId, nurseName } = data;
    const call = waitingCalls.get(callId);
    
    if (call) {
      const room = rooms.get(call.roomId);
      if (room) {
        room.nurse = { id: socket.id, name: nurseName };
        room.nurseId = socket.id;
        room.status = 'active';
        
        const nurse = users.get(socket.id);
        if (nurse) {
          nurse.roomId = call.roomId;
        }
        
        socket.join(call.roomId);
        
        io.to(call.patientId).emit('call-accepted', {
          roomId: call.roomId,
          nurseName: nurseName,
          nurseId: socket.id
        });
        
        waitingCalls.delete(callId);
        
        io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
        io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
        
        console.log('Call accepted by nurse:', nurseName);
      }
    }
  });

  socket.on('ready', (data) => {
    console.log('Ready received:', data);
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (room && room.patientId === socket.id && room.nurse) {
      io.to(room.nurse.id).emit('user-connected', room.patientId);
      console.log('Patient ready, notified nurse for room:', roomId);
    }
  });

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

  socket.on('toggle-audio', (data) => {
    socket.to(data.roomId).emit('peer-audio-toggle', { enabled: data.enabled });
  });

  socket.on('toggle-video', (data) => {
    socket.to(data.roomId).emit('peer-video-toggle', { enabled: data.enabled });
  });

  socket.on('screen-share-start', (data) => {
    socket.to(data.roomId).emit('peer-screen-share-start');
  });

  socket.on('screen-share-stop', (data) => {
    socket.to(data.roomId).emit('peer-screen-share-stop');
  });

  socket.on('end-call', (data) => {
    console.log('End call:', data);
    const { roomId } = data;
    
    socket.to(roomId).emit('call-ended');
    
    const room = rooms.get(roomId);
    if (room) {
      rooms.delete(roomId);
      io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
    }
    
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
        io.to(user.roomId).emit('user-disconnected');
        
        const room = rooms.get(user.roomId);
        if (room) {
          rooms.delete(user.roomId);
          io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
        }
      }
      
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

const PORT = process.env.PORT || 3001;

// For Vercel, we need to export the app
if (process.env.NODE_ENV !== 'production') {
  httpServer.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║   Healthcare Video Call System - Server Running      ║
╠═══════════════════════════════════════════════════════╣
║   Server: http://localhost:${PORT}                        ║
║   Status: Active                                      ║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

module.exports = app;
