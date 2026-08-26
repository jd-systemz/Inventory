// PASTE your deployed Apps Script Web App URL here (ends in /exec):
const API_URL = 'https://script.google.com/macros/s/AKfycbxx448moFrOP0e5lYa9FBpzXiXdCgvyqT3xhYHhfuL-ecdJk8as7pSvFeZfmhvYGbQ-/exec';
const LAST_VIEW_KEY = 'inventory_last_view';
const THEME_KEY = 'inventory_theme';

// ===================== THEME (light / dark) =====================
(function () {
  const toggle = document.getElementById('themeToggle');
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    toggle.textContent = theme === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19';
    localStorage.setItem(THEME_KEY, theme);
  }
  toggle.addEventListener('click', function () {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
  });
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
})();

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

function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () {
      const base64 = reader.result.split(',')[1];
      resolve({ base64Data: base64, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    };
    reader.onerror = function () { reject(new Error('Could not read the selected file.')); };
    reader.readAsDataURL(file);
  });
}

// Encodes every file in a FileList (from a multi-select <input type="file">)
// in parallel, preserving order.
function filesToBase64Array(fileList) {
  return Promise.all(Array.from(fileList).map(fileToBase64));
}

// ===================== DRAG-AND-DROP ATTACHMENT ZONE =====================
// Keeps its own file list in memory (not the native <input>'s FileList,
// which can't easily be appended to) so that clicking to browse AND
// dragging files in both add to the same pending set, with per-file remove
// buttons. Call once per prefix; returns { getFiles, reset }.

function humanFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[i];
}

function setupDropzone(prefix) {
  const zone = document.getElementById(prefix + '-dropzone');
  const input = document.getElementById(prefix + '-attachment');
  const listEl = document.getElementById(prefix + '-attachment-filelist');
  if (!zone || !input || !listEl) return { getFiles: function () { return []; }, reset: function () {} };

  let files = [];

  function render() {
    listEl.innerHTML = '';
    files.forEach(function (f, idx) {
      const item = document.createElement('div');
      item.className = 'filelist-item';
      item.innerHTML =
        '<span class="filelist-item-name">' + escapeHtml(f.name) + '</span>' +
        '<span class="filelist-item-size">' + humanFileSize(f.size) + '</span>' +
        '<button type="button" class="filelist-remove" data-idx="' + idx + '">&#10005;</button>';
      listEl.appendChild(item);
    });
    listEl.querySelectorAll('.filelist-remove').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        files.splice(Number(btn.dataset.idx), 1);
        render();
      });
    });
  }

  function addFiles(fileListLike) {
    Array.from(fileListLike).forEach(function (f) { files.push(f); });
    render();
  }

  zone.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () {
    addFiles(input.files);
    input.value = ''; // reset so picking the same file again still fires 'change'
  });

  zone.addEventListener('dragover', function (e) {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', function () {
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });

  return {
    getFiles: function () { return files; },
    reset: function () { files = []; render(); }
  };
}

// Safety net: without this, dropping a file anywhere outside a dropzone
// makes the browser navigate away and open/download that file instead of
// just ignoring the drop.
window.addEventListener('dragover', function (e) { e.preventDefault(); });
window.addEventListener('drop', function (e) { e.preventDefault(); });

// ===================== MENU (with last-view persistence) =====================

const views = ['checkStocks', 'correctStocks', 'updateRack', 'barcodeDone', 'receiving', 'issuance', 'inventoryControls'];
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

function activateView(target) {
  document.querySelectorAll('.menu-item').forEach(function (b) {
    b.classList.toggle('active', b.dataset.view === target);
  });
  views.forEach(function (v) {
    document.getElementById('view-' + v).classList.toggle('active', v === target);
  });
}

document.querySelectorAll('.menu-item').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const target = btn.dataset.view;
    activateView(target);
    localStorage.setItem(LAST_VIEW_KEY, target);
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

