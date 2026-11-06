// UI tests without a browser: render the screens to HTML, then "click" the buttons found in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRandom, type ActionBody, type BoardDef, type Choice } from '../src/engine/index.ts';
import { describeEvent } from '../src/describe.ts';
import { applyAction, botStep, clickSquare, currentPrompt, fromSave, isBotTurn, startGame, toSave, type AppState, type GameSetup, type Seat } from '../src/ui/app.ts';
import { clampAmount, withAmount, type AmountField, type UiCommand } from '../src/ui/html.ts';
import { renderGame, renderSetup } from '../src/ui/view.ts';

// ---------- Reading rendered HTML ----------

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? unescape(m[1]) : undefined;
};

interface Clickable {
  body?: ActionBody;
  ui?: UiCommand;
  input?: { id: string; field: AmountField };
}

function clickables(html: string): Clickable[] {
  const out: Clickable[] = [];
  for (const [tag] of html.matchAll(/<(?:button|g)\b[^>]*>/g)) {
    const act = attr(tag, 'data-act');
    const ui = attr(tag, 'data-ui');
    const id = attr(tag, 'data-input');
    if (act) out.push({ body: JSON.parse(act), input: id ? { id, field: attr(tag, 'data-field') as AmountField } : undefined });
    else if (ui) out.push({ ui: JSON.parse(ui) });
  }
  return out;
}

function numberInputs(html: string): Map<string, { min: number; max: number; value: number }> {
  const map = new Map<string, { min: number; max: number; value: number }>();
  for (const m of html.matchAll(/<input id="([^"]+)" class="num" type="number" min="(-?\d+)" max="(-?\d+)" step="1" value="(-?\d+)">/g)) {
    map.set(unescape(m[1]), { min: Number(m[2]), max: Number(m[3]), value: Number(m[4]) });
  }
  return map;
}

/** Does some rendered button offer this engine choice? */
function offered(choice: Choice, list: Clickable[]): boolean {
  return list.some(({ body }) => {
    if (!body || body.type !== choice.type) return false;
    if ('district' in choice && 'district' in body) return body.district === choice.district;
    if ('square' in choice && 'square' in body) return body.square === choice.square;
    if (choice.type === 'move' && body.type === 'move') return body.path.join() === choice.path.join();
    return true;
  });
}

// ---------- Playing through the UI ----------

/** Plays a whole game. Humans click random rendered buttons (and sometimes board squares). */
function autoplay(setup: GameSetup, seed: number): AppState {
  const rand = makeRandom(seed);
  let app = startGame(setup, rand);
  for (let steps = 0; currentPrompt(app); steps++) {
    assert.ok(steps < 20_000, 'game did not finish');
    if (isBotTurn(app)) {
      app = botStep(app, rand);
      continue;
    }
    const prompt = currentPrompt(app)!;
    const html = renderGame(app, { speedMs: 0 });
    const list = clickables(html);
    for (const choice of prompt.choices) assert.ok(offered(choice, list), `UI doesn't offer ${JSON.stringify(choice)} during ${app.game.phase.kind}`);
    const acts = list.filter((c) => c.body);
    assert.ok(acts.length > 0, `no buttons during ${app.game.phase.kind}`);
    if (rand() < 0.1) {
      const squares = list.filter((c) => c.ui?.cmd === 'square');
      const pickSq = squares[Math.floor(rand() * squares.length)].ui as { cmd: 'square'; square: number };
      app = clickSquare(app, pickSq.square);
      assert.equal(app.error, null);
      continue;
    }
    const click = acts[Math.floor(rand() * acts.length)];
    let body = click.body!;
    if (click.input) {
      const input = numberInputs(html).get(click.input.id);
      assert.ok(input, `button points at missing input #${click.input.id}`);
      const typed = String(input.min + Math.floor(rand() * (input.max - input.min + 1)));
      body = withAmount(body, click.input.field, clampAmount(typed, input.min, input.max));
    }
    app = applyAction(app, body);
    assert.equal(app.error, null, `clicking ${JSON.stringify(body)} failed`);
  }
  return app;
}

