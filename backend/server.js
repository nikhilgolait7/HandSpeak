
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

const wss = new WebSocket.Server({
  noServer: true
});

const PORT = process.env.PORT || 3000;

const DEVICE_TOKEN = process.env.DEVICE_TOKEN;
const CAREGIVER_TOKEN = process.env.CAREGIVER_TOKEN;
const PATIENT_ID = process.env.PATIENT_ID || "patient-001";

// Connected clients
const clients = new Map();

// Patient state
const patientState = {
  online: false,
  temperature: null,
  lastSeen: null
};

const REQUESTS = {
  water: {
    message: "Patient needs water",
    priority: "normal"
  },

  medicine: {
    message: "Patient needs medicine",
    priority: "high"
  },

  food: {
    message: "Patient needs food",
    priority: "normal"
  },

  help: {
    message: "Patient needs help",
    priority: "high"
  },

  emergency: {
    message: "Patient requires emergency assistance",
    priority: "critical"
  }
};

// ---------------- BROADCAST ----------------

function broadcast(data, target = "caregiver") {

  const payload = JSON.stringify(data);

  for (const [ws, client] of clients.entries()) {

    if (
      ws.readyState === WebSocket.OPEN &&
      (target === "all" || client.role === target)
    ) {
      ws.send(payload);
    }
  }
}

// ---------------- EXPO PUSH ----------------

async function sendExpoPush(type, requestId) {

  const messageMap = {
    water: ["Water Request 💧", "Patient needs water"],
    medicine: ["Medicine Request 💊", "Patient needs medicine"],
    food: ["Food Request 🍎", "Patient needs food"],
    help: ["Patient Needs Help 🆘", "Patient requests help"],
    emergency: ["🚨 EMERGENCY", "Patient requires immediate assistance"]
  };

  const [title, body] = messageMap[type];

  // Tokens will be added by caregiver app
  const tokens = [...pushTokens];

  if (!tokens.length) return;

  const messages = tokens.map(token => ({
    to: token,
    sound: "default",
    priority: "high",
    channelId: "patient-alerts",
    title,
    body,
    data: {
      patientId: PATIENT_ID,
      requestId,
      type
    }
  }));

  try {

    const response = await fetch(
      "https://exp.host/--/api/v2/push/send",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },

        body: JSON.stringify(messages)
      }
    );

    if (!response.ok) {
      throw new Error(`Expo error ${response.status}`);
    }

    console.log("Push result:", await response.json());

  } catch (error) {
    console.error("Push notification error:", error);
  }
}

const pushTokens = new Set();

// ---------------- HEALTH CHECK ----------------

app.get("/", (req, res) => {

  res.json({
    name: "HandSpeak API",
    status: "running",
    websocket: "enabled"
  });
});

// ---------------- HTTP HISTORY ----------------

app.get("/api/requests", async (req, res) => {

  if (req.headers.authorization !==
      `Bearer ${CAREGIVER_TOKEN}`) {

    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  try {

    const requests = await PatientRequest
      .find({ patientId: PATIENT_ID })
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(requests);

  } catch (error) {

    res.status(500).json({
      error: "Database error"
    });
  }
});

// ---------------- WEBSOCKET UPGRADE ----------------

server.on("upgrade", (request, socket, head) => {

  const url = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token");

  const authorized =
    (role === "device" && token === DEVICE_TOKEN) ||
    (role === "caregiver" && token === CAREGIVER_TOKEN);

  if (!authorized) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(
    request,
    socket,
    head,
    ws => {
      wss.emit("connection", ws, role);
    }
  );
});

// ---------------- WEBSOCKET CONNECTION ----------------

wss.on("connection", (ws, role) => {

  clients.set(ws, { role });

  console.log(`${role} connected`);

  if (role === "device") {

    patientState.online = true;
    patientState.lastSeen = new Date();

    broadcast({
      event: "device_status",
      online: true,
      lastSeen: patientState.lastSeen
    });
  }

  ws.send(JSON.stringify({
    event: "connected",
    role,
    patientId: PATIENT_ID
  }));

  // Send current patient state to caregiver
  if (role === "caregiver") {

    ws.send(JSON.stringify({
      event: "patient_state",
      ...patientState
    }));
  }

  ws.on("message", async raw => {

    try {

      const data = JSON.parse(raw.toString());

      // -------- DEVICE MESSAGES --------

      if (role === "device") {

        if (data.event === "temperature") {

          const temperature = Number(data.value);

          if (
            !Number.isFinite(temperature) ||
            temperature < -20 ||
            temperature > 100
          ) return;

          patientState.temperature = temperature;
          patientState.lastSeen = new Date();

          broadcast({
            event: "temperature",
            value: temperature,
            timestamp: patientState.lastSeen
          });

        }

        else if (data.event === "request") {

          const details = REQUESTS[data.type];

          if (!details) return;

          const temperature = Number(data.temperature);

          const record = await PatientRequest.create({

            patientId: PATIENT_ID,

            type: data.type,

            message: details.message,

            priority: details.priority,

            temperature:
              Number.isFinite(temperature)
                ? temperature
                : null

          });

          const response = {

            event: "patient_request",

            id: record._id.toString(),

            type: record.type,

            message: record.message,

            priority: record.priority,

            temperature: record.temperature,

            acknowledged: false,

            createdAt: record.createdAt

          };

          broadcast(response);

          // Notify caregiver even if app is backgrounded
          await sendExpoPush(
            record.type,
            record._id.toString()
          );

          ws.send(JSON.stringify({
            event: "request_received",
            id: record._id.toString()
          }));
        }
      }

      // -------- CAREGIVER MESSAGES --------

      if (role === "caregiver") {

        if (data.event === "register_push") {

          if (
            typeof data.token === "string" &&
            /^ExponentPushToken\[.+\]$/.test(data.token)
          ) {
            pushTokens.add(data.token);
          }
        }

        else if (data.event === "acknowledge") {

          const record = await PatientRequest.findOneAndUpdate(
            {
              _id: data.id,
              patientId: PATIENT_ID
            },

            {
              acknowledged: true,
              acknowledgedAt: new Date()
            },

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
      }

    } catch (error) {

      console.error("WebSocket message error:", error);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: "error",
          message: "Invalid message"
        }));
      }
    }
  });

  ws.on("close", () => {

    clients.delete(ws);

    console.log(`${role} disconnected`);

    if (role === "device") {

      const anotherDevice = [...clients.values()]
        .some(client => client.role === "device");

      if (!anotherDevice) {

        patientState.online = false;

        broadcast({
          event: "device_status",
          online: false
        });
      }
    }
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