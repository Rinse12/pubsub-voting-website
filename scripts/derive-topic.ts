import { resolveRegistry, topicFor, validateCriteriaRules } from "@bitsocial/pubsub-voting";
import { criteria } from "../shared/criteria.js";

/**
 * Smoke test / topic inspector: validates the criteria document against the built-in
 * rule registry exactly like PubsubVoter does at createContest time, then prints the
 * derived pubsub topic. Run: npm run topic
 */
validateCriteriaRules(criteria, resolveRegistry({}));
console.log("criteria valid ✔");
console.log("topic:", await topicFor(criteria));
