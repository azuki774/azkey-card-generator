# Cross-site request protection for POST /cards

## Problem

`POST /cards` accepts `application/x-www-form-urlencoded` bodies. That content
type is a CORS-safelisted ("simple request") content type, so an attacker's
site could cause a victim's browser to *send* such a POST (classic form /
`fetch(..., { mode: 'no-cors' })` conscription) and spend server resources
(Misskey lookup + image rendering) on the victim's behalf.

## What this change does

- Requires the dedicated header `X-Card-Request: 1` on **every** `POST /cards`
  request, checked in a route-attached `preHandler` before profile lookup and
  rendering. Missing or wrong values return a generic `403` JSON body with
  `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- The browser client (`public/assets/app.js`) sends that header via
  `fetch('/cards', ...)`.
- Explicitly rejects cross-site Fetch Metadata: any `Sec-Fetch-Site` value
  other than `same-origin` (`cross-site`, `same-site`, `none`, unknown) is
  rejected with the same generic 403. Absent `Sec-Fetch-Site` (curl / direct
  clients) is allowed through to the header check, so non-browser clients only
  need the dedicated header. Legitimate browser use is always a same-origin
  `fetch`, so this is strict without breaking the app.
- Deliberately does **not** enable CORS. The custom header makes cross-origin
  browser requests non-simple, forcing a preflight the server never grants.
  No `Access-Control-Allow-Origin` is ever emitted for `/cards`.
- No deployment-specific `Origin` allow-list is required. The custom header
  plus no-CORS is the primary mechanism, without deriving the public origin
  from potentially untrusted `Host` / `X-Forwarded-*` headers. Do not add CORS
  grants for `/cards` in the application or the reverse proxy.

## Sending vs. reading (why CORS alone is not the issue)

CORS controls whether a foreign page can *read* the response. It does not stop
the browser from *sending* a simple cross-site POST. The cost here (upstream
fetch + render) happens at send time, so the fix must stop the request from
being honored at all — hence the required non-simple header plus Fetch
Metadata rejection, enforced before any expensive work.

## Requirements for direct clients

Send `X-Card-Request: 1` with every `POST /cards` call, for both
`application/x-www-form-urlencoded` and JSON bodies. Example:

```sh
curl -X POST http://127.0.0.1:3000/cards \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'X-Card-Request: 1' \
  --data 'username=alice'
```

## What this is not

- Not bot authentication: the header value is public and visible in the
  shipped JS. It proves the request was made intentionally by script that
  could set headers (same-origin page or direct client), not that the caller
  is trusted.
- Not a replacement for rate limits or concurrency limits: an attacker can
  still send direct (non-browser) requests. Per-IP / global limits are still
  needed independently of this protection.
- Plain no-JS `<form method="post" action="/cards">` submissions no longer
  work because plain forms cannot set the custom header. This is intentional;
  the app already depends on JS to parse the JSON response and render Blob
  previews/downloads.

## Implementation notes

- Guard lives in `src/cross-site-guard.ts` (`guardCrossSiteCardsRequest`) and
  is attached via the route option
  `app.post('/cards', { preHandler: guardCrossSiteCardsRequest }, ...)`.
  Route attachment (rather than string-matching `request.url`) ensures query
  strings and encoded variants resolving to `/cards` are all protected.
