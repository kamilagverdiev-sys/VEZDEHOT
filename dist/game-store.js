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
  function canWrite() {
    try {
      const session = root.VEZDEHOT_TAB_SESSION;
      return !session || typeof session.canWrite !== 'function' || session.canWrite() === true;
    } catch (_) { return false; }
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

  function archiveCorrupt(key, raw) {
    if (raw === null) return;
    // Content-addressing deduplicates retries without deleting an earlier damaged
    // record. An oversized original stays in place instead of being destroyed.
    if (raw.length > MAX_LENGTH) throw new Error('size');
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
    const archiveKey = key + ':corrupt:' + raw.length + ':' + (hash >>> 0).toString(16);
    const previous = get(archiveKey);
    if (previous !== null && previous !== raw) throw new Error('archive-collision');
    if (previous === null) put(archiveKey, raw);
  }

  function persist(key, entry, validate) {
    if (!canWrite()) {
      entry.status = 'unavailable'; entry.message = messages.readonly;
      return writeResult(entry, false);
    }
    try {
      const envelope = entry.envelope;
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
      if (data.primary.kind === 'corrupt') archiveCorrupt(key, data.primary.raw);
      if (data.primary.kind === 'valid') {
        if (data.backup.kind === 'corrupt') archiveCorrupt(key + ':backup', data.backup.raw);
        // Backup must commit first. If it cannot, retain the primary as well.
        if (data.backup.raw !== data.primary.raw) put(key + ':backup', data.primary.raw);
      }
      if (!canWrite()) throw new Error('ownership');
      put(key, raw);
      entry.pending = false; entry.status = envelope.payload === null ? 'empty' : 'saved'; entry.message = messages[entry.status];
      return writeResult(entry, true);
    } catch (_) {
      entry.pending = true; entry.status = 'unavailable'; entry.message = messages.unavailable;
      return writeResult(entry, false);
    }
  }

  function save(game, scope, state, options) {
    const key = keyFor(game, scope);
    if (!key) return writeResult(invalidEntry(), false);
    const validate = validatorFor(key, options);
    if (!canWrite()) {
      const previous = records.get(key) || inspect(game, scope, validate);
      // A denied write must not become a queued stale action for a future owner.
      previous.status = 'unavailable'; previous.message = messages.readonly;
      return writeResult(previous, false);
    }
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
    return persist(key, entry, validate);
  }

  function load(game, scope, options) {
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
      if (!canWrite()) {
        entry.status = 'unavailable'; entry.message = messages.readonly;
        return {state: payload, status: 'unavailable', message: messages.readonly, revision: 0};
      }
      const migrated = save(game, scope, payload, {validate});
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
    if (!entry.pending) return writeResult(entry, ['empty', 'saved', 'recovered'].includes(entry.status));
    return persist(key, entry, validators.get(key));
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
    load: (game, scope, options) => withNotice(game, scope, () => load(game, scope, options)),
    save: (game, scope, state, options) => withNotice(game, scope, () => save(game, scope, state, options)),
    clear: (game, scope) => withNotice(game, scope, () => save(game, scope, null)),
    retry: (game, scope) => withNotice(game, scope, () => retry(game, scope)),
    status, peek
  });
})(window);
