# v2026.08.11-01-rc.6

- Date: 2026-08-11
- Status: release candidate

## Changes

- Retry a missing BuildingHUB title match twice at short intervals before storing a long-term pending state.
- Treat public-data API request-limit result code 22 as a temporary failure.
- Keep browser polling alive across temporary Cloudflare 5xx, rate-limit, and network failures.
- Preserve completed BuildingHUB pages in D1 so automatic retries resume from the failed page.
