# smoke-fixtures

`gh-fixture.js` — подставной `gh` для `smoke.js`: отвечает по JSON-манифесту,
путь к которому лежит в `LOCAL_REVIEW_GH_FIXTURES`. Реальная сеть в автотесте
не используется ни разу.

Это `.js`, а не `.cmd`/`.sh`, потому что Node отказывается спавнить `.cmd` при
`shell: false`, а `shell: true` в проде запрещён (пути и поисковые строки
содержат пробелы и кириллицу). `lib/gh.js` видит, что `LOCAL_REVIEW_GH_BIN`
оканчивается на `.js`, и запускает файл текущим `process.execPath`.
