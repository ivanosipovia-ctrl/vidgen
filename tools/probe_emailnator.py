import re, urllib.request

BASE = "https://emailnator.com"
chunks = [
    "/_next/static/chunks/2mmpezlrfmbu5.js",
    "/_next/static/chunks/3odwqsnjc--hl.js",
    "/_next/static/chunks/2e_lrwr-bf1eq.js",
    "/_next/static/chunks/turbopack-2q3lgn448e_ke.js",
    "/_next/static/chunks/3fntmmi971322.js",
    "/_next/static/chunks/07tdxsienjck5.js",
    "/_next/static/chunks/3w0x5u6xd5lcu.js",
    "/_next/static/chunks/28v7k4j_0q9ek.js",
    "/_next/static/chunks/0cz1d0mv5g_q7.js",
    "/_next/static/chunks/0jvhpaew_uadu.js",
]

pat = re.compile(r'["\'](/[a-zA-Z0-9_\-/]{2,60})["\']')
hint = re.compile(r'message|gmail|inbox|email|generat|captcha|turnstile|address', re.I)

found = {}
for c in chunks:
    try:
        req = urllib.request.Request(BASE + c, headers={"User-Agent": "Mozilla/5.0"})
        js = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
    except Exception as e:
        print("ERR", c, e)
        continue
    for m in pat.finditer(js):
        p = m.group(1)
        if hint.search(p):
            found.setdefault(p, c)

for p, c in sorted(found.items()):
    print(p, "<-", c)
