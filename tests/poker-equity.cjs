const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const equity = require('../dist/poker-equity.js');
const source = fs.readFileSync(path.join(__dirname, '../dist/poker.html'), 'utf8').split('// POKER_ENGINE_START')[1].split('// POKER_ENGINE_END')[0];
const context = vm.createContext({ console, Math, Date });
vm.runInContext(source + '\nthis.reference = {evaluate, makeDeck};', context);
const reference = context.reference;
const cards = text => text.split(' ');
const objects = text => cards(text).map(id => ({ id, rank: id.slice(0, -1), suit: id.slice(-1), v: ['2','3','4','5','6','7','8','9','10','J','Q','K','A'].indexOf(id.slice(0,-1)) + 2 }));
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
async function main() {
  await test('direct ranking matches the engine for wheel, double trips, flush and kickers', () => {
    for (const hand of ['A♠ 2♠ 3♠ 4♠ 5♠ K♥ Q♦', 'A♠ A♥ A♦ K♠ K♥ K♦ 2♣', 'A♠ K♠ Q♠ 9♠ 2♠ J♥ 10♦', 'A♠ A♥ K♣ Q♦ J♠ 8♥ 2♣', 'K♠ K♥ Q♠ Q♥ A♦ 8♣ 2♦', 'A♠ A♥ A♣ A♦ K♠ 8♥ 2♣']) {
      assert.equal(equity.evaluate(cards(hand)), reference.evaluate(objects(hand)).value);
    }
  });
  await test('exact evaluator matches best-five enumeration over 900 seeded hands', () => {
    let seed = 717283;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const deck = reference.makeDeck();
    for (let trial = 0; trial < 900; trial++) {
      const shuffled = [...deck];
      for (let i = 0; i < 7; i++) { const j = i + Math.floor(random() * (52 - i)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      const hand = shuffled.slice(0, 5 + trial % 3);
      assert.equal(equity.evaluate(hand), reference.evaluate(hand).value);
    }
  });
  await test('unbeatable royal flush wins every sample', () => {
    const value = equity.estimateSync({ hand: cards('A♠ K♠'), board: cards('Q♠ J♠ 10♠ 2♦ 3♥'), opponents: 3, samples: 400 });
    assert.equal(value.win, 100); assert.equal(value.tie, 0); assert.equal(value.equity, 100);
  });
  await test('royal flush on the board always splits and equity reflects four shares', () => {
    const value = equity.estimateSync({ hand: cards('2♥ 3♦'), board: cards('A♠ K♠ Q♠ J♠ 10♠'), opponents: 3, samples: 400 });
    assert.equal(value.win, 0); assert.equal(value.tie, 100); assert.equal(value.equity, 25);
  });
  await test('pocket aces estimate falls within a realistic broad heads-up range', () => {
    const value = equity.estimateSync({ hand: cards('A♠ A♥'), board: [], opponents: 1, samples: 6000, seed: 813 });
    assert(value.win > 80 && value.win < 89, JSON.stringify(value));
    assert(Math.abs(value.win + value.tie + value.loss - 100) < 1e-8);
    assert(value.equity >= value.win && value.equity <= value.win + value.tie);
  });
  await test('only visible cards and opponent count affect the deterministic estimate', () => {
    const input = { hand: objects('A♠ J♥'), board: objects('2♣ 7♦ Q♥'), opponents: 3, samples: 500 };
    const before = JSON.stringify(input), value = equity.estimateSync(input);
    const extra = { ...input };
    for (const key of ['players', 'deck', 'burn', 'opponentHands']) Object.defineProperty(extra, key, { get() { throw new Error('Hidden information read'); } });
    assert.deepEqual(equity.estimateSync(extra), value);
    assert.deepEqual(equity.estimateSync({ ...input, hand: [...input.hand].reverse(), board: [...input.board].reverse() }), value);
    assert.equal(JSON.stringify(input), before);
  });
  await test('fewer opponents change the estimate without reading folded cards', () => {
    const input = { hand: cards('A♠ A♥'), opponents: 1, samples: 4000, seed: 'opponents' };
    const one = equity.estimateSync(input), three = equity.estimateSync({ ...input, opponents: 3 });
    assert(one.equity > three.equity + 12);
    assert.equal(equity.estimateSync({ ...input, opponents: 0 }).win, 100);
  });
  await test('invalid public cards, board lengths and counts are rejected', () => {
    const input = { hand: cards('A♠ K♥'), board: [], opponents: 3, samples: 200 };
    assert.throws(() => equity.estimateSync({ ...input, hand: cards('A♠ A♠') }), /Duplicate/);
    assert.throws(() => equity.estimateSync({ ...input, board: cards('A♠ 2♣ 3♠') }), /Duplicate/);
    assert.throws(() => equity.estimateSync({ ...input, board: cards('2♣') }), /board/);
    assert.throws(() => equity.estimateSync({ ...input, opponents: -1 }), /Opponent/);
    assert.throws(() => equity.estimateSync({ ...input, samples: 20001 }), /Sample/);
    assert.throws(() => equity.estimateSync({ ...input, hand: cards('1♠ K♥') }), /Unknown/);
  });
  await test('async estimate yields between chunks and agrees with synchronous samples', async () => {
    const input = { hand: cards('A♠ K♥'), board: cards('Q♦ J♦ 2♣'), opponents: 3, samples: 400, seed: 4 };
    const progress = [];
    let timerRan = false;
    const pending = equity.estimate({ ...input, onProgress: value => progress.push(value.samples) });
    setTimeout(() => { timerRan = true; }, 0);
    const value = await pending;
    assert(timerRan); assert(progress.length > 1); assert(progress[0] <= 64);
    assert(progress.every((count, index) => index === 0 || count > progress[index - 1]));
    assert.deepEqual(value, equity.estimateSync(input));
  });
  await test('cancelling an old estimate rejects it before further progress', async () => {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(equity.estimate({ hand: cards('A♠ K♥'), opponents: 3, samples: 1600, signal: controller.signal, onProgress() { calls++; controller.abort(); } }), { name: 'AbortError' });
    assert.equal(calls, 1);
    controller.abort();
    await assert.rejects(equity.estimate({ hand: cards('A♠ K♥'), opponents: 3, signal: controller.signal }), { name: 'AbortError' });
  });
  console.log(checks + ' poker equity checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
