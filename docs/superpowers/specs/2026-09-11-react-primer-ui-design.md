# local-review: новый UI — React + Primer + CodeMirror

Дата: 2026-09-11
Статус: согласовано в чате, к реализации

## Задача

Заменить самописный vanilla-фронт (`tools/local-review/public/`) на React-приложение
в стиле GitHub (дизайн-система Primer), а построчный дифф — на CodeMirror 6.
Функциональность обоих режимов (локальная папка и GitHub PR) сохраняется 1:1.
Архитектура готовит следующий подпроект — подключение LSP (сначала TypeScript).

## Что меняется по сравнению с прошлым spec

Spec `2026-09-05-local-review-two-modes-design.md` запрещал npm-зависимости,
бандлеры и фреймворки. Это решение пересмотрено: UI будет расти (LSP, поиск,
дерево файлов), самописный DOM это не вытянет. Ограничение остаётся для
**сервера**: runtime-зависимостей у node-сервера по-прежнему ноль, всё новое —
`devDependencies`, которые вшиваются в бандл фронта.

## За рамками

- LSP (отдельный подпроект; для PR-режима он потребует checkout кода).
- Изменение модели комментариев, хранилища, экспорта.
- Комментарии к удалённым строкам (сейчас их тоже нет — `diff-view.js:85-89`).
- Split (side-by-side) view.

## Зафиксированные решения

| Тема | Решение |
|---|---|
| Фреймворк | React 19 + TypeScript + Vite |
| UI-кит | `@primer/react` v38 (CSS Modules, без styled-components), `@primer/primitives`, `@primer/octicons-react` |
| Дифф | CodeMirror 6: `@codemirror/merge` `unifiedMergeView`, read-only |
| Подсветка синтаксиса | `@codemirror/language-data` (ленивая загрузка языка по имени файла) |
| Тема | по умолчанию — как в ОС; переключатель auto / light / dark в шапке, выбор в `localStorage` |
| Toast | свой компонент (в Primer toast нет) |
| Состояние | React state + context, без стейт-менеджеров |
| Роутинг | свой hash-роутер, формат URL прежний (`#/local/<root>`, `#/pr/<host>/<owner>/<repo>/<n>`) |
| Сборка | фронт в `tools/local-review/web/`, сборка в `tools/local-review/dist/` (в `.gitignore`), `prepare` собирает при `npm install` |

## 1. Структура, сборка, отдача

- `tools/local-review/web/` — Vite-проект: `index.html`, `src/`, `vite.config.ts`,
  `tsconfig.json`. `vite build` пишет в `tools/local-review/dist/`.
- Все npm-пакеты — `devDependencies` корневого `package.json`. Скрипты: `build`,
  `dev`, `typecheck`, `test:web`, `prepare`.
- Сервер: `PUBLIC_DIR` → `dist/` (`lib/http.js:6`), переопределяется
  `LOCAL_REVIEW_STATIC_DIR` (точка подмены для smoke, по образцу
  `LOCAL_REVIEW_GH_BIN`). MIME дополняется `.map .json .woff2 .png .wasm`.
  Если `index.html` в статике нет — `review` при старте пишет
  «UI не собран: выполни `npm run build`» и выходит с ненулевым кодом.
- Разработка: `npm run dev` — Vite на :5173 с proxy `/api` → `127.0.0.1:4321`
  без `changeOrigin`: заголовки `Host` и `Origin` оба `localhost:5173`,
  `checkOrigin` (`lib/http.js:96-108`) это пропускает.
- `public/` удаляется.

## 2. Сервер: полные тексты файлов

`/api/diff` дополнительно отдаёт `oldText: string | null` и `newText: string | null`.
Прежние поля (`hunks`, `additions`, `deletions`, `status`, `binary`, …) не
меняются — существующий контракт `smoke.js` остаётся в силе.

`null`: binary, missing, отсутствующая сторона (`oldText` у добавленного и
untracked; `newText` у удалённого), слишком большой файл (> 5 МБ) — тогда
добавляется `textUnavailable: '<причина>'`.

Local (`lib/diff.js`, новый `gitShow` в `lib/git.js`), `old = oldPath ?? path`:

| mode | oldText | newText |
|---|---|---|
| working | `git show HEAD:<old>` (нет HEAD или файл добавлен → `null`) | файл с диска |
| staged | `git show HEAD:<old>` | `git show :<path>` |
| base | `git show <merge-base>:<old>` | файл с диска |
| untracked | `null` | файл с диска |

PR (`lib/sources/pr-source.js`):
- Один раз на PR (кэш 120 с, как у diff): `gh pr view --json baseRefOid,headRefOid`,
  затем `gh api repos/{o}/{r}/compare/{baseRefOid}...{headRefOid}` → `merge_base_commit.sha`.
