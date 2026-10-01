# Auth fixes live in `build/`, not `src/` — they will be erased by the next build

**Found:** 2026-09-08, while trying to pull a class roster for another project.
**Status:** resolved 2026-09-10 (see below). Originally recorded so it wasn't rediscovered from scratch.

## RESOLVED — 2026-09-10

`build/auth/browser-auth.js` had gone missing entirely (every other file in
`build/` was present — `.d.ts`, `.d.ts.map`, `.js.map` for this one included,
just not the `.js` itself). Something (most likely an interrupted
`npm run build` — the leftover `~`-prefixed dirs from the same period in the
2026-09-05 dependency-update notes point at tsc getting killed mid-run) left
this one compiled file absent, which is what actually broke the MCP server:
`main` is `build/index.js`, which imports this file.

Checked whether the drift described above was still live: compared
`src/auth/browser-auth.ts` at HEAD against a saved copy of the hand-patched
`build/auth/browser-auth.js` Matt had kept from before. They are functionally
identical — same WSL/Docker detection, same cookie-first token strategy with
CSRF handling, same retry/lock-file logic, same storage-state persistence.
Only differences were TypeScript type erasure and tsc's own formatting. **The
fix was never actually lost from `src/` — it's committed and intact.** The
only casualty was this one missing compiled file.

Fix applied: restored the saved compiled file to `build/auth/browser-auth.js`
directly (`node --check` confirms valid JS, 26411 bytes, matches the original
find). `build/` is already gitignored (guard #1 from below was already in
place), so no commit was needed or made.

Not yet done: running `npm run build` fresh to confirm a normal build now
reproduces the same output byte-for-byte (should — src matches), and
`npm run auth` to refresh the session token (MCP tool calls were returning
"Authentication expired" independent of this issue).

The `prebuild` staleness-check guard suggested below is still worth adding.

---

## Summary

The browser auth flow has been modified directly in the **compiled output**
rather than in TypeScript source. The changes are therefore:

- not in `src/`, so they are not part of the build input
- not in git (only `src/` is meaningfully tracked for this purpose)
- **destroyed by the next `npm run build`**

## Evidence

```
build/auth/browser-auth.js   modified 2026-09-05 20:59   (26411 bytes)
src/auth/browser-auth.ts     modified 2026-03-06 15:09   (25113 bytes)
```

Compiled output six months newer than the source it is nominally compiled
from, and ~1.3 KB larger. A normal build cannot produce that ordering.

The runtime stack trace also confirms the patched file is what actually
executes:

```
file:///C:/.../brightspace-mcp-server/build/auth/browser-auth.js:263
BrowserAuthError: [PBMCP-1001] [PBMCP-1003] Browser auth failed at step
  "token_interception": Token interception timed out after 120 seconds
```

## Current failure mode

Authentication itself succeeds — SSO completes, Duo MFA is approved, and the
session reaches the Brightspace home page. It then fails at
**`token_interception`**, timing out after 120s while trying to capture an API
token from the authenticated session.

Contributing warnings observed in the same run:

```
[WARN] d2l_rf cookie still missing - POST requests may fail
[WARN] Existing session missing CSRF token (d2l_rf), forcing re-login
[WARN] localStorage Bearer token failed validation, trying next strategy
[WARN] Could not extract valid token from existing session, forcing re-login
```

So the restored session is treated as unusable (no `d2l_rf` CSRF cookie, no
valid Bearer token in localStorage), a full re-login is forced, that re-login
succeeds, and token interception still never fires. That points at the
interception hook not matching whatever request/response actually carries the
token now — a likely upstream change in how D2L issues it.

## Not a problem: the "Rohan Muppa" attribution

Worth recording, because it reads alarming and prompted a "am I even in the
right repo" moment:

```
origin    https://github.com/redmondmj/brightspace-mcp-server.git
upstream  https://github.com/RohanMuppa/brightspace-mcp-server
```

This is a fork. Copyright headers and the `BrightspaceMCP/1.0 (Rohan Muppa; ...)`
user-agent string are expected upstream attribution, not evidence of a wrong
checkout.

## What needs doing

1. **Recover the deltas before they're lost.** Copy `build/auth/browser-auth.js`
   somewhere safe *now*, outside the repo. It is the only record of the fixes.
2. Compile the current source to a scratch directory and diff it against the
   saved file, to isolate exactly what was hand-patched:
   ```bash
   npx tsc --outDir /tmp/build-clean
   diff /tmp/build-clean/auth/browser-auth.js build/auth/browser-auth.js
   ```
3. Port each delta into `src/auth/browser-auth.ts`, rebuild, and confirm the
   built output still behaves the same.
4. Commit the TypeScript change so it survives.
5. Separately, fix `token_interception` — this is a real outstanding bug, not
   just drift. Compare against upstream to see whether it has already been
   addressed there.

## Guard against a repeat

Nothing currently stops `build/` being edited by hand. Options, cheapest first:

- Add `build/` to `.gitignore` and generate it only via `npm run build`, so a
  hand edit is obviously ephemeral rather than looking authoritative.
- Add a `prebuild` script that fails if any file in `build/` is newer than the
  newest file in `src/`.

## Unrelated, noticed in passing

Uncommitted work in the tree at time of writing:

```
 M src/tools/manage-content.ts
 M src/tools/schemas.ts
?? tests/tools/
?? proxmox_mcp.log
```

`proxmox_mcp.log` is a stray log from a different MCP server writing into this
directory — worth a `*.log` gitignore entry.
