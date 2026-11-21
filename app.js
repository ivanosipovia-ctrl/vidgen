'use strict';

const state = {
  engine: 'omni', // omni | seedance
  refs: [], // {filename, contentType, dataBase64}
  jobs: [],
  activeJobId: null,
  pollTimer: null,
  view: 'stage',
  lastPrompt: '',
};

const MODELS = {
  omni: ['Veo 3.1 Fast', 'Veo 3.2 Fast', 'Veo 3.1 Lite'],
  seedance: ['Seedance 2.0 Standard', 'Seedance 2.0 Fast', 'Seedance 2.0 Lite'],
};

const DURATIONS = {
  omni: [4, 6, 8, 10],
  seedance: [5, 8, 10, 12, 15],
};

const RATIOS = {
  omni: ['16:9', '9:16', 'auto'],
  seedance: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', 'auto'],
};

const $ = (id) => document.getElementById(id);

// api key: web-ключ приходит с /api/config, храним и шлём везде
const api = { key: localStorage.getItem('vg_key') || '', refresh: null };
function authHeaders(extra) {
  return Object.assign({ 'X-Api-Key': api.key }, extra || {});
}
function videoUrl(id) {
  return '/api/videos/' + id + '.mp4?key=' + encodeURIComponent(api.key);
}

// сервер мог перезапуститься / redeploy — web-ключ другой. тянем его заново
// (без кэша) и сохраняем. один запрос в параллели на все вызовы
function refreshKey() {
  if (!api.refresh) {
    api.refresh = fetch('/api/config', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d.webKey && d.webKey !== api.key) {
          api.key = d.webKey;
          localStorage.setItem('vg_key', d.webKey);
          syncVideoUrls(); // <video> уже получил src со старым ключом
        }
        return api.key;
      })
      .catch(() => api.key)
      .finally(() => { api.refresh = null; });
  }
  return api.refresh;
}

// переписываем src у всех плееров, если ключ сменился
function syncVideoUrls() {
  document.querySelectorAll('video[src*="/api/videos/"]').forEach(v => {
    const id = (v.getAttribute('src') || '').match(/\/api\/videos\/([a-z0-9]+)\.mp4/i);
    if (!id) return;
    const next = videoUrl(id[1]);
    if (v.src !== new URL(next, location.href).href) v.src = next;
  });
}

// fetch с авторизацией: при 401 один раз обновляем ключ и повторяем запрос.
// заголовок ставим здесь же — вызывающий код мог собрать его со старым ключом
async function apiFetch(url, opts) {
  const withKey = (o) => {
    const n = Object.assign({}, o || {});
    n.headers = Object.assign({}, (o && o.headers) || {}, { 'X-Api-Key': api.key });
    return n;
  };
  let r = await fetch(url, withKey(opts));
  if (r.status === 401 || r.status === 403) {
    const before = api.key;
    await refreshKey();
    if (api.key && api.key !== before) r = await fetch(url, withKey(opts));
  }
  return r;
}

const STAGE_TEXT = {
  new: 'очередь...',
  account: 'соединяемся с API...',
  account_ready: 'API подключён',
  upload_refs: 'загружаем референсы...',
  submitting: 'отправляем генерацию...',
  queued: 'в очереди на источнике...',
  target_done: 'видео готово — скачиваем к нам...',
  pending_queue: 'в очереди на источнике...',
  submitting_target: 'отправляем...',
  running: 'рендерим видео...',
  downloading: 'скачиваем готовое видео...',
  done: 'готово!',
  error: 'ошибка',
};

