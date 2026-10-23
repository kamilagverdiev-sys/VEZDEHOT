#!/usr/bin/env node
'use strict';

// Read-only Monte Carlo audit. No browser, storage, network, or production edits.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const DIFFICULTIES = ['easy', 'normal', 'hard'];
const POLICIES = ['random', 'greedycurrent', 'coverage-aware'];
const TAGS = ['medical', 'technical', 'food', 'survival', 'social'];
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function seedFor(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest().readUInt32LE(0);
}
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let x = state;
    x = Math.imul(x ^ x >>> 15, x | 1);
    x ^= x + Math.imul(x ^ x >>> 7, x | 61);
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

function harness() {
  const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
  const start = html.indexOf('    const BUNKER_VERSION=2;');
  const end = html.indexOf('    function canHumanAttack', start);
  const shuffle = html.match(/    function shuffle\(a\)\{[^\n]+\}/)?.[0];
  assert(start >= 0 && end > start && shuffle, 'Production engine boundaries changed');
  const source = shuffle + '\n' + html.slice(start, end);
  const ctx = {
    Math: Object.assign(Object.create(Math), {random: () => { throw Error('Set trial seed first'); }}),
    Date: {now: () => 1700000000000},
    s: {}, botNames: ['A', 'B', 'C', 'D', 'E'], avatars: ['A', 'B', 'C', 'D', 'E'],
    save() {}, render() {}, toast(message) { throw Error(message); }
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nthis.api={startBunker,bunkerHumanReveal,bunkerHumanVote,bunkerContinue,bunkerEvent,bunkerCardValue,scenarios:bunkerScenarios};', ctx);
  return {ctx, api: ctx.api, engineSha256: hash(source), htmlSha256: hash(html)};
}

// No engine object reaches a policy. Future events, bot style, hidden opponent
// traits, votes not yet cast, and RNG state are deliberately absent.
function observation(g, api) {
  return {
    round: g.round, phase: g.phase, focus: g.scenario.focus, current: api.bunkerEvent(g).focus,
    players: Array.from(g.players, (p, seat) => ({seat, alive: p.alive,
      cards: Array.from(p.cards).flatMap((c, index) => seat === 0 || c.revealed ? [{
        index, revealed: c.revealed, score: c.score, tags: [...(c.tags || [])], value: api.bunkerCardValue(c, g)
      }] : [])
    }))
  };
}
const publicTags = p => new Set(p.cards.filter(c => c.revealed).flatMap(c => c.tags));
const need = (tag, o) => (tag === o.focus ? 1.2 : 0) + (tag === o.current ? 1.5 : 0) || .6;
function coverage(o, omit = -1) {
  const counts = Object.fromEntries(TAGS.map(tag => [tag, 0]));
  for (const p of o.players) if (p.alive && p.seat !== omit) {
    for (const tag of publicTags(p)) counts[tag]++;
  }
  return counts;
}
function pick(items, score, random, maximize) {
  const rated = items.map(item => ({item, score: score(item)}));
  const best = (maximize ? Math.max : Math.min)(...rated.map(x => x.score));
  const tied = rated.filter(x => Math.abs(x.score - best) < 1e-9);
  assert(tied.length, 'Policy has no legal choices');
  return tied[Math.floor(random() * tied.length)].item;
}
function decide(o, policy, random) {
  assert(POLICIES.includes(policy));
  if (o.phase === 'reveal') {
    const hidden = o.players[0].cards.filter(c => !c.revealed);
    if (policy === 'random') return hidden[Math.floor(random() * hidden.length)].index;
    const counts = coverage(o, 0), known = publicTags(o.players[0]);
    return pick(hidden, c => c.value + (policy === 'coverage-aware' ? 2 * [...new Set(c.tags)]
      .filter(tag => !known.has(tag)).reduce((sum, tag) => sum + need(tag, o) / (1 + counts[tag]), 0) : 0), random, true).index;
  }
  assert.equal(o.phase, 'vote');
  const others = o.players.filter(p => p.alive && p.seat !== 0);
  if (policy === 'random') return others[Math.floor(random() * others.length)].seat;
  const counts = coverage(o);
  return pick(others, p => p.cards.reduce((sum, c) => sum + c.value, 0) +
    (policy === 'coverage-aware' ? 2 * [...publicTags(p)].reduce((sum, tag) => sum + need(tag, o) / counts[tag], 0) : 0), random, false).seat;
}

function trial(h, scenario, difficulty, policy, seed, includeTrace = false) {
  const {ctx, api} = h;
  ctx.Math.random = rng(seedFor(seed, 'engine'));
  const humanRandom = rng(seedFor(seed, 'human')); // never consumes the engine stream
  ctx.s = {nick: 'Human policy', balance: 10000, games: 0, wins: 0, xp: 0, view: 'bunker'};
  api.startBunker({diff: difficulty, scenarioChoice: scenario});
  const g = ctx.s.game;
  assert.equal(ctx.s.balance, 9900);
  const deal = hash(JSON.stringify({players: g.players, events: g.events}));
  const trace = [];
  for (let round = 1; !g.over; round++) {
    assert(round <= 3 && g.round === round && g.phase === 'reveal');
    const reveal = decide(observation(g, api), policy, humanRandom);
    assert(!g.players[0].cards[reveal].revealed);
    api.bunkerHumanReveal(reveal);
    assert.equal(g.phase, 'vote');
    const vote = decide(observation(g, api), policy, humanRandom);
    assert(vote !== 0 && g.players[vote].alive);
    const alive = g.players.filter(p => p.alive).length;
    api.bunkerHumanVote(vote);
    assert.equal(g.phase, 'voteResult');
    assert.equal(g.votes.reduce((a, b) => a + b, 0), alive);
    assert.equal(g.players.filter(p => p.alive).length, alive - 1);
    if (includeTrace) trace.push({round, reveal, vote, out: g.lastVote.out, ballots: clone(g.lastVote.ballots)});
    api.bunkerContinue();
  }
  assert(g.settled && g.result === (g.players[0].alive ? 'survived' : 'lost'));
  const win = Number(g.result === 'survived');
  assert.equal(ctx.s.balance - 10000, 250 * win - 100);
  assert.equal(ctx.s.games, 1);
  if (win) assert.equal(g.players.filter(p => p.alive).length, 3);
  return {win, rounds: g.round, deal, ...(includeTrace ? {trace} : {})};
}

function wilson(wins, n) {
  const z = 1.959963984540054, p = wins / n, z2 = z * z, divisor = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / divisor;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / divisor;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function pairedDelta(a, b) {
  assert.equal(a.length, b.length);
  const n = a.length, diffs = a.map((value, i) => value - b[i]);
  const mean = diffs.reduce((sum, x) => sum + x, 0) / n;
  const variance = diffs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1);
  const half = 1.959963984540054 * Math.sqrt(variance / n);
  return {mean, ci95: [Math.max(-1, mean - half), Math.min(1, mean + half)]};
}
function summarize(outcomes) {
  const n = outcomes.length, wins = outcomes.reduce((sum, result) => sum + result, 0);
  return {n, wins, rate: wins / n, ci95: wilson(wins, n), meanCoins: 250 * wins / n - 100};
}

function selfTest(h) {
  const scenario = h.api.scenarios[0].code;
  const first = trial(h, scenario, 'hard', 'coverage-aware', 23112, true);
  assert.deepEqual(trial(h, scenario, 'hard', 'coverage-aware', 23112, true), first);
  for (const difficulty of DIFFICULTIES) for (const policy of POLICIES) {
    assert.equal(trial(h, scenario, difficulty, policy, 23112).deal, first.deal, 'Same seed must preserve the starting deal/events');
  }
  h.ctx.s.game = null; h.ctx.s.balance = 10000; h.ctx.Math.random = rng(8181);
  h.api.startBunker({diff: 'hard', scenarioChoice: scenario});
  const g = h.ctx.s.game;
  for (const phase of ['reveal', 'vote']) {
    if (phase === 'vote') h.api.bunkerHumanReveal(0);
    const before = observation(g, h.api), changed = clone(g);
    changed.players.slice(1).forEach(p => p.cards.filter(c => !c.revealed).forEach(c => {
      for (const field of ['score', 'tags', 'title']) Object.defineProperty(c, field, {get() { throw Error('Hidden opponent read: ' + field); }});
    }));
    for (let i = changed.round; i < changed.events.length; i++) {
      Object.defineProperty(changed.events, i, {get() { throw Error('Future event read'); }});
    }
    const after = observation(changed, h.api);
    assert.deepEqual(after, before);
    const frozen = value => {if (value && typeof value === 'object') {Object.values(value).forEach(frozen); Object.freeze(value);} return value;};
    for (const policy of POLICIES) assert.equal(decide(frozen(after), policy, rng(17)), decide(before, policy, rng(17)));
  }
  assert.deepEqual(wilson(0, 100).map(x => Math.round(x * 1000)), [0, 37]);
  assert.deepEqual(pairedDelta([1, 0, 1], [1, 0, 1]), {mean: 0, ci95: [0, 0]});
  // Two stories with the same focus must have identical mechanics, not just close rates.
  for (const focus of TAGS) {
    const pair = h.api.scenarios.filter(s => s.focus === focus);
    assert.equal(pair.length, 2);
    for (const difficulty of DIFFICULTIES) for (const policy of POLICIES) for (let i = 0; i < 10; i++) {
      assert.deepEqual(trial(h, pair[0].code, difficulty, policy, i + 600, true), trial(h, pair[1].code, difficulty, policy, i + 600, true));
    }
  }
}

function run({samples = 1000, seed = 'bunker-balance-2026-10-23-v1'} = {}) {
  assert(Number.isSafeInteger(samples) && samples >= 2 && samples <= 100000);
  const h = harness();
  selfTest(h);
  const cells = [], raw = {}, aggregate = [];
  for (const scenario of h.api.scenarios) {
    for (const difficulty of DIFFICULTIES) for (const policy of POLICIES) {
      const outcomes = [];
      for (let i = 0; i < samples; i++) outcomes.push(trial(h, scenario.code, difficulty, policy, seedFor(seed, scenario.code, i)).win);
      const key = [scenario.code, difficulty, policy].join('|'); raw[key] = outcomes;
      cells.push({scenario: scenario.code, name: scenario.name, focus: scenario.focus, difficulty, policy, ...summarize(outcomes)});
    }
    process.stderr.write('Measured ' + scenario.code + '\n');
  }
  for (const difficulty of DIFFICULTIES) for (const policy of POLICIES) {
    const outcomes = h.api.scenarios.flatMap(s => raw[[s.code, difficulty, policy].join('|')]);
    const baseline = h.api.scenarios.flatMap(s => raw[[s.code, difficulty, 'random'].join('|')]);
    aggregate.push({difficulty, policy, ...summarize(outcomes), deltaRandom: pairedDelta(outcomes, baseline)});
  }
  const hardMinusEasy = POLICIES.map(policy => ({policy, ...pairedDelta(
    h.api.scenarios.flatMap(s => raw[[s.code, 'hard', policy].join('|')]),
    h.api.scenarios.flatMap(s => raw[[s.code, 'easy', policy].join('|')])
  )}));
  return {method: 'production-engine/public-observation/v1', seed, samplesPerCell: samples,
    games: samples * cells.length, node: process.version, engineSha256: h.engineSha256,
    htmlSha256: h.htmlSha256, outcomeSha256: hash(JSON.stringify(raw)), cells, aggregate, hardMinusEasy};
}

function markdown(r) {
  const pct = value => (value * 100).toFixed(1);
  const interval = range => range.map(pct).join('–');
  const signed = value => (value > 0 ? '+' : '') + pct(value);
  const rate = cell => `${pct(cell.rate)}% [${interval(cell.ci95)}]`;
  const diffName = {easy: 'Мягкие', normal: 'Рассудительные', hard: 'Расчётливые'};
  const rows = r.aggregate.map(cell => `| ${diffName[cell.difficulty]} | ${cell.policy} | ${cell.wins}/${cell.n} | ${rate(cell)} | ${cell.policy === 'random' ? 'baseline' : `${signed(cell.deltaRandom.mean)} [${cell.deltaRandom.ci95.map(signed).join('; ')}]`} | ${cell.meanCoins.toFixed(1)} |`);
  const cellRows = [];
  for (const scenario of [...new Set(r.cells.map(c => c.scenario))]) for (const difficulty of DIFFICULTIES) {
    const cells = POLICIES.map(policy => r.cells.find(c => c.scenario === scenario && c.difficulty === difficulty && c.policy === policy));
    cellRows.push(`| ${scenario} · ${cells[0].focus} | ${diffName[difficulty]} | ${cells.map(rate).join(' | ')} |`);
  }
  const spreads = r.aggregate.map(cell => {
    const sorted = r.cells.filter(c => c.difficulty === cell.difficulty && c.policy === cell.policy).sort((a, b) => a.rate - b.rate);
    return `| ${diffName[cell.difficulty]} | ${cell.policy} | ${pct(sorted[0].rate)}% · ${sorted[0].scenario} | ${pct(sorted.at(-1).rate)}% · ${sorted.at(-1).scenario} |`;
  });
  return `# Баланс «Бункера»: воспроизводимый замер

Замер 2026-10-23: **${r.games.toLocaleString('en-US')} партий**, 10 сценариев × 3 сложности × 3 политики × ${r.samplesPerCell} запусков. Изменений рабочего движка или коэффициентов ради этого отчёта нет. Выигрыш означает, что человек остался в тройке; это не прогноз выживания собранной команды.

## Как повторить

\`\`\`sh
node scripts/bunker-balance.cjs --self-test
node scripts/bunker-balance.cjs --samples ${r.samplesPerCell} --seed ${r.seed} --output docs/BUNKER_BALANCE.md
node scripts/bunker-balance.cjs --samples 200 --format json --output /tmp/bunker-balance.json
\`\`\`

Запуск работает из любой папки, без зависимостей, браузера, сети и сохранений пользователя. По умолчанию выводит Markdown в stdout; \`--format json\` сохраняет точные числа и метаданные. Отчёт отражает конкретный снимок исходника, а не автоматически обновляемую статистику. Небольшие пилоты полезны для проверки выполнения, не для настройки по единичным ячейкам.

- Среда: ${r.node}; PRNG Mulberry32. Seed: \`${r.seed}\`.
- SHA-256 извлечённого production-фрагмента вместе с production-shuffle: \`${r.engineSha256}\`.
- SHA-256 полного \`dist/index.html\`: \`${r.htmlSha256}\`.
- SHA-256 упорядоченного массива бинарных результатов: \`${r.outcomeSha256}\`.

## Метод и границы доступа

Скрипт извлекает исходные функции из \`dist/index.html\`. Каждая партия проходит реальную цепочку \`startBunker → bunkerHumanReveal → bunkerHumanVote → bunkerContinue\`, включая действующих ботов, жеребьёвку, исключение, остановку при проигрыше и единственное начисление результата. Только DOM/render/save заменены пустыми функциями; профиль существует внутри VM и удаляется перед следующей партией. Дата фиксирована, случайность движка воспроизводима. На каждом ходе проверяются допустимость раскрытия и голоса, число бюллетеней, исключение ровно одного кандидата, завершение максимум за три раунда и реальное начисление +150/−100 игровых V.

Политика человека получает отдельный снимок: своё полное досье, открытые карты остальных, живые места, текущий раунд, постоянный и **только текущий** приоритет. Скрытых чужих характеристик, будущих событий, случайного состояния и ещё не поданных голосов в снимке нет. Снимок не содержит ссылок на игру. Self-test заменяет скрытые значения и будущие события бросающими ошибку getters: решения продолжают работать и не меняются; замороженный снимок не изменяется.

Политики заданы до финального замера и не подбирались под его результаты:

- **random:** равномерное случайное раскрытие среди своих закрытых карт и случайный голос против живого соперника. Это baseline человека против обычных production-ботов выбранной сложности, а не режим, где все шесть игроков случайны.
- **greedycurrent:** раскрыть карту с максимальной текущей пользой (база +2 за сценарий +3 за событие); голосовать против соперника с минимальной суммой открытой пользы. Равенства разрешаются случайно.
- **coverage-aware:** та же текущая польза плюс фиксированный бонус за разнообразие. Для тега \`need = 1.2 × сценарий + 1.5 × текущее событие\`, а если оба не совпали — 0.6. При раскрытии только новый для себя открытый тег добавляет \`2 × need / (1 + число других живых людей с этим открытым тегом)\`. При голосовании каждый открытый тег кандидата добавляет \`2 × need / число живых людей с этим открытым тегом\`; исключается минимальная итоговая оценка. Это простая эвристика, не оптимальная стратегия и не копия скрытой логики ботов.

Seed каждой стартовой партии — SHA-256(master seed, код сценария, номер испытания), первые 32 бита little-endian. Из него независимо выводятся потоки \`engine\` и \`human\`. Для разных сложностей/политик одного испытания раздача и три запланированных события одинаковы; это проверяется по хешу. Человек не видит будущие события. После разных решений боты потребляют разное число случайных значений: одинаковый seed **не означает одинаковые дальнейшие броски и траектории**. Парные разности ниже сравнивают целые исходы на согласованных стартах, а не изолированный эффект одного хода. Для разных сценариев используются разные стартовые seeds.

## Сводка

Сценарии имеют равный вес. Интервалы выигрыша — 95% Wilson, доли в процентах. Δ к random — парная разность в процентных пунктах с приблизительным 95% интервалом по дисперсии разностей исходов. V — средний результат реальных начислений: \`250 × доля побед − 100\`; это только игровые монеты.

| Сложность | Политика | Побед / партий | Выигрыш, 95% CI | Δ к random, п.п. [95% CI] | Средние V |
|---|---|---:|---:|---:|---:|
${rows.join('\n')}

## Все сценарии

В каждой ячейке ${r.samplesPerCell} партий; формат: доля побед [95% Wilson]. Эти интервалы описывают Monte Carlo-разброс при фиксированной политике, а не гарантируют частоту побед живых игроков.

| Сценарий · бонус | Сложность | random | greedycurrent | coverage-aware |
|---|---|---:|---:|---:|
${cellRows.join('\n')}

Наблюдаемый диапазон по десяти историям:

| Сложность | Политика | Минимум | Максимум |
|---|---|---:|---:|
${spreads.join('\n')}

## Что следует из замера

${r.hardMinusEasy.map(d => `- При фиксированной политике \`${d.policy}\` разность hard − easy: **${signed(d.mean)} п.п.**, приблизительный парный 95% CI [${d.ci95.map(signed).join('; ')}].`).join('\n')}
- Сравнивать сложности нужно при одной и той же политике. Разрыв между случайным и осмысленным раскрытием велик; один общий «процент побед игрока» скрывает это. Результаты не доказывают честность ИИ: отсутствие доступа к скрытым данным проверяется отдельно тестами и границей наблюдений.
- Разница coverage-aware и greedycurrent — сравнение двух конкретных эвристик. По этой таблице нельзя объявлять покрытие оптимальным, оценивать опыт человека или доказывать качество команды после партии. Проигрыш останавливает матч раньше полного формирования тройки, поэтому состав оставшихся в проигранных партиях не используется как финальная командная метрика.
- Пять пар имеют **одинаковую механику**: STORM/PASS, BLACKOUT/DEPTH, WINTER/HARVEST, ASH/POLAR, STATION/SHORE. Длительность и история не входят в расчёты. Self-test проверяет по 90 одинаковых стартов на пару (3 сложности × 3 политики × 10 seeds): полные трассы голосований и результаты совпадают. Разница процентов внутри пары в основной таблице обусловлена независимыми выборками, не балансом этих двух историй.
- Минимумы и максимумы выбраны после просмотра 90 ячеек: их нельзя интерпретировать как подтверждённые «лучший/худший сценарий». Интервалы не скорректированы на множественные сравнения; агрегированный Wilson — приближённое описание равновесной смеси сценариев. Для изменения отдельного приоритета нужны заранее заданное сравнение и независимый повтор.

