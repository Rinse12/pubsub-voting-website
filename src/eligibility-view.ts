import type { EligibilityNode, EligibilityResult, VerifyFail } from "@bitsocial/pubsub-voting";

/**
 * Rendering for `Contest.checkEligibility` — the badge verdict, the per-rule breakdown, and the
 * peer-side rejection message.
 *
 * Split out of main.ts so it can be tested without a browser: the gate the 5chan contests ship is
 * a single rule, so the interesting shapes (an `all` with two failures, an `any` where one branch
 * qualifies, a rule whose chain read failed) never occur in the deployed app and would otherwise
 * ship unexercised. See tests/eligibility-view.test.ts.
 *
 * Nothing here knows anything about a particular rule: no contract, no threshold, no block. Every
 * human sentence about a failure is the RULE's own (`check.error`), rendered verbatim. The one
 * sentence this file writes itself is for the unknown state, which the library deliberately leaves
 * wordless (a tolerated leaf error returns the leaf unevaluated).
 */

/** Written as text, never as HTML — a rule's sentence and a `.bso` name are both untrusted input. */
export interface GateMark {
    glyph: string;
    cls: string;
    title: string;
}

/**
 * How one gate node's verdict is drawn. THREE states, not two.
 *
 * A failed node is styled as a problem only when it is in the blame set: under an `any`, a wallet
 * admitted as a moderator also "fails" the Pass rule, and colouring that red would tell it to go
 * and acquire something it does not need. Non-blame failures stay muted but present — "the branch
 * you did not take" is still worth seeing.
 */
export function gateMark(satisfied: boolean | undefined, blamed: boolean): GateMark {
    if (satisfied === true) return { glyph: "✓", cls: "badge-ok", title: "satisfied" };
    // NOT a failure: nothing was learned about this wallet, so it must never read as a missing
    // requirement. `checkEligibility` folds a rule whose chain read threw as unknown and answers
    // anyway when another branch decides the gate — it throws only when it cannot.
    if (satisfied === undefined)
        return { glyph: "?", cls: "badge-warn", title: "could not be checked — this rule's chain read failed" };
    return blamed
        ? { glyph: "✗", cls: "badge-bad", title: "not satisfied" }
        : { glyph: "✗", cls: "muted", title: "not satisfied — but not what stopped this wallet" };
}

/** The sentence shown next to one leaf. The rule's own words whenever the rule has any. */
export function gateLeafText(node: EligibilityNode & { kind: "leaf" }): string {
    if (node.satisfied === true) return `satisfied (score ${node.score})`;
    // A tolerated leaf error carries no sentence of its own, so this wording is ours — and it says
    // only what is true: nothing was learned, and the gate was decided by other rules.
    if (node.satisfied === undefined) return "couldn't be checked (chain read failed) — the gate was decided without it";
    return node.error ?? "this wallet does not qualify";
}

/**
 * Whether this node is part of what explains the refusal.
 *
 * The library's blame set is a set of LEAVES, so a branch has to inherit: a branch is blamed when
 * any leaf beneath it is. Without this a refused `all` renders its own row muted while its blamed
 * children are red — the top of the tree, the row a reader looks at first, disowning the failure.
 */
function branchBlamed(node: EligibilityNode, blamed: ReadonlySet<number>): boolean {
    return node.kind === "leaf" ? blamed.has(node.leaf) : node.children.some((child) => branchBlamed(child, blamed));
}

