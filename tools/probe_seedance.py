import json
import random
import string
import sys
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


def fresh_account():
    st, body = post("https://emailnator.com/api/generate-email", {"ids": [1, 2, 3, 8]})
    email = json.loads(body).get("email")
    uname = "sx" + "".join(random.choices(string.ascii_lowercase + string.digits, k=9))
    pwd = "Wq7!" + "".join(random.choices(string.ascii_letters + string.digits, k=14))
    st, body = post(
        TARGET + "/api/auth/register",
        {"username": uname, "email": email, "password": pwd, "refCode": ""},
        {"X-GenCPU-Client": "web", "Origin": TARGET, "Referer": TARGET + "/"},
    )
    d = json.loads(body)
    token = (d.get("user") or {}).get("webToken")
    print("account:", uname, "token:", bool(token))
    return token


def base_payload():
    return {
        "useSeedanceHub": False,
        "useServer3": False, "useServer4": False, "useServer5": False, "useServer6": False,
        "useServer7": False, "useServer8": False, "useServer9": False, "useServer10": False,
        "useServer11": False, "useServer12": False, "useServer13": False, "useServer14": False,
        "useSv9Fallback": False,
        "op": "t2v",
        "i2vMode": "by-name",
        "i2vSlotType": "start",
        "imageAssetIds": [],
        "refVidAssetIds": [],
        "refAudioAssetIds": [],
        "audio": True,
        "autoSanitizeVpcs": True,
        "prompts": ["A red sports car drifting through a neon city at night, cinematic"],
    }


def try_batch(label, overrides):
    print("=" * 20, label)
    token = fresh_account()
    payload = {**base_payload(), **overrides}
    st, body = post(TARGET + "/api/batches", payload, {
        "X-GenCPU-Client": "web",
        "Authorization": "Bearer " + token,
        "X-Api-Key": token,
    })
    print(st, body[:900])
    try:
        d = json.loads(body)
        if d.get("jobs"):
            print("JOB_ID:", d["jobs"][0].get("id"))
    except Exception:
        pass


# server2 + Standard
try_batch("server2 standard", {
    "model": "Seedance 2.0 Standard",
    "serverEngine": "server2",
    "useSeedanceHub": True,
    "engine": "seedancehub",
    "cookieSource": "seedancehub",
    "duration": 10,
    "resolution": 480,
    "ratio": "16:9",
})

# server2 + Lite (the "free-ish" model)
try_batch("server2 lite", {
    "model": "Seedance 2.0 Lite",
    "serverEngine": "server2",
    "useSeedanceHub": True,
    "engine": "seedancehub",
    "cookieSource": "seedancehub",
    "duration": 10,
    "resolution": 480,
    "ratio": "16:9",
})

# server3 hourly cluster
try_batch("server3 hourly", {
    "model": "Seedance 2.0",
    "serverEngine": "server3",
    "useServer3": True,
    "engine": "server3",
    "cookieSource": "server3",
    "duration": 15,
    "resolution": 480,
    "ratio": "16:9",
})
