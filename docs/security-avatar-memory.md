# Avatar memory bound (finding 3)

## Problem

`MisskeyClient.getAvatar()` previously allowed **25M input pixels** and
verified downloads with `image.raw().toBuffer()`. That retains a
full-resolution RGBA buffer (~100MB at 25M pixels) and then the card
renderer decodes the original file a second time for the 320x320 cover
crop. A small compressed file (solid-color PNG, large JPEG) can therefore
exhaust Node heap / native memory even though the 5MB compressed download
cap passes.

## Fix (this branch)

`src/misskey-client.ts` now:

- Lowers `MAX_INPUT_PIXELS` to **4,000,000** and exports it with
  `AVATAR_SIZE_PX = 320` and `AVATAR_PROCESS_TIMEOUT_SECONDS = 5`.
- **Rationale for 4M:** the rendered avatar slot is exactly 320x320px
  (102,400 pixels). 4M pixels is ~39x the output area, leaving ample
  headroom for cover-crop quality, while reducing 8-bit RGBA pixel data to
  ~16MB (4M x 4 bytes) instead of ~100MB (25M x 4 bytes).
- Keeps the **5MB compressed download cap**, strict allowlisted avatar
  origins, `redirect: 'manual'`, and real format-vs-MIME matching
  (`metadata.format` must equal the declared `image/png|jpeg|webp|gif`,
  so SVG-as-PNG is rejected).
- Decodes with `sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })`:
  `limitInputPixels` rejects oversized dimensions at the `metadata()`
  stage (before full decode); `pages: 1` decodes only the **first frame**
  of animated GIF/WebP rather than producing full-resolution output for every
  frame. Parsing the animation container still has a cost. Channels are left
  as decoded (RGB/RGBA); PNG output preserves alpha where present.
- Re-checks `width * height > MAX_INPUT_PIXELS` explicitly
  (belt-and-suspenders if decoder metadata reporting changes).
- Normalizes to a bounded **320x320 PNG** (`resize(cover, centre).png()`)
  with a best-effort `.timeout({ seconds: 5 })` and returns
  `{ contentType: 'image/png', data: normalized }`. No full-resolution
  `raw()` buffer is retained or passed downstream.
- Center-cover semantics and the renderer corrupt-image fallback are
  unchanged: the renderer still accepts the normalized PNG, the built-in
  SVG fallback, and direct small test buffers.

Unchanged on purpose: rate limiting (finding 1) and cross-site response
request protection (finding 2) are separate PRs; text fitting (finding 4) is
untouched.

## Residual risk: resizing does not eliminate decoder working memory

Bounding output size does **not** bound decoder working memory to the
output size. libvips/sharp must still parse headers, allocate codec
state, and decode input rows up to the pixel limit (plus pipeline
buffers, EXIF/ICC handling, bit-depth conversion, and per-format codec
overhead). The 16MB calculation is only for 8-bit RGBA pixels, not an RSS
limit or a measured peak. Concurrent requests increase aggregate usage.
The Sharp timeout is not a hard deadline covering metadata parsing, all
native work, or queue time. Always apply process/container resource limits.

## Container resource limits (runnable example)

The repo does not build deployment infrastructure here; apply limits at
the runtime boundary. Example for a single-instance card service:

```bash
docker run -d --name azkey-cards \
  --cpus 1.0 \
  --memory 512m --memory-swap 512m \
  --pids-limit 128 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -e NODE_OPTIONS="--max-old-space-size=384" \
  -p 127.0.0.1:3000:3000 \
  azkey-card-generator
```

This example assumes a TLS reverse proxy on the same host. With a separate
proxy, use a private container network and restrict ingress to the proxy;
do not expose a bypass around its access/rate controls. These are starting
values, not a load-tested capacity guarantee. Tune with representative load:

- `--memory/--memory-swap`: caps Node heap + sharp/libvips native RSS
  together; set swap equal to memory to disable swap.
- `--cpus`: bounds concurrent libvips thread-pool throughput; sharp also
  honors `sharp.concurrency(n)` / `sharp.cache(false)` in-process if you
  need a smaller native cache.
- `--pids-limit`: bounds process/thread growth; validate the chosen cap with
  the deployment CPU count and native worker settings.
- `--read-only` + `/tmp` tmpfs: least privilege; the app only needs
  ephemeral temp space.

Kubernetes equivalent (per container):

```yaml
resources:
  requests: { cpu: "250m", memory: "256Mi" }
  limits: { cpu: "1000m", memory: "512Mi" }
```

## Verification

```bash
npm ci
npm test        # includes tests/security-avatar-memory.test.ts
npm run build
```

`tests/security-avatar-memory.test.ts` covers: PNG/JPEG/WebP/GIF
normalization to 320x320 PNG, a two-frame GIF retaining only its first frame,
oversized-dimension rejection with a small
compressed solid-color fixture (kilobytes on the wire, rejected as
`avatar_rejected` at the metadata stage), the exact 4M boundary
(2000x2000 accepted / 2001x2000 rejected), SVG disguise / MIME mismatch /
truncation, center-cover preservation, and normalized/corrupt end-to-end
rendering through the unchanged renderer fallback. Fixtures are kept
small (<= ~2048px per side, solid colors) so tests do not load huge
buffers.
