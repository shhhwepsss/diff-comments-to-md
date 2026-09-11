# local-review: два режима (GitHub PR + локальная папка) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить `tools/local-review` в тулу с двумя экранами одного сервера — обзор GitHub PR через `gh` и обзор локальной папки, выбираемой в UI, — с общим кодом диффа, комментариев и экспорта.

**Architecture:** Всё, «на что мы смотрим», описывается дескриптором, который едет плоскими query-параметрами в каждом запросе; сервер не хранит текущий выбор как мутируемое состояние. Дескриптор разворачивается фабриками в источник диффа (`lib/sources/*`) и в путь к файлу комментариев (`lib/stores/factory.js`). Работа идёт в два этапа: **сначала** чистый рефакторинг (вынос общего кода из `public/app.js`, разбор `review.js` на модули) при неизменном поведении, **потом** новая функциональность.

**Tech Stack:** Node.js 20+, только встроенные модули (`node:http`, `node:fs`, `node:path`, `node:child_process`, `node:os`, `node:crypto`). Фронт — vanilla HTML/CSS/JS, подключение обычными `<script>`-тегами. GitHub — только подпроцесс `gh` (проверено на `gh 2.96.0`).

**Spec:** `docs/superpowers/specs/2026-09-05-local-review-two-modes-design.md`

---

## Global Constraints

Действуют для каждой задачи ниже, повторять в требованиях каждой задачи не нужно — они подразумеваются всегда.

- **Ноль npm-зависимостей.** В `package.json` нет и не появляется `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`. Никаких бандлеров, транспайлеров, фреймворков, тест-раннеров.
- **Фронт подключается обычными `<script src>`-тегами** в `public/index.html`, глобальные функции, никаких ES-модулей/`import`/сборки.
- **Доступ к GitHub — только подпроцессом `gh`.** Ни одного `fetch`/`https.request` к `api.github.com` или любому другому внешнему хосту в коде тулы. Токен GitHub в коде тулы не читается и не хранится.
- **Тула не выполняет git-команд на запись.** Разрешены только `git diff`, `git rev-parse`, `git ls-files`, `git merge-base`, `git status` (последний — только в smoke). Единственная запись в чужой репозиторий — строка `.local-review/` в `.gitignore` (спек, раздел 7, пункт 7).
- **Сервер слушает `127.0.0.1`** (`review.js:30`), кросс-сайтовые запросы отклоняются по `Origin` / `Sec-Fetch-Site`.
- **Node 20+**, `'use strict'` в каждом `.js`, `require('node:...')` для встроенных модулей — как в существующем коде.
- **Язык интерфейса и сообщений об ошибках — русский**, как в существующем коде. Комментарии в коде — английские там, где они уже английские (`lib/*.js`), русские в местах, где уже русские (`public/app.js:533-536`).
- **После каждой задачи, меняющей код, обязателен прогон** `node tools/local-review/smoke.js` с результатом «все проверки зелёные» и кодом выхода 0. Базовая линия на момент написания плана — **65/65**. Ни одна существующая проверка не должна упасть ни на одном шаге; число проверок растёт только там, где задача явно добавляет новые.

### Базовая линия (проверено перед написанием плана)

```
$ node tools/local-review/smoke.js
65/65 проверок прошло
все проверки зелёные
```

```
$ gh --version
gh version 2.96.0 (2026-07-02)
```

`gh search prs --json` — доступные поля: `assignees, author, authorAssociation, body, closedAt, commentsCount, createdAt, id, isDraft, isLocked, isPullRequest, labels, number, repository, state, title, updatedAt, url`. **`headRefName` отсутствует** — это и есть причина расхождения из спека 1.5.
`gh pr list --json` — поля включают `headRefName`, `baseRefName`, `number`, `title`, `author`, `state`, `isDraft`, `updatedAt`, `url`.

---

## Карта файлов

### Существующие, которые меняются

| Файл | Что с ним происходит |
| --- | --- |
| `tools/local-review/review.js` (458 стр.) | худеет до процессных забот: флаги, статика, `listen`, открытие браузера, `.gitignore`. Роуты уезжают в `lib/routes/*`, HTTP-хелперы — в `lib/http.js` |
| `tools/local-review/lib/store.js` | конструктор `CommentStore(repoRoot)` → `CommentStore(filePath)` (`lib/store.js:11-14`). **Ломающее изменение**, задача 5 |
| `tools/local-review/lib/export.js` | `writeMarkdownFile` начинает получать каталог назначения от вызывающего (сам код не меняется, меняется вызов) |
| `tools/local-review/lib/diff.js` | **не меняется вообще.** `parsePatch` (`lib/diff.js:102`) переиспользуется PR-источником как есть |
| `tools/local-review/lib/git.js` | не меняется |
| `tools/local-review/public/app.js` (786 стр.) | распадается на `api.js` + `diff-view.js` + `screen-local.js` + `screen-pr.js` + сам `app.js` (роутер, шапка, переключение экранов) |
| `tools/local-review/public/index.html` | новые `<script>`-теги, разметка двух экранов, вторая модалка |
| `tools/local-review/public/styles.css` | стили экранов выбора папки и поиска PR, `.status.C` |
| `tools/local-review/smoke.js` (461 стр.) | расширяется: фикстуры `gh`, проверки девяти инвариантов |
| `tools/local-review/README.md` | два режима, `gh`, новые эндпоинты, исправление `README.md:86-87` |
| `package.json` | не меняется (инвариант 7) |

### Создаются

| Файл | Ответственность |
| --- | --- |
| `tools/local-review/lib/http.js` | `sendJson`, `sendText`, `readBody`, `readJsonBody`, `serveStatic`, `checkOrigin` |
| `tools/local-review/lib/descriptor.js` | разбор дескриптора из query, валидация, ключ |
| `tools/local-review/lib/config.js` | домашний конфиг `~/.local-review`: пути, `state.json`, недавние, счёт PR-файлов |
| `tools/local-review/lib/browse.js` | обзор каталогов, валидация корня |
| `tools/local-review/lib/gh.js` | единственное место вызова `gh`, классификация ошибок |
| `tools/local-review/lib/pr-search.js` | поиск PR-ов и разрешение метаданных PR-а |
| `tools/local-review/lib/sources/local-source.js` | локальный источник (обёртка над `lib/diff.js`) |
| `tools/local-review/lib/sources/pr-source.js` | PR-источник: разбор `gh pr diff` на файлы |
| `tools/local-review/lib/sources/factory.js` | дескриптор → источник |
| `tools/local-review/lib/stores/factory.js` | дескриптор → путь к файлу комментариев |
| `tools/local-review/lib/routes/state.js` | `/api/state`, `/api/diff` |
| `tools/local-review/lib/routes/comments.js` | `/api/comments*` |
| `tools/local-review/lib/routes/export.js` | `/api/export/*` |
| `tools/local-review/lib/routes/browse.js` | `/api/browse`, `/api/local/validate` |
| `tools/local-review/lib/routes/session.js` | `/api/session` GET/POST |
| `tools/local-review/lib/routes/gh.js` | `/api/gh/status`, `/api/pr/search`, `/api/pr/resolve` |
| `tools/local-review/lib/routes/index.js` | таблица маршрутов и диспетчер |
| `tools/local-review/public/api.js` | `api()`, `toast()`, `qs()` |
| `tools/local-review/public/diff-view.js` | список файлов, рендер диффа, карточки комментариев, редактор, протяжка, экспорт |
| `tools/local-review/public/screen-local.js` | выбор папки, недавние, модалка подъёма к корню, переключатель режимов |
| `tools/local-review/public/screen-pr.js` | статус `gh`, форма поиска, список результатов, шапка PR-а |
| `tools/local-review/smoke-fixtures/gh-fixture.js` | подставной `gh` для smoke (запускается через `LOCAL_REVIEW_GH_BIN`) |

### Порядок подключения скриптов (итоговый, задача 17)

```html
<script src="/api.js"></script>
<script src="/diff-view.js"></script>
<script src="/screen-local.js"></script>
<script src="/screen-pr.js"></script>
<script src="/app.js"></script>
```

`app.js` объявляет `const el` и `const state` и загружается последним; остальные файлы только объявляют функции и обращаются к `state`/`el` в момент вызова, а первый вызов происходит из `boot()` внизу `app.js`. Общая глобальная лексическая область у классических `<script>` одна, поэтому `const` из `app.js` виден в `diff-view.js`.

---

## Фазы

| Фаза | Задачи | Смысл |
| --- | --- | --- |
| A. Рефакторинг | 1-4 | поведение не меняется ни на байт, smoke остаётся 65/65 |
| B. Дескриптор и локальный режим | 5-11 | дескриптор, стораджи, конфиг, обзор папок, сессия, Origin |
| C. GitHub | 12-16 | фикстуры `gh`, `lib/gh.js`, поиск, PR-источник |
| D. Фронт | 17-19 | хеш-роутер и два экрана |
| E. Проверка и документация | 20-22 | девять инвариантов, README, живой прогон |

---

# ФАЗА A — РЕФАКТОРИНГ (поведение не меняется)

Задачи 1-4 не добавляют ни одной новой возможности и не меняют ни одного HTTP-ответа. Единственный критерий приёмки — smoke даёт ровно те же **65/65** и страница в браузере работает как раньше. Спек, раздел 4.2: «Порядок работ: сначала выделение, потом роутер».

---

### Task 1: Вынести `api()` и `toast()` в `public/api.js`

**Files:**
- Create: `tools/local-review/public/api.js`
- Modify: `tools/local-review/public/app.js:39-59` (вырезать), `tools/local-review/public/index.html:62` (добавить тег)
- Test: `tools/local-review/smoke.js` (не меняется, служит регрессом)

**Interfaces:**
- Consumes: ничего.
- Produces: глобальные `async function api(pathname, options)` (кидает `Error` с текстом из `payload.error`), `function toast(message, isError)`.

**Что должно остаться неизменным:** текст сообщений, тайминги тоста (5000 мс / 8000 мс при ошибке), поведение `api()` при не-JSON ответе (возвращает текст — это используется в `copyAll`, `app.js:648`).

- [ ] **Step 1: Создать `public/api.js` переносом кода один в один**

Из `public/app.js:39-59` (`api`) и `public/app.js:50-59` (`toast` + `toastTimer`). `toast()` сейчас обращается к `el.toast`, а `el` останется в `app.js` — чтобы не тащить `el` в этот файл, тост находит узел сам:

```js
'use strict';

// Fetch + toast: the two things every screen needs and nothing else does.

async function api(pathname, options) {
  const res = await fetch(pathname, options);
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = payload && payload.error ? payload.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

let toastTimer = null;
function toast(message, isError) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.toggle('error', Boolean(isError));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, isError ? 8000 : 5000);
}
```

- [ ] **Step 2: Убрать перенесённое из `app.js`**

Удалить `public/app.js:39-59` целиком (функции `api`, `toast`, переменная `toastTimer`) вместе с заголовком секции `// ---- utilities`. Строку `toast: document.getElementById('toast'),` в объекте `el` (`public/app.js:20`) удалить — на неё больше никто не ссылается.

- [ ] **Step 3: Подключить скрипт первым**

В `public/index.html` заменить строку 62 на:

```html
    <script src="/api.js"></script>
    <script src="/app.js"></script>
```

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `65/65 проверок прошло` и `все проверки зелёные`, код выхода 0.

- [ ] **Step 5: Проверить руками в браузере (минимальный контроль)**

Run: `node tools/local-review/review.js --no-open --port 4399`, открыть `http://127.0.0.1:4399/`, убедиться: дифф рисуется, в консоли браузера пусто, клик по номеру строки открывает редактор. Остановить сервер.

- [ ] **Step 6: Commit**

```bash
git add tools/local-review/public/api.js tools/local-review/public/app.js tools/local-review/public/index.html
git commit -m "refactor(local-review): extract api() and toast() into public/api.js"
```

---

### Task 2: Вынести общий код диффа и комментариев в `public/diff-view.js`

**Files:**
- Create: `tools/local-review/public/diff-view.js`
- Modify: `tools/local-review/public/app.js` (вырезать перечисленные ниже блоки), `tools/local-review/public/index.html` (тег между `api.js` и `app.js`)

**Interfaces:**
- Consumes: `api()`, `toast()` из задачи 1; глобальные `el` и `state`, объявленные в `app.js`.
- Produces: глобальные функции `anchorLabel(comment)`, `commentsFor(file)`, `renderFiles()`, `lineRow(line, filePath)`, `renderDiff()`, `commentCard(comment)`, `editorCard(target)`, `openEditor(target)`, `closeEditor()`, `startDrag(file, lineNumber, event)`, `extendDrag(event)`, `finishDrag()`, `cancelDrag()`, `paintRange(from, to)`, `refreshComments()`, `selectFile(file, orphan)`, `copyAll()`, `exportMd()`, константа `MAX_RENDERED_LINES`, объект `drag`.

**Что должно остаться неизменным:** ровно тот же DOM, те же имена классов (`.line`, `.num`, `.code`, `.comment`, `.editor`, `.hunk`, `.hunk-head`, `.comment-row`, `.selected`), те же горячие клавиши (`Ctrl+Enter`, `Esc`), тот же лимит `MAX_RENDERED_LINES = 20000`, тот же текст подсказок. Это перенос, а не переписывание: содержимое функций копируется дословно.

- [ ] **Step 1: Перенести блоки в `public/diff-view.js`**

Переносятся дословно, в этом порядке (номера строк — по текущему `public/app.js`):

| Что | Строки в `app.js` |
| --- | --- |
| `const MAX_RENDERED_LINES = 20000;` | 35 |
| `anchorLabel`, `commentsFor` | 61-71 |
| `renderFiles` | 94-141 |
| `lineRow`, `renderDiff` | 145-344 |
| `commentCard`, `editorCard`, `openEditor`, `closeEditor` | 348-530 |
| комментарий-шапка про выделение строк + `drag`, `paintRange`, `startDrag`, `extendDrag`, `finishDrag`, `cancelDrag` | 532-589 |
| `refreshComments` | 593-599 |
| `selectFile` | 627-645 |
| `copyAll`, `exportMd` | 647-682 |

Файл начинается с `'use strict';` и шапки:

```js
'use strict';

// Diff rendering, comment cards, the inline editor, line-number dragging and
// export. Shared verbatim by both screens: nothing here knows whether the diff
// came from a local repository or from a GitHub pull request.
```

- [ ] **Step 2: Убрать перенесённое из `app.js`**

В `app.js` остаются: объект `el` (`app.js:3-21` минус удалённая в задаче 1 строка `toast`), объект `state` (`app.js:23-33`), `renderTopbar` (75-90), `refreshState` (601-625), модалка (686-734), блок wiring (736-770) и `boot()` (772-786).

- [ ] **Step 3: Подключить скрипт**

В `public/index.html`, между `api.js` и `app.js`:

