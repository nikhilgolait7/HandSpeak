import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Platform,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

// Show notifications even when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ---------------- CONFIG ----------------
// REPLACE with your PC's IPv4 address (run 'ipconfig' in CMD/PowerShell)
const SERVER_IP = '10.44.39.254'; 
const SERVER_PORT = 3000;
// REPLACE with the CAREGIVER_TOKEN from your backend .env
const CAREGIVER_TOKEN = 'handspeak123'; 

export default function App() {
  const ws = useRef(null);
  const [connected, setConnected] = useState(false);
  const [requests, setRequests] = useState([]);
  const [patientState, setPatientState] = useState({
    online: false,
    temperature: null,
    lastSeen: null,
  });

  // Register push token
  const registerPush = async () => {
    if (!Device.isDevice) {
      console.log('Push notifications need a physical device');
      return;
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.log('Push permission denied');
      return;
    }

    try {
      const token = (await Notifications.getExpoPushTokenAsync()).data;
      console.log('Push Token:', token);

      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(
          JSON.stringify({ event: 'register_push', token })
        );
      }
    } catch (err) {
      console.log('Push token error:', err.message);
    }
  };

  // Connect WebSocket
  useEffect(() => {
    const url = `ws://${SERVER_IP}:${SERVER_PORT}/ws?role=caregiver&token=${CAREGIVER_TOKEN}`;
    const socket = new WebSocket(url);
    ws.current = socket;

    socket.onopen = () => {
      console.log('WS connected');
      setConnected(true);
      registerPush();
    };

    socket.onmessage = (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }

      if (data.event === 'patient_state') {
        setPatientState({
          online: data.online,
          temperature: data.temperature,
          lastSeen: data.lastSeen,
        });
      }

      if (data.event === 'temperature') {
        setPatientState((prev) => ({
          ...prev,
          temperature: data.value,
          lastSeen: data.timestamp,
        }));
      }

      if (data.event === 'device_status') {
        setPatientState((prev) => ({
          ...prev,
          online: data.online,
          lastSeen: data.lastSeen || prev.lastSeen,
        }));
      }

      if (data.event === 'patient_request') {
        setRequests((prev) => [data, ...prev].slice(0, 50));
      }

      if (data.event === 'request_acknowledged') {
        setRequests((prev) =>
          prev.map((r) =>
            r.id === data.id ? { ...r, acknowledged: true } : r
          )
        );
      }
    };

    socket.onclose = () => {
      console.log('WS disconnected');
      setConnected(false);
    };

    socket.onerror = (e) => {
      console.log('WS error:', e.message);
    };

    // Auto reconnect every 5s if dropped
    const reconnect = setInterval(() => {
      if (ws.current && ws.current.readyState === WebSocket.CLOSED) {
        console.log('Reconnecting...');
        ws.current = new WebSocket(url);
      }
    }, 5000);

    return () => {
      clearInterval(reconnect);
      if (ws.current) ws.current.close();
    };
  }, []);

  const acknowledge = (id) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({ event: 'acknowledge', id }));
  };

  const priorityColor = (p) =>
    p === 'critical' ? '#d32f2f' : p === 'high' ? '#f57c00' : '#388e3c';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>HandSpeak Caregiver</Text>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.dot,
              { backgroundColor: connected ? '#4caf50' : '#f44336' },
            ]}
          />
          <Text style={styles.statusText}>
            {connected ? 'Connected' : 'Disconnected'}
          </Text>
        </View>
      </View>

      <View style={styles.patientCard}>
        <Text style={styles.sectionTitle}>Patient State</Text>
        <Text style={styles.line}>
          Device: {patientState.online ? '🟢 Online' : '🔴 Offline'}
        </Text>
        <Text style={styles.line}>
          Temperature:{' '}
          {patientState.temperature != null
            ? `${patientState.temperature.toFixed(1)} °C`
            : '—'}
        </Text>
        <Text style={styles.line}>
          Last seen:{' '}
          {patientState.lastSeen
            ? new Date(patientState.lastSeen).toLocaleTimeString()
            : '—'}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Requests</Text>
      <ScrollView style={styles.list}>
        {requests.length === 0 && (
          <Text style={styles.empty}>No requests yet</Text>
        )}
        {requests.map((r) => (
          <View key={r.id} style={styles.requestCard}>
            <View style={styles.requestHeader}>
              <Text
                style={[
                  styles.requestType,
                  { color: priorityColor(r.priority) },
                ]}
              >
                {r.type.toUpperCase()}
              </Text>
              <Text style={styles.requestTime}>
                {new Date(r.createdAt).toLocaleTimeString()}
              </Text>
            </View>
            <Text style={styles.requestMessage}>{r.message}</Text>
            {r.temperature != null && (
              <Text style={styles.requestMeta}>
                Temp: {r.temperature.toFixed(1)} °C
              </Text>
            )}
            {r.acknowledged ? (
              <Text style={styles.acked}>✓ Acknowledged</Text>
            ) : (
              <TouchableOpacity
                style={styles.ackButton}
                onPress={() => acknowledge(r.id)}
              >
                <Text style={styles.ackButtonText}>Acknowledge</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
    paddingHorizontal: 16,
  },
  header: { marginBottom: 16 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  statusText: { color: '#cbd5e1', fontSize: 13 },
  patientCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  sectionTitle: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  line: { color: '#e2e8f0', fontSize: 14, marginBottom: 4 },
  list: { flex: 1 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 20 },
  requestCard: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  requestHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  requestType: { fontWeight: '700', fontSize: 12 },
  requestTime: { color: '#64748b', fontSize: 11 },
  requestMessage: { color: '#e2e8f0', fontSize: 15, marginBottom: 6 },
  requestMeta: { color: '#94a3b8', fontSize: 12, marginBottom: 6 },
  acked: { color: '#4caf50', fontSize: 13, fontWeight: '600' },
  ackButton: {
    backgroundColor: '#2563eb',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  ackButtonText: { color: '#fff', fontWeight: '600' },
});