## Решение по коррекции

**Не менять коэффициенты автоматически по таблице.** Целевой процент побед для каждой аудитории пока не задан; подгонка к 50% была бы произвольной. Даже 0% или 100% в конечной выборке не доказывают невозможность другого исхода. Подтверждённая поправка к интерпретации контента: считать каталог десятью историями с пятью механическими профилями, а не десятью независимыми наборами правил. Если понадобится именно механическое разнообразие, сначала задать отдельные публичные правила сценариев, затем повторить этот аудит; одно изменение текста или срока баланса не меняет.

Для следующего решения нужны реальные анонимные распределения выбранных раскрытий/голосов либо заранее согласованные целевые диапазоны для этих фиксированных политик. Существующие боты, выплаты и вероятности в рамках замера не изменены.
`;
}

if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  let output, format = 'markdown';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--samples') options.samples = Number(args[++i]);
    else if (args[i] === '--seed') options.seed = args[++i];
    else if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--format') {format = args[++i]; assert(['json', 'markdown'].includes(format), 'Format must be json or markdown');}
    else if (args[i] === '--help') {console.log('node scripts/bunker-balance.cjs [--samples 1000] [--seed text] [--format markdown|json] [--output path]\nnode scripts/bunker-balance.cjs --self-test'); process.exit(0);}
    else if (args[i] === '--self-test') {selfTest(harness()); console.log('PASS deterministic replay, legal engine transitions, paired starts, public-only policies, five equivalent scenario pairs, CI checks'); process.exit(0);}
    else throw Error('Unknown argument: ' + args[i]);
  }
  const measurement = run(options), result = format === 'json' ? JSON.stringify(measurement, null, 2) + '\n' : markdown(measurement);
  if (output) fs.writeFileSync(path.resolve(output), result); else process.stdout.write(result);
}
module.exports = {harness, observation, decide, trial, selfTest, rng, seedFor, wilson, pairedDelta, run, markdown};
