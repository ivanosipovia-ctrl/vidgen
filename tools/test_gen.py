import json
import random
import string
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TARGET = "http://160.30.161.35"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def post(url, payload, headers=None):
    h = {"Content-Type": "application/json", "Accept": "application/json", **UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


def get(url, headers=None):
    h = dict(UA)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# 1. fresh email
st, body = post("https://emailnator.com/api/generate-email", {"ids": [1, 2, 3, 8]})
ed = json.loads(body)
email = ed.get("email")
print("email:", email)

# 2. register
uname = "nx" + "".join(random.choices(string.ascii_lowercase + string.digits, k=9))
pwd = "Zq9!" + "".join(random.choices(string.ascii_letters + string.digits, k=14))
st, body = post(
    TARGET + "/api/auth/register",
    {"username": uname, "email": email, "password": pwd, "refCode": ""},
    {"X-GenCPU-Client": "web", "Origin": TARGET, "Referer": TARGET + "/"},
)
d = json.loads(body)
token = (d.get("user") or {}).get("webToken")
print("register:", st, "user:", (d.get("user") or {}).get("id"), "token:", bool(token))

AUTH = {"X-GenCPU-Client": "web", "Authorization": "Bearer " + token, "X-Api-Key": token}

# 3. full state dump
st, raw = get(TARGET + "/api/state", AUTH)
state = raw.decode("utf-8", "ignore")
open("video-site/tools/state.json", "w", encoding="utf-8").write(state)
sd = json.loads(state)
u = sd.get("user", {})
keys = [k for k in u if any(s in k.lower() for s in ("sv9", "sv10", "sv11", "sv12", "gift", "balance", "wallet", "gencpu"))]
print("== user quota fields ==")
for k in sorted(keys):
    print(" ", k, "=", json.dumps(u[k], ensure_ascii=False)[:300])

settings = sd.get("settings", {})
print("== settings keys ==", list(settings.keys()))
for ck in ("server11Config", "server9Config", "seedanceHubConfig", "server10Config"):
    if ck in settings:
        print(ck, "=", json.dumps(settings[ck], ensure_ascii=False)[:800])

# 4. try a Veo 3 Free batch (server11)
payload = {
    "model": "Veo 3.1 Fast",
    "serverEngine": "server11",
    "useSeedanceHub": False,
    "useServer3": False, "useServer4": False, "useServer5": False, "useServer6": False,
    "useServer7": False, "useServer8": False, "useServer9": False, "useServer10": False,
    "useServer11": True, "useServer12": False, "useServer13": False, "useServer14": False,
    "useSv9Fallback": False,
    "engine": "server11",
    "cookieSource": "server11",
    "op": "t2v",
    "i2vMode": "by-name",
    "i2vSlotType": "start",
    "imageAssetIds": [],
    "refVidAssetIds": [],
    "refAudioAssetIds": [],
    "duration": 8,
    "resolution": 720,
    "ratio": "16:9",
    "audio": True,
    "autoSanitizeVpcs": True,
    "prompts": ["A golden retriever puppy surfing a small wave at sunset, cinematic, warm light"],
}
st, body = post(TARGET + "/api/batches", payload, AUTH)
print("== batch server11 ==", st, body[:1500])
try:
    bd = json.loads(body)
except Exception:
    bd = {}
job_id = None
if bd.get("jobs"):
    job_id = bd["jobs"][0].get("id")
print("job:", job_id)

# 5. poll
if job_id:
    deadline = time.time() + 12 * 60
    last = None
    while time.time() < deadline:
        st, raw = get(TARGET + "/api/state", AUTH)
        try:
            sd = json.loads(raw.decode("utf-8", "ignore"))
        except Exception:
            time.sleep(5)
            continue
        jobs = sd.get("myJobs") or sd.get("jobs") or []
        job = next((j for j in jobs if j.get("id") == job_id), None)
        if job:
            sig = (job.get("status"), job.get("error"), job.get("progress"))
            if sig != last:
                last = sig
                print("status:", json.dumps({k: job.get(k) for k in ("status", "error", "progress", "stage", "videoUrl", "r2Url")}, ensure_ascii=False))
            if job.get("status") in ("done", "completed", "error", "failed", "canceled"):
                break
        time.sleep(5)

    # 6. download
    st, raw = get(TARGET + f"/api/v1/media/{job_id}.mp4?download=1", AUTH)
    print("media http:", st, "bytes:", len(raw), "ctype-ish:", raw[:12])
    if st == 200 and len(raw) > 10000:
        out = f"video-site/tools/sample_{job_id}.mp4"
        open(out, "wb").write(raw)
        print("saved:", out)
