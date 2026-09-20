#!/usr/bin/env node
'use strict';

// `yarn dev` — оба процесса разработки в одном терминале: API (этот сервер,
// без статики) и vite с фронтом. Порознь они тоже запускаются: `yarn dev:api`
// и `yarn dev:frontend`.
//
// Никаких зависимостей: сервер тулы их не имеет, и лаунчер не заводит.

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// Через node, а не через bin-шим: на Windows .cmd-шим требует shell, а shell
// ломает передачу SIGINT дочернему процессу. Путь считаем от package.json:
// подпуть 'vite/bin/vite.js' не объявлен в exports и через require.resolve
// не находится.
const VITE_BIN = path.join(
  path.dirname(require.resolve('vite/package.json', { paths: [ROOT] })),
  'bin',
  'vite.js'
);

// Флаги после `yarn dev` уходят серверу API: `yarn dev --staged`,
// `yarn dev --base origin/main`. Адрес — нет: прокси vite прибит к
// 127.0.0.1:4321, и уехавший сервер до него не дойдёт.
const PINNED = ['--port', '--host'];
const extraArgs = process.argv.slice(2);
const pinnedArg = extraArgs.find((arg) => PINNED.includes(arg.split('=')[0]));
if (pinnedArg) {
  process.stdout.write(
    `\n  ${pinnedArg} в yarn dev не поддержан: прокси vite прибит к 127.0.0.1:4321.\n` +
      '  Нужен другой адрес — запускай yarn dev:api и yarn dev:frontend порознь.\n\n'
  );
  process.exit(1);
}

const TASKS = [
  {
    name: 'api ',
    args: [
      path.join(__dirname, 'review.js'),
      '--no-open',
      '--api-only',
      '--strict-port',
      '--port',
      '4321',
      ...extraArgs,
    ],
  },
  {
    name: 'web ',
    args: [VITE_BIN, '--config', path.join(__dirname, 'web', 'vite.config.mts')],
  },
];

const children = [];
let shuttingDown = false;

// Хвост без \n — это незавершённая строка: она дойдёт следующим чанком,
// и печатать её сразу нельзя: префикс воткнётся в середину строки, а при двух
// детях чужой вывод разрежет её пополам.
const tails = new Map();

function prefix(name, chunk) {
  const lines = ((tails.get(name) || '') + chunk.toString()).split('\n');
  tails.set(name, lines.pop());
  for (const line of lines) process.stdout.write(`  ${name}│ ${line}\n`);
}

function flushTail(name) {
  const tail = tails.get(name);
  if (tail) process.stdout.write(`  ${name}│ ${tail}\n`);
  tails.set(name, '');
}

function stopAll(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal || 'SIGTERM');
  }
}

for (const task of TASKS) {
  const child = spawn(process.execPath, task.args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (chunk) => prefix(task.name, chunk));
  child.stderr.on('data', (chunk) => prefix(task.name, chunk));
  // Одна половина дева без другой бесполезна: упал API — vite проксирует в
  // пустоту, упал vite — смотреть нечего. Уходим вместе и с кодом упавшего —
  // именно упавшего: у добитого сиблинга своего кода нет, перетирать им нельзя.
  child.on('exit', (code, signal) => {
    const firstToGo = !shuttingDown;
    flushTail(task.name);
    if (firstToGo) {
      const how = signal ? `сигнал ${signal}` : `код ${code}`;
      process.stdout.write(
        `\n  ${task.name}│ процесс завершился (${how}) — останавливаю остальные\n`
      );
      // Ctrl+C — штатный выход, а не падение: и смерть по сигналу, и код
      // 128+SIGINT/SIGTERM, которым отвечает vite, — это «нас остановили».
      const killed =
        signal === 'SIGINT' || signal === 'SIGTERM' || code === 130 || code === 143;
      process.exitCode = killed ? 0 : code === null ? 1 : code;
    }
    stopAll();
  });
  child.on('error', (err) => {
    process.stdout.write(`\n  ${task.name}│ не удалось запустить: ${err.message}\n`);
    if (!shuttingDown) process.exitCode = 1;
    stopAll();
  });
}

// Ctrl+C в терминале приходит обоим детям сам, но SIGINT у родителя не должен
// оставить их сиротами, если они его не получили.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll(signal));
}

process.stdout.write(
  '\n  api   http://127.0.0.1:4321/  — только /api\n' +
    '  web   http://127.0.0.1:5173/  — UI, /api проксируется на 4321\n\n' +
    '  Ctrl+C — выход\n\n'
);