```html
    <script src="/api.js"></script>
    <script src="/diff-view.js"></script>
    <script src="/app.js"></script>
```

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `65/65 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 5: Проверить руками в браузере**

Run: `node tools/local-review/review.js --no-open --port 4399`. Проверить по очереди: клик по номеру строки → редактор; протяжка по номерам → диапазон подсвечивается и открывается редактор с `L<a>-L<b>`; `Shift`+клик расширяет; `Esc` во время протяжки отменяет; «+ комментарий к файлу»; `edit`/`delete` на карточке; «Скопировать всё»; «Сгенерировать .md». Консоль браузера — без ошибок.

- [ ] **Step 6: Commit**

```bash
git add tools/local-review/public/diff-view.js tools/local-review/public/app.js tools/local-review/public/index.html
git commit -m "refactor(local-review): extract shared diff/comment view into public/diff-view.js"
```

---

### Task 3: Вынести HTTP-хелперы в `lib/http.js`

**Files:**
- Create: `tools/local-review/lib/http.js`
- Modify: `tools/local-review/review.js:136-207` (вырезать), `tools/local-review/review.js:13` (`PUBLIC_DIR` переезжает), `tools/local-review/review.js:16-22` (`MIME` переезжает)

**Interfaces:**
- Consumes: ничего.
- Produces: `module.exports = { sendJson, sendText, readBody, readJsonBody, serveStatic, PUBLIC_DIR, MIME }` с теми же сигнатурами: `sendJson(res, status, body)`, `sendText(res, status, text, type)`, `readBody(req, limitBytes)`, `readJsonBody(req)`, `serveStatic(req, res, urlPath)`.

**Что должно остаться неизменным:** заголовки ответов (`content-type`, `content-length`, `cache-control: no-store`), лимит тела 2 МБ, поведение при выходе за `PUBLIC_DIR` (403), 404 при отсутствии файла, ошибка `Некорректный JSON в теле запроса` со `status = 400` и `userFacing = true`.

- [ ] **Step 1: Создать `lib/http.js` переносом**

Дословно переносятся `sendJson` (`review.js:136-144`), `sendText` (146-154), `readBody` (156-172), `readJsonBody` (174-185), `serveStatic` (187-207), а также `MIME` (16-22) и `PUBLIC_DIR`. `PUBLIC_DIR` внутри `lib/` вычисляется относительно себя:

```js
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
```

- [ ] **Step 2: Заменить в `review.js` определения на импорт**

```js
const { sendJson, sendText, readJsonBody, serveStatic } = require('./lib/http');
```

Удалить из `review.js` строки 13 (`PUBLIC_DIR`), 16-22 (`MIME`), 136-207. `require('node:fs')` в `review.js` остаётся — он нужен `ensureGitignore` (`review.js:118, 129`).

- [ ] **Step 3: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `65/65`, все зелёные. Особенно важны проверки статики — их в smoke нет, поэтому:

- [ ] **Step 4: Проверить отдачу статики**

Run: `node tools/local-review/review.js --no-open --port 4399`, затем в другом терминале:
```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:4399/
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4399/app.js
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4399/../package.json
```
Expected: `200 text/html; charset=utf-8`, `200`, `403` или `404` (наружу из `public/` не выпускает).

- [ ] **Step 5: Commit**

```bash
git add tools/local-review/lib/http.js tools/local-review/review.js
git commit -m "refactor(local-review): extract HTTP helpers into lib/http.js"
```

---

### Task 4: Разобрать `createApp` на `lib/routes/*` и посадить `review.js` на диету

**Files:**
- Create: `tools/local-review/lib/routes/index.js`, `tools/local-review/lib/routes/state.js`, `tools/local-review/lib/routes/comments.js`, `tools/local-review/lib/routes/export.js`
- Modify: `tools/local-review/review.js:209-357` (весь `createApp` заменяется вызовом диспетчера)

**Interfaces:**
- Consumes: `lib/http.js` (задача 3).
- Produces:
  - `lib/routes/index.js`: `createApp(ctx)` → `async function handle(req, res)`; внутренняя структура `ROUTES` — массив `{ method, match(pathname), handle(req, res, ctx, params) }`.
  - `lib/routes/state.js`: `module.exports = { getState, getDiff }`, обе — `async (req, res, ctx, url)`.
  - `lib/routes/comments.js`: `module.exports = { list, create, clearAll, updateOne, removeOne }`.
  - `lib/routes/export.js`: `module.exports = { exportText, exportFile }`.
  - `ctx` на этом шаге — ровно то, что сейчас приходит в `createApp` (`review.js:407`): `{ repoRoot, store, mode, base }`.

**Что должно остаться неизменным:** пути, методы, коды ответов и тела **всех** восьми существующих эндпоинтов. Список из `review.js:226-355`: `GET /api/state`, `GET /api/diff`, `GET /api/comments`, `POST /api/comments`, `POST /api/comments/clear-all`, `PUT|PATCH /api/comments/:id`, `DELETE /api/comments/:id`, `GET /api/export/text`, `POST /api/export/file`. Порядок проверок важен: `clear-all` проверяется **до** регулярки `/^\/api\/comments\/([^/]+)$/` (`review.js:299` перед `review.js:313`) — иначе `clear-all` уедет в `updateOne`. Сохранить. Так же сохранить 405 на не-GET к статике (`review.js:217-219`) и 404-заглушку `Нет такого эндпоинта: METHOD PATH` (`review.js:355`).

- [ ] **Step 1: Создать `lib/routes/state.js`**

Тела функций — дословный перенос `review.js:226-270`.

```js
'use strict';

const { listFiles, fileDiff } = require('../diff');
const { sendJson } = require('../http');

const MODES = new Set(['working', 'staged', 'base']);

async function getState(req, res, ctx, url) { /* review.js:227-255 as-is */ }
async function getDiff(req, res, ctx, url) { /* review.js:260-269 as-is */ }

module.exports = { getState, getDiff, MODES };
```

`MODES` теперь живёт здесь; в `review.js` он остаётся тоже — там он нужен для валидации `--mode` в `parseArgs` (`review.js:81`). Чтобы не было двух источников правды, `review.js` импортирует его: `const { MODES } = require('./lib/routes/state');`.

- [ ] **Step 2: Создать `lib/routes/comments.js`**

Дословный перенос `review.js:273-335`, разложенный по пяти функциям. `updateOne(req, res, ctx, url, id)` и `removeOne(req, res, ctx, url, id)` принимают `id` шестым параметром — его извлекает диспетчер.

- [ ] **Step 3: Создать `lib/routes/export.js`**

Дословный перенос `review.js:338-353`.

- [ ] **Step 4: Создать `lib/routes/index.js` с таблицей маршрутов**

```js
'use strict';

const { sendJson, sendText, serveStatic } = require('../http');
const state = require('./state');
const comments = require('./comments');
const exportRoutes = require('./export');

const ROUTES = [
  { method: 'GET',    path: '/api/state',              handle: state.getState },
  { method: 'GET',    path: '/api/diff',               handle: state.getDiff },
  { method: 'GET',    path: '/api/comments',           handle: comments.list },
  { method: 'POST',   path: '/api/comments',           handle: comments.create },
  // Must be matched before the /api/comments/:id pattern below.
  { method: 'POST',   path: '/api/comments/clear-all', handle: comments.clearAll },
  { method: 'GET',    path: '/api/export/text',        handle: exportRoutes.exportText },
  { method: 'POST',   path: '/api/export/file',        handle: exportRoutes.exportFile },
];

const COMMENT_ID = /^\/api\/comments\/([^/]+)$/;

function createApp(ctx) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed');
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    for (const route of ROUTES) {
      if (route.path === pathname && route.method === req.method) {
        await route.handle(req, res, ctx, url);
        return;
      }
    }

    const idMatch = COMMENT_ID.exec(pathname);
    if (idMatch) {
      const id = idMatch[1];
      if (req.method === 'PUT' || req.method === 'PATCH') {
        await comments.updateOne(req, res, ctx, url, id);
        return;
      }
      if (req.method === 'DELETE') {
        await comments.removeOne(req, res, ctx, url, id);
        return;
      }
    }

    sendJson(res, 404, { error: `Нет такого эндпоинта: ${req.method} ${pathname}` });
  };
}

module.exports = { createApp, ROUTES };
```

- [ ] **Step 5: Урезать `review.js`**

Удалить `review.js:209-357`. Добавить `const { createApp } = require('./lib/routes');`. Из `review.js` уходят импорты `listFiles`, `fileDiff` (`review.js:9`) и `renderMarkdown`, `writeMarkdownFile` (`review.js:11`) — остаётся `const { resolveRange } = require('./lib/diff');` (нужен для fail-early в `start`, `review.js:403`). Экспорт из `review.js` (строка 458) остаётся прежним по составу: `{ main, start, parseArgs, ensureGitignore, createApp }` — `createApp` реэкспортируется из `lib/routes`. Файл должен стать примерно 210-230 строк.

- [ ] **Step 6: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `65/65 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 7: Проверить порядок маршрутов отдельно**

Run: с поднятым сервером
```bash
curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:4399/api/comments/clear-all
```
Expected: `{"error":"Нужно подтверждение: {\"confirm\": true}","remaining":0}` — то есть запрос попал в `clearAll`, а не в `updateOne` (`Комментарий не найден`). Эту же проверку smoke уже делает на `smoke.js:331`.

- [ ] **Step 8: Commit**

```bash
git add tools/local-review/lib/routes tools/local-review/review.js
git commit -m "refactor(local-review): split inline route handlers into lib/routes/*"
```

---

# ФАЗА B — ДЕСКРИПТОР, СТОРАДЖИ, ЛОКАЛЬНЫЙ РЕЖИМ

---

### Task 5: `CommentStore(filePath)` и `lib/stores/factory.js` — ЛОМАЮЩЕЕ ИЗМЕНЕНИЕ

> ⚠ **Обратная совместимость ломается здесь.** Конструктор `CommentStore` меняется с `(repoRoot)` на `(filePath)` — `lib/store.js:11-14`. Спек, раздел 7, пункт 6.
>
> **Кто ломается и чем ловится:**
> - `review.js:406` (`new CommentStore(repoRoot)`) — правится в этой же задаче.
> - `review.js:446` (`started.store.all().length` в консольном выводе) — правится в этой же задаче.
> - Любой другой вызов — ловится грепом на шаге 1 (`grep -rn "new CommentStore" tools/`); он обязан вернуть ровно один результат до правки и ровно один после.
> - Ловится smoke целиком: 65 проверок гоняют сервер через `start()` (`smoke.js:151`, `smoke.js:351`, `smoke.js:374`, `smoke.js:414`, `smoke.js:443`), а не `CommentStore` напрямую (спек, 7.6: «должен пережить — но проверяется прогоном, а не предположением»). Конкретно упадут `smoke.js:346` (`.local-review/comments.json` существует), `smoke.js:348` (4 комментария в файле), `smoke.js:456` (в файле пусто), если путь посчитан неправильно.

**Files:**
- Modify: `tools/local-review/lib/store.js:10-17`
- Create: `tools/local-review/lib/stores/factory.js`
- Modify: `tools/local-review/review.js:406` и `review.js:446`

**Interfaces:**
- Consumes: ничего (`lib/config.js` появится в задаче 6; до тех пор PR-ветка фабрики берёт каталог из параметра).
- Produces:
  - `new CommentStore(filePath)` — абсолютный путь **к файлу**; `this.file = filePath`, `this.dir = path.dirname(filePath)`. Поля `repoRoot` больше нет.
  - `lib/stores/factory.js`: `commentsFilePath(descriptor, homeDir)` → абсолютный путь; `storeFor(descriptor, homeDir)` → новый `CommentStore`.
  - `sanitizeSegment(s)` → `s.replace(/[^A-Za-z0-9._-]/g, '_')` (спек 3.2).

**Что должно остаться неизменным:** методы `load/save/all/countsByFile/add/update/remove/clearAll` (`lib/store.js:19-105`) — ни строки. Формат файла `{version: 1, comments: []}`. Перенос битого файла в `*.broken-<ts>` (`lib/store.js:30`). Атомарная запись через `.tmp-<pid>` + `rename` (`lib/store.js:41-43`). Константы `STORE_DIR = '.local-review'`, `STORE_FILE = 'comments.json'` остаются экспортируемыми — на них смотрят `review.js:109`, `review.js:115`, `review.js:446-447`.

- [ ] **Step 1: Найти все вызовы конструктора**

Run: `grep -rn "new CommentStore" tools/ && grep -rn "\.repoRoot" tools/local-review/lib/`
Expected: единственный вызов — `review.js:406`; `store.repoRoot` нигде не читается.

- [ ] **Step 2: Поменять конструктор**

`lib/store.js:11-17` становится:

```js
  /**
   * Takes an absolute path to the JSON file. The store is a dumb JSON blob on
   * disk and deliberately knows nothing about local repos vs pull requests —
   * that mapping lives in lib/stores/factory.js and nowhere else.
   */
  constructor(filePath) {
    this.file = filePath;
    this.dir = path.dirname(filePath);
    this.data = { version: 1, comments: [] };
    this.load();
  }
```

- [ ] **Step 3: Создать `lib/stores/factory.js`**

```js
'use strict';

const path = require('node:path');
const { CommentStore, STORE_DIR, STORE_FILE } = require('../store');

/** Anything outside [A-Za-z0-9._-] becomes '_' so a PR key is a safe filename. */
function sanitizeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The single place where a descriptor becomes a path. Keeping it in one
 * function is what makes "stores never overlap" checkable instead of trusted.
 */
function commentsFilePath(descriptor, homeDir) {
  if (descriptor.source === 'local') {
    return path.join(descriptor.root, STORE_DIR, STORE_FILE);
  }
  if (descriptor.source === 'pr') {
    const name =
      [descriptor.host, descriptor.owner, descriptor.repo, descriptor.number]
        .map(sanitizeSegment)
        .join('__') + '.json';
    return path.join(homeDir, 'pr', name);
  }
  const err = new Error(`Неизвестный источник: ${descriptor.source}`);
  err.userFacing = true;
  err.status = 400;
  throw err;
}

/**
 * A fresh store per request: load() re-reads the file, so two browser tabs
 * (one on a local repo, one on a PR) never serve each other stale data.
 */
function storeFor(descriptor, homeDir) {
  return new CommentStore(commentsFilePath(descriptor, homeDir));
}

module.exports = { commentsFilePath, storeFor, sanitizeSegment };
```

- [ ] **Step 4: Поправить `review.js`**

`review.js:406`:
```js
  const store = new CommentStore(path.join(repoRoot, STORE_DIR, STORE_FILE));
```
Импорт в `review.js:10` дополняется `STORE_FILE`. `review.js:446` не меняется — `started.store.all()` работает как раньше.

- [ ] **Step 5: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `65/65 проверок прошло`, `все проверки зелёные`. Если упало на `.local-review/comments.json существует на диске` (`smoke.js:346`) — путь собран неверно, это и есть ловушка на ломающее изменение.

- [ ] **Step 6: Проверить санитайзер вручную**

Run:
```bash
node -e "const{commentsFilePath}=require('./tools/local-review/lib/stores/factory');console.log(commentsFilePath({source:'pr',host:'github.com',owner:'о/владелец',repo:'ре по',number:25},'C:/home/.local-review'))"
```
Expected: путь заканчивается на `pr\github.com_______________________25.json` — ни одного `/`, `\`, пробела или кириллицы в имени файла (кириллица заменена на `_` по одному символу).

- [ ] **Step 7: Commit**

```bash
git add tools/local-review/lib/store.js tools/local-review/lib/stores/factory.js tools/local-review/review.js
git commit -m "refactor(local-review)!: CommentStore takes a file path, add stores/factory"
```

---

### Task 6: Домашний конфиг `lib/config.js`

**Files:**
- Create: `tools/local-review/lib/config.js`
- Modify: `tools/local-review/review.js` (передать `homeDir` в контекст)

**Interfaces:**
- Consumes: `sanitizeSegment` не нужен — фабрика стораджей сама складывает путь.
- Produces:
```js
homeDir()                    // -> path, из process.env.LOCAL_REVIEW_HOME || os.homedir() + '/.local-review'
ensureHome()                 // mkdir -p homeDir(), homeDir()/pr, homeDir()/exports
statePath()                  // -> <home>/state.json
exportsDir()                 // -> <home>/exports
readState()                  // -> { last: descriptor|null, recent: [{ root, openedAt }] }
writeState(next)             // атомарная запись state.json
setLast(descriptor)          // мутирует и пишет state.json
addRecent(root)              // добавляет в начало, дедуп по пути, не длиннее 10
countStoredPrs()             // -> число .json-файлов в <home>/pr
```

**Что должно остаться неизменным:** ничего из существующего кода эта задача не трогает — только добавляет модуль и одно поле в контекст. `smoke` остаётся 65/65 без единой новой проверки на этом шаге.

**Почему `LOCAL_REVIEW_HOME`:** smoke обязан писать в свою временную папку, а не в настоящий `~/.local-review` пользователя. Переменная — точка подмены, ровно как `LOCAL_REVIEW_GH_BIN` для `gh`.

- [ ] **Step 1: Написать `lib/config.js`**

```js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR_NAME = '.local-review';
const RECENT_LIMIT = 10;

/** LOCAL_REVIEW_HOME lets the smoke test point the whole config elsewhere. */
function homeDir() {
  return process.env.LOCAL_REVIEW_HOME || path.join(os.homedir(), DIR_NAME);
}

function statePath() {
  return path.join(homeDir(), 'state.json');
}

function exportsDir() {
  return path.join(homeDir(), 'exports');
}

function ensureHome() {
  const home = homeDir();
  fs.mkdirSync(path.join(home, 'pr'), { recursive: true });
  fs.mkdirSync(path.join(home, 'exports'), { recursive: true });
  return home;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return {
      last: parsed && parsed.last ? parsed.last : null,
      recent: parsed && Array.isArray(parsed.recent) ? parsed.recent : [],
    };
  } catch {
    // A missing or corrupt state file is not an error: it just means "no memory".
    return { last: null, recent: [] };
  }
}

