# v2026.08.11-01-rc.5

- Date: 2026-08-11
- Status: release candidate

## Changes

- Treat Cloudflare upstream HTTP 520-524 and 530 responses as temporary failures.
- Pause and automatically retry BuildingHUB collection instead of storing HTTP 522 as a permanent failure.
- Reduce the per-request BuildingHUB page batch from 8 pages to 3 pages.
- Reduce the upstream page timeout to 12 seconds so the UI can report retry state sooner.
- Keep all BuildingHUB page calls sequential and preserve completed D1 progress.
