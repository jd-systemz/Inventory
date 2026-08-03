// PASTE your deployed Apps Script Web App URL here (ends in /exec):
const API_URL = 'https://script.google.com/macros/s/AKfycbxx448moFrOP0e5lYa9FBpzXiXdCgvyqT3xhYHhfuL-ecdJk8as7pSvFeZfmhvYGbQ-/exec';
const LAST_VIEW_KEY = 'inventory_last_view';

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

// ===================== MENU (with last-view persistence) =====================

const views = ['checkStocks', 'correctStocks', 'receiving', 'issuance'];
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

// ===================== CORRECT STOCKS =====================
// Same lookup as Check Stocks, plus a box to enter the physically counted
// amount. We send that count to the backend, which back-solves Beginning
// Balance so the sheet's own formula recalculates Stock on Hand to match.

let correctStockItemCode = null;

document.getElementById('startScanCorrect').addEventListener('click', function () {
  openScanner('Scan Item Code', lookupItemForCorrection);
});
document.getElementById('correctManualCodeGo').addEventListener('click', function () {
  lookupItemForCorrection(document.getElementById('correctManualCode').value.trim());
});
document.getElementById('correctManualCode').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    lookupItemForCorrection(e.target.value.trim());
  }
});

async function lookupItemForCorrection(code) {
  if (!code) return;
  const resultBox = document.getElementById('correctResult');
  const inputWrap = document.getElementById('correctInputWrap');
  const msg = document.getElementById('msg-correctStocks');

  msg.classList.add('hidden');
  inputWrap.classList.add('hidden');
  correctStockItemCode = null;

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
    correctStockItemCode = res.itemCode;
    resultBox.innerHTML =
      '<div class="result-row"><span class="result-label">Item</span><span class="result-value">' + escapeHtml(res.item) + '</span></div>' +
      '<div class="result-row"><span class="result-label">Item Code</span><span class="result-value">' + escapeHtml(res.itemCode) + '</span></div>' +
      '<div class="result-row"><span class="result-label">Stock on Hand</span><span class="result-value">' + escapeHtml(String(res.stockOnHand)) + '</span></div>';
    document.getElementById('correctActualStock').value = '';
    inputWrap.classList.remove('hidden');
  } catch (err) {
    resultBox.innerHTML = '<div class="msg error">' + escapeHtml(err.message || String(err)) + '</div>';
  }
}

document.getElementById('correctSubmit').addEventListener('click', async function () {
  const msg = document.getElementById('msg-correctStocks');
  const actualInput = document.getElementById('correctActualStock');
  const submitBtn = document.getElementById('correctSubmit');

  if (!correctStockItemCode) { alert('Scan or enter an item first.'); return; }
  if (actualInput.value === '' || isNaN(Number(actualInput.value)) || Number(actualInput.value) < 0) {
    alert('Enter a valid actual stock count (0 or more).');
    return;
  }

  submitBtn.disabled = true;
  msg.className = 'msg';
  msg.classList.remove('hidden');
  msg.innerHTML = '<span class="spinner"></span> Saving correction...';

  try {
    const res = await apiPost('correctStock', {
      itemCode: correctStockItemCode,
      actualStockOnHand: Number(actualInput.value)
    });
    if (res.error) throw new Error(res.error);

    msg.className = 'msg success';
    msg.innerHTML = 'Saved. Stock on Hand for <strong>' + escapeHtml(res.itemCode) + '</strong> now reflects the counted ' +
      escapeHtml(String(res.actualStockOnHand)) + ' (Beginning Balance set to ' + escapeHtml(String(res.newBeginningBalance)) + ').';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message || String(err);
  } finally {
    submitBtn.disabled = false;
  }
});

// ===================== SMARTSHEET LINKS ("where is this saved?") =====================

async function loadSheetLinks() {
  try {
    const links = await apiGet('getSheetLinks');
    if (links.error) { console.error(links.error); return; }
    const checkLink = document.getElementById('checkstocks-sheet-link');
    const correctLink = document.getElementById('correctstocks-sheet-link');
    const recvLink = document.getElementById('receiving-sheet-link');
    const issLink = document.getElementById('issuance-sheet-link');
    if (links.sourceSheetUrl) {
      checkLink.href = links.sourceSheetUrl;
      checkLink.classList.remove('hidden');
      correctLink.href = links.sourceSheetUrl;
      correctLink.classList.remove('hidden');
    }
    if (links.transactionsSheetUrl) {
      recvLink.href = links.transactionsSheetUrl;
      recvLink.classList.remove('hidden');
      issLink.href = links.transactionsSheetUrl;
      issLink.classList.remove('hidden');
    }
  } catch (err) {
    console.error(err);
  }
}