function writeState(next) {
  ensureHome();
  const tmp = `${statePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, statePath());
  return next;
}

function setLast(descriptor) {
  const state = readState();
  state.last = descriptor;
  return writeState(state);
}

function addRecent(root) {
  const state = readState();
  state.recent = [{ root, openedAt: new Date().toISOString() }]
    .concat(state.recent.filter((r) => r.root !== root))
    .slice(0, RECENT_LIMIT);
  return writeState(state);
}

function countStoredPrs() {
  try {
    return fs.readdirSync(path.join(homeDir(), 'pr')).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

module.exports = {
  homeDir, statePath, exportsDir, ensureHome,
  readState, writeState, setLast, addRecent, countStoredPrs,
  DIR_NAME, RECENT_LIMIT,
};
```

- [ ] **Step 2: Не вызывать `ensureHome()` при старте вслепую**

В `start()` (`review.js:391`) `ensureHome()` вызывается один раз, сразу после разбора опций, до `findRepoRoot`. Создание двух пустых каталогов в домашней папке — единственное, что тула делает вне выбранного репозитория, и делать это лениво в каждом хендлере хуже.

- [ ] **Step 3: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `65/65`, все зелёные.

- [ ] **Step 4: Убедиться, что настоящий `~/.local-review` не засоряется тестами**

Run:
```bash
LOCAL_REVIEW_HOME=/tmp/lr-home node -e "const c=require('./tools/local-review/lib/config');c.ensureHome();c.addRecent('C:/x');console.log(JSON.stringify(c.readState()))"
```
Expected: JSON с `recent[0].root === 'C:/x'`, файл лежит в `/tmp/lr-home/state.json`, а не в домашней папке.

- [ ] **Step 5: Commit**

```bash
git add tools/local-review/lib/config.js tools/local-review/review.js
git commit -m "feat(local-review): home config (~/.local-review) with state.json and recents"
```

---

### Task 7: Дескриптор, локальный источник и фабрика источников

**Files:**
- Create: `tools/local-review/lib/descriptor.js`, `tools/local-review/lib/sources/local-source.js`, `tools/local-review/lib/sources/factory.js`
- Modify: `tools/local-review/lib/routes/state.js`, `tools/local-review/lib/routes/comments.js`, `tools/local-review/lib/routes/export.js`, `tools/local-review/lib/routes/index.js`, `tools/local-review/review.js`
- Test: `tools/local-review/smoke.js` (+4 проверки)

**Interfaces:**
- Consumes: `storeFor` (задача 5), `homeDir` (задача 6), `listFiles`/`fileDiff` из `lib/diff.js:71,200`.
- Produces:
  - `lib/descriptor.js`: `parseDescriptor(url, defaults)` → дескриптор либо бросает `userFacing` 400; `descriptorKey(d)` → строка (`local:<root>:<mode>:<base>` / `pr:<host>/<owner>/<repo>#<number>`); `descriptorLabel(d)` → строка для UI.
  - `lib/sources/local-source.js`: `createLocalSource(descriptor)` → `{ id, kind: 'local', descriptor, async listFiles(options), async fileDiff(filePath, context, options), async meta() }`. Единый интерфейс на оба источника (спек 1.2): `options` и `meta()` локальному не нужны, но они есть, чтобы вызывающий код в `lib/routes/state.js` был один на оба случая.
  - `lib/sources/factory.js`: `createSource(descriptor)` → источник; на этом шаге знает только `local`, `pr` добавляется в задаче 16.
  - `ctx` меняется на `{ defaults, homeDir }`, где `defaults` — `{ source:'local', root, mode, base }` или `null`, если сервер стартовал вне репозитория.

**Ключевое требование совместимости:** когда в запросе нет ни одного параметра дескриптора, `parseDescriptor` возвращает `ctx.defaults`. Это ровно тот приём, которым сегодня работают `mode`/`base` (`review.js:227-228`, `review.js:261-262`). Благодаря ему все 65 существующих проверок smoke, которые ходят на `/api/state` и `/api/diff?file=…` без дескриптора, продолжают работать без единой правки.

**Что должно остаться неизменным:** форма ответа `/api/state` (`review.js:235-254`): поля `repoRoot`, `mode`, `base`, `rangeLabel`, `totalComments`, `files[{path, oldPath, status, kind, untracked, comments}]`, `orphanFiles`. Форма ответа `/api/diff` — `{...entry, hunks, binary, additions, deletions}`. Коды: 400 на неизвестный `mode` (`review.js:229-232`), 400 на отсутствующий `file` (`review.js:263-266`), 404 на файл вне диффа (`lib/diff.js:205-208`).

- [ ] **Step 1: Написать `lib/descriptor.js`**

```js
'use strict';

const MODES = new Set(['working', 'staged', 'base']);

function bad(message) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = 400;
  return err;
}

/**
 * A descriptor is the whole answer to "what are we looking at". It travels in
 * the query string of every request, including POST and DELETE, so there is
 * exactly one place it is read from and no mutable "current selection" on the
 * server that two browser tabs could fight over.
 */
function parseDescriptor(url, defaults) {
  const p = url.searchParams;
  const source = p.get('source');

  if (!source) {
    // No descriptor in the request -> CLI defaults, exactly like mode/base today.
    if (!defaults) throw bad('Не выбран источник: открой папку или PR.');
    const mode = p.get('mode') || defaults.mode;
    const base = p.get('base') || defaults.base;
    if (!MODES.has(mode)) throw bad(`Неизвестный режим: ${mode}`);
    return Object.assign({}, defaults, { mode, base });
  }

  if (source === 'local') {
    const root = p.get('root');
    if (!root) throw bad('Не передан параметр root');
    const mode = p.get('mode') || 'working';
    const base = p.get('base') || 'origin/main';
    if (!MODES.has(mode)) throw bad(`Неизвестный режим: ${mode}`);
    return { source: 'local', root, mode, base };
  }

  if (source === 'pr') {
    const host = p.get('host') || 'github.com';
    const owner = p.get('owner');
    const repo = p.get('repo');
    const number = Number(p.get('number'));
    if (!owner || !repo) throw bad('Для PR нужны owner и repo');
    if (!Number.isInteger(number) || number <= 0) throw bad('Некорректный номер PR');
    return { source: 'pr', host, owner, repo, number };
  }

  throw bad(`Неизвестный источник: ${source}`);
}

function descriptorKey(d) {
  return d.source === 'local'
    ? `local:${d.root}:${d.mode}:${d.base}`
    : `pr:${d.host}/${d.owner}/${d.repo}#${d.number}`;
}

function descriptorLabel(d) {
  return d.source === 'local' ? d.root : `${d.owner}/${d.repo}#${d.number}`;
}

module.exports = { parseDescriptor, descriptorKey, descriptorLabel, MODES };
```

- [ ] **Step 2: Написать `lib/sources/local-source.js`**

Тонкая обёртка, логика диффа не меняется (спек 1.3):

```js
'use strict';

const { listFiles, fileDiff } = require('../diff');
const { descriptorKey } = require('../descriptor');

function createLocalSource(descriptor) {
  const { root, mode, base } = descriptor;
  return {
    id: descriptorKey(descriptor),
    kind: 'local',
    descriptor,
    // Both sources take the same arguments; `options` (currently only {fresh})
    // is meaningless here because git is re-read on every call anyway.
    async listFiles(options) {
      return listFiles(root, mode, base); // -> { files, range }
    },
    async fileDiff(filePath, context, options) {
      return fileDiff(root, mode, base, filePath, context);
    },
    async meta() {
      return null; // no PR header on the local screen
    },
  };
}

module.exports = { createLocalSource };
```

- [ ] **Step 3: Написать `lib/sources/factory.js`**

```js
'use strict';

const { createLocalSource } = require('./local-source');

function createSource(descriptor) {
  if (descriptor.source === 'local') return createLocalSource(descriptor);
  const err = new Error(`Неизвестный источник: ${descriptor.source}`);
  err.userFacing = true;
  err.status = 400;
  throw err;
}

module.exports = { createSource };
```

- [ ] **Step 4: Перевести роуты на дескриптор**

В каждом хендлере первая строка — разбор дескриптора, вторая — получение стораджа:

```js
const descriptor = parseDescriptor(url, ctx.defaults);
const store = storeFor(descriptor, ctx.homeDir);
const source = createSource(descriptor);
```

В `getState` `repoRoot` в ответе для локального дескриптора остаётся `descriptor.root`; для PR оно появится в задаче 16 как `null` + отдельный блок `pr`. `rangeLabel` берётся из `range.label`, как сейчас (`review.js:239`).

- [ ] **Step 5: Собрать `defaults` в `review.js`**

```js
  const defaults = repoRoot
    ? { source: 'local', root: repoRoot, mode: options.mode, base: options.base }
    : null;
  const handler = createApp({ defaults, homeDir: config.homeDir() });
```

`start()` продолжает возвращать `{ server, port, repoRoot, store, gitignore }` — `smoke.js:151-159` и `smoke.js:414-419` читают `server.port` и `server.server`, а `review.js:446` — `started.store.all()`. Поле `store` собирается из `storeFor(defaults, homeDir)`, когда `defaults` есть, иначе `null`, и вывод в `review.js:446` печатается только при наличии.

- [ ] **Step 6: Добавить в smoke четыре проверки дескриптора**

Вставить после блока `// modes` (`smoke.js:397-411`):

```js
  // ---------------------------------------------------- дескриптор в query
  console.log('\nдескриптор источника');
  const byDescriptor = await call(
    `/api/state?source=local&root=${encodeURIComponent(repo)}&mode=working`
  );
  ok(byDescriptor.status === 200, 'явный локальный дескриптор -> 200');
  eq(
    byDescriptor.body.files.map((f) => f.path).sort(),
    (await call('/api/state')).body.files.map((f) => f.path).sort(),
    'явный дескриптор и дефолтный дают один и тот же список файлов'
  );
  const noRoot = await call('/api/state?source=local');
  ok(noRoot.status === 400, 'source=local без root -> 400');
  const badSource = await call('/api/state?source=svn');
  ok(badSource.status === 400, 'неизвестный source -> 400, а не 500');
```

- [ ] **Step 7: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `69/69 проверок прошло`, `все проверки зелёные`. Прежние 65 — все на месте.

- [ ] **Step 8: Commit**

```bash
git add tools/local-review/lib tools/local-review/review.js tools/local-review/smoke.js
git commit -m "feat(local-review): source descriptor in every request, local source behind a factory"
```

---

### Task 8: Каталог экспорта зависит от дескриптора

**Files:**
- Modify: `tools/local-review/lib/routes/export.js`
- Test: `tools/local-review/smoke.js` (+1 проверка)

**Interfaces:**
- Consumes: `exportsDir()` (задача 6), `parseDescriptor` (задача 7).
- Produces: ответ `POST /api/export/file` дополняется полем `dir` (абсолютный каталог, куда записано) — фронт показывает его в тосте.

**Что должно остаться неизменным:** `renderMarkdown` и `anchorOf` (`lib/export.js:12-36`) — ни строки; они уже не зависят от источника (спек 3.3). Имя файла `review-<YYYY-MM-DD-HHmm>.md` (`lib/export.js:49`). Для локального дескриптора каталог назначения — корень репозитория, как сейчас (`review.js:345`); это проверяет `smoke.js:298`.

- [ ] **Step 1: Выбирать каталог по дескриптору**

```js
const dir = descriptor.source === 'local' ? descriptor.root : config.exportsDir();
const written = writeMarkdownFile(dir, store.all(), undefined);
sendJson(res, 200, {
  file: written.name,
  path: written.path,
  dir,
  count: comments.length,
  remaining: store.all().length,
});
```

- [ ] **Step 2: Добавить проверку в smoke**

Рядом с блоком инварианта 1 (`smoke.js:296-301`):

```js
  ok(
    path.dirname(file1.body.path) === repo && file1.body.dir === repo,
    'в локальном режиме .md пишется в корень репозитория',
    file1.body.path
  );
```

- [ ] **Step 3: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `70/70 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 4: Commit**

```bash
git add tools/local-review/lib/routes/export.js tools/local-review/smoke.js
git commit -m "feat(local-review): export destination follows the descriptor"
```

---

### Task 9: Обзор каталогов `lib/browse.js` + `/api/browse` + `/api/local/validate`

**Files:**
- Create: `tools/local-review/lib/browse.js`, `tools/local-review/lib/routes/browse.js`
- Modify: `tools/local-review/lib/routes/index.js`
- Test: `tools/local-review/smoke.js` (+7 проверок, инвариант 8)

**Interfaces:**
- Consumes: `findRepoRoot` (`lib/git.js:60`), `readState` (задача 6).
- Produces:
  - `browse(requestedPath)` → `{ path, parent, separator, entries: [{ name, path, isRepo }] }`.
  - `startingPoints()` → `{ path: null, parent: null, separator, entries: [...] }` — домашний каталог пользователя плюс недавние (спек 2.3).
  - `validateRoot(requestedPath)` → `{ ok, repoRoot, sameAsRequested, error }` (спек 2.4).
  - `GET /api/browse?path=` и `GET /api/local/validate?root=`.

**Что должно остаться неизменным:** ни один существующий эндпоинт не трогается. Содержимое файлов не читается **никогда** (спек, инвариант 8): в `browse` только `fs.readdirSync(dir, { withFileTypes: true })` и `fs.existsSync(path.join(dir, name, '.git'))`, ни одного `readFile`.

- [ ] **Step 1: Написать `lib/browse.js`**

```js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findRepoRoot } = require('./git');
const { readState } = require('./config');

function isRepo(dir) {
  // Only the presence of .git directly inside. Never opens it.
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Directory names only. File contents are never read and files never appear in
 * the listing. `parent` is a hint for the ".." button — the server never climbs
 * on its own and never scans a default root.
 */
function browse(requestedPath) {
  const dir = path.resolve(requestedPath);
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const err = new Error(
      e.code === 'ENOENT' ? `Каталог не найден: ${dir}` : `Каталог недоступен: ${dir}`
    );
    err.userFacing = true;
    err.status = e.code === 'ENOENT' ? 404 : 403;
    throw err;
  }
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), isRepo: isRepo(path.join(dir, d.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    separator: path.sep,
    isRepo: isRepo(dir),
    entries,
  };
}

/** No `path` in the request -> home directory + recently opened repositories. */
function startingPoints() {
  const home = os.homedir();
  const recent = readState().recent.map((r) => ({
    name: path.basename(r.root),
    path: r.root,
    isRepo: isRepo(r.root),
    recent: true,
  }));
  return {
    path: null,
    parent: null,
    separator: path.sep,
    home,
    entries: [{ name: path.basename(home) || home, path: home, isRepo: isRepo(home) }].concat(recent),
  };
}

async function validateRoot(requestedPath) {
  const requested = path.resolve(requestedPath);
  const root = await findRepoRoot(requested);
  if (!root) {
    return {
      ok: false,
      repoRoot: null,
      sameAsRequested: false,
      error: `${requested} — не git-репозиторий.`,
    };
  }
  const same = path.resolve(root) === requested;
  return { ok: true, repoRoot: root, sameAsRequested: same, requested, error: null };
}

module.exports = { browse, startingPoints, validateRoot, isRepo };
```

- [ ] **Step 2: Написать `lib/routes/browse.js` и зарегистрировать маршруты**

`GET /api/browse` — если `path` не передан, отдаётся `startingPoints()`; иначе `browse(path)`.
`GET /api/local/validate` — `validateRoot(root)`, всегда 200 с телом `{ok:false, error}` при неудаче: экран выбора папки должен показать сообщение, а не поймать исключение.

Добавить в `ROUTES` (`lib/routes/index.js`):
```js
  { method: 'GET', path: '/api/browse',         handle: browseRoutes.browse },
  { method: 'GET', path: '/api/local/validate', handle: browseRoutes.validate },
```

- [ ] **Step 3: Добавить проверки в smoke (инвариант 8)**

```js
  // ------------------------------------- инвариант 8: обзор каталогов
  console.log('\nинвариант 8: обзор каталогов не отдаёт файлы и не лезет вверх');
  const browseRepo = await call('/api/browse?path=' + encodeURIComponent(repo));
  ok(browseRepo.status === 200, 'GET /api/browse -> 200');
  const names = browseRepo.body.entries.map((e) => e.name);
  ok(names.includes('src'), 'подкаталог src в выдаче', names.join(', '));
  ok(!names.includes('crlf.txt') && !names.includes('big.txt'),
    'файлы в выдачу не попадают', names.join(', '));
  ok(
    !JSON.stringify(browseRepo.body).includes('line 1') &&
      !JSON.stringify(browseRepo.body).includes('alpha'),
    'в ответе нет содержимого файлов'
  );
  eq(browseRepo.body.path, require('node:path').resolve(repo),
    'browse отдаёт ровно запрошенный каталог, а не родительский');
  const browseSrc = await call('/api/browse?path=' + encodeURIComponent(path.join(repo, 'src')));
  eq(browseSrc.body.entries.length, 0, 'в src нет подкаталогов -> пустой список');
  const browseMissing = await call('/api/browse?path=' + encodeURIComponent(path.join(repo, 'нет-такого')));
  ok(browseMissing.status === 404, 'несуществующий каталог -> 404 с текстом');
```

И проверки `validate`:

```js
  const vRoot = await call('/api/local/validate?root=' + encodeURIComponent(repo));
  ok(vRoot.body.ok === true && vRoot.body.sameAsRequested === true,
    'корень репозитория валиден и совпадает с запрошенным', JSON.stringify(vRoot.body));
  const vSub = await call('/api/local/validate?root=' + encodeURIComponent(path.join(repo, 'src')));
  ok(vSub.body.ok === true && vSub.body.sameAsRequested === false,
    'подкаталог -> ok, но sameAsRequested:false', JSON.stringify(vSub.body));
  const vNot = await call('/api/local/validate?root=' + encodeURIComponent(notRepo));
  ok(vNot.body.ok === false && /не git-репозиторий/i.test(vNot.body.error),
    'не-git каталог -> ok:false с читаемым текстом', JSON.stringify(vNot.body));
```

`notRepo` создаётся на `smoke.js:422`; блок с browse-проверками должен идти **после** этой строки.

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `80/80 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 5: Commit**

```bash
git add tools/local-review/lib/browse.js tools/local-review/lib/routes tools/local-review/smoke.js
git commit -m "feat(local-review): directory browsing and repo-root validation endpoints"
```

---

### Task 10: `/api/session` и запись `.gitignore` по подтверждению выбора

**Files:**
- Create: `tools/local-review/lib/routes/session.js`
- Modify: `tools/local-review/lib/routes/index.js`, `tools/local-review/review.js:112-134` (`ensureGitignore` экспортируется и переиспользуется)
- Test: `tools/local-review/smoke.js` (+5 проверок)

**Interfaces:**
- Consumes: `readState`, `setLast`, `addRecent`, `countStoredPrs`, `homeDir` (задача 6); `parseDescriptor` (задача 7); `ensureGitignore` (`review.js:113`).
- Produces:
  - `GET /api/session` → `{ last, recent, homeDir, storedPrs }`.
  - `POST /api/session` с телом `{ descriptor }` → `{ ok: true, last, recent, gitignore: { changed, error? } }`. Для локального дескриптора: пишет в `recent`, зовёт `ensureGitignore(descriptor.root)` и возвращает результат; для PR — только `setLast`.

**Что должно остаться неизменным:** `ensureGitignore` (`review.js:112-134`) — ни строки логики: те же три варианта уже-игнорируемого (`entry`, `STORE_DIR`, `/entry` — `review.js:123`), тот же выбор EOL (`review.js:126`), тот же префикс (`review.js:127`). Она по-прежнему вызывается при старте, когда есть `defaults` (`review.js:405`) — иначе упадёт `smoke.js:371` («.gitignore содержит .local-review/»). Спек 7.7: запись выполняется **только** при подтверждении выбора и **никогда** при `GET /api/browse`.