// ---------------------------------------------------------------- engines
function setEngine(engine) {
  state.engine = engine;

  document.querySelectorAll('.engine-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.engine === engine);
  });
  $('topEngineOmni').classList.toggle('active', engine === 'omni');
  $('topEngineSeedance').classList.toggle('active', engine === 'seedance');

  const modelSel = $('genModel');
  modelSel.innerHTML = MODELS[engine].map(m => `<option value="${m}">${m}</option>`).join('');

  const durSel = $('genDuration');
  const prev = Number(durSel.value);
  const durs = DURATIONS[engine];
  durSel.innerHTML = durs.map(d => {
    const note = (engine === 'omni' && d === 10) ? ' (Gencpu Free — реальные 10с)' : '';
    return `<option value="${d}">${d} сек${note}</option>`;
  }).join('');
  if (durs.includes(prev)) durSel.value = String(prev);
  else durSel.value = String(engine === 'omni' ? 8 : 10);

  const resSel = $('genRes');
  if (engine === 'omni') {
    resSel.innerHTML = '<option value="720">720p</option>';
    resSel.disabled = true;
  } else {
    resSel.innerHTML = '<option value="480">480p</option><option value="720">720p HD</option>';
    resSel.disabled = false;
  }

  const ratioSel = $('genRatio');
  ratioSel.innerHTML = RATIOS[engine].map(r => `<option value="${r}">${r}</option>`).join('');

  $('durationHint').textContent = engine === 'omni'
    ? '4/6/8 сек → Veo 3 Free • 10 сек → Gencpu Free (Seedance 2.5 Lite / Gencpu 1.1) • 720p'
    : 'Seedance 2.0 24/7: 5–15 секунд • 480p/720p • прямой вызов API';

  $('studioTitle').textContent = engine === 'omni' ? 'Omni Flash — Text to Video' : 'Seedance 2 Pro — Text to Video';
  $('studioSub').textContent = engine === 'omni'
    ? 'Veo 3 Free: сервер 🎥 Veo 3 Free → модель Veo 3.1 Fast'
    : '⚡ Seedance 2.0 24/7 → выбранная модель';
}

// ---------------------------------------------------------------- refs
function renderRefs() {
  const box = $('refThumbs');
  box.innerHTML = '';
  state.refs.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'ref-thumb';
    const img = document.createElement('img');
    img.src = r.dataBase64;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '✕';
    rm.onclick = () => { state.refs.splice(i, 1); renderRefs(); };
    div.appendChild(img);
    div.appendChild(rm);
    box.appendChild(div);
  });
}

function fileToRef(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve({
      filename: file.name,
      contentType: file.type || 'image/png',
      dataBase64: String(reader.result || ''),
    });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- alerts
function showAlert(msg, tone) {
  const el = $('batchAlert');
  el.className = 'alert ' + (tone || 'info');
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.classList.add('hidden'); }, 9000);
}

// ---------------------------------------------------------------- stage
function renderStage(job) {
  const empty = $('stageEmpty');
  const loading = $('stageLoading');
  const video = $('stageVideo');
  const err = $('stageError');

  empty.classList.add('hidden');
  loading.classList.add('hidden');
  video.classList.add('hidden');
  err.classList.add('hidden');

  if (!job) { empty.classList.remove('hidden'); return; }

  if (job.status === 'error') {
    err.classList.remove('hidden');
    $('stageErrorText').textContent = job.error || 'неизвестная ошибка';
    return;
  }

  if (job.hasVideo && job.status === 'done') {
    const next = videoUrl(job.id);
    if (video.src !== new URL(next, location.href).href) video.src = next; // не сбрасываем воспроизведение
    video.classList.remove('hidden');
    if (video.paused) video.play().catch(() => {});
    return;
  }

  loading.classList.remove('hidden');
  const key = job.stage || job.status || 'new';
  $('stageStage').textContent = STAGE_TEXT[key] || key;
  $('stageBar').style.width = (job.progress || 0) + '%';
  $('stageHint').textContent = job.engine ? `движок: ${job.engine}` : 'подключение к API';
}

