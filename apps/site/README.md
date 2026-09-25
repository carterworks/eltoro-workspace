# El Toro site

The static Astro site served at [eltoro.carter.works](https://eltoro.carter.works).

```console
pnpm dev
pnpm build
pnpm test          # hermetic unit tests (game engine + netplay protocol)
pnpm test:live     # two real clients through the real relay (needs network)
pnpm test:browser  # two real Chromium clients, needs playwright + a browser
```

Cloudflare Pages builds and deploys `main` automatically. Its project runs `pnpm --filter apps-site build` from the repository root and publishes `apps/site/dist`.

## Structure

- `src/pages/` — one Astro page per route, including `artifacts/<slug>/`.
- `src/lib/<slug>/` — artifact logic split out of the page so it can be unit tested
  (`engine.js` = simulation, `netcode.js` = multiplayer protocol helpers).
- `src/components/` — shared markup, e.g. `ElToroLogo.astro`.
- `public/artifacts/<slug>/` — static assets for an artifact.
- `tests/` — `node --test` suites, run with `pnpm test`.
- `scripts/multiplayer-smoke.mjs` — live two-client netplay test (`pnpm test:live`).
- `scripts/netplay-browser.mjs` — the same thing in two real browser contexts,
  asserting through the page's `window.__bullpong` hook. Serve `dist/` on
  `127.0.0.1:8899` first (`python3 -m http.server 8899 --directory dist`) and run it
  with `playwright` installed. On NixOS,
  `nix build nixpkgs#playwright-driver.browsers` + a matching `npm i playwright@<version>`
  gives a browser this sandbox can actually launch.

## Multiplayer (Bull Pong)

Nobody makes a game or shares a code: the page is already playing the bull when it
loads, and a second visitor is dropped into that match, taking the bull's paddle
mid-rally.

Cloudflare Pages cannot host the relay: a Pages Function cannot send on a WebSocket
created by another request (`Cannot perform I/O on behalf of a different request`),
and Durable Objects cannot be created inside a Pages project — they need a separately
deployed Worker. So netplay rides the public **y-websocket** relay instead.

- Pens: a fixed pool of 8 relay rooms, `bullpong-pen-1` … `bullpong-pen-8`. On load a
  client probes every pen in parallel and picks the best seat going: take a lone
  player's bull paddle (`join`), take over a pen whose authority vanished
  (`takeover`), or settle into an empty one (`empty`). All pens full → keep playing
  the bull and rescan every ~15s.
- One authority per pen: the oldest seated client simulates, publishes snapshots at
  ~25 Hz, and follows the other human's reported paddle. Everyone else just renders
  snapshots, predicts their own paddle, and reports it.
- The bull plays whichever paddle has no human on it, so it hands its horn over when
  someone arrives and takes it back when they leave; a player whose authority
  disappears promotes itself after 4s and keeps its paddle.
- `?pen=<token>` namespaces the pens (`bullpong-<token>-1` …) — handy for a private
  or test pen without putting codes in the UI.
- Solo play is never blocked by the network: with the relay down the page is just a
  single-player game against the bull.

If the relay ever needs to move onto our own domain, the change is one constant
(`RELAY_URL`) plus a Durable Object Worker deployed with the operator's Cloudflare
credentials; the protocol and tests stay as they are.
