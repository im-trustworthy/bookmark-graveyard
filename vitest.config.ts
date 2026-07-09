import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/lib/__tests__/setup.ts"],
    include: ["src/lib/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: [
      // The real "server-only" package throws unconditionally on import
      // outside a react-server context; swap in a no-op stub for tests.
      {
        find: "server-only",
        replacement: path.resolve(__dirname, "src/lib/__tests__/stubs/server-only.ts"),
      },
      // Mirrors tsconfig.json's "@/*" path mapping, in case any tested
      // module (or something it imports) uses the "@/..." alias.
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
});