// ---------------------------------------------------------------- jobs
async function fetchJobs() {
  try {
    const r = await apiFetch('/api/jobs', { headers: authHeaders(), cache: 'no-store' });
    const d = await r.json();
    state.jobs = d.jobs || [];
  } catch (e) { return; }

  // a job is only "finished" when the video is actually here — status=done
  // without hasVideo means the download is still in flight, keep polling
  const isFinished = (j) => j.status === 'error' || (j.status === 'done' && j.hasVideo);
  const running = state.jobs.filter(j => !isFinished(j));
  $('runningCount').textContent = running.length;
  $('historyCount').textContent = state.jobs.length;
  $('sideJobCount').textContent = state.jobs.length;

  const active = state.jobs.find(j => j.id === state.activeJobId && !isFinished(j))
    || running[0]
    || state.jobs.find(j => j.id === state.activeJobId)
    || state.jobs[0]
    || null;
  if (active) state.activeJobId = active.id;

  renderStage(active);
  renderHistory();

  if (!running.length) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    $('btnSubmitBatch').disabled = false;
  } else {
    startPolling(); // self-heal if the timer ever died while jobs are pending
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(fetchJobs, 2500);
}

function renderHistory() {
  const box = $('history');
  if (!state.jobs.length) {
    box.innerHTML = '<div class="empty-note">Пока пусто — сгенерируйте первое видео</div>';
    return;
  }
  box.innerHTML = '';
  for (const j of state.jobs) {
    const item = document.createElement('div');
    item.className = 'hist-item';

    const thumb = document.createElement('div');
    thumb.className = 'hist-thumb';
    if (j.hasVideo) {
      const v = document.createElement('video');
      v.src = videoUrl(j.id);
      v.muted = true;
      v.preload = 'metadata';
      thumb.appendChild(v);
    } else {
      thumb.textContent = j.status === 'error' ? 'ошибка' : (j.progress || 0) + '%';
    }

    const meta = document.createElement('div');
    meta.className = 'hist-meta';

    const prompt = document.createElement('div');
    prompt.className = 'hist-prompt';
    prompt.textContent = j.prompt;

    const tags = document.createElement('div');
    tags.className = 'hist-tags';
    tags.innerHTML = [
      `<span class="tag">${j.model === 'omni' ? 'Omni Flash' : 'Seedance 2 Pro'}</span>`,
      `<span class="tag grey">${j.targetModel || '—'}</span>`,
      `<span class="tag grey">${j.requestedDuration ? j.requestedDuration + '→' + j.duration + 'с' : j.duration + 'с'}</span>`,
      `<span class="tag grey">${j.resolution}p</span>`,
      `<span class="tag grey">${j.ratio}</span>`,
      j.status === 'error' ? '<span class="tag red">ошибка</span>' : '',
      j.status === 'done' ? '<span class="tag">готово</span>' : `<span class="tag grey">${j.stage || j.status}</span>`,
    ].filter(Boolean).join('');

    const time = document.createElement('div');
    time.className = 'hist-time';
    time.textContent = new Date(j.createdAt).toLocaleString('ru-RU') + (j.keyLabel ? ` • ${j.keyLabel}` : '');

    const actions = document.createElement('div');
    actions.className = 'hist-actions';
    actions.innerHTML = j.hasVideo
      ? `<a href="${videoUrl(j.id)}" download="video_${j.id}.mp4">⬇ Скачать</a>
         <button data-open="${j.id}">▶ Показать</button>`
      : (j.status === 'error' ? `<span class="tag red" title="${(j.error || '').replace(/"/g, '')}">${(j.error || 'ошибка').slice(0, 80)}</span>` : '');

    meta.appendChild(prompt);
    meta.appendChild(tags);
    meta.appendChild(time);
    meta.appendChild(actions);
    item.appendChild(thumb);
    item.appendChild(meta);
    box.appendChild(item);
  }

  box.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => {
      state.activeJobId = b.dataset.open;
      setView('stage');
      fetchJobs();
    };
  });
}

function setView(v) {
  state.view = v;
  $('tabStage').classList.toggle('active', v === 'stage');
  $('tabHistory').classList.toggle('active', v === 'history');
  $('stage').classList.toggle('hidden', v !== 'stage');
  $('history').classList.toggle('hidden', v !== 'history');
}

