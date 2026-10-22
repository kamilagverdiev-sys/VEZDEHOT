'use strict';

// Server-only webhook. Do not copy this file into the static dist directory.
const { createHash, timingSafeEqual } = require('node:crypto');
const MAX_BODY = 64 * 1024;
const MAX_REPLIES = 2048;
const REPLAY_TTL = 24 * 60 * 60 * 1000;
const replies = new Map();
const ORIGIN = 'https://vezdehot.vercel.app';
const GAMES = Object.freeze({
  durak: { title: 'Дурак', path: '/index.html?game=durak' },
  bunker: { title: 'Бункер', path: '/index.html?game=bunker' },
  poker: { title: 'Покер', path: '/poker.html' },
  mafia: { title: 'Мафия', path: '/mafia.html' },
  monopoly: { title: 'Монополия', path: '/monopoly.html' }
});

function button(text, path) { return { text, web_app: { url: ORIGIN + path } }; }
function gamesKeyboard() {
  return [
    [button('Дурак', GAMES.durak.path), button('Бункер', GAMES.bunker.path)],
    [button('Покер', GAMES.poker.path), button('Мафия', GAMES.mafia.path)],
    [button('Монополия', GAMES.monopoly.path)],
    [button('Все игры', '/index.html'), button('Мой профиль', '/index.html?profile=1')]
  ];
}

function replyFor(text) {
  const command = /^\/(start|play|games|profile|help)(?:@[a-zA-Z0-9_]{1,32})?(?:\s+([^\s]{1,64}))?(?:\s.*)?$/i.exec(text.trim());
  if (!command) return null;
  const name = command[1].toLowerCase(), slug = (command[2] || '').toLowerCase();
  const game = Object.hasOwn(GAMES, slug) ? GAMES[slug] : null;
  if ((name === 'start' || name === 'play') && game) return {
    text: `${game.title} · VEZDEHOT\n\nОткрой игру прямо в Telegram. Партии идут с ботами и сохраняются на этом устройстве.`,
    reply_markup: { inline_keyboard: [[button(`Играть · ${game.title}`, game.path)], [button('Все игры', '/index.html')]] }
  };
  if (name === 'profile') return {
    text: 'Твой профиль VEZDEHOT\n\nНик, аватар и статистика доступны в приложении. Без отдельного входа ты играешь как гость: запуск через бота не создаёт и не подтверждает аккаунт. В профиле можно отдельно подтвердить вход через Telegram.',
    reply_markup: { inline_keyboard: [[button('Открыть мой профиль', '/index.html?profile=1')]] }
  };
  if (name === 'help') return {
    text: 'VEZDEHOT · помощь\n\n/start — открыть игровую\n/play — выбрать игру\n/games — все пять игр\n/profile — ник, аватар и статистика\n/help — эта подсказка\n\nМожно написать /play durak, /play bunker, /play poker, /play mafia или /play monopoly. Игры работают с ботами; игровой баланс — виртуальные монеты. По умолчанию ты гость. Для аккаунта открой профиль и отдельно подтверди вход через Telegram внутри Mini App.',
    reply_markup: { inline_keyboard: [[button('Открыть игровую', '/index.html')]] }
  };
  return {
    text: name === 'start'
      ? 'VEZDEHOT · твоя игровая всегда рядом\n\nПять настольных игр с ботами. Выбирай стол, меняй ник и играй в своём темпе. Можно начать гостем — без регистрации.\n\nЗапуск в Telegram не выполняет вход в аккаунт; гостевой прогресс хранится на этом устройстве.'
      : 'Во что играем?\n\nКарточный стол, скрытые роли или город недвижимости — выбирай игру. Каждая открывается прямо в Telegram.',
    reply_markup: { inline_keyboard: gamesKeyboard() }
  };
}

function answer(res, status, code) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(code ? { ok: false, error: code } : { ok: true }));
}

function authorized(header, secret) {
  if (typeof header !== 'string' || header.length > 256) return false;
  // Equal-length digests keep the actual secret comparison constant-time.
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(secret));
}

async function readBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BODY)) {
    throw Object.assign(new Error('body'), { status: 413 });
  }
  let body = req.body;
  if (body === undefined) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > MAX_BODY) throw Object.assign(new Error('body'), { status: 413 });
      chunks.push(part);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  // Vercel may have parsed JSON already. Bound both parsed and streaming forms.
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_BODY) {
    throw Object.assign(new Error('body'), { status: 413 });
  }
  return typeof body === 'string' ? JSON.parse(body) : body;
}

async function sendMessage(token, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(7000), redirect: 'error'
  });
  // A blocked/deleted private chat is terminal: retrying cannot deliver a reply.
  if (response.status === 403) { await response.body?.cancel(); return; }
  if (!response.ok) { await response.body?.cancel(); throw new Error('telegram_unavailable'); }
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('telegram_response_too_large');
    chunks.push(Buffer.from(chunk));
  }
  if (JSON.parse(Buffer.concat(chunks).toString('utf8')).ok !== true) throw new Error('telegram_rejected');
}

async function deliverOnce(updateId, send) {
  const now = Date.now();
  for (const [id, entry] of replies) if (entry.done && entry.expires <= now) replies.delete(id);
  const existing = replies.get(updateId);
  if (existing) return existing.promise;
  if (replies.size >= MAX_REPLIES) {
    const oldest = [...replies].find(([, value]) => value.done);
    if (oldest) replies.delete(oldest[0]);
    else throw new Error('busy');
  }
  const entry = { done: false, expires: now + REPLAY_TTL };
  entry.promise = Promise.resolve().then(send).then(() => { entry.done = true; }, error => {
    replies.delete(updateId); throw error;
  });
  replies.set(updateId, entry);
  return entry.promise;
}

module.exports = async function telegram(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return answer(res, 405, 'method_not_allowed'); }
  const token = process.env.TELEGRAM_BOT_TOKEN, secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!/^\d+:[a-zA-Z0-9_-]{20,}$/.test(token || '') || !/^[a-zA-Z0-9_-]{16,256}$/.test(secret || '')) return answer(res, 503, 'not_configured');
  if (!authorized(req.headers['x-telegram-bot-api-secret-token'], secret)) return answer(res, 401, 'unauthorized');
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return answer(res, 415, 'json_required');
  let update;
  try { update = await readBody(req); } catch (error) { return answer(res, error.status || 400, 'invalid_body'); }
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return answer(res, 400, 'invalid_update');
  const msg = update.message;
  // Ignore groups, edited messages, service updates, bots and arbitrary prose.
  if (!msg || msg.chat?.type !== 'private' || !Number.isSafeInteger(msg.chat.id) || msg.chat.id <= 0 ||
      msg.from?.is_bot !== false || msg.from.id !== msg.chat.id || typeof msg.text !== 'string' || msg.text.length > 4096) return answer(res, 200);
  const reply = replyFor(msg.text);
  if (!reply) return answer(res, 200);
  try {
    await deliverOnce(update.update_id, () => sendMessage(token, { chat_id: msg.chat.id, ...reply, disable_notification: true }));
    return answer(res, 200);
  } catch {
    // Do not expose provider responses or token-bearing fetch errors to clients/logs.
    return answer(res, 502, 'delivery_failed');
  }
};
