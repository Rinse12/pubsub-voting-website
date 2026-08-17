/**
 * Tests for the eligibility rendering (src/eligibility-view.ts).
 *
 * Why these exist: the 5chan directory contests gate on a SINGLE rule, so every interesting shape
 * `Contest.checkEligibility` can return — an `all` with two failures, an `any` where one branch
 * qualifies, a rule whose chain read failed, one rule named twice — never occurs in the deployed
 * app. Before this, the site rendered only `check.error` (the blame set joined into one sentence),
 * which is lossless for one rule and lossy for every tree; the renderer that replaced it would
 * have shipped completely unexercised, and `tsc` cannot tell you a checklist reads wrongly.
 *
 * The three behaviours worth breaking a build over:
 *   1. a failure inside a SATISFIED `any` is not styled as a problem (telling a wallet admitted as
 *      a moderator to go and buy a Pass is worse than saying nothing);
 *   2. `satisfied: undefined` renders as unknown, never as a missing requirement — nothing was
 *      learned about the wallet, and the library leaves that state deliberately wordless;
 *   3. rows are keyed by `leaf` (position), so one rule named twice in a gate is two rows.
 *
 *   node tests/eligibility-view.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { EligibilityNode, EligibilityResult, VerifyFail } from "@bitsocial/pubsub-voting";
import { eligibilityBadge, explainEviction, gateMark, renderGateChecklist } from "../src/eligibility-view.js";

/* ---------- a DOM small enough to read ----------
 * Only what the renderer touches. The casts below are to satisfy the DOM types the module is
 * written against; every assertion is on real rendered output, not on a type. */
class FakeElement {
    className = "";
    title = "";
    hidden = false;
    children: FakeElement[] = [];
    readonly tag: string;
    #text = "";
    // Not a parameter property: node's strip-only TypeScript mode (how these tests run) rejects
    // `constructor(readonly tag: string)` outright.
    constructor(tag: string) {
        this.tag = tag;
    }
    set textContent(value: string) {
        this.#text = value;
    }
    get textContent(): string {
        return this.#text;
    }
    append(...nodes: FakeElement[]): void {
        this.children.push(...nodes);
    }
    replaceChildren(...nodes: FakeElement[]): void {
        this.children = [...nodes];
    }
}

const fakeDoc = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
const host = () => new FakeElement("dd");
const asHost = (element: FakeElement) => element as unknown as HTMLElement;

/** Flatten the rendered tree into one readable line per row: "<depth><glyph> [cls] label | text". */
function rows(element: FakeElement, depth = 0): string[] {
    const out: string[] = [];
    for (const li of element.children.flatMap((child) => (child.tag === "ul" ? child.children : [child]))) {
        if (li.tag !== "li") continue;
        const [mark, ...rest] = li.children;
        const label = rest.filter((node) => node.tag !== "ul").map((node) => node.textContent);
        out.push(`${"  ".repeat(depth)}${mark.textContent} [${mark.className.replace("gate-mark ", "")}] ${label.join(" | ")}`);
        for (const nested of li.children.filter((node) => node.tag === "ul")) out.push(...rows(nested, depth + 1));
    }
    return out;
}

/* ---------- fixtures shaped exactly like the library's EligibilityNode ---------- */
const leaf = (
    leafIndex: number,
    type: string,
    satisfied: boolean | undefined,
    extra: { score?: bigint; error?: string } = {}
): EligibilityNode => ({
    kind: "leaf",
    leaf: leafIndex,
    ruleId: `rule-${type}`,
    type,
    satisfied,
    score: extra.score ?? 0n,
    ...(extra.error === undefined ? {} : { error: extra.error })
});

const NO_PASS = "this wallet holds none of the gate token (0xA8e0…C852)";
const BANNED = "this wallet is on the deny list";

