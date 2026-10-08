# Security policy

Bookmark Graveyard handles API keys, X sign-in tokens and your saved posts, so security reports are
welcome and taken seriously.

## Supported versions

Only the `main` branch is supported. Fixes land there. Older commits and forks do not get patches,
so update your copy (`git pull`, then `npm install` and `npm run setup`) to pick them up.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. A public issue tells everyone about the
problem before there is a fix.

Use GitHub's private vulnerability reporting instead:

1. Open the [repository](https://github.com/im-trustworthy/bookmark-graveyard).
2. Go to the **Security** tab.
3. Click **Report a vulnerability** and describe what you found.

Direct link: [Report a vulnerability](https://github.com/im-trustworthy/bookmark-graveyard/security/advisories/new).

Helpful details: what you did, what you expected, what happened, the commit you tested, and whether
it needs a signed-in session. Do not include real API keys or other people's data in a report.

This is a small open-source project, so replies are best effort.

## What counts

In scope: the code in this repository. Examples are the X sign-in flow, the session cookie, the
site password gate, token and voice-key encryption, the article-fetching guard against requests to
private addresses (SSRF), the cron endpoint, and anything that lets one person reach another
person's data on a shared instance.

Out of scope:

- Problems in services you connect to, such as [X](https://x.com),
  [Supabase](https://supabase.com), [xAI](https://x.ai), [ElevenLabs](https://elevenlabs.io),
  [Render](https://render.com) or [Vercel](https://vercel.com). Report those to the vendor.
- Your own setup mistakes, such as a committed `.env.local` or a public Supabase bucket.

## If you run an instance

- Never commit `.env.local`. Keep `SUPABASE_SERVICE_ROLE_KEY` on the server only.
- On a deployed instance, set `ALLOWED_X_USER_IDS`: without it, anyone who completes X sign-in can
  use the instance and its API keys. Set `CRON_SECRET` if you want the weekly sync. `GATE_PASSWORD`
  is optional: it adds a shared password in front of every page for an unlisted instance.
- Set `SUPABASE_ACCESS_TOKEN` only on your own computer for `npm run setup`. Never set it on your
  host.
- Keep the `episodes` storage bucket private. `npm run setup -- --check` warns if it is public.
- If a key leaks, create a new one at the vendor and delete the old one. Changing
  `APP_ENCRYPTION_KEY` makes saved voice keys unreadable, so the app asks people to enter them
  again.

How the app protects data is described in [ARCHITECTURE.md](ARCHITECTURE.md#security-measures)
and in the README's [Data & privacy](README.md#data--privacy) section.
