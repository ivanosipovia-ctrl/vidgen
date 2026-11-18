import json
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def post(url, payload, extra_headers=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json", **UA}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


def get(url, extra_headers=None):
    headers = dict(UA)
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


print("== emailnator generate ==")
st, body = post("https://emailnator.com/api/generate-email", {"ids": [1, 3]})
print(st, body[:800])
try:
    data = json.loads(body)
except Exception:
    data = None

email = None
if isinstance(data, dict):
    for k, v in data.items():
        if isinstance(v, list) and v and isinstance(v[0], str) and "@" in v[0]:
            email = v[0]
        if isinstance(v, str) and "@" in v:
            email = v
print("EMAIL:", email)

if email:
    print("== register ==")
    import random, string
    uname = "nx" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    pwd = "Qw!" + "".join(random.choices(string.ascii_letters + string.digits, k=12))
    st, body = post(
        "http://160.30.161.35/api/auth/register",
        {"username": uname, "email": email, "password": pwd, "refCode": ""},
        {"X-GenCPU-Client": "web", "Origin": "http://160.30.161.35", "Referer": "http://160.30.161.35/"},
    )
    print(st, body[:1200])
    token = None
    try:
        d = json.loads(body)
        token = (d.get("user") or {}).get("webToken") or (d.get("user") or {}).get("apiKey")
        print("TOKEN:", (token or "")[:24], "...")
        print("USER:", json.dumps(d.get("user"), ensure_ascii=False)[:1500])
    except Exception as e:
        print("parse err", e)

    if token:
        print("== state ==")
        st, body = get(
            "http://160.30.161.35/api/state",
            {"X-GenCPU-Client": "web", "Authorization": "Bearer " + token, "X-Api-Key": token},
        )
        print(st, body[:3000])