- На файл: содержимое по SHA через `gh api` (raw contents), `oldText` — на
  merge-base, `newText` — на head. Кэш в памяти по `(sha, path)`.
- Точный вызов `gh api` для raw-контента и его лимиты проверяются при реализации
  и фиксируются в коде комментарием.

Структура диффа — из git, не из CodeMirror. Собственный посимвольный дифф
CodeMirror на коде находил случайные совпадения внутри вставленных блоков и
склеивал нетронутые строки в один большой «изменённый» блок (проверено на
`lib/http.js`). Поэтому клиент передаёт в `unifiedMergeView` свой
`diffConfig.override`, построенный из `hunks` ответа (`web/src/diff/gitDiff.ts`):
блоки строк — ровно как в `git diff`, посимвольный дифф — только внутри пар
«удалённая строка ↔ добавленная строка» (для подсветки слов, как на GitHub).
Если hunks не описывают полученные тексты (проверяется, что всё между блоками
совпадает побайтно), используется дифф CodeMirror.

## 3. Фронт: экраны и компоненты Primer

- **Шапка:** бренд — имя открытого репозитория (для PR — `owner/repo #N`),
  вне репозитория и в настройках `local-review`; то же и в `document.title`; `UnderlineNav` «Папка» / «GitHub PR»; путь репо;
  `SegmentedControl` working / staged / base + `TextInput` для base;
  `IconButton` reload; `CounterLabel` с числом комментариев; кнопки
  «Скопировать всё», «Сгенерировать .md», «Очистить всё» (danger);
  `ActionMenu` темы.
- **Локальная папка:** путь + «вверх», список каталогов (`ActionList`),
  метка «репозиторий», кнопка «открыть»; недавние; ручной ввод пути;
  ошибка — `Banner`; подтверждение корня — `Dialog`.
- **GitHub PR:** статус gh (`Banner`, если не установлен / не залогинен);
  форма owner/repo, запрос, состояние (`Select`), «Искать»; список PR
  (номер, заголовок, мета, «открыть»); строка про каталог хранения.
- **Дифф-экран:** шапка PR (для PR); слева `TreeView` файлов, сгруппированных
  по каталогам, со статусом (иконка A/M/D/R/U), счётчиком комментариев и
  секцией «вне диффа»; справа — шапка файла (путь, rename, +N −M,
  «комментарий к файлу»), блок «комментарии к файлу / вне видимой части»,
  редактор диффа.
- **Очистить всё:** `Dialog` подтверждения, как сейчас.

## 4. Дифф на CodeMirror

Один `EditorView` на выбранный файл:
- документ — `newText`, `unifiedMergeView({ original: oldText, mergeControls: false,
  syntaxHighlightDeletions: true })`, `EditorState.readOnly`, `EditorView.editable(false)`;
- свёртка неизменённых участков — своя (а не `collapseUnchanged`), чтобы строки
  с комментариями никогда не сворачивались; клик по свёрнутому блоку разворачивает;
- гаттеры: старый номер (свой gutter по chunks, для удалённых строк — через
  `widgetMarker`) и новый номер (`lineNumbers`);
- выделение строк: клик по номеру — строка, протяжка — диапазон, Shift+клик —
  расширить; после отпускания открывается редактор под последней строкой;
- комментарии и редактор — block-виджеты под строкой `endLine`; содержимое
  рендерится React-порталами (Primer-контекст и тема сохраняются); высоту
  виджета CodeMirror перемеряет по `ResizeObserver`;
- Ctrl+Enter — сохранить, Esc — отмена / сброс выделения;
- цвета — только CSS-переменные Primer, поэтому смена темы не требует
  переконфигурации редактора;
- binary / missing / «вне диффа» / нет изменений содержимого — `Blankslate`.
- Лимит в 20000 строк (`diff-view.js:7`) убирается: CodeMirror рендерит только
  видимую часть.

## 5. Ошибки и тесты

- Ошибки API — toast (как сейчас); ошибки на экранах выбора — на экране.
- `smoke.js`: `oldText`/`newText` для working/staged/base, untracked, deleted,
  rename, binary; PR через расширенный `gh-fixture.js` (compare + contents),
  включая merge-base вместо `baseRefOid`; GET `/` отдаёт `index.html` из
  подменённой статики.
- Vitest для чистой логики фронта: маппинг старых номеров строк, свёртка с
  учётом комментариев, нормализация выделения, hash ↔ descriptor, дерево файлов,
  построение изменений из hunks (включая новые/удалённые файлы и края файла;
  главный инвариант — применение изменений к старому тексту даёт новый).
- Ручная проверка в браузере обоих режимов и обеих тем.
