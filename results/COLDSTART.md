# Cold-start benchmark results

Measured with `node scripts/coldstart-bench.mjs` — real Chromium, a fresh browser context
per round (so IndexedDB is empty and the snapshot-restore path is never taken), the live
production seeder and the six production HTTP routers. `n=3` medians unless noted.

Run date: 2026-07-20. Site at `17577e8` + the instrumentation commit.

## Headline

| config | 6 communities | first community | cold pull to first tally |
|---|---|---|---|
| as shipped (`fetchLimit=6, joinLimit=8, waitSeeder=20s`) | **10.41 s** | 4.64 s | 2.30 s |
| `?fetchLimit=0` | 7.74 s | 2.47 s | 3.10 s |
| `?fetchLimit=0&waitSeeder=0` | 7.40 s | 2.25 s | 4.63 s |
| all limits off (**new default**) | **6.52 s** | 2.36 s | 3.82 s |

All 63 leader communities, limits off, n=1: **8.88 s** (63 distinct contests, 63 distinct
communities, 0 failures, last tally at 5.86 s). The 146.6 s previously recorded for that row
was not a throughput ceiling.

## Why the fetch cap was expensive

`main.ts` wrapped `libp2p.services.fetch` in `pLimit(6)` to smooth the 63-contest cold-pull
burst. But that service is **shared with pkc-js**, which uses it for
`directFetchIpnsRecordFromProviders` — and pkc-js creates its `AbortSignal.timeout(5000)`
*before* the call enters the queue. Measured queue wait was a median of 1.22 s (max 2.79 s)
against 0.40 s of actual wire time, so up to half the community-load timeout budget was
spent waiting in a queue meant for votes.

The evidence that votes were never the victim: **vote root fetches are 63/63 successful in
every configuration**, capped or not. Every observed `fetch-failed` ("signal is aborted
without reason") is a pkc-js IPNS fetch. Uncapped, pkc-js lands 63 successful IPNS fetches
per round; capped, only 35.

## What the caps did buy

Real, but smaller than what they cost. Uncapped, the 63 separate `<topic>/root` fetches
contend on one browser connection and the cold pull slows from 2.30 s to 3.82 s
(Σwire 30 s → 41 s). That is now the largest single segment of the remaining budget.

## Remaining headroom

1. **One aggregate root fetch instead of 63** (pubsub-voting + bitsocial-seeder). The seeder
   registers one fetch key per topic; a directory-level key returning all 63 root records
   would collapse the 3.8 s cold pull toward a single round-trip, and removes the contention
   the caps were introduced to manage — rather than rate-limiting it.
2. **Seed the cold start with the already-dialed seeder.** `keepSeederConnected` has the
   peer at ~1.2 s, but each contest independently re-runs `findProviders`. A
   `coldStartPeers` option on `PubsubVoter` would skip 63 router lookups.
3. **pkc-js community load is ~2.4 s** and close to its measured floor; not the place to
   spend effort next.

Floor if (1) and (2) land: `0.07 boot + 1.2 dial + ~1.0 pull + 2.4 community ≈ 4.7 s`.

## Reproducing

```bash
node scripts/coldstart-bench.mjs                                   # current defaults
ROUNDS=3 LABEL=x QUERY='fetchLimit=6&joinLimit=8&waitSeeder=20000' \
  node scripts/coldstart-bench.mjs                                 # the old shipped config
TARGET_COMMUNITIES=63 TIMEOUT_MS=200000 node scripts/coldstart-bench.mjs
```

Per-round JSONL (including the full phase timeline) via `APPEND_JSONL=results/coldstart.jsonl`.

## 2026-07-21 (later): the whole cold pull in one round trip — library `06ed65c`

Headroom item (1) landed as `bulk-root-fetch` commit `06ed65c` (on top of `1795cd5`'s bulk
key): the bulk answer now **inlines each record's checkpoint chunk blocks** (~300 B per
contest, hash-verified client-side, budget-capped), the one answer **fans out to every
contest it names** (not just the batch that asked), and a fresh answer is **cached 10 s**
so stragglers stop refetching it. Item (2) became unnecessary in its own right: the fan-out
means the FIRST returning router lookup serves all 63 contests, so the 63 lookups still fire
but only the fastest one gates anything.

A/B, n=8 per arm, sequential blocks ~2.5 h apart (seeder redeployed between arms —
`bak-preinline` is the rollback), site rebuilt per arm:

| median | ab3-bulk (1795cd5) | ab3-inline (06ed65c) |
|---|---|---|
| first peer connection | 1.30 s | 1.50 s |
| cold pull → first tally | 4.69 s | **3.01 s** |
| bulk root fetches | 3 | **1** |
| Σ fetch wire | 2.73 s | **0.67 s** |
| total → 6 communities | 7.65 s | **6.52 s** |

The phase streams are the real proof (per-round in `coldstart.jsonl`):

- **ab3-bulk**: 3 bulk fetches spread over ~2 s every round; per-contest tallies straggle
  0.6–1.9 s apart; one round hit the known 16 s first-connection stall (total 22.0 s).
- **ab3-inline**: exactly ONE bulk fetch every round; **all 63 tallies land within ~150 ms
  of each other** at bulk+0.65 s. Clean rounds have every vote tally done at **~3.1 s**
  (vs 5.5–6.2 s) — the votes side of the cold start is now a single discovery + a single
  round trip + verify.
- The remaining tail rounds (2/8 in each arm) are the PRE-EXISTING failure modes: a slow
  router draw delaying the first connection/pull, and community-load block stalls. Neither
  is on the new path.

**The bottleneck has moved.** With votes converged at ~3.1 s, the 63 community loads now
all fire at once and `communities 2..6` widened 0.51 s → 1.77 s (burst contention on the
shared fetch/bitswap path). Next levers are on the community side: the discovery-driven
pre-warm (dial the seeder's Kubo peer at boot instead of t+5 s) and pacing the
community-load burst.
