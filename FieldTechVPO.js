// ==============================
//  CONFIG / STATE
// ==============================
let records = [];                // full raw records for current filter
let fetchedRecords = 0;
let totalIncompleteRecords = 0;
let offset = '';
let isLoading = false;
let isFetching = false;
let currentSearchTerm = localStorage.getItem('jobSearchTerm') || '';
let currentCheckbox = null;
let currentRecordId = null;
let techniciansWithRecords = new Set();
let branchesWithRecords = new Set();
let totalRecords = 0;
let nextOffset = '';  // Airtable pagination cursor for "Load more"
let lastFilterFormula = ''; // remember current filter for the next page
let LOG_FETCH = true; // flip to false to silence logs in prod
let AUTO_LOAD_ALL_PAGES = true; // fetch all pages on initial load

function logFetch(...args) {
  if (LOG_FETCH) console.log(...args);
}

// Rendering control
const RENDER_BATCH_SIZE = 150;   // slightly smaller for smoother mobile paint
let renderCursor = 0;            // next row index to append
let renderTimer = null;          // chunk scheduling
let lastRenderedSearchKey = '';  // to detect when to full-reset render

// Caches
const MENU_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const RECORDS_CACHE_TTL = 10 * 60 * 1000;   // 10m
const recordsCache = new Map();             // key: `${tech}|${branch}` -> { ts, records, total }
let currentController = null;               // AbortController for cancelable fetches

// Airtable config
const airtableApiKey = 'pata9Iv7DANqtJrgO.b308b33cd0f323601f3fb580aac0d333ca1629dd26c5ebe2e2b9f18143ccaa8e';
const airtableBaseId = 'appQDdkj6ydqUaUkE';
const airtableTableName = 'tblO72Aw6qplOEAhR';
const airtableViewId = 'viwAYuyLBtyoHOxPK'; // optimized view
const airtableEndpoint = `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableName}`;

// Only fetch the fields we render
const fieldsToFetch = [
  'ID Number',
  'static Vanir Office',
  'Job Name',
  'Description of Work',
  'static Field Technician',
  'Field Tech Confirmed Job Complete'
];

// Axios defaults
axios.defaults.headers.common['Authorization'] = `Bearer ${airtableApiKey}`;

// ==============================
//  UTILITIES
// ==============================
async function fetchPageWithOffset(filterByFormula, offsetCursor = '') {
  const params = {
    filterByFormula,
    view: airtableViewId,
    pageSize: 100,
    fields: fieldsToFetch,
    offset: offsetCursor
  };

  const t0 = performance.now();
  const res = await axios.get(airtableEndpoint, { params, signal: makeSignal() });
  const dt = Math.round(performance.now() - t0);

  const rawRecords = res.data.records || [];
  const page = rawRecords
    .filter(r => !r.fields['Field Tech Confirmed Job Complete'])
    .map(r => ({ id: r.id, fields: r.fields, descriptionOfWork: r.fields['Description of Work'] || '' }));

  const next = res.data.offset || '';
  logFetch(`[VPO] Page fetched: +${page.length} jobs in ${dt}ms (offset in="${offsetCursor || '∅'}" -> out="${next || '∅'}")`);

  return { page, offset: next };
}