const seats = (...kinds: Seat['kind'][]): Seat[] => kinds.map((kind, i) => ({ name: `P${i + 1}`, kind }));

test('setup screen has 4 seats, the options and a start button', () => {
  const html = renderSetup();
  for (let i = 0; i < 4; i++) assert.match(html, new RegExp(`id="seat-kind-${i}"`));
  assert.match(html, /id="opt-target"/);
  assert.ok(clickables(html).some((c) => c.ui?.cmd === 'start'));
});

test('startGame applies the setup', () => {
  const app = startGame({ seats: seats('human', 'balanced', 'trader'), target: 6000, ventureCards: true, catchUpCash: true, randomOrder: false, seed: 1 });
  assert.deepEqual(app.game.players.map((p) => p.name), ['P1', 'P2', 'P3']);
  assert.deepEqual(app.game.players.map((p) => p.cash), [1500, 1625, 1750]);
  assert.equal(app.game.config.targetNetWorth, 6000);
  assert.equal(app.game.config.ventureCards, true);
});

test('random turn order keeps names and seat types together', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const app = startGame({ seats: seats('human', 'balanced', 'trader', 'landlord'), target: 8000, ventureCards: false, catchUpCash: true, randomOrder: true }, makeRandom(seed));
    app.seats.forEach((seat, i) => assert.equal(app.game.players[i].name, seat.name));
    assert.equal(app.seats.find((s) => s.name === 'P1')!.kind, 'human');
  }
});

for (const ventureCards of [false, true]) {
  test(`one human (random clicks) vs 3 bots: 6 full games through the UI (venture cards ${ventureCards ? 'on' : 'off'})`, () => {
    for (let seed = 1; seed <= 6; seed++) {
      const app = autoplay({ seats: seats('human', 'balanced', 'trader', 'landlord'), target: 8000, ventureCards, catchUpCash: true, randomOrder: true, maxRounds: 50 }, seed);
      assert.equal(app.game.phase.kind, 'gameOver');
      assert.match(renderGame(app, { speedMs: 0 }), /wins!/);
    }
  });
}

test('four humans (random clicks), so humans also hit debt, auctions and buyouts: 6 games', () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 6; seed++) {
    const app = autoplay({ seats: seats('human', 'human', 'human', 'human'), target: 5000, ventureCards: true, catchUpCash: true, randomOrder: false, maxRounds: 25, seed }, seed);
    assert.equal(app.game.phase.kind, 'gameOver');
    for (const line of app.log) {
      if (line.includes('to cover debt')) seen.add('debt');
      if (line.includes('won the auction')) seen.add('auction');
      if (line.includes('bought out')) seen.add('buyout');
      if (line.includes('invested')) seen.add('invest');
    }
  }
  assert.deepEqual([...seen].sort(), ['auction', 'buyout', 'debt', 'invest']);
});

test('player names are escaped everywhere', () => {
  const evil = '<img src=x onerror=alert(1)>';
  let app = startGame({ seats: [{ name: evil, kind: 'human' }, { name: 'Bot', kind: 'balanced' }], target: 8000, ventureCards: false, catchUpCash: false, randomOrder: false, seed: 3 });
  app = applyAction(app, { type: 'roll' });
  const html = renderGame(app, { speedMs: 0 });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
});

