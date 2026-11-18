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

const STAGE_TEXT = {
  new: 'очередь...',
  account: 'создаём свежий аккаунт...',
  account_ready: 'аккаунт готов',
  upload_refs: 'загружаем референсы...',
  submitting: 'отправляем генерацию...',
  queued: 'в очереди на источнике...',
  target_done: 'источник готов — скачиваем к нам...',
  pending_queue: 'в очереди на источнике...',
  submitting_target: 'отправляем...',
  running: 'источник рендерит видео...',
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
    const note = (engine === 'omni' && d === 10) ? ' (будет 8 — лимит Veo)' : '';
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
    ? 'Veo 3 Free: максимум 8 секунд (10 → 8) • 720p • бесплатный запуск на свежем аккаунте'
    : 'Seedance 2.0 24/7: 5–15 секунд • 480p/720p • аккаунт создаётся под каждую генерацию';

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
    video.src = '/api/videos/' + job.id + '.mp4';
    video.classList.remove('hidden');
    video.play().catch(() => {});
    return;
  }

  loading.classList.remove('hidden');
  const key = job.stage || job.status || 'new';
  $('stageStage').textContent = STAGE_TEXT[key] || key;
  $('stageBar').style.width = (job.progress || 0) + '%';
  const acc = job.account ? `аккаунт: ${job.account} • ` : '';
  $('stageHint').textContent = acc + (job.engine ? `источник: ${job.engine}` : 'подготовка источника');
}

// ---------------------------------------------------------------- jobs
async function fetchJobs() {
  try {
    const r = await fetch('/api/jobs');
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
      v.src = '/api/videos/' + j.id + '.mp4';
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
      `<span class="tag grey">${j.duration}с</span>`,
      `<span class="tag grey">${j.resolution}p</span>`,
      `<span class="tag grey">${j.ratio}</span>`,
      j.status === 'error' ? '<span class="tag red">ошибка</span>' : '',
      j.status === 'done' ? '<span class="tag">готово</span>' : `<span class="tag grey">${j.stage || j.status}</span>`,
    ].filter(Boolean).join('');

    const time = document.createElement('div');
    time.className = 'hist-time';
    time.textContent = new Date(j.createdAt).toLocaleString('ru-RU') + (j.account ? ` • ${j.account}` : '');

    const actions = document.createElement('div');
    actions.className = 'hist-actions';
    actions.innerHTML = j.hasVideo
      ? `<a href="/api/videos/${j.id}.mp4" download="video_${j.id}.mp4">⬇ Скачать</a>
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
    const r = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'запрос отклонён');
    state.activeJobId = d.job.id;
    state.lastPrompt = prompt;
    showAlert('✨ Генерация запущена — аккаунт создаётся прямо сейчас', 'success');
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

// ---------------------------------------------------------------- init
function init() {
  fetch('/api/config').then(r => r.json()).then(d => {
    $('targetBadge').textContent = 'источник: ' + (d.target || '—');
  }).catch(() => {});

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

  setEngine('omni');
  renderRefs();
  updateCounter();
  fetchJobs();
  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