**Куда переехать `ensureGitignore`:** остаётся в `review.js` и экспортируется (уже экспортируется — `review.js:458`); `lib/routes/session.js` берёт её из `require('../../review')`. Циклический require здесь безопасен, потому что `session.js` вызывает её лениво внутри хендлера, а не на этапе загрузки модуля. Если при исполнении окажется, что цикл всё же мешает, `ensureGitignore` переносится в `lib/gitignore.js` и импортируется обеими сторонами — но только тогда, а не заранее.

- [ ] **Step 1: Написать `lib/routes/session.js`**

```js
'use strict';

const { sendJson, readJsonBody } = require('../http');
const config = require('../config');

async function get(req, res) {
  const state = config.readState();
  sendJson(res, 200, {
    last: state.last,
    recent: state.recent,
    homeDir: config.homeDir(),
    storedPrs: config.countStoredPrs(),
  });
}

async function post(req, res) {
  const body = await readJsonBody(req);
  const d = body.descriptor;
  if (!d || (d.source !== 'local' && d.source !== 'pr')) {
    sendJson(res, 400, { error: 'Нужен descriptor с source local|pr' });
    return;
  }
  let gitignore = { changed: false };
  if (d.source === 'local') {
    if (!d.root) {
      sendJson(res, 400, { error: 'Для локального источника нужен root' });
      return;
    }
    // The .gitignore line is written here and nowhere else during browsing:
    // only a confirmed folder selection touches the user's repository.
    gitignore = require('../../review').ensureGitignore(d.root);
    config.addRecent(d.root);
  }
  config.setLast(d);
  const state = config.readState();
  sendJson(res, 200, { ok: true, last: state.last, recent: state.recent, gitignore });
}

module.exports = { get, post };
```

- [ ] **Step 2: Зарегистрировать маршруты**

```js
  { method: 'GET',  path: '/api/session', handle: session.get },
  { method: 'POST', path: '/api/session', handle: session.post },
```

- [ ] **Step 3: Добавить проверки в smoke**

Перед этими проверками smoke должен выставить `process.env.LOCAL_REVIEW_HOME` в свою временную папку — сделать это первой строкой `main()` (`smoke.js:148`):

```js
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-home-'));
  process.env.LOCAL_REVIEW_HOME = home;
```

и удалять её рядом с остальными (`smoke.js:468-470`).

```js
  // ------------------------------------------------------------ сессия
  console.log('\nсессия и .gitignore по подтверждению');
  const sess0 = await call('/api/session');
  ok(sess0.status === 200 && sess0.body.homeDir === home,
    'GET /api/session отдаёт домашний конфиг', JSON.stringify(sess0.body));

  const gitignoreBeforeBrowse = fs.readFileSync(path.join(clean, '.gitignore'), 'utf8');
  await call('/api/browse?path=' + encodeURIComponent(clean));
  eq(
    fs.readFileSync(path.join(clean, '.gitignore'), 'utf8'),
    gitignoreBeforeBrowse,
    'обзор каталога НЕ пишет в .gitignore'
  );

  const noGitignoreRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-pick-'));
  git(['init', '-q', '-b', 'main'], noGitignoreRepo);
  const picked = await call('/api/session', json('POST', {
    descriptor: { source: 'local', root: noGitignoreRepo, mode: 'working', base: 'origin/main' },
  }));
  ok(picked.status === 200 && picked.body.gitignore.changed === true,
    'подтверждение выбора папки пишет .local-review/ в .gitignore', JSON.stringify(picked.body));
  ok(
    fs.readFileSync(path.join(noGitignoreRepo, '.gitignore'), 'utf8').includes('.local-review/'),
    'строка действительно в файле'
  );
  eq((await call('/api/session')).body.recent[0].root, noGitignoreRepo,
    'выбранная папка попала в недавние');
```

Удалить `noGitignoreRepo` в конце вместе с остальными временными каталогами.

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `85/85 проверок прошло`, `все проверки зелёные`. Проверка `smoke.js:371` («.gitignore содержит .local-review/» во временном репозитории) должна остаться зелёной — она подтверждает, что старт с `--cwd` по-прежнему пишет строку.

- [ ] **Step 5: Commit**

```bash
git add tools/local-review/lib/routes/session.js tools/local-review/lib/routes/index.js tools/local-review/smoke.js
git commit -m "feat(local-review): /api/session with recents and confirmed-selection .gitignore write"
```

---

### Task 11: Проверка происхождения запроса (`Origin` / `Sec-Fetch-Site`)

**Files:**
- Modify: `tools/local-review/lib/http.js` (добавить `checkOrigin`), `tools/local-review/lib/routes/index.js` (вызвать первой строкой диспетчера)
- Test: `tools/local-review/smoke.js` (+4 проверки)

**Interfaces:**
- Consumes: ничего.
- Produces: `checkOrigin(req)` → `null`, если запрос допустим, либо строка с причиной отказа.

**Правило (сформулировано так, чтобы не сломать существующий smoke):** отклоняем, только когда заголовок **присутствует и явно чужой**. `Sec-Fetch-Site: cross-site` или `same-site` → 403. `Origin`, не равный `http://<host>:<port>` или `http://127.0.0.1:<port>` / `http://localhost:<port>` → 403. Отсутствие обоих заголовков → пропускаем: `fetch` из Node (которым ходит `smoke.js:130`) их не шлёт, а браузер шлёт всегда.

**Что должно остаться неизменным:** все 85 проверок smoke — они ходят без `Origin` и не должны получить 403. Это и есть повод сформулировать правило именно так.

- [ ] **Step 1: Написать `checkOrigin`**

```js
/**
 * Second line of defence behind the 127.0.0.1 bind. Folder picking turns the
 * repository path into a client-supplied value, so a page on another origin
 * must not be able to make us list directories or write comment files.
 * Headers that are absent are fine: non-browser clients (curl, the smoke test)
 * send neither, browsers always send Sec-Fetch-Site.
 */
function checkOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return `Кросс-сайтовый запрос отклонён (Sec-Fetch-Site: ${site})`;
  }
  const origin = req.headers.origin;
  if (!origin) return null;
  const host = req.headers.host || '';
  const allowed = new Set([
    `http://${host}`,
    `http://127.0.0.1${host.includes(':') ? ':' + host.split(':')[1] : ''}`,
    `http://localhost${host.includes(':') ? ':' + host.split(':')[1] : ''}`,
  ]);
  if (!allowed.has(origin)) return `Кросс-сайтовый запрос отклонён (Origin: ${origin})`;
  return null;
}
```

- [ ] **Step 2: Вызвать в диспетчере**

Первой строкой `handle` в `lib/routes/index.js`, до разбора URL:

```js
    const originProblem = checkOrigin(req);
    if (originProblem) {
      sendJson(res, 403, { error: originProblem });
      return;
    }
```

- [ ] **Step 3: Добавить проверки в smoke**

```js
  // ------------------------------------------- Origin / Sec-Fetch-Site
  console.log('\nпроверка происхождения запроса');
  const crossSite = await call('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } });
  ok(crossSite.status === 403, 'Sec-Fetch-Site: cross-site -> 403', JSON.stringify(crossSite.body));
  const evilOrigin = await call('/api/state', { headers: { origin: 'http://evil.example' } });
  ok(evilOrigin.status === 403, 'чужой Origin -> 403', JSON.stringify(evilOrigin.body));
  const sameOrigin = await call('/api/state', {
    headers: { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${server.port}` },
  });
  ok(sameOrigin.status === 200, 'свой Origin + same-origin -> 200');
  const noHeaders = await call('/api/state');
  ok(noHeaders.status === 200, 'запрос без Origin и Sec-Fetch-Site пропускается');
```

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `89/89 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 5: Проверить, что браузер не сломался**

Run: `node tools/local-review/review.js --no-open --port 4399`, открыть страницу, убедиться, что дифф грузится (браузер шлёт `Sec-Fetch-Site: same-origin`) и в консоли нет 403.

- [ ] **Step 6: Commit**

```bash
git add tools/local-review/lib/http.js tools/local-review/lib/routes/index.js tools/local-review/smoke.js
git commit -m "feat(local-review): reject cross-site requests by Origin/Sec-Fetch-Site"
```

---

# ФАЗА C — GITHUB

---

### Task 12: Фикстурный `gh` для smoke (`LOCAL_REVIEW_GH_BIN`)

> Эта задача — **инфраструктура теста**, а не проверка продакшн-кода. Она добавляет подставной `gh` и самопроверку, что подстановка работает. Ни одна новая проверка ещё не смотрит на `lib/gh.js` (его нет), поэтому smoke остаётся зелёным. Все содержательные проверки навешиваются в задачах 13-16 и 20.

**Files:**
- Create: `tools/local-review/smoke-fixtures/gh-fixture.js`, `tools/local-review/smoke-fixtures/README.md` (три строки: что это и почему `.js`, а не `.cmd`)
- Modify: `tools/local-review/smoke.js` (генератор манифеста + самопроверка)

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `smoke-fixtures/gh-fixture.js` — исполняется как `node gh-fixture.js <argv...>`; читает манифест по пути из `LOCAL_REVIEW_GH_FIXTURES`, ищет ответ по сигнатуре `argv.join(' ')`, печатает `stdout`/`stderr`, выходит с указанным кодом.
  - В `smoke.js`: `function ghFixtures(manifest)` — пишет манифест во временный файл и выставляет `process.env.LOCAL_REVIEW_GH_BIN` / `LOCAL_REVIEW_GH_FIXTURES`; `function noGh()` — выставляет `LOCAL_REVIEW_GH_BIN` в несуществующий путь.

**Почему `.js`, а не `.cmd`/`.sh`:** Node 20 отказывается спавнить `.cmd`/`.bat` при `shell: false`, а `shell: true` в проде запрещён (аргументы с пробелами и кириллицей). Поэтому `lib/gh.js` (задача 13) распознаёт значение `LOCAL_REVIEW_GH_BIN`, оканчивающееся на `.js`/`.cjs`/`.mjs`, и запускает его текущим `process.execPath`. Одна переменная окружения, как в спеке 1.6, никакого shell, прод-путь (`gh`) остаётся честным подпроцессом.

**Что должно остаться неизменным:** реальная сеть в автотесте не используется ни разу (спек 6.1). Ни один существующий тест не должен начать зависеть от установленного `gh`.

- [ ] **Step 1: Написать `smoke-fixtures/gh-fixture.js`**

```js
#!/usr/bin/env node
'use strict';

// A stand-in for the gh CLI, driven by a JSON manifest. Used only by smoke.js:
// production always spawns the real `gh`.
//
// Manifest: { "<argv joined by spaces>": { "code": 0, "stdout": "...", "stderr": "..." } }
// The special key "*" is the fallback.

const fs = require('node:fs');

const argv = process.argv.slice(2);
const manifestPath = process.env.LOCAL_REVIEW_GH_FIXTURES;

let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  process.stderr.write(`gh-fixture: cannot read manifest ${manifestPath}: ${e.message}\n`);
  process.exit(99);
}

const key = argv.join(' ');
const hit = manifest[key] || manifest['*'];
if (!hit) {
  process.stderr.write(`gh-fixture: no fixture for: ${key}\n`);
  process.exit(98);
}
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code === undefined ? 0 : hit.code);
```

- [ ] **Step 2: Добавить в `smoke.js` управление фикстурами**

```js
const FIXTURE_GH = path.join(__dirname, 'smoke-fixtures', 'gh-fixture.js');

/** Points lib/gh.js at the fixture script and installs a manifest. */
function ghFixtures(manifest, dir) {
  const file = path.join(dir, `gh-manifest-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  process.env.LOCAL_REVIEW_GH_BIN = FIXTURE_GH;
  process.env.LOCAL_REVIEW_GH_FIXTURES = file;
  return file;
}

/** Simulates "gh is not installed" with a real ENOENT. */
function noGh() {
  process.env.LOCAL_REVIEW_GH_BIN = path.join(os.tmpdir(), 'definitely-no-gh-here-12345');
  delete process.env.LOCAL_REVIEW_GH_FIXTURES;
}
```

- [ ] **Step 3: Добавить самопроверку фикстуры**

```js
  console.log('\nфикстура gh');
  const manifestFile = ghFixtures({ 'auth status': { code: 0, stdout: 'ok\n' } }, home);
  const probe = spawnSync(process.execPath, [FIXTURE_GH, 'auth', 'status'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { LOCAL_REVIEW_GH_FIXTURES: manifestFile }),
  });
  ok(probe.status === 0 && probe.stdout === 'ok\n',
    'подставной gh отвечает по манифесту', JSON.stringify(probe.stdout));
  const missProbe = spawnSync(process.execPath, [FIXTURE_GH, 'nope'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { LOCAL_REVIEW_GH_FIXTURES: manifestFile }),
  });
  ok(missProbe.status === 98, 'незаписанный сценарий -> явная ошибка фикстуры, а не тишина');
```

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `91/91 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 5: Commit**

```bash
git add tools/local-review/smoke-fixtures tools/local-review/smoke.js
git commit -m "test(local-review): manifest-driven gh fixture for the smoke suite"
```

---

### Task 13: `lib/gh.js` и `/api/gh/status`

**Files:**
- Create: `tools/local-review/lib/gh.js`, `tools/local-review/lib/routes/gh.js`
- Modify: `tools/local-review/lib/routes/index.js`
- Test: `tools/local-review/smoke.js` (+6 проверок)

**Interfaces:**
- Consumes: фикстура из задачи 12.
- Produces:
```js
ghBin()                      // -> { bin, prefixArgs }
ghRaw(args)                  // -> { code, stdout: Buffer, stderr: Buffer, spawnError }
gh(args)                     // -> stdout string; бросает классифицированную ошибку
ghJson(args)                 // -> распарсенный JSON
classifyGhError(res, args)   // -> Error { message, userFacing:true, status, ghReason }
ghStatus()                   // -> { installed, authenticated, login, host, message }
```
`GET /api/gh/status` → тело `ghStatus()`, всегда со статусом 200: «`gh` не установлен» — это не ошибка HTTP, это состояние, которое рисует экран.

**Классификация (спек 1.6), точные тексты:**

| Признак | `ghReason` | Сообщение |
| --- | --- | --- |
| `spawn` → `ENOENT` | `not-installed` | ``gh не установлен. Установи GitHub CLI и выполни `gh auth login`.`` |
| код ≠ 0 и в stderr `auth` / `not logged` / `authentication` | `not-authenticated` | ``Ты не залогинен в gh. Выполни `gh auth login`.`` |
| stderr содержит `rate limit` | `rate-limit` | `Превышен лимит GitHub API. Подожди и повтори.` |
| stderr содержит `dial tcp` / `no such host` / `timeout` / `connection refused` | `network` | `Нет связи с GitHub.` |
| stderr содержит `HTTP 404` / `Could not resolve to a` / `not found` | `not-found` | `Репозиторий или PR не найден, либо нет доступа.` |
| прочее | `unknown` | первая непустая строка stderr, обрезанная до 300 символов |

Порядок проверок важен: `rate limit` до `auth`, потому что сообщение о лимите у GitHub иногда содержит слово `authenticated`.

**Что должно остаться неизменным:** ни один существующий эндпоинт. Ни одного `require('node:https')`/`fetch` в `lib/gh.js`.

- [ ] **Step 1: Написать `lib/gh.js`**

```js
'use strict';

const { spawn } = require('node:child_process');

const HTTP_STATUS = { 'not-installed': 503, 'not-authenticated': 401, 'rate-limit': 429,
  network: 502, 'not-found': 404, unknown: 502 };

/**
 * The only place in the tool that runs gh. Same shape as lib/git.js: an argv
 * array, shell:false, no string interpolation — paths and search queries carry
 * spaces and Cyrillic and must survive verbatim.
 *
 * LOCAL_REVIEW_GH_BIN is the substitution point for the smoke test. When it
 * names a .js file we run it with the current node binary, because Node 20
 * refuses to spawn .cmd/.bat without a shell and we never want a shell here.
 */
function ghBin() {
  const raw = process.env.LOCAL_REVIEW_GH_BIN || 'gh';
  if (/\.(c|m)?js$/i.test(raw)) return { bin: process.execPath, prefixArgs: [raw] };
  return { bin: raw, prefixArgs: [] };
}

function ghRaw(args) {
  const { bin, prefixArgs } = ghBin();
  return new Promise((resolve) => {
    const child = spawn(bin, prefixArgs.concat(args), {
      windowsHide: true,
      shell: false,
      env: Object.assign({}, process.env, { GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }),
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) =>
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), spawnError: e }));
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), spawnError: null }));
  });
}

function classifyGhError(res, args) {
  const stderr = res.stderr ? res.stderr.toString('utf8') : '';
  const lower = stderr.toLowerCase();
  let reason = 'unknown';
  let message = (stderr.split('\n').find((l) => l.trim()) || `gh ${args.join(' ')} -> ${res.code}`)
    .trim()
    .slice(0, 300);

  if (res.spawnError && res.spawnError.code === 'ENOENT') {
    reason = 'not-installed';
    message = 'gh не установлен. Установи GitHub CLI и выполни `gh auth login`.';
  } else if (lower.includes('rate limit')) {
    reason = 'rate-limit';
    message = 'Превышен лимит GitHub API. Подожди и повтори.';
  } else if (lower.includes('dial tcp') || lower.includes('no such host') ||
             lower.includes('timeout') || lower.includes('connection refused')) {
    reason = 'network';
    message = 'Нет связи с GitHub.';
  } else if (lower.includes('http 404') || lower.includes('could not resolve to a') ||
             lower.includes('not found')) {
    reason = 'not-found';
    message = 'Репозиторий или PR не найден, либо нет доступа.';
  } else if (lower.includes('not logged') || lower.includes('authentication') ||
             lower.includes('auth login') || lower.includes('gh auth')) {
    reason = 'not-authenticated';
    message = 'Ты не залогинен в gh. Выполни `gh auth login`.';
  }

  const err = new Error(message);
  err.userFacing = true;
  err.ghReason = reason;
  err.status = HTTP_STATUS[reason];
  return err;
}