test('a destination with several routes asks which route', () => {
  const board: BoardDef = {
    name: 'Diamond',
    squares: [
      { id: 0, type: 'bank', x: 1, y: 2, links: [1, 2, 4] },
      { id: 1, type: 'shop', district: 'A', baseValue: 100, x: 0, y: 1, links: [0, 3] },
      { id: 2, type: 'shop', district: 'A', baseValue: 100, x: 1, y: 1, links: [0, 3] },
      { id: 3, type: 'shop', district: 'A', baseValue: 100, x: 1, y: 0, links: [1, 2, 4] },
      { id: 4, type: 'suit', suit: 'spade', x: 2, y: 1, links: [0, 3] },
    ],
  };
  let app = startGame({ seats: seats('human', 'human'), target: 8000, ventureCards: false, catchUpCash: false, randomOrder: false, seed: 1, board });
  app.game.phase = { kind: 'move', remaining: 2 };
  app = clickSquare(app, 3);
  assert.equal(app.routeFor, 3);
  assert.equal(app.game.phase.kind, 'move'); // didn't move yet
  const html = renderGame(app, { speedMs: 0 });
  assert.match(html, /Several routes lead there/);
  assert.equal(clickables(html).filter((c) => c.body?.type === 'move').length, 3);
  app = applyAction(app, { type: 'move', path: [2, 3] });
  assert.equal(app.game.players[0].position, 3);
  assert.equal(app.routeFor, null);
});

test('saving and loading', () => {
  let app = startGame({ seats: seats('human', 'balanced'), target: 8000, ventureCards: true, catchUpCash: true, randomOrder: false, seed: 5 });
  app = applyAction(app, { type: 'roll' });
  const loaded = fromSave(toSave(app))!;
  assert.equal(JSON.stringify(loaded.game), JSON.stringify(app.game));
  assert.deepEqual(loaded.seats, app.seats);
  assert.equal(fromSave('not json'), null);
  assert.equal(fromSave(null), null);
  assert.equal(fromSave(JSON.stringify({ version: 99 })), null);
});

test('typed amounts are clamped to the allowed range', () => {
  assert.equal(clampAmount('150', 1, 99), 99);
  assert.equal(clampAmount('-5', 1, 99), 1);
  assert.equal(clampAmount('abc', 1, 99), 1);
  assert.equal(clampAmount('12.7', 1, 99), 12);
});

test('a player named "You" gets proper grammar', () => {
  const app = startGame({ seats: [{ name: 'You', kind: 'human' }, { name: 'Ada', kind: 'human' }], target: 8000, ventureCards: false, catchUpCash: false, randomOrder: false, seed: 1 });
  const html = renderGame(app, { speedMs: 0 });
  assert.match(html, /Your turn/);
  assert.doesNotMatch(html, /You's/);
  const s = app.game;
  assert.equal(describeEvent(s, { type: 'promoted', player: 0, level: 2, salary: 400 }), 'You were promoted to level 2 and earned 400G.');
  assert.equal(describeEvent(s, { type: 'tookBreak', player: 0 }), 'You are taking a break: your shops are closed until your next turn.');
  assert.equal(describeEvent(s, { type: 'feePaid', player: 1, owner: 0, square: 1, amount: 13 }), 'Ada paid 13G to you at A1.');
  assert.equal(describeEvent(s, { type: 'gameOver', winner: 0, reason: 'target' }), 'GAME OVER: You win (reached the target net worth at the bank).');
  assert.equal(describeEvent(s, { type: 'promoted', player: 1, level: 2, salary: 400 }), 'Ada was promoted to level 2 and earned 400G.');
});

test('the log shows the newest turn first, and each turn in the order it happened', () => {
  let app = startGame({ seats: seats('balanced', 'balanced'), target: 8000, ventureCards: false, catchUpCash: true, randomOrder: false, seed: 2 });
  const rand = makeRandom(9);
  for (let i = 0; i < 40 && currentPrompt(app); i++) app = botStep(app, rand);
  const html = renderGame(app, { speedMs: 0 });
  const log = html.slice(html.indexOf('class="log-list"'));
  const titles = [...log.matchAll(/class="turn-title">([^<]*)</g)].map((m) => m[1]);
  assert.ok(titles.length >= 3, 'expected several turns in the log');
  const s = app.game;
  assert.equal(titles[0], `Round ${s.round}: ${s.players[s.turn.player].name}`);
  const previousTurn = log.split('class="turn-title"')[2];
  assert.ok(previousTurn.indexOf('rolled') < previousTurn.indexOf('moved'), 'lines within a turn should be in order');
});