function openScannerContinuous(title, onDecoded) {
  document.getElementById('scannerTitle').textContent = title;
  clearScannerFeedback();
  document.getElementById('scannerModal').classList.remove('hidden');
  modalScanner = new Html5Qrcode('scannerRegion');
  modalScannerActive = true;
  let lastCode = null;
  let lastTime = 0;
  modalScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 150 } },
    function (decodedText) {
      const code = decodedText.trim();
      const now = Date.now();
      if (code === lastCode && (now - lastTime) < 2500) return;
      lastCode = code;
      lastTime = now;
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

function clearScannerFeedback() {
  const box = document.getElementById('scannerFeedback');
  box.innerHTML = '';
  box.classList.add('hidden');
}

function appendScannerFeedback(html) {
  const box = document.getElementById('scannerFeedback');
  box.classList.remove('hidden');
  const line = document.createElement('div');
  line.className = 'feedback-line';
  line.innerHTML = html;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 50) box.removeChild(box.firstChild);
}

function overwriteEmit(el) {
  return function (html) {
    el.classList.remove('hidden');
    el.innerHTML = html;
  };
}
function appendEmit() {
  return function (html) { appendScannerFeedback(html); };
}

// ===================== CHECK STOCKS =====================

document.getElementById('checkStocks-scan-btn').addEventListener('click', function () {
  openScanner('Scan Item Code', lookupItem);
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
      '<div class="result-row"><span class="result-label">Stock on Hand</span><span class="result-value">' + escapeHtml(String(res.stockOnHand)) + '</span></div>' +
      (res.rack ? '<div class="result-row"><span class="result-label">Rack</span><span class="result-value">' + escapeHtml(String(res.rack)) + '</span></div>' : '') +
      (res.barcodeDone ? '<div class="result-row"><span class="result-label">Barcode Done</span><span class="result-value">Yes</span></div>' : '');
  } catch (err) {
    resultBox.innerHTML = '<div class="msg error">' + escapeHtml(err.message || String(err)) + '</div>';
  }
}

// ===================== CORRECT STOCKS =====================

