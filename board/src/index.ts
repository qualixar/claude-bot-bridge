// Cloudflare Workers entry. The application itself lives in app.ts and is shared with the Node server.
import { createApp, type App } from "./app";
import { configFromEnv } from "./config";
import { bindingFailureLimiter } from "./guard";
import { WORKERS_STREAM } from "./web/routes";

const apps = new WeakMap<object, App>();

/** One app per env object: the parsed config and the imported encryption keys are reused across requests. */
function appFor(env: Env): App {
  let app = apps.get(env);
  if (!app) {
    app = createApp({
      db: env.DB,
      config: configFromEnv(env),
      clientIp: (req) => req.headers.get("cf-connecting-ip"),
      stream: WORKERS_STREAM,
      // The rate-limiting binding keeps failed-auth counting out of D1; without it the D1 counters are used.
      failureLimiter: env.AUTH_FAIL_LIMITER ? bindingFailureLimiter(env.AUTH_FAIL_LIMITER) : undefined,
    });
    apps.set(env, app);
  }
  return app;
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => appFor(env).fetch(req),
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await appFor(env).tick(Date.now());
  },
} satisfies ExportedHandler<Env>;
