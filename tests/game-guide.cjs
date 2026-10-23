'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../dist/game-guide.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const datasetName = name => name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, options) {
    const handlers = this.listeners.get(type) || [];
    handlers.push({fn, once: !!options?.once}); this.listeners.set(type, handlers);
  }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.fn !== fn)); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.defaultPrevented ||= false;
    event.preventDefault ||= function () { this.defaultPrevented = true; };
    event.stopPropagation ||= function () { this.propagationStopped = true; };
    event.currentTarget = this;
    for (const item of [...(this.listeners.get(event.type) || [])]) {
      item.fn.call(this, event); if (item.once) this.removeEventListener(event.type, item.fn);
    }
    if (typeof this['on' + event.type] === 'function') this['on' + event.type](event);
    if (event.bubbles !== false && !event.propagationStopped && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

function matches(element, selector) {
  if (!element || element.nodeType !== 1) return false;
  selector = selector.trim();
  if (!selector) return false;
  const excluded = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
  if (excluded.some(part => matches(element, part))) return false;
  selector = selector.replace(/:not\([^)]+\)/g, '');
  if (selector.includes(':disabled') && !element.disabled) return false;
  if (selector.includes(':enabled') && element.disabled) return false;
  selector = selector.replace(/:(?:disabled|enabled)/g, '');
  const attributes = [...selector.matchAll(/\[([^\]=\s]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g)];
  for (const match of attributes) {
    const value = element.getAttribute(match[1]);
    if (match[2] === undefined ? value === null : value !== match[2]) return false;
  }
  selector = selector.replace(/\[[^\]]+\]/g, '');
  const id = selector.match(/#([\w-]+)/); if (id && element.id !== id[1]) return false;
  for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(match[1])) return false;
  const tag = selector.match(/^[a-zA-Z][\w-]*/); if (tag && element.tagName !== tag[0].toUpperCase()) return false;
  return true;
}

class Element extends Target {
  constructor(tag, document) {
    super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.childNodes = this.children; this.attributes = new Map(); this.dataset = {};
    this.hidden = false; this.inert = false; this.disabled = false; this.className = ''; this.id = ''; this._text = '';
    this.style = {setProperty(name, value) { this[name] = value; }};
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? 'add' : 'remove'](name); return add; }
    };
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { return !!this.parentNode && (this.parentNode.nodeType === 9 || this.parentNode.isConnected); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this.children.length = 0; this._text = String(value ?? ''); }
  set innerHTML(_) { throw new Error('Guide modal must construct DOM nodes, not assign innerHTML'); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get offsetParent() { return this.hidden ? null : this.parentElement; }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === 'string') { const text = new Element('span', this.ownerDocument); text.textContent = node; node = text; }
      node.remove?.(); node.parentNode = this; this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  removeChild(node) { const index = this.children.indexOf(node); if (index >= 0) { this.children.splice(index, 1); node.parentNode = null; } return node; }
  remove() { this.parentNode?.removeChild?.(this); }
  setAttribute(name, value) {
    value = String(value); this.attributes.set(name, value);
    if (name.startsWith('data-')) this.dataset[datasetName(name)] = value;
    else if (name === 'class') this.className = value;
    else if (name === 'id') this.id = value;
    else if (name === 'tabindex') this.tabIndex = Number(value);
    else if (['hidden', 'disabled', 'inert'].includes(name)) this[name] = true;
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[datasetName(name)] ?? null;
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    if (name === 'tabindex' && this.tabIndex !== undefined) return String(this.tabIndex);
    if (['hidden', 'disabled', 'inert'].includes(name)) return this[name] ? '' : null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) delete this.dataset[datasetName(name)];
    else if (['hidden', 'disabled', 'inert'].includes(name)) this[name] = false;
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) { return selector.split(',').some(part => matches(this, part)); }
  querySelectorAll(selector) {
    const selected = [];
    for (const child of this.children) { if (child.matches(selector)) selected.push(child); selected.push(...child.querySelectorAll(selector)); }
    return selected;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  getClientRects() { return this.hidden || this.parentElement?.hidden ? [] : [{}]; }
  blocked() { return this.disabled || this.hidden || this.inert || !!this.parentElement?.blocked(); }
  focus() {
    if (!this.isConnected || this.blocked()) return;
    this.ownerDocument.activeElement = this;
    this.dispatchEvent({type: 'focusin', bubbles: true});
  }
  click() { if (!this.blocked()) this.dispatchEvent({type: 'click', bubbles: true}); }
  scrollIntoView() {}
}

