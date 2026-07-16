import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";

/**
 * Decode-only diagnostics for the pubsub-voting wire shapes: the gossip message envelope
 * (root heartbeat | live vote bundle), the fetch-protocol root record served to cold
 * joiners, and the checkpoint chunk blocks holding the actual signed bundles. Shared by
 * the on-page log/bundle panel and the seeder log so both sides describe the same bytes
 * the same way — "82 bytes" alone can't distinguish "the contest is empty" from "the
 * checkpoint didn't load" (the 2026-07-16 empty-boards investigation); `count` can.
 *
 * pubsub-voting doesn't export its wire codecs, but every layout is canonical dag-cbor
 * pinned by fixed upstream test vectors (any change there is a breaking wire change), so
 * decoding them here is safe. Best-effort by design: garbage in, a fallback out — never
 * a throw on the logging path.
 */

/** The fetch-protocol root record; the gossip heartbeat carries the same fields minus `chunks`. */
export interface ParsedRootRecord {
    version: number;
    root: CID;
    count: number;
    sizeBytes: number;
    chunks?: CID[];
}

/** A bundle's binary wire shape (crdt codec) — as inlined in chunk blocks and live-delta messages. */
interface WireBundle {
    address: Uint8Array;
    blockNumber: number;
    signature: { signature: Uint8Array; type: string };
    votes: { community: { name?: string; publicKey: Uint8Array }; vote: number }[];
}

const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** The full root CID on purpose: comparing roots across peers is what settles divergence questions. */
const describeRecord = (r: ParsedRootRecord) => `${r.count} vote bundle(s), checkpoint ${r.sizeBytes} B, root ${r.root}`;

/** Parse fetched root-record bytes; undefined on garbage. */
export function parseRootRecord(bytes: Uint8Array): ParsedRootRecord | undefined {
    try {
        const record = dagCbor.decode<ParsedRootRecord>(bytes);
        return typeof record?.count === "number" ? record : undefined;
    } catch {
        return undefined;
    }
}

/** Describe fetched root-record bytes (the `<topic>/root` fetch-protocol response). */
export function describeRootRecord(bytes: Uint8Array): string {
    const record = parseRootRecord(bytes);
    return record ? describeRecord(record) : "undecodable root record";
}

/**
 * A bundle block's CID, matching the library's `bundleCid`: CIDv1, dag-cbor, sha2-256 over
 * the standalone block bytes — the verdict-cache key and the identity a checkpoint carries.
 */
export async function bundleCidForBytes(bytes: Uint8Array): Promise<string> {
    return CID.createV1(dagCbor.code, await sha256.digest(bytes)).toString();
}

/** Map a wire bundle to display JSON: address/signature bytes → hex, publicKey multihash → B58 key. */
function wireBundleToDisplay(wire: WireBundle) {
    return {
        address: hex(wire.address),
        blockNumber: wire.blockNumber,
        signature: { type: wire.signature.type, signature: hex(wire.signature.signature) },
        votes: wire.votes.map((vote) => ({
            community: {
                ...(vote.community.name !== undefined ? { name: vote.community.name } : {}),
                publicKey: base58btc.encode(vote.community.publicKey).slice(1)
            },
            vote: vote.vote
        }))
    };
}

/** One downloaded bundle, ready to render: its content address plus the decoded document. */
export interface DownloadedBundle {
    cid: string;
    bundle: unknown;
}

/**
 * Decode a checkpoint chunk block (an array of inlined wire bundles) into displayable
 * bundles. Each bundle's CID is re-derived by re-encoding its wire object — dag-cbor is
 * canonical, so decode→encode reproduces the standalone block bytes the library hashes.
 */
export async function decodeChunkBundles(chunkBytes: Uint8Array): Promise<DownloadedBundle[]> {
    const wires = dagCbor.decode<WireBundle[]>(chunkBytes);
    if (!Array.isArray(wires)) return [];
    return Promise.all(
        wires.map(async (wire) => ({
            cid: await bundleCidForBytes(dagCbor.encode(wire)),
            bundle: wireBundleToDisplay(wire)
        }))
    );
}

/** Extract the bundle from a live-delta gossip message; undefined for heartbeats/garbage. */
export async function extractLiveBundle(messageBytes: Uint8Array): Promise<DownloadedBundle | undefined> {
    try {
        const message = dagCbor.decode<{ kind?: string; bundle?: Uint8Array }>(messageBytes);
        if (message.kind !== "bundle" || !(message.bundle instanceof Uint8Array)) return undefined;
        return {
            cid: await bundleCidForBytes(message.bundle),
            bundle: wireBundleToDisplay(dagCbor.decode<WireBundle>(message.bundle))
        };
    } catch {
        return undefined;
    }
}

/** Describe one gossip message on the contest topic (async: a bundle's CID is a hash away). */
export async function describeGossipMessage(bytes: Uint8Array): Promise<string> {
    try {
        const message = dagCbor.decode<{ kind?: string; record?: ParsedRootRecord; bundle?: Uint8Array }>(bytes);
        if (message.kind === "root" && message.record) return `root heartbeat: ${describeRecord(message.record)}`;
        if (message.kind === "bundle" && message.bundle instanceof Uint8Array)
            return `live vote bundle (${message.bundle.length} B, cid ${await bundleCidForBytes(message.bundle)})`;
        return `unknown message kind ${JSON.stringify(message.kind)}`;
    } catch {
        return "undecodable message";
    }
}