function showLoadingOverlay() {
  const el = document.getElementById('loadingOverlay');
  if (el) {
    el.style.display = 'flex';
    el.setAttribute('aria-hidden', 'false');
  }
}
function hideLoadingOverlay() {
  const el = document.getElementById('loadingOverlay');
  if (el) {
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');
  }
}
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = "toast show";
  setTimeout(() => { toast.className = "toast"; }, 2500);
}
function escapeFormulaValue(str = '') {
  return String(str).replace(/"/g, '\\"');
}
function nowTs() { return Date.now(); }
function cacheGet(key) {
  const item = recordsCache.get(key);
  if (!item) return null;
  if (nowTs() - item.ts > RECORDS_CACHE_TTL) return null;
  return item;
}
function cacheSet(key, payload) {
  recordsCache.set(key, { ts: nowTs(), ...payload });
}
function cancelRenderTimer() {
  if (!renderTimer) return;
  if (window.cancelIdleCallback) {
    window.cancelIdleCallback(renderTimer);
  } else {
    clearTimeout(renderTimer);
  }
  renderTimer = null;
}
function scheduleRenderChunk(reset = false) {
  if (reset) {
    cancelRenderTimer();
    renderCursor = 0;
  }
  const run = () => renderTableFromRecords(renderCursor === 0);
  if ('requestIdleCallback' in window) {
    renderTimer = window.requestIdleCallback(run, { timeout: 120 });
  } else {
    renderTimer = setTimeout(run, 0);
  }
}
function setCountBadge(count) {
  const countEl = document.getElementById('recordCount');
  if (countEl) {
    countEl.textContent = `${count} open job${count === 1 ? '' : 's'}`;
    countEl.style.display = '';
  }
}

// ==============================
//  DOMContentLoaded
// ==============================
document.addEventListener("DOMContentLoaded", async function () {
  const displayNameElement = document.getElementById('displayName');
  const techDropdown = document.getElementById('techDropdown');
  const branchDropdown = document.getElementById('branchDropdown');
  const searchBar = document.getElementById('searchBar');
  const clearSearch = document.getElementById('clearSearch');
  const resetFiltersBtn = document.getElementById('resetFilters');

  // Restore persisted search
  if (searchBar) {
    searchBar.value = currentSearchTerm;
    clearSearch.hidden = !searchBar.value;
  }

  // Debounced search
  let searchTimeout;
  if (searchBar) {
    searchBar.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentSearchTerm = (searchBar.value || '').toLowerCase();
        localStorage.setItem('jobSearchTerm', currentSearchTerm);
        document.getElementById('clearSearch').hidden = !currentSearchTerm;
        // Full reset render to apply search filter
        scheduleRenderChunk(true);
      }, 200);
    }, { passive: true });
  }
  if (clearSearch) {
    clearSearch.addEventListener('click', () => {
      if (!searchBar) return;
      searchBar.value = '';
      currentSearchTerm = '';
      localStorage.setItem('jobSearchTerm', '');
      clearSearch.hidden = true;
      scheduleRenderChunk(true);
      searchBar.focus();
    });
  }

  if (resetFiltersBtn) {
    resetFiltersBtn.addEventListener('click', async () => {
      localStorage.setItem('fieldTech','all');
      localStorage.setItem('branchFilter','all');
      if (techDropdown) techDropdown.value = 'all';
      if (branchDropdown) branchDropdown.value = 'all';
      await fetchRecordsFiltered('all','all');
      hideColumnsIfFiltered();
    });
  }

  // Populate Tech & Branch from a single crawl (cached)
  showLoadingOverlay();
  await populateMenus(techDropdown, branchDropdown);

  // Initialize selected filters from storage
  const storedTech = localStorage.getItem('fieldTech') || 'all';
  const storedBranch = localStorage.getItem('branchFilter') || 'all';
  if (techDropdown) techDropdown.value = storedTech;
  if (branchDropdown) branchDropdown.value = storedBranch;

  if (displayNameElement) {
    displayNameElement.innerText =
      storedTech !== "all" && storedTech ? `Logged in as: ${storedTech}` : '';
  }

  // Initial fetch & render
  await fetchRecordsFiltered(storedTech, storedBranch);

  // Dropdown listeners
  if (techDropdown) {
    techDropdown.addEventListener('change', async () => {
      const selectedTech = techDropdown.value || 'all';
      localStorage.setItem('fieldTech', selectedTech);

      if (displayNameElement) {
        displayNameElement.innerText =
          selectedTech !== "all" && selectedTech ? `Logged in as: ${selectedTech}` : '';
      }

      const selectedBranch = (branchDropdown && branchDropdown.value) || 'all';
      await fetchRecordsFiltered(selectedTech, selectedBranch);
    });
  }

  if (branchDropdown) {
    branchDropdown.addEventListener('change', async () => {
      const selectedBranch = branchDropdown.value || 'all';
      localStorage.setItem('branchFilter', selectedBranch);

      const selectedTech = (techDropdown && techDropdown.value) || 'all';
      await fetchRecordsFiltered(selectedTech, selectedBranch);
    });
  }

  // Modal UX wiring
  wireModalUX();

  hideColumnsIfFiltered();
  hideLoadingOverlay();
});