function harness() {
  const document = new Target(); document.nodeType = 9;
  document.createElement = tag => new Element(tag, document);
  document.body = document.createElement('body'); document.body.parentNode = document;
  document.documentElement = document.createElement('html');
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.getElementById = id => document.body.querySelector('#' + id);
  const app = document.createElement('main'), trigger = document.createElement('button'), priorInert = document.createElement('aside');
  trigger.textContent = 'Открыть обучение'; app.append(trigger); priorInert.inert = true; document.body.append(app, priorInert); document.activeElement = trigger;
  const window = new Target(), controls = {owner: true}, effects = [], timers = new Set();
  const effect = name => (...args) => { effects.push({name, args}); throw new Error('Unexpected side effect: ' + name); };
  const localStorage = {getItem: effect('storage.read'), setItem: effect('storage.write'), removeItem: effect('storage.delete')};
  Object.assign(window, {document, localStorage, VEZDEHOT_TAB_SESSION: {canWrite: () => controls.owner},
    VEZDEHOT: new Proxy({}, {get: (_, method) => effect('platform.' + String(method))}),
    VEZDEHOT_GAME_STORE: new Proxy({}, {get: (_, method) => effect('game.' + String(method))})
  });
  const timeout = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const context = {window, document, localStorage, console, setTimeout: timeout, clearTimeout: id => { clearTimeout(id); timers.delete(id); },
    requestAnimationFrame: fn => timeout(fn, 0), cancelAnimationFrame: clearTimeout, queueMicrotask,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    HTMLElement: Element, Element
  };
  vm.runInNewContext(source, context);
  return {api: window.VEZDEHOT_GUIDE, window, document, app, trigger, priorInert, controls, effects,
    get dialog() { return document.body.querySelector('[role="dialog"]'); },
    get overlay() { return document.body.children.find(node => node !== app && node !== priorInert) || null; },
    close() { for (const timer of timers) clearTimeout(timer); timers.clear(); }
  };
}

function fixture(extra = {}) {
  return {game: 'poker', title: 'Покер: понятная игра', context: {title: 'Сейчас ваш ход', text: 'Проверьте банк и доступные действия.'},
    sections: [{title: 'Как сравнить карты', text: 'Старшая комбинация забирает банк.'}, {title: 'Равные руки', text: 'При равенстве банк делится.'}],
    lessons: [
      {id: 'hand', title: 'Сравнение рук', prompt: 'Что проверить перед решением?', choices: [
        {label: 'Забрать чужие фишки', correct: false, feedback: 'Фишки других игроков нельзя присвоить.'},
        {label: 'Проверить комбинацию', correct: true, feedback: 'Верно: сравните свою комбинацию с общими картами.'}
      ]},
      {id: 'tie', title: 'Делёж банка', prompt: 'Что происходит при равных комбинациях?', choices: [
        {label: 'Банк делится', correct: true, feedback: 'Да, победители делят банк.'},
        {label: 'Всегда побеждает дилер', correct: false, feedback: 'Положение дилера не определяет победителя.'}
      ]}
    ], ...extra};
}
function button(h, selector) { const found = h.dialog?.querySelector(selector); assert.ok(found, `Missing guide button: ${selector}`); return found; }
function choice(h, label) { const found = h.dialog?.querySelectorAll('[data-guide-choice]').find(node => node.textContent.includes(label)); assert.ok(found, `Missing choice: ${label}`); return found; }
function visibleText(node) { return !node || node.hidden ? '' : node._text + node.children.map(visibleText).join(''); }

test('guide exports the shared API and opens an accessible contextual dialog', async t => {
  const h = harness(); t.after(() => h.close());
  for (const method of ['open', 'journal', 'tip']) assert.equal(typeof h.api[method], 'function');
  h.api.open(fixture({trigger: h.trigger})); await tick();
  assert.ok(h.dialog); assert.equal(h.dialog.getAttribute('aria-modal'), 'true');
  assert.ok(h.dialog.getAttribute('aria-labelledby')); assert.equal(h.app.inert, true); assert.equal(h.priorInert.inert, true);
  assert.ok(h.dialog.contains(h.document.activeElement));
  assert.match(visibleText(h.dialog), /Сейчас ваш ход/);
  for (const name of ['now', 'rules', 'practice']) assert.ok(button(h, `[data-guide-tab="${name}"]`));
  assert.deepEqual(h.effects, []);
});

