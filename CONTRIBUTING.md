# Contributing

Thanks for helping. Small fixes, bug reports and docs improvements are all welcome. For anything
big, open an issue first so we can agree on the shape before you spend a weekend on it.

Be kind. Assume good faith, keep feedback about the code, and welcome newcomers.

## Run it locally

You need [Node.js](https://nodejs.org) 20 or newer and [git](https://git-scm.com). Then follow
[SETUP.md](SETUP.md) to get your own Supabase project, X app and xAI key. In short:

```bash
git clone https://github.com/im-trustworthy/bookmark-graveyard.git
cd bookmark-graveyard
npm install
cp .env.example .env.local     # fill it in, see SETUP.md
npm run setup -- --check       # read-only: checks every value and the database
npm run dev                    # http://localhost:3000
```

This is Next.js 16, which has breaking changes from older versions. Before you touch framework-level
code, read the matching guide in `node_modules/next/dist/docs/` (see [AGENTS.md](AGENTS.md)).

A map of the code and the pipeline is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Checks to run before you open a pull request

```bash
npm test             # unit tests (Vitest)
npx tsc --noEmit     # type check
npm run lint         # ESLint
```

All three should pass.

## Pull request expectations

- **Tests for pure logic.** If you add or change logic that does not need a network or a database
  (parsing, selection, formatting, limits), add a test next to the others in
  `src/lib/__tests__/`.
- **No secrets in commits.** Never commit `.env.local`, API keys, tokens or real bookmarks. Redact
  screenshots and test data.
- **Screenshots for UI changes.** Show before and after. Redact your handle, keys and project ids.
- **Keep it focused.** One change per pull request, with a short description of why.
- **Keep docs in step.** If you add an environment variable, put it in `.env.example` and in
  [SETUP.md](SETUP.md).

## Where the backlog lives

Deferred and planned work, and why some of it is blocked upstream, is in [ROADMAP.md](ROADMAP.md).
Check it before proposing a feature. Your idea may already be there with notes.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