// ==============================
//  Menu Population (Unified)
// ==============================
async function populateMenus(techDropdown, branchDropdown) {
  const cacheTime = MENU_CACHE_TTL;
  const lastFetch = Number(localStorage.getItem('lastMenuFetchTime') || 0);
  const cachedTechs = JSON.parse(localStorage.getItem('technicians') || '[]');
  const cachedBranches = JSON.parse(localStorage.getItem('branches') || '[]');

  if (cachedTechs.length && cachedBranches.length && (nowTs() - lastFetch) < cacheTime) {
    populateTechDropdownFromCache(techDropdown, cachedTechs);
    populateBranchDropdownFromCache(branchDropdown, cachedBranches);
    return;
  }

  // Fresh crawl to build both sets in a single paginated pass
  techniciansWithRecords = new Set();
  branchesWithRecords = new Set();
  let _offset = '';
  try {
    do {
      const params = {
        view: airtableViewId,
        pageSize: 100,
        fields: ['static Field Technician', 'static Vanir Office', 'Field Tech Confirmed Job Complete'],
        offset: _offset
      };
      const res = await axios.get(airtableEndpoint, { params, signal: makeSignal() });
      const pageRecords = res.data.records || [];
      pageRecords.forEach(rec => {
        const f = rec.fields || {};
        if (!f['Field Tech Confirmed Job Complete']) {
          if (f['static Field Technician']) techniciansWithRecords.add(f['static Field Technician']);
          if (f['static Vanir Office']) branchesWithRecords.add(f['static Vanir Office']);
        }
      });
      _offset = res.data.offset || '';
    } while (_offset);

    const techs = Array.from(techniciansWithRecords).filter(Boolean).sort();
    const branches = Array.from(branchesWithRecords).filter(Boolean).sort();

    localStorage.setItem('technicians', JSON.stringify(techs));
    localStorage.setItem('branches', JSON.stringify(branches));
    localStorage.setItem('lastMenuFetchTime', String(nowTs()));

    populateTechDropdownFromCache(techDropdown, techs);
    populateBranchDropdownFromCache(branchDropdown, branches);
  } catch (err) {
    console.error('❌ Error populating menus:', err);
    // Fallback to any cache we might have
    populateTechDropdownFromCache(techDropdown, cachedTechs);
    populateBranchDropdownFromCache(branchDropdown, cachedBranches);
  }
}

function populateTechDropdownFromCache(techDropdown, technicians) {
  if (!techDropdown) return;
  const uniqueTechs = Array.from(new Set((technicians || []).filter(Boolean)));
  const previouslySelected = localStorage.getItem('fieldTech') || 'all';
  techDropdown.innerHTML = `
    <option value="">Select a Technician</option>
    <option value="all">Display All</option>
  `;
  uniqueTechs.forEach(tech => {
    const option = document.createElement('option');
    option.value = tech;
    option.innerText = tech;
    techDropdown.appendChild(option);
  });
  techDropdown.value = previouslySelected;
}

function populateBranchDropdownFromCache(branchDropdown, branches) {
  if (!branchDropdown) return;
  const uniqueBranches = Array.from(new Set((branches || []).filter(Boolean)));
  const previouslySelected = localStorage.getItem('branchFilter') || 'all';
  branchDropdown.innerHTML = `
    <option value="">Select a Branch</option>
    <option value="all">All Branches</option>
  `;
  uniqueBranches.forEach(branch => {
    const option = document.createElement('option');
    option.value = branch;
    option.innerText = branch;
    branchDropdown.appendChild(option);
  });
  branchDropdown.value = previouslySelected;
}

// ==============================
//  Fetch Records (Cancelable + Cached)
// ==============================
function makeSignal() {
  // Cancel previous in-flight requests
  if (currentController) currentController.abort();
  currentController = new AbortController();
  return currentController.signal;
}

