# Steady-state CPU + memory benchmark results

**What this measures:** what an open tab costs once the page is already usable — the cost a
user actually lives with, as opposed to [COLDSTART.md](./COLDSTART.md), which measures how long
they wait to get there. The two are reported separately because they have different causes:
cold is boot + 63 joins + the root-fetch burst; steady is whatever the page never stops doing.

Measured with `node scripts/cpu-bench.mjs` — real Chromium, a fresh profile per round (empty
IndexedDB, so the snapshot-restore path is never taken), the live production seeder and the six
production HTTP routers. CPU is `utime+stime` of the **whole Chromium process tree** read from
`/proc` (renderer, network service, GPU, workers) — the number the laptop fan responds to — with
CDP `Performance.getMetrics` alongside it to separate renderer main-thread work from the rest.

Run date: 2026-09-03. Site at `82c44d1`, 63 contests + 64 leader communities, headless.

## Headline — the pkc-js 1s-poll fix

60 s cold start + a 300 s steady window, `n=1` for the long window, `n=3` for the 120 s window.

| pkc-js | steady CPU | renderer task time / 5 min | peak RSS | end RSS | instrumentation churn |
|---|---|---|---|---|---|
| 0.0.92 | 24.1% of a core | 43.6 s | 1383 MiB | 1325 MiB | 131 events/s |
| 0.0.93 | ~22% of a core | same rate | 1290 MiB | — | 128 events/s |
| **0.0.94** | **8.5% of a core** | **10.3 s** | **1249 MiB** | **1079 MiB** | **7.6 events/s** |

Three shorter rounds (60 s cold + 120 s steady) agree: 0.0.92 averaged **23.7%** of a core
(22.1, 20.7, 28.3), 0.0.94 averaged **10.4%** (9.6, 8.4, 13.2).

Cold-start behaviour is unchanged in every configuration and every round: 64 communities loaded,
64/64 joins succeeded, 64 first-tallies. This bump costs nothing on the cold path — it is
**−46%** there too (20.5 → 11.2 CPU-s over 60 s), because the poll starts as soon as the first
community subscribes and so was already burning during cold start.

## What the CPU was

`updatingstatechange` churn, and nothing else of note. Each of the 63 subscribed communities
emitted **exactly 2 transitions per second** — `waiting-retry` ↔ `fetching-ipns` — forever,
because pkc-js's community update loop polled on a 1 s timer rather than waiting for a record.
63 × 2 ≈ the 128–131 events/s measured. It is unbounded in the sense that matters: it does not
decay, it scales with the number of subscribed contests, and none of it is real work.

pkc-js 0.0.94 (`perf(community): drive kubo/helia updates from gossip pushes instead of a 1s
poll`, pkcprotocol/pkc-js#311, issues #308/#307) parks the loop on a pushed IPNS record arrival
plus a jittered safety-net timeout. Churn drops to ~8 events/s, which is genuine traffic.

## pkc-js 0.0.95 — the IPNS fetch traffic

Run date: 2026-09-03, site at `77d55c8` with the libp2p-fetch traffic panel, so the fetch
column below is counted by the page itself (`window.__fetchStats()`, read at the cold/steady
boundary and again at the end — cold-start fetches are excluded).

60 s cold + a steady window, all rounds headless against the live seeder and routers.

| pkc-js | fetch calls/min (steady) | aborted share | steady CPU | peak RSS | end RSS |
|---|---|---|---|---|---|
| 0.0.94 | **117.3** (118, 116.7) | ~45% | 8.6% of a core (8.6, 8.6) | 1243 MiB | 1095-1101 MiB |
| **0.0.95** | **0** (0, 0, 0 — and one 64/min round, see below) | **0%** | **5.9%** of a core (5.8, 5.7, 4.7, 7.2) | 1248 MiB | 1040-1097 MiB |

n=2 at a 180 s window per version, plus n=2 more at 300 s on 0.0.95.

**Fetch traffic goes to zero, not just down.** pkc-js 0.0.95
(`perf(helia): serve subscribed IPNS names from cache while the push channel is healthy`,
pkcprotocol/pkc-js#331, issue #330) adds a push-channel watchdog: a name whose gossipsub topic
has subscribers and has delivered a signature-valid record inside the watchdog window (15 min)
is served from the cached record past its ttl, and the community update loop's safety-net tick
stops forcing `nocache: true` while the channel is healthy. Three of the four 0.0.95 rounds
made **no fetch calls at all** in the steady window; the fourth made 192 over 180 s (64/min,
exactly one per community per minute) because the watchdog had not yet seen a gossip arrival
for every name when the window opened. Both 300 s rounds were zero, so zero is the steady
state and 64/min is the warm-up.

**The aborts disappear with it.** On 0.0.94, ~45% of every call ended in `AbortError`:
`directFetchIpnsRecordFromProviders` fans out to every subscriber and every discovered provider
and aborts the losers on the first valid record (and asks a peer that is both twice —
pkcprotocol/pkc-js#329). On 0.0.95 the healthy path never starts a race, so the noise is gone
rather than merely reduced; the duplicate-peer bug is still there for the unhealthy path.

**CPU falls a third** (8.6% → 5.9% of a core) and **memory does not move** — peak RSS is flat
within noise (1243 vs 1248 MiB) and the JS heap stays in its usual 62-84 MiB band. The win is
network work, not allocation. Cold start is unaffected in every round: 64 communities loaded,
64/64 joins, 64 first-tallies.

Remaining steady cost after this bump is `community-state` and `ipns` instrumentation events at
~5.5-5.8/s, which is gossip delivery — real traffic, not polling.

## Reading the numbers

- **steady CPU %** is of *one* core, averaged over the window. 24% means a quarter of a core
  continuously, which on a laptop is comfortably enough to spin the fan up and keep it there.
- **renderer task time** is main-thread only. It fell 76% (43.6 s → 10.3 s per 5 min) — a
  larger drop than total CPU (65%), which is the expected shape: the poll was main-thread JS,
  while the remaining cost is spread across network and worker threads.
- **RSS is the whole 8-process Chromium tree**, not the page. ~1.1 GB is not all this site;
  treat the *delta* as the signal, not the absolute. JS heap sits at ~65–90 MiB either way and
  is not where the win is.
- **fetch calls/min** counts only the steady window, from the page's own per-peer accounting.
  A warm-up round can differ from the steady state by the whole effect (0 vs 64/min above), so
  prefer a 300 s window when the number being measured is a cache that has to fill first.
- **Run-to-run variance is real** (the 0.0.92 rounds spanned 20.7–28.3%), because the live
  seeder and routers are in the loop. Prefer `ROUNDS=3` and compare means; a single round is
  only worth trusting when the effect is as large as this one.

## Running it

```bash
node scripts/cpu-bench.mjs                                   # 3 rounds, 60s cold + 120s steady
ROUNDS=1 WINDOW_MS=300000 LABEL=pkc-0.0.94 node scripts/cpu-bench.mjs
SKIP_BUILD=1 QUERY='prewarm=0' LABEL=no-prewarm node scripts/cpu-bench.mjs
```

Every query-string knob `main.ts` reads is settable via `QUERY`, so A/B-ing a site option is the
same one-liner as A/B-ing a dependency. `OUT=results/cpu.json` writes the full per-sample series.
