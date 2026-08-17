/* =========================================================
   StudyHub — app.js
   Persistence: localStorage for tasks/todo/timetable/timer,
   IndexedDB for uploaded files (better suited to larger binaries).
   ========================================================= */

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    showToast('Storage is full — try removing a large file.');
  }
}
async function hashPassword(password, salt) {
  const raw = salt + ':' + password;
  if (window.crypto && window.crypto.subtle) {
    try {
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(raw));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* fall through to non-crypto fallback below */ }
  }
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (h << 5) - h + raw.charCodeAt(i);
    h |= 0;
  }
  return 'fb' + Math.abs(h).toString(16);
}

/* ---------- theme (dark/light) ---------- */
function applyTheme(dark) {
  document.body.classList.toggle('dark-mode', dark);
  $$('.theme-toggle-input').forEach(inp => { inp.checked = dark; });
}
function initTheme() {
  const dark = localStorage.getItem('studyhub_theme') === 'dark';
  applyTheme(dark);
  $$('.theme-toggle-input').forEach(inp => {
    inp.addEventListener('change', () => {
      applyTheme(inp.checked);
      localStorage.setItem('studyhub_theme', inp.checked ? 'dark' : 'light');
    });
  });
}

const Auth = (() => {
  const ACCOUNT_KEY = 'studyhub_account';
  const SESSION_KEY = 'studyhub_session';

  function getAccount() { return loadJSON(ACCOUNT_KEY, null); }

  async function createAccount(username, password) {
    const salt = uid();
    const hash = await hashPassword(password, salt);
    saveJSON(ACCOUNT_KEY, { username, salt, hash });
  }

  async function verify(username, password) {
    const acc = getAccount();
    if (!acc || acc.username.toLowerCase() !== username.toLowerCase()) return false;
    return (await hashPassword(password, acc.salt)) === acc.hash;
  }

  function setSession(username, remember) {
    const store = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    store.setItem(SESSION_KEY, username);
    other.removeItem(SESSION_KEY);
  }

  function getSession() {
    return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }

  return { getAccount, createAccount, verify, setSession, getSession, clearSession };
})();

let signupMode = false;

function updateLoginModeUI() {
  $('#loginHeading').textContent = signupMode ? 'Create your account' : 'Welcome back';
  $('#loginSub').textContent = signupMode ? 'Set a username and password for this browser.' : 'Log in to your desk.';
  $('#confirmWrap').style.display = signupMode ? 'flex' : 'none';
  $('#loginConfirm').required = signupMode;
  $('#loginSubmit').textContent = signupMode ? 'Create account' : 'Log in';
  $('#toggleText').textContent = signupMode ? 'Already set up?' : 'New here?';
  $('#loginToggleBtn').textContent = signupMode ? 'Log in instead' : 'Create an account';
  $('#loginError').textContent = '';
}

function enterApp(username) {
  document.body.classList.add('authed');
  $('#spineUser').textContent = username;
  initApp();
}

function initApp() {
  initTabs();
  initFiles();
  initTasks();
  renderTimetable();
  initTimer();
  initTodo();
  renderDashboard();
}

function initAuthScreen() {
  const account = Auth.getAccount();
  signupMode = !account;
  updateLoginModeUI();

  $('#loginToggleBtn').addEventListener('click', () => {
    signupMode = !signupMode;
    $('#loginForm').reset();
    $('#loginRemember').checked = true;
    updateLoginModeUI();
  });

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const errorEl = $('#loginError');
    errorEl.textContent = '';
    const username = $('#loginUsername').value.trim();
    const password = $('#loginPassword').value;
    const remember = $('#loginRemember').checked;

    if (!username) { errorEl.textContent = 'Enter a username.'; return; }

    if (signupMode) {
      if (Auth.getAccount()) {
        errorEl.textContent = 'An account already exists on this device — log in instead.';
        return;
      }
      if (password.length < 4) { errorEl.textContent = 'Password should be at least 4 characters.'; return; }
      if (password !== $('#loginConfirm').value) { errorEl.textContent = "Passwords don't match."; return; }

      await Auth.createAccount(username, password);
      Auth.setSession(username, remember);
      showToast('Account created — welcome to StudyHub.');
      enterApp(username);
    } else {
      const ok = await Auth.verify(username, password);
      if (!ok) { errorEl.textContent = 'Incorrect username or password.'; return; }
      Auth.setSession(username, remember);
      enterApp(username);
    }
  });

  $('#logoutBtn').addEventListener('click', () => {
    Auth.clearSession();
    document.body.classList.remove('authed');
    $('#loginForm').reset();
    signupMode = !Auth.getAccount();
    updateLoginModeUI();
    showToast('Logged out.');
  });
}