async function gh(args) {
  const res = await ghRaw(args);
  if (res.spawnError || res.code !== 0) throw classifyGhError(res, args);
  return res.stdout.toString('utf8');
}

async function ghJson(args) {
  const text = await gh(args);
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('gh вернул не JSON — обнови GitHub CLI.');
    err.userFacing = true;
    err.status = 502;
    err.ghReason = 'unknown';
    throw err;
  }
}

/** Never throws: "gh is missing" is a screen state, not a request failure. */
async function ghStatus() {
  const res = await ghRaw(['auth', 'status']);
  if (res.spawnError && res.spawnError.code === 'ENOENT') {
    return { installed: false, authenticated: false, login: null, host: null,
      message: 'gh не установлен. Установи GitHub CLI и выполни `gh auth login`.' };
  }
  const text = `${res.stdout.toString('utf8')}\n${res.stderr.toString('utf8')}`;
  if (res.code !== 0) {
    return { installed: true, authenticated: false, login: null, host: null,
      message: classifyGhError(res, ['auth', 'status']).message };
  }
  const host = (/([\w.-]+)\s*$/m.exec((/Logged in to ([\w.-]+)/.exec(text) || [])[1] || '') || [])[1]
    || (/([\w.-]+)/.exec((/Logged in to ([\w.-]+)/.exec(text) || [])[1] || '') || [])[1] || 'github.com';
  const login = (/account (\S+)/.exec(text) || /as (\S+)/.exec(text) || [])[1] || null;
  return { installed: true, authenticated: true, login, host, message: null };
}

module.exports = { gh, ghJson, ghRaw, ghStatus, classifyGhError, ghBin };
```

- [ ] **Step 2: Написать `lib/routes/gh.js` со `status` и зарегистрировать маршрут**

```js
  { method: 'GET', path: '/api/gh/status', handle: ghRoutes.status },
```

`status` вызывает `ghStatus()` и отдаёт 200 всегда.

- [ ] **Step 3: Добавить проверки в smoke (это TDD-часть: сначала падает)**

```js
  console.log('\ngh: статус и классификация ошибок');
  ghFixtures({
    'auth status': { code: 0, stdout: 'github.com\n  ✓ Logged in to github.com account octocat\n' },
  }, home);
  const st1 = await call('/api/gh/status');
  ok(st1.status === 200 && st1.body.installed === true && st1.body.authenticated === true,
    'gh залогинен -> installed:true, authenticated:true', JSON.stringify(st1.body));

  ghFixtures({ 'auth status': { code: 1, stderr: 'You are not logged into any GitHub hosts. Run gh auth login\n' } }, home);
  const st2 = await call('/api/gh/status');
  ok(st2.status === 200 && st2.body.authenticated === false && /не залогинен/i.test(st2.body.message),
    'нет логина -> читаемое сообщение', JSON.stringify(st2.body));

  noGh();
  const st3 = await call('/api/gh/status');
  ok(st3.status === 200 && st3.body.installed === false && /не установлен/i.test(st3.body.message),
    'gh не установлен -> читаемое сообщение, а не ENOENT-стек', JSON.stringify(st3.body));
  ok(!/\n\s+at\s/.test(JSON.stringify(st3.body)), 'в ответе нет stack trace');
```

Плюс две прямые проверки классификатора:

```js
  const { classifyGhError } = require('./lib/gh');
  eq(classifyGhError({ code: 1, stderr: Buffer.from('API rate limit exceeded for user') }, []).ghReason,
    'rate-limit', 'rate limit классифицируется');
  eq(classifyGhError({ code: 1, stderr: Buffer.from('dial tcp: lookup api.github.com: no such host') }, []).ghReason,
    'network', 'сетевая ошибка классифицируется');
```

- [ ] **Step 4: Убедиться, что проверки падают до реализации**

Run: `node tools/local-review/smoke.js` (с закомментированной регистрацией маршрута)
Expected: FAIL на `gh залогинен -> installed:true` (404 вместо 200), ненулевой код выхода. Раскомментировать.

- [ ] **Step 5: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `97/97 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 6: Убедиться, что реальный `gh` не вызывался**

Run: `grep -n "api.github.com\|https\." tools/local-review/lib/*.js tools/local-review/lib/**/*.js`
Expected: ни одного совпадения.

- [ ] **Step 7: Commit**

```bash
git add tools/local-review/lib/gh.js tools/local-review/lib/routes tools/local-review/smoke.js
git commit -m "feat(local-review): gh subprocess wrapper with readable error classification"
```

---

### Task 14: Поиск PR-ов `lib/pr-search.js` + `/api/pr/search`

**Files:**
- Create: `tools/local-review/lib/pr-search.js`
- Modify: `tools/local-review/lib/routes/gh.js`, `tools/local-review/lib/routes/index.js`
- Test: `tools/local-review/smoke.js` (+6 проверок)

**Interfaces:**
- Consumes: `gh`, `ghJson` (задача 13).
- Produces: `searchPrs({ repo, q, state, limit })` → `{ mode: 'repo'|'global', items: [...] }`, где элемент:
```js
{ host, owner, repo, number, title, author, headRefName, baseRefName, state, isDraft, updatedAt, url }
```
`headRefName` и `baseRefName` — `null` в глобальном режиме (спек 1.5 и 7.4: `gh search prs` их не отдаёт, проверено на 2.96.0).

**Команды (спек 1.5, поля сверены с `gh 2.96.0`):**

| Репозиторий | argv |
| --- | --- |
| задан `o/r` | `pr list --repo o/r --search <q> --state <s> --limit <n> --json number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft` |
| пусто | `search prs --author=@me --state=<s> --limit <n> --json number,title,repository,author,state,updatedAt,url,isDraft` + `<q>` как позиционный аргумент, если непуст |

`state = merged`: у `gh pr list` — `--state merged`; у `gh search prs` — флаг `--merged` вместо `--state`. Расхождение целиком внутри `pr-search.js`. `state = all` → `--state all` / отсутствие флага состояния.

`owner`/`repo` в глобальном режиме достаются из `repository.nameWithOwner` (у `gh search prs` поле `repository` — объект с `name`, `nameWithOwner`). `host` в обоих режимах — `github.com`, пока не появится причина иначе.

**Что должно остаться неизменным:** ни один существующий эндпоинт; поиск не пишет ничего никуда.

- [ ] **Step 1: Написать `lib/pr-search.js`**

```js
'use strict';

const { ghJson } = require('./gh');

const STATES = new Set(['open', 'closed', 'merged', 'all']);

function normalizeState(state) {
  const s = state || 'open';
  if (!STATES.has(s)) {
    const err = new Error(`Неизвестное состояние: ${s} (open | closed | merged | all)`);
    err.userFacing = true;
    err.status = 400;
    throw err;
  }
  return s;
}

function splitRepo(repo) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(repo).trim());
  if (!m) {
    const err = new Error('Репозиторий указывается как owner/repo');
    err.userFacing = true;
    err.status = 400;
    throw err;
  }
  return { owner: m[1], repo: m[2] };
}

async function searchPrs({ repo, q, state, limit }) {
  const s = normalizeState(state);
  const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const query = (q || '').trim();

  if (repo) {
    const { owner, repo: name } = splitRepo(repo);
    const args = ['pr', 'list', '--repo', `${owner}/${name}`, '--limit', String(n),
      '--json', 'number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft'];
    if (query) args.push('--search', query);
    args.push('--state', s);
    const rows = await ghJson(args);
    return {
      mode: 'repo',
      items: rows.map((r) => ({
        host: 'github.com', owner, repo: name, number: r.number, title: r.title,
        author: r.author ? r.author.login : null,
        headRefName: r.headRefName || null, baseRefName: r.baseRefName || null,
        state: r.state, isDraft: Boolean(r.isDraft), updatedAt: r.updatedAt, url: r.url,
      })),
    };
  }

  // No repository: gh search prs. It has no headRefName in --json (gh 2.96.0),
  // so the branch stays null and is filled in when the PR is opened.
  const args = ['search', 'prs', '--author=@me', '--limit', String(n),
    '--json', 'number,title,repository,author,state,updatedAt,url,isDraft'];
  if (s === 'merged') args.push('--merged');
  else if (s !== 'all') args.push(`--state=${s}`);
  if (query) args.push(query);
  const rows = await ghJson(args);
  return {
    mode: 'global',
    items: rows.map((r) => {
      const full = (r.repository && r.repository.nameWithOwner) || '';
      const [owner, name] = full.split('/');
      return {
        host: 'github.com', owner: owner || null, repo: name || null, number: r.number,
        title: r.title, author: r.author ? r.author.login : null,
        headRefName: null, baseRefName: null,
        state: r.state, isDraft: Boolean(r.isDraft), updatedAt: r.updatedAt, url: r.url,
      };
    }),
  };
}

module.exports = { searchPrs, normalizeState, splitRepo };
```

- [ ] **Step 2: Зарегистрировать `/api/pr/search`**

```js
  { method: 'GET', path: '/api/pr/search', handle: ghRoutes.search },
```

Хендлер читает `repo`, `q`, `state`, `limit` из query, зовёт `searchPrs`, отдаёт `{ mode, items, storedPrs, homeDir }` — счётчик PR-файлов и путь конфига нужны экрану поиска (спек 3.2: «чтобы каталог не рос незаметно»).

- [ ] **Step 3: Добавить проверки в smoke**

```js
  console.log('\nпоиск PR-ов');
  const listKey = 'pr list --repo o/r --limit 30 --json number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft --state open';
  ghFixtures({
    [listKey]: { code: 0, stdout: JSON.stringify([
      { number: 25, title: 'Правка кириллицей', author: { login: 'octocat' },
        headRefName: 'feat/пробел и слеш', baseRefName: 'main', state: 'OPEN',
        isDraft: false, updatedAt: '2026-09-01T10:00:00Z', url: 'https://github.com/o/r/pull/25' },
    ]) },
    'search prs --author=@me --limit 30 --json number,title,repository,author,state,updatedAt,url,isDraft --state=open': { code: 0, stdout: '[]' },
  }, home);

  const found = await call('/api/pr/search?repo=o/r&state=open');
  ok(found.status === 200 && found.body.items.length === 1, 'поиск по репозиторию отдаёт PR',
    JSON.stringify(found.body));
  eq(found.body.items[0].headRefName, 'feat/пробел и слеш',
    'ветка с пробелом и кириллицей доезжает целиком');
  eq(found.body.mode, 'repo', 'режим поиска — repo');

  const globalSearch = await call('/api/pr/search?state=open');
  eq(globalSearch.body.items.length, 0, 'пустой результат глобального поиска -> пустой список, не ошибка');
  eq(globalSearch.body.mode, 'global', 'режим поиска — global');

  const badRepo = await call('/api/pr/search?repo=просто-строка');
  ok(badRepo.status === 400 && /owner\/repo/.test(badRepo.body.error),
    'некорректный репозиторий -> 400 с подсказкой', JSON.stringify(badRepo.body));
```

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `103/103 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 5: Commit**

```bash
git add tools/local-review/lib/pr-search.js tools/local-review/lib/routes tools/local-review/smoke.js
git commit -m "feat(local-review): PR search via gh pr list / gh search prs"
```

---

### Task 15: Метаданные PR-а — `/api/pr/resolve`

**Files:**
- Modify: `tools/local-review/lib/pr-search.js` (добавить `resolvePr`), `tools/local-review/lib/routes/gh.js`, `tools/local-review/lib/routes/index.js`
- Test: `tools/local-review/smoke.js` (+3 проверки)

**Interfaces:**
- Consumes: `ghJson`, `parseDescriptor`.
- Produces: `resolvePr({ host, owner, repo, number })` → `{ host, owner, repo, number, title, author, state, isDraft, headRefName, baseRefName, headSha, url }`.
  `GET /api/pr/resolve?source=pr&host=&owner=&repo=&number=` → это же тело.

**Команда:** `pr view <number> --repo <owner>/<repo> --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url`.
Это шапка экрана, а не дифф; она же добирает `headRefName`, которого нет у глобального поиска (спек 1.5, 7.4).

**Что должно остаться неизменным:** дифф здесь не запрашивается — `gh pr diff` живёт только в `pr-source.js` (задача 16). Разделение стадий «искать PR» / «читать дифф» из спека 1.5 сохраняется.

- [ ] **Step 1: Добавить `resolvePr`**

```js
async function resolvePr({ host, owner, repo, number }) {
  const row = await ghJson(['pr', 'view', String(number), '--repo', `${owner}/${repo}`,
    '--json', 'number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url']);
  return {
    host: host || 'github.com', owner, repo, number: row.number,
    title: row.title, author: row.author ? row.author.login : null,
    state: row.state, isDraft: Boolean(row.isDraft),
    headRefName: row.headRefName || null, baseRefName: row.baseRefName || null,
    headSha: row.headRefOid || null, url: row.url,
  };
}
```

- [ ] **Step 2: Зарегистрировать маршрут**

```js
  { method: 'GET', path: '/api/pr/resolve', handle: ghRoutes.resolve },
