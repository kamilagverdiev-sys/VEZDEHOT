'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../dist/game-store.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const key = (game = 'poker', scope = 'guest') => `vezdehot:session:v1:${scope}:${game}`;
const valid = state => state && Number.isInteger(state.turn) && state.turn >= 0 && Array.isArray(state.cards);
const state = turn => ({turn, cards: ['AH', 'KS']});
function harness(existing = new Map()) {
  const store = existing, writes = [], events = [];
  const controls = {failRead: false, failWrite: false, failKey: null, owner: true};
  const storage = {
    getItem(name) { if (controls.failRead) throw new Error('SecurityError'); return store.get(name) ?? null; },
    setItem(name, value) {
      writes.push(name);
      if (controls.failWrite || controls.failKey === name) throw new Error('QuotaExceededError');
      store.set(name, String(value));
    }
  };
  const window = {localStorage: storage, VEZDEHOT_TAB_SESSION: {canWrite: () => controls.owner},
    document: {dispatchEvent: event => events.push(plain({type: event.type, detail: event.detail}))},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }};
  vm.runInNewContext(source, {window, localStorage: storage, Date, console});
  return {api: window.VEZDEHOT_GAME_STORE, store, writes, controls, window, events};
}

test('versioned saves retain the previous valid revision and return independent copies', () => {
  const h = harness();
  assert.equal(h.api.load('poker', 'guest', {validate: valid}).status, 'empty');
  assert.equal(h.api.save('poker', 'guest', state(1), {validate: valid}).revision, 1);
  assert.equal(h.api.save('poker', 'guest', state(2), {validate: valid}).revision, 2);
  const primary = JSON.parse(h.store.get(key())), backup = JSON.parse(h.store.get(key() + ':backup'));
  assert.deepEqual(Object.keys(primary).sort(), ['format', 'game', 'payload', 'revision', 'scope', 'updatedAt', 'version'].sort());
  assert.equal(primary.format, 'vezdehot-game-session'); assert.equal(primary.version, 1);
  assert.equal(primary.revision, 2); assert.equal(backup.revision, 1);
  assert.equal(backup.payload.turn, 1); assert.equal(primary.payload.turn, 2);
  const loaded = h.api.load('poker', 'guest', {validate: valid}); loaded.state.cards.push('2C');
  assert.deepEqual(plain(h.api.peek('poker', 'guest').state), state(2));
  assert.equal(h.api.status('poker', 'guest').pending, false);
});

test('a corrupt primary recovers the validated backup without changing either original', () => {
  const h = harness();
  h.api.save('poker', 'guest', state(1), {validate: valid});
  h.api.save('poker', 'guest', state(2), {validate: valid});
  h.store.set(key(), '{broken'); const before = new Map(h.store); h.writes.length = 0;
  const restored = h.api.load('poker', 'guest', {validate: valid});
  assert.equal(restored.status, 'recovered'); assert.equal(restored.state.turn, 1);
  assert.match(restored.message, /предыдущая/); assert.equal(h.writes.length, 0); assert.deepEqual(h.store, before);
  assert.equal(h.api.save('poker', 'guest', state(3), {validate: valid}).ok, true);
  assert.equal(JSON.parse(h.store.get(key() + ':backup')).payload.turn, 1);
  assert.ok([...h.store].some(([name, raw]) => name.startsWith(key() + ':corrupt:') && raw === '{broken'));
});

test('semantically invalid primary is rejected, and backup must also pass the game validator', () => {
  const h = harness();
  h.api.save('poker', 'guest', state(1), {validate: valid});
  h.api.save('poker', 'guest', state(2), {validate: valid});
  const primary = JSON.parse(h.store.get(key())); primary.payload.turn = -50; h.store.set(key(), JSON.stringify(primary));
  assert.equal(h.api.load('poker', 'guest', {validate: valid}).status, 'recovered');
  const backup = JSON.parse(h.store.get(key() + ':backup')); backup.payload.cards = null; h.store.set(key() + ':backup', JSON.stringify(backup));
  const restored = h.api.load('poker', 'guest', {validate: valid});
  assert.equal(restored.status, 'corrupt'); assert.equal(restored.state, null);
  assert.equal(h.store.get(key()), JSON.stringify(primary));
  assert.equal(h.store.get(key() + ':backup'), JSON.stringify(backup));
});

