// ===== BLE UUIDs (must match firmware) =====
const SERVICE_UUID   = '0000180d-0000-1000-8000-00805f9b34fb';
const STEP_UUID      = '00002a55-0000-1000-8000-00805f9b34fb';
const BPM_UUID       = '00002a37-0000-1000-8000-00805f9b34fb';
const SPO2_UUID      = '00002a5e-0000-1000-8000-00805f9b34fb';
const SLEEP_UUID     = '00002a44-0000-1000-8000-00805f9b34fb';

// ===== State =====
let bleDevice = null;
let bleServer = null;
let isConnected = false;
let hrHistory = Array(30).fill(0);
let hrChart = null;

// ===== Profile =====
function getProfile() {
  return JSON.parse(localStorage.getItem('pulse_profile') || '{}');
}

function loadProfile() {
  const p = getProfile();
  if (p.name) {
    document.getElementById('profileName').textContent = p.name;
    document.getElementById('profileMeta').textContent =
      `${p.age}y · ${p.weight}kg · ${p.height}cm · Goal: ${p.stepGoal?.toLocaleString()} steps`;
  }
  if (p.stepGoal) {
    document.getElementById('stepsGoalText').textContent =
      `Goal: ${p.stepGoal.toLocaleString()}`;
  }
}

// ===== Calorie calculation =====
function calcCalories(steps) {
  const p = getProfile();
  const weight = p.weight || 70;
  const height = p.height || 170;
  const strideM = height * 0.414 / 100;
  const distKm  = (steps * strideM) / 1000;
  // MET-based: ~0.57 kcal per kg per km walking
  return Math.round(distKm * weight * 0.57);
}

// ===== HR Chart =====
function initChart() {
  const ctx = document.getElementById('hrChart').getContext('2d');
  hrChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(30).fill(''),
      datasets: [{
        data: hrHistory,
        borderColor: '#ff6584',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
        backgroundColor: 'rgba(255,101,132,0.08)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          display: false,
          min: 40,
          max: 160
        }
      }
    }
  });
}

function updateChart(bpm) {
  if (!hrChart) return;
  hrHistory.push(bpm);
  hrHistory.shift();
  hrChart.data.datasets[0].data = [...hrHistory];
  hrChart.update('none');
}

// ===== BLE Connection =====
async function toggleBLE() {
  if (isConnected) {
    disconnect();
  } else {
    connect();
  }
}

async function connect() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth not supported. Use Chrome on Android, or WebBLE app on iPhone.');
    return;
  }

  try {
    document.getElementById('bleBtnText').textContent = 'Scanning...';

    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'FitnessTracker' }],
      optionalServices: [SERVICE_UUID]
    });

    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

    document.getElementById('bleBtnText').textContent = 'Connecting...';
    bleServer = await bleDevice.gatt.connect();

    const service = await bleServer.getPrimaryService(SERVICE_UUID);

    // Subscribe to all characteristics
    await subscribeChar(service, STEP_UUID,  onStepData);
    await subscribeChar(service, BPM_UUID,   onBpmData);
    await subscribeChar(service, SPO2_UUID,  onSpo2Data);
    await subscribeChar(service, SLEEP_UUID, onSleepData);

    setConnected(true);

  } catch (err) {
    console.error(err);
    document.getElementById('bleBtnText').textContent = 'Connect';
    if (err.name !== 'NotFoundError') {
      alert('Connection failed: ' + err.message);
    }
  }
}

async function subscribeChar(service, uuid, handler) {
  const char = await service.getCharacteristic(uuid);
  char.addEventListener('characteristicvaluechanged', handler);
  await char.startNotifications();
}