/* ---------- tab navigation ---------- */
function initTabs() {
  const tabs = $$('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.sheet').forEach(s => s.classList.remove('active'));
      $('#' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'dashboard') renderDashboard();
    });
  });
  tabs[0].classList.add('active');
}
const FileStore = (() => {
  let db = null;
  const DB_NAME = 'studyhub_files';
  const STORE = 'files';

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(STORE)) {
          idb.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function add(record) {
    const idb = await open();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function remove(id) {
    const idb = await open();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function all() {
    const idb = await open();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.addedAt - a.addedAt));
      req.onerror = () => reject(req.error);
    });
  }

  return { add, remove, all };
})();

function fileKind(type, name) {
  if (type.includes('pdf') || name.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (/\.(docx?|txt|rtf|odt)$/i.test(name) || type.includes('word') || type.includes('document')) return 'doc';
  return 'other';
}
function kindLabel(kind) {
  return { pdf: 'PDF', image: 'IMG', doc: 'DOC', other: 'FILE' }[kind];
}
function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function handleFiles(fileList) {
  for (const file of Array.from(fileList)) {
    if (file.size > 20 * 1024 * 1024) {
      showToast(`${file.name} is over 20MB — skipped.`);
      continue;
    }
    const dataUrl = await new Promise(res => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.readAsDataURL(file);
    });
    await FileStore.add({
      id: uid(),
      name: file.name,
      type: file.type,
      size: file.size,
      addedAt: Date.now(),
      data: dataUrl
    });
  }
  showToast('Files added to your archive.');
  renderFiles();
}

async function renderFiles() {
  const grid = $('#fileGrid');
  const empty = $('#fileEmpty');
  const search = $('#fileSearch').value.trim().toLowerCase();
  const typeFilter = $('#fileTypeFilter').value;

  let files = await FileStore.all();
  if (search) files = files.filter(f => f.name.toLowerCase().includes(search));
  if (typeFilter !== 'all') files = files.filter(f => fileKind(f.type, f.name) === typeFilter);

  grid.innerHTML = '';
  empty.classList.toggle('show', files.length === 0);

  files.forEach(f => {
    const kind = fileKind(f.type, f.name);
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.open = f.id;
    card.innerHTML = `
      <div class="file-icon ${kind}">${kindLabel(kind)}</div>
      <div class="file-name">${escapeHtml(f.name)}</div>
      <div class="file-meta">${fmtBytes(f.size)} · ${new Date(f.addedAt).toLocaleDateString()}</div>
      <div class="file-actions">
        <a class="btn small ghost" href="${f.data}" download="${escapeAttr(f.name)}">Download</a>
        <button class="btn small danger" data-remove="${f.id}">Remove</button>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.file-actions')) return; // let Download/Remove behave normally
      openFilePreview(f);
    });
    grid.appendChild(card);
  });

  $$('[data-remove]', grid).forEach(btn => {
    btn.addEventListener('click', async () => {
      await FileStore.remove(btn.dataset.remove);
      renderFiles();
      renderDashboard();
    });
  });

  updateStat('#statFiles', (await FileStore.all()).length);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

async function openFilePreview(f) {
  const modal = $('#fileModal');
  const body = $('#fileModalBody');
  const kind = fileKind(f.type, f.name);

  $('#fileModalName').textContent = f.name;
  $('#fileModalDownload').href = f.data;
  $('#fileModalDownload').setAttribute('download', f.name);
  body.innerHTML = '';

  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = f.data;
    img.alt = f.name;
    body.appendChild(img);
  } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
    const frame = document.createElement('iframe');
    frame.src = f.data;
    body.appendChild(frame);
  } else if (f.type.startsWith('text/') || /\.(txt|md|csv|json|log)$/i.test(f.name)) {
    try {
      const text = await (await fetch(f.data)).text();
      const pre = document.createElement('pre');
      pre.textContent = text;
      body.appendChild(pre);
    } catch {
      body.innerHTML = `<p class="file-modal-noprev">Couldn't load a preview for this file. Use Download to view it.</p>`;
    }
  } else {
    body.innerHTML = `<p class="file-modal-noprev">No in-app preview for this file type yet.<br>Use Download to open it.</p>`;
  }

  modal.classList.add('show');
}

