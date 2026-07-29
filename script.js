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

// Local (not UTC) yyyy-mm-dd, so "today" is always today regardless of timezone.
function todayISO() {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

// ===================== MENU (with last-view persistence) =====================

const views = ['checkStocks', 'receiving', 'issuance'];
const LAST_VIEW_KEY = 'inventoryApp:lastView';
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
    try { localStorage.setItem(LAST_VIEW_KEY, target); } catch (e) { /* ignore storage errors */ }
    closeMenu();
  });
});

// Restore whichever view was open before refresh (defaults to Check Stocks
// the very first time, or if nothing was saved).
(function restoreLastView() {
  let saved = null;
  try { saved = localStorage.getItem(LAST_VIEW_KEY); } catch (e) { /* ignore */ }
  activateView(views.indexOf(saved) !== -1 ? saved : 'checkStocks');
})();

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

// ===================== CHECK STOCKS (untouched logic) =====================

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

// ===================== ITEM LIST (shared cache for both combos) =====================

let itemListCache = [];
let itemListError = null;

async function loadItemList() {
  itemListError = null;
  try {
    const items = await apiGet('getItemList');
    if (items.error) throw new Error(items.error);
    itemListCache = items;
  } catch (err) {
    itemListError = (err.message || String(err)) +
      ' — check that your Apps Script is deployed as a NEW version after any code changes.';
    itemListCache = [];
  }
  ['receiving', 'issuance'].forEach(function (prefix) {
    const errBox = document.getElementById(prefix + '-item-error');
    if (itemListError) {
      errBox.textContent = itemListError;
      errBox.classList.remove('hidden');
    } else {
      errBox.classList.add('hidden');
    }
  });
}

// ===================== TYPE-TO-SEARCH COMBOBOX =====================

function setupCombo(prefix) {
  const input = document.getElementById(prefix + '-item-input');
  const hidden = document.getElementById(prefix + '-item-value');
  const list = document.getElementById(prefix + '-item-list');

  function render(filterText) {
    const q = (filterText || '').trim().toLowerCase();
    const matches = itemListCache.filter(function (it) {
      if (!q) return true;
      return it.name.toLowerCase().indexOf(q) !== -1 ||
        (it.code && it.code.toLowerCase().indexOf(q) !== -1);
    }).slice(0, 50);

    list.innerHTML = '';
    if (!itemListCache.length) {
      list.innerHTML = '<div class="combo-empty">' +
        (itemListError ? 'Items failed to load — see error above.' : 'Loading items...') +
        '</div>';
    } else if (!matches.length) {
      list.innerHTML = '<div class="combo-empty">No matching items.</div>';
    } else {
      matches.forEach(function (it) {
        const opt = document.createElement('div');
        opt.className = 'combo-option';
        opt.textContent = it.code ? (it.name + ' (' + it.code + ')') : it.name;
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault(); // keep focus so 'blur' doesn't fire before click registers
          selectComboItem(prefix, it.name);
        });
        list.appendChild(opt);
      });
    }
    list.classList.remove('hidden');
  }

  input.addEventListener('focus', function () { render(input.value); });
  input.addEventListener('input', function () {
    hidden.value = ''; // typing invalidates any previously selected/scanned item
    render(input.value);
  });
  input.addEventListener('blur', function () {
    setTimeout(function () { list.classList.add('hidden'); }, 100);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') list.classList.add('hidden');
  });
}

function selectComboItem(prefix, itemName) {
  document.getElementById(prefix + '-item-input').value = itemName;
  document.getElementById(prefix + '-item-value').value = itemName;
  document.getElementById(prefix + '-item-list').classList.add('hidden');
}

function clearCombo(prefix) {
  document.getElementById(prefix + '-item-input').value = '';
  document.getElementById(prefix + '-item-value').value = '';
}

// ===================== SCAN TO SELECT ITEM (Receiving / Issuance) =====================

document.querySelectorAll('.scan-item-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const targetPrefix = btn.dataset.target.split('-')[0]; // 'receiving' or 'issuance'
    openScanner('Scan Item Barcode', function (code) {
      selectItemByCode(targetPrefix, code);
    });
  });
});

async function selectItemByCode(prefix, code) {
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
    const exists = itemListCache.some(function (it) { return it.name === res.item; });
    if (exists) {
      selectComboItem(prefix, res.item);
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

// ===================== PHOTO UPLOAD (optional, per line) =====================
// Downscales to a max of 1280px and re-encodes as JPEG so uploads stay small.

function compressImageFile(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const maxDim = 1280;
        let width = img.width, height = img.height;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { reject(new Error('Could not read image.')); };
      img.src = e.target.result;
    };
    reader.onerror = function () { reject(new Error('Could not read file.')); };
    reader.readAsDataURL(file);
  });
}

