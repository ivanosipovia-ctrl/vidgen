// video-site backend — no dependencies, Node 18+
// flow per generation: authorize -> batch -> poll -> download mp4
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const TARGET = process.env.TARGET_URL || 'http://160.30.161.35';
const EMAILNATOR = 'https://emailnator.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const PAID_TOKEN_FILE = path.join(DATA_DIR, 'paid-token.txt');

// optional: paste a token of an account with an active Seedance pack -> seedance jobs use it
function paidToken() {
  if (process.env.PAID_TOKEN) return process.env.PAID_TOKEN.trim();
  try {
    if (fs.existsSync(PAID_TOKEN_FILE)) return fs.readFileSync(PAID_TOKEN_FILE, 'utf8').trim();
  } catch (e) {}
  return '';
}

for (const dir of [DATA_DIR, VIDEO_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------- api keys
// data/keys.json: { "<key>": { id, name, createdAt, lastUsedAt, disabled } }
// the built-in "web" key is auto-provisioned and returned by /api/config so the
// site UI can authenticate; external apps get their own keys via POST /api/keys
//
// На хостинге с эфемерным диском (Render free) keys.json стирается при каждом
// рестарте/редеплое, поэтому ключи НЕ зависят от файла:
//   * web-ключ берётся из переменной окружения WEB_KEY — он не меняется никогда;
//   * каждый новый ключ несёт HMAC-метку от секрета (WEB_KEY/KEY_SECRET из
//     окружения, локально — data/secret.txt) и действует даже без записи на диске;
//   * список ключей браузер восстанавливает через POST /api/keys/sync.
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
const WEB_KEY_ID = 'web';
const WEB_KEY_ENV = String(process.env.WEB_KEY || '').trim();
const KEY_SECRET_ENV = String(process.env.KEY_SECRET || '').trim();
const ON_RENDER = Boolean(process.env.RENDER);

function loadOrCreateSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s) return s;
    }
  } catch (e) {}
  const s = rnd(48);
  try { fs.writeFileSync(SECRET_FILE, s); } catch (e) {}
  return s;
}
// секрет HMAC: окружение переживает редеплой, файл — только локально
const KEY_SECRET = KEY_SECRET_ENV || WEB_KEY_ENV || loadOrCreateSecret();

let keys = {};
if (fs.existsSync(KEYS_FILE)) {
  try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (e) { keys = {}; }
}
function saveKeys() {
  try { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2)); } catch (e) {}
}
function hmacHex(input) {
  return crypto.createHmac('sha256', KEY_SECRET).update(String(input)).digest('hex');
}
// ключ вида vg_<8 hex id><16 hex метка>: метка выводится из секрета,
// поэтому такой ключ принимается сервером и когда keys.json утрачен
function statelessValid(k) {
  const m = /^vg_([0-9a-f]{8})([0-9a-f]{16})$/i.exec(String(k || ''));
  if (!m) return false;
  const expect = hmacHex('key:' + m[1].toLowerCase()).slice(0, 16);
  try {
    return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(m[2].toLowerCase()));
  } catch (e) { return false; }
}
function findWebKey() {
  for (const [k, v] of Object.entries(keys)) if (v && v.id === WEB_KEY_ID && !v.disabled) return k;
  return null;
}
// web-ключ: WEB_KEY из окружения > производный от секрета > с диска > новый
let webKey = WEB_KEY_ENV
  || (KEY_SECRET_ENV ? 'vg_' + hmacHex('web').slice(0, 24) : null)
  || findWebKey()
  || 'vg_' + rnd(24);
