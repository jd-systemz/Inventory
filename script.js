// ⚠️ PASTE your deployed Apps Script Web App URL here (ends in /exec):
const API_URL = 'https://script.google.com/macros/s/AKfycbxx448moFrOP0e5lYa9FBpzXiXdCgvyqT3xhYHhfuL-ecdJk8as7pSvFeZfmhvYGbQ-/exec';

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
    document.querySelectorAll('select.item-select').forEach(function (sel) {
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
    const targetId = btn.dataset.target;
    openScanner('Scan Item Barcode', function (code) {
      selectItemByCode(targetId, code);
    });
  });
});

async function selectItemByCode(selectId, code) {
  const sel = document.getElementById(selectId);
  const prefix = selectId.split('-')[0]; // 'receiving' or 'issuance'
  const msg = document.getElementById('msg-' + prefix);

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

// ===================== RECEIVING / ISSUANCE — BULK ADD & SUBMIT =====================

function setupBulkForm(prefix, type) {
  const dateInput = document.getElementById(prefix + '-date');
  const itemSel = document.getElementById(prefix + '-item');
  const priceInput = document.getElementById(prefix + '-unitPrice');
  const qtyInput = document.getElementById(prefix + '-qty');
  const lobSel = document.getElementById(prefix + '-lob');
  const completedSel = document.getElementById(prefix + '-completed');
  const addBtn = document.getElementById(prefix + '-add');
  const tableBody = document.querySelector('#' + prefix + '-table tbody');
  const countEl = document.getElementById(prefix + '-count');
  const submitAllBtn = document.getElementById(prefix + '-submit-all');
  const msg = document.getElementById('msg-' + prefix);

  let pending = [];
  dateInput.value = new Date().toISOString().slice(0, 10);

  function render() {
    tableBody.innerHTML = '';
    pending.forEach(function (row, idx) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(row.itemName) + '</td>' +
        '<td>' + escapeHtml(row.unitPrice) + '</td>' +
        '<td>' + escapeHtml(row.qty) + '</td>' +
        '<td>' + escapeHtml(row.lob) + '</td>' +
        '<td>' + escapeHtml(row.completed) + '</td>' +
        '<td><button type="button" class="remove-line" data-idx="' + idx + '">&#10005;</button></td>';
      tableBody.appendChild(tr);
    });
    countEl.textContent = pending.length;
    submitAllBtn.disabled = pending.length === 0;
    tableBody.querySelectorAll('.remove-line').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pending.splice(Number(btn.dataset.idx), 1);
        render();
      });
    });
  }

  addBtn.addEventListener('click', function () {
    if (!itemSel.value) { alert('Select an item first.'); return; }
    if (!qtyInput.value || Number(qtyInput.value) <= 0) { alert('Enter a quantity greater than 0.'); return; }
    if (!lobSel.value) { alert('Select an LOB.'); return; }

    pending.push({
      itemName: itemSel.value,
      unitPrice: priceInput.value || 0,
      qty: qtyInput.value,
      lob: lobSel.value,
      completed: completedSel.value
    });
    render();

    // Clear the item-specific fields so the next line starts fresh;
    // keep LOB/Completed since batches are often all the same.
    itemSel.value = '';
    priceInput.value = '';
    qtyInput.value = '';
  });

  submitAllBtn.addEventListener('click', async function () {
    if (!pending.length) return;
    if (!dateInput.value) { alert('Pick a date.'); return; }

    submitAllBtn.disabled = true;
    msg.className = 'msg';
    msg.classList.remove('hidden');
    msg.innerHTML = '<span class="spinner"></span> Saving ' + pending.length + ' item(s)...';

    try {
      const res = await apiPost('submitBulkTransactions', {
        type: type,
        date: dateInput.value,
        rows: pending
      });
      if (res.error) throw new Error(res.error);
      msg.className = 'msg success';
      msg.textContent = res.count + ' ' + type.toLowerCase() + ' entr' + (res.count === 1 ? 'y' : 'ies') + ' added successfully.';
      pending = [];
      render();
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message || String(err);
      submitAllBtn.disabled = false; // let them retry without losing the list
    }
  });

  render();
}

// ===================== INIT =====================

window.addEventListener('load', function () {
  loadItemList();
  setupBulkForm('receiving', 'Receiving');
  setupBulkForm('issuance', 'Issuance');
});