/** One `<li>` per gate node, recursing into `all`/`any` branches. */
export function gateNodeItem(doc: Document, node: EligibilityNode, blamed: ReadonlySet<number>): HTMLLIElement {
    const li = doc.createElement("li");
    const mark = gateMark(node.satisfied, branchBlamed(node, blamed));
    const glyph = doc.createElement("span");
    glyph.className = `gate-mark ${mark.cls}`;
    glyph.textContent = mark.glyph;
    glyph.title = mark.title;
    li.append(glyph);

    if (node.kind !== "leaf") {
        // The requirement's SHAPE, which a flat list cannot express: "every one of these" reads
        // differently from "any one of these", and only the tree knows which this is.
        const op = doc.createElement("span");
        op.className = "gate-op";
        op.textContent = node.kind === "all" ? "every one of:" : "any one of:";
        const ul = doc.createElement("ul");
        ul.className = "gate-tree";
        ul.append(...node.children.map((child) => gateNodeItem(doc, child, blamed)));
        li.append(op, ul);
        return li;
    }

    // The rule's `type` verbatim, deliberately NOT a friendly label mapped from it here: a
    // per-type label in the client is one more thing that silently goes stale when the gate
    // changes, which is the mistake this whole path exists to stop repeating. The human sentence
    // is the rule's own, alongside it.
    const type = doc.createElement("code");
    type.textContent = node.type;
    const why = doc.createElement("span");
    why.className = "gate-why";
    why.textContent = gateLeafText(node);
    li.append(type, why);
    return li;
}

/**
 * Draw the whole gate as a checklist: one row per LEAF — its position in the tree, the only key
 * unique within one result, since `type` and `ruleId` may each repeat — nested by `all`/`any`.
 *
 * Skipped for a single-rule gate, which is what the 5chan contests ship today: with one leaf the
 * badge already carries that rule's own sentence and a one-item list adds nothing.
 */
export function renderGateChecklist(doc: Document, host: HTMLElement, check: EligibilityResult): void {
    if (check.gate.kind === "leaf") {
        host.replaceChildren();
        host.hidden = true;
        return;
    }
    const blamed = new Set(check.eligible ? [] : check.failures.map((failure) => failure.leaf));
    const ul = doc.createElement("ul");
    ul.className = "gate-tree gate-root";
    ul.append(gateNodeItem(doc, check.gate, blamed));
    host.replaceChildren(ul);
    host.hidden = false;
}

/**
 * The badge line: the verdict itself.
 *
 * On the eligible branch `score` is the rule's own only for a single-rule gate; across a tree it is
 * a FOLD (min over `all`, max over `any`), so naming a Pass count there would be a guess dressed as
 * a fact. On the refusal branch `check.error` is the blame set joined — right for one rule, and the
 * checklist beneath carries the structure once there is more than one.
 */
export function eligibilityBadge(check: EligibilityResult): { text: string; cls: "badge-ok" | "badge-bad" } {
    if (!check.eligible) return { text: `no — ${check.error}`, cls: "badge-bad" };
    const detail =
        check.gate.kind === "leaf" ? `holds ${check.score} 5chan Pass${check.score === 1n ? "" : "es"}` : "every requirement met";
    return { text: `yes — ${detail}`, cls: "badge-ok" };
}

/**
 * The peer-side rejection message.
 *
 * Each rule states its own reason and the library carries them through, so there is nothing to
 * translate — this strips the pipeline's `not admitted: ` prefix, names the board, and enumerates
 * when more than one rule is to blame. `verdict.reason` is those same sentences joined with "; ",
 * which reads as one run-on once a gate has several rules. Do not add rule-specific special cases
 * here: that is exactly what went stale last time.
 */
export function explainEviction(code: string, verdict: VerifyFail): string {
    const strip = (reason: string) => reason.replace(/^not admitted: /, "");
    // The blame set, when the library carried one: the rules whose failure EXPLAINS the rejection,
    // which is not every rule that failed (one failing inside a satisfied `any` explains nothing).
    const failures = verdict.failures ?? [];
    if (failures.length > 1) {
        const list = failures.map((failure) => `• ${strip(failure.error)}`).join("\n");
        return `Your /${code}/ vote was rejected — ${failures.length} requirements were not met:\n${list}`;
    }
    return `Your /${code}/ vote was rejected: ${strip(verdict.reason)}.`;
}
