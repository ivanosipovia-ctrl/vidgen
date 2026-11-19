# VidGen — Omni Flash + Seedance 2 Pro

Сайт для генерации видео. Промпт, референсы, длительность, качество, соотношение сторон — те же окна, что на источнике, но запуск идёт через наш бэкенд.

## Как работает

Всё идёт через реальный API генерации:

1. бэкенд авторизуется в API источника (`http://160.30.161.35`)
2. если загружены референсы — они заливаются как картинки-референсы
3. отправляется команда генерации (та же, что жмёт кнопку Generate на источнике)
4. бэкенд поллит статус, ждёт `done`
5. видео скачивается к нам в `data/videos/` и отдаётся с нашего сайта

## Запуск

```
START.bat
```

или

```
node server.js
```

Откроется на `http://localhost:8080` (если порт занят — автоматически `8090`).
Порт и адрес источника переопределяются через `PORT` и `TARGET_URL`.

## Два режима (левая колонка)

- **🎥 Omni Flash** — движок `🎥 Veo 3 Free` (`server11`), модель `Veo 3.1 Fast`
  - длительность 4/6/8/10 сек → 10 автоматически режется до 8 (предел Veo)
  - 720p, 16:9 / 9:16 / auto
- **⚡ Seedance 2 Pro** — движок `⚡ Seedance 2.0 24/7` (`server2`)
  - модель: Standard (по умолчанию) / Fast / Lite
  - длительность 5/8/10/12/15 сек, 480p/720p

## API-ключи (для внешних приложений)

Раздел **🔑 API-ключи** в интерфейсе: создание, копирование, отзыв ключей.

Все `/api/*` маршруты (кроме `GET /api/config`) требуют ключ в заголовке
`X-Api-Key` или `Authorization: Bearer vg_...`. Для видео, которое тянет
`<video>`/скачивание, ключ передаётся в URL: `?key=vg_...`.

```bash
curl -H "X-Api-Key: vg_ваш_ключ" https://vidgen.onrender.com/api/jobs
```

### Управление ключами (нужен web-ключ)

- `GET /api/keys` → `{keys:[{key, id, name, createdAt, lastUsedAt}]}`
- `POST /api/keys` body `{"name":"мой бот"}` → `{key, name}` — ключ показывается **один раз**
- `DELETE /api/keys/:key` → `{ok:true}` — отзыв, web-ключ удалить нельзя

### Где хранятся ключи и что с ними бывает при рестарте

`data/keys.json` — обычный файл, переживает перезапуск процесса
(`node server.js`, `START.bat`).

На хостинге с эфемерным диском (Render free) файл стирается при каждом
редеплое. Чтобы web-ключ сайта не менялся, задайте переменную окружения
`WEB_KEY` (пример в `render.yaml`) — сервер подставит именно его.

Браузер чинится сам, без ручных действий:

- при ответе `401` фронт один раз перечитывает `/api/config` без кэша,
  сохраняет новый ключ и повторяет запрос уже с ним
- если ключ сменился, у всех `<video>` переписывается `?key=` в `src`
- если `/api/config` не ответил (холодный старт), используется ключ
  из `localStorage`, а не пустой

### POST /api/generate

```json
{
  "model": "omni",
  "targetModel": "Veo 3.1 Fast",
  "prompt": "лисёнок бежит по снежному лесу, кинематографично",
  "duration": 8,
  "resolution": 720,
  "ratio": "16:9",
  "audio": true,
  "refs": [
    { "filename": "face.png",
      "contentType": "image/png",
      "dataBase64": "data:image/png;base64,iVBORw0KGgo..." }
  ]
}
```

| поле | значения | что делает |
|---|---|---|
| `model` | `omni` \| `seedance` | выбор движка, обязателен |
| `targetModel` | см. таблицу ниже | конкретная модель |
| `prompt` | строка | обязателен, пустой → `400 prompt empty` |
| `duration` | omni: `4/6/8/10`, seedance: `5/8/10/12/15` | секунды |
| `resolution` | omni: только `720`, seedance: `480` \| `720` | качество |
| `ratio` | omni: `16:9` `9:16` `auto`; seedance: `16:9` `9:16` `1:1` `3:4` `4:3` `21:9` `auto` | кадр |
| `audio` | `true`/`false` (по умолчанию `true`) | звук |
| `refs` | до 9 штук | фото-референсы, есть → режим `i2v` |

**`targetModel` — точные значения:**

| `model` | допустимые `targetModel` | по умолчанию |
|---|---|---|
| `omni` | `Veo 3.1 Fast`, `Veo 3.2 Fast`, `Veo 3.1 Lite` | `Veo 3.1 Fast` |
| `seedance` | `Seedance 2.0 Standard`, `Seedance 2.0 Fast`, `Seedance 2.0 Lite` | `Seedance 2.0 Standard` |

