# VEZDEHOT third-party notices

The current production build uses lightweight CSS card faces, card backs, table textures, dice and motion effects. The referenced repositories below were reviewed as optional sources; their files are not bundled into the current static build.

## Optional CC0 assets

- [Kenney Boardgame Pack](https://opengameart.org/content/boardgame-pack) — CC0.
- [Classic 4-Color Poker Deck](https://opengameart.org/node/187141) — CC0.
- [Kenney Casino Audio](https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips) — CC0.

## Optional libraries and assets

- [SVG-cards](https://github.com/htdebeer/SVG-cards) — LGPL-2.1. If bundled in a future release, include the LGPL text and preserve the source link.
- [canvas-confetti](https://github.com/catdad/canvas-confetti) — ISC. If added as a dependency, include its ISC notice.
- [dice-box](https://github.com/3d-dice/dice-box) — MIT. If bundled, retain its MIT notice and required public assets.
- [roll-a-die](https://github.com/drdreo/dice-roller-3d) — MIT.

No attribution is required for the CC0 sources, but the links are retained here for provenance and future asset updates.

## Bundled dependency

- `@supabase/supabase-js` 2.118.0 — MIT, Supabase Inc. Pinned browser UMD build in `dist/vendor/supabase-2.118.0.js`; license in `dist/vendor/SUPABASE-LICENSE.txt`.
- Telegram Mini Apps SDK is loaded from Telegram's official server only when launched with a Telegram marker. It is not copied into this repository.
