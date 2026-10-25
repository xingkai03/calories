# Calories

A personal food and calorie journal, served by GitHub Pages at
<https://xingkai03.github.io/calories/>, with Supabase email/password access, private
storage, food references, daily macros, Garmin activity imports, and JSON/CSV backups.
See [the setup guide](docs/setup.md) for the one-account database setup and
[the Garmin guide](docs/garmin.md) for activity imports.

Run `npm test` (Node 22.18+ or Node 24 recommended). `npm run dev` serves the app at
`localhost:4321/calories/`, and `npm run build` writes `dist/`. Pushes to `main` deploy to
GitHub Pages after the tests pass. The build needs the `PUBLIC_CALORIES_SUPABASE_URL` and
`PUBLIC_CALORIES_SUPABASE_KEY` repository Actions variables.

- `src/pages/` app (`/calories/`), setup guide (`/calories/setup/`), Garmin guide, SQL downloads
- `src/components/calories/`, `src/lib/calories/` React island and app logic
- `scripts/calories-pwa.mjs` generates the offline service worker after each build
- `backend/calories/` database SQL and the Garmin sync worker
- `supabase/functions/calories-food-photos/` photo nutrition Edge Function

This app was moved here from `xingkai03/xingkai03.github.io` with its history.
