# Changelog

## v13.3.13

- Snapshot release created and pushed to `release/v13.3.13`.
- Includes:
  - SNMP poller improvements: better OID expansion, error handling, and core Elenos OID handling.
  - SNMP trap manager: new trap receiver with privileged-bind fallback and varbind normalization.
  - Database schema tweaks: created `snmp_traps` table and added defaults for `display_label`, `display_order`, and `poll_interval` where applicable.
  - Fallback assets: automated SNMP walk template generation from `snmp_full_walk.txt` when live walks fail.
  - Misc: small client/server fixes for routing and asset handling.
- Tag: `v13.3.13`

## v13.2.0.0

- Cleanup: removed obsolete `server/snmp-poller.ts` to avoid confusion; consolidated on `server/services/snmp-poller.ts` which is used by `server/routes/snmp.ts`.
- No API surface changes; SNMP routes continue to use the same service.
- Represents the cleaned-up codebase after dev routing fixes in v13.1.1.7.

Tag: `v13.2.0.0`

## v13.1.1.7

- Dev routing stabilized for SPA: catch-all serves `index.html` only for HTML requests; non-HTML asset requests bypass the catch-all.
- Express dev server handles `HEAD /` health checks cleanly and avoids noise from Vite ping requests.
- Vite dev config updates:
  - Added explicit React alias/dedupe to prevent multiple React instances.
  - Included `react`, `react-dom`, and `@tanstack/react-query` in `optimizeDeps` for faster cold starts.
  - Relaxed `server.fs` restrictions in dev to allow client assets to resolve correctly.
- Verified pages `/map` and `/cards` load without errors; navigation uses `useLocation` correctly.
- Improved HMR stability and consistent asset routing during development.

Tags: `v13.3.13`, `v13.1.1.7`, `v13.2.0.0`