function closeFilePreview() {
  const modal = $('#fileModal');
  modal.classList.remove('show');
  $('#fileModalBody').innerHTML = ''; // stop any pdf/media from playing in the background
}

function initFileModal() {
  const modal = $('#fileModal');
  $('#fileModalClose').addEventListener('click', closeFilePreview);
  $('#fileModalCloseBtn').addEventListener('click', closeFilePreview);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeFilePreview(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('show')) closeFilePreview();
  });
}

function initFiles() {
  const dz = $('#dropzone');
  const input = $('#fileInput');
  $('#browseBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });

  ['dragenter', 'dragover'].forEach(evt =>
    dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt =>
    dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

  $('#fileSearch').addEventListener('input', renderFiles);
  $('#fileTypeFilter').addEventListener('change', renderFiles);

  initFileModal();
  renderFiles();
}

/* =========================================================
   TASKS
   ========================================================= */
let tasks = loadJSON('studyhub_tasks', []);
let taskFilter = 'all';

function saveTasks() { saveJSON('studyhub_tasks', tasks); }

function renderTasks() {
  const list = $('#taskList');
  const empty = $('#taskEmpty');
  let visible = tasks.slice().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  if (taskFilter === 'open') visible = visible.filter(t => !t.done);
  if (taskFilter === 'done') visible = visible.filter(t => t.done);

  list.innerHTML = '';
  empty.classList.toggle('show', visible.length === 0);

  visible.forEach(t => {
    const li = document.createElement('li');
    li.className = `task-item priority-${t.priority}${t.done ? ' done' : ''}`;
    const dueStr = t.due ? new Date(t.due + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'no due date';
    li.innerHTML = `
      <input type="checkbox" class="task-check" ${t.done ? 'checked' : ''} data-toggle="${t.id}">
      <div class="task-body">
        <div class="task-title">${escapeHtml(t.title)}</div>
        <div class="task-sub">${t.subject ? escapeHtml(t.subject) + ' · ' : ''}${dueStr} · ${t.priority}</div>
      </div>
      <div class="task-actions">
        <button class="btn small danger" data-del="${t.id}">Delete</button>
      </div>
    `;
    list.appendChild(li);
  });

  $$('[data-toggle]', list).forEach(cb => cb.addEventListener('change', () => {
    const t = tasks.find(x => x.id === cb.dataset.toggle);
    t.done = cb.checked;
    saveTasks(); renderTasks(); renderDashboard();
  }));
  $$('[data-del]', list).forEach(btn => btn.addEventListener('click', () => {
    tasks = tasks.filter(x => x.id !== btn.dataset.del);
    saveTasks(); renderTasks(); renderDashboard();
  }));

  updateStat('#statTasks', tasks.filter(t => !t.done).length);
}

function initTasks() {
  $('#taskForm').addEventListener('submit', e => {
    e.preventDefault();
    tasks.push({
      id: uid(),
      title: $('#taskTitle').value.trim(),
      subject: $('#taskSubject').value.trim(),
      due: $('#taskDue').value,
      priority: $('#taskPriority').value,
      done: false
    });
    saveTasks();
    e.target.reset();
    $('#taskPriority').value = 'medium';
    renderTasks(); renderDashboard();
    showToast('Task added.');
  });

  $$('#taskFilterSeg .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('#taskFilterSeg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    taskFilter = btn.dataset.filter;
    renderTasks();
  }));

  renderTasks();
}

/* =========================================================
   TIMETABLE
   ========================================================= */
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SLOTS = ['8–9', '9–10', '10–11', '11–12', '12–1', '1–2', '2–3', '3–4', '4–5', 'Evening'];

let timetable = loadJSON('studyhub_timetable', {});

function saveTimetable() { saveJSON('studyhub_timetable', timetable); }

function renderTimetable() {
  const table = $('#timetableGrid');
  let html = '<tr><th>Time</th>' + DAYS.map(d => `<th>${d}</th>`).join('') + '</tr>';
  SLOTS.forEach((slot, r) => {
    html += `<tr><td>${slot}</td>`;
    DAYS.forEach((day, c) => {
      const key = `${r}_${c}`;
      const val = timetable[key] || '';
      html += `<td><input class="cell-input" data-key="${key}" value="${escapeAttr(val)}" placeholder="—"></td>`;
    });
    html += '</tr>';
  });
  table.innerHTML = html;

  $$('.cell-input', table).forEach(inp => {
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v) timetable[inp.dataset.key] = v;
      else delete timetable[inp.dataset.key];
      saveTimetable();
      renderDashboard();
    });
  });
}

