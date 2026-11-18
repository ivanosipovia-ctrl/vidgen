// video-site backend — no dependencies, Node 18+
// flow per generation: emailnator address -> fresh account on target -> batch -> poll -> download mp4
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
    resolution: j.resolution,
    ratio: j.ratio,
    audio: j.audio,
    status: j.status,
    stage: j.stage,
    error: j.error,
    progress: j.progress,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt || null,
    account: j.account || null,
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
const OMNI_DURATION_MAP = { 4: 4, 6: 6, 8: 8, 10: 8 }; // veo cluster caps at 8s: 10 -> 8

function buildBatchPayload(opts) {
  const prompt = String(opts.prompt || '').trim();
  const imageAssetIds = opts.imageAssetIds || [];

  if (opts.model === 'omni') {
    const duration = OMNI_DURATION_MAP[Number(opts.duration)] || 8;
    const ratio = ['16:9', '9:16', 'auto'].includes(opts.ratio) ? opts.ratio : '16:9';
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
    job.engine = built.engine;
    job.targetModel = built.targetModel;
    job.duration = built.duration;

    job.stage = 'submitting';
    job.progress = 15;
    saveJobs();

    const r = await targetPost('/api/batches', built.payload, acc.token);
    if (!r.data || !r.data.ok) {
      throw new Error('target rejected batch: ' + (r.text || '').slice(0, 500));
    }
    const first = (r.data.jobs || [])[0];
    if (!first || !first.id) throw new Error('no job id returned: ' + (r.text || '').slice(0, 400));
    job.targetJobId = first.id;
    job.stage = 'queued';
    job.progress = 20;
    saveJobs();

    // poll
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
      msg += ' — источник требует активный пакет на аккаунте для Seedance. Omni Flash (Veo) бесплатный.';
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
    if (p === '/api/jobs' && req.method === 'GET') {
      const list = Object.values(jobs)
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
      const job = {
        id: 'j' + Date.now().toString(36) + rnd(4),
        model: opts.model,
        engine: opts.model === 'omni' ? 'server11' : 'server2',
        targetModel: null,
        prompt,
        duration: Number(opts.duration) || (opts.model === 'omni' ? 8 : 10),
        resolution: Number(opts.resolution) || (opts.model === 'omni' ? 720 : 480),
        ratio: opts.ratio || '16:9',
        audio: opts.audio !== false,
        refs,
        status: 'pending',
        stage: 'new',
        progress: 0,
        error: null,
        account: null,
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
      if (!job) return json(res, 404, { error: 'not found' });
      return json(res, 200, { job: publicJob(job) });
    }

    const vidMatch = p.match(/^\/api\/videos\/([a-z0-9]+)\.mp4$/i);
    if (vidMatch && req.method === 'GET') return serveVideo(req, res, vidMatch[1]);

    if (p === '/api/config' && req.method === 'GET') {
      return json(res, 200, { target: TARGET });
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