test('rules and practice switch inside the modal without touching game storage or economy', async t => {
  const h = harness(); t.after(() => h.close()); h.api.open(fixture()); await tick();
  button(h, '[data-guide-tab="rules"]').click();
  assert.match(visibleText(h.dialog), /Старшая комбинация забирает банк/);
  button(h, '[data-guide-tab="practice"]').click();
  assert.match(visibleText(h.dialog), /Что проверить перед решением/);
  button(h, '[data-guide-tab="now"]').click(); assert.match(visibleText(h.dialog), /Сейчас ваш ход/);
  assert.deepEqual(h.effects, []);
});

test('wrong practice answers explain the mistake and do not unlock the next lesson', async t => {
  const h = harness(); t.after(() => h.close()); h.api.open(fixture()); await tick();
  button(h, '[data-guide-tab="practice"]').click();
  choice(h, 'Забрать чужие фишки').click();
  assert.match(visibleText(h.dialog), /Фишки других игроков нельзя присвоить/);
  const feedback = h.dialog.querySelector('[data-guide-feedback]');
  assert.equal(feedback.getAttribute('aria-live'), 'polite'); assert.equal(h.document.activeElement, feedback);
  const next = h.dialog.querySelector('[data-guide-next]'); assert.ok(!next || next.disabled || next.hidden);
  choice(h, 'Проверить комбинацию').click();
  assert.match(visibleText(h.dialog), /Верно: сравните свою комбинацию/);
  assert.equal(button(h, '[data-guide-next]').disabled, false); button(h, '[data-guide-next]').click();
  assert.match(visibleText(h.dialog), /Что происходит при равных комбинациях/);
  const nextLesson = h.dialog.querySelector('[data-guide-next]'); assert.ok(!nextLesson || nextLesson.disabled || nextLesson.hidden);
  assert.deepEqual(h.effects, []);
});

test('Escape closes the dialog and restores trigger focus and each previous inert value', async t => {
  const h = harness(); t.after(() => h.close()); let closes = 0;
  h.api.open(fixture({trigger: h.trigger, onClose: () => closes++})); await tick();
  const event = {type: 'keydown', key: 'Escape', target: h.document.activeElement}; h.document.dispatchEvent(event);
  assert.equal(h.dialog, null); assert.equal(h.app.inert, false); assert.equal(h.priorInert.inert, true);
  assert.equal(h.document.activeElement, h.trigger); assert.equal(closes, 1);
  h.document.dispatchEvent({type: 'keydown', key: 'Escape'}); assert.equal(closes, 1);
});

test('invalid lessons with zero or multiple correct answers are skipped', async t => {
  const h = harness(); t.after(() => h.close()); const good = fixture().lessons[0];
  h.api.open(fixture({lessons: [
    {id: 'none', title: 'Неверная конфигурация', prompt: 'Нет верного ответа', choices: [{label: 'A', correct: false, feedback: 'Нет'}, {label: 'B', correct: false, feedback: 'Нет'}]},
    {id: 'two', title: 'Два верных ответа', prompt: 'Неоднозначный вопрос', choices: [{label: 'C', correct: true, feedback: 'Да'}, {label: 'D', correct: true, feedback: 'Да'}]}, good
  ]})); await tick(); button(h, '[data-guide-tab="practice"]').click();
  const text = visibleText(h.dialog); assert.match(text, /Что проверить перед решением/);
  assert.doesNotMatch(text, /Нет верного ответа|Неоднозначный вопрос/);
  assert.equal(h.dialog.querySelectorAll('[data-guide-choice]').length, good.choices.length);
});

test('context, rules, and lesson copy are literal text and cannot inject DOM', async t => {
  const h = harness(); t.after(() => h.close()); const attack = '<img src=x onerror="window.injected=true"> & <script>alert(1)</script>';
  h.api.open(fixture({title: attack, context: {title: attack, text: attack}, sections: [{title: attack, text: attack}],
    lessons: [{id: 'escape', title: attack, prompt: attack, choices: [{label: attack, correct: true, feedback: attack}, {label: 'Другая кнопка', correct: false, feedback: attack}]}]
  })); await tick();
  for (const name of ['now', 'rules', 'practice']) {
    button(h, `[data-guide-tab="${name}"]`).click();
    assert.ok(visibleText(h.dialog).includes(attack)); assert.equal(h.dialog.querySelector('img,script'), null);
  }
  choice(h, attack).click(); assert.ok(visibleText(h.dialog).includes(attack)); assert.equal(h.window.injected, undefined);
});

