(function (root) {
  'use strict';

  // Each game owns its own record. A backup is the previous validated record,
  // never a copy of whatever bytes happened to be in localStorage.
  const FORMAT = 'vezdehot-game-session';
  const VERSION = 1;
  const PREFIX = 'vezdehot:session:v1:';
  const MAX_LENGTH = 512 * 1024;
  const games = new Set(['durak', 'bunker', 'poker', 'mafia', 'monopoly']);
  const records = new Map();
  const validators = new Map();
  const announced = new Map();
  const loaded = new Set();
  const observedHeads = new Map();
  const importFences = new Set();
  const messages = {
    empty: 'Нет сохранённой партии.',
    saved: 'Партия сохранена на этом устройстве.',
    recovered: 'Последнее сохранение повреждено. Восстановлена предыдущая исправная версия; последний ход мог не сохраниться.',
    corrupt: 'Сохранение повреждено, исправной резервной копии нет. Исходные данные сохранены для восстановления.',
    unavailable: 'Не удалось записать партию на устройство. Текущая партия пока хранится только в этой вкладке. Не закрывайте её и повторите сохранение.',
    readonly: 'Партия открыта в другой вкладке. Продолжите в активной вкладке или сначала передайте управление этой вкладке.',
    invalid: 'Состояние партии не прошло проверку. Последнее исправное сохранение не изменено.',
    conflict: 'На устройстве уже есть более новая версия партии. Загрузите её перед продолжением.'
  };

  function keyFor(game, scope) {
    if (!games.has(game) || typeof scope !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope)) return null;
    return PREFIX + scope + ':' + game;
  }

  function clone(value) { return value === null ? null : JSON.parse(JSON.stringify(value)); }
  function object(value) { return value !== null && typeof value === 'object'; }
  function stringify(value) {
    const raw = JSON.stringify(value);
    if (typeof raw !== 'string' || raw.length > MAX_LENGTH) throw new Error('size');
    return raw;
  }
  function get(key) {
    const value = root.localStorage ? root.localStorage.getItem(key) : localStorage.getItem(key);
    return value == null ? null : value;
  }
  function put(key, raw) {
    if (root.localStorage) root.localStorage.setItem(key, raw);
    else localStorage.setItem(key, raw);
  }
  function canWrite(scope, access) {
    try {
      const session = root.VEZDEHOT_TAB_SESSION;
      if (access?.contextCurrent && access.contextCurrent() !== true) return false;
      if (session && typeof session.status === 'function') {
        const status = session.status();
        if (status && Object.prototype.hasOwnProperty.call(status, 'scope') && status.scope !== scope) return false;
      }
      if (access?.raw) {
        if (!session) return false;
        const check = typeof session.ownsLock === 'function' ? session.ownsLock : session.canWrite;
        return typeof check === 'function' && check.call(session) === true;
      }
      return !session || typeof session.canWrite !== 'function' || session.canWrite() === true;
    } catch (_) { return false; }
  }
  function observeHead(key) {
    try { observedHeads.set(key, get(key)); } catch (_) { /* Unavailable reads retain the last observed head. */ }
  }
  function staleHead(key) {
    if (importFences.has(key)) return true;
    if (!observedHeads.has(key)) return false;
    try { return observedHeads.get(key) !== get(key); } catch (_) { return false; }
  }
  function denyStale(game, scope, validate) {
    const key = keyFor(game, scope), cached = records.get(key);
    if (cached) cached.pending = false;
    const entry = inspect(game, scope, validate);
    entry.status = 'unavailable'; entry.message = messages.conflict;
    return writeResult(entry, false);
  }
  function validatorFor(key, options) {
    if (options && typeof options.validate === 'function') validators.set(key, options.validate);
    return validators.get(key);
  }
  function validPayload(value, validate) {
    // Null is a tombstone. It deliberately bypasses game-state validators.
    if (value === null) return null;
    if (!object(value)) throw new Error('payload');
    let result = JSON.parse(stringify(value));
    if (validate) {
      const checked = validate(result);
      if (checked !== true) {
        if (!object(checked)) throw new Error('validation');
        result = checked;
      }
    }
    if (!object(result)) throw new Error('payload');
    return JSON.parse(stringify(result));
  }
  function parse(raw, game, scope, validate) {
    if (raw === null) return {kind: 'empty'};
    try {
      if (typeof raw !== 'string' || raw.length > MAX_LENGTH) throw new Error('size');
      const value = JSON.parse(raw);
      if (!object(value) || value.format !== FORMAT || value.version !== VERSION || value.game !== game || value.scope !== scope ||
          !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
          !Object.prototype.hasOwnProperty.call(value, 'payload')) throw new Error('envelope');
      return {kind: 'valid', raw, envelope: {
        format: FORMAT, version: VERSION, game, scope, revision: value.revision,
        updatedAt: value.updatedAt, payload: validPayload(value.payload, validate)
      }};
    } catch (_) { return {kind: 'corrupt', raw}; }
  }
  function result(entry) {
    return {state: entry.envelope ? clone(entry.envelope.payload) : null, status: entry.status,
      message: entry.message, revision: entry.envelope ? entry.envelope.revision : 0};
  }
  function writeResult(entry, ok) {
    return {ok, status: entry.status, message: entry.message, revision: entry.envelope ? entry.envelope.revision : 0};
  }
  function remember(key, envelope, status, message, pending) {
    const entry = {envelope, status, message: message || messages[status], pending: !!pending};
    if (key) records.set(key, entry);
    return entry;
  }
  function invalidEntry() { return {envelope: null, status: 'unavailable', message: messages.invalid, pending: false}; }
  function disk(game, scope, validate) {
    const key = keyFor(game, scope);
    return {primary: parse(get(key), game, scope, validate), backup: parse(get(key + ':backup'), game, scope, validate)};
  }
  function inspect(game, scope, validate) {
    const key = keyFor(game, scope);
    const cached = records.get(key);
    if (cached && cached.pending) {
      try { validPayload(cached.envelope.payload, validate); }
      catch (_) { return remember(key, null, 'corrupt', messages.invalid, false); }
      return cached;
    }
    try {
      const data = disk(game, scope, validate);
      if (data.primary.kind === 'valid') {
        return remember(key, data.primary.envelope, data.primary.envelope.payload === null ? 'empty' : 'saved');
      }
      if (data.backup.kind === 'valid') {
        return remember(key, data.backup.envelope, 'recovered', data.primary.kind === 'empty'
          ? 'Основное сохранение недоступно. Восстановлена предыдущая исправная версия; последний ход мог не сохраниться.' : messages.recovered);
      }
      if (data.primary.kind === 'corrupt' || data.backup.kind === 'corrupt') return remember(key, null, 'corrupt');
      return remember(key, null, 'empty');
    } catch (_) {
      return remember(key, cached ? cached.envelope : null, 'unavailable',
        'Хранилище устройства недоступно. Сохранение между посещениями пока невозможно.', false);
    }
  }

  function archiveCorrupt(key, raw, write) {
    if (raw === null) return;
    // Content-addressing deduplicates retries without deleting an earlier damaged
    // record. An oversized original stays in place instead of being destroyed.
    if (raw.length > MAX_LENGTH) throw new Error('size');
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
    const archiveKey = key + ':corrupt:' + raw.length + ':' + (hash >>> 0).toString(16);
    const previous = get(archiveKey);
    if (previous !== null && previous !== raw) throw new Error('archive-collision');
    if (previous === null) write(archiveKey, raw);
  }

  function persist(key, entry, validate, access) {
    if (!canWrite(entry.envelope.scope, access)) {
      entry.status = 'unavailable'; entry.message = messages.readonly;
      return writeResult(entry, false);
    }
    try {
      const envelope = entry.envelope;
      const write = (name, value) => {
        if (!canWrite(envelope.scope, access)) throw new Error('ownership');
        put(name, value);
      };
      const raw = stringify(envelope);
      const data = disk(envelope.game, envelope.scope, validate);
      if (data.primary.kind === 'valid' && data.primary.raw === raw) {
        entry.pending = false; entry.status = envelope.payload === null ? 'empty' : 'saved'; entry.message = messages[entry.status];
        return writeResult(entry, true);
      }
      const maxRevision = Math.max(data.primary.envelope?.revision || 0, data.backup.envelope?.revision || 0);
      if (maxRevision >= envelope.revision) {
        // Another owner has already advanced this game. Never replay an older
        // in-memory turn over it after ownership changes.
        entry.pending = false;
        const current = inspect(envelope.game, envelope.scope, validate);
        current.status = 'unavailable'; current.message = messages.conflict;
        return writeResult(current, false);
      }
      if (data.primary.kind === 'corrupt') archiveCorrupt(key, data.primary.raw, write);
      if (data.primary.kind === 'valid') {
        if (data.backup.kind === 'corrupt') archiveCorrupt(key + ':backup', data.backup.raw, write);
        // Backup must commit first. If it cannot, retain the primary as well.
        if (data.backup.raw !== data.primary.raw) write(key + ':backup', data.primary.raw);
      }
      write(key, raw);
      entry.pending = false; entry.status = envelope.payload === null ? 'empty' : 'saved'; entry.message = messages[entry.status];
      return writeResult(entry, true);
    } catch (error) {
      entry.pending = error?.message !== 'ownership'; entry.status = 'unavailable'; entry.message = entry.pending ? messages.unavailable : messages.readonly;
      return writeResult(entry, false);
    }
  }

  function save(game, scope, state, options, access) {
    const key = keyFor(game, scope);
    if (!key) return writeResult(invalidEntry(), false);
    const validate = validatorFor(key, options);
    if (!canWrite(scope, access)) {
      const previous = records.get(key) || inspect(game, scope, validate);
      // A denied write must not become a queued stale action for a future owner.
      return writeResult({...previous, status: 'unavailable', message: messages.readonly}, false);
    }
    if (!access?.raw && staleHead(key)) return denyStale(game, scope, validate);
    let payload;
    try { payload = validPayload(state, validate); }
    catch (_) {
      const previous = records.get(key) || inspect(game, scope, validate);
      previous.status = 'corrupt'; previous.message = messages.invalid;
      return writeResult(previous, false);
    }
    let revision = records.get(key)?.envelope?.revision || 0;
    try {
      const data = disk(game, scope, validate);
      revision = Math.max(revision, data.primary.envelope?.revision || 0, data.backup.envelope?.revision || 0);
    } catch (_) { /* persist below keeps the new state in memory when storage is blocked. */ }
    if (revision >= Number.MAX_SAFE_INTEGER) return writeResult(invalidEntry(), false);
    const envelope = {format: FORMAT, version: VERSION, game, scope, revision: revision + 1, updatedAt: Date.now(), payload};
    try { stringify(envelope); }
    catch (_) {
      const previous = records.get(key) || inspect(game, scope, validate);
      previous.status = 'corrupt'; previous.message = messages.invalid;
      return writeResult(previous, false);
    }
    const entry = remember(key, envelope, 'unavailable', messages.unavailable, true);
    const output = persist(key, entry, validate, access);
    observeHead(key);
    return output;
  }

  function load(game, scope, options, access) {
    const key = keyFor(game, scope);
    if (!key) return result(invalidEntry());
    const validate = validatorFor(key, options);
    const entry = inspect(game, scope, validate);
    // Even an empty tombstone is authoritative: never resurrect legacy data.
    if (entry.status !== 'empty' || entry.envelope || typeof validate !== 'function' || !Array.isArray(options?.legacyKeys)) return result(entry);
    let corruptLegacy = false;
    for (const candidate of options.legacyKeys) {
      const legacyKey = typeof candidate === 'string' ? candidate : candidate?.key;
      if (typeof legacyKey !== 'string' || !legacyKey || legacyKey.length > 256 || legacyKey === key) continue;
      let raw;
      try { raw = get(legacyKey); }
      catch (_) { return result(remember(key, null, 'unavailable', 'Не удалось прочитать прежнее сохранение. Данные на устройстве не изменены.')); }
      if (raw === null) continue;
      let payload;
      try {
        if (raw.length > MAX_LENGTH) throw new Error('size');
        let value = JSON.parse(raw);
        if (typeof candidate?.select === 'function') value = candidate.select(value);
        if (value == null) continue;
        payload = validPayload(value, validate);
      } catch (_) { corruptLegacy = true; continue; }
      if (!canWrite(scope, access)) {
        entry.status = 'unavailable'; entry.message = messages.readonly;
        return {state: payload, status: 'unavailable', message: messages.readonly, revision: 0};
      }
      const migrated = save(game, scope, payload, {validate}, access);
      const current = records.get(key);
      if (migrated.ok) current.message = 'Прежнее сохранение проверено и перенесено в новую версию. Исходная копия сохранена.';
      return result(current);
    }
    return result(corruptLegacy ? remember(key, null, 'corrupt', 'Прежнее сохранение не прошло проверку. Исходные данные сохранены для восстановления.') : entry);
  }

  function peek(game, scope) {
    const key = keyFor(game, scope);
    return key ? result(inspect(game, scope, validators.get(key))) : result(invalidEntry());
  }
  function status(game, scope) {
    const key = keyFor(game, scope);
    const entry = key ? (records.get(key) || inspect(game, scope, validators.get(key))) : invalidEntry();
    return {status: entry.status, message: entry.message, revision: entry.envelope?.revision || 0, pending: !!entry.pending};
  }
  function retry(game, scope) {
    const key = keyFor(game, scope);
    if (!key) return writeResult(invalidEntry(), false);
    const entry = records.get(key) || inspect(game, scope, validators.get(key));
    if (!canWrite(scope)) return writeResult({...entry, status: 'unavailable', message: messages.readonly}, false);
    if (staleHead(key)) return denyStale(game, scope, validators.get(key));
    if (!entry.pending) return writeResult(entry, ['empty', 'saved', 'recovered'].includes(entry.status));
    const output = persist(key, entry, validators.get(key)); observeHead(key); return output;
  }

  function sharedValidator(game, remote) {
    const shared = root.VEZDEHOT_SESSION_VALIDATION;
    if (!shared || typeof shared.validate !== 'function') throw new Error('validator');
    return state => shared.validate(game, state, {remote: !!remote});
  }
  function legacyKeys(game, scope) {
    if (game !== 'durak' && game !== 'bunker') return [{key: ({poker: 'vezdehot_poker_v2_', mafia: 'vezdehot_mafia_v3_', monopoly: 'vezdehot_monopoly_v3_'})[game] + scope}];
    const select = value => {
      if (!object(value) || Array.isArray(value)) throw new Error('legacy');
      if (value.savedGames != null && (!object(value.savedGames) || Array.isArray(value.savedGames))) throw new Error('legacy');
      if (value.savedGames && Object.prototype.hasOwnProperty.call(value.savedGames, game)) return value.savedGames[game];
      if (value.game == null) return null;
      const kind = Array.isArray(value.game.deck) ? 'durak' : Array.isArray(value.game.players?.[0]?.cards) ? 'bunker' : null;
      if (!kind) throw new Error('legacy');
      return kind === game ? value.game : null;
    };
    return [{key: 'vezdehot:main:' + scope, select}, ...(scope === 'guest' ? [{key: 'vezdehot_v2', select}, {key: 'uniq_play_v1', select}] : [])];
  }
  function exportAll(scope, options = {}) {
    const output = {ok: false, games: {}, revisions: {}, message: ''};
    if (!keyFor('durak', scope)) { output.message = messages.invalid; return output; }
    const access = {raw: true, contextCurrent: options.contextCurrent};
    if (options.contextCurrent !== undefined && typeof options.contextCurrent !== 'function' || !canWrite(scope, access)) { output.message = messages.readonly; return output; }
    try {
      for (const game of games) {
        const key = keyFor(game, scope), previous = records.get(key);
        if (previous && (previous.pending || ['corrupt', 'unavailable'].includes(previous.status))) throw new Error(previous.message);
        const validate = sharedValidator(game, false);
        const value = withNotice(game, scope, () => load(game, scope, {validate, legacyKeys: legacyKeys(game, scope)}, access));
        const current = records.get(key);
        if (current?.pending || ['corrupt', 'unavailable'].includes(value.status)) throw new Error(value.message);
        output.games[game] = clone(value.state); output.revisions[game] = value.revision;
      }
      if (!canWrite(scope, access)) throw new Error(messages.readonly);
      output.ok = true; output.message = 'Партии проверены для синхронизации.';
    } catch (error) { output.games = {}; output.revisions = {}; output.message = error?.message === 'validator' ? 'Проверка игровых сохранений ещё не готова.' : error?.message || messages.invalid; }
    return output;
  }
  function installAll(scope, snapshots, options = {}) {
    const access = {raw: true, contextCurrent: options.contextCurrent};
    if (!keyFor('durak', scope) || typeof options.contextCurrent !== 'function' || !canWrite(scope, access)) return {ok: false, message: messages.readonly};
    if (!object(snapshots) || Array.isArray(snapshots) || Object.keys(snapshots).length !== games.size || [...games].some(game => !Object.prototype.hasOwnProperty.call(snapshots, game))) return {ok: false, message: messages.invalid};
    const prepared = [];
    try {
      // Validate every game before changing any durable data or installing a fence.
      for (const game of games) {
        const key = keyFor(game, scope), validate = sharedValidator(game, true);
        const payload = validPayload(snapshots[game], validate);
        const data = disk(game, scope, sharedValidator(game, false));
        const revision = Math.max(records.get(key)?.envelope?.revision || 0, data.primary.envelope?.revision || 0, data.backup.envelope?.revision || 0);
        if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('revision');
        const envelope = {format: FORMAT, version: VERSION, game, scope, revision: revision + 1, updatedAt: Date.now(), payload};
        stringify(envelope); prepared.push({key, game, envelope});
      }
      if (!canWrite(scope, access)) return {ok: false, message: messages.readonly};
      for (const item of prepared) if (loaded.has(item.key)) importFences.add(item.key);
      for (const item of prepared) {
        if (!canWrite(scope, access)) return {ok: false, message: messages.readonly};
        const validate = sharedValidator(item.game, false);
        const output = withNotice(item.game, scope, () => {
          const entry = remember(item.key, item.envelope, 'unavailable', messages.unavailable, true);
          return persist(item.key, entry, validate, access);
        });
        if (!output.ok) return {ok: false, message: output.message};
      }
      return {ok: true, message: 'Облачные партии сохранены на этом устройстве.'};
    } catch (error) { return {ok: false, message: error?.message === 'validator' ? 'Проверка игровых сохранений ещё не готова.' : messages.invalid}; }
  }

  function withNotice(game, scope, action) {
    const output = action();
    const key = keyFor(game, scope);
    if (!key) return output;
    const detail = {game, scope, ...status(game, scope)};
    const signature = JSON.stringify(detail);
    if (announced.get(key) !== signature) {
      announced.set(key, signature);
      try {
        const target = root.document || (typeof document !== 'undefined' ? document : null);
        const Event = root.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
        if (target && Event && typeof target.dispatchEvent === 'function') target.dispatchEvent(new Event('vezdehot:save-status', {detail}));
      } catch (_) { /* A notice listener must not turn a committed save into a failed save. */ }
    }
    return output;
  }

  root.VEZDEHOT_GAME_STORE = Object.freeze({
    load: (game, scope, options) => withNotice(game, scope, () => {const key = keyFor(game, scope); if (key) loaded.add(key); const output = load(game, scope, options); if (key) observeHead(key); return output;}),
    save: (game, scope, state, options) => withNotice(game, scope, () => save(game, scope, state, options)),
    clear: (game, scope) => withNotice(game, scope, () => save(game, scope, null)),
    retry: (game, scope) => withNotice(game, scope, () => retry(game, scope)),
    status, peek, exportAll, installAll
  });
})(window);