function setupCorrectStocksForm() {
  const resultBox = document.getElementById('correctResult');
  const inputWrap = document.getElementById('correctInputWrap');
  const valueInput = document.getElementById('correctActualStock');
  const addBtn = document.getElementById('correctAddToList');
  const scanBtn = document.getElementById('correctStocks-scan-btn');
  const tableBody = document.querySelector('#correctStocks-table tbody');
  const countEl = document.getElementById('correctStocks-count');
  const submitAllBtn = document.getElementById('correctStocks-submit-all');
  const msg = document.getElementById('msg-correctStocks');

  let currentLookup = null;
  let pending = [];

  function render() {
    tableBody.innerHTML = '';
    pending.forEach(function (row, idx) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(row.itemName) + '</td>' +
        '<td>' + escapeHtml(row.itemCode) + '</td>' +
        '<td>' + escapeHtml(String(row.currentValue)) + '</td>' +
        '<td>' + escapeHtml(String(row.newValue)) + '</td>' +
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

  async function lookup(code) {
    if (!code) return;
    msg.classList.add('hidden');
    inputWrap.classList.add('hidden');
    currentLookup = null;
    resultBox.classList.remove('hidden');
    resultBox.innerHTML = '<span class="spinner"></span> Looking up "' + escapeHtml(code) + '"...';
    try {
      const res = await apiGet('checkStock', { code: code });
      if (res.error) { resultBox.innerHTML = '<div class="msg error">' + escapeHtml(res.error) + '</div>'; return; }
      if (!res.found) { resultBox.innerHTML = '<div class="msg error">' + escapeHtml(res.message) + '</div>'; return; }

      if (pending.some(function (r) { return r.itemCode === res.itemCode; })) {
        resultBox.innerHTML = '<div class="msg error">' + escapeHtml(res.item) + ' is already staged below - remove it first if you want to re-enter it.</div>';
        return;
      }

      currentLookup = { item: res.item, itemCode: res.itemCode, currentValue: res.stockOnHand };
      resultBox.innerHTML =
        '<div class="result-row"><span class="result-label">Item</span><span class="result-value">' + escapeHtml(res.item) + '</span></div>' +
        '<div class="result-row"><span class="result-label">Item Code</span><span class="result-value">' + escapeHtml(res.itemCode) + '</span></div>' +
        '<div class="result-row"><span class="result-label">Stock on Hand</span><span class="result-value">' + escapeHtml(String(res.stockOnHand)) + '</span></div>';
      valueInput.value = '';
      inputWrap.classList.remove('hidden');
      valueInput.focus();
    } catch (err) {
      resultBox.innerHTML = '<div class="msg error">' + escapeHtml(err.message || String(err)) + '</div>';
    }
  }

  setupCombo('correctStocks-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; }, function (code) {
    lookup(code);
  });
  scanBtn.addEventListener('click', function () { openScanner('Scan Item Code', lookup); });

  addBtn.addEventListener('click', function () {
    if (!currentLookup) { alert('Search or scan an item first.'); return; }
    if (valueInput.value === '' || isNaN(Number(valueInput.value)) || Number(valueInput.value) < 0) {
      alert('Enter a valid actual stock count (0 or more).');
      return;
    }

    pending.push({
      itemCode: currentLookup.itemCode,
      itemName: currentLookup.item,
      currentValue: currentLookup.currentValue,
      newValue: Number(valueInput.value)
    });
    render();

    currentLookup = null;
    inputWrap.classList.add('hidden');
    resultBox.classList.add('hidden');
    combos['correctStocks-item'].clear();
  });

  submitAllBtn.addEventListener('click', async function () {
    if (!pending.length) return;
    submitAllBtn.disabled = true;
    msg.className = 'msg';
    msg.classList.remove('hidden');
    msg.innerHTML = '<span class="spinner"></span> Saving ' + pending.length + ' correction(s)...';

    try {
      const rows = pending.map(function (row) { return { itemCode: row.itemCode, actualStockOnHand: row.newValue }; });
      const res = await apiPost('bulkCorrectStock', { rows: rows });
      if (res.error) throw new Error(res.error);

      msg.className = 'msg success';
      msg.innerHTML = res.count + ' stock correction(s) saved.';
      if (res.notFound && res.notFound.length) {
        msg.innerHTML += '<br>Not found / skipped: ' + res.notFound.map(escapeHtml).join(', ');
      }

      pending = [];
      render();
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message || String(err);
      submitAllBtn.disabled = false;
    }
  });

  render();
}

// ===================== UPDATE RACK =====================

function setupRackForm() {
  const prefixSel = document.getElementById('rackPrefix');
  const numberSel = document.getElementById('rackNumber');
  const letterSel = document.getElementById('rackLetter');
  const selectedLabel = document.getElementById('rackSelectedLabel');
  const scanBtn = document.getElementById('startScanRack');
  const comboInput = document.getElementById('updateRack-item-input');
  const resultBox = document.getElementById('rackResult');
  const tableBody = document.querySelector('#updateRack-table tbody');
  const countEl = document.getElementById('updateRack-count');
  const submitAllBtn = document.getElementById('updateRack-submit-all');
  const msg = document.getElementById('msg-updateRack');

  for (let i = 1; i <= 25; i++) {
    const val = 'R' + String(i).padStart(2, '0');
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    numberSel.appendChild(opt);
  }

  let pending = [];

  function currentRackValue() {
    if (!prefixSel.value || !numberSel.value || !letterSel.value) return '';
    return prefixSel.value + '-' + numberSel.value + '_' + letterSel.value;
  }

  function updateRackReadiness() {
    const rack = currentRackValue();
    const ready = !!rack;
    scanBtn.disabled = !ready;
    comboInput.disabled = !ready;
    selectedLabel.textContent = ready ? ('Scanning into: ' + rack) : 'Select LOB, rack #, and section to begin.';
  }
  [prefixSel, numberSel, letterSel].forEach(function (sel) {
    sel.addEventListener('change', updateRackReadiness);
  });
  updateRackReadiness();

  function render() {
    tableBody.innerHTML = '';
    pending.forEach(function (row, idx) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(row.itemName) + '</td>' +
        '<td>' + escapeHtml(row.itemCode) + '</td>' +
        '<td>' + escapeHtml(String(row.currentValue)) + '</td>' +
        '<td>' + escapeHtml(row.newValue) + '</td>' +
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

  async function stageByCode(code, emit, showLoading) {
    const rack = currentRackValue();
    if (!rack) { alert('Select LOB, rack #, and section first.'); return; }
    if (!code) return;

    if (showLoading !== false) {
      emit('<span class="spinner"></span> Looking up "' + escapeHtml(code) + '"...');
    }
    try {
      const res = await apiGet('checkStock', { code: code });
      if (res.error) { emit('<div class="msg error" style="margin:0;">' + escapeHtml(res.error) + '</div>'); return; }
      if (!res.found) { emit('<div class="msg error" style="margin:0;">' + escapeHtml(res.message) + '</div>'); return; }

      const idx = pending.findIndex(function (r) { return r.itemCode === res.itemCode; });
      if (idx !== -1) {
        pending[idx].newValue = rack;
        render();
        emit('<div class="msg success" style="margin:0;">Moved ' + escapeHtml(res.item) + ' to ' + escapeHtml(rack) + '.</div>');
        return;
      }

      pending.push({ itemCode: res.itemCode, itemName: res.item, currentValue: res.rack || '(none)', newValue: rack });
      render();
      emit('<div class="msg success" style="margin:0;">Added ' + escapeHtml(res.item) + ' &rarr; ' + escapeHtml(rack) + '.</div>');
    } catch (err) {
      emit('<div class="msg error" style="margin:0;">' + escapeHtml(err.message || String(err)) + '</div>');
    }
  }

  setupCombo('updateRack-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; }, function (code) {
    stageByCode(code, overwriteEmit(resultBox));
  });

  scanBtn.addEventListener('click', function () {
    const rack = currentRackValue();
    openScannerContinuous('Scan items for ' + rack, function (code) {
      stageByCode(code, appendEmit(), false);
    });
  });

  submitAllBtn.addEventListener('click', async function () {
    if (!pending.length) return;
    submitAllBtn.disabled = true;
    msg.className = 'msg';
    msg.classList.remove('hidden');
    msg.innerHTML = '<span class="spinner"></span> Saving ' + pending.length + ' rack update(s)...';

    try {
      const rows = pending.map(function (row) { return { itemCode: row.itemCode, rack: row.newValue }; });
      const res = await apiPost('bulkUpdateRack', { rows: rows });
      if (res.error) throw new Error(res.error);

      msg.className = 'msg success';
      msg.innerHTML = res.count + ' rack update(s) saved.';
      if (res.notFound && res.notFound.length) {
        msg.innerHTML += '<br>Not found / skipped: ' + res.notFound.map(escapeHtml).join(', ');
      }

      pending = [];
      render();
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message || String(err);
      submitAllBtn.disabled = false;
    }
  });

  render();
}

// ===================== BARCODE DONE =====================

function setupBarcodeDoneForm() {
  const scanBtn = document.getElementById('startScanBarcodeDone');
  const resultBox = document.getElementById('barcodeDoneResult');
  const tableBody = document.querySelector('#barcodeDone-table tbody');
  const countEl = document.getElementById('barcodeDone-count');
  const submitAllBtn = document.getElementById('barcodeDone-submit-all');
  const msg = document.getElementById('msg-barcodeDone');

  let pending = [];

  function render() {
    tableBody.innerHTML = '';
    pending.forEach(function (row, idx) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(row.itemName) + '</td>' +
        '<td>' + escapeHtml(row.itemCode) + '</td>' +
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

  async function stageByCode(code, emit, showLoading) {
    if (!code) return;
    if (showLoading !== false) {
      emit('<span class="spinner"></span> Looking up "' + escapeHtml(code) + '"...');
    }
    try {
      const res = await apiGet('checkStock', { code: code });
      if (res.error) { emit('<div class="msg error" style="margin:0;">' + escapeHtml(res.error) + '</div>'); return; }
      if (!res.found) { emit('<div class="msg error" style="margin:0;">' + escapeHtml(res.message) + '</div>'); return; }

      if (pending.some(function (r) { return r.itemCode === res.itemCode; })) {
        emit('<div class="msg error" style="margin:0;">' + escapeHtml(res.item) + ' is already staged.</div>');
        return;
      }

      pending.push({ itemCode: res.itemCode, itemName: res.item });
      render();
      emit('<div class="msg success" style="margin:0;">Marked ' + escapeHtml(res.item) + ' &#10003;</div>');
    } catch (err) {
      emit('<div class="msg error" style="margin:0;">' + escapeHtml(err.message || String(err)) + '</div>');
    }
  }

  setupCombo('barcodeDone-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; }, function (code) {
    stageByCode(code, overwriteEmit(resultBox));
  });

  scanBtn.addEventListener('click', function () {
    openScannerContinuous('Scan items to mark Barcode Done', function (code) {
      stageByCode(code, appendEmit(), false);
    });
  });

  submitAllBtn.addEventListener('click', async function () {
    if (!pending.length) return;
    submitAllBtn.disabled = true;
    msg.className = 'msg';
    msg.classList.remove('hidden');
    msg.innerHTML = '<span class="spinner"></span> Saving ' + pending.length + ' item(s)...';

    try {
      const rows = pending.map(function (row) { return { itemCode: row.itemCode }; });
      const res = await apiPost('bulkMarkBarcodeDone', { rows: rows });
      if (res.error) throw new Error(res.error);

      msg.className = 'msg success';
      msg.innerHTML = res.count + ' item(s) marked Barcode Done.';
      if (res.notFound && res.notFound.length) {
        msg.innerHTML += '<br>Not found / skipped: ' + res.notFound.map(escapeHtml).join(', ');
      }

      pending = [];
      render();
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message || String(err);
      submitAllBtn.disabled = false;
    }
  });

  render();
}

// ===================== INVENTORY CONTROLS (new) =====================
// Three server-side jobs. "Update Dropdown in Logs" resolves in a couple of
// seconds (it's a direct Smartsheet call). The two barcode jobs just fire a
// GitHub Actions run and return immediately — the real work happens on
// GitHub's side over the next minute or two.

function setupInventoryControls() {
  const msg = document.getElementById('msg-inventoryControls');

  function wire(btnId, action, confirmText) {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', async function () {
      if (confirmText && !confirm(confirmText)) return;
      btn.disabled = true;
      msg.className = 'msg';
      msg.classList.remove('hidden');
      msg.innerHTML = '<span class="spinner"></span> Working...';
      try {
        const res = await apiPost(action, {});
        if (res.error) throw new Error(res.error);
        msg.className = 'msg success';
        msg.textContent = res.message || 'Done.';
      } catch (err) {
        msg.className = 'msg error';
        msg.textContent = err.message || String(err);
      } finally {
        btn.disabled = false;
      }
    });
  }

  wire('btn-generateBarcode', 'triggerGenerateBarcode');
  wire('btn-downloadBarcodeImage', 'triggerDownloadBarcodeImage');
  wire('btn-updateDropdown', 'updateDropdownInLogs',
    'This overwrites the "Enhanced Item" dropdown options with the current Item list. Continue?');
}

// ===================== SMARTSHEET LINKS ("where is this saved?") =====================

async function loadSheetLinks() {
  try {
    const links = await apiGet('getSheetLinks');
    if (links.error) { console.error(links.error); return; }
    const sourceLinkIds = ['checkstocks-sheet-link', 'correctstocks-sheet-link', 'updateRack-sheet-link', 'barcodeDone-sheet-link'];
    const txnLinkIds = ['receiving-sheet-link', 'issuance-sheet-link'];
    if (links.sourceSheetUrl) {
      sourceLinkIds.forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.href = links.sourceSheetUrl;
        el.classList.remove('hidden');
      });
    }
    if (links.transactionsSheetUrl) {
      txnLinkIds.forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.href = links.transactionsSheetUrl;
        el.classList.remove('hidden');
      });
    }
  } catch (err) {
    console.error(err);
  }
}

