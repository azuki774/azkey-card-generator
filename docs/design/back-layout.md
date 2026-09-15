# Back card layout

The back is rendered at 1200 × 760 pixels over the shared front base image.
Both sides use the title `Azuki Internet / PROFILE CARD` and the same logo.
The back body stacks ノート数, フォロー数, フォロワー数, and 登録日 at x=108.
The account display name and @username appear on one line at x=108, y=160 above the statistics.
The display name is black and bold; the @username is purple (`#7654f5`) and bold.
The display name is fitted within 440px, then the @username uses the remaining width
after a 16px gap, so long identities do not overlap.
Labels start at y=240, 336, 432, 528; values at y=282, 378, 474, 570. Counts use comma
grouping; missing or invalid counts display `—`, while zero displays `0`.
The account registration date uses UTC `YYYY-MM-DD`; missing or invalid dates
display `—`. It is distinct from the issuance timestamp in the footer.

Both lower-right footers display the issuance date in UTC `YYYY-MM-DD` and
the card UUID without labels. Both lines use the same fixed 16px font size. Node.js `crypto.randomUUID()` generates a UUID v4
once per card pair. Reissuing a card generates a new UUID, including when the
profile and timestamp are identical. This identifier is independent of the
Misskey account ID and is not persisted on the server. A caller may supply a
UUID to the renderer for reproducible rendering in tests.

The renderer returns `cardId` alongside the two image buffers. The HTTP response
uses this same UUID in `front-azkcard-<uuid>.png` and `back-azkcard-<uuid>.png`.
The browser uses the existing `fileName` response field for downloads.