const refused = (gate: EligibilityNode, failures: number[], error: string): EligibilityResult => ({
    eligible: false,
    error,
    failures: failures.map((index) => collect(gate).find((check) => check.leaf === index)!),
    checks: collect(gate),
    gate
});
const admitted = (gate: EligibilityNode, score: bigint): EligibilityResult => ({
    eligible: true,
    score,
    checks: collect(gate),
    gate
});
/** Every leaf of `gate`, in document order — the library's `checks`. */
function collect(gate: EligibilityNode): Extract<EligibilityNode, { kind: "leaf" }>[] {
    return gate.kind === "leaf" ? [gate] : gate.children.flatMap(collect);
}

test("a single-rule gate renders NO checklist — the badge already carries that rule's sentence", () => {
    const element = host();
    const gate = leaf(0, "erc5192-min-balance", true, { score: 1n });
    renderGateChecklist(fakeDoc, asHost(element), admitted(gate, 1n));

    assert.equal(element.hidden, true);
    assert.deepEqual(element.children, []);
    // The deployed 5chan contests are exactly this shape, so the badge must not regress.
    assert.deepEqual(eligibilityBadge(admitted(gate, 1n)), { text: "yes — holds 1 5chan Pass", cls: "badge-ok" });
    assert.match(eligibilityBadge(admitted(gate, 2n)).text, /holds 2 5chan Passes/);
});

test("an `all` refused by both rules lists both, each blamed, in the rules' own words", () => {
    const element = host();
    const gate: EligibilityNode = {
        kind: "all",
        satisfied: false,
        children: [leaf(0, "erc5192-min-balance", false, { error: NO_PASS }), leaf(1, "deny-list", false, { error: BANNED })]
    };
    renderGateChecklist(fakeDoc, asHost(element), refused(gate, [0, 1], `${NO_PASS}; ${BANNED}`));

    assert.equal(element.hidden, false);
    assert.deepEqual(rows(element), [
        "✗ [badge-bad] every one of:",
        `  ✗ [badge-bad] erc5192-min-balance | ${NO_PASS}`,
        `  ✗ [badge-bad] deny-list | ${BANNED}`
    ]);
});

test("a failure inside a SATISFIED `any` is muted, not blamed — don't tell a moderator to buy a Pass", () => {
    const element = host();
    const gate: EligibilityNode = {
        kind: "any",
        satisfied: true,
        children: [leaf(0, "erc5192-min-balance", false, { error: NO_PASS }), leaf(1, "moderator", true, { score: 1n })]
    };
    const check = admitted(gate, 1n);
    renderGateChecklist(fakeDoc, asHost(element), check);

    const rendered = rows(element);
    assert.deepEqual(rendered, [
        "✓ [badge-ok] any one of:",
        `  ✗ [muted] erc5192-min-balance | ${NO_PASS}`,
        "  ✓ [badge-ok] moderator | satisfied (score 1)"
    ]);
    // The whole point: this wallet qualified, so nothing on screen may look like a problem.
    assert.equal(rendered.some((row) => row.includes("badge-bad")), false);
    // And the badge cannot claim a Pass count: across a tree `score` is a fold, not the rule's own.
    assert.deepEqual(eligibilityBadge(check), { text: "yes — every requirement met", cls: "badge-ok" });
});

test("a rule whose chain read failed renders as UNKNOWN, never as a missing requirement", () => {
    const element = host();
    // `satisfied: undefined` with no `error`: the library returns a tolerated leaf error
    // unevaluated, so the wording here has to be ours.
    const unknown = leaf(1, "deny-list", undefined);
    const gate: EligibilityNode = {
        kind: "all",
        satisfied: false,
        children: [leaf(0, "erc5192-min-balance", false, { error: NO_PASS }), unknown]
    };
    renderGateChecklist(fakeDoc, asHost(element), refused(gate, [0], NO_PASS));

    const rendered = rows(element);
    assert.deepEqual(rendered[2], "  ? [badge-warn] deny-list | couldn't be checked (chain read failed) — the gate was decided without it");
    // It must not be drawn as a failure by either glyph or colour, at any blame state.
    assert.equal(rendered[2].includes("✗"), false);
    assert.equal(rendered[2].includes("badge-bad"), false);
    assert.equal(gateMark(undefined, true).cls, "badge-warn");
    assert.match(gateMark(undefined, true).title, /could not be checked/);
});

