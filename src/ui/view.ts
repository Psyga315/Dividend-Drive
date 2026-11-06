// Builds the HTML for each screen. Pure functions: state in, HTML string out.
import {
  SUITS, buyoutPrice, districtSize, feeFor, indexBoard, netWorth, ownedInDistrict, rankings,
  shopBaseFee, shopFee, shopMaxCapital, shopsValue, stockPrice, stockValue,
  type ActionPrompt, type Choice, type GameState, type PlayerId, type SquareDef, type SquareId,
} from '../engine/index.ts';
import { SUIT_SYMBOLS, be, gold, isYou, possessive, shares, verbS } from '../describe.ts';
import type { SeatView } from '../online/protocol.ts';
import { GAME_LENGTHS, GAME_TITLE, SEAT_KINDS, canAct, currentPrompt, isHuman, type AppState, type SeatKind } from './app.ts';
import { PLAYER_COLORS, districtColor, renderBoard } from './board-view.ts';
import { actAttr, esc, numberInput, uiAttr } from './html.ts';
import type { ConnectionStatus } from './online.ts';

// ---------- Setup screen ----------

const DEFAULT_SEATS: { name: string; kind: SeatKind | 'none' }[] = [
  { name: 'You', kind: 'human' },
  { name: 'Ada', kind: 'balanced' },
  { name: 'Ben', kind: 'trader' },
  { name: 'Cy', kind: 'landlord' },
];

export function renderSetup(): string {
  const rows = DEFAULT_SEATS.map((seat, i) => {
    const options = [...SEAT_KINDS.map((k) => ({ value: k.kind as string, label: k.label })), ...(i >= 2 ? [{ value: 'none', label: '(nobody)' }] : [])];
    return (
      `<div class="seat-row"><span class="dot" style="background:${PLAYER_COLORS[i]}"></span>` +
      `<input id="seat-name-${i}" class="name" maxlength="16" value="${esc(seat.name)}" aria-label="Player ${i + 1} name">` +
      `<select id="seat-kind-${i}" aria-label="Player ${i + 1} type">` +
      options.map((o) => `<option value="${o.value}"${o.value === seat.kind ? ' selected' : ''}>${esc(o.label)}</option>`).join('') +
      `</select></div>`
    );
  }).join('');
  const lengths = GAME_LENGTHS.map((l) => `<option value="${l.target}"${l.id === 'standard' ? ' selected' : ''}>${esc(l.label)}</option>`).join('');
  return `
<div class="setup">
  <h1>${esc(GAME_TITLE)}</h1>
  <p class="muted">Buy shops, invest in them, trade district stocks, and be first back to the bank with the target net worth.</p>
  <div class="mode-switch"><span class="current">On this computer</span><button ${uiAttr({ cmd: 'goOnline' })}>Play online with friends →</button></div>
  <h2>Players</h2>
  ${rows}
  <p class="muted small">Players take turns on this computer. Seat colors follow the turn order once the game starts.</p>
  <h2>Options</h2>
  <label class="opt">Game length <select id="opt-target">${lengths}</select></label>
  <label class="opt"><input type="checkbox" id="opt-random" checked> Random turn order</label>
  <label class="opt"><input type="checkbox" id="opt-catchup" checked> Catch-up cash: each later player starts with +125G</label>
  <label class="opt"><input type="checkbox" id="opt-ventures"> Venture cards (20 random events on ? and suit squares)</label>
  <div id="setup-error" class="error" hidden></div>
  <button class="primary big" ${uiAttr({ cmd: 'start' })}>Start game</button>
</div>`;
}

// ---------- Game screen ----------

/** Extra information for online games. */
export interface OnlineInfo {
  code: string;
  status: ConnectionStatus;
  seats: SeatView[]; // index = player id
}

export interface GameViewOptions {
  speedMs: number;
  online?: OnlineInfo;
}

export const SPEEDS = [
  { ms: 1200, label: 'Slow' },
  { ms: 600, label: 'Normal' },
  { ms: 200, label: 'Fast' },
  { ms: 0, label: 'Instant' },
];

