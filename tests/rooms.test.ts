// Online rooms (src/server/rooms.ts), tested without any networking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { legalActions, makeRandom, type GameState } from '../src/engine/index.ts';
import { randomAction } from '../src/bots/index.ts';
import { RoomError, RoomManager, type Listener } from '../src/server/rooms.ts';
import type { EndReason, RoomView } from '../src/online/protocol.ts';

/** A fake browser tab that records what the server sends it. */
function tab(token: string) {
  const views: RoomView[] = [];
  const ended: EndReason[] = [];
  const listener: Listener = { token, send: (v) => views.push(v), end: (reason) => ended.push(reason) };
  return { listener, views, ended, last: () => views[views.length - 1] };
}

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err) {
    if (err instanceof RoomError) return err.status;
    throw err;
  }
  return 0;
};

function lobby(...guests: string[]) {
  const m = new RoomManager({ botDelayMs: 0, random: makeRandom(1) });
  const host = m.createRoom('Host');
  const others = guests.map((name) => m.joinRoom(host.code, name));
  return { m, host, others };
}

test('create, join, see each other; names are cleaned and made unique', () => {
  const { m, host } = lobby();
  assert.match(host.code, /^[A-HJ-NP-Z]{5}$/);
  const a = m.joinRoom(host.code.toLowerCase(), '  Host  ');
  const b = m.joinRoom(host.code, 'B\u0007ob <b>');
  const t = tab(host.token);
  m.subscribe(host.code, host.token, t.listener);
  const v = t.last();
  assert.deepEqual(v.seats.map((s) => s.name), ['Host', 'Host 2', 'Bob <b>']);
  assert.equal(v.you, 0);
  assert.equal(v.hostSeat, 0);
  assert.equal(v.game, null);
  assert.deepEqual(v.seats.map((s) => s.connected), [true, false, false]);
  assert.notEqual(a.token, b.token);
});

test('joining: bad code 404, empty name 400, full room 409, started game 409', () => {
  const { m, host } = lobby('A', 'B', 'C');
  assert.equal(status(() => m.joinRoom('ZZZZZ', 'X')), 404);
  assert.equal(status(() => m.joinRoom(host.code, '   ')), 400);
  assert.equal(status(() => m.joinRoom(host.code, 'D')), 409);
  const { m: m2, host: h2 } = lobby('A');
  m2.command(h2.code, h2.token, { type: 'start' });
  assert.equal(status(() => m2.joinRoom(h2.code, 'Late')), 409);
});

test('only the host can change options, add bots, remove players and start', () => {
  const { m, host, others } = lobby('Guest');
  const guest = others[0];
  for (const command of [
    { type: 'setOptions', options: { target: 6000 } },
    { type: 'addBot', kind: 'trader' },
    { type: 'removeSeat', seat: 0 },
    { type: 'start' },
  ]) {
    assert.equal(status(() => m.command(host.code, guest.token, command)), 403, command.type);
  }
  m.command(host.code, host.token, { type: 'setOptions', options: { target: 6000, ventureCards: true, botSpeed: 'fast' } });
  assert.equal(status(() => m.command(host.code, host.token, { type: 'setOptions', options: { target: 'lots' } })), 400);
  assert.equal(status(() => m.command(host.code, host.token, { type: 'setOptions', options: { botSpeed: 'warp' } })), 400);
  assert.equal(status(() => m.command(host.code, host.token, { type: 'addBot', kind: 'cheater' })), 400);
  m.command(host.code, host.token, { type: 'addBot', kind: 'trader' });
  const v = m.view(host.code, host.token);
  assert.equal(v.options.target, 6000);
  assert.equal(v.options.ventureCards, true);
  assert.deepEqual(v.seats.map((s) => s.kind), ['human', 'human', 'trader']);
  assert.equal(status(() => m.command(host.code, 'not-a-token', { type: 'start' })), 403);
  assert.equal(status(() => m.command(host.code, host.token, { type: 'nonsense' })), 400);
  assert.equal(status(() => m.command(host.code, host.token, null)), 400);
});

