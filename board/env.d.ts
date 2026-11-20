declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AUTH_FAIL_LIMITER?: RateLimit;
    // Keys. Prefer the *_KEY_SHA256 hashes; OWNER_TOKEN / WORKER_TOKEN are the legacy plaintext form.
    OWNER_KEY_SHA256?: string;
    WORKER_KEY_SHA256?: string;
    VIEWER_KEY_SHA256?: string;
    WORKER_TOKEN?: string;
    OWNER_TOKEN?: string;
    BOARD_ENCRYPTION_KEY?: string;
    BOARD_ENCRYPTION_KEY_PREVIOUS?: string;
    ALLOW_PLAINTEXT_STORAGE?: string;
    STRICT_ENCRYPTION?: string;
    SESSION_SECRET?: string;
    WORKER_NAME?: string;
    WORKER_RATE_LIMIT_PER_MIN?: string;
    TEST_MIGRATIONS?: import("cloudflare:test").D1Migration[];
  }
}
interface Env extends Cloudflare.Env {}