export function renderGame(app: AppState, opts: GameViewOptions): string {
  const s = app.game;
  const prompt = currentPrompt(app);
  const destinations = new Set<SquareId>();
  if (prompt && canAct(app, prompt.player) && s.phase.kind === 'move') {
    for (const c of prompt.choices) if (c.type === 'move') destinations.add(c.path[c.path.length - 1]);
  }
  const online = opts.online;
  const controls = online
    ? `<span class="room-tag">Room <b>${esc(online.code)}</b></span>${connectionBadge(online.status)}<button ${uiAttr({ cmd: 'exitGame' })}>Leave</button>`
    : `<label class="small">Bot speed <select id="speed">${SPEEDS.map((sp) => `<option value="${sp.ms}"${sp.ms === opts.speedMs ? ' selected' : ''}>${sp.label}</option>`).join('')}</select></label>
  <button ${uiAttr({ cmd: 'newGame' })}>New game</button>`;
  return `
<header class="topbar">
  <strong>${esc(GAME_TITLE)}</strong>
  <span class="status">${statusLine(app)}</span>
  <span class="spacer"></span>
  ${controls}
</header>
<main class="layout">
  <section class="board-area">${renderBoard(s, { destinations, selected: app.selected })}</section>
  <section class="notes">
    <div class="panel info">${infoPanel(app)}</div>
    <div class="panel log"><h3>Log</h3>${logList(app.log)}</div>
  </section>
  <aside class="side">
    <div class="players">${s.players.map((_, i) => playerCard(app, i, online)).join('')}</div>
    <div class="panel action${prompt && canAct(app, prompt.player) ? ' your-move' : ''}">${app.error ? errorBox(app.error) : ''}${actionPanel(app, prompt, online)}</div>
    <div class="panel market"><h3>Stock market</h3>${marketTable(s)}</div>
  </aside>
</main>`;
}

function connectionBadge(status: ConnectionStatus): string {
  if (status === 'open') return '<span class="conn ok" title="Connected to the game server">● online</span>';
  return '<span class="conn bad" title="Trying to reconnect">● reconnecting…</span>';
}

function statusLine(app: AppState): string {
  const s = app.game;
  if (s.phase.kind === 'gameOver') return 'Game over';
  const pl = s.players[s.turn.player];
  const rolled = s.turn.roll !== null ? ` · rolled ${s.turn.roll}` : '';
  const whose = app.viewer === s.turn.player ? 'Your' : possessive(pl.name);
  return `Round ${s.round} · ${esc(whose)} turn${rolled} · Target ${gold(s.config.targetNetWorth)}`;
}

function errorBox(message: string): string {
  return `<div class="error">${esc(message)} <button class="link-btn" ${uiAttr({ cmd: 'dismissError' })}>OK</button></div>`;
}

// ---------- Player cards ----------