test('quota failure keeps the newest state in memory and retry commits the same revision', () => {
  const h = harness();
  h.api.save('poker', 'guest', state(1), {validate: valid});
  h.controls.failWrite = true;
  const failed = h.api.save('poker', 'guest', state(2), {validate: valid});
  assert.equal(failed.ok, false); assert.equal(failed.status, 'unavailable'); assert.equal(failed.revision, 2);
  assert.equal(h.api.load('poker', 'guest', {validate: valid}).state.turn, 2);
  assert.equal(h.api.peek('poker', 'guest').state.turn, 2); assert.equal(h.api.status('poker', 'guest').pending, true);
  assert.equal(JSON.parse(h.store.get(key())).payload.turn, 1);
  h.controls.failWrite = false;
  const retried = h.api.retry('poker', 'guest');
  assert.equal(retried.ok, true); assert.equal(retried.revision, 2); assert.equal(h.api.status('poker', 'guest').pending, false);
  assert.equal(JSON.parse(h.store.get(key())).payload.turn, 2);
  assert.equal(JSON.parse(h.store.get(key() + ':backup')).payload.turn, 1);
});

test('failed primary commit preserves the old game across reload, then allows retry', () => {
  const h = harness(); h.api.save('poker', 'guest', state(7), {validate: valid});
  h.controls.failKey = key();
  assert.equal(h.api.save('poker', 'guest', state(8), {validate: valid}).ok, false);
  const reopened = harness(h.store).api.load('poker', 'guest', {validate: valid});
  assert.equal(reopened.state.turn, 7); assert.equal(reopened.revision, 1);
  assert.equal(JSON.parse(h.store.get(key() + ':backup')).payload.turn, 7);
  h.controls.failKey = null; assert.equal(h.api.retry('poker', 'guest').ok, true);
  assert.equal(h.api.peek('poker', 'guest').state.turn, 8);
});

test('failure to preserve a backup never overwrites the primary', () => {
  const h = harness(); h.api.save('poker', 'guest', state(1), {validate: valid});
  h.controls.failKey = key() + ':backup';
  assert.equal(h.api.save('poker', 'guest', state(2), {validate: valid}).ok, false);
  assert.equal(JSON.parse(h.store.get(key())).payload.turn, 1);
  assert.equal(h.api.peek('poker', 'guest').state.turn, 2);
});

test('tombstones block both legacy resurrection and an older backup after clearing', () => {
  const h = harness(); const legacyKey = 'old-poker';
  h.store.set(legacyKey, JSON.stringify(state(1)));
  h.api.load('poker', 'guest', {validate: valid, legacyKeys: [legacyKey]});
  assert.equal(h.api.clear('poker', 'guest').ok, true);
  assert.equal(JSON.parse(h.store.get(key())).payload, null);
  const reopened = harness(h.store);
  const empty = reopened.api.load('poker', 'guest', {validate: valid, legacyKeys: [legacyKey]});
  assert.equal(empty.status, 'empty'); assert.equal(empty.state, null); assert.equal(empty.revision, 2);
  assert.equal(h.store.get(legacyKey), JSON.stringify(state(1)));
});

test('failed clear remains a memory tombstone and retries without resurrecting state', () => {
  const h = harness(); h.api.save('poker', 'guest', state(1), {validate: valid}); h.controls.failWrite = true;
  assert.equal(h.api.clear('poker', 'guest').ok, false);
  const cleared = h.api.load('poker', 'guest', {validate: valid});
  assert.equal(cleared.state, null); assert.equal(cleared.status, 'unavailable'); assert.equal(cleared.revision, 2);
  h.controls.failWrite = false; assert.equal(h.api.retry('poker', 'guest').ok, true);
  assert.equal(harness(h.store).api.peek('poker', 'guest').state, null);
});