// ===================== GENERIC TYPE-TO-SEARCH COMBOBOX =====================

const combos = {};

function setupCombo(key, getOptions, getErrorText, getOptionValue, onSelect) {
  const input = document.getElementById(key + '-input');
  const hidden = document.getElementById(key + '-value');
  const list = document.getElementById(key + '-list');
  if (!input || !hidden || !list) return null;

  function render(filterText, forceShow) {
    const q = (filterText || '').trim().toLowerCase();
    const options = getOptions();
    const matches = options.filter(function (o) {
      if (!q) return true;
      return o.name.toLowerCase().indexOf(q) !== -1 ||
        (o.code && o.code.toLowerCase().indexOf(q) !== -1);
    }).slice(0, 50);

    list.innerHTML = '';
    if (!options.length) {
      list.innerHTML = '<div class="combo-empty">' + escapeHtml(getErrorText() || 'Loading...') + '</div>';
    } else if (!matches.length) {
      list.innerHTML = '<div class="combo-empty">No matching results.</div>';
    } else {
      matches.forEach(function (o) {
        const label = o.code ? (o.name + ' (' + o.code + ')') : o.name;
        const opt = document.createElement('div');
        opt.className = 'combo-option';
        opt.textContent = label;
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          input.value = label;
          hidden.value = getOptionValue(o);
          list.classList.add('hidden');
          if (onSelect) onSelect(hidden.value, o);
        });
        list.appendChild(opt);
      });
    }

    const shouldShow = forceShow || document.activeElement === input;
    list.classList.toggle('hidden', !shouldShow);
  }

  input.addEventListener('focus', function () { render(input.value, true); });
  input.addEventListener('input', function () {
    hidden.value = '';
    render(input.value, true);
  });
  input.addEventListener('blur', function () {
    setTimeout(function () { list.classList.add('hidden'); }, 120);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') list.classList.add('hidden');
  });

  const instance = {
    render: render,
    setValue: function (value) {
      const match = getOptions().filter(function (o) { return getOptionValue(o) === value; })[0];
      input.value = match ? (match.code ? match.name + ' (' + match.code + ')' : match.name) : value;
      hidden.value = value;
      list.classList.add('hidden');
    },
    clear: function () {
      input.value = '';
      hidden.value = '';
      list.classList.add('hidden');
    },
    refresh: function () { render(input.value, false); }
  };
  combos[key] = instance;
  return instance;
}

