// Test stub for the "server-only" package.
//
// The real package unconditionally throws on import outside a react-server
// bundling context (see node_modules/server-only/index.js), which would
// break plain Node/vitest imports of any lib module that imports it
// (env.ts, supabase.ts, grok.ts, ingest.ts, brain.ts). vitest.config.ts
// aliases "server-only" to this file, which exports nothing and does
// nothing — exactly what the real package does inside a valid server
// context.
export {};