test('game and account scopes are isolated, including pending memory writes', () => {
  const h = harness();
  h.api.save('poker', 'guest', state(1), {validate: valid});
  h.api.save('poker', 'account-a', state(2), {validate: valid});
  h.api.save('mafia', 'account-a', state(3), {validate: valid});
  h.controls.failWrite = true; h.api.save('poker', 'account-b', state(4), {validate: valid});
  assert.equal(h.api.peek('poker', 'guest').state.turn, 1);
  assert.equal(h.api.peek('poker', 'account-a').state.turn, 2);
  assert.equal(h.api.peek('mafia', 'account-a').state.turn, 3);
  assert.equal(h.api.peek('poker', 'account-b').state.turn, 4);
  assert.equal(h.api.peek('bunker', 'account-a').state, null);
  h.controls.failWrite = false; h.api.clear('poker', 'account-a');
  assert.equal(h.api.peek('mafia', 'account-a').state.turn, 3); assert.equal(h.api.peek('poker', 'guest').state.turn, 1);
});

test('migration validates before writing and keeps the complete legacy source intact', () => {
  const h = harness(); const legacyKey = 'old-main';
  const old = {game: 'durak', savedGames: {durak: {turn: 4, cards: []}, bunker: {other: true}}};
  h.store.set(legacyKey, JSON.stringify(old));
  const loaded = h.api.load('durak', 'guest', {validate: value => ({...value, migrated: true}), legacyKeys: [{key: legacyKey, select: value => value.savedGames.durak}]});
  assert.equal(loaded.status, 'saved'); assert.equal(loaded.state.turn, 4); assert.equal(loaded.state.migrated, true);
  assert.equal(h.store.get(legacyKey), JSON.stringify(old));
  assert.equal(JSON.parse(h.store.get(key('durak'))).payload.turn, 4);
  const bad = harness(new Map([['old-poker', JSON.stringify({turn: -9, cards: []})]]));
  assert.equal(bad.api.load('poker', 'guest', {validate: valid, legacyKeys: ['old-poker']}).status, 'corrupt');
  assert.equal(bad.store.has(key()), false); assert.equal(bad.writes.length, 0);
});

test('peek is read-only and does not migrate an unvalidated legacy game', () => {
  const h = harness(new Map([['old-poker', JSON.stringify(state(3))]]));
  assert.equal(h.api.peek('poker', 'guest').status, 'empty');
  assert.equal(h.api.load('poker', 'guest', {legacyKeys: ['old-poker']}).status, 'empty');
  assert.equal(h.writes.length, 0); assert.equal(h.store.has(key()), false);
});

test('readonly tabs cannot save, clear, or queue stale writes for later ownership', () => {
  const h = harness(); h.api.save('poker', 'guest', state(1), {validate: valid}); const before = new Map(h.store);
  h.controls.owner = false;
  assert.equal(h.api.save('poker', 'guest', state(9), {validate: valid}).ok, false);
  assert.equal(h.api.clear('poker', 'guest').ok, false);
  assert.equal(h.api.status('poker', 'guest').pending, false); assert.deepEqual(h.store, before);
  h.controls.owner = true; h.api.retry('poker', 'guest');
  assert.equal(JSON.parse(h.store.get(key())).payload.turn, 1);
});

test('retry does not overwrite a newer revision from another owner', () => {
  const h = harness(); h.api.save('poker', 'guest', state(1), {validate: valid});
  h.controls.failWrite = true; h.api.save('poker', 'guest', state(2), {validate: valid}); h.controls.failWrite = false;
  const owner = harness(h.store); owner.api.save('poker', 'guest', state(3), {validate: valid});
  assert.equal(h.api.retry('poker', 'guest').ok, false);
  assert.equal(h.api.status('poker', 'guest').pending, false);
  assert.equal(h.api.peek('poker', 'guest').state.turn, 3); assert.equal(JSON.parse(h.store.get(key())).payload.turn, 3);
});

test('unavailable reads still allow a memory-only game and later durable retry', () => {
  const h = harness(); h.controls.failRead = true;
  assert.equal(h.api.load('poker', 'guest', {validate: valid}).status, 'unavailable');
  assert.equal(h.api.save('poker', 'guest', state(4), {validate: valid}).ok, false);
  assert.equal(h.api.load('poker', 'guest', {validate: valid}).state.turn, 4);
  h.controls.failRead = false; assert.equal(h.api.retry('poker', 'guest').ok, true);
  assert.equal(harness(h.store).api.load('poker', 'guest', {validate: valid}).state.turn, 4);
});