// ===================== ITEM LIST (shared by every item combo in the app) =====================

let itemOptions = [];
let itemListError = null;
const ITEM_COMBO_KEYS = ['checkStocks-item', 'correctStocks-item', 'updateRack-item', 'barcodeDone-item', 'receiving-item', 'issuance-item'];

async function loadItemList() {
  itemListError = null;
  try {
    const items = await apiGet('getItemList');
    if (items.error) throw new Error(items.error);
    itemOptions = items;
  } catch (err) {
    itemListError = (err.message || String(err)) +
      ' - check that your Apps Script is deployed as a NEW version after any code changes.';
    itemOptions = [];
  }
  ITEM_COMBO_KEYS.forEach(function (key) {
    if (combos[key]) combos[key].refresh();
  });
}

// ===================== REQUESTOR OPTIONS (Issuance only) =====================

let requestorOptions = [];
let requestorListError = null;

async function loadRequestorOptions() {
  requestorListError = null;
  const errBox = document.getElementById('requestor-load-error');
  try {
    const options = await apiGet('getRequestorOptions');
    if (options.error) throw new Error(options.error);
    requestorOptions = options.map(function (name) { return { name: name, code: '' }; });
    errBox.classList.add('hidden');
  } catch (err) {
    requestorListError = err.message || String(err);
    requestorOptions = [];
    errBox.textContent = requestorListError;
    errBox.classList.remove('hidden');
  }
  if (combos['issuance-requestor']) combos['issuance-requestor'].refresh();
}