test('Tab and Shift+Tab stay in the modal and an outside focus attempt is redirected', async t => {
  const h = harness(); t.after(() => h.close()); h.api.open(fixture()); await tick();
  const closeButtons = h.dialog.querySelectorAll('[data-guide-close]'), first = closeButtons[0], last = closeButtons.at(-1);
  last.focus(); const next = {type: 'keydown', key: 'Tab'}; h.document.dispatchEvent(next);
  assert.equal(next.defaultPrevented, true); assert.equal(h.document.activeElement, first);
  first.focus(); const previous = {type: 'keydown', key: 'Tab', shiftKey: true}; h.document.dispatchEvent(previous);
  assert.equal(previous.defaultPrevented, true); assert.equal(h.document.activeElement, last);
  const outside = h.document.createElement('button'); h.document.body.append(outside); outside.focus();
  assert.equal(h.document.activeElement, first);
  button(h, '[data-guide-tab="practice"]').click(); choice(h, 'Забрать чужие фишки').click();
  assert.equal(h.document.activeElement.tabIndex, -1);
  const fromFeedback = {type: 'keydown', key: 'Tab'}; h.document.dispatchEvent(fromFeedback);
  assert.equal(fromFeedback.defaultPrevented, true); assert.equal(h.document.activeElement, first);
});

test('tabs implement roving keyboard selection with arrow wrapping, Home, and End', async t => {
  const h = harness(); t.after(() => h.close()); h.api.open(fixture()); await tick();
  const now = button(h, '[data-guide-tab="now"]'), rules = button(h, '[data-guide-tab="rules"]'), practice = button(h, '[data-guide-tab="practice"]');
  now.focus(); now.dispatchEvent({type: 'keydown', key: 'ArrowRight'});
  assert.equal(h.document.activeElement, rules); assert.equal(rules.getAttribute('aria-selected'), 'true'); assert.equal(now.tabIndex, -1); assert.equal(rules.tabIndex, 0);
  assert.match(visibleText(h.dialog), /Старшая комбинация забирает банк/);
  rules.dispatchEvent({type: 'keydown', key: 'End'}); assert.equal(h.document.activeElement, practice);
  practice.dispatchEvent({type: 'keydown', key: 'ArrowRight'}); assert.equal(h.document.activeElement, now);
  now.dispatchEvent({type: 'keydown', key: 'ArrowLeft'}); assert.equal(h.document.activeElement, practice);
  practice.dispatchEvent({type: 'keydown', key: 'Home'}); assert.equal(h.document.activeElement, now);
});

test('practice progresses only through correct answers and restart clears previous answers', async t => {
  const h = harness(); t.after(() => h.close()); const options = fixture(), before = plain(options);
  h.api.open(options); await tick(); button(h, '[data-guide-tab="practice"]').click();
  const lockedNext = button(h, '[data-guide-next]'); lockedNext.onclick();
  assert.match(visibleText(h.dialog), /Что проверить перед решением/); assert.equal(h.dialog.querySelector('progress').value, 0);
  choice(h, 'Проверить комбинацию').click(); assert.equal(h.dialog.querySelector('progress').value, 1);
  assert.ok(h.dialog.querySelectorAll('[data-guide-choice]').every(node => node.disabled));
  button(h, '[data-guide-next]').click();
  choice(h, 'Всегда побеждает дилер').click(); assert.equal(h.dialog.querySelector('progress').value, 1);
  choice(h, 'Банк делится').click(); assert.equal(h.dialog.querySelector('progress').value, 2);
  button(h, '[data-guide-next]').click(); assert.match(visibleText(h.dialog), /Все примеры разобраны/);
  button(h, '[data-guide-restart]').click();
  assert.match(visibleText(h.dialog), /Что проверить перед решением/);
  assert.equal(h.dialog.querySelector('progress').value, 0); assert.equal(button(h, '[data-guide-next]').disabled, true);
  assert.equal(h.dialog.querySelector('[data-guide-feedback]'), null);
  assert.ok(h.dialog.querySelectorAll('[data-guide-choice]').every(node => !node.disabled && node.getAttribute('aria-pressed') === 'false'));
  assert.deepEqual(plain(options), before); assert.deepEqual(h.effects, []);
});

