# Request limits and profile cache

`POST /cards` has two server-side guards before any upstream Misskey/avatar
fetch, plus a UI-only repeated-click guard in the browser:

1. Upstream 429 cooldown (process-local)
2. Global concurrency gate (no queue, immediate `429`)
3. Bounded short-TTL profile/avatar cache (rendered cards are never cached)
4. Browser generation-button cooldown: 3 seconds after each completed
   request (UI-only, bypassable — see below)

All `429` responses are JSON with `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and a `Retry-After` header (seconds).

## What this does NOT do

The generation-button cooldown is UI-only politeness, not abuse
protection:

- It cannot stop direct API clients (`curl`, scripts, bots) calling
  `POST /cards` — the server performs no per-IP or global request counting.
- Reloading the page or opening multiple tabs bypasses the button cooldown.
- Do not claim that hostile bots are blocked. Robust public abuse
  protection (shared rate limiting at a gateway / reverse proxy, WAF,
  CAPTCHA) is out of scope for this app.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `CARD_MAX_CONCURRENT` | `4` | Max concurrent profile-fetch + render pipelines; excess gets immediate `429` with `Retry-After: 2` |
| `CARD_UPSTREAM_COOLDOWN_MS` | `30000` | Upstream 429 cooldown when `Retry-After` is missing/unparsable |
| `CARD_UPSTREAM_COOLDOWN_MAX_MS` | `300000` | Upper bound for any upstream cooldown delay |
| `CARD_PROFILE_CACHE_TTL_MS` | `60000` | TTL for successful profile+avatar entries |
| `CARD_PROFILE_NEGATIVE_CACHE_TTL_MS` | `15000` | TTL for `not_found` negatives (`0` disables) |
| `CARD_PROFILE_CACHE_MAX_ENTRIES` | `200` | Max cached usernames (oldest-first eviction) |
| `CARD_PROFILE_CACHE_MAX_AVATAR_BYTES` | `20971520` | Max total cached avatar bytes (oldest-first eviction) |

Invalid values throw at startup (fail fast). Only successful profiles and
(optional) `not_found` negatives are cached; every issuance still renders
fresh cards with a new UUID/date. A single avatar larger than the byte budget
is served but never stored.

Upstream `429` handling: `Retry-After` (delay-seconds or HTTP-date, clamped to
the max) sets the cooldown; otherwise the default applies. Avatar `429`s are
swallowed into the renderer's fallback image but still trigger the cooldown.

There is intentionally no client-IP accounting, no request windows or quotas,
and no trusted-proxy / `X-Forwarded-For` configuration: Fastify runs with its
defaults and the app never interprets proxy headers.

## Button behavior (usage)

- While a card is generating, the button is disabled and the form reports
  `aria-busy`. Extra submits (button, Enter key, programmatic) are ignored.
- After success or failure, the button stays disabled for 3 seconds. During
  both generation and this short wait, its label is `しばらくお待ちください`; no remaining
  seconds are displayed. The disabled button is gray with no shadow, hidden
  action arrow, and a not-allowed cursor (no hover lift).
- Previews, results, and download links stay on screen during the wait.
  The preview status still reports success/failure independently of the
  button label, which returns to `カードを作る` when the wait expires.
- A validation failure before any request starts no cooldown.
- A `429` with a `Retry-After` longer than 3 seconds extends the button
  cooldown to honor it (bounded, seconds or HTTP-date). JSON, parsing, and
  network failures still fall back to the 3-second wait and re-enable the
  button afterwards.

## Caveats and residual risks

- CPU/memory/PID/log bounds: the concurrency gate (`CARD_MAX_CONCURRENT`,
  default `4`) is the backstop for local rendering cost (`sharp` work is
  CPU- and memory-intensive per request) — size it from load tests of this
  host, not from upstream capacity. Process/thread counts, container memory
  limits, and log volume (every `/cards` failure is logged) still need
  platform-level bounds (cgroup limits, log rotation/retention) outside this
  app.
- TLS and edge termination: the app speaks plain HTTP. Always terminate TLS
  at the reverse proxy / load balancer and never expose the app port
  directly.
- Cooldown clamp: upstream `Retry-After` values larger than
  `CARD_UPSTREAM_COOLDOWN_MAX_MS` are clamped down to the max, so an upstream
  asking for a longer backoff will see this service retry sooner than asked.
  If the upstream documents longer backoffs, raise the max via operator
  configuration rather than code changes.
- Direct API abuse: without per-IP counting, any client can issue requests
  up to the concurrency gate as fast as it likes. If this service is exposed
  to hostile traffic, add shared limiting in front of it.

## Single-process limitation

The concurrency gate, the cooldown, and the cache are process-local and
bounded. Under multiple processes or replicas, each instance enforces its own
limits: effective global capacity scales with the replica count and a
cooldown on one instance does not cover the others. Run a single replica, or
put shared limiting (e.g. a gateway / reverse proxy with a shared counter)
in front when scaling horizontally.

## Deployment note (tsukikage dev/prod)

No deployment changes are needed for this policy: no new environment
variables, no proxy-header configuration, and no container or replica
changes. The defaults (`CARD_MAX_CONCURRENT=4`, upstream cooldown
30s/max 300s, profile cache as above) apply to both dev and prod unless the
operator already overrides them. Container memory/CPU limits and replica
counts behave as before — remember each replica enforces its own
process-local gate, cooldown, and cache.
