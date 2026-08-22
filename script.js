// PASTE your deployed Apps Script Web App URL here
const API_URL = 'YOUR_APPS_SCRIPT_URL_HERE';
const LAST_VIEW_KEY = 'inventory_last_view';
const THEME_KEY = 'inventory_theme';

// ===================== THEME & MENU =====================
const views = ['checkStocks', 'correctStocks', 'updateRack', 'barcodeDone', 'receiving', 'issuance', 'inventoryControls'];
// ... theme logic ...

// ===================== API HELPERS =====================
async function apiPost(action, payload) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload })
  });
  return resp.json();
}
// ... other api helpers ...

// ===================== INVENTORY CONTROLS =====================
const controlsMsg = document.getElementById('msg-controls');

async function runControlAction(action, label) {
  if (!confirm(`Run ${label}? This might take a while.`)) return;
  
  controlsMsg.className = 'msg';
  controlsMsg.classList.remove('hidden');
  controlsMsg.innerHTML = `<span class="spinner"></span> Running ${label}...`;

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

document.getElementById('btn-downloadBarcodes').addEventListener('click', () => {
  runControlAction('bulkDownloadBarcodes', 'Download Barcodes to Drive');
});

document.getElementById('btn-createBarcodes').addEventListener('click', () => {
  runControlAction('bulkCreateBarcodes', 'Create Barcodes in Smartsheet');
});

document.getElementById('btn-syncDropdown').addEventListener('click', () => {
  runControlAction('syncDropdownOptions', 'Update Dropdown Options');
});

// ===================== INIT =====================
window.addEventListener('load', function () {
  // Existing init code
  activateView(localStorage.getItem(LAST_VIEW_KEY) || 'checkStocks');
  // ... rest of init ...
});
