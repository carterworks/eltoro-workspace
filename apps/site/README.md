# El Toro site

The static Astro site served at [eltoro.carter.works](https://eltoro.carter.works).

```console
pnpm dev
pnpm build
```

Cloudflare Pages builds and deploys `main` automatically. Its project runs `pnpm --filter apps-site build` from the repository root and publishes `apps/site/dist`.
