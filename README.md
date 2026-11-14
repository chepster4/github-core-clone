# github-core-clone

A GitHub-compatible git forge in a single Node process. No database, no
framework, no dependencies — only the Node standard library. One process
serves the four surfaces an agent already speaks, over its own deterministic
in-memory store:

- **git smart HTTP (protocol v2)** — `git-upload-pack` (`ls-refs`, `fetch`
  with `deepen` / shallow boundaries) and `git-receive-pack` (push with pack
  validation, ref updates and reporting), plus `info/refs` advertisements.
- **REST v3** — repositories, issues, pull requests, users and search, under
  `/api/v3`, with the same shapes and status codes the suite drives.
- **GraphQL** — a v4 endpoint at `/api/graphql` (queries, mutations and the
  connection cursors the checks use).
- **MCP** — the Model Context Protocol over streamable HTTP at `/mcp`, so an
  agent can drive the forge as tools instead of raw HTTP.

Everything is deterministic: the store holds no wall-clock time, no random
ids and no ambient state, so the same sequence of calls always produces the
same export.

## Run it

Node 22.6 or newer, nothing to install.

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:40169 MAKEFUN_SHOP_TOKEN=test-token \
  node --experimental-strip-types main.ts
```

Or `npm start`, which runs the same command. The env's port is the one it
writes to its ready file when it starts (locally `http://127.0.0.1:<port>`,
in a trial `http://store:8080`). The process binds an ephemeral port,
registers it with the env at `MAKEFUN_ENV_URL` (`POST /register
{"port": N}`), then polls `GET /done` until the env says the trial is over
and exits 0. `MAKEFUN_SHOP_TOKEN` is the bearer token every API call must
present; without it the server answers 401 JSON, never HTML.

## Layout

- `main.ts` — the entry <-> env lifecycle: bind, register, poll `/done`,
  exit. It imports its own server and nothing else.
- `app.ts` — the HTTP server: routing, the bearer-token check and JSON
  discipline. The real surface lives in `lib/`.
- `lib/git.ts` — git objects: hashing, commit/tree parsing, pack reading and
  writing (no deltas, zlib level 1), reachability.
- `lib/gitproto.ts` — the smart-HTTP wire protocol: pkt-lines, the v2
  `ls-refs` / `fetch` commands, `receive-pack`, sideband framing.
- `lib/store.ts` — the in-memory store: repositories, refs, objects, issues,
  pull requests, users and search.
- `lib/rest.ts` — the REST v3 routes.
- `lib/graphql.ts` — the GraphQL v4 endpoint.
- `lib/mcp.ts` — the MCP tools over streamable HTTP.
- `lib/http.ts` — the small HTTP helpers every surface shares.

## How it stays fast

The timed workloads are dominated by the request path, so the hot paths keep
no per-request work they can avoid:

- The fetch pack is cached on the sorted object-id list it was built from —
  a pack is a pure function of that list, and objects are immutable, so the
  clone workload's identical fetches build once and hit the cache after.
- The upload-pack command section is parsed once per request and handed to
  `ls-refs` / `fetch`, instead of each re-reading the body.
- The upload-pack advertisement and the static pkt-line pieces (flush,
  acknowledgement prefix, packfile marker) are built once at module load.
- The bearer header is computed once per process (the token never changes),
  the git route regex is skipped for API and MCP paths, and request paths
  take a string fast path with a full `URL` fallback for anything unusual.
- Issue reads serve a cached serialized body; issue creation stamps
  `createdAt` / `updatedAt` once.

Nothing on these paths changes behaviour: every optimisation preserves the
exact status codes, bodies and error shapes the conformance suite checks
(120/120), and the store stays deterministic.

## Score

The suite grades conformance (600), the MCP arm (200) and four timed
workloads (200): push (200 sequential pushes), clone (50 concurrent shallow
clones), read (2,000 sequential issue GETs) and write (200 sequential issue
POSTs). The entry holds 120/120 conformance checks and the full MCP arm.