// ===================== SCAN TO FILL ITEM FIELD (Receiving / Issuance) =====================

document.querySelectorAll('.scan-item-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const key = btn.dataset.target;
    openScanner('Scan Item Barcode', function (code) {
      selectItemByCode(key, code);
    });
  });
});

async function selectItemByCode(key, code) {
  const prefix = key.split('-')[0];
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
    const exists = itemOptions.some(function (o) { return o.code === res.itemCode; });
    if (exists) {
      combos[key].setValue(res.itemCode);
      msg.classList.add('hidden');
    } else {
      msg.className = 'msg error';
      msg.textContent = 'Scanned item "' + res.item + '" was not found in the item list.';
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message || String(err);
  }
}

// ===================== RECEIVING / ISSUANCE — BULK ADD & SUBMIT =====================

function setupBulkForm(prefix, type) {
  const dateInput = document.getElementById(prefix + '-date');
  const mrfInput = document.getElementById(prefix + '-mrf');
  const projectNameInput = document.getElementById(prefix + '-projectName');
  const soNumberInput = document.getElementById(prefix + '-soNumber');
  const priceInput = document.getElementById(prefix + '-unitPrice');
  const qtyInput = document.getElementById(prefix + '-qty');
  const lobSel = document.getElementById(prefix + '-lob');
  const completedSel = document.getElementById(prefix + '-completed');
  const sizeInput = document.getElementById(prefix + '-size');
  const uomInput = document.getElementById(prefix + '-uom');
  const purposeSel = document.getElementById(prefix + '-purpose');

  function getRequestStatus() {
    const checked = document.querySelector('input[name="' + prefix + '-requestStatus"]:checked');
    return checked ? checked.value : 'Ongoing';
  }
  function resetRequestStatus() {
    const ongoingRadio = document.querySelector('input[name="' + prefix + '-requestStatus"][value="Ongoing"]');
    if (ongoingRadio) ongoingRadio.checked = true;
  }
  const addBtn = document.getElementById(prefix + '-add');
  const tableBody = document.querySelector('#' + prefix + '-table tbody');
  const countEl = document.getElementById(prefix + '-count');
  const submitAllBtn = document.getElementById(prefix + '-submit-all');
  const msg = document.getElementById('msg-' + prefix);
  const attachmentZone = setupDropzone(prefix);
  const requestorCombo = combos[prefix + '-requestor'];

  let pending = [];
  dateInput.value = new Date().toISOString().slice(0, 10);

  function render() {
    tableBody.innerHTML = '';
    pending.forEach(function (row, idx) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(row.itemName) + '</td>' +
        '<td>' + escapeHtml(row.mrf || '') + '</td>' +
        '<td>' + escapeHtml(row.unitPrice) + '</td>' +
        '<td>' + escapeHtml(row.qty) + '</td>' +
        '<td>' + escapeHtml(row.lob) + '</td>' +
        '<td>' + escapeHtml(row.completed) + '</td>' +
        '<td>' + escapeHtml(row.requestStatus) + '</td>' +
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
    const itemCode = document.getElementById(prefix + '-item-value').value;
    if (!itemCode) { alert('Select an item first (type to search, or tap Scan).'); return; }
    if (!qtyInput.value || Number(qtyInput.value) <= 0) { alert('Enter a quantity greater than 0.'); return; }
    if (!lobSel.value) { alert('Select an LOB.'); return; }

    const match = itemOptions.filter(function (o) { return o.code === itemCode; })[0];

    pending.push({
      itemCode: itemCode,
      itemName: match ? match.name : itemCode,
      mrf: mrfInput.value.trim(),
      projectName: projectNameInput.value.trim(),
      soNumber: soNumberInput.value.trim(),
      unitPrice: priceInput.value || 0,
      qty: qtyInput.value,
      lob: lobSel.value,
      completed: completedSel.value,
      size: sizeInput ? sizeInput.value.trim() : '',
      uom: uomInput ? uomInput.value.trim() : '',
      purpose: purposeSel ? purposeSel.value : 'Material Request',
      requestStatus: getRequestStatus()
    });
    render();

    combos[prefix + '-item'].clear();
    priceInput.value = '';
    qtyInput.value = '';
    if (sizeInput) sizeInput.value = '';
    if (uomInput) uomInput.value = '';
    // Request Status and Purpose are deliberately NOT reset here — a whole
    // batch is usually the same MRF# and same status/purpose.
  });

  submitAllBtn.addEventListener('click', async function () {
    if (!pending.length) return;
    if (!dateInput.value) { alert('Pick a date.'); return; }

    const badRow = pending.find(function (r) { return !r.itemCode; });
    if (badRow) {
      alert('"' + badRow.itemName + '" has no Item Code attached (this shouldn\'t happen — please remove it from the list, re-add it by searching again, and try Submit All once more).');
      return;
    }

    let resolvedRequestor = null;
    if (requestorCombo) {
      resolvedRequestor = document.getElementById(prefix + '-requestor-value').value;
      if (!resolvedRequestor) {
        alert('Please pick a requestor from the suggestions (type a few letters and tap a match).');
        return;
      }
    }

    submitAllBtn.disabled = true;
    msg.className = 'msg';
    msg.classList.remove('hidden');
    msg.innerHTML = '<span class="spinner"></span> Saving ' + pending.length + ' item(s)...';

    try {
      const payload = { type: type, date: dateInput.value, rows: pending };
      if (resolvedRequestor) payload.requestor = resolvedRequestor;
      const attachedFiles = attachmentZone.getFiles();
      if (attachedFiles.length) {
        payload.attachments = await filesToBase64Array(attachedFiles);
      }

      const res = await apiPost('submitBulkTransactions', payload);
      if (res.error) throw new Error(res.error);

      msg.className = 'msg success';
      msg.innerHTML = res.count + ' ' + type.toLowerCase() + ' entr' + (res.count === 1 ? 'y' : 'ies') + ' added successfully.';
      if (res.rowLinks && res.rowLinks.length) {
        msg.innerHTML += '<div class="row-links">Jump straight to the new row: ' +
          res.rowLinks.map(function (link, i) {
            return '<a href="' + link + '" target="_blank" rel="noopener" class="sheet-link-inline">Open row ' +
              (res.rowNumbers[i] || i + 1) + ' &#8599;</a>';
          }).join(' ') + '</div>';
      } else if (res.rowNumbers && res.rowNumbers.length) {
        msg.innerHTML += ' Look for row' + (res.rowNumbers.length === 1 ? ' ' : 's ') +
          '<strong>' + res.rowNumbers.join(', ') + '</strong> in Smartsheet.';
      }
      if (res.sheetUrl) {
        msg.innerHTML += ' <a href="' + res.sheetUrl + '" target="_blank" rel="noopener" class="sheet-link-inline">View in Smartsheet &#8599;</a>';
      }
      if (res.attachmentWarning) msg.innerHTML += '<br>' + escapeHtml(res.attachmentWarning);
      if (res.secondSheetWarning) {
        msg.innerHTML += '<br>' + escapeHtml(res.secondSheetWarning);
      } else if (res.secondSheetCount) {
        msg.innerHTML += '<br>Mirrored ' + res.secondSheetCount + ' row(s) to MRF & PO Monitoring.';
      }
      if (res.cascadedMrfNumbers && res.cascadedMrfNumbers.length) {
        msg.innerHTML += '<br>Marked all rows for MRF# ' + res.cascadedMrfNumbers.map(escapeHtml).join(', ') + ' as Completed.';
      }

      pending = [];
      render();
      mrfInput.value = '';
      projectNameInput.value = '';
      soNumberInput.value = '';
      priceInput.value = '';
      qtyInput.value = '';
      lobSel.value = '';
      completedSel.value = 'YES';
      resetRequestStatus();
      attachmentZone.reset();
      if (requestorCombo) requestorCombo.clear();
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message || String(err);
      submitAllBtn.disabled = false;
    }
  });

  render();
}

// ===================== INIT =====================

window.addEventListener('load', function () {
  activateView(localStorage.getItem(LAST_VIEW_KEY) || 'checkStocks');

  setupCombo('checkStocks-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; }, function (code) { lookupItem(code); });
  setupCombo('receiving-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; });
  setupCombo('issuance-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; });
  setupCombo('issuance-requestor', function () { return requestorOptions; }, function () { return requestorListError; }, function (o) { return o.name; });

  loadItemList();
  loadSheetLinks();
  loadRequestorOptions();
  setupCorrectStocksForm();
  setupRackForm();
  setupBarcodeDoneForm();
  setupBulkForm('receiving', 'Receiving');
  setupBulkForm('issuance', 'Issuance');
  setupInventoryControls();
});
