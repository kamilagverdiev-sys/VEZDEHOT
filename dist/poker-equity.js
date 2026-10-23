/* Public-information Hold'em estimates. No live deck, burn cards or opponent hands. */
(function (root) {
  'use strict';
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const DEFAULT_SAMPLES = 1600;
  const CHUNK_SIZE = 64;

  function cardNumber(card) {
    const id = typeof card === 'string' ? card : card && (card.id || String(card.rank || '') + String(card.suit || ''));
    if (typeof id !== 'string') throw new TypeError('A card needs a rank and suit.');
    const suit = SUITS.indexOf(id.slice(-1));
    const rank = RANKS.indexOf(id.slice(0, -1));
    if (suit < 0 || rank < 0) throw new TypeError('Unknown card.');
    return suit * 13 + rank;
  }
  function value(category, a = 0, b = 0, c = 0, d = 0, e = 0) {
    return (((((category * 15 + a) * 15 + b) * 15 + c) * 15 + d) * 15 + e);
  }
  function straightHigh(mask) {
    for (let high = 14; high >= 6; high--) {
      const run = 31 << (high - 4);
      if ((mask & run) === run) return high;
    }
    return (mask & 16444) === 16444 ? 5 : 0; // A, 5, 4, 3, 2.
  }
  function highest(mask, count) {
    const result = [];
    for (let rank = 14; rank >= 2 && result.length < count; rank--) if (mask & (1 << rank)) result.push(rank);
    return result;
  }
  // Exact best-five ranking for 5–7 cards, without enumerating all 21 subsets.
  function scoreNumbers(cards) {
    const counts = new Uint8Array(15), suits = new Uint8Array(4), suitMasks = [0, 0, 0, 0];
    let mask = 0;
    for (const card of cards) {
      const rank = card % 13 + 2, suit = Math.floor(card / 13), bit = 1 << rank;
      counts[rank]++; suits[suit]++; suitMasks[suit] |= bit; mask |= bit;
    }
    let flushSuit = -1;
    for (let suit = 0; suit < 4; suit++) if (suits[suit] >= 5) {
      const straight = straightHigh(suitMasks[suit]);
      if (straight) return value(8, straight);
      flushSuit = suit;
    }
    const quads = [], triples = [], pairs = [];
    for (let rank = 14; rank >= 2; rank--) {
      if (counts[rank] === 4) quads.push(rank);
      if (counts[rank] === 3) triples.push(rank);
      if (counts[rank] >= 2) pairs.push(rank);
    }
    if (quads.length) return value(7, quads[0], highest(mask & ~(1 << quads[0]), 1)[0]);
    if (triples.length) {
      const pair = pairs.find(rank => rank !== triples[0]);
      if (pair) return value(6, triples[0], pair);
    }
    if (flushSuit !== -1) return value(5, ...highest(suitMasks[flushSuit], 5));
    const straight = straightHigh(mask);
    if (straight) return value(4, straight);
    if (triples.length) return value(3, triples[0], ...highest(mask & ~(1 << triples[0]), 2));
    if (pairs.length >= 2) return value(2, pairs[0], pairs[1], highest(mask & ~(1 << pairs[0]) & ~(1 << pairs[1]), 1)[0]);
    if (pairs.length) return value(1, pairs[0], ...highest(mask & ~(1 << pairs[0]), 3));
    return value(0, ...highest(mask, 5));
  }
  function evaluate(cards) {
    if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new RangeError('Evaluate needs 5–7 cards.');
    const numbers = cards.map(cardNumber);
    if (new Set(numbers).size !== numbers.length) throw new RangeError('Duplicate cards.');
    return scoreNumbers(numbers);
  }
  function hash(text) {
    let result = 2166136261;
    for (let i = 0; i < text.length; i++) result = Math.imul(result ^ text.charCodeAt(i), 16777619);
    return result >>> 0;
  }
  function prepare(options) {
    // Destructure only public inputs. Deliberately ignore all other properties.
    const { hand, board = [], opponents, samples = DEFAULT_SAMPLES, seed } = options || {};
    if (!Array.isArray(hand) || hand.length !== 2) throw new RangeError('Exactly two player cards are required.');
    if (!Array.isArray(board) || ![0, 3, 4, 5].includes(board.length)) throw new RangeError('The board must have 0, 3, 4 or 5 cards.');
    if (!Number.isInteger(opponents) || opponents < 0 || opponents > 8) throw new RangeError('Opponent count must be between 0 and 8.');
    if (!Number.isInteger(samples) || samples < 1 || samples > 20000) throw new RangeError('Sample count must be between 1 and 20000.');
    const own = hand.map(cardNumber).sort((a, b) => a - b), visible = board.map(cardNumber).sort((a, b) => a - b);
    const known = new Set([...own, ...visible]);
    if (known.size !== own.length + visible.length) throw new RangeError('Duplicate public cards.');
    const pool = Array.from({ length: 52 }, (_, i) => i).filter(card => !known.has(card));
    let randomState = seed === undefined ? hash(own + '|' + visible + '|' + opponents) : hash(String(seed));
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
    return { own, visible, opponents, target: samples, pool, random, done: 0, wins: 0, ties: 0, shares: 0 };
  }
  function sample(state) {
    const { own, visible, opponents, pool, random } = state;
    const deck = pool.slice(), missing = 5 - visible.length, drawCount = missing + opponents * 2;
    // Sampling without replacement, including the unknown community cards.
    for (let i = 0; i < drawCount; i++) {
      const j = i + Math.floor(random() * (deck.length - i));
      const card = deck[i]; deck[i] = deck[j]; deck[j] = card;
    }
    const board = visible.concat(deck.slice(0, missing));
    const ourScore = scoreNumbers(board.concat(own));
    let tied = 1, lost = false;
    for (let i = 0; i < opponents; i++) {
      const index = missing + i * 2;
      const theirScore = scoreNumbers(board.concat(deck[index], deck[index + 1]));
      if (theirScore > ourScore) { lost = true; break; }
      if (theirScore === ourScore) tied++;
    }
    state.done++;
    if (!lost) {
      if (tied === 1) state.wins++; else state.ties++;
      state.shares += 1 / tied;
    }
  }
  function result(state) {
    const count = state.done;
    if (state.opponents === 0) return { win: 100, tie: 0, equity: 100, loss: 0, samples: 0, requestedSamples: state.target, exact: true, opponents: 0 };
    return { win: count ? state.wins * 100 / count : 0, tie: count ? state.ties * 100 / count : 0,
      equity: count ? state.shares * 100 / count : 0, loss: count ? (count - state.wins - state.ties) * 100 / count : 0,
      samples: count, requestedSamples: state.target, exact: false, opponents: state.opponents };
  }
  function abortError() {
    const error = new Error('Estimate cancelled.'); error.name = 'AbortError'; return error;
  }
  // Useful for deterministic tests; use estimate() in the UI so actions remain responsive.
  function estimateSync(options) {
    const state = prepare(options);
    if (state.opponents) while (state.done < state.target) sample(state);
    return result(state);
  }
  function estimate(options) {
    return new Promise((resolve, reject) => {
      let state;
      try { state = prepare(options); } catch (error) { reject(error); return; }
      const signal = options?.signal, onProgress = options?.onProgress;
      function step() {
        if (signal?.aborted) { reject(abortError()); return; }
        try {
          const end = Math.min(state.target, state.done + CHUNK_SIZE), started = Date.now();
          if (state.opponents) while (state.done < end) {
            sample(state);
            if (Date.now() - started >= 6) break;
          }
          if (signal?.aborted) { reject(abortError()); return; }
          const progress = result(state);
          if (typeof onProgress === 'function') onProgress(progress);
          if (!state.opponents || state.done >= state.target) resolve(progress);
          else setTimeout(step, 0);
        } catch (error) { reject(error); }
      }
      setTimeout(step, 0);
    });
  }
  const api = Object.freeze({ estimate, estimateSync, evaluate });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PokerEquity = api;
})(typeof window !== 'undefined' ? window : globalThis);
