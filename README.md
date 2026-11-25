# KanpurGym: gym management app, sold to many gyms

One website, one database, every gym gets its own branded app:

| Address | What it is |
|---|---|
| `kanpurgym.com` | Landing page with prices and a "book a free demo" form |
| `kanpurgym.com/admin/` | Super admin panel: create gyms, trials, payments, leads |
| `<gym>.kanpurgym.com` | That gym's app for the owner and members (installable PWA) |
| `kanpurgym.com/g/<gym>/` | Same app, used when wildcard subdomains are off (Admin → Settings) |

## How a new gym goes live (about 2 minutes)
1. Admin → **New gym**: name, owner WhatsApp, colours, logo → **Create gym app**.
2. Tap **Send on WhatsApp**. The owner gets the link and a one-time setup code.
3. The owner opens the link, enters gym details, plans, UPI ID and a password. Done.
4. The free trial (30 days by default) starts when the gym is created. Record payments in the gym page; the paid period is added after the trial or the current paid period.
5. If the subscription is not renewed, the app shows "Subscription ended" after the grace days. The data stays safe; one payment switches it back on.

## Folders
- `web/`: everything uploaded to Hostinger `public_html` (PHP 8 router + static assets)
  - `index.php` decides landing / admin / gym app from the address
  - `inc/config.php`: Supabase URL and **publishable** key, domain, site name
  - `templates/`: HTML pages; `assets/`: JS, CSS, icons
- `supabase/`: database. Fresh project: run `schema.sql`, `upgrade_2_1.sql`, `upgrade_2_2.sql`, `upgrade_2_3.sql`, `saas_3_0.sql` in order.

## Security model
- One shared database. Every gym table has `gym_id` with row level security; the app API runs as a role that cannot bypass it, so a gym can only ever see its own rows.
- The website only holds the publishable key. Never put the secret/service_role key in this repo.
- Owners log in with Supabase Auth; members log in with phone + PIN. Logins are stored per gym in the browser.
- The super admin is created once with the admin setup key (kept outside the repo).

## Deploy
Pushes to `main` upload `web/` to Hostinger by FTP when the `FTP_SERVER`, `FTP_USERNAME` and `FTP_PASSWORD` repository secrets exist. A daily job keeps the free Supabase project awake.
