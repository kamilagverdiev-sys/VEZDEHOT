'use strict';
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(require('node:path').join(__dirname, '../dist/mafia.html'), 'utf8');
const engine = html.split('// MAFIA_ENGINE_START')[1].split('// MAFIA_ENGINE_END')[0];
const ui = html.split('// MAFIA_UI_START')[1].split('// MAFIA_UI_END')[0];
const selectors = new Map(), groups = new Map(), writes = new Map();
let focusCount = 0, scrolled = [], accountOpens = 0, historyOpens = 0;
const heading = { focus() { focusCount++; }, scrollIntoView(options) { scrolled.push(options); } };
const app = { innerHTML: '', className: '', querySelector: () => heading };
const profile = { nick: 'Игрок', balance: 10000, reduceMotion: false };
const context = {
  console, Date, Math,
  window: { innerWidth: 360, matchMedia: () => ({ matches: false }), VEZDEHOT: {
    getProfile: () => ({ ...profile }), updateProfile: patch => Object.assign(profile, patch), scopeKey: () => 'guest',
    openAccount() { accountOpens++; }, openHistory() { historyOpens++; }
  } },
  document: {
    documentElement: { dataset: { motion: 'full' } }, body: { dataset: {} },
    getElementById: () => app,
    querySelector: selector => selectors.get(selector) || null,
    querySelectorAll: selector => groups.get(selector) || []
  },
  localStorage: { getItem: key => writes.get(key) || null, setItem: (key, value) => writes.set(key, value), removeItem: key => writes.delete(key) }
};
vm.createContext(context); vm.runInContext(engine + '\n' + ui, context);
const run = text => vm.runInContext(text, context);
function fixture(role = 'detective') {
  selectors.clear(); groups.clear(); profile.balance = 10000;
  run('syncProfile();g=newGame();paused=false;uiDetails={};uiPhaseKey=null;uiGameId=null');
  const roles = ['detective', 'mafia', 'mafia', 'doctor', 'civilian', 'civilian', 'civilian'];
  const at = roles.indexOf(role); [roles[0], roles[at]] = [roles[at], roles[0]];
  context.g.players.forEach((p, i) => { p.role = roles[i]; });
  return context.g;
}
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }

test('every phase has its own timeline step, including dawn', () => {
  const g = fixture();
  for (const phase of ['night', 'dawn', 'day', 'vote', 'voteResult']) {
    g.phase = phase; const output = run('phaseBar()');
    assert.equal((output.match(/aria-current="step"/g) || []).length, 1);
    assert.equal((output.match(/class="phase /g) || []).length, 5);
    assert.match(output, /Рассвет/);
  }
});
test('roster never reveals an unchecked hidden role, and labels a confirmed team accurately', () => {
  const g = fixture('civilian');
  let output = run('playerGrid()');
  const bot = output.split('data-target="1"')[1].split('</button>')[0];
  assert.match(bot, /Роль неизвестна/); assert.ok(!bot.includes('мафия'));
  g.knowledge[0] = { 1: 'mafia', 3: 'town' };
  output = run('playerGrid()');
  assert.match(output, /Проверен: мафия/); assert.match(output, /Проверен: не мафия/);
  assert.ok(!output.split('data-target="3"')[1].split('</button>')[0].includes('Доктор'));
});
test('doctor self selection and investigator confirmation are clear without leaking a result early', () => {
  let g = fixture('doctor');
  assert.ok(!run('playerGrid()').split('data-target="0"')[1].split('>')[0].includes('disabled'));
  g = fixture(); g.nightTarget = 1;
  assert.ok(!run('phasePanel()').includes('ЛИЧНАЯ ПРОВЕРКА'));
  g.privateNotes = ['Ночь 1: Луна — мафия.']; g.phase = 'dawn';
  const panel = run('phasePanel()');
  assert.match(panel, /ЛИЧНАЯ ПРОВЕРКА/); assert.match(panel, /Луна — мафия/); assert.match(panel, /data-open-notebook/);
});
test('selection patches target and confirmation in place, preserving the roster', () => {
  const g = fixture(); const note = { classList: { toggle() {} } }, action = { disabled: true }, marks = [];
  groups.set('[data-target]', g.players.map(p => ({ dataset: { target: p.id }, classList: { toggle: (cls, on) => marks.push([p.id, on]) }, setAttribute() {} })));
  selectors.set('.selected-target', note); selectors.set('[data-night-confirm]', action);
  g.nightTarget = 1; app.innerHTML = 'roster stays'; run('renderSelection()');
  assert.equal(app.innerHTML, 'roster stays'); assert.equal(action.disabled, false);
  assert.match(note.innerHTML, /Луна/); assert.ok(!note.innerHTML.includes('мафия'));
  assert.equal(marks.filter(v => v[1]).length, 1);
});
test('spectator interface cannot imply a player vote or night target', () => {
  const g = fixture(); g.players[0].alive = false;
  assert.ok(!run('phasePanel()').includes('class="selected-target'));
  g.phase = 'vote';
  const output = run('phasePanel()'); assert.match(output, /Показать голоса/);
  assert.ok(!output.includes('Подтвердить голос')); assert.ok(!output.includes('class="selected-target'));
  assert.equal((run('playerGrid()').match(/ disabled/g) || []).length, 7);
});
test('pause buttons, profile and history bind all visible instances to their actual actions', () => {
  fixture(); const pauses = [{}, {}], histories = [{}, {}], profiles = [{}];
  groups.set('[data-pause]', pauses); groups.set('[data-history]', histories); groups.set('[data-profile]', profiles);
  run('bind()'); pauses[1].onclick(); assert.equal(context.paused, true);
  pauses[0].onclick(); assert.equal(context.paused, false);
  histories.forEach(b => b.onclick()); profiles[0].onclick();
  assert.equal(historyOpens, 2); assert.equal(accountOpens, 1);
});
test('disclosure state survives manual phases and mobile phase navigation honors reduced motion', () => {
  const g = fixture(); groups.set('[data-detail]', [{ dataset: { detail: 'chronicle' }, open: true }]);
  run('render()'); assert.match(app.innerHTML, /data-detail="chronicle" open/);
  context.document.documentElement.dataset.motion = 'reduced';
  g.phase = 'dawn'; run('render()'); assert.equal(scrolled.at(-1).behavior, 'auto'); assert.ok(focusCount > 0);
  const before = scrolled.length; run('render()'); assert.equal(scrolled.length, before);
  context.document.documentElement.dataset.motion = 'full';
});
test('untrusted player names are escaped in dossier attributes and result messages', () => {
  const g = fixture(); g.players[1].name = '<img src=x onerror="alert(1)">';
  assert.ok(!run('playerGrid()').includes('<img'));
  g.over = true; g.settled = true; g.resultReason = '<script>alert(1)</script>'; g.win = false;
  assert.ok(!run('resultPanel()').includes('<script>'));
});

test('replay opens a new first night with the same difficulty and charges the entry once', () => {
  const old = fixture('civilian'); old.over = true; old.settled = true; old.phase = 'result'; old.diff = 'hard';
  const replay = {}; groups.set('[data-replay]', [replay]); run('bind()');
  replay.onclick();
  assert.notEqual(context.g.id, old.id); assert.equal(context.g.phase, 'night');
  assert.equal(context.g.diff, 'hard'); assert.equal(context.g.over, false);
  assert.equal(profile.balance, 9900); assert.equal(context.paused, false);
  const newId = context.g.id; replay.onclick();
  assert.equal(context.g.id, newId); assert.equal(profile.balance, 9900);
  assert.equal(JSON.parse(writes.get('vezdehot_mafia_v3_guest')).id, newId);
});
test('insufficient replay balance preserves the completed game and shows an actionable error', () => {
  const old = fixture(); old.over = true; old.settled = true; old.phase = 'result'; old.winningTeam = 'town'; old.win = true; old.resultReason = 'Город победил.';
  profile.balance = 50; run('replay()');
  assert.equal(context.g.id, old.id); assert.equal(profile.balance, 50);
  assert.match(app.innerHTML, /role="alert"/); assert.match(app.innerHTML, /Для входа нужно 100 V/);
  assert.match(app.innerHTML, /Результат партии/);
});
test('result explains team victory, eliminated-player credit and net entry accounting', () => {
  const g = fixture('civilian'); g.over = true; g.settled = true; g.phase = 'result'; g.winningTeam = 'town'; g.win = true;
  g.players.forEach(p => { if (p.role === 'mafia' || p.id === 0) p.alive = false; });
  g.resultReason = 'Город нашёл всех участников мафии.';
  const output = run('resultPanel()');
  assert.match(output, /Ты победил вместе с командой/);
  assert.match(output, /Ты выбыл, но результат определяется победой всей команды/);
  assert.match(output, /Мафия 0 · Город 4/);
  assert.match(output, /−100 V/); assert.match(output, /250 V/); assert.match(output, /\+150 V/);
  assert.match(output, /data-replay>Сыграть ещё · 100 V/); assert.match(output, /data-new>Изменить настройки/);
});
test('mafia parity and draw results explain the actual ending condition', () => {
  const g = fixture('civilian'); g.over = true; g.settled = true; g.phase = 'result'; g.win = false; g.winningTeam = 'mafia';
  g.players.forEach(p => { p.alive = p.role === 'mafia' || [0, 3].includes(p.id); });
  let output = run('resultPanel()');
  assert.match(output, /Твоя команда проиграла/); assert.match(output, /Мафии осталось 2, остальных жителей — 2/);
  g.draw = true; g.winningTeam = 'draw'; g.round = 25;
  output = run('resultPanel()'); assert.match(output, /Ничья — ставка возвращена/);
  assert.match(output, /За 25 раундов/); assert.match(output, /<span>Итог<\/span><b>0 V/);
});
test('suspicions remain available while voting and no hidden team counts appear before the end', () => {
  const g = fixture('civilian'); g.phase = 'vote'; g.nightText = 'Все жители встретили рассвет.';
  g.statements = [{ actor: 1, target: 2, text: 'Предлагает присмотреться к Рэю.' }];
  assert.match(run('logs()'), /Версии жителей/); assert.match(run('logs()'), /Предлагает присмотреться к Рэю/);
  const panel = run('phasePanel()'); assert.match(panel, /Версия бота — подозрение, а не раскрытая роль/);
  assert.match(panel, /data-open-statements/); assert.ok(!panel.includes('Мафии осталось'));
});
test('chronicle shows all retained events and identifies reverse chronology', () => {
  const g = fixture(); g.log = Array.from({ length: 40 }, (_, i) => 'Событие ' + (40 - i));
  const output = run('logs()'); assert.match(output, /40 · новые сверху/);
  assert.match(output, /Событие 1<\/li>/); assert.match(output, /Событие 40<\/li>/);
});

test('voting archive remains readable during the next night and never exposes living roles', () => {
  const g = fixture('civilian'); g.phase = 'night'; g.round = 2;
  g.voteHistory = [{ round: 1, ballots: [{ voter: 1, target: 3 }, { voter: 2, target: 4 }], message: 'Голоса разделились.' }];
  const output = run('voteArchive()'); assert.match(output, /Раунд 01/); assert.match(output, /Луна/); assert.match(output, /Мила/);
  assert.ok(!output.includes('Доктор')); assert.ok(!output.includes('Мафия')); assert.match(run('logs()'), /Архив голосований/);
  g.phase = 'vote'; assert.match(run('phasePanel()'), /data-open-vote-archive/);
});
test('archived names and discussion context are escaped and ordered newest first', () => {
  const g = fixture(); g.players[1].name = '<script>bad</script>'; g.phase = 'day';
  g.statements = [{ actor: 1, target: 2, text: 'Версия.', context: '<img src=x>' }];
  g.voteHistory = [1,2].map(round => ({ round, ballots: [{ voter: 1, target: 2 }], message: '<img src=x>' }));
  const output = run('logs()'); assert.ok(!output.includes('<script>')); assert.ok(!output.includes('<img'));
  assert.match(output, /statement-context/); assert.ok(output.indexOf('Раунд 02') < output.indexOf('Раунд 01'));
});
test('past-vote link opens the archive and preserves focus', () => {
  fixture(); let focus = 0, scroll = 0;
  const archive = { open: false, scrollIntoView() { scroll++; }, querySelector() { return { focus() { focus++; } }; } };
  selectors.set('[data-detail="vote-archive"]', archive); const link = {}; groups.set('[data-open-vote-archive]', [link]);
  run('bind()'); link.onclick(); assert.equal(archive.open, true); assert.equal(focus, 1); assert.equal(scroll, 1);
});

test('an interrupted result offers retry without falsely claiming saved progress or replay', () => {
  const g = fixture('civilian'); g.over = true; g.phase = 'result'; g.winningTeam = 'town'; g.win = true; g.settled = false;
  const output = run('resultPanel()'); assert.match(output, /Результат ожидает сохранения/);
  assert.match(output, /data-retry-settlement/); assert.ok(!output.includes('data-replay')); assert.ok(!output.includes('уже сохранён'));
});

test('shared recovery notice is rendered and bound on the setup screen and during a game', () => {
  const rendered = [], bound = [];
  context.window.VEZDEHOT.renderSaveNotice = (game, scope) => { rendered.push([game, scope]); return '<aside role="status">Восстановлена резервная копия</aside>'; };
  context.window.VEZDEHOT.bindSaveNotice = (container, game, scope) => bound.push([container, game, scope]);
  fixture(); run('render()'); assert.match(app.innerHTML, /role="status">Восстановлена резервная копия/);
  run('g=null;render()'); assert.match(app.innerHTML, /Восстановлена резервная копия/);
  assert.deepEqual(rendered, [['mafia', 'guest'], ['mafia', 'guest']]);
  assert.ok(bound.length === 2 && bound.every(item => item[0] === app && item[1] === 'mafia' && item[2] === 'guest'));
  delete context.window.VEZDEHOT.renderSaveNotice; delete context.window.VEZDEHOT.bindSaveNotice;
});

test('stale UI click handlers cannot advance a game after tab ownership is lost', () => {
  const g = fixture(), target = { dataset: { target: '1' } }, confirm = {}, pause = {};
  groups.set('[data-target]', [target]); groups.set('[data-night-confirm]', [confirm]); groups.set('[data-pause]', [pause]);
  run('bind()'); context.window.VEZDEHOT_TAB_SESSION = { canWrite: () => false };
  target.onclick(); confirm.onclick(); pause.onclick();
  assert.equal(g.nightTarget, null); assert.equal(g.phase, 'night'); assert.equal(context.paused, false);
  delete context.window.VEZDEHOT_TAB_SESSION;
});

test('learning opens on a saved pause and does not change the phase, target, role or economy', () => {
  const g = fixture(), guide = {}, trigger = {}, balance = profile.balance;
  g.nightTarget = 1; const before = JSON.stringify(g);
  context.window.VEZDEHOT_GUIDE = { open(options) { Object.assign(guide, options); } };
  selectors.set('[data-rules]', trigger); groups.set('[data-rules]', [trigger]); run('bind()'); trigger.onclick();
  assert.equal(context.paused, true); assert.equal(JSON.parse(writes.get('vezdehot_mafia_v3_guest')).paused, true);
  assert.equal(g.phase, 'night'); assert.equal(g.nightTarget, 1); assert.equal(profile.balance, balance);
  const after = { ...g }; delete after.paused; assert.equal(JSON.stringify(after), before);
  assert.equal(guide.game, 'mafia'); assert.equal(guide.trigger, trigger); assert.equal(guide.lessons.length, 3);
  assert.equal(guide.onClose, undefined, 'closing training must not automatically resume the game');
  delete context.window.VEZDEHOT_GUIDE;
});

test('all three learning situations are standalone and have one explained correct answer', () => {
  const g = fixture('civilian'), baseline = run('JSON.stringify(mafiaLessons())'), lessons = JSON.parse(baseline);
  assert.equal(new Set(lessons.map(lesson => lesson.id)).size, 3);
  for (const lesson of lessons) { assert.equal(lesson.choices.filter(choice => choice.correct).length, 1); assert.ok(lesson.choices.every(choice => choice.feedback && choice.label)); }
  assert.match(lessons[0].choices.find(choice => choice.correct).feedback, /предположением/);
  assert.match(lessons[1].choices.find(choice => choice.correct).feedback, /выбывшим/);
  assert.match(lessons[2].choices.find(choice => choice.correct).feedback, /Подтверждение/);
  g.players.forEach(p => { p.role = 'mafia'; }); g.knowledge = { 0: { 1: 'mafia' } }; g.phase = 'vote';
  assert.equal(run('JSON.stringify(mafiaLessons())'), baseline); run('g=null'); assert.equal(run('JSON.stringify(mafiaLessons())'), baseline);
});

test('mobile learning returns focus to the invoked visible control instead of the hidden header button', () => {
  fixture(); const header = {}, footer = {}; let received;
  context.window.VEZDEHOT_GUIDE = { open(options) { received = options; } };
  groups.set('[data-rules]', [header, footer]); selectors.set('[data-rules]', header); run('bind()');
  footer.onclick({ currentTarget: footer }); assert.equal(received.trigger, footer);
  delete context.window.VEZDEHOT_GUIDE;
});

test('context and personal notebook never reveal unconfirmed roles or other players private knowledge', () => {
  const g = fixture('civilian'); g.personalMarks = { 1: 'suspect', 2: 'trust' }; g.phase = 'vote';
  const contextBefore = run('JSON.stringify(mafiaContext())'), notebookBefore = run('personalNotebook()');
  [g.players[1].role, g.players[4].role] = [g.players[4].role, g.players[1].role]; g.knowledge[3] = { 1: 'mafia' };
  assert.equal(run('JSON.stringify(mafiaContext())'), contextBefore); assert.equal(run('personalNotebook()'), notebookBefore);
  assert.match(notebookBefore, /Боты их не видят/); assert.match(notebookBefore, /не раскрывают роли/);
  g.players[1].name = '<img src=x onerror=alert(1)>'; assert.ok(!run('personalNotebook()').includes('<img'));
});

test('common journals preserve round labels, reverse chronology, privacy and disclosure state', () => {
  const g = fixture(), calls = [];
  g.log = ['День 3: Решение города.', 'Ночь 3: Жертв нет.', 'Ночь 2: Старое событие.']; g.privateNotes = ['Ночь 3: Луна — мафия.'];
  context.window.VEZDEHOT_GUIDE = { journal(options) { calls.push(options); return '<details data-detail="' + options.id + '"></details>'; } };
  run('uiDetails.chronicle=true;logs()');
  const chronicle = calls.find(call => call.id === 'chronicle'), notebook = calls.find(call => call.id === 'notebook');
  assert.equal(chronicle.open, true); assert.deepEqual(Array.from(chronicle.entries, entry => entry.label), ['День 03', 'Ночь 03', 'Ночь 02']);
  assert.equal(chronicle.entries[0].text, 'Решение города.'); assert.equal(notebook.entries[0].text, 'Луна — мафия.');
  calls.length = 0; g.players[0].role = 'civilian'; run('logs()'); assert.ok(!calls.some(call => call.id === 'notebook'));
  delete context.window.VEZDEHOT_GUIDE;
});

test('stale learning and personal-mark controls do nothing after ownership is lost', () => {
  const g = fixture(), rules = {}, mark = { dataset: { personalMark: '1' }, value: 'suspect' }, clear = {}; let opened = 0;
  context.window.VEZDEHOT_GUIDE = { open() { opened++; } };
  groups.set('[data-rules]', [rules]); groups.set('[data-personal-mark]', [mark]); groups.set('[data-clear-marks]', [clear]); run('bind()');
  context.window.VEZDEHOT_TAB_SESSION = { canWrite: () => false }; const before = JSON.stringify(g);
  rules.onclick(); mark.onchange(); clear.onclick(); assert.equal(opened, 0); assert.equal(JSON.stringify(g), before); assert.equal(context.paused, false);
  delete context.window.VEZDEHOT_TAB_SESSION; delete context.window.VEZDEHOT_GUIDE;
});

test('shipped shared journal renders Mafia round labels and escaped private entries with stable disclosure keys', () => {
  const g = fixture(); g.log = ['День 3: Решение города.', 'Ночь 3: Все живы.']; g.privateNotes = ['Ночь 3: <img src=x> — мафия.'];
  context.document.addEventListener = () => {}; context.window.addEventListener = () => {};
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../dist/game-guide.js'), 'utf8'), context);
  run('uiDetails.chronicle=true'); const output = run('logs()');
  assert.match(output, /class="vh-journal" data-key="journal-chronicle" data-detail="chronicle" open/);
  assert.match(output, /Ночь 03/); assert.match(output, /День 03/); assert.match(output, /2 события · новые сверху/);
  assert.match(output, /journal-notebook/); assert.match(output, /&lt;img src=x&gt;/); assert.ok(!output.includes('<img'));
  assert.match(run('mafiaTip()'), /class="vh-coach"/);
  delete context.window.VEZDEHOT_GUIDE;
});

test('postgame review counts actual human ballots and distinguishes ties, exclusions and missing legacy outcomes', () => {
  const g = fixture('civilian'); g.round = 4;
  g.voteHistory = [
    { round: 1, ballots: [{ voter: 0, target: 1 }, { voter: 2, target: 3 }], eliminated: null, message: 'Ничья' },
    { round: 2, ballots: [{ voter: 0, target: 3 }, { voter: 2, target: 3 }], eliminated: 3, message: 'Доктор выбыл' },
    { round: 3, ballots: [{ voter: 0, target: 4 }], message: 'Старое сохранение' },
    { round: 4, ballots: [{ voter: 1, target: 2 }], eliminated: 2, message: 'Наблюдение' }
  ];
  assert.equal(run('voteReview()'), '', 'review cannot reveal living roles before the result');
  g.over = true; g.phase = 'result'; g.players[0].alive = false; g.players[4].alive = false;
  const output = run('voteReview()');
  assert.match(output, /Твоих голосов<\/dt><dd>3/); assert.match(output, /Против мафии<\/dt><dd>1/); assert.match(output, /Против города<\/dt><dd>2/);
  assert.match(output, /Раунд 01 · Мафия/); assert.match(output, /Раунд 02 · Доктор/); assert.match(output, /Раунд 03 · Комиссар/);
  assert.ok(!output.includes('Раунд 04')); assert.match(output, /никто не выбыл/); assert.match(output, /этот житель выбыл/); assert.match(output, /Итог исключения не сохранён/);
  assert.ok(!/точность|правильных|неправильных|\d+%/.test(output));
});

test('review escapes names, attributes another elimination correctly, and handles games without human ballots', () => {
  const g = fixture(); g.over = true; g.phase = 'result'; g.players[1].name = '<img src=x>'; g.players[2].name = '<script>other</script>';
  g.voteHistory = [{ round: 1, ballots: [{ voter: 0, target: 1 }], eliminated: 2, message: 'Архив' }];
  let output = run('voteReview()'); assert.match(output, /выбыл другой житель/); assert.match(output, /&lt;img src=x&gt;/); assert.match(output, /&lt;script&gt;other/); assert.ok(!output.includes('<img')); assert.ok(!output.includes('<script>'));
  g.voteHistory = [{ round: 1, ballots: [{ voter: 2, target: 1 }], eliminated: 1, message: 'Архив' }]; output = run('voteReview()');
  assert.match(output, /В сохранённом архиве нет твоих голосов/); assert.match(output, /Твоих голосов<\/dt><dd>0/);
});

test('displayed bot argument cites a public round and never claims another detective private result', () => {
  const g = fixture('civilian'); g.round = 2; g.players[6].alive = false;
  g.voteHistory = [{ round: 1, ballots: [{ voter: 1, target: 6 }], eliminated: 6, message: 'Роль открыта' }];
  g.knowledge[4] = { 1: 'mafia' }; const reason = run('statementReason(g.players[1],g.players[4])');
  assert.match(reason, /Раунд 1: Луна → Марс/); assert.match(reason, /Мирный/); assert.match(reason, /не доказательство роли/);
  g.knowledge[4][1] = 'town'; g.players[1].role = 'doctor'; assert.equal(run('statementReason(g.players[1],g.players[4])'), reason);
  g.phase = 'day'; g.statements = [{ actor: 4, target: 1, text: 'Версия', context: reason }];
  const output = run('logs()'); assert.match(output, /Основание версии/); assert.match(output, /Как боты принимают решения/); assert.match(output, /Чужие проверки, твои отметки/);
});

test('a night ending labels prior statements and ballots by their actual round and inflects vote counts', () => {
  const g = fixture('civilian'); g.round = 4; g.over = true; g.phase = 'result'; g.settled = true; g.win = true; g.winningTeam = 'town'; g.resultReason = 'Ночной итог';
  g.statementsRound = 3; g.statements = [{ actor: 1, target: 3, text: 'Прошлая версия', context: '' }];
  g.ballots = [{ voter: 0, target: 1 }, { voter: 1, target: 3 }, { voter: 2, target: 3 }, { voter: 3, target: 1 }];
  g.voteHistory = [{ round: 3, ballots: JSON.parse(JSON.stringify(g.ballots)), eliminated: null, message: 'Ничья' }];
  const output = run('logs()'); assert.match(output, /Версии жителей · день 3/); assert.match(output, /Кто за кого голосовал · раунд 3/); assert.match(output, /4 голоса/); assert.ok(!output.includes('4 голосов'));
  assert.match(run('resultPanel()'), /Раунд завершения: 4/); assert.ok(!run('resultPanel()').includes('Завершено раундов'));
  g.ballots[0].target = 2; assert.equal(run('ballotsRound()'), null, 'an unmatched old ballot set must not inherit the ending round');
  assert.equal(run('voteCount(1)'), '1 голос'); assert.equal(run('voteCount(2)'), '2 голоса'); assert.equal(run('voteCount(5)'), '5 голосов'); assert.equal(run('voteCount(11)'), '11 голосов');
});

// Parsing the shipped inline script catches accidental syntax edits outside the extracted regions.
new Function(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1]);
console.log(`${count} Mafia UI checks passed`);
