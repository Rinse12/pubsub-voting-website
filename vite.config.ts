import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// Pinned library versions, shown in the page header so a deployed build says what it runs.
const deps = pkg.dependencies as Record<string, string>;

export default defineConfig({
    define: {
        __PUBSUB_VOTING_VERSION__: JSON.stringify(deps["@bitsocial/pubsub-voting"]),
        __PKC_JS_VERSION__: JSON.stringify(deps["@pkcprotocol/pkc-js"])
    },
    build: {
        target: "es2022",
        // helia/libp2p chunks are large; the warning is noise for this single-page test app
        chunkSizeWarningLimit: 2000
    },
    esbuild: { target: "es2022" },
    optimizeDeps: { esbuildOptions: { target: "es2022" } }
});
