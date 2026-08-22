const API_URL = 'https://script.google.com/macros/s/AKfycbxx448moFrOP0e5lYa9FBpzXiXdCgvyqT3xhYHhfuL-ecdJk8as7pSvFeZfmhvYGbQ-/exec';

const views = ['checkStocks', 'correctStocks', 'updateRack', 'barcodeDone', 'receiving', 'issuance', 'inventoryControls'];

// ===================== API HELPERS =====================

async function apiPost(action, payload) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload })
  });
  return resp.json();
}

async function apiGet(action, params = {}) {
  const url = new URL(API_URL);
  url.searchParams.set('action', action);
  for (let k in params) url.searchParams.set(k, params[k]);
  const resp = await fetch(url);
  return resp.json();
}

// ===================== NAVIGATION =====================

function activateView(target) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + target));
  document.querySelectorAll('.menu-item').forEach(m => m.classList.toggle('active', m.dataset.view === target));
}

document.querySelectorAll('.menu-item').forEach(btn => {
  btn.addEventListener('click', () => {
    activateView(btn.dataset.view);
    document.getElementById('sideMenu').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
  });
});

document.getElementById('menuBtn').addEventListener('click', () => {
  document.getElementById('sideMenu').classList.add('open');
  document.getElementById('overlay').classList.add('show');
});

// ===================== INVENTORY CONTROLS =====================

const controlsMsg = document.getElementById('msg-controls');

async function runControlAction(action, label) {
  if (!confirm(`Are you sure you want to run: ${label}?`)) return;
  
  controlsMsg.className = 'msg';
  controlsMsg.classList.remove('hidden');
  controlsMsg.innerHTML = `<span class="spinner"></span> Processing ${label}... Please wait.`;

  try {
    const res = await apiPost(action, {});
    if (res.error) throw new Error(res.error);
    
    controlsMsg.className = 'msg success';
    controlsMsg.innerHTML = `<strong>Success:</strong> ${res.message}`;
  } catch (err) {
    controlsMsg.className = 'msg error';
    controlsMsg.textContent = err.message || String(err);
  }
}

document.getElementById('btn-downloadBarcodes').addEventListener('click', () => runControlAction('bulkDownloadBarcodes', 'Download Barcodes to Drive'));
document.getElementById('btn-createBarcodes').addEventListener('click', () => runControlAction('bulkCreateBarcodes', 'Create Barcodes in Smartsheet'));
document.getElementById('btn-syncDropdown').addEventListener('click', () => runControlAction('syncDropdownOptions', 'Update Dropdown Options'));

// ===================== SHARED LOGIC (STUBS) =====================
// Add your specific scanner and button logic for the other views here...

window.addEventListener('load', () => {
  activateView('checkStocks');
});