function setupPhotoInput(prefix) {
  const fileInput = document.getElementById(prefix + '-photo');
  const preview = document.getElementById(prefix + '-photo-preview');
  let currentDataUrl = null;

  fileInput.addEventListener('change', async function () {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      currentDataUrl = await compressImageFile(file);
      renderPreview();
    } catch (err) {
      alert(err.message || String(err));
      resetPhoto();
    }
  });

  function renderPreview() {
    preview.classList.remove('hidden');
    preview.innerHTML = '<img src="' + currentDataUrl + '" alt="Preview" />' +
      '<button type="button" class="remove-photo">Remove</button>';
    preview.querySelector('.remove-photo').addEventListener('click', resetPhoto);
  }

  function resetPhoto() {
    currentDataUrl = null;
    fileInput.value = '';
    preview.classList.add('hidden');
    preview.innerHTML = '';
  }

  return {
    getDataUrl: function () { return currentDataUrl; },
    reset: resetPhoto
  };
}

// ===================== RECEIVING / ISSUANCE — BULK ADD & SUBMIT =====================

function setupBulkForm(prefix, type) {
  const dateInput = document.getElementById(prefix + '-date');
  const priceInput = document.getElementById(prefix + '-unitPrice');
  const qtyInput = document.getElementById(prefix + '-qty');
  const lobSel = document.getElementById(prefix + '-lob');
  const completedSel = document.getElementById(prefix + '-completed');
  const addBtn = document.getElementById(prefix + '-add');
  const tableBody = document.querySelector('#' + prefix + '-table tbody');
  const countEl = document.getElementById(prefix + '-count');
  const submitAllBtn = document.getElementById(prefix + '-submit-all');
  const msg = document.getElementById('msg-' + prefix);
  const photo = setupPhotoInput(prefix);

  let pending = [];
  dateInput.value = todayISO();

  function render() {
    tableBody.innerHTML = '';
    pending.forEach(function (row, idx) {
      const tr = document.createElement('tr');
      const photoCell = row.photoDataUrl
        ? '<img class="thumb" src="' + row.photoDataUrl + '" alt="photo" />'
        : '<span class="no-photo">&mdash;</span>';
      tr.innerHTML =
        '<td>' + escapeHtml(row.itemName) + '</td>' +
        '<td>' + escapeHtml(row.unitPrice) + '</td>' +
        '<td>' + escapeHtml(row.qty) + '</td>' +
        '<td>' + escapeHtml(row.lob) + '</td>' +
        '<td>' + escapeHtml(row.completed) + '</td>' +
        '<td>' + photoCell + '</td>' +
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
    const itemName = document.getElementById(prefix + '-item-value').value;
    if (!itemName) { alert('Select an item first (type to search, or tap Scan).'); return; }
    if (!qtyInput.value || Number(qtyInput.value) <= 0) { alert('Enter a quantity greater than 0.'); return; }
    if (!lobSel.value) { alert('Select an LOB.'); return; }

    const dataUrl = photo.getDataUrl();
    pending.push({
      itemName: itemName,
      unitPrice: priceInput.value || 0,
      qty: qtyInput.value,
      lob: lobSel.value,
      completed: completedSel.value,
      photoDataUrl: dataUrl,
      photoBase64: dataUrl ? dataUrl.split(',')[1] : null,
      photoName: dataUrl ? (itemName.replace(/[^a-z0-9]/gi, '_') + '.jpg') : null,
      photoType: dataUrl ? 'image/jpeg' : null
    });
    render();

    // Clear the item-specific fields so the next line starts fresh;
    // keep LOB/Completed since batches are often all the same.
    clearCombo(prefix);
    priceInput.value = '';
    qtyInput.value = '';
    photo.reset();
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
        rows: pending.map(function (r) {
          return {
            itemName: r.itemName,
            unitPrice: r.unitPrice,
            qty: r.qty,
            lob: r.lob,
            completed: r.completed,
            imageBase64: r.photoBase64 || undefined,
            imageName: r.photoName || undefined,
            imageType: r.photoType || undefined
          };
        })
      });
      if (res.error) throw new Error(res.error);
      msg.className = 'msg success';
      let text = res.count + ' ' + type.toLowerCase() + ' entr' + (res.count === 1 ? 'y' : 'ies') + ' added successfully.';
      if (res.attachErrors && res.attachErrors.length) {
        text += ' (Some photos failed to attach: ' + res.attachErrors.join('; ') + ')';
      }
      msg.textContent = text;
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
  setupCombo('receiving');
  setupCombo('issuance');
  loadItemList();
  setupBulkForm('receiving', 'Receiving');
  setupBulkForm('issuance', 'Issuance');
});