function playerCard(app: AppState, p: PlayerId, online: OnlineInfo | undefined): string {
  const s = app.game;
  const pl = s.players[p];
  const worth = netWorth(s, p);
  const pct = Math.max(0, Math.min(100, Math.round((100 * worth) / s.config.targetNetWorth)));
  const active = s.phase.kind !== 'gameOver' && s.turn.player === p;
  const kind = SEAT_KINDS.find((k) => k.kind === app.seats[p].kind)?.label.replace(/ \(.*\)/, '') ?? '';
  const suits = SUITS.map((suit) => `<span class="suit${pl.suits.includes(suit) ? ' have' : ''}${suit === 'heart' || suit === 'diamond' ? ' red' : ''}">${SUIT_SYMBOLS[suit]}</span>`).join('');
  const wild = pl.wildcards > 0 ? ` <span class="badge">+${pl.wildcards} wild</span>` : '';
  const seat = online?.seats[p];
  const flags = [
    app.viewer === p ? '<span class="badge you">you</span>' : '',
    seat && seat.kind === 'human' && !seat.connected ? '<span class="badge offline">offline</span>' : '',
    seat?.standIn ? '<span class="badge">bot playing</span>' : '',
    pl.bankrupt ? '<span class="badge bad">BANKRUPT</span>' : '',
    pl.shopsClosed ? '<span class="badge">shops closed</span>' : '',
  ].join('');
  return `
<div class="pcard${active ? ' active' : ''}${pl.bankrupt ? ' out' : ''}" style="--pc:${PLAYER_COLORS[p]}">
  <div class="pc-head"><span class="dot" style="background:${PLAYER_COLORS[p]}">${p + 1}</span> <strong>${esc(pl.name)}</strong> <span class="muted small">${esc(kind)} · level ${pl.level}</span>${flags}</div>
  <div class="pc-money"><span>Cash <b>${gold(pl.cash)}</b></span><span>Net worth <b>${gold(worth)}</b></span></div>
  <div class="bar"><div style="width:${pct}%"></div></div>
  <div class="pc-suits">${suits}${wild}<span class="muted small"> shops ${gold(shopsValue(s, p))} · stocks ${gold(stockValue(s, p))}</span></div>
</div>`;
}

// ---------- Stock market ----------