async function fetchRecordsFiltered(fieldTech = 'all', branch = 'all') {
  showLoadingOverlay();
  isFetching = true;

  // Reset state
  records = [];
  fetchedRecords = 0;
  totalIncompleteRecords = 0;
  nextOffset = '';
  scheduleRenderChunk(true); // clear & rebuild

  // Cache lookup
  const cacheKey = `${fieldTech}|${branch}`;
  const cached = cacheGet(cacheKey);
  if (cached && !AUTO_LOAD_ALL_PAGES) {
    records = cached.records.slice();
    totalIncompleteRecords = records.length;
    fetchedRecords = records.length;
    logFetch?.(`[VPO] Cache hit for "${cacheKey}": ${records.length} jobs`);
    isFetching = false;
    hideLoadingOverlay();
    hideColumnsIfFiltered();
    setCountBadge(records.length);
    scheduleRenderChunk(true);
    return;
  }

  try {
    // Build filterByFormula for this view
    const parts = ['NOT({Field Tech Confirmed Job Complete})'];
    if (fieldTech && fieldTech !== 'all') {
      parts.push(`SEARCH("${escapeFormulaValue(fieldTech)}", {static Field Technician})`);
    }
    if (branch && branch !== 'all') {
      parts.push(`{static Vanir Office} = "${escapeFormulaValue(branch)}"`);
    }
    lastFilterFormula = parts.length > 1 ? `AND(${parts.join(',')})` : parts[0];
    logFetch?.(`[VPO] Initial fetch with filter: ${lastFilterFormula}`);

    // --- fetch first page ---
    const { page, offset } = await fetchPageWithOffset(lastFilterFormula, '');
    records = page;
    fetchedRecords = page.length;
    totalIncompleteRecords = records.length;
    nextOffset = offset;

    logFetch?.(`[VPO] Initial load total: ${records.length} jobs${nextOffset ? ' (more available)' : ' (no more pages)'}`);
    scheduleRenderChunk(true);
    setCountBadge(records.length);

    // --- auto-load remaining pages, if enabled ---
    if (AUTO_LOAD_ALL_PAGES) {
      let loops = 0;
      while (nextOffset) {
        const { page: more, offset: nxt } = await fetchPageWithOffset(lastFilterFormula, nextOffset);
        records = records.concat(more);
        fetchedRecords += more.length;
        totalIncompleteRecords = records.length;
        nextOffset = nxt;

        // Render newly added rows without clearing
        scheduleRenderChunk(false);
        setCountBadge(records.length);

        logFetch?.(`[VPO] Auto-loaded page ${++loops}: +${more.length} (total ${records.length})${nextOffset ? ' (more available)' : ' (done)'}`);

        // keep cache warm as we go so a reload picks up the larger set
        cacheSet(cacheKey, { records: records.slice(), total: records.length });
      }
    } else {
      // caching just the first page if not auto-loading
      cacheSet(cacheKey, { records: records.slice(), total: records.length });
    }

    logFetch?.(`[VPO] Final total after initial load: ${records.length}`);

  } catch (error) {
    if (axios.isCancel?.(error) || error.name === 'CanceledError' || error.message === 'canceled') {
      // filter changed mid-flight; ignore
    } else {
      console.error('❌ Error fetching records:', error);
      showToast('Error fetching records.');
    }
  } finally {
    isFetching = false;
    hideLoadingOverlay();
    hideColumnsIfFiltered();
    setCountBadge(records.length);
  }
}


async function fetchNextPage() {
  if (!nextOffset || isFetching) return;

  try {
    isFetching = true;
    showLoadingOverlay();

    const { page, offset } = await fetchPageWithOffset(lastFilterFormula, nextOffset);

    // Append new rows and render more
    records = records.concat(page);
    fetchedRecords += page.length;
    totalIncompleteRecords = records.length;
    nextOffset = offset; // empty string means no more pages

    // Totals log
    logFetch(`[VPO] Loaded more: +${page.length} (total ${records.length})${nextOffset ? ' (more available)' : ' (no more pages)'}`);

    // Continue rendering (no full reset)
    scheduleRenderChunk(false);
    setCountBadge(records.length);
  } catch (error) {
    if (axios.isCancel?.(error) || error.name === 'CanceledError' || error.message === 'canceled') {
      // ignored
    } else {
      console.error('❌ Error fetching next page:', error);
      showToast('Error loading more records.');
    }
  } finally {
    isFetching = false;
    hideLoadingOverlay();
    hideColumnsIfFiltered();
  }
}



