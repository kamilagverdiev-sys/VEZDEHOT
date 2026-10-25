# Вход в VEZDEHOT

На 23 октября 2026 года в публичных настройках проекта Supabase наблюдались `anonymous: false` и `external.google: false`. Локальный гостевой режим работает самостоятельно. Google и Telegram OIDC требуют настройки credentials; Telegram Mini App использует отдельную серверную проверку подписанных данных. Наличие кнопки не подтверждает успешный вход: аккаунт появляется только после подтверждённой Supabase session.

## Адреса

Проект Supabase: `cyzbraifdkrqicdsbuwe`.

| Где указать | Адрес |
| --- | --- |
| Google Authorized redirect URI и Telegram OIDC Redirect URI | `https://cyzbraifdkrqicdsbuwe.supabase.co/auth/v1/callback` |
| Supabase Site URL | `https://vezdehot.vercel.app` |
| Supabase Additional Redirect URLs — Vercel | `https://vezdehot.vercel.app/auth-callback.html` |
| Supabase Additional Redirect URLs — Sites | `https://vezdehot.greysquid7.chatgpt.site/auth-callback.html` |

Callback из карточки провайдера в Supabase должен совпадать с первым адресом. У Google/Telegram указывается callback **Supabase**, а в Supabase разрешаются конечные адреса **приложения**. Добавляйте точные production-адреса; wildcard для всех доменов не нужен. Приложение возвращает пользователя на callback своего текущего origin.

## Google

1. В Google Cloud → Google Auth Platform настройте Branding, Audience и контакт владельца. Для внешнего приложения проверьте статус публикации; в Testing вход ограничен добавленными test users.
2. Создайте OAuth Client типа **Web application**. Добавьте production-origin Vercel и Sites в Authorized JavaScript origins, а callback Supabase из таблицы — в Authorized redirect URIs.
3. В Supabase → Authentication → Sign In / Providers → Google включите провайдер и сохраните полученные Client ID и Client Secret. Достаточно scopes `openid`, `email`, `profile`.
4. Добавьте оба конечных redirect приложения в Supabase → URL Configuration.
5. Пройдите реальный вход тестовым аккаунтом, выход и повторный вход, затем проверьте восстановление собственного профиля.

Публичный `GET https://cyzbraifdkrqicdsbuwe.supabase.co/auth/v1/settings` с заголовком `apikey` существующего publishable key позволяет приложению обнаружить `external.google`. До подтверждённого `true` интерфейс сообщает, что Google ещё не подключён; при недоступности настроек гостевой режим остаётся доступен.

## Telegram Mini App: вход внутри бота

`VesdehotBot` открывает игру внутри Telegram. При наличии `Telegram.WebApp.initData` клиент отправляет **только подписанную строку** в `https://cyzbraifdkrqicdsbuwe.supabase.co/functions/v1/telegram-auth`. Edge Function проверяет Ed25519-подпись Telegram, bot ID `8412086640` и время данных, сопоставляет проверенный Telegram ID с Supabase user ID и возвращает одноразовый `token_hash`. Клиент завершает вход через `auth.verifyOtp({token_hash, type: 'magiclink'})`. `initDataUnsafe` не является доказательством личности и не используется.

В `dist/auth-config.js` для этого пути находятся публичные `telegramMiniAppEnabled: true` и `telegramAuthUrl`. Функция должна быть опубликована с `verify_jwt: false`: вход проверяется подписью Telegram, а у гостя ещё нет пользовательского JWT. CORS разрешает только Vercel и Sites из таблицы; серверные права Supabase остаются в окружении Edge Function. Доверенная метка `app_metadata.telegram_id` используется для отображения подключённого Telegram.

В обычном браузере кнопка **«Открыть в Telegram»** открывает `https://t.me/VesdehotBot` и объясняет подтверждение внутри бота. Открытие ссылки само по себе не авторизует пользователя. Подписанные данные появляются при запуске игры через Telegram; SDK сообщает готовность событием `vezdehot:telegramready`, после которого интерфейс обновляет доступность входа.

Этот способ не объединяет уже открытый Google/OIDC-аккаунт с Telegram. Сначала нужно выйти; профили остаются отдельными. Для явного связывания способов используйте OIDC и manual identity linking, описанные ниже. Настоящий успешный вход проверяется внутри Telegram, а не подстановкой клиентского `user.id`.

## Telegram: дополнительный браузерный OAuth / OIDC

1. В BotFather выберите бота (или создайте бота проекта), откройте **Login Widget** и настройку **OIDC**. Зарегистрируйте точный Redirect URI Supabase из таблицы. Получите OIDC Client ID и Client Secret; это не публичные настройки сайта.
2. В Supabase → Authentication → Providers → **New Provider** выберите **Auto-discovery (OIDC)**. Укажите выданные BotFather Client ID и Client Secret в соответствующих полях Dashboard.
3. Используйте следующие значения провайдера:

