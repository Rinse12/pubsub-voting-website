import { defineConfig } from "vite";

export default defineConfig({
    build: {
        target: "es2022",
        // helia/libp2p chunks are large; the warning is noise for this single-page test app
        chunkSizeWarningLimit: 2000
    },
    esbuild: { target: "es2022" },
    optimizeDeps: { esbuildOptions: { target: "es2022" } }
});