function todaysScheduleEntries() {
  const jsDay = new Date().getDay(); // 0=Sun
  const col = jsDay === 0 ? 6 : jsDay - 1;
  const entries = [];
  SLOTS.forEach((slot, r) => {
    const val = timetable[`${r}_${col}`];
    if (val) entries.push({ slot, val });
  });
  return entries;
}

/* =========================================================
   FOCUS TIMER
   ========================================================= */
let timerState = {
  mode: 'focus',
  remaining: 25 * 60,
  running: false,
  intervalId: null
};
let sessionsToday = loadJSON('studyhub_sessions', { date: '', count: 0 });

function todayStr() { return new Date().toISOString().slice(0, 10); }
function ensureSessionsFresh() {
  if (sessionsToday.date !== todayStr()) sessionsToday = { date: todayStr(), count: 0 };
}

function lengthsFromInputs() {
  return {
    focus: Math.max(1, parseInt($('#lenFocus').value, 10) || 25) * 60,
    short: Math.max(1, parseInt($('#lenShort').value, 10) || 5) * 60,
    long: Math.max(1, parseInt($('#lenLong').value, 10) || 15) * 60
  };
}

function setMode(mode, resetTime = true) {
  timerState.mode = mode;
  $$('#modeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const labelMap = { focus: 'Focus', short: 'Short break', long: 'Long break' };
  $('#timerMode').textContent = labelMap[mode];
  if (resetTime) {
    const lens = lengthsFromInputs();
    timerState.remaining = lens[mode];
    updateRing(1);
    renderTimerDisplay();
  }
}

function renderTimerDisplay() {
  const m = Math.floor(timerState.remaining / 60).toString().padStart(2, '0');
  const s = Math.floor(timerState.remaining % 60).toString().padStart(2, '0');
  $('#timerDisplay').textContent = `${m}:${s}`;
}

function updateRing(fraction) {
  const hand = $('#timerHand');
  const angle = (1 - Math.max(0, Math.min(1, fraction))) * 360;
  hand.style.transform = `rotate(${angle}deg)`;

  const colorMap = {
    focus: { main: '#5FC7D4', deep: '#3C9BA6' },
    short: { main: 'var(--amber)', deep: 'var(--amber-deep)' },
    long:  { main: 'var(--coral)', deep: 'var(--coral-deep)' }
  };
  const c = colorMap[timerState.mode] || colorMap.focus;
  $('.watch-hand-main').style.fill = c.main;
  $('.watch-hand-shadow').style.fill = c.deep;
  $('#watchSubdialMark').style.fill = c.deep;
}

function tick() {
  timerState.remaining -= 1;
  const lens = lengthsFromInputs();
  const total = lens[timerState.mode];
  updateRing(Math.max(0, timerState.remaining / total));
  renderTimerDisplay();

  if (timerState.remaining <= 0) {
    stopTimer();
    if (timerState.mode === 'focus') {
      ensureSessionsFresh();
      sessionsToday.count += 1;
      saveJSON('studyhub_sessions', sessionsToday);
      updateStat('#statSessions', sessionsToday.count);
      $('#sessionCount').textContent = sessionsToday.count;
      showToast('Focus session complete — take a break!');
      setMode(sessionsToday.count % 4 === 0 ? 'long' : 'short');
    } else {
      showToast('Break over — ready to focus?');
      setMode('focus');
    }
    playChime();
  }
}

function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.start(); osc.stop(ctx.currentTime + 0.8);
  } catch (e) { /* audio not available, ignore */ }
}