Неизвестное значение молча заменяется на модель по умолчанию (ошибка не будет).
Длительность omni `10` автоматически режется до `8` — предел Veo.
Невалидный `duration`/`ratio` тоже заменяются на безопасный дефолт.

**Фото-референсы:** `refs` — массив до 9 объектов.
`dataBase64` — строка вида `data:<mime>;base64,<данные>` (то, что возвращает
`FileReader.readAsDataURL`), `filename` и `contentType` — любые.
Первая картинка считается кадром/персонажом. Если `refs` пустой или не
передан — генерация текст-в-видео (`t2v`), с картинками — `i2v`.

**Ответ:**

```json
{ "job": {
    "id": "jmwmjo3nz2639",        // <- id задачи, дальше опрашивать его
    "status": "pending",
    "stage": "new",
    "progress": 0,
    "keyLabel": "web",
    "hasVideo": false,
    "error": null,
    "createdAt": 1795031937935,
    "finishedAt": null } }
```

Ошибка на входе → `400 {"error":"prompt empty"}` или `400 {"error":"bad model"}`,
нет ключа → `401 {"error":"API-ключ не передан или недействителен (X-Api-Key)"}`.

### GET /api/jobs и GET /api/jobs/{id}

`GET /api/jobs` → `{"jobs":[ ... ]}` (новые сверху),
`GET /api/jobs/{id}` → `{"job": ...}`; нет такой или она не вашего ключа → `404 {"error":"not found"}`.

Поля задачи:

- **`id`** — идентификатор, он же имя файла: `/api/videos/{id}.mp4`
- **`status`** — итог: `pending`, любое промежуточное состояние источника
  (`queued`, `running`, `processing`...), `done` (видео скачано и лежит у нас)
  или `error`
- **`stage`** — что происходит прямо сейчас:

  | stage | текст в интерфейсе |
  |---|---|
  | `new` | очередь |
  | `account` | соединяемся с API |
  | `account_ready` | API подключён |
  | `upload_refs` | загружаем референсы |
  | `submitting` | отправляем генерацию |
  | `queued` / `pending_queue` | в очереди на источнике |
  | `running` | рендерим видео |
  | `target_done` | видео готово — скачиваем к нам |
  | `downloading` | скачиваем готовое видео |
  | `done` | готово |
  | `error` | ошибка |

- **`progress`** — 0…100
- **`error`** — текст ошибки, `null` пока всё хорошо
- **`hasVideo`** — `true` только когда mp4 реально лежит на диске.
  **Считать готовым можно только `status === "done" && hasVideo === true`** —
  статус `done` без `hasVideo` означает, что файл ещё доезжает
- **`keyLabel`** — имя ключа, создавшего задачу

`status: "done"` без `hasVideo` — промежуточное состояние, продолжайте опрашивать
(фронт делает это каждые 2.5 с).

### GET /api/videos/{id}.mp4

Отдаёт mp4 с поддержкой `Range`: `206 Partial Content` на `Range: bytes=...`,
`200` без него. Ключ — в заголовке или в `?key=`.

### Пример на curl

```bash
K="vg_ваш_ключ"
ID=$(curl -s -H "X-Api-Key: $K" -H "Content-Type: application/json" \
  -d '{"model":"omni","targetModel":"Veo 3.1 Fast","prompt":"a fox running","duration":8}' \
  https://vidgen.onrender.com/api/generate | jq -r .job.id)

while true; do
  S=$(curl -s -H "X-Api-Key: $K" https://vidgen.onrender.com/api/jobs/$ID)
  echo "$S" | jq -r '"\(.status) \(.stage) \(.progress)% \(.error // "")"'
  [ "$(echo "$S" | jq -r '.job.status')" = "done" ] && break
  sleep 5
done

curl -H "X-Api-Key: $K" -o out.mp4 https://vidgen.onrender.com/api/videos/$ID.mp4
```

### Ограничения

- одновременно у одного ключа рекомендуется одна активная задача
- прерванная рестартом сервера задача получает `status:"error"` с текстом
  «сервер был перезапущен во время генерации — запустите заново»
- на бесплатном тарифе хостинга сайт засыпает: первый запрос после простоя
  идёт 40–60 секунд

## Файлы

- `server.js` — бэкенд без зависимостей (node 18+, `fetch` из коробки)
- `public/` — интерфейс (промпт, референсы, настройки, история с плеером, API-ключи)
- `data/videos/` — скачанные mp4
- `data/jobs.json` — история запусков
- `data/keys.json` — API-ключи
- `tools/` — разведочные скрипты (квоты источника, живые тесты)

## Лимиты источника (проверено живьём)

- Veo 3 Free: **5/день** — путь Omni Flash
- Seedance 2.0 24/7: нужен активный тариф (135K / 265K / подписка), иначе API вернёт ошибку — текст покажем в интерфейсе. Тариф подставляется через файл `data/paid-token.txt` (`wtok_...`) или переменную окружения `PAID_TOKEN`.
- Gencpu Free (server10): 2/день — не используется
