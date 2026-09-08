# Deploying to strmap.sixgenrentals.com

This is a **private tool on a public company's subdomain**, not a page of the
marketing site. It shows STR permit data, the Sixgen portfolio's revenue, and
acquisition underwriting. Everything except `/login` is gated by magic-link auth
against the `allowed_emails` allowlist, the middleware fails closed, and every
table is RLS-scoped. Keep it that way: do not add a public page to this app, and
do not link to it from sixgenrentals.com.

`public/robots.txt` disallows all crawling so the login page does not surface in
search results beside the public site.

---

## What sits where

| Piece | Where | Notes |
|---|---|---|
| Public site `sixgenrentals.com` | Squarespace | untouched by any of this |
| DNS for the domain | Google Cloud DNS (`ns-cloud-c1..c4.googledomains.com`) | the CNAME goes here |
| `strmap.sixgenrentals.com` | Vercel | this app |
| Database, auth, PostGIS | Supabase project `STR MAP` | already live |

## Why Vercel rather than Netlify

Both configs are in the repo and either will run the app, but the long routes
decide it. `netlify.toml` documents the platform's 26-second synchronous ceiling;
the permit import geocodes ~1,000 addresses and the GIS sync rebuilds a dissolved
600-ft exclusion in PostGIS, and both blow through that. `vercel.json` already
declares `maxDuration` per route, up to 300 s.

**Duration is plan-gated on Vercel.** Confirm the current ceiling for your plan
when you sign up. If the long routes exceed it, nothing is broken — run them from
your machine with the `IMPORT_SECRET` bearer token, which is what
`requireAdminOrSecret` exists for. See RUNBOOK.md, "Long-running operations".
Every interactive page is far inside any of these limits.

---

## Steps

### 1. Push the repo

The project is a git repo with an initial commit. Create an **empty private**
GitHub repo — private matters, the code encodes your underwriting — and push:

```bash
git remote add origin https://github.com/<you>/sixgen-str-finder.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `.env.local`. Verify nothing secret is staged:

```bash
git ls-files | grep -E "^\.env" || echo "no env files tracked - good"
```

### 2. Import to Vercel

vercel.com → Add New → Project → import the repo. Framework auto-detects as
Next.js; leave build and output settings alone.

### 3. Environment variables

Set these in Vercel → Settings → Environment Variables, for **Production**
(and Preview if you want preview deploys to work).

| Name | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | your project URL | same as `.env.local` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key | **server only** — bypasses all RLS |
| `NEXT_PUBLIC_SITE_URL` | `https://strmap.sixgenrentals.com` | magic-link redirects |
| `IMPORT_SECRET` | long random string | bearer token for machine imports |

`NEXT_PUBLIC_*` variables are compiled into the browser bundle. Never put the
service role key in one.

Use a **different** `IMPORT_SECRET` from the local one, so a leaked development
value cannot drive production.

### 4. Add the domain

Vercel → Settings → Domains → add `strmap.sixgenrentals.com`. Vercel shows the
record to create.

### 5. Create the DNS record

Google Cloud DNS → the `sixgenrentals.com` zone → add:

```
Name:  strmap
Type:  CNAME
Data:  cname.vercel-dns.com.       (use whatever value Vercel shows you)
TTL:   300
```

A CNAME on a subdomain does not affect the apex, so the Squarespace site keeps
serving `sixgenrentals.com` and `www` exactly as it does now.

Propagation is usually minutes. Check with:

```bash
nslookup strmap.sixgenrentals.com
```

Vercel issues the TLS certificate automatically once the record resolves.

### 6. Point Supabase auth at the new domain

Supabase → Authentication → URL Configuration:

- **Site URL**: `https://strmap.sixgenrentals.com`
- **Redirect URLs**: add `https://strmap.sixgenrentals.com/auth/callback`

Keep `http://localhost:3000/auth/callback` in the redirect list if you still
develop locally. Magic links break silently without this — the email arrives and
the link bounces.

### 7. Verify, in this order

1. `https://strmap.sixgenrentals.com/api/health` — checks the database, the
   exclusion zone and the service-role connection. Do this first; it needs no
   login and tells you whether the env vars took.
2. Load the root. You should be redirected to `/login`, not shown a page.
3. Sign in with an allowlisted address. If the magic link bounces, step 6 is wrong.
4. Test Address → `697 Cindy Blair Way` → expect YELLOW, R-1B, acreage 0.52,
   600-ft separation PASS.
5. Sixgen Comps → expect 17 listings and $2,335,364 T12.

### 8. Invite the people who need it

Admin → Invite, or insert into `allowed_emails`. Anyone not on that list cannot
get in even with a valid Supabase account.

---

## After deploying

- **Rotate `IMPORT_SECRET`** if the local value was ever shared or pasted anywhere.
- **Long imports** run from your machine against the deployed API:
  `curl -X POST https://strmap.sixgenrentals.com/api/refresh?jurisdiction=lfucg -H "Authorization: Bearer $IMPORT_SECRET"`
- **Migrations are not automatic.** New `supabase/migrations/*.sql` files must be
  run in the SQL editor. A deploy that expects a column you have not added fails
  at runtime, not at build.
- **Preview deployments get a public vercel.app URL.** They are auth-gated like
  production, but if you would rather they not exist at all, turn preview
  deployments off or protect them in Vercel's settings.
