# Telegram Mini App authentication

Deploy `index.ts` as `telegram-auth` with JWT verification **disabled**. Telegram's Ed25519 signature is the authentication gate; the browser may send the public Supabase API key. The function uses built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` server secrets. It does not need or accept a Telegram bot token.

Allowed origins are exactly `https://vezdehot.vercel.app` and `https://vezdehot.greysquid7.chatgpt.site`. The server's bot ID is `8412086640` (`VesdehotBot`), and only Telegram's production public key is accepted in production. Do not expose a runtime request/environment override for either value.

Client contract:

```js
const response = await fetch(telegramAuthUrl, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', apikey: supabasePublicKey},
  body: JSON.stringify({initData: window.Telegram.WebApp.initData})
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.error);
const {data, error} = await supabase.auth.verifyOtp({
  token_hash: payload.token_hash,
  type: 'magiclink'
});
```

This endpoint supports **Mini App `initData`**, not the separate Telegram Login Widget payload or `initDataUnsafe`. The signed data must be no older than 600 seconds and no more than 30 seconds in the future. Reopen the Mini App after expiry. Duplicate query parameters, malformed percent encoding, unsafe IDs, unexpected body fields, and bodies over 16 KiB are rejected. Responses use `Cache-Control: no-store`; neither initData nor issued credentials are logged.

The migration `20261022103414_verified_telegram_identities.sql` owns the private identity mapping. Anonymous/authenticated clients have no table privileges; service role needs SELECT and INSERT. Creation uses a dedicated synthetic email, server-owned `app_metadata.telegram_id`, and a new Supabase account. Existing Google/other accounts are not merged. A creation collision can only be resolved by re-reading the private mapping, never by looking up an email. Both the mapped user and the generated link's returned user must match the verified Telegram identity before a token hash is returned.

If insertion fails, the function first re-reads the authoritative mapping. If no row exists, it attempts to delete **only the user newly created by that same request**, so retrying can create it again. If the lookup is unavailable, the function does not delete an account. An unknown create request outcome, unavailable lookup, or failed rollback can therefore require operator repair: inspect the private mapping and trusted account metadata in a privileged server environment. Never repair an identity by trusting client fields or simply adopting an existing email account.

Every backend request has an 8-second abort deadline and disallows redirects. A short per-isolate one-request-per-second guard expires automatically and returns `429` with `Retry-After: 1`. It is not a distributed rate limiter. Valid signed initData can be reused within its 10-minute lifetime; the exchanged Supabase token is consumed by verifyOtp. Reopening/retrying does not permanently consume the Telegram identity.

Run offline tests with `node tests/telegram-auth.cjs`. The fixtures generate their own Ed25519 keypair and inject that public key directly into test functions; HTTP requests cannot choose a verification key. Tests cover signature/audience/date validation, body/origin checks, account collisions, failed-provision rollback, mapping and token-target spoofing, and retry expiry. They do not substitute for a real signed login opened from the configured Telegram bot.

References:

- https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
- https://supabase.com/docs/reference/javascript/auth-admin-generatelink
- https://supabase.com/docs/reference/javascript/auth-admin-getuserbyid
- https://supabase.com/docs/reference/javascript/auth-verifyotp
- https://github.com/supabase/auth-js/blob/master/src/lib/fetch.ts (`_generateLinkResponse`: raw response has top-level `hashed_token`, `verification_type`, and user fields)
- https://github.com/supabase/auth/blob/master/internal/api/verify.go (`verifyTokenHash`/`verifyPost` accept `magiclink` token hashes; `email` is the general email-OTP type)
