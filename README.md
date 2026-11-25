# Gym Manager

A free, installable gym app (Android/iPhone via "Add to Home screen") for one gym:
members, renewals, WhatsApp reminders, UPI-QR payments, a small shop, announcements and reports.

- **Website:** GitHub Pages (this repo)
- **Database, logins, photos:** Supabase (free plan)
- **Cost:** ₹0

## How it is protected

- All data lives in Supabase. Every table is locked (row level security on, no direct access).
  The app can only call `gym_api()`, which checks who is asking before every action — see `supabase/schema.sql`.
- Owner logs in with email + password (Supabase Auth). Members log in with phone + 6-digit PIN
  (bcrypt-hashed, 5 wrong tries locks it for 15 minutes, members must set their own PIN).
- Prices, totals and expiry dates are calculated in the database, never trusted from the phone.
  A payment can only be confirmed once, by the owner.
- Strict Content Security Policy, no HTML from users is ever rendered, product photos are
  re-saved as fresh JPEGs and only the owner can upload them.
- The values in `config.js` (project URL + publishable key) are meant to be public.
  **Never** put the `service_role` / secret key in this repo.

## First run

1. `supabase/schema.sql` is run once in the Supabase project (SQL Editor).
2. Supabase → Authentication: turn **off** "Confirm email"; set **Site URL** to the GitHub Pages address.
3. Open `setup.html` on the website, enter the private setup key (kept offline, not in this repo) and the gym details.
4. Setup locks itself in the database immediately, and the `maintenance` GitHub Action deletes `setup.html` within the hour.
5. Supabase → Authentication: turn **off** "Allow new users to sign up".

## Maintenance (automatic)

`.github/workflows/maintenance.yml` runs hourly: it removes the setup page after setup, pings the database so the
free Supabase project doesn't pause, and makes a tiny monthly commit so GitHub keeps the schedule running.
