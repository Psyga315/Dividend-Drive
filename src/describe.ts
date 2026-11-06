// Plain-English text for game events. Used by the simulator logs and the in-game log.
import { indexBoard, type GameEvent, type GameState, type PlayerId, type SquareId, type Suit } from './engine/index.ts';

export const SUIT_SYMBOLS: Record<Suit, string> = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };

export const gold = (n: number): string => `${n.toLocaleString('en-US')}G`;

/** "1 share", "5 shares" */
export const shares = (n: number): string => `${n} share${n === 1 ? '' : 's'}`;

// ---------- Grammar for a player named "You" ("You were promoted", not "You was") ----------

export const isYou = (name: string): boolean => name.trim().toLowerCase() === 'you';
/** "Ada's" / "Your" */
export const possessive = (name: string): string => (isYou(name) ? 'Your' : `${name}'s`);
/** Name in the middle of a sentence: "paid 40G to Ada" / "paid 40G to you" */
export const objectName = (name: string): string => (isYou(name) ? 'you' : name);
/** "is" / "are" */
export const be = (name: string): string => (isYou(name) ? 'are' : 'is');
const was = (name: string) => (isYou(name) ? 'were' : 'was');
const their = (name: string) => (isYou(name) ? 'your' : 'their');
/** "wins" / "win" */
export const verbS = (name: string, verb: string): string => (isYou(name) ? verb : `${verb}s`);

/** Shops are named by district and position, e.g. "C1", unless the board gives them a name. */
export function squareLabel(s: GameState, id: SquareId): string {
  const b = indexBoard(s.board);
  const sq = b.byId.get(id);
  if (!sq) return `square ${id}`;
  switch (sq.type) {
    case 'shop': return sq.name ?? `${sq.district}${(b.districtShops.get(sq.district) ?? []).indexOf(id) + 1}`;
    case 'bank': return 'the bank';
    case 'suit': return `the ${SUIT_SYMBOLS[sq.suit]} square`;
    case 'stockbroker': return 'the stockbroker';
    case 'takeABreak': return 'take-a-break';
    case 'venture': return 'a venture square';
  }
}

export function describeEvent(s: GameState, e: GameEvent): string {
  const who = (p: PlayerId) => s.players[p].name;
  const whom = (p: PlayerId) => objectName(s.players[p].name);
  const at = (id: SquareId) => squareLabel(s, id);
  switch (e.type) {
    case 'turnStarted': return `--- Round ${e.round}: ${who(e.player)} ---`;
    case 'rolled': return `${who(e.player)} rolled a ${e.value}.`;
    case 'moved': return `${who(e.player)} moved to ${at(e.path[e.path.length - 1])}.`;
    case 'suitCollected':
      return e.onTheWay
        ? `${who(e.player)} picked up ${SUIT_SYMBOLS[e.suit]} on the way.`
        : `${who(e.player)} collected ${SUIT_SYMBOLS[e.suit]}.`;
    case 'promoted': return `${who(e.player)} ${was(who(e.player))} promoted to level ${e.level} and earned ${gold(e.salary)}.`;
    case 'feePaid': return `${who(e.player)} paid ${gold(e.amount)} to ${whom(e.owner)} at ${at(e.square)}.`;
    case 'shopClosed': return `${at(e.square)} is closed (${whom(e.owner)} ${be(who(e.owner))} taking a break): no fee.`;
    case 'dividend': return `${who(e.player)} received a ${gold(e.amount)} dividend from district ${e.district}.`;
    case 'shopBought': return `${who(e.player)} bought ${at(e.square)} for ${gold(e.price)}.`;
    case 'invested': return `${who(e.player)} invested ${gold(e.amount)} in ${at(e.square)}.`;
    case 'boughtOut':
      return `${who(e.player)} bought out ${at(e.square)} from ${whom(e.from)} for ${gold(e.price)} (${who(e.from)} received ${gold(e.ownerReceived)}).`;
    case 'stockBought': return `${who(e.player)} bought ${shares(e.qty)} of ${e.district} at ${gold(e.pricePerShare)} each.`;
    case 'stockSold': return `${who(e.player)} sold ${shares(e.qty)} of ${e.district} at ${gold(e.pricePerShare)} each.`;
    case 'stockPriceChanged': {
      // Large trades move the price when the turn ends (RULES.md §8.3), so say so.
      const when = e.reason === 'card' ? '' : 'End of turn: ';
      const why = { largeBuy: 'large purchase', largeSell: 'large sale', card: 'venture card' }[e.reason];
      const change = e.newPrice === e.oldPrice
        ? `barely moved (still ${gold(e.newPrice)})`
        : `${e.newPrice > e.oldPrice ? 'rose' : 'fell'} from ${gold(e.oldPrice)} to ${gold(e.newPrice)}`;
      return `${when}${when ? 'district' : 'District'} ${e.district} stock ${change} (${why}).`;
    }
    case 'tookBreak': {
      const name = who(e.player);
      return `${name} ${be(name)} taking a break: ${their(name)} shops are closed until ${their(name)} next turn.`;
    }
    case 'cardDrawn': return `${who(e.player)} drew venture card ${e.card}: "${e.text}"`;
    case 'cashChanged': return `${who(e.player)} ${e.amount >= 0 ? 'received' : 'paid'} ${gold(Math.abs(e.amount))}.`;
    case 'sharesGranted': return `${who(e.player)} received ${shares(e.qty)} of ${e.district} for free.`;
    case 'shopValuesChanged': return `Shop values in district ${e.district} ${e.pct >= 0 ? 'rose' : 'fell'} ${Math.abs(e.pct)}%.`;
    case 'wildcardGained': return `${who(e.player)} received a Suit Yourself card.`;
    case 'shopSoldToBank': return `${who(e.player)} sold ${at(e.square)} to the bank for ${gold(e.amount)} to cover debt.`;
    case 'auctionWon': return `${who(e.player)} won the auction for ${at(e.square)} with ${gold(e.bid)}.`;
    case 'auctionNoBids': return `Nobody bid on ${at(e.square)}, so it is unowned again.`;
    case 'bankrupt': return `${who(e.player)} went bankrupt!`;
    case 'gameOver': {
      const why = {
        target: 'reached the target net worth at the bank',
        bankruptcy: 'had the highest net worth when a player went bankrupt',
        maxRounds: 'had the highest net worth at the round limit',
      }[e.reason];
      return `GAME OVER: ${who(e.winner)} ${verbS(who(e.winner), 'win')} (${why}).`;
    }
  }
}