import json
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://localhost:8090"


def post(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


print("config:", get(BASE + "/api/config"))
job = post(BASE + "/api/generate", {
    "model": "omni",
    "targetModel": "Veo 3.1 Fast",
    "prompt": "A red fox running through snowy forest, cinematic drone shot, golden hour",
    "duration": 10,
    "resolution": 720,
    "ratio": "16:9",
    "audio": True,
    "refs": [],
})
print("created:", json.dumps(job, ensure_ascii=False)[:400])
jid = job["job"]["id"]

deadline = time.time() + 15 * 60
last = None
while time.time() < deadline:
    time.sleep(5)
    j = get(BASE + "/api/jobs/" + jid)["job"]
    sig = (j["status"], j["stage"], j["error"])
    if sig != last:
        last = sig
        print("state:", json.dumps({k: j.get(k) for k in ("status", "stage", "progress", "account", "error", "hasVideo")}, ensure_ascii=False))
    if j["status"] in ("done", "error") and (j.get("hasVideo") or j["status"] == "error"):
        break

if j["status"] == "done":
    with urllib.request.urlopen(BASE + "/api/videos/" + jid + ".mp4", timeout=60) as r:
        data = r.read()
    print("video bytes:", len(data), "head:", data[:12])
    open("video-site/tools/site_sample.mp4", "wb").write(data)
    print("saved video-site/tools/site_sample.mp4")

print("jobs list:", json.dumps(get(BASE + "/api/jobs")["jobs"][:2], ensure_ascii=False)[:600])
