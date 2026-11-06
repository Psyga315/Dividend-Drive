# RULES.md: Stock-Market Board Game (working title TBD)

A PC game based on Fortune Street's **Standard rules**, cut down to the
"stock-market Monopoly" core. If the code and this file disagree, fix one of them.

**Tags**
- ✅ Matches the original game's code (via the Fortune Street Modding District Simulator)
- 🟡 How the original game is reported to work (wikis and forums). Likely right, not confirmed.
- 🔧 Our own choice or a starting guess. Change it freely.

---

## 1. Goal

- **Win:** be the first player to **reach the bank** (passing or landing) with **net worth ≥ target**. 🟡
- **Net worth** = cash + total value of your shops + (your shares × current price) in every district. ✅
- **Other ways the game ends:** when `bankruptcyLimit` players have gone bankrupt, or when `maxRounds` runs out (if it's set). The highest net worth then wins. 🟡
- **Ties:** the player later in the turn order ranks higher. 🟡
- **Information:** everything is public (cash, shops, shares, suits). 🔧
- **Setup:** turn order is random. Everyone starts on the bank and may move in any direction on their first turn. 🟡

## 2. Settings and numbers (all adjustable)

| Key | Default | Tag | Notes |
|---|---|---|---|
| `players` | 2–4, any mix of humans and bots | 🔧 | The original always has 4 |
| `initialCash` | 1500 | 🔧 | Guess. Tune with bot-vs-bot simulations |
| `targetNetWorth` | 10000 | 🔧 | Guess. The original's practice board uses 8000 |
| `baseSalary` | 250 | 🟡 | "Usually 250" |
| `salaryIncrement` | 150 | 🟡 | Multiplied by your level |
| `shopBonusRate` | 10% | 🟡 | Share of your total shop value added to salary |
| `dieMax` | 6 | 🔧 | Die rolls 1 to `dieMax`. Original boards vary |
| `maxInvestPerTurn` | 999 | 🟡 | |
| `maxSharesPerPurchase` | 99 | 🟡 | |
| `buyoutMultiplier` | 5 | 🟡 | Buyer pays 5 × the shop's value |
| `buyoutToOwner` | 3 | 🟡 | Owner gets 3 × value; the bank keeps the other 2 × |
| `debtSaleRate` | 75% | 🟡 | What the bank pays when you sell a shop to cover debt |
| `stockMultStart` | 11/256 (≈ 0.04297) | ✅ | Stored in the game as 0xB00 / 65536 |
| `largeTradeThreshold` | 10 shares | 🟡 | |
| `largeTradeStep` | 10% | 🟡 | Players report "about 10%, maybe 8%" |
| `dividendRate` | 20% | 🟡 | Share of each fee paid out to shareholders |
| `dividendMinShares` | 5 | 🟡 | Speculative; see §8.4 |
| `maxSuitYourself` | 9 | 🟡 | Wildcard limit (venture module only) |
| `bankruptcyLimit` | 1 | 🟡 | The original's default |
| `maxRounds` | off (100 in bot simulations) | 🔧 | One round = every active player takes a turn |
| `protectDominatedShops` | false | 🔧 | If true, shops in a fully owned district can't be bought out |
| `ventureCards` | false | 🔧 | Turns on §12 |
| `seed` | random | 🔧 | Same seed = same dice and cards (for replays and testing) |
| `seatCashBonus` | 125 | 🔧 | Seat i (0 = first player) starts with initialCash + i × 125 |

## 3. Board

The board is a network of squares connected in any direction. Each square has `id`, `type`, `x`, `y` and `links` (the ids of its neighbors). Shops also have `district`, `baseValue` and an optional `baseFee`.

| Square | When you pass it | When you land on it |
|---|---|---|
| **Bank** | Promotion check, then win check, then you may buy stocks (§9) | Same as passing, plus you may move in any direction next turn |
| **Shop** | Nothing | See §5.4 |
| **Suit** (♠ ♥ ♦ ♣) | Collect that suit | Collect that suit, and draw a venture card if the module is on |
| **Stockbroker** | Nothing | You may buy stocks (§8.2) |
| **Take-a-break** | Nothing | Your shops close until your next turn: they charge no fees and pay no dividends |
| **Venture** (module only) | Nothing | Draw a venture card |

**Board guidelines:** one bank, four suit squares spread around the board, 3–8 shops per district (4 is typical), shop values between 90 and 550, starting stock prices roughly 5–20. 🟡

## 4. Turn structure

1. **Start of turn:** your shops reopen if they were closed.
2. **Before rolling:** you may sell stocks in any district, any number of times, and view game info. You can only sell stocks here or when covering debt. 🟡
3. **Roll and move** (§4.1). Squares you pass trigger their "pass" effects.
4. **Land:** resolve the square you stopped on.
5. **End of turn**, in this order:
   1. Every player with cash below 0 covers their debt (§10), starting with the active player, then in turn order.
   2. Apply the stock price moves from large trades (§8.3).
   3. Check whether the game has ended (§11).

### 4.1 Movement
- Roll 1 to `dieMax` and move exactly that many squares, choosing your path at junctions.
- **No U-turns:** your next square can't be the one you just came from. 🟡
  - Exceptions: you may pick any direction at the start of your turn if you're standing on the bank, on the first turn, or after a "choose direction" card.
  - If the only way out is back, a U-turn is allowed. 🔧
- **Backtracking:** during a move, you may step back along squares you took this move. 🔧
  - Each step back gives you that step again and returns any suit you picked up on those squares.
  - You can't backtrack past a bank you've already passed this move; what happened there is final.
- Other players on a square have no effect.

## 5. Shops and districts

Each shop has a `baseValue` (never changes), a `value` (starts equal to `baseValue`), a `baseFee` (never changes) and an `owner`.

**Owning more shops in a district does not raise their value. It raises their fees and max capital (§5.2–5.3).** ✅ Some wikis say value rises too, but the game's code doesn't do that.

### 5.1 Base fee 🟡
If the board file doesn't set `baseFee`, calculate it:
`baseFee = round(baseValue × (0.2 − 0.15 × 0.2^(baseValue / 200)))`
This is the formula the fan board editor FortuneAvenue fits to the original boards. It works out to about 13% of value at 100, 17% at 200, and close to 20% from 500 up. The original boards set fees by hand, close to this curve.

### 5.2 Fee (what visitors pay) ✅
`fee = max(1, floor(baseFee × (2 × value − baseValue) × feeMult / baseValue))`

`feeMult` comes from the table below, using the number of shops in the district and how many of them this shop's owner has (counting this one). Investing until a shop is worth 2 × its base value triples its fee.

### 5.3 Max capital (how much more you can invest in a shop) ✅
`maxCapital = max(0, floor(baseValue × capMult) − value)`

If an owner loses shops in a district, a shop can end up worth more than its new limit allows. It keeps its value, but nothing more can be invested until the limit rises again.

**Tables.** Rows = N, the number of shops in the district. Columns = shops in that district owned by this owner. The last column in each row means owning the whole district ("domination").

**feeMult** ✅
| N | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | | | | | | | |
| 2 | 1 | 2 | | | | | | |
| 3 | 1 | 1.5 | 3.75 | | | | | |
| 4 | 1 | 1.25 | 2.5 | 5 | | | | |
| 5 | 1 | 1.25 | 2 | 3.25 | 6 | | | |
| 6 | 1 | 1.25 | 2 | 2.75 | 4.25 | 6.75 | | |
| 7 | 1 | 1.25 | 1.75 | 2.75 | 3.75 | 5.25 | 7.5 | |
| 8 | 1 | 1.25 | 1.75 | 2.5 | 3.5 | 4.5 | 6 | 8 |

**capMult** ✅
| N | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| 1 | 2 | | | | | | | |
| 2 | 1.5 | 3 | | | | | | |
| 3 | 1.5 | 2.25 | 6 | | | | | |
| 4 | 1.5 | 2 | 4 | 10 | | | | |
| 5 | 1.5 | 2 | 4 | 10 | 12 | | | |
| 6 | 1.5 | 2 | 4 | 10 | 12 | 14 | | |
| 7 | 1.5 | 2 | 4 | 10 | 12 | 14 | 16 | |
| 8 | 1.5 | 2 | 4 | 10 | 12 | 14 | 16 | 19 |

Rows 1–3 come from the fan mod CSMM. The unmodded game needs at least 3 shops per district, and its row 3 is fee 1 / 2 / 3.75 and cap 2 / 3 / 6. Rows 4–8 are the same in both.

### 5.4 Landing on a shop
- **No owner:** you may buy it for its current value.
- **Another player's shop:** pay the fee to the owner (nothing if their shops are closed). Dividends are paid out (§8.4). Then you may buy it out (§7).
- **Your own shop:** you may invest (§6).

### 5.5 Paying with stocks as backup 🟡
You may buy a shop, invest, or buy out a shop as long as **cash + the current value of your stocks ≥ the cost**. Your cash can go below zero; you cover it at the end of the turn (§10), usually by selling stock. Stocks themselves can only be bought with cash you actually have (cost ≤ cash).

## 6. Investing 🟡
- You can only invest when you land on one of your own shops (or through a venture card).
- You may invest in **any** of your shops anywhere on the board, each up to its max capital, **up to 999 total per turn**.
- Investing moves money from cash into shop value one-for-one, so your net worth doesn't change.
- The district's stock price updates right away (§8.1). ✅

## 7. Buyouts 🟡
- **When:** after paying the fee at another player's shop, you may buy that shop for **5 × its value**.
- **Who gets the money:** the owner receives 3 × the value; the bank keeps the other 2 ×.
- **What changes:** the shop's value stays the same. Fees and max capital update for every shop in that district.
- **Closed shops:** they can still be bought out. 🔧
- **Fully owned districts:** their shops can be bought out unless `protectDominatedShops` is on. 🔧

## 8. Stocks

### 8.1 Price ✅
Each district has one stock.
`price = max(1, floor(avgValue × mult))`, where `avgValue = floor(total shop value in the district / number of shops)`.
- `mult` starts at 11/256.
- The price recalculates whenever any shop value in the district changes.
- Large trades (§8.3) and venture cards change `mult`.

### 8.2 Buying and selling 🟡
- **Buy:** when you pass or land on the bank, or land on a stockbroker. One district per visit, 1–99 shares, at the current price, paid in cash.
- **Sell:** before rolling, or while covering debt. Any amount, at the current price.
- There's no limit on how many shares you can own in total, and the bank never runs out. 🔧

### 8.3 Large trades 🟡/🔧
- **Tracking:** for each player and district, keep a running total of shares bought minus shares sold this turn. Sales made to cover debt count; free shares from cards don't.
- **At the end of the turn:** if that total is +10 or more, multiply `mult` by 1.10. If it's −10 or less, multiply `mult` by 0.90.
- **Size doesn't matter:** it's one step per player per district per turn, whether you traded 10 shares or 99. 🔧
- **Intended effects** (these match how the original is played):
  - Selling 9 shares raises cash without moving the price.
  - Selling 10 crashes the price in a rival's district.
  - Buying and selling in the same turn cancel out.
- **Rounding quirk:** prices are rounded down, so a 10% step on a cheap stock may not show (7 → 7.7 → 7). The original does the same. 🟡

### 8.4 Dividends 🟡
Whenever someone pays a shop fee, the bank adds money: a pool worth **20% of the fee** goes to that district's shareholders, including the owner and the payer if they hold shares.
`dividend = floor(pool × yourShares / max(totalShares, 5))`

Because of the `max(…, 5)`, a sole shareholder needs at least 5 shares to collect the whole pool. Players report this behavior but it isn't confirmed. No fee paid means no dividends.

## 9. Bank, suits and promotions
- **Suits:** collect ♠ ♥ ♦ ♣ by passing or landing on suit squares. Collecting one you already have does nothing.
- **Suit Yourself cards** (venture module only): each one stands in for a missing suit and is used up. You can hold up to 9.
- **At the bank** (passing or landing), in this order:
  1. **Promotion**, if you have all 4 suits (wildcards can fill gaps). 🟡
     - Salary = `baseSalary + salaryIncrement × level + floor(total shop value / 10)`.
     - Then your level goes up by 1, and your suits and any wildcards you used are cleared.
     - Everyone starts at level 1.
  2. **Win check** (§1).
  3. **Buy stocks** if you want (§8.2).
- If you **land** on the bank, you may move in any direction next turn. 🟡

## 10. Debt, auctions and bankruptcy
- Cash may go below zero during a turn. At the end of the turn, each player below zero must sell until their cash is 0 or more.
- **Selling stocks:** any amount, at the current price.
- **Selling a shop:**
  - The bank pays you 75% of its value immediately. 🟡
  - The shop then goes to auction among the other active players, and the winning bid goes to the bank. 🟡
  - **How the auction works** 🔧: everyone bids once in secret. The minimum is the shop's value, and you can't bid more than your cash. Highest bid wins; ties go to the player later in turn order.
  - If nobody bids, the shop becomes unowned and keeps its current value. 🔧
- **Bankruptcy:** if you've sold everything and your cash is still below zero, you're bankrupt. You're out of the game, and your remaining shops become unowned with their values kept. 🔧

## 11. Game end
- A player reaches the bank with net worth ≥ target → that player wins.
- `bankruptcyLimit` reached → highest net worth wins.
- `maxRounds` reached (if set) → highest net worth wins.

## 12. Venture cards (optional module, off by default)
A shuffled deck of 20 cards, drawn when you land on a venture or suit square and reshuffled when it runs out. "Random district" means any district with equal chance. The original game's card numbers are in brackets.

| # | Effect | Original # |
|---|---|---|
| 1 | Stock prices +10% in a random district (`mult` × 1.10) | 60 |
| 2 | Stock prices +20% in a random district | 63 |
| 3 | Stock prices −10% in a random district | 41 |
| 4 | Stock prices −20% in a random district | 42 |
| 5 | Stock prices +20% in a district you choose | 97 |
| 6 | Receive 20 free shares in a random district | 21 |
| 7 | Receive 5 free shares in every district | 77 |
| 8 | Receive cash worth 10% of your total stock value | 61 |
| 9 | Buy stocks now (like a stockbroker) | 67 |
| 10 | Buy stocks now at 10% below market price | 59 |
| 11 | Sell stocks now at 20% above market price (counts toward §8.3) | 69 |
| 12 | Pay 2 per share you own | 43 |
| 13 | All shop values in a random district +10% | 31 |
| 14 | All shop values in a random district −10% | 48 |
| 15 | Invest in any of your shops now (999 limit applies) | 12 |
| 16 | Roll the die; receive 50 × the roll from the bank | 15 |
| 17 | Lose 10% of your cash | 46 |
| 18 | Receive a Suit Yourself card (if you already hold 9, receive 100 instead) | 100 |
| 19 | Move in any direction next turn | 1 |
| 20 | Receive half your salary | 17 |

- Shop value changes from cards: `value = floor(value × (1 ± percent))`, and stock prices update right away.
- A shop can drop below its base value this way. Its fee then shrinks, but never below 1.

## 13. Not included (possible later additions)
- **Trading shops between players** (buy, sell or swap before rolling). The original has this, so it's the top candidate for a second version, but bots would need negotiation logic.
- **Voluntary shop auctions.**
- **Everything else from the original:** vacant plots and special buildings, arcade minigames, Boon/Boom squares, warps, cannons, switches, roll-on and change-of-suit squares, the venture card bingo grid, characters, and Easy rules.

## 14. Starter board numbers
- **Layout:** 5 districts with 4 shops each, 1 bank, 4 suits, 1 stockbroker, 1 take-a-break (plus 2 venture squares if the module is on). About 32 squares in a loop with one shortcut. The exact layout goes in the board file.
- **Money check:** all shops together are worth 5160, compared with 6000 total starting cash (4 × 1500).

| District | Shop values (base fee in brackets) | Average value | Starting stock price |
|---|---|---|---|
| A | 100 (13), 120 (17), 160 (25), 180 (30) | 140 | 6 |
| B | 150 (23), 180 (30), 220 (38), 250 (45) | 200 | 8 |
| C | 200 (34), 230 (41), 260 (47), 310 (58) | 250 | 10 |
| D | 240 (43), 280 (52), 320 (60), 360 (69) | 300 | 12 |
| E | 300 (56), 350 (67), 420 (82), 530 (105) | 400 | 17 |

## 15. Test cases (expected results for the code to check)
1. `baseFee`: a value of 100 gives 13, 200 gives 34, 500 gives 99, 1000 gives 200.
2. A shop with base value 200 and base fee 34, in a district of 4 shops:

| Shops owned there | Fee at value 200 | Max capital | Fee after investing the max |
|---|---|---|---|
| 1 | 34 | 100 | 68 |
| 2 | 42 | 200 | 127 |
| 3 | 85 | 600 | 595 |
| 4 | 170 | 1800 | 3230 |

3. **Stock prices:**
   - District C starts at 10.
   - After 400 is invested in one of its shops, the average value is 350 and the price is 15.
   - Starting price after `mult` × 1.10 is 11.
4. **Dividends:**
   - A fee of 170 makes a pool of 34. With P1 holding 30 shares and P2 holding 10, P1 gets 25 and P2 gets 8.
   - A sole shareholder with 3 shares gets 20.
5. **Salary:** at level 1 with shops worth 600 in total, the salary is 460 (250 + 150 + 60).
6. **Buyout** of a shop worth 200: the buyer pays 1000, the owner gets 600, the bank keeps 400.
7. **Debt sale** of a shop worth 200: the seller gets 150, and auction bids start at 200.

## 16. Engine notes
- **Whole numbers:** all money is an integer.
- **Matching the original's rounding:** store `feeMult` × 4 and `capMult` × 256 as integers (whole-number math).
- **`mult`:** a decimal number is fine, or a whole number in 1/65536 units starting at 2816.
- **Randomness:** all dice and card draws come from a seeded random number generator kept in the game state, so simulations and online games can be replayed exactly.
- **Engine shape:**
  - The rules engine is one function, `step(state, action) → { state, events }`, plus `legalActions(state)`, which lists what the current player is allowed to do.
  - The rules engine contains no graphics or UI code.

## 17. Sources
- Fortune Street Modding District Simulator, `src/pages/simulator.js` in FortuneStreetModding/fortunestreetmodding.github.io: fee and max capital tables and formulas, stock price formula.
- FortuneAvenue changelog (v6): the base fee formula.
- Super Mario Wiki, "Fortune Street": salary formula, 75% debt sale, auctions, 999 investment cap, 99-share limit, bank direction rule, tie-break, venture card list.
- GameFAQs Fortune Street boards: 5× / 3× buyout split, about 10% price moves on large trades, 20% dividends.

## 18. Engine decisions (filled in while coding)
- A move that reaches the bank pauses there. After promotion and stock buying, the rest of the roll continues (no U-turn back).
- Buying stocks: one district per stop, then the stop ends.
- Card 11: sell shares in one district at +20%, then the turn ends.
- Card 17: takes 10% of cash only if cash is positive.
- The invest menu opens only if an investment is possible. It closes automatically once the 999 limit or every shop's max capital is used up.
- Shop purchases and buyouts you can't cover with cash + stocks are not offered.
- Auctions: players who can't pay the minimum bid pass automatically.
- Bankruptcy: the player's shops become unowned (values kept) and their shares are removed.

## 19. Balance decisions (bot simulations, starter board, 4 players)
- Game length: target 6,000 ≈ 30 rounds, 8,000 ≈ 35 (default), 10,000 ≈ 40.
- seatCashBonus 125 evens out turn order: wins by seat 25/25/24/26% (33/28/23/17% without it).
- largeTradeStep stays at 10%. A mix of shops and stocks wins (balanced 32%, trader 23%, landlord 13%; fair 25%).
  At 5%, the no-stocks landlord beat the trader.
- Winner's net worth: about 54% stocks, 29% shops, 18% cash.