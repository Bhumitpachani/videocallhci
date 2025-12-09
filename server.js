// server.js
// Professional Node.js backend for nurse-patient video call system
// Optimized for Vercel serverless deployment with Socket.io

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const httpServer = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Socket.io configuration optimized for Vercel
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  allowEIO3: true,
});

// ============================================
// STATE MANAGEMENT (Use Redis in production)
// ============================================

const state = {
  users: new Map(), // socketId -> { id, role, busy, socketId }
  userSockets: new Map(), // userId -> socketId
  activeCalls: new Map(), // userId -> partnerId
  waitingQueue: [], // [patientIds]
};

// ============================================
// HELPER FUNCTIONS
// ============================================

const getUserBySocketId = (socketId) => state.users.get(socketId);
const getUserById = (userId) => {
  const socketId = state.userSockets.get(userId);
  return socketId ? state.users.get(socketId) : null;
};

const getOnlineUsers = () => {
  return Array.from(state.users.values()).map(({ id, role, busy }) => ({
    id,
    role,
    busy,
  }));
};

const setUserBusy = (userId, busy) => {
  const user = getUserById(userId);
  if (user) {
    user.busy = busy;
    state.users.set(user.socketId, user);
  }
};

const broadcastOnlineUsers = () => {
  io.emit('onlineUsers', getOnlineUsers());
};

const startCall = (callerId, calleeId) => {
  const caller = getUserById(callerId);
  const callee = getUserById(calleeId);

  if (!caller || !callee) {
    return { success: false, error: 'User not found' };
  }

  setUserBusy(callerId, true);
  setUserBusy(calleeId, true);
  state.activeCalls.set(callerId, calleeId);
  state.activeCalls.set(calleeId, callerId);

  io.to(callee.socketId).emit('incomingCall', {
    from: callerId,
    callerRole: caller.role,
  });

  broadcastOnlineUsers();

  return { success: true };
};

const endCall = (userId) => {
  const partnerId = state.activeCalls.get(userId);
  if (!partnerId) return;

  const user = getUserById(userId);
  const partner = getUserById(partnerId);

  if (user) setUserBusy(userId, false);
  if (partner) {
    setUserBusy(partnerId, false);
    io.to(partner.socketId).emit('callEnded', {
      from: userId,
      reason: 'User ended call',
    });
  }

  state.activeCalls.delete(userId);
  state.activeCalls.delete(partnerId);

  // Notify nurse of next waiting patient
  if (user?.role === 'nurse' && state.waitingQueue.length > 0) {
    io.to(user.socketId).emit('waitingPatient', {
      patientId: state.waitingQueue[0],
      queueLength: state.waitingQueue.length,
    });
  }

  broadcastOnlineUsers();
};

