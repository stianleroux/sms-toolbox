import * as SMS from 'expo-sms';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';

type PollMessage = {
  id: string;
  to: string;
  text: string;
  createdAt: string;
};

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState('https://your-worker.workers.dev');
  const [apiKey, setApiKey] = useState('');
  const [deviceId, setDeviceId] = useState('android-phone-1');
  const [pollIntervalMs, setPollIntervalMs] = useState('5000');
  const [polling, setPolling] = useState(false);
  const [working, setWorking] = useState(false);
  const [lastEvent, setLastEvent] = useState('Idle');

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canPoll = useMemo(() => !!apiBaseUrl.trim() && !!deviceId.trim(), [apiBaseUrl, deviceId]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  async function postAck(messageId: string, status: 'sent' | 'failed', error?: string) {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };
    if (apiKey.trim()) {
      headers['x-api-key'] = apiKey.trim();
    }

    await fetch(`${apiBaseUrl.trim()}/api/sms/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: deviceId.trim(),
        id: messageId,
        status,
        error
      })
    });
  }

  async function sendSmsFromMessage(message: PollMessage) {
    const isAvailable = await SMS.isAvailableAsync();
    if (!isAvailable) {
      await postAck(message.id, 'failed', 'SMS not available on this device');
      setLastEvent(`Failed ${message.id}: SMS not available`);
      return;
    }

    const result = await SMS.sendSMSAsync([message.to], message.text);
    if (result.result === 'sent') {
      await postAck(message.id, 'sent');
      setLastEvent(`Sent ${message.id} -> ${message.to}`);
      return;
    }

    await postAck(message.id, 'failed', `SMS result: ${result.result}`);
    setLastEvent(`Failed ${message.id}: ${result.result}`);
  }

  async function pollOnce() {
    if (working || !canPoll) {
      return;
    }

    setWorking(true);
    try {
      const headers: Record<string, string> = {};
      if (apiKey.trim()) {
        headers['x-api-key'] = apiKey.trim();
      }

      const pollUrl = `${apiBaseUrl.trim()}/api/sms/poll?deviceId=${encodeURIComponent(deviceId.trim())}`;
      const response = await fetch(pollUrl, { headers });
      if (!response.ok) {
        setLastEvent(`Poll failed: HTTP ${response.status}`);
        return;
      }

      const data = (await response.json()) as { hasMessage?: boolean; message?: PollMessage };
      if (!data.hasMessage || !data.message) {
        setLastEvent('No message in queue');
        return;
      }

      await sendSmsFromMessage(data.message);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Unknown error';
      setLastEvent(`Poll error: ${text}`);
    } finally {
      setWorking(false);
    }
  }

  function scheduleNextPoll() {
    if (!polling) {
      return;
    }
    const interval = Number.parseInt(pollIntervalMs, 10);
    const safeInterval = Number.isFinite(interval) && interval >= 1000 ? interval : 5000;
    timerRef.current = setTimeout(async () => {
      await pollOnce();
      scheduleNextPoll();
    }, safeInterval);
  }

  function startPolling() {
    if (!canPoll) {
      Alert.alert('Missing config', 'Set API URL and device ID first.');
      return;
    }
    setPolling(true);
    setLastEvent('Polling started');
  }

  function stopPolling() {
    setPolling(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setLastEvent('Polling stopped');
  }

  useEffect(() => {
    if (polling) {
      scheduleNextPoll();
    } else if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [polling, apiBaseUrl, apiKey, deviceId, pollIntervalMs]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>SMS Relay Client</Text>
        <Text style={styles.subtitle}>Poll Cloudflare and send SMS from this device</Text>

        <Text style={styles.label}>Worker API Base URL</Text>
        <TextInput
          value={apiBaseUrl}
          onChangeText={setApiBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="https://your-worker.workers.dev"
        />

        <Text style={styles.label}>API Key (optional)</Text>
        <TextInput
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="x-api-key"
        />

        <Text style={styles.label}>Device ID</Text>
        <TextInput
          value={deviceId}
          onChangeText={setDeviceId}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="android-phone-1"
        />

        <Text style={styles.label}>Poll Interval (ms)</Text>
        <TextInput
          value={pollIntervalMs}
          onChangeText={setPollIntervalMs}
          keyboardType="number-pad"
          style={styles.input}
          placeholder="5000"
        />

        <View style={styles.row}>
          <Pressable
            style={[styles.button, styles.startButton, (!canPoll || polling) && styles.buttonDisabled]}
            onPress={startPolling}
            disabled={!canPoll || polling}
          >
            <Text style={styles.buttonText}>Start</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.stopButton, !polling && styles.buttonDisabled]} onPress={stopPolling} disabled={!polling}>
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        </View>

        <Pressable style={[styles.button, styles.pollNowButton]} onPress={pollOnce} disabled={working || !canPoll}>
          {working ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Poll Now</Text>}
        </Pressable>

        <View style={styles.logBox}>
          <Text style={styles.logTitle}>Last Event</Text>
          <Text style={styles.logText}>{lastEvent}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f6f7fb',
  },
  container: {
    padding: 20,
    gap: 10,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#16181d',
    marginTop: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#4b5565',
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    color: '#3b4250',
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cdd4df',
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  startButton: {
    backgroundColor: '#166534',
    flex: 1,
  },
  stopButton: {
    backgroundColor: '#991b1b',
    flex: 1,
  },
  pollNowButton: {
    marginTop: 4,
    backgroundColor: '#1d4ed8',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 15,
  },
  logBox: {
    marginTop: 8,
    backgroundColor: '#fff',
    borderColor: '#dbe1ea',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  logTitle: {
    fontSize: 12,
    color: '#526077',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  logText: {
    fontSize: 14,
    color: '#111827',
  },
});