```

Хендлер разбирает дескриптор через `parseDescriptor(url, ctx.defaults)` и требует `source === 'pr'`, иначе 400 — дескриптор читается из одного места, как во всех остальных роутах.

- [ ] **Step 3: Добавить проверки в smoke**

```js
  console.log('\nметаданные PR-а');
  const viewKey = 'pr view 25 --repo o/r --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url';
  ghFixtures({
    [viewKey]: { code: 0, stdout: JSON.stringify({
      number: 25, title: 'Заголовок PR-а', author: { login: 'octocat' }, state: 'OPEN',
      isDraft: false, headRefName: 'feat/x', baseRefName: 'main',
      headRefOid: 'abc123', url: 'https://github.com/o/r/pull/25' }) },
    'pr view 999 --repo o/r --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url':
      { code: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 999.\n' },
  }, home);

  const meta = await call('/api/pr/resolve?source=pr&host=github.com&owner=o&repo=r&number=25');
  ok(meta.status === 200 && meta.body.headRefName === 'feat/x' && meta.body.headSha === 'abc123',
    'метаданные PR-а разрешаются', JSON.stringify(meta.body));
  const gone = await call('/api/pr/resolve?source=pr&host=github.com&owner=o&repo=r&number=999');
  ok(gone.status === 404 && /не найден/i.test(gone.body.error),
    'несуществующий PR -> 404 с читаемым текстом', JSON.stringify(gone.body));
  const notPr = await call('/api/pr/resolve?source=local&root=' + encodeURIComponent(repo));
  ok(notPr.status === 400, 'локальный дескриптор в /api/pr/resolve -> 400');
```

- [ ] **Step 4: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `106/106 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 5: Commit**

```bash
git add tools/local-review/lib/pr-search.js tools/local-review/lib/routes tools/local-review/smoke.js
git commit -m "feat(local-review): resolve PR metadata via gh pr view"
```

---

### Task 16: PR-источник — разбор `gh pr diff` и подключение к `/api/state` и `/api/diff`

**Files:**
- Create: `tools/local-review/lib/sources/pr-source.js`
- Modify: `tools/local-review/lib/sources/factory.js`, `tools/local-review/lib/routes/state.js`
- Test: `tools/local-review/smoke.js` (+10 проверок)

**Interfaces:**
- Consumes: `gh` (задача 13), `parsePatch` из `lib/diff.js:102` — **без изменений**, `resolvePr` (задача 15).
- Produces:
  - `splitPrDiff(text)` → `[{ path, oldPath, status, kind, binary, body }]` — чистая функция, тестируется отдельно.
  - `unquotePath(s)` → путь без C-эскейпов git (`"a/\320\264…"` → `a/д…`).
  - `createPrSource(descriptor)` → `{ id, kind: 'pr', descriptor, async listFiles(), async fileDiff(filePath, context), async meta() }`.
  - `/api/state` для PR-дескриптора: то же тело, что для локального, плюс `pr: <результат resolvePr>`; `repoRoot: null`; `rangeLabel: '<base> ← <head>'`; `mode`/`base` отсутствуют (у PR-дескриптора режимов нет — спек 1.1).

**Разбор шапки блока (спек 1.4):**

| Строка в шапке | `status` / `kind` |
| --- | --- |
| `new file mode …` | `A` |
| `deleted file mode …` | `D` |
| `rename from` / `rename to` | `R`, `oldPath` из `rename from` |
| `copy from` / `copy to` | `C`, `oldPath` из `copy from` |
| ничего из перечисленного | `M` |
| `Binary files … differ` / `GIT binary patch` | `binary: true` (ставит уже существующий `parsePatch`, `lib/diff.js:113`) |

Пути берутся из `--- a/<old>` / `+++ b/<new>`, если они есть (там git не квотит при обычном UTF-8), иначе из строки `diff --git`; для переименования — из `rename from`/`rename to`. `/dev/null` в `---`/`+++` игнорируется. Нормализация статусов в однобуквенный алфавит `A/M/D/R/C` делается здесь, в адаптере, а не в UI (спек 1.2): фронт и CSS (`public/app.js:106`, `public/styles.css:216-223`) уже умеют только его.

**`additions`/`deletions`** берутся из результата `parsePatch`; отдельного источника счётчиков нет (спек 1.4).

**Кеш:** `gh pr diff` вызывается один раз на дескриптор, результат парсится и кладётся в модульный `Map` с TTL 120 с; `?fresh=1` в запросе обходит кеш (кнопка «перечитать» в UI). Без кеша `/api/diff` на каждый файл делал бы сетевой вызов.

**Если GitHub отказался отдать дифф:** `gh pr diff` вернёт ненулевой код, `classifyGhError` даст читаемое сообщение, роут отдаст его вместе с `prUrl`. Запасной дороги нет — сознательно (спек 1.4, 7.5).

**Что должно остаться неизменным:** `lib/diff.js` — ни строки. Локальный путь `/api/state` и `/api/diff` — те же ответы (проверяется всеми 65 базовыми проверками). Признак `untracked` ставит только локальный источник (спек 1.2) — у PR-файлов его нет, значит `undefined`, и фронт это уже переносит (`review.js:246` приводит через `Boolean(...)`).

- [ ] **Step 1: Написать `unquotePath` и `splitPrDiff`**

```js
'use strict';

const { gh } = require('../gh');
const { parsePatch } = require('../diff');
const { descriptorKey } = require('../descriptor');
const { resolvePr } = require('../pr-search');

const CACHE = new Map(); // descriptorKey -> { at, files }
const TTL_MS = 120000;

/** git quotes non-ASCII paths as "a/\320\264..."; undo that. */
function unquotePath(value) {
  if (!value.startsWith('"')) return value;
  const inner = value.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') { bytes.push(inner.charCodeAt(i)); continue; }
    const next = inner[i + 1];
    const octal = /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4));
    if (octal) { bytes.push(parseInt(inner.slice(i + 1, i + 4), 8)); i += 3; continue; }
    const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
    bytes.push(map[next] === undefined ? next.charCodeAt(0) : map[next]);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p) {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

/**
 * Cuts `gh pr diff` output on `diff --git` boundaries, one block per file, and
 * reads status from the block header. The body goes to the existing parsePatch
 * (lib/diff.js:102) untouched — that is the whole point: line numbers in PR
 * mode are computed by exactly the same code as in local mode.
 */
function splitPrDiff(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = { header: [line], body: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@') || current.body.length) current.body.push(line);
    else current.header.push(line);
  }

  return blocks.map((block) => {
    const head = block.header.join('\n');
    let status = 'M';
    let kind = 'M';
    let oldPath = null;

    const gitLine = /^diff --git (\S+|".*?") (\S+|".*?")$/m.exec(block.header[0]);
    let newPath = gitLine ? stripPrefix(unquotePath(gitLine[2])) : null;
    let fromPath = gitLine ? stripPrefix(unquotePath(gitLine[1])) : null;

    const minus = /^--- (\S+|".*?")$/m.exec(head);
    const plus = /^\+\+\+ (\S+|".*?")$/m.exec(head);
    if (plus) { const p = stripPrefix(unquotePath(plus[1])); if (p) newPath = p; }
    if (minus) { const p = stripPrefix(unquotePath(minus[1])); if (p) fromPath = p; }

    if (/^new file mode /m.test(head)) { status = 'A'; kind = 'A'; }
    else if (/^deleted file mode /m.test(head)) { status = 'D'; kind = 'D'; newPath = fromPath; }
    else if (/^rename to /m.test(head)) {
      status = 'R'; kind = 'R';
      oldPath = unquotePath((/^rename from (.*)$/m.exec(head) || [])[1] || '') || fromPath;
      newPath = unquotePath((/^rename to (.*)$/m.exec(head) || [])[1] || '') || newPath;
    } else if (/^copy to /m.test(head)) {
      status = 'C'; kind = 'C';
      oldPath = unquotePath((/^copy from (.*)$/m.exec(head) || [])[1] || '') || fromPath;
      newPath = unquotePath((/^copy to (.*)$/m.exec(head) || [])[1] || '') || newPath;
    }

    // Binary markers can sit in the header, not the body: keep them for parsePatch.
    const binaryHeader = /^(Binary files .* differ|GIT binary patch)$/m.test(head);
    const body = (binaryHeader ? block.header.filter((l) => /^(Binary files|GIT binary patch)/.test(l)) : [])
      .concat(block.body)
      .join('\n');

    return { path: newPath, oldPath, status, kind, body };
  }).filter((f) => f.path);
}
```

- [ ] **Step 2: Написать `createPrSource`**

```js
async function loadFiles(descriptor, fresh) {
  const key = descriptorKey(descriptor);
  const hit = CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.files;

  const text = await gh(['pr', 'diff', String(descriptor.number),
    '--repo', `${descriptor.owner}/${descriptor.repo}`]);
  const files = splitPrDiff(text).map((f) => {
    const parsed = parsePatch(f.body);
    return {
      path: f.path, oldPath: f.oldPath, status: f.status, kind: f.kind,
      hunks: parsed.hunks, binary: parsed.binary,
      additions: parsed.additions, deletions: parsed.deletions,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  CACHE.set(key, { at: Date.now(), files });
  return files;
}

function createPrSource(descriptor) {
  return {
    id: descriptorKey(descriptor),
    kind: 'pr',
    descriptor,
    async meta() {
      return resolvePr(descriptor);
    },
    async listFiles(options) {
      const files = await loadFiles(descriptor, options && options.fresh);
      return {
        files: files.map((f) => ({
          path: f.path, oldPath: f.oldPath, status: f.status, kind: f.kind,
          additions: f.additions, deletions: f.deletions,
        })),
        range: { label: `${descriptor.owner}/${descriptor.repo}#${descriptor.number}` },
      };
    },
    async fileDiff(filePath, context, options) {
      const files = await loadFiles(descriptor, options && options.fresh);
      const entry = files.find((f) => f.path === filePath);
      if (!entry) {
        const err = new Error(`Файл "${filePath}" отсутствует в диффе этого PR-а.`);
        err.userFacing = true;
        err.status = 404;
        throw err;
      }
      return entry; // context is ignored: GitHub gives a fixed -U3 diff
    },
  };
}

module.exports = { createPrSource, splitPrDiff, unquotePath };
```

Комментарий про `context` обязателен в коде: локальный источник умеет менять `-U<n>` (`lib/diff.js:218`), GitHub — нет; UI сейчас всегда шлёт 3 (`review.js:267`), так что расхождения не видно.

- [ ] **Step 3: Подключить в фабрику и в `/api/state`**

`lib/sources/factory.js` получает ветку `if (descriptor.source === 'pr') return createPrSource(descriptor);`.
`getState` для PR-дескриптора дополняет ответ: `pr: await source.meta()`, `repoRoot: null`, `rangeLabel: '<baseRefName> ← <headRefName>'`. Если `meta()` упал (например, `not-found`), ошибка уходит наверх и превращается в JSON с `error` — экран покажет её вместо пустоты.

- [ ] **Step 4: Добавить проверки в smoke**

Фикстура диффа — с кириллицей, пробелом в имени, CRLF, переименованием и бинарником:

```js
  console.log('\nPR: дифф из gh');
  const PR_DIFF = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -10,3 +10,4 @@ function x() {',
    ' context 10',
    '+добавленная строка',
    ' context 11',
    ' context 12',
    'diff --git a/old name.txt b/новое имя.txt',
    'similarity index 90%',
    'rename from old name.txt',
    'rename to новое имя.txt',
    'diff --git a/assets/logo.bin b/assets/logo.bin',
    'index 3333333..4444444 100644',
    'Binary files a/assets/logo.bin and b/assets/logo.bin differ',
    'diff --git a/created.txt b/created.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/created.txt',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-was here',
    '',
  ].join('\r\n');

  ghFixtures({
    [viewKey]: { code: 0, stdout: JSON.stringify({
      number: 25, title: 'Заголовок PR-а', author: { login: 'octocat' }, state: 'OPEN',
      isDraft: false, headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123',
      url: 'https://github.com/o/r/pull/25' }) },
    'pr diff 25 --repo o/r': { code: 0, stdout: PR_DIFF },
    'pr diff 26 --repo o/r': { code: 0, stdout: '' },
    'pr diff 27 --repo o/r': { code: 1, stderr: 'HTTP 406: Sorry, this diff is taking too long to generate.\n' },
  }, home);

  const prQuery = 'source=pr&host=github.com&owner=o&repo=r&number=25';
  const prState = await call(`/api/state?${prQuery}`);
  ok(prState.status === 200, 'PR-дескриптор -> /api/state 200', JSON.stringify(prState.body).slice(0, 200));
  const prPaths = prState.body.files.map((f) => f.path).sort();
  eq(prPaths, ['assets/logo.bin', 'created.txt', 'gone.txt', 'новое имя.txt', 'src/app.js'].sort(),
    'все пять файлов PR-а разобраны, включая кириллицу с пробелом');
  eq(prState.body.files.find((f) => f.path === 'новое имя.txt').kind, 'R',
    'переименование помечено R');
  eq(prState.body.files.find((f) => f.path === 'новое имя.txt').oldPath, 'old name.txt',
    'у переименования сохранён oldPath');
  eq(prState.body.files.find((f) => f.path === 'created.txt').kind, 'A', 'новый файл помечен A');
  eq(prState.body.files.find((f) => f.path === 'gone.txt').kind, 'D', 'удалённый файл помечен D');
  eq(prState.body.pr.title, 'Заголовок PR-а', 'шапка PR-а приехала в /api/state');

  const prBin = await call(`/api/diff?file=${encodeURIComponent('assets/logo.bin')}&${prQuery}`);
  ok(prBin.body.binary === true, 'бинарный файл PR-а помечен binary', JSON.stringify(prBin.body));

  const prApp = await call(`/api/diff?file=${encodeURIComponent('src/app.js')}&${prQuery}`);
  const prAdded = prApp.body.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add');
  eq(prAdded.length, 1, 'в диффе PR-а одна добавленная строка');
  eq(prAdded[0].newLine, 11, 'номер строки из PR-диффа = 11 (@@ -10,3 +10,4 @@, после одного контекста)');
  ok(!prAdded[0].text.includes('\r'), 'CRLF из ответа gh не попадает в текст строки');

  const prEmpty = await call('/api/state?source=pr&host=github.com&owner=o&repo=r&number=26');
  eq(prEmpty.body.files.length, 0, 'PR без изменённых файлов -> пустой список, не падение');

  const prRefused = await call('/api/state?source=pr&host=github.com&owner=o&repo=r&number=27');
  ok(prRefused.status >= 400 && prRefused.status < 500 &&
     typeof prRefused.body.error === 'string' && !/\n\s+at\s/.test(prRefused.body.error),
    'GitHub не отдал дифф -> читаемое сообщение без стека', JSON.stringify(prRefused.body));
```

Фикстура для номера 26 и 27 требует своих `pr view` — добавить их в манифест по тому же образцу.

- [ ] **Step 5: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `119/119 проверок прошло`, `все проверки зелёные`. Базовые 65 обязаны остаться зелёными: `lib/diff.js` не тронут.

- [ ] **Step 6: Commit**

```bash
git add tools/local-review/lib/sources tools/local-review/lib/routes/state.js tools/local-review/smoke.js
git commit -m "feat(local-review): PR diff source parsing gh pr diff through the existing parsePatch"
```

---

# ФАЗА D — ФРОНТ

---

### Task 17: Хеш-роутер и оболочка двух экранов

**Files:**
- Modify: `tools/local-review/public/index.html`, `tools/local-review/public/app.js`, `tools/local-review/public/api.js` (добавить `qs`), `tools/local-review/public/diff-view.js` (запросы получают дескриптор), `tools/local-review/public/styles.css`
- Create: пустые заглушки не создаются — `screen-local.js` и `screen-pr.js` появляются в задачах 18-19 вместе с содержимым; на этом шаге `app.js` показывает экран-заглушку «выбери источник» с двумя ссылками.

**Interfaces:**
- Consumes: `api()`, `toast()`, всё из `diff-view.js`.
- Produces:
  - `public/api.js`: `qs(extra)` → строка query из `state.descriptor` плюс `extra`; `descriptorFromHash(hash)` → дескриптор или `null`; `hashFor(descriptor)` → строка хеша.
  - `public/app.js`: `route()`, `showScreen(name)`, `boot()`; `state.descriptor` — единственный источник правды о текущем контексте, синхронизированный с `location.hash`.

**Маршруты (спек 4.1):**

| Хеш | Экран |
| --- | --- |
| `#/local` | выбор папки |
| `#/local/<url-encoded путь>` | дифф локального репозитория |
| `#/pr` | поиск PR-ов |
| `#/pr/<host>/<owner>/<repo>/<number>` | дифф PR-а |
| пусто | читается `GET /api/session` → `last`; если его нет — `#/local` |

`localStorage` для этого не годится: при перезапуске порт может смениться, а это другой origin (спек 4.1).

**Что должно остаться неизменным:** весь DOM диффа и его классы; `MAX_RENDERED_LINES`; горячие клавиши; модалка массового удаления и её три способа отмены (`public/app.js:704-716`) — она переезжает в разметку без изменения логики.

- [ ] **Step 1: Добавить `qs` и хеш-хелперы в `api.js`**

```js
/** Descriptor -> query string. One place builds it, every request uses it. */
function qs(extra) {
  const p = new URLSearchParams();
  const d = state.descriptor;
  if (d && d.source === 'local') {
    p.set('source', 'local');
    p.set('root', d.root);
    p.set('mode', d.mode || 'working');
    p.set('base', d.base || 'origin/main');
  } else if (d && d.source === 'pr') {
    p.set('source', 'pr');
    p.set('host', d.host);
    p.set('owner', d.owner);
    p.set('repo', d.repo);
    p.set('number', String(d.number));
  }
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p.toString();
}

function hashFor(d) {
  if (!d) return '#/local';
  if (d.source === 'local') return `#/local/${encodeURIComponent(d.root)}`;
  return `#/pr/${d.host}/${d.owner}/${d.repo}/${d.number}`;
}

function descriptorFromHash(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'local' && parts[1]) {
    return { source: 'local', root: decodeURIComponent(parts[1]), mode: 'working', base: 'origin/main' };
  }
  if (parts[0] === 'pr' && parts.length >= 5) {
    return { source: 'pr', host: parts[1], owner: parts[2], repo: parts[3], number: Number(parts[4]) };
  }
  return null;
}
```

- [ ] **Step 2: Перевести запросы `diff-view.js` на `qs()`**

Три места:
- `refreshComments` (перенесено из `app.js:594`): `api('/api/comments?' + qs())`.
- `selectFile` (перенесено из `app.js:638-639`): `api('/api/diff?' + qs({ file }))` — старая сборка `URLSearchParams({file, mode, base})` уходит.
- `commentCard`/`editorCard` (перенесено из `app.js:373`, `app.js:429`, `app.js:481`): `POST /api/comments?<qs()>`, `PUT /api/comments/<id>?<qs()>`, `DELETE /api/comments/<id>?<qs()>`. Дескриптор едет в query даже у POST и DELETE — единообразно, чтобы не было двух мест, откуда он читается (спек 2.2).
- `copyAll`/`exportMd` (перенесено из `app.js:648`, `app.js:679`): `'/api/export/text?' + qs()`, `'/api/export/file?' + qs()`.
- `clearAll` в `app.js:727`: `'/api/comments/clear-all?' + qs()`.

- [ ] **Step 3: Разметка трёх экранов в `index.html`**

Существующий `<main class="layout">` (`index.html:35-47`) заворачивается в `<section id="screen-diff" class="screen">`. Добавляются `<section id="screen-local" class="screen" hidden>` и `<section id="screen-pr" class="screen" hidden>` (наполнение — задачи 18-19). В шапке слева появляется переключатель:

```html
        <nav class="tabs">
          <a id="tab-local" class="tab" href="#/local">Папка</a>
          <a id="tab-pr" class="tab" href="#/pr">GitHub PR</a>
        </nav>
```

Блок `.topbar-mid` с `#modes` и `#base-input` (`index.html:17-25`) скрывается на не-локальных экранах — у PR-дескриптора режимов нет (спек 1.1).

Вторая модалка (подъём к корню репозитория, задача 18) добавляется отдельным блоком `#root-modal-overlay` по образцу `index.html:49-58` — тот же класс `.overlay`, те же три способа отмены.

- [ ] **Step 4: Написать роутер в `app.js`**

```js
function showScreen(name) {
  for (const id of ['screen-diff', 'screen-local', 'screen-pr']) {
    document.getElementById(id).hidden = id !== `screen-${name}`;
  }
  el.topbarMid.hidden = !(name === 'diff' && state.descriptor && state.descriptor.source === 'local');
  el.tabLocal.classList.toggle('active', name === 'local' || (state.descriptor || {}).source === 'local');
  el.tabPr.classList.toggle('active', name === 'pr' || (state.descriptor || {}).source === 'pr');
}

async function route() {
  const hash = location.hash;
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const d = descriptorFromHash(hash);

  if (d) {
    state.descriptor = d;
    showScreen('diff');
    await refreshState(null);
    // Remember the choice so an empty hash after a restart lands here again.
    api('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ descriptor: d }),
    }).catch(() => {});
    return;
  }
  if (parts[0] === 'pr') {
    state.descriptor = null;
    showScreen('pr');
    await renderPrScreen();
    return;
  }
  state.descriptor = null;
  showScreen('local');
  await renderLocalScreen();
}

window.addEventListener('hashchange', () => route().catch((e) => toast(e.message, true)));

(async function boot() {
  try {
    if (!location.hash) {
      // The hash is the source of truth; the saved descriptor is consulted only
      // when there is no hash at all.
      const session = await api('/api/session');
      location.hash = hashFor(session.last);
      if (!location.hash) location.hash = '#/local';
    }
    await route();
  } catch (e) {
    toast(e.message, true);
  }
})();
```

`refreshState` (перенесённая из `app.js:601-625`) переводится на `api('/api/state?' + qs())` и на PR-ветке дополнительно рисует шапку PR-а из `data.pr`.

- [ ] **Step 5: Стили экранов и `.status.C`**

