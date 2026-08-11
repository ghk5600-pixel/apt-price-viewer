# v2026.08.11-01

- Date: 2026-08-11
- Status: production release

## Changes

- Add ordered watchlists with synchronized drag-and-drop ordering and numbered Kakao map markers.
- Limit each watchlist to 20 apartment complexes.
- Calculate supply-area price per pyeong from BuildingHUB ledger data.
- Cache completed supply-area profiles in Cloudflare D1 for reuse by all visitors.
- Resume partial BuildingHUB collection and retry transient API or Cloudflare failures automatically.
- Keep permit APIs as address discovery and failed-match fallback sources.
- Exclude officetels and lodging facilities while retaining apartments in mixed-use buildings.
- Remove the repeated `단지 가중` helper text from completed comparison rows.
