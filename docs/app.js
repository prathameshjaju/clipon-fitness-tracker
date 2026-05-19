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

// ===== AI COACH =====
const OLLAMA_API_KEY = 'f83fddbc10bd49c19821e7a9e38e5c61.C60W-qq_osi8cOZEZRJ23_cx';  // Replace with your key
const OLLAMA_MODEL   = 'gemma3:4b';

async function askAI() {
  const btn = document.getElementById('askAiBtn');
  const responseEl = document.getElementById('aiResponse');

  const steps   = document.getElementById('stepsVal').textContent;
  const bpm     = document.getElementById('bpmVal').textContent;
  const spo2    = document.getElementById('spo2Val').textContent;
  const sleep   = document.getElementById('sleepDuration').textContent;
  const cal     = document.getElementById('caloriesVal').textContent;
  const sleeping = document.getElementById('sleepBadge').textContent.includes('Sleeping');
  const p       = getProfile();

  const prompt = `You are a concise fitness coach. Analyse this data and give 2-3 short, specific, actionable tips.

User: ${p.name || 'User'}, ${p.age || '?'}y, ${p.weight || '?'}kg
Steps today: ${steps} (goal: ${p.stepGoal || 8000})
Calories burned: ${cal} kcal
Heart rate: ${bpm} BPM
SpO2: ${spo2}%
Sleep tracked: ${sleep} (currently ${sleeping ? 'sleeping' : 'awake'})

Give practical advice based on this exact data. Be direct and specific. No generic advice.`;

  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Thinking...';
  responseEl.className = 'ai-response loading';
  responseEl.textContent = 'Analysing your data...';

  try {
    const res = await fetch('https://corsproxy.io/?url=https://ollama.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OLLAMA_API_KEY}`
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${res.status}: ${errText}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ||
                 data.message?.content ||
                 data.response ||
                 'No response received.';

    responseEl.className = 'ai-response';
    responseEl.textContent = text;

  } catch (err) {
    responseEl.className = 'ai-response';
    responseEl.textContent = `Error: ${err.message}`;
    console.error(err);
  }

  btn.disabled = false;
  btn.innerHTML = '<span>✨</span> Ask AI Coach';
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
