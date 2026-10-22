# Telegram · VEZDEHOT

The bot opens the five existing games in Telegram Mini Apps. Commands: `/start`, `/play`, `/games`, `/profile`, `/help`. It replies only in private chats. Game results, account identity and balances are never accepted through chat commands.

Launching a Mini App does **not** sign the player in. The website starts with its ordinary guest/account flow. Players may explicitly confirm Telegram login in the profile panel; that separate authentication endpoint verifies signed Telegram data before creating a session. The presentation bridge does not authenticate users, read Telegram user data or turn launch markers into a trusted identity. Google login remains a separate provider configuration.

## Deployment layout

Deploy from the project root with both `api/telegram.js` and the static `dist` output. The Node.js function must serve `https://vezdehot.vercel.app/api/telegram`; `dist/index.html`, games, assets and `dist/telegram.js` remain public static assets. Do not copy the server function into `dist`, and do not apply an SPA fallback to `/api/*`.

Use the Node.js runtime (Node 24 recommended), with at least a 15-second function duration. The handler has no npm dependencies. It uses the normal Vercel Node `req, res` signature and supports both a parsed JSON `req.body` and a raw request stream. A successful `GET /api/telegram` check is **405**, since this endpoint accepts webhook POSTs only. `POST` without the secret returns **401** once configuration is present, or **503** while secrets are missing.

Load `./telegram.js` on every game page and the lobby. The bridge downloads the official Telegram SDK after launch parameters are observed, then calls `ready()` / `expand()` and enables Telegram's back button on a game or profile URL. It stores only a boolean in session storage so normal navigation within the same Mini App can reload the SDK; the SDK manages its own initialization parameters. It dispatches `vezdehot:telegramready` on `document` after connecting so account UI can update. It sets `--safe-t` and `--safe-b`; page containers should use these variables for top/bottom padding. The website must handle `index.html?game=durak`, `index.html?game=bunker` and `index.html?profile=1` after its shared platform is ready.

## Required production secrets

Set these as server-only Vercel environment variables, scoped to **Production**, then deploy again:

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The bot token issued by BotFather. Never place it in browser code, static assets, a URL sent to users, committed configuration, or logs. |
| `TELEGRAM_WEBHOOK_SECRET` | A freshly generated random secret, 16–256 characters using only `A–Z`, `a–z`, `0–9`, `_`, `-`. Recommended: 32 random bytes encoded as base64url. This is separate from the bot token. |

Generate the webhook secret in a secure local process with `require('node:crypto').randomBytes(32).toString('base64url')`. Pass it directly to the environment-variable store instead of printing it into a shared transcript. Do not attach the production webhook to preview deployments. Rotate the bot token in BotFather if it has been disclosed publicly.

## Register the webhook and menu

Run the following Node 24 script once from a secure environment where both variables are already loaded. It does not print the token, secret or provider error payloads. Do not paste token values into the code or command line. Setting `drop_pending_updates: false` preserves pending updates; `max_connections: 1` reduces delivery concurrency for this small bot.

```js
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token || !/^[A-Za-z0-9_-]{16,256}$/.test(secret || '')) {
  throw new Error('Missing Telegram server environment variables');
}
const origin = 'https://vezdehot.vercel.app';
async function call(method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000)
    });
  } catch { throw new Error(`${method}: network failure`); }
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(`${method}: rejected`);
  return result.result;
}
await call('setWebhook', {
  url: `${origin}/api/telegram`, secret_token: secret,
  allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false
});
await call('setMyCommands', { commands: [
  { command: 'start', description: 'Открыть игровую VEZDEHOT' },
  { command: 'play', description: 'Выбрать игру' },
  { command: 'games', description: 'Все пять игр' },
  { command: 'profile', description: 'Ник, аватар и статистика' },
  { command: 'help', description: 'Как играть и пользоваться ботом' }
] });
await call('setChatMenuButton', { menu_button: {
  type: 'web_app', text: 'Играть', web_app: { url: `${origin}/index.html` }
} });
const status = await call('getWebhookInfo', {});
console.log({ url: status.url, pendingUpdates: status.pending_update_count,
  hasRecentError: Boolean(status.last_error_date), allowedUpdates: status.allowed_updates });
```

In BotFather, optionally set the bot's Main Mini App to `https://vezdehot.vercel.app/index.html` and choose its icon/loading colors. The inline game buttons work in private chat and use only fixed URLs on this domain. `/start mafia` and `/play mafia` open the Mafia table; the other accepted names are `durak`, `bunker`, `poker`, `monopoly`. Unknown arguments fall back to the game menu.

## Verify

Run `node tests/telegram-bot.cjs` locally. After deploying and registering the webhook, open the bot's private chat and send each command. Check that all five game buttons open their intended page, `/profile` opens the account panel, and back navigation returns to the lobby. Test on iOS/Android for visible controls around Telegram's safe areas. Repeat `/play` after closing and reopening the Mini App. Check `getWebhookInfo` for an empty error state and a draining pending-update count.

## Delivery behavior and limits

The endpoint verifies the mandatory secret header using `timingSafeEqual` over fixed-size SHA-256 digests. It rejects non-JSON/oversized bodies (64 KiB), uses a seven-second timeout and no redirects for the Telegram request, limits the provider response size, and never echoes provider errors. Invalid or absent secrets cause no outgoing call. Non-private chats, edits, bot senders and unrelated text are acknowledged without a reply.

Concurrent or completed replayed `update_id` values are deduplicated in one warm function instance (up to 2,048 IDs, 24-hour TTL; oldest completed entries are evicted when full). Transient send failures return 502 and allow Telegram to retry; a blocked chat (403) is acknowledged. **This is not a durable exactly-once guarantee:** a cold start, another instance, or a lost response after Telegram accepted a message may duplicate a reply. No database/user records are written. Stronger delivery guarantees require a separate durable idempotency store, which is intentionally not configured here.

The Mini App bridge uses launch markers for presentation only. It does not persist raw launch data, request contact details, claim bonuses, change profiles or verify Telegram authentication. Opening a normal browser page without a prior Mini App launch in that tab does not load Telegram's SDK. A boolean launch marker survives same-tab navigation; it is never sufficient to authorize an account. Login requires a separate explicit action and server verification of signed data.

Official references, checked 2026-10-22: [Telegram webhook API](https://core.telegram.org/bots/api#setwebhook), [Mini App initialization and safe areas](https://core.telegram.org/bots/webapps#initializing-mini-apps), [Vercel Node.js functions](https://vercel.com/docs/functions/runtimes/node-js).
