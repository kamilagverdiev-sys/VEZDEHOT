/* Telegram presentation bridge. Launch data is never used as account identity. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search);
  const marker = 'vezdehot:telegram-launch';
  const directLaunch = [params, query].some(p => p.has('tgWebAppData') || (p.has('tgWebAppVersion') && p.has('tgWebAppPlatform')));
  let launched = directLaunch;
  // Only a boolean launch marker is ours. The official SDK owns its initParams
  // persistence; raw signed launch data is never copied into our storage.
  try {
    if (directLaunch) sessionStorage.setItem(marker, '1');
    else launched = sessionStorage.getItem(marker) === '1';
  } catch { /* Direct launches still work if session storage is unavailable. */ }
  if (!launched) return;

  function connect() {
    const app = window.Telegram?.WebApp;
    if (!app) return;
    const root = document.documentElement;
    root.classList.add('vh-telegram');
    function viewport() {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const safe = Number(app.safeAreaInset?.[side]) || 0;
        const content = Number(app.contentSafeAreaInset?.[side]) || 0;
        const value = Math.min(300, Math.max(0, safe) + Math.max(0, content));
        root.style.setProperty('--vh-tg-' + side, value + 'px');
      }
      if (Number.isFinite(app.viewportStableHeight) && app.viewportStableHeight > 0) root.style.setProperty('--vh-tg-height', app.viewportStableHeight + 'px');
    }
    const style = document.createElement('style');
    style.textContent = 'html.vh-telegram{--safe-t:max(env(safe-area-inset-top,0px),var(--vh-tg-top,0px));--safe-b:max(env(safe-area-inset-bottom,0px),var(--vh-tg-bottom,0px));scroll-padding-top:var(--safe-t)}html.vh-telegram body{padding-left:var(--vh-tg-left,0px);padding-right:var(--vh-tg-right,0px)}html.vh-telegram .vh-overlay{padding-top:max(12px,var(--vh-tg-top,0px));padding-bottom:max(12px,var(--vh-tg-bottom,0px))}';
    document.head.appendChild(style);
    viewport();
    app.onEvent?.('viewportChanged', viewport);
    if (app.isVersionAtLeast?.('8.0')) {
      app.onEvent?.('safeAreaChanged', viewport);
      app.onEvent?.('contentSafeAreaChanged', viewport);
    }
    try { app.setHeaderColor?.('#0d1020'); app.setBackgroundColor?.('#0d1020'); } catch { /* Older Telegram clients keep their native colors. */ }
    app.ready();
    app.expand();
    const inGame = !/\/(?:index(?:\.html)?)?$/.test(location.pathname) || query.has('game') || query.has('profile');
    if (inGame && app.BackButton) {
      app.BackButton.onClick(() => {
        // Only a fixed same-origin destination; never use return URLs or launch data.
        location.assign(new URL('./index.html', location.href).href);
      });
      app.BackButton.show();
    } else app.BackButton?.hide();
    document.dispatchEvent(new CustomEvent('vezdehot:telegramready'));
  }

  if (window.Telegram?.WebApp) connect();
  else {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js?64';
    script.async = true;
    script.onload = connect;
    // The games remain usable if Telegram's SDK is unavailable.
    script.onerror = () => {};
    document.head.appendChild(script);
  }
})();
