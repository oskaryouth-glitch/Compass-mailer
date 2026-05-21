# Compass Estimate Mailer

A web app that sends monthly home-value emails to a Compass agent's past clients,
using **Apify** (Zillow data) + **Resend** (email) + **Neon Postgres** (storage).
Designed to run on **Vercel** with a monthly cron job — no laptop required.

---

## How it works

1. Each month at 9 AM on the 1st, Vercel Cron hits `/api/cron/monthly`.
2. For every client in the DB, the app:
   - geocodes the address (OpenStreetMap, free)
   - searches a ~0.5 mile box on Zillow via the `maxcopell/zillow-scraper` Apify actor
   - picks the exact home if it appears, otherwise estimates from nearby comps
   - builds a personalized HTML email and sends it via Resend
3. The dashboard at `/` lets you preview, fetch on demand, and send manually.

---

## Local setup (5 minutes)

### 1. Install
```bash
npm install
```

### 2. Sign up for the 3 services
| Service | What you need | Free tier |
|---|---|---|
| **Apify** | API token → [console.apify.com/settings/integrations](https://console.apify.com/settings/integrations) | $5/mo credit (~2,500 results) |
| **Resend** | API key → [resend.com/api-keys](https://resend.com/api-keys) + a verified domain | 3,000 emails/mo, 100/day |
| **Neon** | Postgres `DATABASE_URL` → [console.neon.tech](https://console.neon.tech) | Free tier, no card |

For Resend, the fastest path is to register a domain you own (or buy one through Resend for ~$10/yr) and add the DNS records they show you. Without a verified domain, you can only send test emails to your own Resend account.

### 3. Configure
```bash
cp .env.template .env
# Edit .env and paste in your real values
```

Generate a `CRON_SECRET`:
```bash
openssl rand -hex 32
```

### 4. Create the database tables + seed clients
```bash
node setup-db.js
```
This creates the `clients` table and inserts the 3 starting clients. Re-running it is safe — it skips seeding if clients already exist.

### 5. Run it
```bash
npm start
```
Open http://localhost:3000.

---

## Deploy to Vercel

### 1. Push to GitHub
```bash
git init && git add . && git commit -m "Initial commit"
gh repo create compass-mailer --private --source=. --remote=origin --push
```
(Or use the GitHub UI to make a private repo, then push.)

### 2. Import into Vercel
- Go to [vercel.com/new](https://vercel.com/new)
- Import the repo
- **Framework Preset:** Other
- **Build/Output settings:** leave defaults (vercel.json handles it)

### 3. Add environment variables
In the Vercel project's **Settings → Environment Variables**, paste each value from your local `.env`:
- `APIFY_TOKEN`
- `RESEND_API_KEY`
- `RESEND_FROM`
- `RESEND_FROM_NAME`
- `DATABASE_URL`
- `CRON_SECRET`

### 4. Deploy
Click **Deploy**. After it finishes, visit the live URL — the dashboard loads.

### 5. Verify the cron
Go to **Settings → Cron Jobs** in the Vercel dashboard — you'll see the monthly job. Vercel sends `Authorization: Bearer ${CRON_SECRET}` with each cron call; the handler verifies it.

You can also manually invoke it from the Vercel dashboard's cron page to test.

---

## How estimates are calculated

The Apify actor searches for-sale listings inside a map bounding box, not a specific address. So `fetchEstimate()` does this:

1. **Geocode** the client address via Nominatim (free, no API key).
2. **Search** a ~0.5 mile box (expanding to 1.5 mi if too few results).
3. **Match** — find the client's exact home in the results (by house number + street).
4. **Fall back** when the home isn't listed:
   - If we know the home's sqft → average `$ / sqft` of neighbors × client's sqft
   - Otherwise → simple average of nearby Zestimates
5. **Comparables** — 3 closest neighbors with prices are included in the email.

The estimate's `source` field tells you which path was used:
- `zillow_zestimate` — direct hit, Zillow had a Zestimate
- `zillow_listing_price` — exact match found but only an asking price (currently on market)
- `neighborhood_ppsf` — sqft-weighted neighborhood average
- `neighborhood_avg` — plain average of nearby homes

Filling in `sqft` for each client (in the DB) noticeably improves accuracy.

---

## File layout

```
compass-mailer/
├── api/index.js     Vercel entry → re-exports server.js's Express app
├── public/          Static dashboard
├── server.js        Express app + all routes + Apify/email/fetch logic
├── db.js            Neon Postgres helpers
├── setup-db.js      One-shot table creation + seed (run once)
├── vercel.json      Rewrites + monthly cron schedule
└── .env.template    Env vars (copy to .env locally)
```

---

## Costs

- **Apify**: 50 clients × $0.002/result × ~5 results per client = ~$0.50/month. Free $5 credit covers it.
- **Resend**: 50 emails/month — free.
- **Neon**: free tier handles this many clients indefinitely.
- **Vercel**: Hobby tier is free and includes cron.

Total: **$0/month** at this scale.