if (!keys[webKey] || keys[webKey].id !== WEB_KEY_ID) {
  const oldWeb = Object.entries(keys).find(([, v]) => v && v.id === WEB_KEY_ID && !v.disabled);
  if (oldWeb && oldWeb[0] !== webKey) keys[oldWeb[0]].disabled = true;
  keys[webKey] = { id: WEB_KEY_ID, name: 'web', createdAt: Date.now(), lastUsedAt: null };
  saveKeys(); // иначе файл на диске остался бы со старым web-ключом
} else if (keys[webKey].disabled) {
  delete keys[webKey].disabled;
  saveKeys();
}
const WEB_KEY = webKey;
// Аварийный ключ — зашит в сам код: принимается сервером ВСЕГДА, переживает
// любые рестарты/редеплои и утрату keys.json (не зависит ни от секрета, ни от
// диска). Для генераций; управление ключами — только через web-ключ.
// Можно переопределить переменной окружения EMERGENCY_KEY.
const EMERGENCY_KEY = String(process.env.EMERGENCY_KEY || 'vg_e4c1a7f9d20b6835ac91e0d7').trim();
// локально диск постоянный — ключи и так стабильны; на эфемерном диске
// без переменной окружения они будут меняться при каждом рестарте
const STABLE_KEYS = Boolean(KEY_SECRET_ENV || WEB_KEY_ENV) || !ON_RENDER;
if (!STABLE_KEYS) {
  console.warn('ВНИМАНИЕ: задайте переменную окружения WEB_KEY — иначе ключи изменятся после каждого редеплоя');
}

function keyFrom(req, url) {
  const h = req.headers['x-api-key'] || req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  if (m) return m[1].trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  const q = url.searchParams.get('key'); // videos: <video src> cannot send headers
  return q ? q.trim() : '';
}
function authKey(req, url) {
  const k = keyFrom(req, url);
  if (!k) return null;
  if (k === EMERGENCY_KEY) {
    return { key: k, id: 'emergency', name: 'аварийный' };
  }
  if (k === WEB_KEY) {
    if (keys[k]) keys[k].lastUsedAt = Date.now();
    return { key: k, id: WEB_KEY_ID, name: 'web' };
  }
  const rec = keys[k];
  if (rec) {
    if (rec.disabled) return null; // отзыв действует, пока запись на диске
    rec.lastUsedAt = Date.now();
    return { key: k, ...rec };
  }
  // keys.json утрачен (эфемерный диск) — ключ всё равно действует,
  // если HMAC-метка сходится с секретом из окружения
  if (statelessValid(k)) {
    return { key: k, id: k.slice(3, 11), name: 'внешний ключ', stateless: true };
  }
  return null;
}
function isWeb(rec) { return rec && rec.id === WEB_KEY_ID; }

// ---------------------------------------------------------------- job store
let jobs = {};
if (fs.existsSync(JOBS_FILE)) {
  try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch (e) { jobs = {}; }
}
// recovery: a restart/redeploy kills in-flight jobs — surface them as errors
// instead of leaving the UI polling a ghost forever
let recoveredCount = 0;
for (const j of Object.values(jobs)) {
  if (j && j.status !== 'done' && j.status !== 'error') {
    j.status = 'error';
    j.stage = 'error';
    j.error = 'сервер был перезапущен во время генерации — запустите заново';
    j.finishedAt = j.finishedAt || Date.now();
    recoveredCount++;
  }
}
if (recoveredCount) console.log('восстановление после перезапуска: ' + recoveredCount + ' прерванных джоб помечено ошибкой');

let jobsWriteTimer = null;
function saveJobs() {
  if (jobsWriteTimer) return;
  jobsWriteTimer = setTimeout(() => {
    jobsWriteTimer = null;
    try { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); } catch (e) {}
  }, 250);
}

function publicJob(j) {
  return {
    id: j.id,
    model: j.model,          // omni | seedance
    engine: j.engine,        // target engine used
    targetModel: j.targetModel,
    prompt: j.prompt,
    duration: j.duration,
    requestedDuration: j.requestedDuration || null, // если 10 → 8: показываем оба
    resolution: j.resolution,
    ratio: j.ratio,
    audio: j.audio,
    status: j.status,
    stage: j.stage,
    error: j.error,
    progress: j.progress,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt || null,
    keyLabel: j.keyLabel || null,
    hasVideo: Boolean(j.videoFile && fs.existsSync(path.join(VIDEO_DIR, j.videoFile))),
  };
}