В `styles.css` добавить `.screen[hidden] { display: none; }`, `.tabs`/`.tab`/`.tab.active` (по образцу `.mode`/`.mode.active`, `styles.css:82-99`), и правило `.file-item .status.C { color: var(--warn); }` рядом с `styles.css:223` — статус `C` (copied) приходит от PR-адаптера и сейчас не покрашен.

- [ ] **Step 6: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `119/119 проверок прошло`, `все проверки зелёные`. Фронт smoke не проверяет, но роут `?source=…` в query теперь используют обе стороны — регресс сервера обязателен.

- [ ] **Step 7: Проверить в браузере**

Run: `node tools/local-review/review.js --no-open --port 4399`, открыть страницу. Ожидаемо: адресная строка получает `#/local/<путь>` (сервер стартовал в репозитории → `session.last` уже записан), дифф на месте, вкладки переключаются, `#/pr` показывает заглушку, консоль без ошибок, ни одного 5xx во вкладке Network.

- [ ] **Step 8: Commit**

```bash
git add tools/local-review/public
git commit -m "feat(local-review): hash router and two-screen shell"
```

---

### Task 18: Экран локальной папки `public/screen-local.js`

**Files:**
- Create: `tools/local-review/public/screen-local.js`
- Modify: `tools/local-review/public/index.html` (разметка `#screen-local` + вторая модалка), `tools/local-review/public/styles.css`, `tools/local-review/public/app.js` (перенести переключатель режимов в этот файл)

**Interfaces:**
- Consumes: `api()`, `qs()`, `hashFor()`, `toast()`; эндпоинты `/api/browse`, `/api/local/validate`, `/api/session`.
- Produces: `renderLocalScreen()`, `openFolder(pathValue)`, `confirmRootModal(text)`.

**Поведение выбора папки (спек 2.4):**

| Что нашли | Что происходит |
| --- | --- |
| `validate.ok === false` | сообщение «`P` — не git-репозиторий», пользователь остаётся на экране выбора |
| `ok && sameAsRequested` | сразу `location.hash = hashFor({source:'local', root})`, молча |
| `ok && !sameAsRequested` | модалка «Выбран `P`. Это подкаталог репозитория `R`. Дифф будем читать из корня `R`. Открыть?» → [Отмена] / [Открыть корень] |

Модалка — существующий оверлей (`public/index.html:49-58`, его копия `#root-modal-overlay`), **не** нативный `confirm()`: нативные диалоги блокируют браузерную автоматизацию, которой проверяется живой прогон (спек 2.4).

**Что должно остаться неизменным:** переключатель `working/staged/base` и поле базовой ревизии (`public/index.html:17-25`, обработчики `app.js:743-762`) переезжают в этот файл дословно, меняется только источник дескриптора — при переключении режима правится `state.descriptor.mode` и вызывается `refreshState(state.activeFile)`.

- [ ] **Step 1: Разметка `#screen-local`**

Поле текущего пути (только для чтения) + кнопка «..», список подкаталогов с пометкой «репозиторий», блок «Недавние», поле ручного ввода пути с кнопкой «Открыть». Все элементы получают id: `local-path`, `local-up`, `local-entries`, `local-recent`, `local-manual`, `local-open`, `local-error`.

- [ ] **Step 2: Написать `renderLocalScreen()`**

```js
async function renderLocalScreen(startPath) {
  const data = await api('/api/browse' + (startPath ? '?path=' + encodeURIComponent(startPath) : ''));
  el.localPath.textContent = data.path || 'Начни с домашней папки или недавних';
  el.localUp.hidden = !data.parent;
  el.localUp.onclick = () => renderLocalScreen(data.parent).catch((e) => toast(e.message, true));
  el.localEntries.textContent = '';
  for (const entry of data.entries) {
    const li = document.createElement('li');
    li.className = 'browse-item' + (entry.isRepo ? ' repo' : '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const mark = document.createElement('span');
    mark.className = 'hint';
    mark.textContent = entry.isRepo ? 'репозиторий' : '';
    const open = document.createElement('button');
    open.className = 'link';
    open.textContent = 'открыть';
    open.addEventListener('click', (e) => { e.stopPropagation(); openFolder(entry.path); });
    li.append(name, mark, open);
    // Click on the row descends; only the button opens. Descending never writes.
    li.addEventListener('click', () => renderLocalScreen(entry.path).catch((err) => toast(err.message, true)));
    el.localEntries.append(li);
  }
}
```

- [ ] **Step 3: Написать `openFolder()` с модалкой подъёма к корню**

```js
async function openFolder(pathValue) {
  const v = await api('/api/local/validate?root=' + encodeURIComponent(pathValue));
  if (!v.ok) {
    el.localError.textContent = v.error;
    el.localError.hidden = false;
    return; // stay on the picker, exactly as the spec requires
  }
  if (!v.sameAsRequested) {
    const confirmed = await confirmRootModal(
      `Выбран ${v.requested}. Это подкаталог репозитория ${v.repoRoot}. ` +
      `Дифф будем читать из корня ${v.repoRoot}. Открыть?`
    );
    if (!confirmed) {
      toast('Отменено — ничего не открыто');
      return;
    }
  }
  el.localError.hidden = true;
  const descriptor = { source: 'local', root: v.repoRoot, mode: 'working', base: 'origin/main' };
  const saved = await api('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ descriptor }),
  });
  if (saved.gitignore && saved.gitignore.changed) toast('в .gitignore добавлено .local-review/');
  location.hash = hashFor(descriptor);
}
```

Тост про `.gitignore` — требование спека 7.7: «факт записи показывается в UI строкой „в `.gitignore` добавлено `.local-review/`“».

- [ ] **Step 4: `confirmRootModal` по образцу существующей модалки**

Копия `openModal`/`closeModal` (`public/app.js:686-708`) на узлах `#root-modal-*`, с теми же тремя способами отмены: кнопка «Отмена», `Esc`, клик по фону. Обработчик `Esc` в `app.js:709-716` дополняется веткой на второй оверлей — порядок проверок: сначала оверлей массового удаления, потом оверлей корня, потом `cancelDrag()`.

- [ ] **Step 5: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `119/119 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 6: Проверить в браузере**

Run: `node tools/local-review/review.js --no-open --port 4399`, перейти на `#/local`. Проверить: спуск по каталогам; «..»; выбор подкаталога репозитория → модалка → «Отмена» ничего не открывает, `Esc` и клик по фону тоже; «Открыть корень» открывает корень; выбор не-git каталога → сообщение на экране, страница не сменилась; переключатель `working/staged/base` работает после открытия.

- [ ] **Step 7: Commit**

```bash
git add tools/local-review/public
git commit -m "feat(local-review): folder picker screen with root-ascend confirmation"
```

---

### Task 19: Экран поиска PR-ов `public/screen-pr.js`

**Files:**
- Create: `tools/local-review/public/screen-pr.js`
- Modify: `tools/local-review/public/index.html` (разметка `#screen-pr` + шапка PR-а на экране диффа), `tools/local-review/public/styles.css`

**Interfaces:**
- Consumes: `api()`, `hashFor()`, `toast()`; эндпоинты `/api/gh/status`, `/api/pr/search`, `/api/pr/resolve`.
- Produces: `renderPrScreen()`, `runPrSearch()`, `renderPrHeader(pr)`.

**Экран поиска:** блок статуса `gh` (спек 1.6 / инвариант 9), форма (репозиторий — **опциональное** поле, строка запроса, состояние `open|closed|merged|все`), список результатов, строка «конфиг: `<homeDir>`, хранится PR-ов: `<storedPrs>`» (спек 3.2: «чтобы каталог не рос незаметно»).

**Ветка в выдаче:** при пустом поле репозитория показывается `—` (спек 1.5, 7.4) — `gh search prs` её не отдаёт; ветка подтягивается при открытии PR-а через `/api/pr/resolve`.

**Что должно остаться неизменным:** ни одна функция `diff-view.js` — экран диффа PR-а рисуется тем же кодом. Единственное, что добавляется на экран диффа, — блок `#pr-header` с заголовком, ветками, автором, состоянием и ссылкой на PR.

- [ ] **Step 1: Разметка `#screen-pr` и `#pr-header`**

id: `gh-status`, `pr-repo`, `pr-query`, `pr-state`, `pr-search-btn`, `pr-results`, `pr-config-line`, `pr-header`.

- [ ] **Step 2: Написать `renderPrScreen()`**

```js
async function renderPrScreen() {
  const status = await api('/api/gh/status');
  el.ghStatus.textContent = '';
  if (!status.installed || !status.authenticated) {
    const box = document.createElement('div');
    box.className = 'empty';
    box.textContent = status.message;
    el.ghStatus.append(box);
    el.prSearchBtn.disabled = true;
    return; // a readable message, never an empty screen or a stack trace
  }
  el.prSearchBtn.disabled = false;
  el.ghStatus.textContent = `gh: ${status.login || '?'} @ ${status.host || 'github.com'}`;
  await runPrSearch();
}
```

- [ ] **Step 3: Написать `runPrSearch()` и рендер строк результата**

Строка результата: `#<number>`, заголовок, автор, `headRefName || '—'`, состояние, дата, кнопка «открыть» → `location.hash = hashFor({source:'pr', host, owner, repo, number})`. Ошибка поиска рисуется в `#pr-results` текстом (`e.message`), а не тостом, который исчезнет через 8 секунд.

Под списком:

```js
  el.prConfigLine.textContent =
    `Комментарии к PR-ам: ${data.homeDir} (хранится PR-ов: ${data.storedPrs})`;
```

- [ ] **Step 4: `renderPrHeader(pr)` на экране диффа**

Вызывается из `refreshState`, когда `data.pr` есть: заголовок, `baseRefName ← headRefName`, автор, `state`/`isDraft`, ссылка `pr.url` (`target="_blank" rel="noreferrer"`). Для локального дескриптора блок скрывается.

- [ ] **Step 5: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: `119/119 проверок прошло`, `все проверки зелёные`.

- [ ] **Step 6: Проверить в браузере с подставным `gh`**

Run:
```bash
LOCAL_REVIEW_GH_BIN=/nonexistent/gh node tools/local-review/review.js --no-open --port 4399
```
Открыть `#/pr`. Expected: сообщение «`gh` не установлен. Установи GitHub CLI и выполни `gh auth login`.», кнопка поиска заблокирована, пустого экрана и stack trace нет, в консоли браузера чисто. Затем перезапустить без переменной и убедиться, что реальный поиск работает.

- [ ] **Step 7: Commit**

```bash
git add tools/local-review/public
git commit -m "feat(local-review): PR search screen and PR header on the diff screen"
```

---

# ФАЗА E — ПРОВЕРКА И ДОКУМЕНТАЦИЯ

---

### Task 20: smoke.js — явный блок девяти инвариантов

**Files:**
- Modify: `tools/local-review/smoke.js` (новая секция `проверка инвариантов раздела 5` в конце, перед подсчётом итогов)
- Test: сам себе тест

**Interfaces:**
- Consumes: всё построенное выше, `ghFixtures`/`noGh` из задачи 12.
- Produces: секция, где каждая проверка подписана номером инварианта; расхождение по любому — ненулевой код выхода (уже обеспечено `failures` / `process.exit(1)`, `smoke.js:464-467`).

**Требование:** каждый из девяти инвариантов раздела 5 спека получает **именованную** проверку. Часть уже покрыта в задачах 7-19; здесь добавляется то, чего не хватает, и всё девять перечисляются явно, чтобы по выводу smoke было видно покрытие.

- [ ] **Step 1: Инвариант 1 — экспорт не меняет комментарии, теперь и в PR-режиме**

Локальная часть уже есть (`smoke.js:282-301`). Добавить PR-часть:

```js
  console.log('\nинвариант 1 (PR): экспорт не меняет комментарии');
  const prBefore = (await call(`/api/comments?${prQuery}`)).body.comments;
  await call(`/api/export/text?${prQuery}`);
  const prFile1 = await call(`/api/export/file?${prQuery}`, { method: 'POST' });
  await call(`/api/export/text?${prQuery}`);
  await call(`/api/export/file?${prQuery}`, { method: 'POST' });
  const prAfter = (await call(`/api/comments?${prQuery}`)).body.comments;
  eq(prAfter.map((c) => c.id).sort(), prBefore.map((c) => c.id).sort(),
    'инвариант 1: после 4 экспортов в PR-режиме те же id');
  eq(path.dirname(prFile1.body.path), path.join(home, 'exports'),
    'инвариант 1: .md PR-режима записан в ~/.local-review/exports');
```

- [ ] **Step 2: Инвариант 2 — массовое удаление только с confirm, в обоих режимах**

Локальная часть есть (`smoke.js:330-341`). Добавить PR-часть тремя теми же телами (`{}`, `{confirm:false}`, `{confirm:"true"}`) → 400 каждый раз, и проверку, что число комментариев PR-а не изменилось.

- [ ] **Step 3: Инвариант 3 — переживают перезапуск, в обоих режимах**

Локальная часть есть (`smoke.js:344-366`). Добавить: закрыть сервер, поднять новый через `start()`, запросить `/api/comments?<prQuery>` — те же id, то же количество. Плюс прочитать файл `<home>/pr/github.com__o__r__25.json` с диска и сверить количество.

- [ ] **Step 4: Инвариант 4 — реальные номера строк, в обоих режимах**

Локальная часть есть (`smoke.js:213-224`, `smoke.js:315-327`). PR-часть добавлена в задаче 16 (`newLine === 11`). Здесь добавить проверку по экспорту:

```js
  const prMd = await call(`/api/export/text?${prQuery}`);
  ok(prMd.body.includes('src/app.js:L11\n'),
    'инвариант 4: якорь в экспорте PR-режима — реальный номер строки', prMd.body);
```

- [ ] **Step 5: Инвариант 5 — стораджи не пересекаются**

```js
  console.log('\nинвариант 5: стораджи не пересекаются');
  await call('/api/comments', json('POST', { file: 'src/app.js', startLine: 3, endLine: 3, text: 'ЛОКАЛЬНЫЙ-МАРКЕР' }));
  await call(`/api/comments?${prQuery}`, json('POST', { file: 'src/app.js', startLine: 11, endLine: 11, text: 'PR-МАРКЕР' }));

  const localOnDisk = fs.readFileSync(path.join(repo, '.local-review', 'comments.json'), 'utf8');
  const prStorePath = path.join(home, 'pr', 'github.com__o__r__25.json');
  const prOnDisk = fs.readFileSync(prStorePath, 'utf8');

  ok(localOnDisk.includes('ЛОКАЛЬНЫЙ-МАРКЕР') && !localOnDisk.includes('PR-МАРКЕР'),
    'инвариант 5: в локальном файле нет комментариев PR-а');
  ok(prOnDisk.includes('PR-МАРКЕР') && !prOnDisk.includes('ЛОКАЛЬНЫЙ-МАРКЕР'),
    'инвариант 5: в PR-файле нет локальных комментариев');
  ok(!fs.existsSync(path.join(repo, 'pr')),
    'инвариант 5: PR-сторадж не создаётся внутри репозитория');
  ok(
    (await call(`/api/comments?${prQuery}`)).body.comments.every((c) => c.text !== 'ЛОКАЛЬНЫЙ-МАРКЕР'),
    'инвариант 5: API PR-дескриптора не отдаёт локальные комментарии'
  );
  ok(
    (await call('/api/comments')).body.comments.every((c) => c.text !== 'PR-МАРКЕР'),
    'инвариант 5: API локального дескриптора не отдаёт комментарии PR-а'
  );
  const mixedState = await call(`/api/state?${prQuery}`);
  const localState2 = await call('/api/state');
  ok(mixedState.body.totalComments !== localState2.body.totalComments ||
     mixedState.body.totalComments === 1,
    'инвариант 5: счётчики двух режимов считаются раздельно',
    `${mixedState.body.totalComments} / ${localState2.body.totalComments}`);
```

- [ ] **Step 6: Инвариант 6 — никаких git-команд на запись и никакой записи в исходники**

```js
  console.log('\nинвариант 6: тула не пишет в репозиторий');
  const headBefore = git(['rev-parse', 'HEAD'], repo).trim();
  const reflogBefore = git(['reflog', '--format=%H'], repo).split('\n').length;
  // ... прогон уже состоялся выше ...
  eq(git(['rev-parse', 'HEAD'], repo).trim(), headBefore, 'инвариант 6: HEAD не двигался');
  eq(git(['reflog', '--format=%H'], repo).split('\n').length, reflogBefore,
    'инвариант 6: reflog не пополнился (ни одной пишущей git-команды)');

  const dirty = git(['status', '--porcelain'], repo)
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/\.local-review|review-\d{4}-\d{2}-\d{2}-\d{4}\.md|\.gitignore/.test(l));
  eq(dirty, [], 'инвариант 6: тула не изменила ни одного файла проекта', dirty.join(' | '));

  const writeCommands = /spawn\(\s*'git'\s*,\s*\[\s*'(add|commit|checkout|reset|clean|rm|mv|push|stash|apply|restore)'/;
  const gitSource = fs.readFileSync(path.join(__dirname, 'lib', 'git.js'), 'utf8');
  ok(!writeCommands.test(gitSource), 'инвариант 6: в lib/git.js нет пишущих git-команд');
```

`headBefore`/`reflogBefore` снимаются в начале `main()`, сверка — здесь.

- [ ] **Step 7: Инвариант 7 — ноль npm-зависимостей**

