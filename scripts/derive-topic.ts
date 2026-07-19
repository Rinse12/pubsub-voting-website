import { resolveRegistry, topicFor, validateCriteriaRules } from "@bitsocial/pubsub-voting";
import { allCriteria, directoryCodeOf } from "../shared/contests.js";

/**
 * Smoke test / topic inspector: validates every directory contest's criteria document
 * against the built-in rule registry exactly like PubsubVoter does at createContest
 * time, then prints each derived pubsub topic. Run: npm run topic
 */
const registry = resolveRegistry({});
for (const criteria of allCriteria) {
    validateCriteriaRules(criteria, registry);
    console.log(`/${directoryCodeOf(criteria)}/`.padEnd(8), await topicFor(criteria));
}
console.log(`${allCriteria.length} contests valid \u2714`);
