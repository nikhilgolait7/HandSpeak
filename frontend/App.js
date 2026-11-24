import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Platform,
  Animated,
  Easing,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Svg, { Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

// 1. Setup Local Notification Handler (Works without Firebase)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ---------------- CONFIG ----------------
const SERVER_HOST = 'handspeak-hs96.onrender.com'; 
const CAREGIVER_TOKEN = 'handspeak123'; 
const PATIENT_ID = 'patient-001';

const AnimatedPath = Animated.createAnimatedComponent(Path);

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [isRegistered, setIsRegistered] = useState(false);
  const [activeTab, setActiveTab] = useState('admin');

  // Monitor State
  const ws = useRef(null);
  const reconnectTimer = useRef(null);
  const [connected, setConnected] = useState(false);
  const [requests, setRequests] = useState([]);
  const [patientState, setPatientState] = useState({
    online: false,
    heartRate: null,
    lastSeen: null,
  });

  // Admin State
  const [patient, setPatient] = useState({ name: '', mobile: '', patientId: PATIENT_ID });
  const [relatives, setRelatives] = useState([{ name: '', mobile: '' }, { name: '', mobile: '' }]);
  const [doctor, setDoctor] = useState({ name: '', mobile: '' });

  // Animations
  const heartScale = useRef(new Animated.Value(1)).current;
  const ecgScroll = useRef(new Animated.Value(0)).current;

  // ---------------- INITIAL LOAD: CHECK REGISTRATION ----------------
  useEffect(() => {
    const checkRegistration = async () => {
      try {
        const res = await fetch(`https://${SERVER_HOST}/api/patients/${PATIENT_ID}`, {
          headers: { Authorization: `Bearer ${CAREGIVER_TOKEN}` }
        });
        const data = await res.json();
        
        if (data && data.name) {
          setPatient(data);
          setRelatives(data.relatives || [{ name: '', mobile: '' }, { name: '', mobile: '' }]);
          setDoctor(data.doctor || { name: '', mobile: '' });
          setIsRegistered(true);
          setActiveTab('monitor');
          startWebSocket();
          requestPermissions(); // Ask for notification permissions
        } else {
          setIsRegistered(false);
          setActiveTab('admin');
        }
      } catch (err) {
        console.log('Registration check failed:', err);
        setIsRegistered(false);
        setActiveTab('admin');
      } finally {
        setIsLoading(false);
      }
    };
    checkRegistration();
  }, []);

  // ---------------- PERMISSIONS ----------------
  const requestPermissions = async () => {
    try {
      if (!Device.isDevice) return;
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        console.log('Notification permission denied');
      }
    } catch (err) {
      console.log('Permission error:', err.message);
    }
  };

  // ---------------- WEBSOCKET ----------------
  const startWebSocket = () => {
    if (ws.current) return;

    const connect = () => {
      const url = `wss://${SERVER_HOST}/ws?role=caregiver&token=${CAREGIVER_TOKEN}`;
      const socket = new WebSocket(url);
      ws.current = socket;

      socket.onopen = () => {
        setConnected(true);
      };

      socket.onmessage = (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }

        if (data.event === 'patient_state') setPatientState({ online: data.online, heartRate: data.heartRate, lastSeen: data.lastSeen });
        if (data.event === 'heart_rate') setPatientState((prev) => ({ ...prev, heartRate: data.value, lastSeen: data.timestamp }));
        if (data.event === 'device_status') setPatientState((prev) => ({ ...prev, online: data.online, lastSeen: data.lastSeen || prev.lastSeen }));
        
        if (data.event === 'patient_request') {
          setRequests((prev) => [data, ...prev].slice(0, 50));
          
          // 🔔 Trigger Local Notification (Banner + Sound) instantly
          Notifications.scheduleNotificationAsync({
            content: {
              title: `🚨 ${data.type.toUpperCase()} ALERT`,
              body: data.message,
              sound: true,
              data: { id: data.id },
            },
            trigger: null, 
          });
        }

        if (data.event === 'request_acknowledged') setRequests((prev) => prev.map((r) => r.id === data.id ? { ...r, acknowledged: true } : r));
      };

      socket.onclose = () => {
        setConnected(false);
        reconnectTimer.current = setTimeout(connect, 10000);
      };
    };

    connect();
  };

  // ---------------- ANIMATIONS ----------------
  useEffect(() => {
    if (!isRegistered) return;

    const pulse = () => {
      Animated.sequence([
        Animated.timing(heartScale, { toValue: 1.3, duration: 150, useNativeDriver: true }),
        Animated.timing(heartScale, { toValue: 1, duration: 150, useNativeDriver: true }),
      ]).start(() => {
        const bpm = patientState.heartRate || 60;
        const interval = (60 / bpm) * 1000;
        setTimeout(pulse, interval);
      });
    };
    pulse();

    Animated.loop(
      Animated.timing(ecgScroll, { toValue: 1, duration: 2000, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, [patientState.heartRate, isRegistered]);

  // ---------------- ADMIN LOGIC ----------------
  const handleRelativeChange = (index, field, value) => {
    const newRelatives = [...relatives];
    newRelatives[index][field] = value;
    setRelatives(newRelatives);
  };

  const savePatient = async () => {
    if (!patient.name || !patient.mobile) return Alert.alert("Error", "Name and Mobile required.");
    try {
      const res = await fetch(`https://${SERVER_HOST}/api/patients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patient, relatives, doctor })
      });
      if (res.ok) {
        Alert.alert("Success", "Patient registered! Starting Monitor...");
        setIsRegistered(true);
        startWebSocket();
        requestPermissions();
        setActiveTab('monitor');
      } else {
        Alert.alert("Error", "Failed to save patient.");
      }
    } catch (err) { Alert.alert("Error", "Network request failed."); }
  };

  const clearDatabase = () => {
    Alert.alert("WARNING", "Delete ALL patients and history?", [
      { text: "Cancel", style: "cancel" },
      { text: "DELETE", style: "destructive", onPress: async () => {
          try {
            const res = await fetch(`https://${SERVER_HOST}/api/clear-db`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${CAREGIVER_TOKEN}` }
            });
            if (res.ok) {
              setRequests([]);
              setPatient({ name: '', mobile: '', patientId: PATIENT_ID });
              setRelatives([{ name: '', mobile: '' }, { name: '', mobile: '' }]);
              setDoctor({ name: '', mobile: '' });
              setIsRegistered(false);
              setActiveTab('admin');
              if (ws.current) ws.current.close();
              Alert.alert("Success", "Database cleared.");
            }
          } catch (err) { Alert.alert("Error", "Failed to clear DB."); }
        } 
      }
    ]);
  };

  const acknowledge = (id) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ event: 'acknowledge', id }));
    }
  };

  const priorityColor = (p) => p === 'critical' ? '#ff3b30' : p === 'high' ? '#ff9500' : '#34c759';
  const ecgPath = "M0 40 L50 40 L60 35 L70 45 L80 40 L100 40 L110 10 L120 70 L130 40 L200 40 L210 35 L220 45 L230 40 L250 40 L260 10 L270 70 L280 40 L350 40 L360 35 L370 45 L380 40 L400 40";

  // ---------------- RENDER LOADING ----------------
  if (isLoading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#00ffcc" />
        <Text style={{ color: '#00ffcc', marginTop: 16 }}>Connecting to HandSpeak...</Text>
      </View>
    );
  }

  // ---------------- RENDER MONITOR ----------------
  const renderMonitor = () => (
    <ScrollView style={styles.tabContent} contentContainerStyle={{ paddingBottom: 20 }}>
      
      <View style={styles.patientNameCard}>
        <Text style={styles.patientLabel}>PATIENT</Text>
        <Text style={styles.patientNameText}>{patient.name}</Text>
      </View>

      <View style={styles.monitorCard}>
        <View style={styles.ecgContainer}>
          <Animated.View
            style={{
              width: 400,
              flexDirection: 'row',
              transform: [{ translateX: ecgScroll.interpolate({ inputRange: [0, 1], outputRange: [0, -200] }) }],
            }}
          >
            <Svg height="80" width="400">
              <Path d={ecgPath} fill="none" stroke="#00ffcc" strokeWidth="3" />
            </Svg>
          </Animated.View>
        </View>

        <View style={styles.hrRow}>
          <Animated.Text style={[styles.heartIcon, { transform: [{ scale: heartScale }] }]}>❤️</Animated.Text>
          <View style={styles.hrTextContainer}>
            <Text style={styles.hrNumber}>{patientState.heartRate || '--'}</Text>
            <Text style={styles.hrLabel}>BPM</Text>
          </View>
        </View>
        <Text style={styles.lastSeen}>
          Last Sync: {patientState.lastSeen ? new Date(patientState.lastSeen).toLocaleTimeString() : '--'}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Patient Alerts</Text>
      {requests.length === 0 && <Text style={styles.empty}>No active alerts</Text>}
      
      {requests.map((r) => (
        <View key={r.id} style={[styles.requestCard, { borderLeftColor: priorityColor(r.priority) }]}>
          <View style={styles.requestHeader}>
            <Text style={[styles.requestType, { color: priorityColor(r.priority) }]}>{r.type.toUpperCase()}</Text>
            <Text style={styles.requestTime}>{new Date(r.createdAt).toLocaleTimeString()}</Text>
          </View>
          <Text style={styles.requestMessage}>{r.message}</Text>
          {r.heartRate && <Text style={styles.requestMeta}>HR at alert: {r.heartRate} BPM</Text>}
          
          {r.acknowledged ? (
            <View style={styles.ackedBadge}><Text style={styles.ackedText}>✓ ACKNOWLEDGED</Text></View>
          ) : (
            <TouchableOpacity style={styles.ackButton} onPress={() => acknowledge(r.id)}>
              <Text style={styles.ackButtonText}>Acknowledge Alert</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </ScrollView>
  );

  // ---------------- RENDER ADMIN ----------------
  const renderAdmin = () => (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <ScrollView style={styles.tabContent} contentContainerStyle={{ paddingBottom: 40 }}>
        
        {!isRegistered && (
          <View style={styles.warningBox}>
            <Ionicons name="warning" size={24} color="#ff9500" />
            <Text style={styles.warningText}>Please register a patient to unlock the monitor.</Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>Patient Details</Text>
        <View style={styles.formCard}>
          <TextInput style={styles.input} placeholder="Patient Name" placeholderTextColor="#666" value={patient.name} onChangeText={(t) => setPatient({ ...patient, name: t })} />
          <TextInput style={styles.input} placeholder="Patient Mobile" placeholderTextColor="#666" keyboardType="phone-pad" value={patient.mobile} onChangeText={(t) => setPatient({ ...patient, mobile: t })} />
        </View>

        <Text style={styles.sectionTitle}>Relatives (2)</Text>
        {relatives.map((rel, index) => (
          <View key={index} style={styles.formCard}>
            <Text style={styles.subLabel}>Relative {index + 1}</Text>
            <TextInput style={styles.input} placeholder="Name" placeholderTextColor="#666" value={rel.name} onChangeText={(t) => handleRelativeChange(index, 'name', t)} />
            <TextInput style={styles.input} placeholder="Mobile" placeholderTextColor="#666" keyboardType="phone-pad" value={rel.mobile} onChangeText={(t) => handleRelativeChange(index, 'mobile', t)} />
          </View>
        ))}

        <Text style={styles.sectionTitle}>Doctor</Text>
        <View style={styles.formCard}>
          <TextInput style={styles.input} placeholder="Doctor Name" placeholderTextColor="#666" value={doctor.name} onChangeText={(t) => setDoctor({ ...doctor, name: t })} />
          <TextInput style={styles.input} placeholder="Doctor Mobile" placeholderTextColor="#666" keyboardType="phone-pad" value={doctor.mobile} onChangeText={(t) => setDoctor({ ...doctor, mobile: t })} />
        </View>

        <TouchableOpacity style={styles.saveButton} onPress={savePatient}>
          <Text style={styles.saveButtonText}>{isRegistered ? "UPDATE PATIENT" : "SAVE & START MONITOR"}</Text>
        </TouchableOpacity>

        {isRegistered && (
          <>
            <Text style={[styles.sectionTitle, { color: '#ff3b30', marginTop: 40 }]}>Danger Zone</Text>
            <TouchableOpacity style={styles.clearButton} onPress={clearDatabase}>
              <Ionicons name="trash-outline" size={20} color="#fff" style={{marginRight: 8}} />
              <Text style={styles.clearButtonText}>CLEAR DATABASE</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>HandSpeak</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: connected ? '#34c759' : '#ff3b30' }]} />
          <Text style={styles.statusText}>{connected ? 'LIVE' : 'OFFLINE'}</Text>
        </View>
      </View>

      {isRegistered && (
        <View style={styles.tabBar}>
          <TouchableOpacity style={[styles.tabButton, activeTab === 'monitor' && styles.tabActive]} onPress={() => setActiveTab('monitor')}>
            <Ionicons name="pulse" size={20} color={activeTab === 'monitor' ? '#00ffcc' : '#8e8e93'} />
            <Text style={[styles.tabText, activeTab === 'monitor' && styles.tabTextActive]}>Monitor</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tabButton, activeTab === 'admin' && styles.tabActive]} onPress={() => setActiveTab('admin')}>
            <Ionicons name="settings" size={20} color={activeTab === 'admin' ? '#00ffcc' : '#8e8e93'} />
            <Text style={[styles.tabText, activeTab === 'admin' && styles.tabTextActive]}>Admin</Text>
          </TouchableOpacity>
        </View>
      )}

      {isRegistered && activeTab === 'monitor' ? renderMonitor() : renderAdmin()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f', paddingTop: Platform.OS === 'ios' ? 60 : 40 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  statusText: { color: '#8e8e93', fontSize: 12, fontWeight: '700', letterSpacing: 1 },

  tabBar: { flexDirection: 'row', paddingHorizontal: 20, marginBottom: 16 },
  tabButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 20, backgroundColor: '#12121a', marginRight: 10 },
  tabActive: { backgroundColor: '#1f1f2e', borderWidth: 1, borderColor: '#00ffcc' },
  tabText: { color: '#8e8e93', fontSize: 14, fontWeight: '600', marginLeft: 8 },
  tabTextActive: { color: '#00ffcc' },

  tabContent: { flex: 1, paddingHorizontal: 20 },

  patientNameCard: { backgroundColor: '#12121a', borderRadius: 12, padding: 16, marginBottom: 16, borderLeftWidth: 4, borderLeftColor: '#00ffcc' },
  patientLabel: { color: '#8e8e93', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  patientNameText: { color: '#fff', fontSize: 24, fontWeight: '800', marginTop: 4 },

  monitorCard: { backgroundColor: '#12121a', borderRadius: 16, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: '#1f1f2e', shadowColor: '#00ffcc', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 5 },
  ecgContainer: { height: 80, backgroundColor: '#0a0a0f', borderRadius: 8, marginBottom: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#1f1f2e', justifyContent: 'center' },
  hrRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  heartIcon: { fontSize: 40, marginRight: 16 },
  hrTextContainer: { alignItems: 'flex-start' },
  hrNumber: { color: '#00ffcc', fontSize: 64, fontWeight: '900', lineHeight: 70 },
  hrLabel: { color: '#00ffcc', fontSize: 14, fontWeight: '700', letterSpacing: 2, marginTop: -5 },
  lastSeen: { color: '#48484a', fontSize: 12, textAlign: 'center', marginTop: 10 },

  sectionTitle: { color: '#8e8e93', fontSize: 14, fontWeight: '700', letterSpacing: 1, marginBottom: 12, textTransform: 'uppercase' },
  empty: { color: '#48484a', textAlign: 'center', marginTop: 20, fontSize: 16 },
  
  requestCard: { backgroundColor: '#12121a', borderRadius: 12, padding: 16, marginBottom: 12, borderLeftWidth: 4 },
  requestHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  requestType: { fontWeight: '800', fontSize: 14, letterSpacing: 1 },
  requestTime: { color: '#48484a', fontSize: 12, fontWeight: '600' },
  requestMessage: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  requestMeta: { color: '#8e8e93', fontSize: 13, marginBottom: 12 },
  
  ackButton: { backgroundColor: '#00ffcc', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  ackButtonText: { color: '#000', fontWeight: '800', fontSize: 14 },
  ackedBadge: { backgroundColor: '#1f1f2e', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  ackedText: { color: '#34c759', fontWeight: '800', fontSize: 14, letterSpacing: 1 },

  formCard: { backgroundColor: '#12121a', borderRadius: 12, padding: 16, marginBottom: 16 },
  subLabel: { color: '#8e8e93', fontSize: 12, marginBottom: 8 },
  input: { backgroundColor: '#0a0a0f', color: '#fff', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12, marginBottom: 12, borderWidth: 1, borderColor: '#1f1f2e' },
  saveButton: { backgroundColor: '#00ffcc', borderRadius: 8, paddingVertical: 16, alignItems: 'center', marginTop: 10 },
  saveButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
  
  clearButton: { flexDirection: 'row', backgroundColor: '#ff3b30', borderRadius: 8, paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
  clearButtonText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  warningBox: { flexDirection: 'row', backgroundColor: '#2a1f10', padding: 16, borderRadius: 8, marginBottom: 20, alignItems: 'center', borderWidth: 1, borderColor: '#ff9500' },
  warningText: { color: '#ff9500', fontSize: 14, fontWeight: '600', marginLeft: 12, flex: 1 },
});