| Поле | Значение |
| --- | --- |
| Provider type | `oidc` |
| Identifier | `custom:telegram` |
| Name | `Telegram` |
| Issuer | `https://oauth.telegram.org` |
| Scopes | `openid`, `profile` |
| Email optional | `true` |
| PKCE enabled | `true` |
| Skip nonce check | `false` |

Telegram не предоставляет email, поэтому `email_optional` обязателен. Телефон и разрешение боту писать пользователю для входа не нужны. Supabase проверяет OIDC-токен и хранит secret; отдельный Telegram token exchange в статическом клиенте не требуется.

В публичном `dist/auth-config.js` флаг **`telegramEnabled`** должен оставаться `false`, пока OIDC-провайдер не настроен; это отдельный флаг от `telegramMiniAppEnabled`. Включайте его только после настройки и проверки перехода. Этот файл содержит только публичные параметры и флаги; не помещайте туда Client Secret, bot token, Supabase secret key или `service_role`. Не считайте наличие кнопки или флага доказательством успешной авторизации.

## Один профиль, разные способы входа

Для OIDC в Supabase рекомендуется включить **Manual Identity Linking**, затем установить публичный `manualLinkingEnabled: true`. Подключайте второй способ через `auth.linkIdentity()` только из уже открытого аккаунта. Telegram и Google не объединяются автоматически по email: у Telegram email нет. Обычный повторный `signInWithOAuth()` может открыть другой аккаунт. Нативный Mini App путь не вызывает `linkIdentity()` и не объединяет аккаунты автоматически.

Локальный гость хранится отдельно от каждого `auth.uid()`. При входе существующее облачное сохранение имеет собственную историю; нельзя автоматически записывать поверх него общий браузерный snapshot или складывать балансы. Перенос гостевого прогресса допустим в новый профиль без сохранений, а при конфликте нужен явный выбор. При выходе восстанавливается гостевой профиль, а не данные предыдущего аккаунта. На Vercel и Sites разные браузерные хранилища: общими для них становятся профиль и пять сохранённых партий после входа в тот же аккаунт и подтверждённой синхронизации. Все состояния переносятся вместе с балансом; при разных локальных ветках нужен явный выбор облачной версии.

Анонимный Supabase Auth для локального гостя включать не обязательно. Если позднее используется `signInAnonymously()`, переход к постоянному аккаунту делается через `linkIdentity()`; анонимный пользователь получает PostgreSQL-роль `authenticated`, а не `anon`.

## Проверка перед объявлением входа готовым

На страницах локальный `vendor/supabase-2.118.0.js` загружается перед `auth-config.js`, затем общие валидаторы, `game-store.js`, `tab-session.js`, `cloud-checkpoint.js` и `platform.js`. Для production включён `checkpointsEnabled`; запись профиля и результатов выполняется только через атомарный RPC, описанный в [контракте сохранений](CLOUD_CHECKPOINT_CONTRACT.md). Доступ к профилю и запуск сохранённых игр выполняется после `VEZDEHOT.ready`. При событии `vezdehot:accountchange` игра останавливает таймеры; общий API замораживает мутации до перехода в лобби. Регрессионные тесты: `node tests/platform-auth.cjs`.

- Оба провайдера возвращают на разрешённый callback без секретов в URL/коде сайта; отмена и ошибка оставляют понятное сообщение и доступ к гостевому режиму.
- Сессия подтверждена Supabase, повторное открытие сохраняет вход, выход не показывает чужой профиль.
- Аккаунты A и B на одном браузере не видят и не перезаписывают локальные или облачные данные друг друга, включая медленный ответ сети при переключении.
- Чтение профиля защищено RLS по `auth.uid()`, изменения проходят owner-only checkpoint RPC с проверкой серверной версии. Прямая запись клиентом в `profiles` и `player_results` запрещена. `user_metadata` не используется для прав доступа.
- Подключение Google и Telegram из одного аккаунта сохраняет тот же user ID. Конфликт уже существующей identity обрабатывается сообщением, без скрытого слияния профилей.
- В Telegram Mini App реальная подпись принимается сервером; неверная/просроченная отклоняется. Обычный браузер предлагает открытие бота, а не выдуманную авторизацию. Подтверждение Native Mini App и связывание OIDC проверяются отдельно.

## Официальные документы

- [Supabase Google](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase Custom OAuth/OIDC](https://supabase.com/docs/guides/auth/custom-oauth-providers)
- [Пример Telegram OIDC у Supabase](https://supabase.com/docs/guides/self-hosting/self-hosted-custom-oauth-providers)
- [Telegram Login / OIDC](https://core.telegram.org/bots/telegram-login)
- [Supabase Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
- [Supabase Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)
