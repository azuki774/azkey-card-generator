# Front card layout

The front is rendered at 1200 × 760 pixels over
`assets/card-templates/default/front/base.png`. Coordinates below use the
top-left of each box; text is fitted against the supplied width before it is
rasterized by Sharp.

| Element | Box / position | Typography |
| --- | --- | --- |
| Title | x64, y40, w800, h64 | 48px bold |
| Placeholder mark | x960, y40, 176 × 176 | existing `front/icons/placeholder.svg` |
| Avatar | x64, y224, 320 × 320 | cover crop, 24px radius |
| Profile panel | x408, y200, 728 × 368 | white, 92% opacity, 24px radius |
| App role | x432, y224, w664, h48 | 32px; omitted when empty |
| Display name | x432, y336, w664, h72 | up to 48px bold |
| Handle | x432, y432, w664, h56 | up to 40px |
| User ID | right edge x1136, y688, w704, h32 | up to 24px, right aligned |

Names and handles shrink to 24px and then use a grapheme-safe ellipsis. User
IDs shrink to 16px; roles remain 32px and ellipsize. The renderer measures and
embeds the same Sharp/Pango text raster, so fitting and output use identical
glyphs. Avatar input
is optional and invalid data falls back to a local generated placeholder; no
network fetch is performed.

`appRole` describes this application’s role for the profile and is independent
of azkey roles. `PlaceholderProfileSource` supplies a fixed sample ID and the
local placeholder icon as its avatar, with no app role.

The rough visual reference is [front-place-idea.webp](front-place-idea.webp).