function startTimer() {
  if (timerState.running) return;
  timerState.running = true;
  $('#timerToggle').textContent = 'Pause';
  timerState.intervalId = setInterval(tick, 1000);
}
function pauseTimer() {
  timerState.running = false;
  $('#timerToggle').textContent = 'Start';
  clearInterval(timerState.intervalId);
}
function stopTimer() { pauseTimer(); }

function initTimer() {
  ensureSessionsFresh();
  $('#sessionCount').textContent = sessionsToday.count;

  $$('#modeSeg .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    pauseTimer();
    setMode(btn.dataset.mode);
  }));

  $('#timerToggle').addEventListener('click', () => {
    timerState.running ? pauseTimer() : startTimer();
  });

  $('#timerReset').addEventListener('click', () => {
    pauseTimer();
    setMode(timerState.mode);
  });

  ['#lenFocus', '#lenShort', '#lenLong'].forEach(sel => {
    $(sel).addEventListener('change', () => {
      if (!timerState.running) setMode(timerState.mode);
    });
  });

  setMode('focus');
}

/* =========================================================
   TODO
   ========================================================= */
let todos = loadJSON('studyhub_todos', []);
function saveTodos() { saveJSON('studyhub_todos', todos); }

function renderTodos() {
  const list = $('#todoList');
  const empty = $('#todoEmpty');
  list.innerHTML = '';
  empty.classList.toggle('show', todos.length === 0);

  todos.forEach(t => {
    const li = document.createElement('li');
    li.className = `todo-item${t.done ? ' done' : ''}`;
    li.innerHTML = `
      <input type="checkbox" class="todo-check" ${t.done ? 'checked' : ''} data-toggle="${t.id}">
      <span class="todo-text">${escapeHtml(t.text)}</span>
      <button class="btn small danger" data-del="${t.id}">Remove</button>
    `;
    list.appendChild(li);
  });

  $$('[data-toggle]', list).forEach(cb => cb.addEventListener('change', () => {
    todos.find(t => t.id === cb.dataset.toggle).done = cb.checked;
    saveTodos(); renderTodos(); renderDashboard();
  }));
  $$('[data-del]', list).forEach(btn => btn.addEventListener('click', () => {
    todos = todos.filter(t => t.id !== btn.dataset.del);
    saveTodos(); renderTodos(); renderDashboard();
  }));

  updateStat('#statTodo', todos.filter(t => !t.done).length);
}

function initTodo() {
  $('#todoForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#todoInput');
    todos.push({ id: uid(), text: input.value.trim(), done: false });
    saveTodos();
    e.target.reset();
    renderTodos(); renderDashboard();
  });
  renderTodos();
}

/* =========================================================
   DASHBOARD
   ========================================================= */
function updateStat(sel, value) { $(sel).textContent = value; }

async function renderDashboard() {
  $('#todayDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  updateStat('#statTasks', tasks.filter(t => !t.done).length);
  updateStat('#statTodo', todos.filter(t => !t.done).length);
  ensureSessionsFresh();
  updateStat('#statSessions', sessionsToday.count);
  updateStat('#statFiles', (await FileStore.all()).length);

  const due = tasks.filter(t => !t.done && t.due).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 5);
  const dueList = $('#dueSoonList');
  dueList.innerHTML = due.length
    ? due.map(t => `<li><span>${escapeHtml(t.title)}</span><span class="tag">${new Date(t.due + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></li>`).join('')
    : '<li class="mini-empty">Nothing urgent — nice.</li>';

  const sched = todaysScheduleEntries();
  const schedList = $('#todaySchedule');
  schedList.innerHTML = sched.length
    ? sched.map(s => `<li><span>${escapeHtml(s.val)}</span><span class="tag">${s.slot}</span></li>`).join('')
    : '<li class="mini-empty">No entries for today yet.</li>';
}

/* =========================================================
   INIT
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAuthScreen();

  const session = Auth.getSession();
  const account = Auth.getAccount();
  if (session && account && session === account.username) {
    enterApp(account.username);
  }
});
