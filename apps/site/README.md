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

Cloudflare Pages cannot host the relay: a Pages Function cannot send on a WebSocket
created by another request (`Cannot perform I/O on behalf of a different request`),
and Durable Objects cannot be created inside a Pages project — they need a separately
deployed Worker. So netplay rides the public **y-websocket** relay instead:

- Relay: `wss://demos.yjs.dev/ws`, room = path segment, `bullpong-<CODE>`.
- Host (right paddle) owns the simulation and publishes snapshots through the
  awareness channel at ~25 Hz; the guest (left paddle) publishes only its paddle
  position. Both read the other's awareness state — no server logic of ours.
- Solo mode (vs the AI) is the fallback whenever the relay is unreachable: the page
  degrades to single player instead of failing.
- Share link format: `/artifacts/bull-pong/?room=<CODE>`.
- The host is authoritative; the guest renders relayed snapshots and extrapolates the
  bull's motion from its last known velocity, so its view trails by roughly the
  relay's one-way latency. A player who goes quiet for 4s is treated as gone (the
  awareness protocol's own timeout is 30s, too slow for a live match).

If the relay ever needs to move onto our own domain, the change is one constant
(`RELAY_URL`) plus a Durable Object Worker deployed with the operator's Cloudflare
credentials; the protocol and tests stay as they are.
