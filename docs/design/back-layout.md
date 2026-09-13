# Back card layout

The back is rendered at 1200 × 760 pixels over the shared front base image.
The title and logo occupy the same top positions as the front. Note count and
registration date are stacked on the left at approximately y=290 and y=454.
The handle and optional user ID are stacked and right-aligned near the lower
edge using the front card's fitting policy.

Note counts use comma grouping. Registration timestamps from Misskey are
converted to UTC `YYYY-MM-DD`; missing or invalid timestamps display `—`.
Handles and IDs shrink and receive a grapheme-safe ellipsis when they exceed
their allotted width.