const cleanupUser = (socketId) => {
  const user = state.users.get(socketId);
  if (!user) return;

  // End active call
  if (state.activeCalls.has(user.id)) {
    endCall(user.id);
  }

  // Remove from waiting queue
  const queueIndex = state.waitingQueue.indexOf(user.id);
  if (queueIndex !== -1) {
    state.waitingQueue.splice(queueIndex, 1);
  }

  // Cleanup state
  state.users.delete(socketId);
  state.userSockets.delete(user.id);

  broadcastOnlineUsers();
  console.log(`[CLEANUP] ${user.role} ${user.id} removed`);
};

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log(`[CONNECT] Socket ${socket.id} connected`);

  // ============================================
  // REGISTRATION
  // ============================================
  socket.on('register', ({ userId, role }) => {
    try {
      // Validation
      if (!userId || typeof userId !== 'string') {
        return socket.emit('error', { message: 'Invalid user ID' });
      }
      if (!['nurse', 'patient'].includes(role)) {
        return socket.emit('error', { message: 'Invalid role' });
      }

      // Check if userId already exists
      if (state.userSockets.has(userId)) {
        const existingSocketId = state.userSockets.get(userId);
        // If same socket, ignore
        if (existingSocketId === socket.id) {
          return socket.emit('registered', { userId, role });
        }
        return socket.emit('error', { message: 'User ID already registered' });
      }

      // Register user
      const userData = {
        id: userId,
        role,
        busy: false,
        socketId: socket.id,
      };

      state.users.set(socket.id, userData);
      state.userSockets.set(userId, socket.id);

      socket.emit('registered', { userId, role });
      broadcastOnlineUsers();

      console.log(`[REGISTER] ${role} ${userId} registered`);
    } catch (error) {
      console.error('[REGISTER ERROR]', error);
      socket.emit('error', { message: 'Registration failed' });
    }
  });

  // ============================================
  // CALL INITIATION
  // ============================================
  socket.on('callUser', ({ calleeId }) => {
    try {
      const caller = getUserBySocketId(socket.id);
      if (!caller) {
        return socket.emit('error', { message: 'Not registered' });
      }

      const callee = getUserById(calleeId);
      if (!callee) {
        return socket.emit('error', { message: 'User not found or offline' });
      }

      // Prevent same-role calls
      if (caller.role === callee.role) {
        return socket.emit('error', { message: 'Cannot call users with same role' });
      }

      // Check if callee is busy
      if (callee.busy) {
        if (caller.role === 'patient' && callee.role === 'nurse') {
          // Add to waiting queue
          if (!state.waitingQueue.includes(caller.id)) {
            state.waitingQueue.push(caller.id);
            io.to(callee.socketId).emit('waitingPatient', {
              patientId: caller.id,
              queueLength: state.waitingQueue.length,
            });
          }
          socket.emit('callWaiting', {
            message: 'Nurse is busy. You have been added to the queue.',
            queuePosition: state.waitingQueue.indexOf(caller.id) + 1,
          });
        } else {
          socket.emit('error', { message: 'User is currently busy' });
        }
        return;
      }

      // Start call
      const result = startCall(caller.id, callee.id);
      if (result.success) {
        socket.emit('callStarted', { to: calleeId });
      } else {
        socket.emit('error', { message: result.error });
      }
    } catch (error) {
      console.error('[CALL USER ERROR]', error);
      socket.emit('error', { message: 'Failed to initiate call' });
    }
  });

  // ============================================
  // ACCEPT WAITING PATIENT (Nurse only)
  // ============================================
  socket.on('acceptWaiting', ({ patientId }) => {
    try {
      const nurse = getUserBySocketId(socket.id);
      if (!nurse || nurse.role !== 'nurse') {
        return socket.emit('error', { message: 'Unauthorized action' });
      }

      const queueIndex = state.waitingQueue.indexOf(patientId);
      if (queueIndex === -1) {
        return socket.emit('error', { message: 'Patient not in queue' });
      }

      state.waitingQueue.splice(queueIndex, 1);

      const patient = getUserById(patientId);
      if (!patient) {
        return socket.emit('error', { message: 'Patient offline' });
      }

      const result = startCall(nurse.id, patientId);
      if (result.success) {
        io.to(patient.socketId).emit('callStarted', {
          from: nurse.id,
          role: nurse.role,
        });
      }
    } catch (error) {
      console.error('[ACCEPT WAITING ERROR]', error);
      socket.emit('error', { message: 'Failed to accept patient' });
    }
  });

  // ============================================
  // WEBRTC SIGNALING
  // ============================================
  socket.on('offer', ({ offer, to }) => {
    try {
      const from = getUserBySocketId(socket.id);
      const target = getUserById(to);

      if (!from || !target) return;

      io.to(target.socketId).emit('offer', {
        offer,
        from: from.id,
      });
    } catch (error) {
      console.error('[OFFER ERROR]', error);
    }
  });

  socket.on('answer', ({ answer, to }) => {
    try {
      const from = getUserBySocketId(socket.id);
      const target = getUserById(to);

      if (!from || !target) return;

      io.to(target.socketId).emit('answer', {
        answer,
        from: from.id,
      });
    } catch (error) {
      console.error('[ANSWER ERROR]', error);
    }
  });

  socket.on('ice-candidate', ({ candidate, to }) => {
    try {
      const from = getUserBySocketId(socket.id);
      const target = getUserById(to);

      if (!from || !target) return;

      io.to(target.socketId).emit('ice-candidate', {
        candidate,
        from: from.id,
      });
    } catch (error) {
      console.error('[ICE CANDIDATE ERROR]', error);
    }
  });

  // ============================================
  // CHAT MESSAGES
  // ============================================
  socket.on('chatMessage', ({ message, to }) => {
    try {
      const from = getUserBySocketId(socket.id);
      const target = getUserById(to);

      if (!from || !target) return;

      io.to(target.socketId).emit('chatMessage', {
        message,
        from: from.id,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('[CHAT MESSAGE ERROR]', error);
    }
  });

  // ============================================
  // END CALL
  // ============================================
  socket.on('endCall', ({ to }) => {
    try {
      const from = getUserBySocketId(socket.id);
      if (!from) return;

      if (state.activeCalls.get(from.id) === to) {
        endCall(from.id);
      }
    } catch (error) {
      console.error('[END CALL ERROR]', error);
    }
  });

  // ============================================
  // GET WAITING QUEUE (Nurse only)
  // ============================================
  socket.on('getWaitingQueue', () => {
    try {
      const user = getUserBySocketId(socket.id);
      if (!user || user.role !== 'nurse') return;

      socket.emit('waitingQueue', {
        queue: state.waitingQueue,
        length: state.waitingQueue.length,
      });
    } catch (error) {
      console.error('[GET QUEUE ERROR]', error);
    }
  });

  // ============================================
  // DISCONNECT
  // ============================================
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] Socket ${socket.id} disconnected`);
    cleanupUser(socket.id);
  });
});

// ============================================
// REST API ENDPOINTS
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    timestamp: new Date().toISOString(),
    service: 'Nurse-Patient Video Call System',
  });
});

// Get server statistics
app.get('/api/stats', (req, res) => {
  res.json({
    onlineUsers: state.users.size,
    activeCalls: state.activeCalls.size / 2,
    waitingQueue: state.waitingQueue.length,
    nurses: Array.from(state.users.values()).filter((u) => u.role === 'nurse').length,
    patients: Array.from(state.users.values()).filter((u) => u.role === 'patient').length,
  });
});

// Get online users (requires auth in production)
app.get('/api/users', (req, res) => {
  res.json({
    users: getOnlineUsers(),
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// SERVER START
// ============================================

const PORT = process.env.PORT || 3001;

if (process.env.NODE_ENV !== 'production') {
  httpServer.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║  🏥 Nurse-Patient Video Call System                  ║
║  Server running on port ${PORT}                         ║
║  Health: http://localhost:${PORT}                       ║
║  Stats: http://localhost:${PORT}/api/stats              ║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

// Export for Vercel
module.exports = httpServer;
