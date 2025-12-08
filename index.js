require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
let server;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100 
});
app.use(limiter);

const corsOptions = {
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST'],
  credentials: true
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const useHttps = fs.existsSync('server.crt') && fs.existsSync('server.key');
if (useHttps) {
  console.log('Using HTTPS');
  const options = {
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.crt')
  };
  server = https.createServer(options, app);
} else {
  console.log('Using HTTP (generate certs for HTTPS)');
  server = http.createServer(app);
}

const io = socketIO(server, {
  cors: corsOptions
});

const rooms = new Map();
const users = new Map();
const waitingCalls = new Map();

app.get('/', (req, res) => {
  res.json({ message: 'Healthcare Video Call Backend Running', timestamp: new Date().toISOString() });
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('register', (data) => {
    console.log('Register:', data);
    const { userType, name } = data;
    
    users.set(socket.id, {
      id: socket.id,
      name,
      type: userType,
      roomId: null
    });

    if (userType === 'nurse') {
      socket.join('nurses');
      io.to(socket.id).emit('rooms-update', Array.from(rooms.values()));
      io.to(socket.id).emit('waiting-calls-update', Array.from(waitingCalls.values()));
    }
    console.log(`Registered ${userType}: ${name}`);
  });

  socket.on('call-nurse', (data) => {
    const { patientName, roomName } = data;
    const callId = `call_${Date.now()}`;
    const roomId = `room_${Date.now()}`;
    
    const room = {
      id: roomId,
      name: roomName || 'Patient Room',
      patientName,
      status: 'waiting',
      patientId: socket.id
    };
    rooms.set(roomId, room);
    
    const call = {
      id: callId,
      roomId,
      roomName: roomName || 'Patient Room',
      patientName,
      patientId: socket.id,
      timestamp: Date.now()
    };
    waitingCalls.set(callId, call);
    
    const user = users.get(socket.id);
    if (user) user.roomId = roomId;
    socket.join(roomId);
    
    io.to('nurses').emit('incoming-call', call);
    io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
    io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
    
    console.log(`Call created: ${callId} for room ${roomId}`);
  });

  socket.on('accept-call', (data) => {
    const { callId, nurseName } = data;
    const call = waitingCalls.get(callId);
    
    if (call) {
      const room = rooms.get(call.roomId);
      if (room) {
        room.nurse = { id: socket.id, name: nurseName };
        room.nurseId = socket.id;
        room.status = 'active';
        
        const nurse = users.get(socket.id);
        if (nurse) nurse.roomId = call.roomId;
        
        socket.join(call.roomId);
        
        io.to(call.patientId).emit('call-accepted', {
          roomId: call.roomId,
          nurseName,
          nurseId: socket.id
        });
        
        waitingCalls.delete(callId);
        io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
        io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
        
        console.log(`Call accepted: ${nurseName} for room ${room.id}`);
      }
    }
  });

  socket.on('ready', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (room && room.patientId === socket.id && room.nurse) {
      io.to(room.nurse.id).emit('user-connected', room.patientId);
      console.log(`Patient ready for room ${roomId}`);
    }
  });

  // WebRTC Signaling
  socket.on('offer', (data) => {
    io.to(data.target).emit('offer', { offer: data.offer, sender: socket.id });
  });

  socket.on('answer', (data) => {
    io.to(data.target).emit('answer', { answer: data.answer, sender: socket.id });
  });

  socket.on('ice-candidate', (data) => {
    if (data.target) {
      io.to(data.target).emit('ice-candidate', { candidate: data.candidate, sender: socket.id });
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
    const { roomId } = data;
    socket.to(roomId).emit('call-ended');
    
    const room = rooms.get(roomId);
    if (room) {
      rooms.delete(roomId);
      io.to('nurses').emit('rooms-update', Array.from(rooms.values()));
    }
    
    for (const [id, call] of waitingCalls.entries()) {
      if (call.roomId === roomId) {
        waitingCalls.delete(id);
        io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
        break;
      }
    }
    console.log(`Call ended for room ${roomId}`);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
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
      
      for (const [id, call] of waitingCalls.entries()) {
        if (call.patientId === socket.id) {
          waitingCalls.delete(id);
          io.to('nurses').emit('waiting-calls-update', Array.from(waitingCalls.values()));
          break;
        }
      }
    }
    users.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`Server running on ${protocol}://localhost:${PORT}`);
  console.log(`For network: ${protocol}://YOUR-IP:${PORT} (use HTTPS for media permissions)`);
});