test('removing a player disconnects them; leaving passes the host role on', () => {
  const { m, host, others } = lobby('A', 'B');
  const [a, b] = others;
  const ta = tab(a.token);
  const tb = tab(b.token);
  m.subscribe(host.code, a.token, ta.listener);
  m.subscribe(host.code, b.token, tb.listener);
  m.command(host.code, host.token, { type: 'removeSeat', seat: 1 });
  assert.deepEqual(ta.ended, ['kicked']);
  assert.equal(status(() => m.command(host.code, a.token, { type: 'leave' })), 403);
  m.command(host.code, host.token, { type: 'leave' });
  const v = tb.last();
  assert.deepEqual(v.seats.map((s) => s.name), ['B']);
  assert.equal(v.hostSeat, 0); // B is the host now
  m.command(host.code, b.token, { type: 'leave' });
  assert.equal(m.rooms.size, 0); // last human left: room deleted
  assert.deepEqual(tb.ended, ['left']);
});

test('starting needs 2 players; the game is dealt with seats in turn order', () => {
  const { m, host } = lobby();
  assert.equal(status(() => m.command(host.code, host.token, { type: 'start' })), 409);
  m.command(host.code, host.token, { type: 'addBot', kind: 'balanced' });
  m.command(host.code, host.token, { type: 'setOptions', options: { randomOrder: false } });
  m.command(host.code, host.token, { type: 'start' });
  const v = m.view(host.code, host.token);
  assert.ok(v.game);
  assert.deepEqual(v.game.players.map((p) => p.name), v.seats.map((s) => s.name));
  assert.equal(v.you, 0);
  assert.equal(status(() => m.command(host.code, host.token, { type: 'addBot', kind: 'balanced' })), 409);
});

test('moves: only on your turn, only with the current step, only legal ones', () => {
  const { m, host, others } = lobby('Guest');
  m.command(host.code, host.token, { type: 'setOptions', options: { randomOrder: false } });
  m.command(host.code, host.token, { type: 'start' });
  const guest = others[0];
  assert.equal(status(() => m.command(host.code, guest.token, { type: 'act', step: 0, action: { type: 'roll' } })), 403);
  assert.equal(status(() => m.command(host.code, host.token, { type: 'act', step: 5, action: { type: 'roll' } })), 409);
  assert.equal(status(() => m.command(host.code, host.token, { type: 'act', step: 0, action: { type: 'buyShop' } })), 400);
  m.command(host.code, host.token, { type: 'act', step: 0, action: { type: 'roll' } });
  assert.equal(m.view(host.code, host.token).step, 1);
  // the same click arriving twice is "stale", not a second roll
  assert.equal(status(() => m.command(host.code, host.token, { type: 'act', step: 0, action: { type: 'roll' } })), 409);
});

test('views never reveal the dice seed, the venture deck or sealed bids', () => {
  const { m, host } = lobby();
  m.command(host.code, host.token, { type: 'addBot', kind: 'balanced' });
  m.command(host.code, host.token, { type: 'setOptions', options: { ventureCards: true } });
  m.command(host.code, host.token, { type: 'start' });
  const g = m.view(host.code, host.token).game!;
  assert.equal(g.rng, 0);
  assert.deepEqual(g.deck, []);
});

/** Every human seat picks random legal moves until the game ends. Bots move by themselves. */
function playToEnd(m: RoomManager, code: string, tokens: string[], seed: number): RoomView {
  const rand = makeRandom(seed);
  for (let i = 0; i < 50_000; i++) {
    let moved = false;
    for (const token of tokens) {
      const v = m.view(code, token);
      const prompt = legalActions(v.game!);
      if (!prompt) return v;
      if (prompt.player !== v.you) continue;
      m.command(code, token, { type: 'act', step: v.step, action: randomAction(prompt, rand) });
      moved = true;
      break;
    }
    if (!moved) throw new Error('Nobody here can move, but the game is not over');
  }
  throw new Error('Game did not finish');
}

function auctionBidsHidden(g: GameState | null): boolean {
  return !g || g.phase.kind !== 'auction' || g.phase.bids.every((b) => b === null || b === 0);
}