// ---------------------------------------------------------------- submit
async function submit() {
  const prompt = $('bulkPromptsInput').value.trim();
  if (!prompt) { showAlert('Введите промт', 'error'); return; }

  const payload = {
    model: state.engine,
    targetModel: $('genModel').value,
    prompt,
    duration: Number($('genDuration').value),
    resolution: Number($('genRes').value),
    ratio: $('genRatio').value,
    audio: $('genAudio').checked,
    refs: state.refs,
  };

  $('btnSubmitBatch').disabled = true;
  try {
    const r = await apiFetch('/api/generate', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'запрос отклонён');
    state.activeJobId = d.job.id;
    state.lastPrompt = prompt;
    showAlert('✨ Генерация запущена — запрос принят API', 'success');
    $('bulkPromptsInput').value = '';
    updateCounter();
    setView('stage');
    startPolling();
    fetchJobs();
  } catch (e) {
    showAlert(e.message || 'ошибка отправки', 'error');
    $('btnSubmitBatch').disabled = false;
  }
}

function updateCounter() {
  const v = $('bulkPromptsInput').value;
  const n = v.length;
  $('promptCounter').textContent = n + ' символов';
  $('charCount').textContent = n + ' символов';
}

// ---------------------------------------------------------------- api keys modal
async function apiGet(path, opts) {
  const r = await apiFetch(path, Object.assign({ headers: authHeaders(), cache: 'no-store' }, opts || {}));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'ошибка ' + r.status);
  return d;
}

const KEYS_BACKUP = 'vg_keys_backup';
function readKeysBackup() {
  try { return JSON.parse(localStorage.getItem(KEYS_BACKUP) || '[]'); } catch (e) { return []; }
}
// аварийный ключ сервера — приходит с /api/keys, показывается отдельной строкой
let EMERGENCY_KEY = '';
function writeKeysBackup(list) {
  try { localStorage.setItem(KEYS_BACKUP, JSON.stringify(list)); } catch (e) {}
}

// после редеплоя на Render keys.json пуст — восстанавливаем список из бэкапа
// браузера (сами ключи при этом действуют и так, см. server.js)
async function loadKeyList() {
  let list = [];
  try {
    const d = await apiGet('/api/keys');
    list = d.keys || [];
    if (d.emergency) EMERGENCY_KEY = String(d.emergency);
  } catch (e) { return list; }
  const have = new Set(list.map(k => k.key));
  const missing = readKeysBackup().filter(k => k && k.key && !have.has(k.key));
  if (missing.length) {
    try {
      await apiGet('/api/keys/sync', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ keys: missing }),
      });
      const d = await apiGet('/api/keys');
      list = d.keys || list;
    } catch (e) {}
  }
  if (list.length) writeKeysBackup(list); // пустой ответ не затирает бэкап
  return list;
}

async function renderKeys() {
  const box = $('apiKeyList');
  try {
    const all = await loadKeyList();
    const list = all.filter(k => !k.disabled); // отозванные не показываем
    box.innerHTML = '';
    if (EMERGENCY_KEY) {
      const row = document.createElement('div');
      row.className = 'key-row';
      row.innerHTML = `
        <div style="min-width:0">
          <div class="key-name">аварийный · всегда работает</div>
          <div class="key-meta">зашит в сервер — переживает любые рестарты и редеплои</div>
        </div>
        <div class="key-val">${escapeHtml(EMERGENCY_KEY.slice(0, 10))}…${escapeHtml(EMERGENCY_KEY.slice(-4))}</div>
        <button data-copy="${escapeHtml(EMERGENCY_KEY)}">копировать</button>`;
      box.appendChild(row);
    }
    if (!list.length) {
      if (!EMERGENCY_KEY) box.innerHTML = '<div class="key-empty">Ключей пока нет — создайте первый</div>';
      return;
    }
    for (const k of list) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const created = new Date(k.createdAt).toLocaleDateString('ru-RU');
      const used = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('ru-RU') : 'не использовался';
      const isWeb = k.id === 'web';
      row.innerHTML = `
        <div style="min-width:0">
          <div class="key-name">${escapeHtml(k.name)}${isWeb ? ' · сайт' : ''}</div>
          <div class="key-meta">создан ${created} • последний запрос: ${used}</div>
        </div>
        <div class="key-val">${escapeHtml(k.key.slice(0, 10))}…${escapeHtml(k.key.slice(-4))}</div>
        <button data-copy="${escapeHtml(k.key)}">копировать</button>
        ${isWeb ? '' : `<button data-revoke="${escapeHtml(k.key)}">удалить</button>`}`;
      box.appendChild(row);
    }
    box.querySelectorAll('[data-copy]').forEach(b => {
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'скопировано'; } catch (e) {}
        setTimeout(() => { b.textContent = 'копировать'; }, 1500);
      };
    });
    box.querySelectorAll('[data-revoke]').forEach(b => {
      b.onclick = async () => {
        try { await apiGet('/api/keys/' + b.dataset.revoke, { method: 'DELETE' }); } catch (e) {}
        renderKeys();
      };
    });
  } catch (e) {
    box.innerHTML = '<div class="key-empty">' + escapeHtml(e.message) + '</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openApi() {
  $('apiModal').classList.remove('hidden');
  renderKeys();
}
function closeApi() { $('apiModal').classList.add('hidden'); }