function marketTable(s: GameState): string {
  const b = indexBoard(s.board);
  const head = s.players.map((pl, i) => `<th title="${esc(pl.name)}"><span class="dot" style="background:${PLAYER_COLORS[i]}">${i + 1}</span></th>`).join('');
  const rows = b.districts.map((d) => {
    const owners = (b.districtShops.get(d) ?? []).map((id) => {
      const o = s.shops[id].owner;
      return `<span class="mini" style="background:${o === null ? '#e2e8f0' : PLAYER_COLORS[o]}"></span>`;
    }).join('');
    const held = s.players.map((pl) => `<td>${pl.shares[d] || ''}</td>`).join('');
    return `<tr><td><span class="swatch" style="background:${districtColor(s, d)}"></span>${esc(d)}</td><td><b>${gold(stockPrice(s, d))}</b></td><td>${owners}</td>${held}</tr>`;
  }).join('');
  return `<table class="market-table"><thead><tr><th>District</th><th>Price</th><th>Shops</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- Log ----------

const TURN_HEADER = /^--- (.*) ---$/;

/** Newest turn first; within a turn, lines in the order they happened. */
export function logList(log: string[]): string {
  const turns: { title: string | null; lines: string[] }[] = [];
  for (const line of log) {
    const header = line.match(TURN_HEADER);
    if (header) turns.push({ title: header[1], lines: [] });
    else if (turns.length === 0) turns.push({ title: null, lines: [line] });
    else turns[turns.length - 1].lines.push(line);
  }
  const items = turns.slice(-60).reverse().map((t, i) => {
    const title = t.title === null ? '' : `<div class="turn-title">${esc(t.title)}</div>`;
    return `<li class="turn${i === 0 ? ' current' : ''}">${title}${t.lines.map((l) => `<div>${esc(l)}</div>`).join('')}</li>`;
  });
  return `<ol class="log-list">${items.join('')}</ol>`;
}

// ---------- Square labels ----------

export function shortLabel(s: GameState, id: SquareId): string {
  const b = indexBoard(s.board);
  const sq = b.byId.get(id)!;
  switch (sq.type) {
    case 'shop': return sq.name ?? `${sq.district}${(b.districtShops.get(sq.district) ?? []).indexOf(id) + 1}`;
    case 'bank': return 'Bank';
    case 'suit': return SUIT_SYMBOLS[sq.suit];
    case 'stockbroker': return 'Stockbroker';
    case 'takeABreak': return 'Take a break';
    case 'venture': return s.config.ventureCards ? 'Venture' : 'Blank';
  }
}

// ---------- Action panel (what the current player can do) ----------

type ChoiceOf<T extends Choice['type']> = Extract<Choice, { type: T }>;
const pick = <T extends Choice['type']>(prompt: ActionPrompt, type: T): ChoiceOf<T>[] =>
  prompt.choices.filter((c): c is ChoiceOf<T> => c.type === type);

const btn = (attr: string, label: string, cls = '') => `<button class="${cls}" ${attr}>${label}</button>`;
const PASS_ATTR = actAttr({ type: 'pass' });

/** Shown when someone else must act: a bot, or (online) another person. */
function waitingPanel(app: AppState, p: PlayerId, online: OnlineInfo | undefined): string {
  const rawName = app.game.players[p].name;
  const name = esc(rawName);
  if (!isHuman(app, p)) return `<h3>${name} ${be(rawName)} thinking…</h3><p class="muted">Bots play automatically.${online ? '' : ' Change their speed at the top.'}</p>`;
  const seat = online?.seats[p];
  const auction = app.game.phase.kind === 'auction' ? ' Bids are sealed: nobody sees them until the auction ends.' : '';
  if (seat && !seat.connected) {
    if (seat.standIn) return `<h3>${name} is offline</h3><p class="muted">A bot is playing for ${name} until they come back.</p>`;
    return `<h3>${name} is offline</h3><p class="muted">The game waits for them to reconnect. If they're gone for good, a bot can play their turns until they return.</p>
${btn(uiAttr({ cmd: 'standIn', seat: p }), `Let a bot play for ${name}`, 'primary')}`;
  }
  return `<h3>Waiting for ${name}…</h3><p class="muted">${name} is deciding.${auction}</p>`;
}

function actionPanel(app: AppState, prompt: ActionPrompt | null, online: OnlineInfo | undefined): string {
  const s = app.game;
  if (!prompt) return gameOverPanel(app, online);
  const me = prompt.player;
  if (!canAct(app, me)) return waitingPanel(app, me, online);
  const rawName = s.players[me].name;
  const name = esc(rawName);
  const ph = s.phase;
  switch (ph.kind) {
    case 'preRoll': {
      const sells = pick(prompt, 'sellStock');
      const sellBox = sells.length === 0 ? '' : `
<details><summary>Sell stock before rolling</summary>
${sellTable(sells, (c) => Math.min(c.maxQty, s.config.largeTradeThreshold - 1))}
<p class="muted small">Selling ${s.config.largeTradeThreshold}+ shares of one district in a turn lowers its price ${s.config.largeTradeStep}% at the end of the turn.</p></details>`;
      const title = app.viewer === me ? 'Your turn' : `${esc(possessive(rawName))} turn`;
      return `<h3>${title}</h3>${btn(actAttr({ type: 'roll' }), 'Roll the die', 'primary big')}${sellBox}`;
    }
    case 'move': {
      const routes = pick(prompt, 'move').map((c) => {
        const end = c.path[c.path.length - 1];
        const via = c.path.length > 1 ? ` <span class="muted small">via ${c.path.slice(0, -1).map((id) => esc(shortLabel(s, id))).join(', ')}</span>` : '';
        const cls = app.routeFor === end ? 'route highlight' : 'route';
        return btn(actAttr({ type: 'move', path: c.path }), `→ <b>${esc(shortLabel(s, end))}</b>${via}`, cls);
      }).join('');
      const total = s.turn.roll ?? ph.remaining;
      const note = ph.remaining < total ? ` (${ph.remaining} of ${total} steps left)` : '';
      const hint = app.routeFor !== null ? '<p class="hint">Several routes lead there. Pick one:</p>' : '<p class="muted small">Click a glowing square on the board, or pick a route here. Moving to the bank stops there first.</p>';
      return `<h3>${name} rolled a ${total}${note}</h3>${hint}<div class="routes">${routes}</div>`;
    }
    case 'buyShop': {
      const sq = shopDef(s, ph.square);
      const price = s.shops[ph.square].value;
      const owned = ownedInDistrict(s, sq.district, me);
      const size = districtSize(s, sq.district);
      const feeAfter = feeFor(shopBaseFee(sq), sq.baseValue, price, size, owned + 1);
      const short = s.players[me].cash < price ? '<p class="warn">You don\'t have enough cash; you\'ll have to sell stock to cover it.</p>' : '';
      return `<h3>${esc(shortLabel(s, ph.square))} is for sale</h3>
<p>Price <b>${gold(price)}</b>. Visitors would pay you <b>${gold(feeAfter)}</b>. You'd own ${owned + 1} of the ${size} shops in district ${esc(sq.district)}.</p>${short}
${btn(actAttr({ type: 'buyShop' }), `Buy for ${gold(price)}`, 'primary')} ${btn(PASS_ATTR, "Don't buy")}`;
    }
    case 'buyout': {
      const shop = s.shops[ph.square];
      const owner = s.players[shop.owner!];
      const price = buyoutPrice(s, ph.square);
      const short = s.players[me].cash < price ? '<p class="warn">You\'d have to sell stock to cover this.</p>' : '';
      return `<h3>Buy out ${esc(shortLabel(s, ph.square))}?</h3>
<p>You can force ${esc(owner.name)} to sell it to you for <b>${gold(price)}</b> (${s.config.buyoutMultiplier}× its ${gold(shop.value)} value). ${esc(owner.name)} receives ${gold(shop.value * s.config.buyoutToOwner)}.</p>${short}
${btn(actAttr({ type: 'buyout' }), `Buy out for ${gold(price)}`, 'primary')} ${btn(PASS_ATTR, 'No thanks')}`;
    }
    case 'invest': {
      const room = s.config.maxInvestPerTurn - s.turn.invested;
      const rows = pick(prompt, 'invest').map((c) => {
        const id = `inv-${c.square}`;
        return `<tr><td><b>${esc(shortLabel(s, c.square))}</b></td><td>${gold(s.shops[c.square].value)}</td><td>${gold(shopFee(s, c.square))}</td><td>${numberInput(id, 1, c.maxAmount, c.maxAmount)}</td><td>${btn(actAttr({ type: 'invest', square: c.square, amount: 0 }, { id, field: 'amount' }), 'Invest')}</td></tr>`;
      }).join('');
      return `<h3>Invest in your shops</h3>
<p class="muted small">Up to ${gold(room)} more this turn. Investing raises a shop's value (and so its fee) and lifts that district's stock price. Your net worth stays the same.</p>
<table class="form-table"><thead><tr><th>Shop</th><th>Value</th><th>Fee</th><th>Amount</th><th></th></tr></thead><tbody>${rows}</tbody></table>
${btn(PASS_ATTR, 'Done investing')}`;
    }
    case 'buyStock': {
      const options = pick(prompt, 'buyStock');
      const rows = options.map((c) => {
        const id = `buy-${c.district}`;
        return `<tr><td><span class="swatch" style="background:${districtColor(s, c.district)}"></span>${esc(c.district)}</td><td>${gold(c.pricePerShare)}</td><td>${s.players[me].shares[c.district] || 0}</td><td>${numberInput(id, 1, c.maxQty, Math.min(c.maxQty, s.config.largeTradeThreshold))}</td><td>${btn(actAttr({ type: 'buyStock', district: c.district, qty: 0 }, { id, field: 'qty' }), 'Buy')}</td></tr>`;
      }).join('');
      const title = ph.discountPct > 0 ? `Buy stock at ${ph.discountPct}% off` : 'Buy stock';
      const then = ph.remaining > 0 ? `<p class="muted small">Afterwards you'll keep moving (${ph.remaining} more).</p>` : '';
      return `<h3>${title}</h3>
<p class="muted small">One district per visit, up to ${s.config.maxSharesPerPurchase} shares. Buying ${s.config.largeTradeThreshold}+ shares raises the price ${s.config.largeTradeStep}% at the end of your turn. Shareholders earn dividends whenever someone pays a fee in that district.</p>
<table class="form-table"><thead><tr><th>District</th><th>Price</th><th>You own</th><th>Shares</th><th></th></tr></thead><tbody>${rows}</tbody></table>${then}
${btn(PASS_ATTR, "Don't buy")}`;
    }
    case 'sellStockCard':
      return `<h3>Sell stock at ${ph.premiumPct}% above market price</h3>${sellTable(pick(prompt, 'sellStock'), (c) => c.maxQty)}
<p class="muted small">One district. Selling ${s.config.largeTradeThreshold}+ shares still lowers its price at the end of the turn.</p>${btn(PASS_ATTR, "Don't sell")}`;
    case 'chooseDistrict':
      return `<h3>Raise a district's stock price by 20%</h3><div class="routes">${pick(prompt, 'chooseDistrict').map((c) =>
        btn(actAttr({ type: 'chooseDistrict', district: c.district }), `<span class="swatch" style="background:${districtColor(s, c.district)}"></span>District ${esc(c.district)} <span class="muted small">now ${gold(stockPrice(s, c.district))}, you own ${shares(s.players[me].shares[c.district])}</span>`, 'route')).join('')}</div>`;
    case 'debt': {
      const debt = -s.players[me].cash;
      const sells = pick(prompt, 'sellStock');
      const shopRows = pick(prompt, 'sellShop').map((c) =>
        `<tr><td><b>${esc(shortLabel(s, c.square))}</b></td><td>${gold(s.shops[c.square].value)}</td><td>${gold(c.bankPays)}</td><td>${btn(actAttr({ type: 'sellShop', square: c.square }), 'Sell')}</td></tr>`).join('');
      const who = app.viewer === me ? 'You are' : `${name} ${be(rawName)}`;
      return `<h3>${who} ${gold(debt)} in debt</h3>
<p class="muted small">Raise cash until you're at 0G or more. Stock sells at full price. A shop sells to the bank for ${s.config.debtSaleRate}% of its value and is then auctioned to the other players.</p>
${sells.length ? `<h4>Sell stock</h4>${sellTable(sells, (c) => Math.min(c.maxQty, Math.ceil(debt / c.pricePerShare)))}` : ''}
${shopRows ? `<h4>Sell a shop</h4><table class="form-table"><thead><tr><th>Shop</th><th>Value</th><th>Bank pays</th><th></th></tr></thead><tbody>${shopRows}</tbody></table>` : ''}`;
    }
    case 'auction': {
      const c = pick(prompt, 'bid')[0];
      const who = app.viewer === me ? 'Place' : `${name}, place`;
      return `<h3>Auction: ${esc(shortLabel(s, ph.square))}</h3>
<p>${who} a <b>sealed bid</b>. Minimum ${gold(c.min)} (the shop's value). Highest bid wins; ties go to the player later in turn order. The money goes to the bank.</p>
<p>${numberInput('bid', c.min, c.max, c.min)} ${btn(actAttr({ type: 'bid', amount: 0 }, { id: 'bid', field: 'amount' }), 'Place bid', 'primary')} ${btn(PASS_ATTR, 'Pass')}</p>`;
    }
    case 'gameOver':
      return gameOverPanel(app, online);
  }
}

