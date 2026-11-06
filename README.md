\# Dividend Drive



A turn-based board game you play in your browser: buy shops, invest in them, trade district stocks and collect dividends. The first player to reach the bank with the target net worth wins.



!\[Dividend Drive screenshot](docs/Dividend Drive.png)



\## Features



\- 2–4 players on one computer, any mix of humans and bots

\- Four bot styles: balanced, trader (loves stocks), landlord (no stocks) and random

\- A stock market: prices follow shop values, trading 10+ shares moves the price, and shareholders earn dividends whenever anyone pays a fee in their district

\- Districts, investing, buyouts, debt auctions, suits and promotions

\- Optional venture cards (20 random events)

\- Saves automatically in your browser



\## How to play



\- Roll and move. At junctions you pick your route; no U-turns.

\- Land on an empty shop to buy it. Rivals who land on your shops pay you a fee.

\- Owning more shops in a district raises their fees and how much you can invest in them.

\- Land on one of your shops to invest: its value and fee go up, and so does the district's stock price.

\- Buy stock at the bank or the stockbroker.

\- Collect all four suits (♠ ♥ ♦ ♣), then pass the bank for a promotion and a salary.

\- Reach the target net worth (cash + shops + stocks) and get to the bank to win.



The full rules, with every number, are in \[RULES.md](RULES.md).



\## Running it



You need \[Node.js](https://nodejs.org) 22.18 or newer.



```

npm install

npm run dev

```



The game opens at http://127.0.0.1:5173.



| Command | What it does |

|---|---|

| `npm run dev` | Builds and serves the game, and reloads the page when you save a file |

| `npm test` | Runs the tests |

| `npm run typecheck` | Checks the TypeScript for errors |

| `npm run sim` | Plays 1,000 bot games and prints balance statistics (`node scripts/simulate.ts --log` prints one full game) |

| `npm run build:web` | Builds the game into `web/` as static files for any web host |



\## How it's built



Plain TypeScript, with no frameworks and no runtime dependencies.



\- `src/engine/`: the rules. `step(state, action)` returns the next state plus a list of events, and `legalActions(state)` lists what the current player may do.

\- `src/bots/`: computer players

\- `src/ui/`: the browser interface (HTML and an SVG board)

\- `src/boards/`: board layouts

\- `tests/`: rule tests, random stress tests, and UI tests that click through whole games



\## Credits



Inspired by \*Fortune Street\* (\*Itadaki Street\*). The shop fee and capital tables follow the original game's formulas, as documented by the \[Fortune Street Modding](https://fortunestreetmodding.github.io) community.



Dividend Drive is a fan project. It is not affiliated with or endorsed by Nintendo or Square Enix, and it contains none of their art, music, characters or boards.



\## License



\[MIT](LICENSE)

