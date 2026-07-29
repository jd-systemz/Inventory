// ⚠️ PASTE your deployed Apps Script Web App URL here (ends in /exec):
const API_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';

// ===================== API HELPERS =====================

async function apiGet(action, params) {
  const url = new URL(API_URL);
  url.searchParams.set('action', action);
  if (params) {
    Object.keys(params).forEach(function (k) { url.searchParams.set(k, params[k]); });
  }
  const resp = await fetch(url.toString());
  return resp.json();
}

async function apiPost(action, payload) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
    body: JSON.stringify({ action: action, payload: payload })
  });
  return resp.json();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===================== MENU =====================

const views = ['checkStocks', 'receiving', 'issuance'];
const menuBtn = document.getElementById('menuBtn');
const sideMenu = document.getElementById('sideMenu');
const overlay = document.getElementById('overlay');

menuBtn.addEventListener('click', function () {
  sideMenu.classList.toggle('open');
  overlay.classList.toggle('show');
});
overlay.addEventListener('click', closeMenu);
function closeMenu() {
  sideMenu.classList.remove('open');
  overlay.classList.remove('show');
}

document.querySelectorAll('.menu-item').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.menu-item').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    const target = btn.dataset.view;
    views.forEach(function (v) {
      document.getElementById('view-' + v).classList.toggle('active', v === target);
    });
    closeMenu();
  });
});

// ===================== SHARED SCANNER MODAL =====================

let modalScanner = null;
let modalScannerActive = false;

function openScanner(title, onDecoded) {
  document.getElementById('scannerTitle').textContent = title;
  document.getElementById('scannerModal').classList.remove('hidden');
  modalScanner = new Html5Qrcode('scannerRegion');
  modalScannerActive = true;
  modalScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 150 } },
    function (decodedText) {
      const code = decodedText.trim();
      closeScannerModal();
      onDecoded(code);
    },
    function () { /* ignore per-frame scan misses */ }
  ).catch(function (err) {
    closeScannerModal();
    alert('Camera error: ' + err);
  });
}

function closeScannerModal() {
  document.getElementById('scannerModal').classList.add('hidden');
  if (modalScanner && modalScannerActive) {
    modalScannerActive = false;
    modalScanner.stop().catch(function () {});
  }
}
document.getElementById('closeScanner').addEventListener('click', closeScannerModal);

// ===================== CHECK STOCKS =====================

document.getElementById('startScanCheck').addEventListener('click', function () {
  openScanner('Scan Item Code', lookupItem);
});
document.getElementById('manualCodeGo').addEventListener('click', function () {
  lookupItem(document.getElementById('manualCode').value.trim());
});
document.getElementById('manualCode').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    lookupItem(e.target.value.trim());
  }
});

async function lookupItem(code) {
  if (!code) return;
  const resultBox = document.getElementById('stockResult');
  resultBox.classList.remove('hidden');
  resultBox.innerHTML = '<span class="spinner"></span> Looking up "' + escapeHtml(code) + '"...';
  try {
    const res = await apiGet('checkStock', { code: code });
    if (res.error) {
      resultBox.innerHTML = '<div class="msg error">' + escapeHtml(res.error) + '</div>';
      return;
    }
    if (!res.found) {
      resultBox.innerHTML = '<div class="msg error">' + escapeHtml(res.message) + '</div>';
      return;
    }
    resultBox.innerHTML =
      '<div class="result-row"><span class="result-label">Item</span><span class="result-value">' + escapeHtml(res.item) + '</span></div>' +
      '<div class="result-row"><span class="result-label">Item Code</span><span class="result-value">' + escapeHtml(res.itemCode) + '</span></div>' +
      '<div class="result-row"><span class="result-label">Stock on Hand</span><span class="result-value">' + escapeHtml(String(res.stockOnHand)) + '</span></div>';
  } catch (err) {
    resultBox.innerHTML = '<div class="msg error">' + escapeHtml(err.message || String(err)) + '</div>';
  }
}

// ===================== ITEM LIST (Enhanced Item dropdowns) =====================

async function loadItemList() {
  try {
    const items = await apiGet('getItemList');
    if (items.error) {
      console.error(items.error);
      return;
    }
    document.querySelectorAll('select[name="itemName"]').forEach(function (sel) {
      const current = sel.value;
      sel.innerHTML = '<option value="">Select item</option>';
      items.forEach(function (it) {
        const opt = document.createElement('option');
        opt.value = it.name;
        opt.textContent = it.code ? (it.name + ' (' + it.code + ')') : it.name;
        sel.appendChild(opt);
      });
      if (current) sel.value = current;
    });
  } catch (err) {
    console.error(err);
  }
}

// ===================== SCAN TO SELECT ITEM (Receiving / Issuance) =====================

document.querySelectorAll('.scan-item-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const formId = btn.dataset.form;
    openScanner('Scan Item Barcode', function (code) {
      selectItemByCode(formId, code);
    });
  });
});

async function selectItemByCode(formId, code) {
  const form = document.getElementById(formId);
  const msgId = formId === 'form-receiving' ? 'msg-receiving' : 'msg-issuance';
  const msg = document.getElementById(msgId);
  const sel = form.querySelector('select[name="itemName"]');

  msg.className = 'msg';
  msg.classList.remove('hidden');
  msg.innerHTML = '<span class="spinner"></span> Looking up "' + escapeHtml(code) + '"...';

  try {
    const res = await apiGet('checkStock', { code: code });
    if (res.error || !res.found) {
      msg.className = 'msg error';
      msg.textContent = res.error || res.message;
      return;
    }
    const match = Array.prototype.find.call(sel.options, function (o) { return o.value === res.item; });
    if (match) {
      sel.value = res.item;
      msg.classList.add('hidden');
    } else {
      msg.className = 'msg error';
      msg.textContent = 'Scanned item "' + res.item + '" was not found in the dropdown list.';
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message || String(err);
  }
}

// ===================== RECEIVING / ISSUANCE FORMS =====================

function setupTxnForm(formId, msgId, type) {
  const form = document.getElementById(formId);
  const msg = document.getElementById(msgId);
  const dateInput = form.querySelector('input[name="date"]');
  const completedSelect = form.querySelector('select[name="completed"]');

  function resetDefaults() {
    dateInput.value = new Date().toISOString().slice(0, 10);
    completedSelect.value = 'YES';
  }
  resetDefaults();

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      type: type,
      itemName: fd.get('itemName'),
      unitPrice: fd.get('unitPrice'),
      qty: fd.get('qty'),
      date: fd.get('date'),
      lob: fd.get('lob'),
      completed: fd.get('completed')
    };
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    msg.className = 'msg';
    msg.classList.remove('hidden');
    msg.innerHTML = '<span class="spinner"></span> Saving...';

    try {
      const res = await apiPost('submitTransaction', payload);
      if (res.error) throw new Error(res.error);
      msg.className = 'msg success';
      msg.textContent = type + ' entry added successfully.';
      form.reset();
      resetDefaults();
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message || String(err);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ===================== INIT =====================

window.addEventListener('load', function () {
  loadItemList();
  setupTxnForm('form-receiving', 'msg-receiving', 'Receiving');
  setupTxnForm('form-issuance', 'msg-issuance', 'Issuance');
});
