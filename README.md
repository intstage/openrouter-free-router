# openrouter-free-router

**One OpenAI-compatible endpoint that always answers with the best *free* OpenRouter model that is available right now.**
It finds new free models by itself every day, checks that each one can actually call tools, and (optionally) keeps
DeepSeek Harness model lists in sync — so an agent can just use the model `auto`.

[Русская версия ниже](#по-русски)

```
your agent / app ──► http://127.0.0.1:11500/v1  model: "auto"
                         │  picks the top-3 healthy free models
                         ▼
                    openrouter.ai  ("models": [a, b, c] → first free one answers)
                         │  all three busy (429)? → cool them down 10 min, try the next three
```

## Why

OpenRouter has a rotating set of free (`:free`) models. They are great for agents, but:

- new ones appear and old ones disappear every week, and most apps have a fixed model list;
- the generic `openrouter/free` router may land on a tiny model that cannot call tools;
- a single free model is often rate-limited (429) exactly when you need it.

free-router fixes all three with ~500 lines of Node.js and no dependencies.

## What it does

- **Daily catalog refresh** (and on demand): takes `GET /api/v1/models` and keeps models that are free, support `tools`,
  take and return text, and have at least 128k context.
- **Probe**: every new model gets one request asking it to call a `get_weather` tool. It passes only if it returns a valid
  tool call. Failed models are skipped for 14 days; busy ones are retried next time. At most 5 probes per refresh.
- **Ranking**: your `favorites.txt` first, then bigger models (by `550b`-style size in the id), then newer.
- **`auto` model**: each request is sent with OpenRouter's `models` fallback list (max 3, an OpenRouter limit).
  If all three are rate-limited, they cool down for 10 minutes and the next three are tried (up to 3 rounds).
  When the account-wide daily cap is hit, it fails fast until midnight UTC instead of hammering every model.
- **Any model id** also works and is passed through as is. Streaming is supported.
- **DeepSeek Harness**: with `FR_DSH_PATCHES` it writes a `free-auto` provider (model `auto` + every working free model)
  into `cordis.patch.yml`, replacing only that block.
- Notifications about new models on macOS (`FR_NOTIFY=mac`). Request log: `state/requests.jsonl`.

## Quick start

```bash
git clone https://github.com/intstage/openrouter-free-router && cd openrouter-free-router
mkdir -p ~/.config/free-router && cp examples/openrouter.env.example ~/.config/free-router/openrouter.env
chmod 600 ~/.config/free-router/openrouter.env   # put your key there
FR_KEY_FILE=~/.config/free-router/openrouter.env node free-router.mjs --sync   # first catalog + probes
FR_KEY_FILE=~/.config/free-router/openrouter.env node free-router.mjs          # run the endpoint
```

```bash
curl -s http://127.0.0.1:11500/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}]}'
```

Point any OpenAI-compatible client at `http://127.0.0.1:11500/v1` with model `auto` (the API key it sends is ignored).
Run it as a service with `examples/free-router.service` (Linux) or `examples/com.example.free-router.plist` (macOS).

### DeepSeek Harness

1. Set `FR_DSH_PATCHES` to your profile's `cordis.patch.yml` (e.g. `~/.dsh/profiles/desktop/cordis.patch.yml`) and
   `FR_DSH_API_KEY_ENV=FREE_ROUTER_KEY`.
2. Give DSH a dummy key for that provider: add `FREE_ROUTER_KEY=local` to `~/.dsh/.env`.
   The real OpenRouter key stays with free-router only.
3. After the first refresh, pick **Auto: best available free model** in DSH (restart DSH if it does not show up).

The built-in OpenRouter catalog of DSH is fixed per version; DSH's "fetch models" only *suggests* models — what is used
is whatever `cordis.patch.yml` says. That is why free-router edits that file. See `examples/dsh-free-auto.yml`.

## Endpoints

| | |
|---|---|
| `POST /v1/chat/completions` | `model: "auto"` or any OpenRouter id |
| `GET /v1/models` | `auto` + working free models |
| `GET /status` | catalog age, models in use, cooling models, daily-limit state |
| `POST /sync` | refresh the catalog now (handy for a menu-bar button) |

It listens on `127.0.0.1` only by default. It has no authentication of its own — do not expose it to a network.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `FR_KEY_FILE` | — | file with `OPENROUTER_API_KEY=…` (re-read on change); or set `OPENROUTER_API_KEY` |
| `FR_HOST` / `FR_PORT` | `127.0.0.1` / `11500` | |
| `FR_STATE_DIR` | `./state` | state, request log, optional `favorites.txt` override |
| `FR_DSH_PATCHES` | — | `:`-separated `cordis.patch.yml` files to keep in sync |
| `FR_DSH_API_KEY_ENV` | — | env var name DSH resolves for this provider |
| `FR_NOTIFY` | `none` | `mac` for macOS notifications |
| `FR_SYNC_HOURS` | `24` | catalog refresh period |
| `FR_COOLDOWN_MIN` | `10` | how long a rate-limited model is skipped |
| `FR_MAX_BATCHES` | `3` | rounds of 3 models per request |
| `FR_HTTPS_PROXY` | — | `http://host:port` proxy to reach openrouter.ai |

## Things to know

- **Privacy**: free OpenRouter endpoints may log and train on your prompts (you must allow that in
  *Settings → Privacy* for most of them to work). Do not send secrets or personal data.
- **Limits** (as of Nov 2026): about 20 requests/min and 50 requests/day for free models per account; 1000/day after
  a one-time $10 top-up. An agent spends one request per step, so 50/day is only a handful of tasks.
- **Spend protection**: give your OpenRouter key a tiny credit limit (e.g. $0.01). Free models cost $0 and keep working;
  a paid model by mistake cannot spend anything.
- Probes spend requests too (≤5 per refresh).

## Tests

```bash
npm test     # node --test, no network
```

---

## По-русски

**Один адрес в формате OpenAI, который всегда отвечает лучшей из свободных сейчас бесплатных моделей OpenRouter.**
Сам раз в сутки находит новые бесплатные модели, проверяет, что каждая умеет вызывать инструменты, и при желании
записывает их в настройки DeepSeek Harness. Агенту остаётся выбрать модель `auto`.

**Как работает.** Берёт список моделей OpenRouter и оставляет бесплатные, с инструментами, текстом и контекстом от 128k.
Каждую новую проверяет одним запросом: модель должна вызвать инструмент `get_weather`. Порядок: ваш `favorites.txt`,
потом крупнее, потом новее. На запрос с моделью `auto` отправляет в OpenRouter тройку лучших (больше трёх OpenRouter
не принимает), он берёт первую свободную. Если все три заняты (429), они «остывают» 10 минут, пробуется следующая тройка.
При дневном лимите сразу отвечает ошибкой до полуночи UTC.

**Запуск** — см. Quick start выше; ключ OpenRouter кладётся в файл с правами 600. Как служба — примеры в `examples/`.

**DeepSeek Harness.** Укажите `FR_DSH_PATCHES` (путь к `cordis.patch.yml` профиля) и `FR_DSH_API_KEY_ENV=FREE_ROUTER_KEY`,
добавьте `FREE_ROUTER_KEY=local` в `~/.dsh/.env` (фиктивный ключ — настоящий хранится только у free-router) и выберите в
DSH модель «Auto: best available free model». Встроенный каталог OpenRouter в DSH фиксирован в версии программы, поэтому
новые модели без такого скрипта сами не появляются.

**Важно.** Бесплатные модели могут обучаться на ваших запросах — личное и секреты не отправляйте. Лимит — около 50
запросов в сутки на аккаунт (агент тратит запрос на каждый шаг), после разового пополнения на 10 $ — 1000. Поставьте
ключу OpenRouter лимит расходов, например 0,01 $: бесплатные модели работают, платная по ошибке ничего не потратит.
Сервер слушает только `127.0.0.1` и своей авторизации не имеет — не открывайте его в сеть.

## License

MIT
