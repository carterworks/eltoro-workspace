/**
 * Alchemy stack for the El Toro site.
 *
 * Replaces the `eltoro-site` Cloudflare Pages project with a Worker serving
 * static assets. The site is Astro with `output: "static"`, so `StaticSite`
 * runs the app's own `build` script and uploads `dist/` — the same build and
 * output the Pages project published.
 *
 * Deploy from `apps/site` with `pnpm run deploy`. The `prod` stage also wires
 * the custom domain by adopting the pre-existing `carter.works` zone, the
 * `eltoro.carter.works` DNS record, and its Worker route.
 */
import { adopt } from "alchemy/AdoptPolicy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stage from "alchemy/Stage";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "eltoro-site",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage.Stage;
    const site = yield* Cloudflare.Website.StaticSite("Website", {
      name: "eltoro-site",
      compatibility: { date: "2024-09-03" },
      command: "pnpm run build",
      outdir: "dist",
      dev: { command: "pnpm run dev" },
    });

    if (stage === "prod") {
      const zone = yield* Cloudflare.Zone.Zone("CarterWorks", {
        name: "carter.works",
      }).pipe(adopt(true));

      // The subdomain record the route depends on. Points at the Worker's
      // workers.dev origin rather than the retired Pages project, so the
      // record still resolves even if the route is ever dropped. Confirm the
      // workers.dev origin against Cloudflare before the first deploy.
      yield* Cloudflare.DNS.Record("ElToroSiteApex", {
        zoneId: zone.zoneId,
        name: "eltoro.carter.works",
        type: "CNAME",
        content: "eltoro-site.carterworks.workers.dev",
        proxied: true,
      }).pipe(adopt(true));

      yield* Cloudflare.Workers.WorkerRoute("ElToroSiteRoute", {
        zoneId: zone.zoneId,
        pattern: "eltoro.carter.works/*",
        script: site.workerName,
      }).pipe(adopt(true));
    }

    return { url: site.url };
  }),
);
