require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const cors = require("cors");

const PatientRequest = require("./models/Request");

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// WebSocket server (for the Caregiver Expo App)
const wss = new WebSocket.Server({
  noServer: true
});

const PORT = process.env.PORT || 3000;

const DEVICE_TOKEN = process.env.DEVICE_TOKEN;
const CAREGIVER_TOKEN = process.env.CAREGIVER_TOKEN;
const PATIENT_ID = process.env.PATIENT_ID || "patient-001";

// Connected caregiver clients
const clients = new Map();

// Patient state
const patientState = {
  online: false,
  temperature: null,
  lastSeen: null
};

const REQUESTS = {
  water: { message: "Patient needs water", priority: "normal" },
  medicine: { message: "Patient needs medicine", priority: "high" },
  food: { message: "Patient needs food", priority: "normal" },
  help: { message: "Patient needs help", priority: "high" },
  emergency: { message: "Patient requires emergency assistance", priority: "critical" }
};

// ---------------- BROADCAST TO CAREGIVER APP ----------------
function broadcast(data, target = "caregiver") {
  const payload = JSON.stringify(data);
  for (const [ws, client] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN && (target === "all" || client.role === target)) {
      ws.send(payload);
    }
  }
}

// ---------------- EXPO PUSH ----------------
const pushTokens = new Set();

async function sendExpoPush(type, requestId) {
  const messageMap = {
    water: ["Water Request 💧", "Patient needs water"],
    medicine: ["Medicine Request 💊", "Patient needs medicine"],
    food: ["Food Request 🍎", "Patient needs food"],
    help: ["Patient Needs Help 🆘", "Patient requests help"],
    emergency: ["🚨 EMERGENCY", "Patient requires immediate assistance"]
  };

  const [title, body] = messageMap[type];
  const tokens = [...pushTokens];

  if (!tokens.length) return;

  const messages = tokens.map(token => ({
    to: token,
    sound: "default",
    priority: "high",
    channelId: "patient-alerts",
    title,
    body,
    data: { patientId: PATIENT_ID, requestId, type }
  }));

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(messages)
    });
    if (!response.ok) throw new Error(`Expo error ${response.status}`);
    console.log("Push result:", await response.json());
  } catch (error) {
    console.error("Push notification error:", error);
  }
}

// ---------------- HEALTH CHECK ----------------
app.get("/", (req, res) => {
  res.json({ name: "HandSpeak API", status: "running", websocket: "enabled" });
});

// ---------------- ESP8266 HTTP ENDPOINT ----------------
app.post("/api/esp-data", async (req, res) => {
  const { token } = req.query;
  
  // Verify the device token
  if (token !== DEVICE_TOKEN) {
    return res.status(401).json({ error: "Unauthorized device" });
  }

  const data = req.body;

  // Mark patient as online whenever data arrives
  patientState.online = true;
  patientState.lastSeen = new Date();
  broadcast({ event: "device_status", online: true, lastSeen: patientState.lastSeen });

  // Handle Temperature updates
  if (data.event === "temperature") {
    patientState.temperature = data.value;
    broadcast({
      event: "temperature",
      value: data.value,
      timestamp: patientState.lastSeen
    });
  }

  // Handle Button Press requests
  if (data.event === "request") {
    const details = REQUESTS[data.type];
    if (details) {
      const record = await PatientRequest.create({
        patientId: PATIENT_ID,
        type: data.type,
        message: details.message,
        priority: details.priority,
        temperature: data.temperature || null
      });

      broadcast({
        event: "patient_request",
        id: record._id.toString(),
        type: record.type,
        message: record.message,
        priority: record.priority,
        temperature: record.temperature,
        acknowledged: false,
        createdAt: record.createdAt
      });

      await sendExpoPush(record.type, record._id.toString());
    }
  }

  res.json({ success: true });
});

// ---------------- HTTP HISTORY ----------------
app.get("/api/requests", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${CAREGIVER_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const requests = await PatientRequest
      .find({ patientId: PATIENT_ID })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------- WEBSOCKET UPGRADE (FOR EXPO APP) ----------------
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token");

  // Only caregivers can connect via WebSocket
  if (role !== "caregiver" || token !== CAREGIVER_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit("connection", ws, role);
  });
});

// ---------------- WEBSOCKET CONNECTION ----------------
wss.on("connection", (ws, role) => {
  clients.set(ws, { role });
  console.log(`${role} connected via WebSocket`);

  ws.send(JSON.stringify({
    event: "connected",
    role,
    patientId: PATIENT_ID
  }));

  // Send current patient state immediately
  ws.send(JSON.stringify({
    event: "patient_state",
    ...patientState
  }));

  ws.on("message", async raw => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === "register_push") {
        if (typeof data.token === "string" && /^ExponentPushToken\[.+\]$/.test(data.token)) {
          pushTokens.add(data.token);
          console.log("Registered push token");
        }
      }

      else if (data.event === "acknowledge") {
        const record = await PatientRequest.findOneAndUpdate(
          { _id: data.id, patientId: PATIENT_ID },
          { acknowledged: true, acknowledgedAt: new Date() },
          { new: true }
        );

        if (record) {
          broadcast({
            event: "request_acknowledged",
            id: record._id.toString(),
            acknowledged: true,
            acknowledgedAt: record.acknowledgedAt
          }, "all");
        }
      }

    } catch (error) {
      console.error("WebSocket message error:", error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "error", message: "Invalid message" }));
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`${role} disconnected`);
  });
});

// ---------------- DATABASE + SERVER ----------------
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`HandSpeak running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  });