test('closing and reopening a guide starts fresh and does not leak keyboard handlers', async t => {
  const h = harness(); t.after(() => h.close());
  const listeners = type => (h.document.listeners.get(type) || []).length;
  for (let index = 0; index < 3; index++) {
    const handle = h.api.open(fixture({trigger: h.trigger})); await tick();
    assert.equal(listeners('keydown'), 1); assert.equal(listeners('focusin'), 1);
    button(h, '[data-guide-tab="practice"]').click();
    assert.equal(h.dialog.querySelector('progress').value, 0); assert.equal(button(h, '[data-guide-next]').disabled, true);
    choice(h, 'Проверить комбинацию').click(); assert.equal(h.dialog.querySelector('progress').value, 1);
    handle.close(); assert.equal(h.dialog, null); assert.equal(listeners('keydown'), 0); assert.equal(listeners('focusin'), 0);
  }
  assert.deepEqual(h.effects, []);
});

test('session loss closes guidance without resuming a game or undoing the session lock', async t => {
  const h = harness(); t.after(() => h.close()); let resumed = 0;
  const handle = h.api.open(fixture({onClose: () => resumed++, trigger: h.trigger})); await tick();
  button(h, '[data-guide-tab="practice"]').click(); const staleChoice = choice(h, 'Проверить комбинацию');
  h.controls.owner = false; h.app.inert = true;
  h.document.dispatchEvent({type: 'vezdehot:sessionlost', detail: {scope: 'guest'}});
  assert.equal(h.dialog, null); assert.equal(h.app.inert, true); assert.equal(h.priorInert.inert, true); assert.equal(resumed, 0);
  assert.equal((h.document.listeners.get('keydown') || []).length, 0); assert.equal((h.document.listeners.get('focusin') || []).length, 0);
  staleChoice.onclick(); handle.close(); assert.equal(resumed, 0); assert.equal(h.app.inert, true);
  assert.equal(h.api.open(fixture()), null); assert.equal(h.dialog, null); assert.deepEqual(h.effects, []);
});

test('an existing session overlay stays operable when guidance loses ownership', async t => {
  const h = harness(); t.after(() => h.close()); let resumed = 0;
  const sessionOverlay = h.document.createElement('div'), takeControl = h.document.createElement('button');
  sessionOverlay.id = 'vh-session-overlay'; sessionOverlay.hidden = true; takeControl.textContent = 'Продолжить здесь';
  sessionOverlay.append(takeControl); h.document.body.append(sessionOverlay);
  h.api.open(fixture({trigger: h.trigger, onClose: () => resumed++})); await tick();
  assert.equal(h.app.inert, true); assert.equal(sessionOverlay.inert, false);
  h.controls.owner = false; sessionOverlay.hidden = false;
  h.document.dispatchEvent({type: 'vezdehot:sessionlost', detail: {scope: 'guest'}});
  assert.equal(h.dialog, null); assert.equal(h.app.inert, true); assert.equal(sessionOverlay.inert, false); assert.equal(resumed, 0);
  takeControl.focus(); assert.equal(h.document.activeElement, takeControl);
  let requests = 0; takeControl.onclick = () => requests++; takeControl.click(); assert.equal(requests, 1);
});

test('account change and pagehide close without calling the user-resume callback', async t => {
  const h = harness(); t.after(() => h.close()); let resumed = 0;
  h.api.open(fixture({onClose: () => resumed++})); await tick();
  h.document.dispatchEvent({type: 'vezdehot:accountchange', detail: {from: 'guest', to: 'account-a'}});
  assert.equal(h.dialog, null); assert.equal(resumed, 0);
  h.api.open(fixture({onClose: () => resumed++})); await tick();
  h.window.dispatchEvent({type: 'pagehide'}); assert.equal(h.dialog, null); assert.equal(resumed, 0);
  assert.deepEqual(h.effects, []);
});

test('replacing a guide keeps one modal and never resumes the replaced game', async t => {
  const h = harness(); t.after(() => h.close()); let firstClosed = 0, secondClosed = 0;
  const previous = h.api.open(fixture({onClose: () => firstClosed++})); await tick();
  h.api.open(fixture({title: 'Новый разбор', onClose: () => secondClosed++, trigger: h.trigger})); await tick();
  assert.equal(h.document.body.querySelectorAll('[role="dialog"]').length, 1); assert.match(visibleText(h.dialog), /Новый разбор/);
  previous.close(); assert.ok(h.dialog); assert.equal(firstClosed, 0); assert.equal(secondClosed, 0);
  button(h, '[data-guide-close]').click(); assert.equal(h.dialog, null); assert.equal(secondClosed, 1);
  assert.equal(h.app.inert, false); assert.equal(h.priorInert.inert, true);
});