// ==============================
//  Rendering (Chunked + Filtered)
// ==============================
function toggleSearchBarVisibility(recordCount) {
  const searchBar = document.getElementById('searchBar');
  if (!searchBar) return;
  searchBar.style.display = recordCount < 6 ? 'none' : 'block';
}

function sortRecordsWithSpecialCondition(recs) {
  return recs.sort((a, b) => {
    const branchA = a.fields['static Vanir Office'] || '';
    const branchB = b.fields['static Vanir Office'] || '';
    const branchCompare = branchA.localeCompare(branchB);
    if (branchCompare !== 0) return branchCompare;

    const idA = a.fields['ID Number'] || '';
    const idB = b.fields['ID Number'] || '';
    const numA = parseInt(idA, 10);
    const numB = parseInt(idB, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(idA).localeCompare(String(idB));
  });
}

function buildTableHeader() {
  const recordsContainer = document.getElementById('records');
  if (!recordsContainer) return null;

  const colgroup = document.createElement('colgroup');
  colgroup.innerHTML = `
    <col class="w-id">
    <col class="w-branch">
    <col class="w-job">
    <col class="w-desc">
    <col class="w-tech">
    <col class="w-completed">
  `;

  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
          <th scope="col" class="col-job">Job Name</th>
      <th scope="col" class="col-desc">Description of Work</th>

      <th scope="col" class="col-id">ID Number</th>
      <th scope="col" class="col-branch">Branch</th>
      <th scope="col" class="col-tech">Field Technician</th>
      <th scope="col" class="col-completed">Completed</th>
    </tr>
  `;

  const tbody = document.createElement('tbody');

  recordsContainer.innerHTML = '';
  recordsContainer.appendChild(colgroup);
  recordsContainer.appendChild(thead);
  recordsContainer.appendChild(tbody);
  return tbody;
}

function renderTableFromRecords(fullReset = false) {
  const recordsContainer = document.getElementById('records');
  if (!recordsContainer) return;

  // Build filtered set based on current search
  const searchKey = (currentSearchTerm || '').toLowerCase();
  let working = records;
  if (searchKey) {
    const k = searchKey;
    working = records.filter(r =>
      Object.values(r.fields).some(v => String(v ?? '').toLowerCase().includes(k)) ||
      (r.descriptionOfWork || '').toLowerCase().includes(k)
    );
  }

  // Empty state / warnings
  const warningId = 'search-warning';
  let warning = document.getElementById(warningId);
  if (!working.length) {
    if (!warning) {
      warning = document.createElement('div');
      warning.id = warningId;
      warning.style.color = '#b45309';
      warning.style.margin = '1em 0';
      const searchBar = document.getElementById('searchBar');

      // FIX: place warning *after* the search bar safely
      if (searchBar && searchBar.parentNode) {
        // Insert after searchBar (reference must be child of parent)
        searchBar.parentNode.insertBefore(warning, searchBar.nextSibling);
        // Alternatively: searchBar.insertAdjacentElement('afterend', warning);
      } else if (recordsContainer.parentNode) {
        // Fallback: put above the table
        recordsContainer.parentNode.insertBefore(warning, recordsContainer);
      } else {
        // Last resort: append to body
        document.body.appendChild(warning);
      }
    }
    warning.textContent = isFetching
      ? 'No matching records found so far. Still loading more—try again shortly.'
      : 'No matching records.';
    recordsContainer.innerHTML = '';
    toggleSearchBarVisibility(0);
    setCountBadge(0);
    hideColumnsIfFiltered(); // keep state consistent even without a header
    return;
  } else if (warning) {
    warning.style.display = 'none';
  }

  // Build header + sort once per search/reset
  if (fullReset || renderTableFromRecords._lastSearchKey !== searchKey) {
    const tbody = buildTableHeader();
    if (!tbody) return;
    renderCursor = 0;
    renderTableFromRecords._sorted = sortRecordsWithSpecialCondition(working.slice());
    renderTableFromRecords._lastSearchKey = searchKey;
  }

  const tbody = recordsContainer.querySelector('tbody');
  if (!tbody) return;

  // Chunked append for smooth rendering on mobile
  const sorted = renderTableFromRecords._sorted || sortRecordsWithSpecialCondition(working.slice());
  const fragment = document.createDocumentFragment();
  const end = Math.min(renderCursor + RENDER_BATCH_SIZE, sorted.length);

  for (let i = renderCursor; i < end; i++) {
    fragment.appendChild(createRecordRow(sorted[i]));
  }

  tbody.appendChild(fragment);
  renderCursor = end;

  // UI meta
  toggleSearchBarVisibility(sorted.length);
  setCountBadge(sorted.length);

  // More to render? schedule another chunk
  if (renderCursor < sorted.length) {
    scheduleRenderChunk(false);
  }

  // Ensure column visibility stays correct for newly appended rows
  hideColumnsIfFiltered();
}

// ==============================
//  Row + Checkbox / Modal
// ==============================
function createRecordRow(record) {
  const tr = document.createElement('tr');

  const f = record.fields || {};
  const idNumber   = f['ID Number'] || '';
  const branch     = f['static Vanir Office'] || '';
  const jobName    = f['Job Name'] || '';
  const desc       = f['Description of Work'] || '';
  const tech       = f['static Field Technician'] || '';
  const isComplete = !!f['Field Tech Confirmed Job Complete'];

  tr.innerHTML = `
      <td class="col-job">${jobName}</td>
    <td class="col-desc">${desc}</td>
    <td class="col-id">${idNumber}</td>
    <td class="col-branch">${branch}</td>
    <td class="col-tech">${tech}</td>
    <td class="col-completed completed-cell">
      <label class="custom-checkbox">
        <input
          type="checkbox"
          ${isComplete ? 'checked' : ''}
          data-record-id="${record.id}"
          data-initial-checked="${isComplete}"
        >
        <span class="checkmark" aria-hidden="true"></span>
      </label>
    </td>
  `;

  const completedCell = tr.querySelector('.completed-cell');
  const checkbox = completedCell.querySelector('input[type="checkbox"]');

  // Primary handler: opens modal on check, updates immediately on uncheck
  checkbox.addEventListener('click', handleCheckboxClick);

  // Guard against double-toggle: only synthesize a click if user tapped empty cell area
  completedCell.addEventListener('click', (e) => {
    if (e.target.closest('input') || e.target.closest('label')) return;
    checkbox.click();
  }, { passive: true });

  return tr;
}

// Hide Branch / Tech columns if filtered (and keep a subtle chip could be added separately)
function hideColumnsIfFiltered() {
  const tech  = (document.getElementById('techDropdown')?.value) || 'all';
  const branch= (document.getElementById('branchDropdown')?.value) || 'all';
  const table = document.getElementById('records');
  if (!table) return;

  const hideBranch = tech !== 'all';                  // hide Branch when Tech is selected
  const hideTech   = tech !== 'all' || branch !== 'all'; // your latest ask

  table.classList.toggle('hide-branch', hideBranch);
  table.classList.toggle('hide-tech', hideTech);
}


// Modal + checkbox flow
const modal = document.getElementById('modal');
const modalOverlay = document.getElementById('modalOverlay');
const yesButton = document.getElementById('yesButton');
const noButton = document.getElementById('noButton');
let previouslyFocused = null;

function handleCheckboxClick(event) {
  currentCheckbox = event.target;
  currentRecordId = currentCheckbox.getAttribute('data-record-id');
  const isChecked = currentCheckbox.checked;

  if (!isChecked) {
    submitUpdate(currentRecordId, false);
    closeModal();
  } else {
    openModal();
  }
  currentCheckbox.setAttribute('data-initial-checked', isChecked);
}

function wireModalUX(){
  if (!modal || !modalOverlay) return;

  // Esc closes
  document.addEventListener('keydown', (e) => {
    if (modal.style.display === 'block' && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (currentCheckbox) currentCheckbox.checked = false;
      closeModal();
    }
    // trap Tab
    if (modal.style.display === 'block' && e.key === 'Tab') {
      const focusables = [yesButton, noButton].filter(Boolean);
      if (!focusables.length) return;
      const i = focusables.indexOf(document.activeElement);
      if (e.shiftKey) {
        e.preventDefault();
        focusables[(i <= 0 ? focusables.length : i) - 1].focus();
      } else {
        e.preventDefault();
        focusables[(i + 1) % focusables.length].focus();
      }
    }
  });

  // Click outside closes
  modalOverlay.addEventListener('click', () => {
    if (currentCheckbox) currentCheckbox.checked = false;
    closeModal();
  });

  // Buttons
  if (yesButton) {
    yesButton.addEventListener('click', () => {
      submitUpdate(currentRecordId, true);

      const recordRow = document.querySelector(`input[data-record-id="${currentRecordId}"]`)?.closest("tr");
      const jobName = recordRow ? recordRow.querySelector(".col-job")?.textContent : `Record ${currentRecordId}`;
      showToast(`✅ Completed: ${jobName}`);

      closeModal();
    });
  }
  if (noButton) {
    noButton.addEventListener('click', () => {
      if (currentCheckbox) currentCheckbox.checked = false;
      closeModal();
    });
  }
}

function openModal(){
  previouslyFocused = document.activeElement;
  modal.style.display = 'block';
  modalOverlay.style.display = 'block';
  modalOverlay.setAttribute('aria-hidden', 'false');
  yesButton?.focus();
}
function closeModal(){
  modal.style.display = 'none';
  modalOverlay.style.display = 'none';
  modalOverlay.setAttribute('aria-hidden', 'true');
  previouslyFocused?.focus();
}

// Patch + remove row locally for instant feedback
async function submitUpdate(recordId, isChecked) {
  try {
    await axios.patch(
      `${airtableEndpoint}/${recordId}`,
      { fields: { "Field Tech Confirmed Job Complete": isChecked } },
      { headers: { Authorization: `Bearer ${airtableApiKey}`, "Content-Type": "application/json" } }
    );

    updateCheckboxUI(recordId, isChecked);

    if (isChecked) {
      // Remove from in-memory list and re-render search view quickly
      const idx = records.findIndex(r => r.id === recordId);
      if (idx >= 0) {
        records.splice(idx, 1);
        // Also drop from cache for current filter so next re-open fetches fresh minimal set
        const tech = localStorage.getItem('fieldTech') || 'all';
        const branch = localStorage.getItem('branchFilter') || 'all';
        const cacheKey = `${tech}|${branch}`;
        recordsCache.delete(cacheKey);

        // Smoothly remove the row if still present
        const row = document.querySelector(`input[data-record-id="${recordId}"]`)?.closest("tr");
        if (row) {
          row.style.transition = "opacity 0.25s";
          row.style.opacity = "0";
          setTimeout(() => row.remove(), 250);
        }
        // Update counts + rerender chunks if search active
        scheduleRenderChunk(true);
      }
    }
  } catch (error) {
    console.error('❌ Error updating record:', error);
    const checkbox = document.querySelector(`input[data-record-id="${recordId}"]`);
    if (checkbox) checkbox.checked = !isChecked;
    showToast('Update failed. Please try again.');
  }
}

function updateCheckboxUI(recordId, isChecked) {
  const checkbox = document.querySelector(`input[data-record-id="${recordId}"]`);
  if (!checkbox) return;
  checkbox.checked = isChecked;
  const row = checkbox.closest('tr');
  const statusCell = row?.querySelector('.status-cell');
  if (statusCell) statusCell.textContent = isChecked ? 'Complete' : 'Incomplete';
}
