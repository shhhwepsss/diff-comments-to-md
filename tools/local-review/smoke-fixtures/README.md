# smoke-fixtures

`gh-fixture.js` — подставной `gh` для `smoke.js`: отвечает по JSON-манифесту,
путь к которому лежит в `LOCAL_REVIEW_GH_FIXTURES`. Реальная сеть в автотесте
не используется ни разу.

Это `.js`, а не `.cmd`/`.sh`, потому что Node отказывается спавнить `.cmd` при
`shell: false`, а `shell: true` в проде запрещён (пути и поисковые строки
содержат пробелы и кириллицу). `lib/gh.js` видит, что `LOCAL_REVIEW_GH_BIN`
оканчивается на `.js`, и запускает файл текущим `process.execPath`.

`folder-dialog-fixture.js` — подставной системный диалог выбора папки для
`POST /api/local/pick-folder`. Включается через `LOCAL_REVIEW_FOLDER_DIALOG_BIN`;
что напечатать и с каким кодом выйти, задаёт JSON в
`LOCAL_REVIEW_FOLDER_DIALOG_RESULT` (`code`, `stdout`, `stderr`, `delayMs`).

`lsp-fixture.js` — подставной language server для LSP-проверок `smoke.js`:
говорит по stdio с framing `Content-Length`, отвечает на `initialize`,
`definition` (ищет объявление слова под курсором) и `hover` (возвращает слово и
версию документа, чтобы было видно `didOpen`/`didChange`), `references` (все
вхождения слова и одно место вне репозитория), `implementation`
(`class X implements <слово>`) и иерархию вызовов (`prepareCallHierarchy`,
`incomingCalls`, `outgoingCalls` — по строкам `function name` и вызовам
`name(`). На слово `crash` падает с кодом 3. `LOCAL_REVIEW_LSP_FIXTURE_DROP`
(имена capabilities через запятую) убирает их из ответа на `initialize` — для
проверки «сервер не поддерживает». Смоук кладёт запускалку для него в
`node_modules/.bin/typescript-language-server` временного репозитория, так что
`lib/lsp/registry.js` находит его тем же путём, что и настоящий сервер.
