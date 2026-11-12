<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# State machines

Lifecycles (episode, background brief job, API token, bookmark pipeline, and the dashboard's flows) are defined in `src/lib/state/`. [ARCHITECTURE.md](ARCHITECTURE.md), section "State machines", is the map: states, legal moves and the checklist for adding one.
A new state or transition goes into that module's `STATES` array and transitions table first, then into the code that uses it. Do not compare a lifecycle's state against bare strings elsewhere.
Before you finish, `npx vitest run`, `npx tsc --noEmit` and `npm run lint` must all pass.