function sellTable(options: ChoiceOf<'sellStock'>[], defaultQty: (c: ChoiceOf<'sellStock'>) => number): string {
  const rows = options.map((c) => {
    const id = `sell-${c.district}`;
    return `<tr><td>${esc(c.district)}</td><td>${gold(c.pricePerShare)}</td><td>${c.maxQty}</td><td>${numberInput(id, 1, c.maxQty, defaultQty(c))}</td><td>${btn(actAttr({ type: 'sellStock', district: c.district, qty: 0 }, { id, field: 'qty' }), 'Sell')}</td></tr>`;
  }).join('');
  return `<table class="form-table"><thead><tr><th>District</th><th>Price</th><th>You own</th><th>Shares</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function gameOverPanel(app: AppState, online: OnlineInfo | undefined): string {
  const s = app.game;
  if (s.phase.kind !== 'gameOver') return '';
  const winnerId = s.phase.winner;
  const winner = s.players[winnerId].name;
  const youWon = app.viewer === winnerId || (app.viewer === null && isYou(winner));
  const why = { target: 'reached the target net worth at the bank', bankruptcy: 'had the highest net worth when a player went bankrupt', maxRounds: 'had the highest net worth when the round limit was reached' }[s.phase.reason];
  const rows = rankings(s).map((p, rank) => `<tr><td>${rank + 1}.</td><td><span class="dot" style="background:${PLAYER_COLORS[p]}">${p + 1}</span> ${esc(s.players[p].name)}</td><td><b>${gold(netWorth(s, p))}</b></td></tr>`).join('');
  const title = youWon ? '🏆 You win!' : `🏆 ${esc(winner)} ${verbS(winner, 'win')}!`;
  const next = online
    ? btn(uiAttr({ cmd: 'backToLobby' }), 'Back to the room', 'primary') + '<p class="muted small">Everyone goes back to the room, where the host can start a rematch.</p>'
    : btn(uiAttr({ cmd: 'newGame' }), 'New game', 'primary');
  return `<h3>${title}</h3><p>${youWon ? 'You' : 'They'} ${why}, in round ${s.round}.</p>
<table class="form-table"><tbody>${rows}</tbody></table>${next}`;
}

// ---------- Info panel (the selected square) ----------

function infoPanel(app: AppState): string {
  const s = app.game;
  if (app.selected === null) return '<p class="muted small">Click any square for details.</p>';
  const sq = indexBoard(s.board).byId.get(app.selected)!;
  const title = `<h3>${esc(shortLabel(s, sq.id))}</h3>`;
  return title + describeSquare(s, sq);
}

function describeSquare(s: GameState, sq: SquareDef): string {
  switch (sq.type) {
    case 'shop': {
      const shop = s.shops[sq.id];
      const size = districtSize(s, sq.district);
      const owner = shop.owner === null ? 'nobody (for sale)' : esc(s.players[shop.owner].name);
      const lines = [
        `District <b>${esc(sq.district)}</b> (${size} shops) · stock price ${gold(stockPrice(s, sq.district))}`,
        `Owner: <b>${owner}</b>${shop.owner !== null ? ` (${ownedInDistrict(s, sq.district, shop.owner)} of ${size} in this district)` : ''}`,
        `Value <b>${gold(shop.value)}</b> (base ${gold(sq.baseValue)})`,
        shop.owner === null ? `Price to buy: ${gold(shop.value)}` : `Fee: <b>${gold(shopFee(s, sq.id))}</b> · can still invest ${gold(shopMaxCapital(s, sq.id))}`,
        shop.owner === null ? '' : `Buyout price: ${gold(buyoutPrice(s, sq.id))}`,
      ];
      return `<p>${lines.filter(Boolean).join('<br>')}</p>`;
    }
    case 'bank':
      return '<p>Pass or land here with all four suits to be promoted and paid a salary. You can buy stock here, and you win by arriving here with the target net worth. Landing here lets you move in any direction next turn.</p>';
    case 'suit':
      return `<p>Pass or land here to collect ${SUIT_SYMBOLS[sq.suit]}. Collect all four, then visit the bank for a promotion.${s.config.ventureCards ? ' Landing here also draws a venture card.' : ''}</p>`;
    case 'stockbroker':
      return '<p>Land here to buy stock.</p>';
    case 'takeABreak':
      return '<p>Land here and your shops close until your next turn: visitors pay you nothing.</p>';
    case 'venture':
      return s.config.ventureCards ? '<p>Land here to draw a venture card.</p>' : '<p>Nothing happens here (venture cards are off).</p>';
  }
}

function shopDef(s: GameState, id: SquareId) {
  const sq = indexBoard(s.board).byId.get(id);
  if (!sq || sq.type !== 'shop') throw new Error(`Square ${id} is not a shop`);
  return sq;
}