test('invalid, circular, oversized, or cross-scope data cannot replace a valid game', () => {
  const h = harness(); h.api.save('poker', 'guest', state(1), {validate: valid}); const before = h.store.get(key());
  const circular = state(2); circular.self = circular;
  assert.equal(h.api.save('poker', 'guest', circular, {validate: valid}).ok, false);
  assert.equal(h.api.save('poker', 'guest', {...state(2), huge: 'a'.repeat(512 * 1024)}, {validate: valid}).ok, false);
  assert.equal(h.api.save('poker', 'guest', state(-1), {validate: valid}).ok, false);
  assert.equal(h.api.save('unknown', 'guest', state(2)).ok, false);
  assert.equal(h.api.save('poker', 'guest:other', state(2)).ok, false);
  assert.equal(h.store.get(key()), before);
  h.store.set(key('poker', 'account-a'), before);
  assert.equal(h.api.load('poker', 'account-a', {validate: valid}).status, 'corrupt');
});

test('a corrupted backup is archived before a later valid primary becomes the backup', () => {
  const h = harness(); h.api.save('poker', 'guest', state(1), {validate: valid});
  h.store.set(key() + ':backup', 'broken-backup');
  assert.equal(h.api.save('poker', 'guest', state(2), {validate: valid}).ok, true);
  assert.equal(JSON.parse(h.store.get(key() + ':backup')).payload.turn, 1);
  assert.ok([...h.store].some(([name, raw]) => name.startsWith(key() + ':backup:corrupt:') && raw === 'broken-backup'));
});

test('save status changes emit one document notice; peek and status never emit', () => {
  const h = harness();
  h.api.load('poker', 'guest', {validate: valid});
  assert.deepEqual(h.events[0], {type: 'vezdehot:save-status', detail: {
    game: 'poker', scope: 'guest', status: 'empty', message: 'Нет сохранённой партии.', revision: 0, pending: false
  }});
  h.api.load('poker', 'guest', {validate: valid}); h.api.status('poker', 'guest'); h.api.peek('poker', 'guest');
  assert.equal(h.events.length, 1);
  h.api.save('poker', 'guest', state(1), {validate: valid});
  assert.equal(h.events.length, 2); assert.equal(h.events.at(-1).detail.status, 'saved');
  h.controls.failWrite = true; h.api.save('poker', 'guest', state(2), {validate: valid});
  assert.equal(h.events.at(-1).detail.status, 'unavailable'); assert.equal(h.events.at(-1).detail.pending, true);
  const count = h.events.length; h.api.peek('poker', 'guest'); h.api.status('poker', 'guest');
  assert.equal(h.events.length, count);
  h.controls.failWrite = false; h.api.retry('poker', 'guest');
  assert.equal(h.events.at(-1).detail.status, 'saved'); assert.equal(h.events.at(-1).detail.pending, false);
});

test('legacy migration in a readonly tab exposes the game without writing or queuing it', () => {
  const h = harness(new Map([['old-poker', JSON.stringify(state(6))]])); h.controls.owner = false;
  const loaded = h.api.load('poker', 'guest', {validate: valid, legacyKeys: ['old-poker']});
  assert.equal(loaded.state.turn, 6); assert.equal(loaded.status, 'unavailable'); assert.equal(loaded.revision, 0);
  assert.equal(h.api.status('poker', 'guest').pending, false); assert.equal(h.writes.length, 0);
  assert.equal(h.events.at(-1).detail.status, 'unavailable');
  h.controls.owner = true; h.api.retry('poker', 'guest'); assert.equal(h.store.has(key()), false);
});

test('backup tombstone is authoritative when the primary disappears', () => {
  const h = harness(new Map([['old-poker', JSON.stringify(state(1))]]));
  h.api.load('poker', 'guest', {validate: valid, legacyKeys: ['old-poker']});
  h.api.clear('poker', 'guest'); h.api.save('poker', 'guest', state(2), {validate: valid});
  h.store.delete(key());
  const loaded = harness(h.store).api.load('poker', 'guest', {validate: valid, legacyKeys: ['old-poker']});
  assert.equal(loaded.status, 'recovered'); assert.equal(loaded.state, null); assert.equal(loaded.revision, 2);
});
