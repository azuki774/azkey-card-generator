# Front card layout

The front is rendered at 1200 × 760 pixels over
`assets/card-templates/default/front/base.png`. Coordinates below use the
top-left of each box; text is fitted against the supplied width before it is
rasterized by Sharp.

| Element | Box / position | Typography |
| --- | --- | --- |
| Title | x64, y40, w800, h64 | `Azuki Internet / PROFILE CARD`, 48px down to 28px bold |
| Placeholder mark | x960, y40, 176 × 176 | existing `front/icons/placeholder.svg` |
| Avatar | x64, y224, 320 × 320 | cover crop, 24px radius |
| Profile panel | x408, y200, 728 × 368 | white, 92% opacity, 24px radius |
| App role | x432, y224, w664, h48 | 32px; omitted when empty |
| Display name | x432, y336, w664, h72 | up to 48px bold |
| Handle | x432, y432, w664, h56 | up to 40px |
| Issuance date (UTC) | right edge x1136, y656, w704 | `YYYY-MM-DD`, no label, fixed 16px, right aligned |
| Card UUID | right edge x1136, y696, w704 | no label, fixed 16px, right aligned |

Names and handles shrink to 24px and then use a grapheme-safe ellipsis. Both footer lines use fixed 16px text; roles remain 32px and ellipsize.
The footer shows the issuance timestamp above the card UUID, matching the back. The renderer measures and
embeds the same Sharp/Pango text raster, so fitting and output use identical
glyphs. Avatar input
is optional and invalid data falls back to a local generated placeholder; no
network fetch is performed.

`appRole` and `avatar` are optional render inputs. The account `userId` is no longer displayed; the footer uses the issuance timestamp and card UUID. `appRole` describes this
application’s role for the profile and is independent of azkey roles. The current
`MisskeyProfileSource` supplies the username, display name, note/following/follower counts, user ID, and
registration date from Misskey, and downloads the avatar for the renderer.
Missing or failed avatar downloads and invalid image data use the local generated
placeholder.

## Testing rationale

The fitting policy tests cover size selection, minimum-size ellipsis, whitespace
normalization, and grapheme boundaries with a deterministic width function.
Renderer tests cover the higher-risk avatar behavior: missing and corrupt inputs
share the fallback, and a non-square input is center-cropped without stretching.
The existing HTTP and render smoke tests cover PNG generation, literal Unicode
and markup-looking display names, and optional role fields. Issuance tests verify new UUIDs per card pair, matching
footers, timestamp changes, and independence from account IDs.

Visual layout, whitespace, typography, and rounded clipping remain manual review
items because those aesthetic details change frequently. The suite intentionally
does not use full pixel snapshots or a mutation test matrix.