// ===================== GENERIC TYPE-TO-SEARCH COMBOBOX =====================
// Renders its own suggestion list in a plain <div>, instead of relying on the
// browser's native <datalist> popup (inconsistent across browsers).
//
// getOptionValue(o) decides what the "real" submitted value is for a given
// option: for the Item combos that's the Item Code; for Requestor it's the
// name itself (there's no separate code).

const combos = {}; // key -> combo instance, e.g. combos['receiving-item']

function setupCombo(key, getOptions, getErrorText, getOptionValue) {
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
          e.preventDefault(); // keep focus so 'blur' doesn't hide the list before this fires
          input.value = label;
          hidden.value = getOptionValue(o);
          list.classList.add('hidden');
        });
        list.appendChild(opt);
      });
    }

    const shouldShow = forceShow || document.activeElement === input;
    list.classList.toggle('hidden', !shouldShow);
  }

  input.addEventListener('focus', function () { render(input.value, true); });
  input.addEventListener('input', function () {
    hidden.value = ''; // typing invalidates any previously selected/scanned value
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
    refresh: function () { render(input.value, false); } // re-render without forcing it open
  };
  combos[key] = instance;
  return instance;
}

// ===================== ITEM LIST (shared by Receiving + Issuance Item combos) =====================
// Item Code is the real submitted value; Item name is shown for readability.

let itemOptions = [];   // [{ name, code }]
let itemListError = null;

async function loadItemList() {
  itemListError = null;
  try {
    const items = await apiGet('getItemList');
    if (items.error) throw new Error(items.error);
    itemOptions = items;
  } catch (err) {
    itemListError = (err.message || String(err)) +
      ' — check that your Apps Script is deployed as a NEW version after any code changes.';
    itemOptions = [];
  }
  if (combos['receiving-item']) combos['receiving-item'].refresh();
  if (combos['issuance-item']) combos['issuance-item'].refresh();
}

// ===================== REQUESTOR OPTIONS (Issuance only) =====================

let requestorOptions = []; // [{ name, code: '' }]
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
    const key = btn.dataset.target; // 'receiving-item' or 'issuance-item'
    openScanner('Scan Item Barcode', function (code) {
      selectItemByCode(key, code);
    });
  });
});

async function selectItemByCode(key, code) {
  const prefix = key.split('-')[0]; // 'receiving' or 'issuance'
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
  const mrfInput = document.getElementById(prefix + '-mrf');               // optional — not required
  const projectNameInput = document.getElementById(prefix + '-projectName'); // optional — not required
  const soNumberInput = document.getElementById(prefix + '-soNumber');     // optional — not required
  const priceInput = document.getElementById(prefix + '-unitPrice');       // optional — not required
  const qtyInput = document.getElementById(prefix + '-qty');
  const lobSel = document.getElementById(prefix + '-lob');
  const completedSel = document.getElementById(prefix + '-completed');
  const addBtn = document.getElementById(prefix + '-add');
  const tableBody = document.querySelector('#' + prefix + '-table tbody');
  const countEl = document.getElementById(prefix + '-count');
  const submitAllBtn = document.getElementById(prefix + '-submit-all');
  const msg = document.getElementById('msg-' + prefix);
  const attachmentInput = document.getElementById(prefix + '-attachment');
  const requestorCombo = combos[prefix + '-requestor']; // only exists for issuance

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
    // Note: MRF#, Project Name, SO#, and Unit Price are intentionally NOT
    // validated here — all four are optional.

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
      completed: completedSel.value
    });
    render();

    // Clear the item-specific fields so the next line starts fresh;
    // keep MRF# / Project Name / SO# / LOB / Completed since a whole batch
    // is usually encoded under the same MRF#, project, and SO#.
    combos[prefix + '-item'].clear();
    priceInput.value = '';
    qtyInput.value = '';
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
      if (attachmentInput && attachmentInput.files && attachmentInput.files[0]) {
        payload.attachment = await fileToBase64(attachmentInput.files[0]);
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

      pending = [];
      render();
      mrfInput.value = '';
      projectNameInput.value = '';
      soNumberInput.value = '';
      priceInput.value = '';
      qtyInput.value = '';
      lobSel.value = '';
      completedSel.value = 'YES';
      if (attachmentInput) attachmentInput.value = '';
      if (requestorCombo) requestorCombo.clear();
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
  activateView(localStorage.getItem(LAST_VIEW_KEY) || 'checkStocks');

  setupCombo('receiving-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; });
  setupCombo('issuance-item', function () { return itemOptions; }, function () { return itemListError; }, function (o) { return o.code; });
  setupCombo('issuance-requestor', function () { return requestorOptions; }, function () { return requestorListError; }, function (o) { return o.name; });

  loadItemList();
  loadSheetLinks();
  loadRequestorOptions();
  setupBulkForm('receiving', 'Receiving');
  setupBulkForm('issuance', 'Issuance');
});