```js
  console.log('\nинвариант 7: ноль зависимостей');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    ok(!pkg[key] || Object.keys(pkg[key]).length === 0,
      `инвариант 7: ${key} пуст`, JSON.stringify(pkg[key]));
  }
  const sources = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory() && d.name !== 'node_modules') walk(abs);
      else if (d.isFile() && abs.endsWith('.js')) sources.push(abs);
    }
  })(__dirname);
  const badRequire = [];
  for (const file of sources) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const id = m[1];
      if (!id.startsWith('node:') && !id.startsWith('.') && !id.startsWith('/')) badRequire.push(`${file}: ${id}`);
    }
  }
  eq(badRequire, [], 'инвариант 7: ни одного require внешнего пакета', badRequire.join(' | '));
```

- [ ] **Step 8: Инвариант 8 — обзор каталогов**

Проверки добавлены в задаче 9; здесь они переименовываются с префиксом `инвариант 8:` и дополняются двумя:

```js
  ok(!('content' in browseRepo.body) && !browseRepo.body.entries.some((e) => 'content' in e),
    'инвариант 8: в выдаче нет поля с содержимым');
  const climb = await call('/api/browse');
  ok(climb.body.path === null && Array.isArray(climb.body.entries),
    'инвариант 8: без path сервер отдаёт стартовый набор, а не сканирует корень диска',
    JSON.stringify(climb.body).slice(0, 200));
```

- [ ] **Step 9: Инвариант 9 — читаемые сообщения на все пять отказов `gh`**

```js
  console.log('\nинвариант 9: отказы gh дают читаемое сообщение');

  // Ровно та же строка argv, что собирает searchPrs для repo=o/r, state=open.
  const SEARCH_KEY =
    'pr list --repo o/r --limit 30 --json number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft --state open';
  const stderrFor = (text) => ({ [SEARCH_KEY]: { code: 1, stderr: text } });

  const ghCases = [
    { name: 'gh не установлен', setup: noGh,
      url: '/api/gh/status', expect: /не установлен/i, viaStatus: true },
    { name: 'нет логина',
      fixture: { [SEARCH_KEY]: { code: 4, stderr: 'gh auth login required: You are not logged into any GitHub hosts\n' } },
      url: '/api/pr/search?repo=o/r', expect: /не залогинен/i },
    { name: 'лимит API',
      fixture: stderrFor('API rate limit exceeded for user ID 1\n'),
      url: '/api/pr/search?repo=o/r', expect: /лимит/i },
    { name: 'нет сети',
      fixture: stderrFor('dial tcp: lookup api.github.com: no such host\n'),
      url: '/api/pr/search?repo=o/r', expect: /связи с GitHub/i },
    { name: '404',
      fixture: stderrFor('HTTP 404: Not Found (https://api.github.com/repos/o/r)\n'),
      url: '/api/pr/search?repo=o/r', expect: /не найден/i },
  ];

  for (const c of ghCases) {
    if (c.setup) c.setup();
    else ghFixtures(c.fixture, home);
    const res = await call(c.url);
    const text = JSON.stringify(res.body);
    ok(c.viaStatus ? res.status === 200 : res.status >= 400 && res.status < 500,
      `инвариант 9 (${c.name}): статус не 5xx`, `${res.status} ${text}`);
    ok(c.expect.test(text), `инвариант 9 (${c.name}): читаемое сообщение`, text);
    ok(!/\n\s+at\s|Error:\s+\w+Error/.test(text), `инвариант 9 (${c.name}): без stack trace`, text);
  }
```

Каждый случай подставляет свой манифест под одним и тем же ключом `SEARCH_KEY` — `ghFixtures` пишет новый файл манифеста и переставляет `LOCAL_REVIEW_GH_FIXTURES`, поэтому предыдущий сценарий не мешает следующему.

- [ ] **Step 10: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: около `160` проверок, `все проверки зелёные`, код выхода 0. В выводе видны все девять строк `инвариант N:`.

- [ ] **Step 11: Проверить, что расхождение действительно валит прогон**

Run: временно сломать один инвариант (например, в `lib/stores/factory.js` вернуть для PR путь внутри `descriptor.root`), запустить smoke.
Expected: `FAIL инвариант 5: ...`, вывод `N проверок упало`, `echo $?` (или `$LASTEXITCODE`) → `1`. Откатить правку, прогнать снова — зелено.

- [ ] **Step 12: Commit**

```bash
git add tools/local-review/smoke.js
git commit -m "test(local-review): explicit check for each of the nine spec invariants"
```

---

### Task 21: README — два режима, `gh`, новые эндпоинты, новые флаги

**Files:**
- Modify: `tools/local-review/README.md`

**Interfaces:**
- Consumes: всё готовое поведение.
- Produces: документ, из которого понятно, что тула делает и чего не делает.

**Что должно остаться неизменным:** раздел «Формат экспорта» (`README.md:62-78`) — формат не менялся; описание работы в UI (`README.md:48-60`) — жесты и горячие клавиши те же.

- [ ] **Step 1: Исправить ныне ложное утверждение `README.md:86-87`**

Сейчас там:

> Тула работает с git только на чтение (`git diff`, `git rev-parse`, `git ls-files`, `git merge-base`) и никогда не пишет в исходники и не коммитит.

С появлением PR-режима это перестало быть правдой в части «никогда не ходит в сеть» (спек 7.2). Заменить на:

> С git тула работает только на чтение (`git diff`, `git rev-parse`, `git ls-files`, `git merge-base`): не коммитит, не переключает ветки, не пишет в исходники. Единственная запись в репозиторий — строка `.local-review/` в `.gitignore`, и только после того, как ты подтвердил выбор папки.
>
> **Локальный режим в сеть не ходит вообще.** **PR-режим ходит в сеть исключительно через подпроцесс `gh`** — прямых HTTP-запросов к `api.github.com` в коде нет, токен не читается и не хранится. В GitHub на запись не отправляется ничего: комментарии живут только локально.

- [ ] **Step 2: Добавить раздел «Два режима»**

Сразу после вводных строк (`README.md:1-7`):
- **Локальная папка** — то же, что раньше, но папка выбирается прямо в UI, из корня репозитория запускаться не обязательно. Комментарии — `<репозиторий>/.local-review/comments.json`, экспорт — в корень репозитория.
- **GitHub PR** — поиск PR-ов и просмотр диффа без локального клона. Комментарии — `~/.local-review/pr/<host>__<owner>__<repo>__<number>.json`, экспорт — `~/.local-review/exports/`. Каталог не чистится автоматически; его путь и число хранимых PR-ов видно на экране поиска.
- Адреса экранов: `#/local`, `#/local/<путь>`, `#/pr`, `#/pr/<host>/<owner>/<repo>/<number>`.

- [ ] **Step 3: Добавить раздел «Требования»**

- Node.js 20+, ноль npm-зависимостей.
- Для PR-режима — установленный **GitHub CLI** и выполненный `gh auth login`. Проверка: `gh auth status`. Без `gh` локальный режим работает полностью, PR-экран показывает, что делать.

- [ ] **Step 4: Обновить таблицу флагов (`README.md:24-34`)**

`--cwd` теперь опционален: без него и без git-репозитория в текущей папке сервер стартует на экране выбора папки. Добавить строку про `LOCAL_REVIEW_HOME` и `LOCAL_REVIEW_GH_BIN` отдельной таблицей «Переменные окружения» с пометкой, что вторая нужна только тесту.

- [ ] **Step 5: Обновить таблицу API (`README.md:102-114`)**

Добавить строки и указать, что дескриптор едет query-параметрами во всех методах, включая POST и DELETE:

| Метод | Путь |
| --- | --- |
| GET | `/api/gh/status` |
| GET | `/api/pr/search?repo=&q=&state=&limit=` |
| GET | `/api/pr/resolve?source=pr&host=&owner=&repo=&number=` |
| GET | `/api/browse?path=` |
| GET | `/api/local/validate?root=` |
| GET | `/api/session` |
| POST | `/api/session` |

Существующие семь строк дополнить хвостом `?source=…`.

- [ ] **Step 6: Обновить раздел «Проверка» (`README.md:89-100`)**

Дописать: GitHub-сценарии гоняются на фикстурах через `LOCAL_REVIEW_GH_BIN`, реальная сеть в тесте не используется; проверяется каждый из девяти инвариантов; ненулевой код выхода при любом расхождении. Указать актуальное число проверок из задачи 20.

- [ ] **Step 7: Проверить, что в README нет вранья**

Run: `grep -n "никогда не ходит в сеть\|только на чтение\|origin/main" tools/local-review/README.md`
Expected: формулировки соответствуют новому тексту; ни одного утверждения, которое опровергается кодом.

- [ ] **Step 8: Прогнать smoke**

Run: `node tools/local-review/smoke.js`
Expected: зелено (README код не трогает, но прогон обязателен по правилу «после каждого шага»).

- [ ] **Step 9: Commit**

```bash
git add tools/local-review/README.md
git commit -m "docs(local-review): two modes, gh requirement, new endpoints and env vars"
```

---

### Task 22: Живой прогон в браузере (спек 6.2)

**Files:**
- Modify: ничего, если всё сошлось. Каждая найденная поломка чинится отдельным коммитом с прогоном smoke.
- Артефакты: пять скриншотов в `docs/superpowers/plans/artifacts/2026-09-06/` (каталог создать).

**Требование:** настоящий сервер, настоящий `gh`, настоящие PR-ы, настоящий репозиторий с незакоммиченными изменениями. Всё — **кликами в UI**, а не запросами к эндпоинтам. Нативные `confirm()` в коде отсутствуют именно ради этого (спек 2.4).

**Подготовка:**
```bash
gh auth status                        # должен показать логин
node tools/local-review/review.js --no-open --port 4399
```
Второй терминал держать под `git status` проверяемого репозитория.

- [ ] **Step 1: Сценарий «GitHub PR» целиком**

`#/pr` → статус `gh` показывает логин → поиск с пустым полем репозитория (свои PR-ы) → в колонке ветки `—` → поиск с указанным `owner/repo` → ветка показана → открыть PR → дифф отрисовался, шапка PR-а с заголовком, `base ← head`, автором и ссылкой.

- [ ] **Step 2: Сценарий «Локальная папка» целиком**

`#/local` → спуск по каталогам → выбор подкаталога репозитория → модалка подъёма к корню → «Открыть корень» → дифф отрисовался; в UI появилась строка «в `.gitignore` добавлено `.local-review/`» (если строки там не было).

- [ ] **Step 3: Комментарии — три способа, на обоих экранах**

Комментарий к строке (клик по номеру); к диапазону (протяжка по номерам вниз и вверх); к файлу целиком («+ комментарий к файлу»). Затем `edit` одного комментария и `delete` одного — соседние не тронуты.

- [ ] **Step 4: Экспорт, на обоих экранах**

«Сгенерировать .md» → тост с путём; открыть файл, сверить содержимое. «Скопировать всё» → вставить в редактор, сверить. **После каждого экспорта** — убедиться, что счётчик комментариев не изменился и список на месте (инвариант 1).

- [ ] **Step 5: Модалка массового удаления — три способа отмены**

«Очистить всё» → «Отмена» → ничего не удалено. Ещё раз → `Esc` → ничего не удалено. Ещё раз → клик по фону → ничего не удалено. Счётчик после всех трёх — прежний (инвариант 2).

- [ ] **Step 6: Перезагрузка страницы и перезапуск сервера, в обоих режимах**

`F5` на экране диффа PR-а → тот же PR, те же комментарии. `Ctrl+C` серверу, запустить снова, открыть тот же адрес → то же самое. Повторить для локального режима (инвариант 3).

- [ ] **Step 7: Переключение между страницами с непустыми комментариями в каждой**

Оставить 2 комментария в локальном режиме и 3 в PR-режиме. Переключаться туда-обратно: списки и счётчики не смешиваются, в каждом ровно свои (инвариант 5).

- [ ] **Step 8: Экраны ошибок**

Остановить сервер, запустить с `LOCAL_REVIEW_GH_BIN=/nonexistent/gh`, открыть `#/pr` → читаемое сообщение про установку `gh`, кнопка поиска заблокирована. Затем на `#/local` выбрать заведомо не-git каталог → сообщение «не git-репозиторий», страница не сменилась (инвариант 9 и спек 2.4).

- [ ] **Step 9: Консоль и сеть**

По ходу всех шагов держать открытыми вкладки Console и Network. Требование: **ни одной необработанной ошибки** в консоли и **ни одного ответа 5xx** в сети. Любое нарушение — баг, чинится и прогоняется smoke.

- [ ] **Step 10: Скриншоты**

Пять штук в `docs/superpowers/plans/artifacts/2026-09-06/`: `pr-list.png`, `pr-diff-with-comment.png`, `local-picker.png`, `local-diff.png`, `gh-unavailable.png`.

- [ ] **Step 11: Финальный прогон smoke и проверка чистоты репозитория**

Run:
```bash
node tools/local-review/smoke.js
git status --porcelain
```
Expected: `все проверки зелёные`; в `git status` — только осознанные изменения (скриншоты, при необходимости — фиксы из шага 9). Ни `.local-review/`, ни `review-*.md` в статусе быть не должно.

- [ ] **Step 12: Commit**

```bash
git add docs/superpowers/plans/artifacts
git commit -m "docs(local-review): live-run screenshots for the two-mode review"
```

---

## Сводка контрольных точек smoke

| После задачи | Ожидаемое число проверок | Что добавилось |
| --- | --- | --- |
| базовая линия | 65 | — |
| 1-4 (рефакторинг) | 65 | ничего, только регресс |
| 5, 6 | 65 | ничего, только регресс |
| 7 | 69 | дескриптор в query |
| 8 | 70 | каталог экспорта |
| 9 | 80 | обзор каталогов, валидация корня |
| 10 | 85 | сессия, `.gitignore` по подтверждению |
| 11 | 89 | `Origin` / `Sec-Fetch-Site` |
| 12 | 91 | самопроверка фикстуры `gh` |
| 13 | 97 | статус и классификация ошибок `gh` |
| 14 | 103 | поиск PR-ов |
| 15 | 106 | метаданные PR-а |
| 16 | 119 | PR-источник и разбор диффа |
| 17-19 (фронт) | 119 | ничего, только регресс |
| 20 | ~160 | явный блок девяти инвариантов |
| 21, 22 | ~160 | ничего, только регресс |

Числа после задачи 20 — оценка: точное значение фиксируется по факту и подставляется в README на шаге 6 задачи 21. Что не оценка и не подлежит послаблению: **на каждом шаге все проверки зелёные и ни одна из базовых 65 не исчезла**.

---

## Точки, где ломается обратная совместимость

| Задача | Что ломается | Чем ловится |
| --- | --- | --- |
| 5 | `CommentStore(repoRoot)` → `CommentStore(filePath)` (`lib/store.js:11-14`); поле `store.repoRoot` исчезает | грепом `new CommentStore` (ровно один вызов до и после); проверками `smoke.js:346`, `smoke.js:348`, `smoke.js:456`, которые читают файл по абсолютному пути |
| 5 | `review.js:406` и потребители `start().store` | `review.js:446` печатает `started.store.all().length`; падение будет видно при первом же ручном запуске |
| 7 | `createApp(ctx)` меняет форму `ctx` с `{repoRoot, store, mode, base}` на `{defaults, homeDir}` | `createApp` экспортируется (`review.js:458`) — экспорт сохраняется; smoke гоняет всё через `start()`, поэтому расхождение всплывёт как 400/500 на первом же запросе |
| 7 | `start()` может вернуть `store: null`, если сервер поднят вне репозитория | `review.js:446` печатает строку про комментарии только при непустом `store`; проверка `smoke.js:429-432` («запуск вне git-репозитория → внятная ошибка») **должна остаться зелёной**: явно переданный `--cwd`, не являющийся репозиторием, по-прежнему валит старт; беззаголовочный старт «просто в непонятной папке» — нет |
| 8 | `POST /api/export/file` получает новое поле `dir` | поле добавляется, существующие `file`/`path`/`count`/`remaining` не трогаются — `smoke.js:296-301` остаётся зелёным |
| 11 | запрос с чужим `Origin` начинает получать 403 | правило сформулировано «отклоняем только при явно чужом заголовке»; отсутствие заголовков пропускается, иначе упали бы все 89 проверок разом |
| 16 | у файлов PR-а нет `untracked` | `review.js:246` уже приводит через `Boolean(...)`, отсутствующий признак становится `false` (спек 1.2) |
| 17 | фронт начинает слать дескриптор в query у POST/PUT/DELETE | сервер принимает и отсутствие дескриптора (дефолты), поэтому старый и новый фронт совместимы с новым сервером |

---

## Принятые ограничения, которые план сохраняет как есть

Это не то, что «решится по ходу», — это то, что подтверждено в спеке (раздел 7) и остаётся таким:

1. `~/.local-review/` **растёт вечно**: ни `.gitignore`, ни автоочистки. Путь и число хранимых PR-ов видны на экране поиска (задача 19, шаг 3).
2. `gh` — **обязательная зависимость PR-режима**. Локальный режим без него работает полностью.
3. **Доверенная граница расширяется**: путь к репозиторию приходит от клиента. Смягчено `Origin`/`Sec-Fetch-Site` (задача 11) и привязкой к `127.0.0.1`.
4. **Ветка в глобальном поиске не показывается** (`—`): `gh search prs --json` её не отдаёт, проверено на `gh 2.96.0`.
5. **Для PR-а, дифф которого GitHub отдать отказался, запасной дороги нет**: читаемое сообщение и ссылка на PR (задача 16, фикстура для номера 27).
6. `CommentStore` **меняет сигнатуру конструктора** — задача 5, ловится прогоном, а не предположением.
7. **Запись `.local-review/` в `.gitignore` каждого открытого проекта** — поведение сохранено, но только после подтверждения выбора папки и с показом факта в UI (задача 10, задача 18 шаг 3).