// ---------------------------------------------------------------- http utils
async function targetPost(p, payload, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-GenCPU-Client': 'web',
    'Origin': TARGET,
    'Referer': TARGET + '/',
    'User-Agent': UA,
  };
  if (token) { headers.Authorization = 'Bearer ' + token; headers['X-Api-Key'] = token; }
  const res = await fetch(TARGET + p, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text };
}

async function targetGet(p, token) {
  const headers = {
    'Accept': 'application/json',
    'X-GenCPU-Client': 'web',
    'User-Agent': UA,
  };
  if (token) { headers.Authorization = 'Bearer ' + token; headers['X-Api-Key'] = token; }
  const res = await fetch(TARGET + p, { headers });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text, res };
}

function rnd(n) {
  return crypto.randomBytes(n * 2).toString('hex').slice(0, n);
}

// ---------------------------------------------------------------- accounts
async function makeEmail() {
  const res = await fetch(EMAILNATOR + '/api/generate-email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': UA,
      'Referer': EMAILNATOR + '/',
      'Origin': EMAILNATOR,
    },
    body: JSON.stringify({ ids: [1, 2, 3, 8] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.email) throw new Error('emailnator: ' + JSON.stringify(data).slice(0, 200));
  return data.email;
}

async function createAccount() {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    let email;
    try { email = await makeEmail(); } catch (e) { lastErr = e; await sleep(1500); continue; }
    const username = 'vx' + rnd(9);
    const password = 'Vp9!' + rnd(14);
    try {
      const r = await targetPost('/api/auth/register', { username, email, password, refCode: '' });
      const token = r.data && r.data.user && (r.data.user.webToken || r.data.user.apiKey);
      if (token) return { token, username, email, id: r.data.user.id };
      lastErr = new Error('register failed: ' + (r.text || '').slice(0, 300));
    } catch (e) {
      lastErr = e;
    }
    await sleep(1200);
  }
  throw lastErr || new Error('account creation failed');
}

// ---------------------------------------------------------------- generation
// Veo (server11) принимает только 4/6/8 — их сервер отклоняет 10
// (проверено: "Server 11 hỗ trợ các mức thời lượng 4s, 6s và 8s").
// Для 10с — кластер Gencpu Free с фронта 160.30.161.35 (selectGencpuFreeCluster):
// server7 "Seedance 2.5 Lite" (5/10/15с, free 0d, быстрый фейл при OOM → повтор),
// фолбэк server10 "Gencpu 1.1" (10–30с, 720p).
const OMNI_DURATIONS = [4, 6, 8, 10];
function omniDuration(d) {
  d = Number(d);
  return OMNI_DURATIONS.includes(d) ? d : 8;
}