async function initKeys() {
  $('navApi').addEventListener('click', openApi);
  $('topNavApi').addEventListener('click', openApi); // мобильная кнопка в топбаре
  $('apiClose').addEventListener('click', closeApi);
  $('apiModal').addEventListener('click', (e) => { if (e.target === $('apiModal')) closeApi(); });
  $('apiKeyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('apiKeyName').value.trim();
    if (!name) return;
    try {
      const d = await apiGet('/api/keys', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name }) });
      const box = $('apiKeyNew');
      box.className = 'alert';
      box.textContent = 'Новый ключ: ' + d.key + ' — скопируйте и сохраните, он не показывается снова.';
      $('apiKeyName').value = '';
      renderKeys();
    } catch (err) {
      const box = $('apiKeyNew');
      box.className = 'alert error';
      box.textContent = err.message;
    }
  });
}

// ---------------------------------------------------------------- init
async function init() {
  try {
    const d = await (await fetch('/api/config', { cache: 'no-store' })).json();
    if (d.webKey) {
      api.key = d.webKey;
      localStorage.setItem('vg_key', d.webKey);
    }
    $('targetBadge').textContent = 'API: ' + (d.target || '—')
      + (d.stableKeys === false ? ' · ⚠ ключи не сохранятся без WEB_KEY' : '');
  } catch (e) {}

  document.querySelectorAll('.engine-btn').forEach(b => {
    b.addEventListener('click', () => setEngine(b.dataset.engine));
  });
  $('topEngineOmni').addEventListener('click', () => setEngine('omni'));
  $('topEngineSeedance').addEventListener('click', () => setEngine('seedance'));

  $('bulkPromptsInput').addEventListener('input', updateCounter);
  $('btnClearPrompt').addEventListener('click', () => { $('bulkPromptsInput').value = ''; updateCounter(); });

  $('refInput').addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []).slice(0, 9 - state.refs.length);
    for (const f of files) {
      try { state.refs.push(await fileToRef(f)); } catch (e) {}
    }
    ev.target.value = '';
    renderRefs();
  });
  $('btnClearRefs').addEventListener('click', () => { state.refs = []; renderRefs(); });

  $('btnSubmitBatch').addEventListener('click', submit);
  $('btnRetry').addEventListener('click', () => {
    if (state.lastPrompt) {
      $('bulkPromptsInput').value = state.lastPrompt;
      updateCounter();
      submit();
    }
  });

  $('tabStage').addEventListener('click', () => setView('stage'));
  $('tabHistory').addEventListener('click', () => setView('history'));
  $('navHistory').addEventListener('click', () => setView('history'));
  $('topNavHistory').addEventListener('click', () => setView('history')); // мобильная кнопка

  setEngine('omni');
  renderRefs();
  updateCounter();
  initKeys();
  fetchJobs();
  loadKeyList().catch(() => {}); // восстановление ключей после редеплоя — фоном
  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