test('journal and contextual tip escape HTML and handle empty or malformed rows', () => {
  const h = harness(); const attack = `<img src=x onerror="run()"> & 'quoted'`;
  const journal = h.api.journal({id: 'bad" onmouseover="run()', title: attack, open: true, entries: [null, {text: 42}, {label: attack, text: attack}]});
  const tip = h.api.tip({title: attack, text: attack});
  for (const html of [journal, tip]) {
    assert.doesNotMatch(html, /<img|<script/); assert.match(html, /&lt;img/); assert.match(html, /&quot;/); assert.match(html, /&amp;/); assert.match(html, /&#39;/);
    assert.ok(html.startsWith('<details')); assert.ok(html.endsWith('</details>'));
  }
  assert.match(journal, /1 событие/); assert.equal((journal.match(/<li>/g) || []).length, 1);
  assert.match(journal, /data-detail="[a-zA-Z0-9_-]+"/); assert.doesNotMatch(journal, /data-detail="bad" onmouseover/);
  const empty = h.api.journal({entries: [], empty: attack}); assert.match(empty, /vh-journal-empty/); assert.match(empty, /&lt;img/);
  assert.equal(h.api.tip({title: 'No text'}), ''); assert.deepEqual(h.effects, []);
});

function walkthroughFixture(overrides={}){
  const calls={create:0,act:[],view:0};
  const adapter={title:'Учебная раздача от первого хода до итога',label:'Раздача',
    create(){calls.create++;return {step:1,moves:[]}},
    view(state){calls.view++;return {step:state.step,total:3,title:'Этап '+state.step,text:'Заданные карты, самостоятельное решение.',done:state.step===3,
      groups:[{label:'Твоя рука',cards:[{rank:'A',suit:'♠'},{rank:'Q',suit:'♥'}]},{label:'Соперник',cards:[{hidden:true,get rank(){throw Error('Hidden rank accessed')},get suit(){throw Error('Hidden suit accessed')}}]}],
      metrics:[{label:'Учебный банк',value:state.moves.length*40}],choices:[{id:'move',label:'Колл 40'},{id:'blocked',label:'Недоступный ход',disabled:true}],
      feedback:state.moves.length?{title:'Ход выполнен',text:state.moves.join(' → ')}:undefined,recap:state.step===3?[{title:'Итог',text:'Две последовательные ставки'}]:[]}},
    act(state,id){calls.act.push(id);state.moves.push(id);state.step++;return state},...overrides};return {adapter,calls};
}

test('walkthrough starts lazily, renders public cards, and keeps progress across tabs',()=>{
  const h=harness(),f=walkthroughFixture();h.api.open(fixture({walkthrough:f.adapter}));
  assert.equal(f.calls.create,0);button(h,'[data-guide-tab="walkthrough"]').click();assert.equal(f.calls.create,1);
  assert.equal(h.dialog.querySelectorAll('.vh-walk-card').length,3);assert.equal(h.dialog.querySelectorAll('[aria-label="Закрытая карта"]').length,1);
  const first=button(h,'[data-walk-action="move"]');first.click();assert.equal(f.calls.act.length,1);assert.match(visibleText(h.dialog),/Этап 2/);
  first.onclick();assert.equal(f.calls.act.length,1,'detached prior action must not act on next step');
  button(h,'[data-guide-tab="rules"]').click();const current=button(h,'[data-walk-action="move"]');current.onclick();assert.equal(f.calls.act.length,1,'hidden panel action is inert');
  button(h,'[data-guide-tab="walkthrough"]').click();assert.equal(f.calls.create,1);assert.match(visibleText(h.dialog),/Этап 2/);assert.deepEqual(h.effects,[]);
});

test('walkthrough ignores disabled actions, completes with recap, and resets only its own state',()=>{
  const h=harness(),f=walkthroughFixture();h.api.open(fixture({walkthrough:f.adapter,initialTab:'walkthrough'}));
  const blocked=button(h,'[data-walk-action="blocked"]');blocked.onclick();assert.equal(f.calls.act.length,0);
  const restart=button(h,'[data-walk-restart]');button(h,'[data-walk-action="move"]').click();restart.onclick();assert.equal(f.calls.create,1,'stale restart cannot reset a later step');
  const last=button(h,'[data-walk-action="move"]');last.click();assert.match(visibleText(h.dialog),/Разбор завершён/);assert.match(visibleText(h.dialog),/Две последовательные ставки/);
  assert.equal(h.dialog.querySelectorAll('[data-walk-action]').length,0);last.onclick();assert.equal(f.calls.act.length,2);
  button(h,'[data-walk-restart]').click();assert.equal(f.calls.create,2);assert.match(visibleText(h.dialog),/Этап 1/);assert.deepEqual(h.effects,[]);
});

test('failed walkthrough actions roll back mutated candidate state and keep close usable',()=>{
  const f=walkthroughFixture({act(state){state.step=3;state.moves.push('bad');throw Error('Test action error')}}),h=harness();
  h.api.open(fixture({walkthrough:f.adapter,initialTab:'walkthrough'}));button(h,'[data-walk-action="move"]').click();
  assert.match(visibleText(h.dialog),/ход не выполнен/);assert.match(visibleText(h.dialog),/Этап 1/);assert.doesNotMatch(visibleText(h.dialog),/bad|Разбор завершён/);
  button(h,'[data-guide-close]').click();assert.equal(h.dialog,null);assert.deepEqual(h.effects,[]);
});

test('malformed walkthrough state or views fail locally and allow a fresh restart',()=>{
  const h=harness();let fail=true;
  const f=walkthroughFixture({create(){if(fail)throw Error('Cannot create');return {step:1,moves:[]}}});
  h.api.open(fixture({walkthrough:f.adapter,initialTab:'walkthrough'}));assert.match(visibleText(h.dialog),/Не удалось открыть/);assert.ok(button(h,'[data-walk-restart]'));
  fail=false;button(h,'[data-walk-restart]').click();assert.ok(button(h,'[data-walk-action="move"]'));
  h.api.open(fixture({walkthrough:{...f.adapter,view:()=>({step:1,total:2,title:'Invalid',text:'Broken',done:false,choices:[{id:'x',label:'A'},{id:'x',label:'B'}]})},initialTab:'walkthrough'}));
  assert.match(visibleText(h.dialog),/Не удалось открыть/);assert.equal(h.dialog.querySelectorAll('[data-walk-action]').length,0);button(h,'[data-guide-close]').click();assert.equal(h.dialog,null);
});

test('closing, replacing, or losing ownership invalidates every old walkthrough action',()=>{
  for(const reason of ['close','account','ownership','replace']){
    const h=harness(),f=walkthroughFixture();let closes=0;
    h.api.open(fixture({walkthrough:f.adapter,initialTab:'walkthrough',onClose:()=>closes++}));
    const action=button(h,'[data-walk-action="move"]'),restart=button(h,'[data-walk-restart]'),tab=button(h,'[data-guide-tab="walkthrough"]');
    if(reason==='close')button(h,'[data-guide-close]').click();
    else if(reason==='replace')h.api.open(fixture());
    else {if(reason==='ownership')h.controls.owner=false;h.document.dispatchEvent({type:reason==='account'?'vezdehot:accountchange':'vezdehot:sessionlost'})}
    action.onclick();restart.onclick();tab.onclick();assert.equal(f.calls.act.length,0);assert.equal(f.calls.create,1);assert.equal(closes,reason==='close'?1:0);assert.deepEqual(h.effects,[]);
  }
});

test('walkthrough copy remains literal text and all four tabs work from the keyboard',()=>{
  const h=harness(),attack='<img src=x onerror="bad()">',f=walkthroughFixture();
  const base=f.adapter.view;f.adapter.view=state=>({...base(state),title:attack,text:attack,groups:[{label:attack,cards:[{rank:'A',suit:'♠'}]}],metrics:[{label:attack,value:attack}],feedback:{title:attack,text:attack},recap:[{title:attack,text:attack}]});
  h.api.open(fixture({walkthrough:f.adapter}));const now=button(h,'[data-guide-tab="now"]');now.focus();now.dispatchEvent({type:'keydown',key:'End'});
  assert.equal(h.document.activeElement,button(h,'[data-guide-tab="walkthrough"]'));assert.match(visibleText(h.dialog),/<img src=x/);assert.equal(h.dialog.querySelector('img,script'),null);
  const walk=button(h,'[data-guide-tab="walkthrough"]');walk.dispatchEvent({type:'keydown',key:'ArrowRight'});assert.equal(h.document.activeElement,now);assert.deepEqual(h.effects,[]);
});

test('walkthrough roster renders only supplied public facts and updates with each decision',()=>{
  const h=harness(),f=walkthroughFixture(),base=f.adapter.view;
  f.adapter.view=state=>({...base(state),groups:[],people:[
    {name:'Игрок',alive:true,self:true,badge:'Комиссар',detail:'Только тебе: собственная роль.'},
    {name:'Лаки',alive:state.step===1,badge:state.step===1?'Роль скрыта':'Мирный',detail:state.step===1?'Проверки пока нет.':'Роль раскрыта после голосования.',get role(){throw Error('Private role must never be read')},get hand(){throw Error('Private cards must never be read')}},
    {name:'Некорректный участник',alive:'yes'},null
  ]});
  h.api.open(fixture({game:'mafia',walkthrough:f.adapter,initialTab:'walkthrough'}));
  assert.equal(h.dialog.querySelectorAll('.vh-walk-person').length,2);assert.equal(h.dialog.querySelector('[aria-label="Участники учебной партии"]').tagName,'SECTION');
  assert.match(visibleText(h.dialog),/Игрок · ты/);assert.match(visibleText(h.dialog),/Роль скрыта/);assert.doesNotMatch(visibleText(h.dialog),/Некорректный/);
  button(h,'[data-walk-action="move"]').click();assert.equal(h.dialog.querySelectorAll('[data-alive="false"]').length,1);assert.match(visibleText(h.dialog),/Мирный/);assert.doesNotMatch(visibleText(h.dialog),/Роль скрыта/);assert.deepEqual(h.effects,[]);
});

test('walkthrough roster text cannot inject markup or expose unsupported object fields',()=>{
  const h=harness(),f=walkthroughFixture(),base=f.adapter.view,attack='<img src=x onerror="bad()">';
  f.adapter.view=state=>({...base(state),people:[{name:attack,alive:false,badge:attack,detail:attack,self:true,secret:'NEVER_RENDER_THIS_ROLE'}]});
  h.api.open(fixture({walkthrough:f.adapter,initialTab:'walkthrough'}));
  assert.equal(h.dialog.querySelector('img,script'),null);assert.match(visibleText(h.dialog),/<img src=x/);assert.doesNotMatch(visibleText(h.dialog),/NEVER_RENDER_THIS_ROLE/);
  assert.equal(h.dialog.querySelector('.vh-walk-person-avatar').getAttribute('aria-hidden'),'true');assert.deepEqual(h.effects,[]);
});

test('walkthrough target selection remains separate from confirmation and exposes pressed state',()=>{
  const h=harness(),f=walkthroughFixture(),base=f.adapter.view;
  f.adapter.view=state=>({...base(state),choices:[{id:'select',label:'Выбрать участника',selected:state.target===1},{id:'confirm',label:'Подтвердить',disabled:state.target!==1}]});
  f.adapter.act=(state,id)=>id==='select'?{...state,target:1}:{...state,step:3};
  h.api.open(fixture({walkthrough:f.adapter,initialTab:'walkthrough'}));const old=button(h,'[data-walk-action="select"]');assert.equal(old.getAttribute('aria-pressed'),'false');
  assert.equal(button(h,'[data-walk-action="confirm"]').disabled,true);old.click();assert.equal(button(h,'[data-walk-action="select"]').getAttribute('aria-pressed'),'true');assert.match(visibleText(h.dialog),/Этап 1/);
  const confirm=button(h,'[data-walk-action="confirm"]');assert.equal(confirm.getAttribute('aria-pressed'),null);assert.equal(confirm.disabled,false);confirm.click();assert.match(visibleText(h.dialog),/Разбор завершён/);old.onclick();assert.match(visibleText(h.dialog),/Разбор завершён/);assert.deepEqual(h.effects,[]);
});

test('an unplayed defense keeps its table position without reading or suggesting a hidden card',()=>{
  const h=harness(),f=walkthroughFixture(),base=f.adapter.view;
  f.adapter.view=state=>({...base(state),groups:[{label:'Защита',cards:[{rank:'7',suit:'♠'},{placeholder:true,label:'Ожидает защиты',get rank(){throw Error('No card has been played')},get suit(){throw Error('No card has been played')}}]}]});
  h.api.open(fixture({walkthrough:f.adapter,initialTab:'walkthrough'}));
  assert.equal(h.dialog.querySelectorAll('.vh-walk-card').length,2);assert.equal(h.dialog.querySelectorAll('.vh-walk-card-slot').length,1);assert.ok(h.dialog.querySelector('[aria-label="Ожидает защиты"]'));assert.equal(h.dialog.querySelector('[aria-label="Закрытая карта"]'),null);assert.deepEqual(h.effects,[]);
});