test("nested branches keep the requirement's SHAPE — an `any` inside an `all`", () => {
    const element = host();
    const gate: EligibilityNode = {
        kind: "all",
        satisfied: false,
        children: [
            {
                kind: "any",
                satisfied: true,
                children: [leaf(0, "erc5192-min-balance", true, { score: 3n }), leaf(1, "moderator", false, { error: "not a moderator" })]
            },
            leaf(2, "deny-list", false, { error: BANNED })
        ]
    };
    renderGateChecklist(fakeDoc, asHost(element), refused(gate, [2], BANNED));

    assert.deepEqual(rows(element), [
        "✗ [badge-bad] every one of:",
        "  ✓ [badge-ok] any one of:",
        "    ✓ [badge-ok] erc5192-min-balance | satisfied (score 3)",
        "    ✗ [muted] moderator | not a moderator",
        `  ✗ [badge-bad] deny-list | ${BANNED}`
    ]);
});

test("rows are keyed by leaf POSITION: one rule named twice is two rows", () => {
    const element = host();
    // "any two of these" repeats a rule across branches, so `type` and `ruleId` both repeat and
    // neither can be the render key.
    const gate: EligibilityNode = {
        kind: "any",
        satisfied: false,
        children: [
            { kind: "all", satisfied: false, children: [leaf(0, "erc5192-min-balance", true, { score: 1n }), leaf(1, "moderator", false, { error: "not a moderator" })] },
            { kind: "all", satisfied: false, children: [leaf(2, "erc5192-min-balance", true, { score: 1n }), leaf(3, "deny-list", false, { error: BANNED })] }
        ]
    };
    renderGateChecklist(fakeDoc, asHost(element), refused(gate, [1, 3], `not a moderator; ${BANNED}`));

    const rendered = rows(element);
    assert.equal(rendered.filter((row) => row.includes("erc5192-min-balance")).length, 2);
    assert.equal(rendered.filter((row) => row.includes("✓")).length, 2);
    assert.equal(rendered.length, 7); // root + 2 branches + 4 leaves
});

test("re-rendering replaces the previous checklist instead of appending to it", () => {
    const element = host();
    const tree: EligibilityNode = {
        kind: "all",
        satisfied: false,
        children: [leaf(0, "erc5192-min-balance", false, { error: NO_PASS }), leaf(1, "deny-list", false, { error: BANNED })]
    };
    renderGateChecklist(fakeDoc, asHost(element), refused(tree, [0, 1], NO_PASS));
    renderGateChecklist(fakeDoc, asHost(element), refused(tree, [0, 1], NO_PASS));
    assert.equal(element.children.length, 1);

    // And a later single-rule answer must clear the tree, not leave it stale on screen.
    renderGateChecklist(fakeDoc, asHost(element), admitted(leaf(0, "erc5192-min-balance", true, { score: 1n }), 1n));
    assert.deepEqual(element.children, []);
    assert.equal(element.hidden, true);
});

test("the eviction message strips the pipeline prefix and enumerates a multi-rule blame set", () => {
    // `disposition: "ignore"` is what the v1 gate actually produces — erc5192-min-balance returns
    // penalize: false, since a 0n may just mean the verifying peer's head is behind.
    const one: VerifyFail = { valid: false, disposition: "ignore", reason: `not admitted: ${NO_PASS}` };
    assert.equal(explainEviction("g", one), `Your /g/ vote was rejected: ${NO_PASS}.`);

    const many: VerifyFail = {
        valid: false,
        disposition: "reject",
        reason: `not admitted: ${NO_PASS}; ${BANNED}`,
        failures: [
            // The prefix rides on `reason`, not on a failure's own sentence — strip it anyway, so a
            // pipeline that ever prefixes both cannot leak "not admitted:" into a bulleted list.
            { type: "erc5192-min-balance", error: `not admitted: ${NO_PASS}` },
            { type: "deny-list", error: BANNED }
        ]
    };
    assert.equal(explainEviction("g", many), `Your /g/ vote was rejected — 2 requirements were not met:\n• ${NO_PASS}\n• ${BANNED}`);
});
