# BSO board vote — pubsub voting on a real website

**Live site: <https://bso-board-vote.netlify.app>**

A static website where people vote over libp2p **pubsub** — no server counts the votes.
Voting is gated by an ERC-20 balance: **any wallet holding ≥ 1 BSO
([`0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A`](https://etherscan.io/token/0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A)
on Ethereum mainnet) gets exactly one vote** (constant weight, not balance-weighted).
Voters pick an existing board from the live tally or submit a new board (a `12D3KooW…`
public key, optionally a verified `.bso` name).

Built on [`@bitsocial/pubsub-voting`](https://github.com/bitsocialnet/pubsub-voting):
votes are EIP-712 ballots signed by the token-holding wallet, gossiped on a topic derived
from the contest rules, validated by every peer (signature + on-chain balance at a
bucketed block) **before** re-forwarding, and merged with a last-write-wins CRDT.

Contest topic: `bitsocial-votes/bafyreih4kfwpmojl2sxrinfimzm7ardh7tfnccgwhulil63ybopugfh2d4`

## Architecture

```
Netlify (static HTML/JS)                     new-plebbit (89.36.231.48)
┌──────────────────────────┐                ┌────────────────────────────────┐
│ browser voter            │   WSS          │ seeder: Node.js Helia node     │
│  - in-page Helia/libp2p ─┼───────────────▶│  - AutoTLS cert (libp2p.direct)│
│  - MetaMask signs ballot │  (AutoTLS)     │  - joins the contest topic     │
│  - renders live tally    │                │  - validates + forwards votes  │
└──────────────────────────┘                │  - serves checkpoint to        │
        ▲    ▲                              │    cold-joining browsers       │
        │    └── other browsers, meshed     └────────────────────────────────┘
        │        through the seeder
        └── Ethereum mainnet RPC (balanceOf reads)
```

Browsers can't accept inbound connections, so they all dial the seeder's WSS address
(pinned in [src/config.ts](src/config.ts)) and the gossipsub mesh forms through it. The
seeder never votes (read-only, no signer) and can't forge or drop votes without honest
peers noticing — validation is done by every participant.

## How a vote works

1. The visitor connects an injected wallet (MetaMask etc.). Connecting is what gives the
   vote an identity — no transaction, no gas, just an EIP-712 signature popup per vote.
2. The library builds the ballot (chosen board, current block bucket, the contest's
   criteria CID) and the wallet signs it.
3. The signed bundle is gossiped on the topic. Every receiving peer recovers the signer
   address from the signature and reads `balanceOf(signer)` at the bucket's sampled
   mainnet block; bundles that don't hold ≥ 1 BSO are dropped and never forwarded.
4. One wallet, one vote: a newer ballot from the same wallet replaces the older one
   (last-write-wins), and an empty ballot withdraws.
5. Votes expire after ~30 days (`voteExpiryBuckets`); voters keep a vote alive by simply
   voting again (the site shows the expiry estimate).

## Repo layout

```
shared/    criteria document (defines the contest AND the topic), vendored
           erc20-balance rule, viem chain factory, .bso name resolvers
src/       the website: in-browser Helia/libp2p node, injected-wallet signer, UI
seeder/    the always-on node: AutoTLS/WSS seeder script + systemd unit
scripts/   derive-topic.ts — validate criteria + print the topic (npm run topic)
```

## Operations

### Redeploy the website

```bash
npm install
npm run build
npx netlify-cli deploy --prod --dir dist --no-build   # site: bso-board-vote
```

### The seeder (new-plebbit)

Runs as systemd unit `pubsub-voting-seeder` from `/root/pubsub-voting-website`
(see [seeder/pubsub-voting-seeder.service](seeder/pubsub-voting-seeder.service)).

```bash
ssh new-plebbit
journalctl -fu pubsub-voting-seeder          # watch tally updates / cert renewals
tail -f /root/pubsub-voting-website/seeder-data/seeder.log   # same lines, plain file
systemctl restart pubsub-voting-seeder       # after code changes: recompile first:
cd /root/pubsub-voting-website && ./node_modules/.bin/tsc -p tsconfig.seeder.json
```

The seeder logs connection open/close, contest-topic subscribe/unsubscribe, gossip
messages on the topic, checkpoint (root record) fetch serves, and tally updates — to
stdout (journald) and to `seeder-data/seeder.log` (rotated once at 10 MB).

Do **not** delete `seeder-data/peer.key`: the peer id determines the
`….libp2p.direct` hostname and the multiaddr baked into `src/config.ts`.

**Vote state is memory-only on the seeder.** The CRDT lives in the process (the
`seeder-data/voting` dir only holds LRU caches), so a restart empties the tally until
an online browser peer re-advertises its checkpoint (root-record heartbeat, ≤ ~12.5
min) and the seeder chases it back. Restarting while **no** voter tab is open loses
the votes permanently.

### Diagnosing "I don't see votes"

`scripts/cold-join-test.ts` acts as a brand-new voter against the production seeder
and reports how long the tally takes to converge:

```bash
npx tsc -p tsconfig.coldtest.json
WAIT_SUBS=1 node dist-seeder/scripts/cold-join-test.js   # healthy: converges in ~5 s
node dist-seeder/scripts/cold-join-test.js               # joins as soon as connected
```

Background: through pubsub-voting 0.0.8 the cold-join pull for past votes ran **once**,
at topic join, and only asked peers already visible in `getSubscribers(topic)`. A join
that raced the seeder's subscription exchange synced nothing and waited ~10 minutes
(jittered heartbeat) for the next chance — which looked like "votes are missing" in a
fresh tab. Fixed upstream in 0.0.10 (pubsub-voting #15): the cold-start pull re-arms on
gossipsub `subscription-change` for the first heartbeat interval after join, so this
site uses the library as-is with no join-ordering workaround.

### Changing the contest rules

Anything in [shared/criteria.ts](shared/criteria.ts) (contract, threshold, RPCs,
expiry, `contestId`) changes the criteria bytes and therefore **forks the topic** —
old votes don't carry over. Redeploy the site and restart the seeder together.

## Local development

```bash
npm install
npm run topic                  # validate criteria + print the topic
AUTO_TLS=off npm run seeder    # local seeder: plain ws on 127.0.0.1:4003, no cert
# paste its /ip4/127.0.0.1/tcp/4003/ws/p2p/… addr into src/config.ts, then:
npm run dev                    # plain ws works from http://localhost
```

Casting a vote end-to-end needs a wallet with ≥ 1 BSO on mainnet (the balance check is
real even locally). The tally, connectivity, and read-only sync all work without one.

## Notable implementation choices & gotchas

- **`erc20-balance` rule is vendored** ([shared/erc20-balance-rule.ts](shared/erc20-balance-rule.ts)).
  The library ships it in its tree but deliberately unregistered (token-*weighted* voting
  is deferred upstream). We use it only as the eligibility **gate** with a `constant`
  weight, registered via `PubsubVoter({ rules })` on both the site and the seeder.
  Stock clients that don't register it recuse themselves (`UnknownRuleError`) instead of
  miscounting — that's by design.
- **AutoTLS needs a plain `/ws` listen.** An explicit `/tls/ws` listen creates a
  certificate-less https server that the certificate-provision event refuses to replace,
  and every TLS handshake then fails with alert 40. Listen on `/ws`; the listener
  upgrades itself in place when the cert arrives.
- **Behind provider NAT, set `PUBLIC_IP`.** new-plebbit's interfaces only carry private
  addresses, so AutoNAT alone never confirms the public address and AutoTLS never
  triggers. `PUBLIC_IP=…` (see the systemd unit) announces it explicitly; the cert
  provisioned seconds after.
- **systemd + nvm**: `npm` isn't on systemd's PATH — the unit runs the precompiled
  `dist-seeder/seeder/seeder.js` with the absolute node binary.
- **RPCs are consensus-critical**: the RPC URLs live inside the criteria document, which
  derives the topic. They must be CORS-enabled (browsers call them directly) and
  archive-capable (verifiers read balances at up to 30-day-old blocks).
- **Board names are dangerous**: a vote carrying a `.bso` name is dropped by peers unless
  the name resolves on-chain to the claimed public key. The UI warns accordingly; plain
  public-key votes are always safe.
- **Republishing is the client's job** (upstream design): the site stores your vote in
  `localStorage` and shows the expiry; re-voting refreshes it. The seeder cannot do it
  for you — it doesn't hold your key.

## License

GPL-3.0-or-later (the vendored rule comes from `@bitsocial/pubsub-voting`, GPL-3.0-or-later).
