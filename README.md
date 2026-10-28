# TideOver

TideOver lets a person post one real, essential household bill, and lets anyone who wants to help pay it **directly to the company that sent it**. The app never collects, holds or forwards money, and never asks for bank or card details.

Created by **Khan Gulrez Shagufa Fazal Ahmed** ([ORCID 0009-0009-6195-0329](https://orcid.org/0009-0009-6195-0329)). Free and open source under the Apache License 2.0.

## How it works

1. **Ask:** the person signs in, picks the bill company from the directory, and photographs the bill. The photo is read in their own browser (Tesseract.js) to check that the amount they typed is on the bill. The photo is **not** uploaded.
2. **Checks:**
   - The company must be in the directory, and must accept payments from anyone with the account number.
   - The amount must be at least ₹2,000 or the local equivalent. There is no maximum.
   - The due date must be within the next 60 days, or no more than 90 days overdue.
   - One open request per person.
   - No repeated bills, and no near-identical photos (checked with an image fingerprint).
   - Notes can't contain links, phone numbers or payment handles.
   - There is a bot check (Turnstile, optional).
3. **Pay:** a donor clicks **I'm paying this**. The bill is held for them for 2 hours, and only they see the account number and the company's payment route.
4. **Prove:** the donor uploads the payment receipt. The person then confirms with a photo of the bill stamped or marked paid. A request with a receipt but no stamped bill after 14 days closes as "paid, not confirmed".
5. **Report:** three reports from different people hide a request until the admin reviews it. Two removals block the account.
6. **Delete:** account numbers are erased when a request closes. Requests and proofs are deleted 30 days later, and only anonymous counts remain. People can delete their request or account at any time.

## Built with (all on Cloudflare's free plan)

| Part | What |
|---|---|
| `src/worker.js`, `src/server.js` | Cloudflare Worker: API, GitHub sign-in, checks, proofs, daily clean-up (cron 00:30 UTC) |
| `src/logic.js` | Rules: minimum amounts per currency, dates, notes, duplicates |
| `src/seed.js` | First directory entries (India, through Bharat BillPay) |
| D1 database `DB` | Requests, claims, reports, directory, and the payment proofs themselves (no separate storage service needed) |
| `public/` | The website: browse, request page, ask for help, my page, directory, how it works, admin |
| `public/billread.js` | Finds amounts, dates and company names in the text read from a bill photo |

## Set up (one time, about 15 minutes)

### 1. GitHub repository
Create a public repository `tideover` and upload everything in this folder. The hidden `.gitignore` is optional.

### 2. GitHub sign-in app
1. On GitHub go to **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name:** `TideOver`
   - **Homepage URL:** `https://tideover.randomthingsonlineatsk.workers.dev`
   - **Authorization callback URL:** `https://tideover.randomthingsonlineatsk.workers.dev/auth/github/callback`
3. Click **Register application**. Copy the **Client ID**, then click **Generate a new client secret** and copy the secret. Keep it private.

### 3. Cloudflare
1. Go to **Workers & Pages → Create → Import a repository** and pick `tideover`. Leave the build command empty and keep the deploy command `npx wrangler deploy`.
2. The first deploy creates the D1 database automatically.
3. Open the **tideover** Worker, then **Settings → Variables and Secrets**. Add two **secrets**:
   - `GITHUB_CLIENT_ID`: the Client ID
   - `GITHUB_CLIENT_SECRET`: the client secret
4. Optional bot check: in **Turnstile**, add a widget for the site. Put its site key in `TURNSTILE_SITEKEY` in `wrangler.jsonc` and its secret as the secret `TURNSTILE_SECRET`.

If the site address is different from `tideover.randomthingsonlineatsk.workers.dev`, use the real address in the GitHub OAuth app and in the `og:` lines of `public/index.html`.

The admin is the GitHub user named in `ADMIN_LOGINS` in `wrangler.jsonc` (currently `randomthingsonlineatsk-cloud`). Several logins can be separated by commas.

**If the first deploy fails at "provisioning":** in Cloudflare create a D1 database named `tideover` (**Storage & Databases → D1 → Create**), copy its ID, and add `"database_id": "<the ID>"` to the `d1_databases` entry in `wrangler.jsonc`.

## Adding bill companies

Requests can only be posted for companies in the directory. People can suggest companies. The admin adds them on the **Admin** page, after opening the company's official website and confirming that anyone can pay a bill with only the account number. India starts with 15 companies paid through Bharat BillPay ("Pay bills" in any UPI app).

## Limits you should know

- The bill-reading check runs in the browser, so a determined person can get around it. The directory, duplicate checks, proofs and reports still apply. The site never says a bill is "verified".
- Sign-in is GitHub only for now. Most people who need help don't have GitHub, so add Google sign-in or passkeys before a public launch.
- With no maximum amount, a large fake request could draw more money before it is caught.
- Proof photos are stored in the D1 database, which allows 500 MB on the free plan. Proofs are deleted 30 days after a request closes.
- This is not legal advice. Have the terms and privacy notice reviewed before a public launch.

## Develop

```bash
npm install
npm test                 # offline tests (server rules, journey, clean-up, bill reading)
npx wrangler dev         # local server with a local database; put GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .dev.vars
```

## License

Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed. Licensed under the [Apache License 2.0](LICENSE). Keep the [NOTICE](NOTICE) file if you reuse or adapt this code.