function disconnect() {
  if (bleDevice && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
  setConnected(false);
}

function onDisconnected() {
  setConnected(false);
}

function setConnected(connected) {
  isConnected = connected;
  const btn = document.getElementById('bleBtn');
  const btnText = document.getElementById('bleBtnText');
  const dashboard = document.getElementById('dashboard');
  const connectScreen = document.getElementById('connectScreen');

  if (connected) {
    btn.classList.add('connected');
    btnText.textContent = 'Connected';
    dashboard.style.display = 'block';
    connectScreen.style.display = 'none';
    loadProfile();
    if (!hrChart) initChart();
  } else {
    btn.classList.remove('connected');
    btnText.textContent = 'Connect';
    dashboard.style.display = 'none';
    connectScreen.style.display = 'block';
  }
}

// ===== Data Handlers =====
function onStepData(event) {
  const val = event.target.value;
  const steps = (val.getUint8(0) << 24) | (val.getUint8(1) << 16) |
                (val.getUint8(2) << 8)  |  val.getUint8(3);

  document.getElementById('stepsVal').textContent = steps.toLocaleString();

  const p = getProfile();
  const goal = p.stepGoal || 8000;
  const pct = Math.min(100, (steps / goal) * 100);
  document.getElementById('stepsFill').style.width = pct + '%';

  const cal = calcCalories(steps);
  document.getElementById('caloriesVal').textContent = cal;
}

function onBpmData(event) {
  const val = event.target.value;
  const bpm = (val.getUint8(0) << 8) | val.getUint8(1);

  if (bpm === 0) {
    document.getElementById('bpmVal').textContent = '--';
    document.getElementById('bpmStatus').textContent = 'Place finger on sensor';
    return;
  }

  document.getElementById('bpmVal').textContent = bpm;

  // HR zone
  let zone = '';
  if (bpm < 60)       zone = 'Resting';
  else if (bpm < 100) zone = 'Normal';
  else if (bpm < 140) zone = 'Elevated';
  else                zone = 'High';

  document.getElementById('bpmStatus').textContent = zone;
  updateChart(bpm);
}

function onSpo2Data(event) {
  const spo2 = event.target.value.getUint8(0);

  if (spo2 === 0) {
    document.getElementById('spo2Val').textContent = '--';
    document.getElementById('spo2Status').textContent = 'Place finger on sensor';
    document.getElementById('spo2Fill').style.width = '0%';
    return;
  }

  document.getElementById('spo2Val').textContent = spo2;

  let status = 'Normal';
  if (spo2 < 90)      status = 'Low — seek help';
  else if (spo2 < 95) status = 'Below normal';
  else if (spo2 < 98) status = 'Normal';
  else                status = 'Excellent';

  document.getElementById('spo2Status').textContent = status;

  const pct = Math.max(0, Math.min(100, (spo2 - 70) / 30 * 100));
  document.getElementById('spo2Fill').style.width = pct + '%';
}

function onSleepData(event) {
  const val = event.target.value;
  const sleeping = val.getUint8(0) === 1;
  const sleepMs = (val.getUint8(1) << 24) | (val.getUint8(2) << 16) |
                  (val.getUint8(3) << 8)  |  val.getUint8(4);

  const badge = document.getElementById('sleepBadge');
  if (sleeping) {
    badge.textContent = '● Sleeping';
    badge.className = 'sleep-badge sleeping';
  } else {
    badge.textContent = '● Awake';
    badge.className = 'sleep-badge awake';
  }

  const totalMin = Math.floor(sleepMs / 60000);
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  document.getElementById('sleepDuration').textContent = `${hrs}h ${mins}m`;
}

// ===== AI COACH (Groq) =====
const GROQ_API_KEY = 'YOUR_GROQ_API_KEY';
const GROQ_MODEL   = 'llama3-8b-8192';
let chatHistory    = [];
let chatOpen       = false;

function getLiveContext() {
  const p       = getProfile();
  const steps   = document.getElementById('stepsVal').textContent;
  const bpm     = document.getElementById('bpmVal').textContent;
  const spo2    = document.getElementById('spo2Val').textContent;
  const sleep   = document.getElementById('sleepDuration').textContent;
  const cal     = document.getElementById('caloriesVal').textContent;
  const sleeping = document.getElementById('sleepBadge').textContent.includes('Sleeping');

  return `You are a friendly, concise personal fitness coach for ${p.name || 'the user'}.
Current live data from their wearable tracker:
- Steps: ${steps} (daily goal: ${p.stepGoal || 8000})
- Calories burned: ${cal} kcal
- Heart rate: ${bpm} BPM
- SpO2: ${spo2}%
- Sleep: ${sleep} tracked (currently ${sleeping ? 'sleeping' : 'awake'})
- Profile: ${p.age || '?'}y, ${p.weight || '?'}kg, ${p.height || '?'}cm

Answer questions based on this real data. Be specific, practical, and brief. No generic advice.`;
}

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chatPanel');
  const fab   = document.getElementById('chatFab');
  panel.style.display = chatOpen ? 'flex' : 'none';
  fab.textContent = chatOpen ? '✕' : '🤖';

  if (chatOpen && chatHistory.length === 0) {
    addChatMessage('ai', "Hi! I'm your AI fitness coach. I can see your live data. Ask me anything about your health, steps, sleep, or heart rate!");
  }
}

function addChatMessage(role, text) {
  const messages = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function addTypingIndicator() {
  const messages = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg ai typing';
  div.id = 'typingIndicator';
  div.textContent = '...';
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;

  input.value = '';
  addChatMessage('user', text);

  chatHistory.push({ role: 'user', content: text });
  addTypingIndicator();

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: getLiveContext() },
          ...chatHistory
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }

    const data   = await res.json();
    const reply  = data.choices[0].message.content;

    chatHistory.push({ role: 'assistant', content: reply });
    removeTypingIndicator();
    addChatMessage('ai', reply);

  } catch (err) {
    removeTypingIndicator();
    addChatMessage('ai', `Error: ${err.message}`);
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

// ===== Init =====
window.addEventListener('load', () => {
  loadProfile();

  // If no profile, redirect to setup
  const p = getProfile();
  if (!p.name) {
    // Show a subtle hint but don't force redirect
    document.getElementById('profileName').textContent = 'Set up profile';
  }
});
