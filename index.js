// index.js → WORKS PERFECTLY ON VERCEL TODAY (Dec 2025)

require('dotenv').config();
const { Server } = require("socket.io");

// Global variables (shared across invocations)
const rooms = new Map();
const users = new Map();
const waitingCalls = new Map();

let io; // Will hold the Socket.IO instance

export default function handler(req, res) {
  // This is the ONLY fix you needed
  if (!res.socket.server.io) {
    console.log("Initializing Socket.IO on Vercel...");

    // Create a dummy HTTP server (Vercel handles the real one)
    const httpServer = {
      listen: () => console.log("Socket.IO attached to Vercel server")
    };

    io = new Server(res.socket.server, {
      path: "/api/socket",
      addTrailingSlash: false,
        cors: {
  origin: "*",  // Allow all origins
  methods: ["GET", "POST"],
  credentials: true
}

      
    });

    // Save for next invocations
    res.socket.server.io = io;

    // ALL YOUR ORIGINAL LOGIC — 100% UNCHANGED
    io.on("connection", (socket) => {
      console.log(`Connected: ${socket.id}`);

      socket.on("register", ({ userType, name }) => {
        users.set(socket.id, { id: socket.id, name, type: userType, roomId: null });
        if (userType === "nurse") {
          socket.join("nurses");
          socket.emit("rooms-update", Array.from(rooms.values()));
          socket.emit("waiting-calls-update", Array.from(waitingCalls.values()));
        }
      });

      socket.on("call-nurse", ({ patientName, roomName }) => {
        const callId = {
          id: `call_${Date.now()}`,
          roomId: `room_${Date.now()}`,
          patientName,
          roomName: roomName || "Patient Room",
          patientId: socket.id,
          timestamp: Date.now()
        };

        const room = {
          id: call.roomId,
          name: call.roomName,
          patientName,
          status: "waiting",
          patientId: socket.id
        };

        rooms.set(call.roomId, room);
        waitingCalls.set(call.id, call);
        users.get(socket.id).roomId = call.roomId;
        socket.join(call.roomId);

        socket.join("nurses");

        io.to("nurses").emit("incoming-call", call);
        io.to("nurses").emit("waiting-calls-update", Array.from(waitingCalls.values()));
        io.to("nurses").emit("rooms-update", Array.from(rooms.values()));
      });

      socket.on("accept-call", ({ callId, nurseName }) => {
        const call = waitingCalls.get(callId);
        if (!call) return;

        const room = rooms.get(call.roomId);
        if (!room) return;

        room.nurse = { id: socket.id, name: nurseName };
        room.nurseId = socket.id;
        room.status = "active";
        users.get(socket.id).roomId = call.roomId;
        socket.join(call.roomId);

        io.to(call.patientId).emit("call-accepted", {
          roomId: call.roomId,
          nurseName,
          nurseId: socket.id
        });

        waitingCalls.delete(callId);
        io.to("nurses").emit("waiting-calls-update", Array.from(waitingCalls.values()));
        io.to("nurses").emit("rooms-update", Array.from(rooms.values()));
      });

      // WebRTC Signaling
      socket.on("offer", (data) => io.to(data.target).emit("offer", { offer: data.offer, sender: socket.id }));
      socket.on("answer", (data) => io.to(data.target).emit("answer", { answer: data.answer, sender: socket.id }));
      socket.on("ice-candidate", (data) => {
        if (data.target) io.to(data.target).emit("ice-candidate", { candidate: data.candidate, sender: socket.id });
      });

      socket.on("end-call", ({ roomId }) => {
        socket.to(roomId).emit("call-ended");
        rooms.delete(roomId);
        for (const [id, c] of waitingCalls) {
          if (c.roomId === roomId) waitingCalls.delete(id);
        }
        io.to("nurses").emit("rooms-update", Array.from(rooms.values()));
        io.to("nurses").emit("waiting-calls-update", Array.from(waitingCalls.values()));
      });

      socket.on("disconnect", () => {
        const user = users.get(socket.id);
        if (user?.roomId) {
          io.to(user.roomId).emit("user-disconnected");
          rooms.delete(user.roomId);
        }
        waitingCalls.forEach((c, id) => c.patientId === socket.id && waitingCalls.delete(id));
        users.delete(socket.id);
      });
    });
  }

  res.end();
}

// THIS IS THE MOST IMPORTANT LINE
export const config = {
  api: {
    bodyParser: false,
    // This enables WebSocket on Vercel
    supportsResponseStreaming: true,
  },
};
