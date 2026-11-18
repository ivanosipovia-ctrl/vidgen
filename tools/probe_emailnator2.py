import re, urllib.request

url = "https://emailnator.com/_next/static/chunks/28v7k4j_0q9ek.js"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
js = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")

for needle in ["/api/generate-email", "/api/message-list", "/api/generate-bulk-email", "turnstile", "captcha", "recaptcha"]:
    print("=" * 30, needle)
    start = 0
    hits = 0
    while True:
        i = js.find(needle, start)
        if i < 0 or hits >= 3:
            break
        print(js[max(0, i - 700):i + 700])
        print("-" * 60)
        start = i + 1
        hits += 1
