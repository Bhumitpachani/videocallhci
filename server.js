// server.js
// Node.js backend for nurse-patient video call system using Express and Socket.io
// Features: Registration, bidirectional calls, waiting queue, WebRTC signaling, chat, busy status
// Deployable to Vercel (serverless) or traditional servers

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Restrict to your React app's URL in production
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000, // Helps with serverless environments like Vercel
});

// In-memory storage (use MongoDB/Redis in production)
const users = {}; // socket.id -> { id: userId, role: 'nurse'|'patient', busy: false }
const activeCalls = {}; // userId -> partnerId
const waitingQueue = []; // patientIds waiting for nurse

// Helper: Find socket.id by userId
const findSocketByUserId = (userId) => {
  return Object.keys(users).find((sid) => users[sid].id === userId);
};

// Helper: Get formatted online users list
const getOnlineUsers = () => {
  return Object.values(users).map((u) => ({
    id: u.id,
    role: u.role,
    busy: u.busy,
  }));
};

// Start a call between two users
const startCall = (callerId, calleeId) => {
  const callerSocket = findSocketByUserId(callerId);
  const calleeSocket = findSocketByUserId(calleeId);
  if (!callerSocket || !calleeSocket) return;

  users[callerSocket].busy = true;
  users[calleeSocket].busy = true;
  activeCalls[callerId] = calleeId;
  activeCalls[calleeId] = callerId;

  io.to(calleeSocket).emit('incomingCall', { from: callerId });
  io.emit('onlineUsers', getOnlineUsers());
};

// End a call and clean up
const endCall = (userId) => {
  const partnerId = activeCalls[userId];
  if (!partnerId) return;

  const userSocket = findSocketByUserId(userId);
  const partnerSocket = findSocketByUserId(partnerId);

  if (userSocket) users[userSocket].busy = false;
  if (partnerSocket) {
    users[partnerSocket].busy = false;
    io.to(partnerSocket).emit('callEnded', { from: userId });
  }

  delete activeCalls[userId];
  delete activeCalls[partnerId];

  // Notify nurse of next waiting patient
  const nurseId = users[userSocket]?.role === 'nurse' ? userId : partnerId;
  if (waitingQueue.length > 0 && nurseId) {
    const nurseSocket = findSocketByUserId(nurseId);
    if (nurseSocket) {
      io.to(nurseSocket).emit('waitingPatient', { patientId: waitingQueue[0] });
    }
  }

  io.emit('onlineUsers', getOnlineUsers());
};

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Register user
  socket.on('register', ({ userId, role }) => {
    if (!userId || !['nurse', 'patient'].includes(role)) {
      return socket.emit('error', 'Invalid registration');
    }
    if (Object.values(users).some((u) => u.id === userId)) {
      return socket.emit('error', 'User ID already taken');
    }
    users[socket.id] = { id: userId, role, busy: false };
    io.emit('onlineUsers', getOnlineUsers());
    console.log(`${role} ${userId} registered`);
  });

  // Initiate call
  socket.on('callUser', ({ calleeId }) => {
    const caller = users[socket.id];
    if (!caller) return socket.emit('error', 'Not registered');

    const calleeSocket = findSocketByUserId(calleeId);
    if (!calleeSocket) return socket.emit('error', 'Callee offline');

    const callee = users[calleeSocket];

    if (caller.role === callee.role) {
      return socket.emit('error', 'Cannot call same role');
    }

    if (callee.busy) {
      if (caller.role === 'patient' && callee.role === 'nurse') {
        if (!waitingQueue.includes(caller.id)) {
          waitingQueue.push(caller.id);
          io.to(calleeSocket).emit('waitingPatient', { patientId: caller.id });
        }
        socket.emit('callWaiting', 'Nurse is busy, added to queue');
      } else {
        socket.emit('error', 'Callee is busy');
      }
    } else {
      startCall(caller.id, callee.id);
      socket.emit('callStarted', { to: calleeId });
    }
  });

  // Nurse accepts waiting patient
  socket.on('acceptWaiting', ({ patientId }) => {
    const nurse = users[socket.id];
    if (!nurse || nurse.role !== 'nurse') return socket.emit('error', 'Not authorized');

    const queueIndex = waitingQueue.indexOf(patientId);
    if (queueIndex === -1) return socket.emit('error', 'Patient not waiting');

    waitingQueue.splice(queueIndex, 1);

    const patientSocket = findSocketByUserId(patientId);
    if (!patientSocket) return socket.emit('error', 'Patient offline');

    startCall(nurse.id, patientId);
    io.to(patientSocket).emit('callStarted', { from: nurse.id });
  });

  // WebRTC signaling
  socket.on('offer', ({ offer, to }) => {
    const toSocket = findSocketByUserId(to);
    if (toSocket) io.to(toSocket).emit('offer', { offer, from: users[socket.id].id });
  });

  socket.on('answer', ({ answer, to }) => {
    const toSocket = findSocketByUserId(to);
    if (toSocket) io.to(toSocket).emit('answer', { answer, from: users[socket.id].id });
  });

  socket.on('ice-candidate', ({ candidate, to }) => {
    const toSocket = findSocketByUserId(to);
    if (toSocket) io.to(toSocket).emit('ice-candidate', { candidate, from: users[socket.id].id });
  });

  // Chat message
  socket.on('chatMessage', ({ message, to }) => {
    const from = users[socket.id]?.id;
    if (!from) return;
    const toSocket = findSocketByUserId(to);
    if (toSocket) io.to(toSocket).emit('chatMessage', { message, from });
  });

  // End call
  socket.on('endCall', ({ to }) => {
    const from = users[socket.id]?.id;
    if (from && activeCalls[from] === to) {
      endCall(from);
    }
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      endCall(user.id);
      const queueIndex = waitingQueue.indexOf(user.id);
      if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1);
      delete users[socket.id];
      io.emit('onlineUsers', getOnlineUsers());
      console.log(`${user.role} ${user.id} disconnected`);
    }
  });
});

// Health check for deployment
app.get('/', (req, res) => res.json({ status: 'Server running' }));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});