function buildBatchPayload(opts) {
  const prompt = String(opts.prompt || '').trim();
  const imageAssetIds = opts.imageAssetIds || [];

  if (opts.model === 'omni') {
    const duration = omniDuration(opts.duration);
    const ratio = ['16:9', '9:16', 'auto'].includes(opts.ratio) ? opts.ratio : '16:9';

    if (duration === 10) {
      // 10с: настройки как на фото (720p, 16:9, audio, 1 видео), кластер Gencpu Free.
      // Приоритет: server7 (Seedance 2.5 Lite, 2116 готовых потоков, free 0d,
      // падает быстро при OOM → повтор), потом server10 (Gencpu 1.1, 720p).
      const base10 = {
        useSeedanceHub: false,
        useServer3: false, useServer4: false, useServer5: false, useServer6: false,
        useServer7: false, useServer8: false, useServer9: false,
        useServer10: true, useServer11: false, useServer12: false, useServer13: false, useServer14: false,
        useSv9Fallback: false,
        op: imageAssetIds.length ? 'i2v' : 't2v',
        i2vMode: 'by-name',
        i2vSlotType: 'start',
        imageAssetIds,
        refVidAssetIds: [],
        refAudioAssetIds: [],
        duration,
        resolution: 720,
        ratio,
        audio: opts.audio !== false,
        autoSanitizeVpcs: true,
        prompts: [prompt],
      };
      const sv7 = Object.assign({}, base10, {
        model: 'Seedance 2.5 Lite',
        serverEngine: 'server7',
        useServer10: false,
        useServer7: true,
        engine: 'server7',
        cookieSource: 'server7',
        // их фронт getActiveSv7ModeKey(): для Seedance 2.5 Lite режим 'seedance_25_lite'
        // (свой пул); 'gencpu_video' уводит в пул Gencpu AI, который в OOM
        sv7Mode: 'seedance_25_lite',
      });
      const sv10 = Object.assign({}, base10, {
        model: 'Gencpu 1.1',
        serverEngine: 'server10',
        engine: 'server10',
        cookieSource: 'server10',
      });
      const at7 = { payload: sv7, duration, engine: 'server7', targetModel: 'Seedance 2.5 Lite' };
      const at10 = { payload: sv10, duration, engine: 'server10', targetModel: 'Gencpu 1.1' };
      return {
        payload: sv7,
        duration,
        engine: 'server7',
        targetModel: 'Seedance 2.5 Lite',
        // OOM на server7 лечится «через несколько минут» — повторяем; server10
        // в конце и только если у него живой пул (иначе очередь висит вечно)
        fallbacks: [at7, at7, at10],
      };
    }

    const veoModels = ['Veo 3.1 Fast', 'Veo 3.2 Fast', 'Veo 3.1 Lite'];
    const veoModel = veoModels.includes(opts.targetModel) ? opts.targetModel : 'Veo 3.1 Fast';
    return {
      payload: {
        model: veoModel,
        serverEngine: 'server11',
        useSeedanceHub: false,
        useServer3: false, useServer4: false, useServer5: false, useServer6: false,
        useServer7: false, useServer8: false, useServer9: false, useServer10: false,
        useServer11: true, useServer12: false, useServer13: false, useServer14: false,
        useSv9Fallback: false,
        engine: 'server11',
        cookieSource: 'server11',
        op: imageAssetIds.length ? 'i2v' : 't2v',
        i2vMode: 'all-shared',
        i2vSlotType: 'start',
        imageAssetIds,
        refVidAssetIds: [],
        refAudioAssetIds: [],
        duration,
        resolution: 720,
        ratio,
        audio: opts.audio !== false,
        autoSanitizeVpcs: true,
        prompts: [prompt],
      },
      duration,
      engine: 'server11',
      targetModel: veoModel,
    };
  }

  // seedance 2 pro -> cluster "Seedance 2.0 24/7" (server2 / server9)
  const allowedDurs = [5, 8, 10, 12, 15];
  let duration = Number(opts.duration);
  if (!allowedDurs.includes(duration)) duration = 10;
  const engine = opts.engine === 'server9' ? 'server9' : 'server2';
  const allowedModels = engine === 'server9'
    ? ['Seedance 2.0', 'Seedance 2.0 Lite']
    : ['Seedance 2.0 Standard', 'Seedance 2.0 Fast', 'Seedance 2.0 Lite'];
  let model = opts.targetModel || 'Seedance 2.0 Standard';
  if (engine === 'server9' && model === 'Seedance 2.0 Standard') model = 'Seedance 2.0';
  if (!allowedModels.includes(model)) model = allowedModels[0];
  const resolution = engine === 'server9' ? 720 : (Number(opts.resolution) === 720 ? 720 : 480);
  const ratio = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', 'auto'].includes(opts.ratio) ? opts.ratio : '16:9';

  return {
    payload: {
      model,
      serverEngine: engine,
      useSeedanceHub: engine === 'server2',
      useServer3: false, useServer4: false, useServer5: false, useServer6: false,
      useServer7: false, useServer8: false,
      useServer9: engine === 'server9',
      useServer10: false, useServer11: false, useServer12: false, useServer13: false, useServer14: false,
      useSv9Fallback: engine === 'server9',
      engine: engine === 'server2' ? 'seedancehub' : 'server9',
      cookieSource: engine === 'server2' ? 'seedancehub' : 'server9',
      op: imageAssetIds.length ? 'i2v' : 't2v',
      i2vMode: 'all-shared',
      i2vSlotType: 'start',
      imageAssetIds,
      refVidAssetIds: [],
      refAudioAssetIds: [],
      duration,
      resolution,
      ratio,
      audio: opts.audio !== false,
      autoSanitizeVpcs: true,
      prompts: [prompt],
    },
    duration,
    engine,
    targetModel: model,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function uploadRefs(token, refs) {
  const ids = [];
  for (const ref of refs) {
    const r = await targetPost('/api/assets/upload', {
      files: [{
        filename: ref.filename || ('ref_' + rnd(4) + (ref.ext || '.png')),
        contentType: ref.contentType || 'image/png',
        dataBase64: ref.dataBase64,
      }],
    }, token);
    if (r.data && r.data.ok && r.data.assets && r.data.assets[0]) {
      ids.push(r.data.assets[0].id);
    } else {
      throw new Error('ref upload failed: ' + (r.text || '').slice(0, 300));
    }
  }
  return ids;
}

async function runJob(job) {
  job.stage = 'account';
  job.progress = 3;
  saveJobs();

  try {
    const forced = job.model === 'seedance' ? paidToken() : '';
    let acc;
    if (forced) {
      acc = { token: forced, username: 'пакет-аккаунт', email: '' };
    } else {
      acc = await createAccount();
    }
    job.account = acc.username;
    job.stage = 'account_ready';
    job.progress = 8;
    saveJobs();

    let imageAssetIds = [];
    if (job.refs && job.refs.length) {
      job.stage = 'upload_refs';
      job.progress = 12;
      saveJobs();
      imageAssetIds = await uploadRefs(acc.token, job.refs);
    }

    const built = buildBatchPayload({ ...job, imageAssetIds });
    const attempts = [built].concat(built.fallbacks || []);

    job.stage = 'submitting';
    job.progress = 15;
    saveJobs();

    // опрос целевого джобы; при ошибе/таймауте — переход на следующую попытку
    const pollTarget = async () => {
      const startedAt = Date.now();
      const DEADLINE = 15 * 60 * 1000;
      let targetJob = null;
      while (Date.now() - startedAt < DEADLINE) {
        await sleep(5000);
        const st = await targetGet('/api/state', acc.token);
        if (!st.data) continue;
        const list = st.data.myJobs || st.data.jobs || [];
        targetJob = list.find(j => j && j.id === job.targetJobId) || null;
        if (targetJob) {
          const s = targetJob.status;
          if (s === 'done' || s === 'completed') {
            job.progress = 95;
            job.stage = 'target_done'; // NOT status=done yet — video still has to land here
          } else if (s === 'error' || s === 'failed' || s === 'canceled') {
            job.status = s;
            job.stage = 'error';
            if (targetJob.error) job.error = String(targetJob.error);
            saveJobs();
            throw new Error('target job failed: ' + (targetJob.error || s));
          } else {
            job.status = s;
            job.progress = Math.min(95, 25 + Math.round(Number(targetJob.progress || 0)));
            job.stage = s;
            if (targetJob.error) job.error = String(targetJob.error);
          }
          saveJobs();
          if (job.stage === 'target_done') break;
        }
      }
      if (!targetJob || !['done', 'completed'].includes(targetJob.status)) {
        throw new Error('timeout waiting for target job');
      }
    };

    let done = false;
    const attemptErrs = [];
    for (let ai = 0; ai < attempts.length; ai++) {
      const attempt = attempts[ai];
      // server10 без живого пула (readyStreams=0) не отправляем — job повиснет в очереди навсегда
      if (attempt.engine === 'server10') {
        try {
          const st = await targetGet('/api/state', acc.token);
          if (st.data && st.data.server10 && Number(st.data.server10.readyStreams || 0) === 0) {
            attemptErrs.push('Gencpu 1.1: пул потоков пуст — пропуск');
            continue;
          }
        } catch (e) {}
      }
      try {
        const r = await targetPost('/api/batches', attempt.payload, acc.token);
        if (!r.data || !r.data.ok) {
          throw new Error('target rejected batch: ' + (r.text || '').slice(0, 300));
        }
        const first = (r.data.jobs || [])[0];
        if (!first || !first.id) throw new Error('no job id returned: ' + (r.text || '').slice(0, 300));
        job.engine = attempt.engine;
        job.targetModel = attempt.targetModel;
        job.duration = attempt.duration;
        job.targetJobId = first.id;
        job.status = 'pending';
        job.error = null;
        job.stage = 'queued';
        job.progress = 20;
        saveJobs();
        await pollTarget();
        done = true;
        break;
      } catch (e) {
        attemptErrs.push((attempt.targetModel || attempt.engine) + ': ' + String(e && e.message || e).slice(0, 300));
        job.targetJobId = null;
        job.status = 'pending';
        job.error = null;
        job.stage = 'submitting';
        saveJobs();
        if (ai < attempts.length - 1) await sleep(60000);
      }
    }
    if (!done) {
      throw new Error('Gencpu Free (10с) сейчас недоступен — попробуй позже. '
        + attemptErrs.join(' | ').slice(0, 700));
    }

    // download
    job.stage = 'downloading';
    job.progress = 96;
    saveJobs();
    let bytes = null;
    for (let i = 0; i < 8; i++) {
      const dl = await fetch(`${TARGET}/api/v1/media/${job.targetJobId}.mp4?download=1`, {
        headers: { 'User-Agent': UA, Authorization: 'Bearer ' + acc.token, 'X-Api-Key': acc.token, 'X-GenCPU-Client': 'web' },
      });
      const buf = Buffer.from(await dl.arrayBuffer());
      if (dl.ok && buf.length > 20000 && buf[0] === 0x00) { bytes = buf; break; }
      if (dl.ok && buf.length > 20000 && buf.toString('utf8', 0, 1) !== '{') { bytes = buf; break; }
      await sleep(4000);
    }
    if (!bytes) throw new Error('video download failed');

    const fname = job.id + '.mp4';
    fs.writeFileSync(path.join(VIDEO_DIR, fname), bytes);
    job.videoFile = fname;
    job.status = 'done';
    job.stage = 'done';
    job.progress = 100;
    job.finishedAt = Date.now();
    job.refs = null;
    saveJobs();
  } catch (e) {
    let msg = String(e && e.message || e);
    if (/Gói|gói cước|nạp|kích hoạt|số dư|Số dư/i.test(msg)) {
      msg += ' — для Seedance нужен активный тариф на стороне API. Omni Flash (Veo) работает бесплатно.';
    }
    job.status = 'error';
    job.error = msg;
    job.stage = 'error';
    job.finishedAt = Date.now();
    job.refs = null;
    saveJobs();
  }
}

// ---------------------------------------------------------------- http server
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([.][.][\\/])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function serveVideo(req, res, jobId) {
  const job = jobs[jobId];
  if (!job || !job.videoFile) { res.writeHead(404); res.end('no video'); return; }
  const file = path.join(VIDEO_DIR, job.videoFile);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('no video'); return; }
  const stat = fs.statSync(file);
  const range = req.headers.range;
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  const start = m && m[1] ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;

  // exactly ONE writeHead — headers are sent before the stream opens
  if (m) {
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    });
  } else {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    });
  }

  const stream = m ? fs.createReadStream(file, { start, end }) : fs.createReadStream(file);
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/config' && req.method === 'GET') {
      // web-ключ отдаём только браузеру с нашего же хоста — внешние приложения
      // берут собственные ключи через POST /api/keys.
      // Referer/Origin могут отсутствовать (Referrer-Policy, приватный режим),
      // поэтому доверяем и sec-fetch-site: same-origin
      const host = req.headers.host || '';
      const src = String(req.headers.origin || req.headers.referer || '');
      const fetchSite = String(req.headers['sec-fetch-site'] || '');
      const sameOrigin = src.includes(host) || fetchSite === 'same-origin';
      return json(res, 200, Object.assign({ target: TARGET, stableKeys: STABLE_KEYS }, sameOrigin ? { webKey: WEB_KEY } : {}));
    }

    if (p === '/api/keys' && req.method === 'GET') {
      const who = authKey(req, url);
      if (!isWeb(who)) return json(res, 403, { error: 'нужен web-ключ' });
      // disabled включаем в ответ: браузер хранит полный список как бэкап
      // и восстанавливает его через /api/keys/sync после редеплоя
      const list = Object.entries(keys)
        .filter(([, v]) => v)
        .map(([k, v]) => ({
          key: k, id: v.id, name: v.name,
          createdAt: v.createdAt, lastUsedAt: v.lastUsedAt || null,
          disabled: Boolean(v.disabled),
        }));
      return json(res, 200, { keys: list, emergency: EMERGENCY_KEY });
    }

    if (p === '/api/keys' && req.method === 'POST') {
      const who = authKey(req, url);
      if (!isWeb(who)) return json(res, 403, { error: 'нужен web-ключ' });
      const body = await readBody(req, 4096);
      const opts = JSON.parse(body.toString('utf8') || '{}');
      const name = String(opts.name || '').trim().slice(0, 40) || 'key';
      const id = rnd(8);
      // stateless-формат: метка от секрета — ключ переживает утрату keys.json
      const k = 'vg_' + id + hmacHex('key:' + id).slice(0, 16);
      keys[k] = { id, name, createdAt: Date.now(), lastUsedAt: null };
      saveKeys();
      return json(res, 200, { key: k, name });
    }

    if (p === '/api/keys/sync' && req.method === 'POST') {
      // браузер отдаёт свой бэкап списка — восстанавливаем keys.json
      // после редеплоя (диск эфемерный). Нужен web-ключ.
      const who = authKey(req, url);
      if (!isWeb(who)) return json(res, 403, { error: 'нужен web-ключ' });
      const body = await readBody(req, 64 * 1024);
      const opts = JSON.parse(body.toString('utf8') || '{}');
      const list = Array.isArray(opts.keys) ? opts.keys.slice(0, 300) : [];
      let restored = 0;
      let changed = false;
      for (const it of list) {
        const k = String(it && it.key || '');
        if (!/^vg_[a-z0-9]{24}$/i.test(k)) continue;
        if (k === WEB_KEY) continue;
        const prev = keys[k] || {};
        const known = Object.keys(prev).length > 0;
        // без переменной окружения секрет неизвестен — legacy-ключи (старого
        // формата) проверить нечем, доверяем бэкапу web-ключа
        if (!known && !statelessValid(k) && !KEY_SECRET_ENV && !WEB_KEY_ENV) continue;
        const rec = {
          // id клиента не принимаем — иначе можно было бы выдать свой ключ за web
          id: prev.id || (statelessValid(k) ? k.slice(3, 11) : rnd(8)),
          name: String(prev.name || it.name || 'key').slice(0, 40),
          createdAt: prev.createdAt || Number(it.createdAt) || Date.now(),
          lastUsedAt: prev.lastUsedAt || Number(it.lastUsedAt) || null,
        };
        if (prev.disabled || it.disabled) rec.disabled = true;
        if (!known) { restored++; changed = true; }
        else if (Boolean(prev.disabled) !== Boolean(rec.disabled)) changed = true;
        keys[k] = rec;
      }
      if (changed) saveKeys();
      return json(res, 200, { ok: true, restored });
    }

    const keyDel = p.match(/^\/api\/keys\/([a-z0-9_]+)$/i);
    if (keyDel && req.method === 'DELETE') {
      const who = authKey(req, url);
      if (!isWeb(who)) return json(res, 403, { error: 'нужен web-ключ' });
      const targetKey = keyDel[1];
      if (targetKey === EMERGENCY_KEY) {
        return json(res, 400, { error: 'аварийный ключ удалить нельзя' });
      }
      if (targetKey === WEB_KEY || (keys[targetKey] && keys[targetKey].id === WEB_KEY_ID)) {
        return json(res, 400, { error: 'web-ключ удалить нельзя' });
      }
      // принимаем и stateless-ключ, которого ещё нет на диске
      if (keys[targetKey] || statelessValid(targetKey)) {
        const rec = keys[targetKey] || { id: targetKey.slice(3, 11), name: 'внешний ключ', createdAt: Date.now(), lastUsedAt: null };
        rec.disabled = true;
        keys[targetKey] = rec;
        saveKeys();
      }
      return json(res, 200, { ok: true });
    }

    // every other /api route needs a valid key (static pages stay public)
    if (!p.startsWith('/api/')) return serveStatic(res, p);
    const caller = authKey(req, url);
    if (!caller) return json(res, 401, { error: 'API-ключ не передан или недействителен (X-Api-Key)' });
    const seesAll = isWeb(caller);

    if (p === '/api/jobs' && req.method === 'GET') {
      const list = Object.values(jobs)
        .filter(j => seesAll || j.key === caller.key)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicJob);
      return json(res, 200, { jobs: list });
    }

    if (p === '/api/generate' && req.method === 'POST') {
      const body = await readBody(req, 30 * 1024 * 1024);
      const opts = JSON.parse(body.toString('utf8'));
      const prompt = String(opts.prompt || '').trim();
      if (!prompt) return json(res, 400, { error: 'prompt empty' });
      if (!['omni', 'seedance'].includes(opts.model)) return json(res, 400, { error: 'bad model' });
      const refs = Array.isArray(opts.refs) ? opts.refs.slice(0, 9) : [];
      const reqDur = Number(opts.duration) || (opts.model === 'omni' ? 8 : 10);
      // фактическая длительность считается сразу — вызывающий видит её в ответе:
      // 4/6/8 → Veo (server11), 10 → Gencpu Free (server10, реальные 10с)
      const actualDur = opts.model === 'omni'
        ? omniDuration(reqDur)
        : ([5, 8, 10, 12, 15].includes(reqDur) ? reqDur : 10);
      const job = {
        id: 'j' + Date.now().toString(36) + rnd(4),
        model: opts.model,
        engine: opts.model === 'omni' ? (actualDur === 10 ? 'server7' : 'server11') : 'server2',
        targetModel: null,
        prompt,
        duration: actualDur,
        requestedDuration: actualDur !== reqDur ? reqDur : null,
        resolution: Number(opts.resolution) || (opts.model === 'omni' ? 720 : 480),
        ratio: opts.ratio || '16:9',
        audio: opts.audio !== false,
        refs,
        status: 'pending',
        stage: 'new',
        progress: 0,
        error: null,
        key: caller.key,
        keyLabel: caller.name,
        targetJobId: null,
        videoFile: null,
        createdAt: Date.now(),
        finishedAt: null,
      };
      jobs[job.id] = job;
      saveJobs();
      runJob(job).catch(() => {});
      return json(res, 200, { job: publicJob(job) });
    }

    const jobMatch = p.match(/^\/api\/jobs\/([a-z0-9]+)$/i);
    if (jobMatch && req.method === 'GET') {
      const job = jobs[jobMatch[1]];
      if (!job || (!seesAll && job.key !== caller.key)) return json(res, 404, { error: 'not found' });
      return json(res, 200, { job: publicJob(job) });
    }

    const vidMatch = p.match(/^\/api\/videos\/([a-z0-9]+)\.mp4$/i);
    if (vidMatch && req.method === 'GET') {
      const job = jobs[vidMatch[1]];
      if (!job || (!seesAll && job.key !== caller.key)) { res.writeHead(404); res.end('no video'); return; }
      return serveVideo(req, res, vidMatch[1]);
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown api' });
    return serveStatic(res, p);
  } catch (e) {
    // headers may already be on their way (video stream) — never crash the process
    if (res.headersSent) { try { res.destroy(); } catch (err) {} return; }
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

process.on('uncaughtException', (err) => {
  console.error('uncaught (kept alive):', err && err.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection (kept alive):', err && err.message || err);
});

let usedFallback = false;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && !usedFallback) {
    usedFallback = true;
    console.log('port ' + PORT + ' занят — поднимаюсь на 8090');
    server.listen(8090);
    return;
  }
  throw err;
});

server.listen(PORT, () => {
  const addr = server.address();
  console.log('video-site up: http://localhost:' + addr.port + ' -> ' + TARGET);
});