test('2 humans + 2 bots play 8 whole games; sealed bids stay hidden in every view', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const m = new RoomManager({ botDelayMs: 0, random: makeRandom(seed) });
    const host = m.createRoom('Host');
    const guest = m.joinRoom(host.code, 'Guest');
    m.command(host.code, host.token, { type: 'addBot', kind: 'balanced' });
    m.command(host.code, host.token, { type: 'addBot', kind: 'trader' });
    m.command(host.code, host.token, { type: 'setOptions', options: { target: 5000, ventureCards: seed % 2 === 0, maxRounds: 40 } });
    const tabs = [tab(host.token), tab(guest.token)];
    m.subscribe(host.code, host.token, tabs[0].listener);
    m.subscribe(host.code, guest.token, tabs[1].listener);
    m.command(host.code, host.token, { type: 'start' });
    const final = playToEnd(m, host.code, [host.token, guest.token], seed * 31);
    assert.equal(final.game!.phase.kind, 'gameOver');
    for (const t of tabs) {
      assert.ok(t.views.every((v) => auctionBidsHidden(v.game)), 'a view showed a sealed bid');
      assert.ok(t.views.every((v) => !v.game || (v.game.rng === 0 && v.game.deck.length === 0)));
      assert.equal(t.last().step, final.step); // everyone got the final state
    }
    // rematch
    m.command(host.code, guest.token, { type: 'backToLobby' });
    assert.equal(m.view(host.code, host.token).game, null);
    m.command(host.code, host.token, { type: 'start' });
    assert.ok(m.view(host.code, host.token).game);
  }
});

test('a bot can stand in for a player who went offline, until they come back', () => {
  const m = new RoomManager({ botDelayMs: 0, random: makeRandom(5) });
  const host = m.createRoom('Host');
  const guest = m.joinRoom(host.code, 'Guest');
  m.command(host.code, host.token, { type: 'setOptions', options: { randomOrder: false, maxRounds: 30 } });
  const guestTab = tab(guest.token);
  const disconnectGuest = m.subscribe(host.code, guest.token, guestTab.listener);
  m.command(host.code, host.token, { type: 'start' });
  assert.equal(status(() => m.command(host.code, host.token, { type: 'standIn', seat: 1 })), 409); // guest is online
  disconnectGuest();
  assert.equal(m.view(host.code, host.token).seats[1].connected, false);
  m.command(host.code, host.token, { type: 'standIn', seat: 1 });
  // The host plays; the bot covers every one of the guest's turns.
  const final = playToEnd(m, host.code, [host.token], 9);
  assert.equal(final.game!.phase.kind, 'gameOver');
  assert.ok(final.game!.round > 1);
  // Coming back takes the seat back from the bot.
  m.command(host.code, host.token, { type: 'backToLobby' });
  m.command(host.code, host.token, { type: 'start' });
  m.command(host.code, host.token, { type: 'standIn', seat: 1 });
  assert.equal(m.view(host.code, host.token).seats[1].standIn, true);
  m.subscribe(host.code, guest.token, tab(guest.token).listener);
  assert.equal(m.view(host.code, host.token).seats[1].standIn, false);
});

test('bots on a timer: a game against 3 bots finishes by itself', async () => {
  const m = new RoomManager({ botDelayMs: 1, random: makeRandom(3) });
  const host = m.createRoom('Host');
  for (const kind of ['balanced', 'trader', 'landlord'] as const) m.command(host.code, host.token, { type: 'addBot', kind });
  m.command(host.code, host.token, { type: 'setOptions', options: { maxRounds: 6 } });
  m.command(host.code, host.token, { type: 'start' });
  const rand = makeRandom(4);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const v = m.view(host.code, host.token);
    const prompt = legalActions(v.game!);
    if (!prompt) break;
    if (prompt.player === v.you) m.command(host.code, host.token, { type: 'act', step: v.step, action: randomAction(prompt, rand) });
    else await new Promise((r) => setTimeout(r, 2));
    assert.ok(Date.now() < deadline, 'bots stopped moving');
  }
  m.close();
});

test('rooms with nobody connected are cleaned up after 2 hours', () => {
  let now = 0;
  const m = new RoomManager({ botDelayMs: 0, now: () => now });
  const idle = m.createRoom('Idle');
  const busy = m.createRoom('Busy');
  m.subscribe(busy.code, busy.token, tab(busy.token).listener);
  now += 60 * 60 * 1000;
  assert.equal(m.sweep(), 0);
  now += 61 * 60 * 1000;
  assert.equal(m.sweep(), 1);
  assert.equal(status(() => m.view(idle.code, idle.token)), 404);
  assert.ok(m.view(busy.code, busy.token));
});

test('connecting with a wrong token or to a closed room ends the session', () => {
  const m = new RoomManager({ botDelayMs: 0 });
  const host = m.createRoom('Host');
  const wrong = tab('nope');
  m.subscribe(host.code, 'nope', wrong.listener);
  assert.deepEqual(wrong.ended, ['badToken']);
  const gone = tab(host.token);
  m.subscribe('QQQQQ', host.token, gone.listener);
  assert.deepEqual(gone.ended, ['roomGone']);
});