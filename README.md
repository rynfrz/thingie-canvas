# thingie: canvas — deployable

## Quick local test
1) Run a static server (preinstalled in package.json):
   ```bash
   npm i
   npm run build
   npm run start
   ```
   Open http://localhost:8080

2) Or just double-click `index.html` (no server).

3) Put your Supabase keys in `supabase.config.js` (or let the build script write them from env).

## Vercel
- Set env vars `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- Build Command: `npm run build`
- Output: root

## Netlify
- Same env vars
- Build Command: `npm run build`
- Publish dir: root
