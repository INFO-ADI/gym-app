# Gym app: one codebase, a separate app for every gym

This repo builds a separate branded app for every gym you sell to. Each gym gets:

- its **own app**: name, logo, colours and home-screen icon
- its **own web address**: `https://info-adi.github.io/gym-app/<slug>/`
- its **own database**: a separate free Supabase project, so gyms never share data

All gyms run **the same code**. Fix a bug or add a feature once, push it, and every gym gets it within a minute or two.

Running cost: **₹0** (GitHub Pages + free Supabase).

---

## How the folders work

| Folder / file | What it is | Shared or per gym? |
|---|---|---|
| `app/` | The app itself: screens, styles, service worker, setup page (with `{{…}}` placeholders) | Shared by every gym |
| `supabase/` | Database code: `schema.sql`, then `upgrade_2_1.sql`, `upgrade_2_2.sql`, `upgrade_2_3.sql`. Don't run these by hand for a new gym. `new-gym` combines them with that gym's setup key (the template's key slot is blank on purpose) | Shared |
| `gyms/<slug>/gym.json` | That gym's name, colours, Supabase address and key, and whether setup is done | Per gym |
| `gyms/<slug>/logo.png` | Optional square logo (512×512 or bigger). Icons are made from it automatically | Per gym |
| `tools/build.mjs` | Builds `dist/<slug>/` for every gym | — |
| `tools/new-gym.mjs` | Adds a new gym and creates its secret setup key | — |
| `private/` | Setup keys and each gym's database file. **Never committed** (it's in `.gitignore`) | Per gym, only on your computer |
| `site.json` | `"home"`: the gym that opens if someone visits the bare site address | — |
| `dist/` | Build output (not committed; GitHub builds it) | — |

`gym.json` looks like this:

```json
{
  "slug": "power-house",
  "name": "Power House Gym",
  "shortName": "Power House",
  "supabaseUrl": "https://abcdefghijklmnopqrst.supabase.co",
  "supabaseKey": "sb_publishable_…",
  "colors": { "a1": "#ffb300", "a2": "#ff6a00", "a3": "#ff2e63", "accent": "#ff8a00", "bg": "#0f1115" },
  "setupDone": false
}
```

- `a1 → a2 → a3` is the gradient used on buttons and charts. `accent` is used for small highlights, and `bg` is the app background.
- `shortName` (20 characters or fewer) is the name shown under the phone icon.
- Only ever paste the **publishable** key (`sb_publishable_…`). Never use the secret / service_role key. The build refuses anything else.

The build checks every `gym.json` strictly and stops on anything wrong, such as a bad colour, a wrong Supabase address or an unknown field. A gym whose URL and key are still placeholders is skipped with a warning.

---

## Add a new gym (step by step)

You need Node 20+ on your computer. Run this once in the repo: `npm install`.

1. **Create the gym:**
   ```
   node tools/new-gym.mjs power-house "Power House Gym"
   ```
   This makes `gyms/power-house/gym.json` and, in the git-ignored `private/power-house/` folder:
   - `SETUP-KEY.txt` holds the gym's secret setup key (like `K7QM-3XRA-…`)
   - `schema.sql` holds the full database install with that key built in

2. **Make a free Supabase account for this gym, using the gym's own email** (not yours).
   Each free Supabase account allows only **2 active projects**, so every gym needs its own account. Then create a project (region: Mumbai).

3. In that project, open **SQL Editor → New query**, paste **all** of `private/power-house/schema.sql` and click **Run**.

4. Change two Authentication settings:
   - **Sign In / Providers → Email:** turn **off** "Confirm email".
   - **URL Configuration → Site URL:** set it to `https://info-adi.github.io/gym-app/power-house/`

5. Under **Project Settings → API Keys**, copy the **Project URL** and the **publishable key** into `gyms/power-house/gym.json`.

6. Optional: change the colours in `gym.json` and add `gyms/power-house/logo.png` (square PNG, 512×512 or bigger).

7. Check it builds:
   ```
   node tools/build.mjs
   ```
   Then commit and push to `main`. GitHub builds and publishes it in about a minute.

8. Open `https://info-adi.github.io/gym-app/power-house/setup.html`. Enter the **setup key** and the gym details, create the owner login, and choose whether to add demo data.

9. Back in Supabase, go to **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up". The owner can still log in, but nobody else can create accounts.

Within the hour, the maintenance job notices that setup is done. It sets `"setupDone": true` and removes that gym's setup page from the website automatically. You can also set it yourself and push.

Give the owner the app link. Members open it on their phones and tap **Add to Home screen**.

> **Tip for selling:** make a gym called `demo` with demo data turned on during setup. Show it to gym owners on your phone. It already has members, payments, PT clients, batches, offers and charts.

---

## How updates reach every gym

- Change anything in `app/` or `supabase/`, then push to `main`.
- The **deploy** workflow builds every gym and publishes them all together.
- Each gym's files get a new version code (a hash), so phones download the new version the next time the app is opened.

**Database changes** are different, because every gym has its own database:

1. Write a new upgrade file, such as `supabase/upgrade_2_4.sql`.
2. Run it once in **each** gym's Supabase SQL Editor.
3. Add it to `SQL_FILES` in `tools/new-gym.mjs`, so new gyms get it automatically.

---

## Remove a gym

1. Delete its folder in `gyms/` and push. Its app disappears from the website within a minute or two.
2. If you're asked to, delete its project in that gym's Supabase account.
3. Delete its `private/<slug>/` folder from your computer.

If that gym was the `home` in `site.json`, change `home` to another gym (or remove it).

---

## GitHub settings (one time)

- **Settings → Pages → Build and deployment → Source: "GitHub Actions"**
- **Settings → Actions → General → Workflow permissions: "Read and write permissions"**

---

## Automatic jobs

- **deploy** (on every push to `main`, or run by hand from the Actions tab): builds and publishes all gyms.
- **maintenance** (every hour) does three things:
  - Pings every gym's database, so free Supabase projects never pause.
  - Hides a gym's setup page once its setup is done.
  - Makes a tiny commit once a month, so GitHub keeps the hourly job switched on.

---

## Safety notes

- Each gym's database only answers through one locked-down function (`gym_api`). All tables are closed to the public.
- Member logins are stored per gym on the phone (`gym_member_token_<slug>`). Each gym's offline cache is named `gym-<slug>-<hash>`, so gyms on the same phone or browser never mix data.
- Setup keys exist only in `private/` on your computer. The database stores just a fingerprint (hash) of each key. Never commit `private/`.
