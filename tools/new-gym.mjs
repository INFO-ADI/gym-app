#!/usr/bin/env node
// Adds a new gym:  node tools/new-gym.mjs <slug> "<Gym Name>"
//  - gyms/<slug>/gym.json              (committed; Supabase URL/key are placeholders until you paste them)
//  - private/<slug>/SETUP-KEY.txt      (NOT committed: private/ is in .gitignore)
//  - private/<slug>/schema.sql         (NOT committed: the full database install with this gym's setup key)
import { createHash, randomInt } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESERVED = new Set(['shell', 'assets', 'app', 'dist', 'tools', 'gyms']);
// no O/0, I/1/L: easy to read out over the phone
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// full install = base schema + every upgrade, in order
const SQL_FILES = ['schema.sql', 'upgrade_2_1.sql', 'upgrade_2_2.sql', 'upgrade_2_3.sql'];

const die = msg => { console.error('✗ ' + msg); process.exit(1); };

export function makeSetupKey() {
  return Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')).join('-');
}

export function schemaWithKey(schemaSql, key) {
  const hash = createHash('sha256').update(key.toUpperCase()).digest('hex');
  const re = /(encode\(extensions\.digest\(upper\(btrim\(coalesce\(p_key, ''\)\)\), 'sha256'\), 'hex'\) <> ')([0-9a-f]{64})(')/g;
  const found = schemaSql.match(re) || [];
  if (found.length !== 1) throw new Error(`expected exactly one setup-key hash in supabase/schema.sql, found ${found.length}`);
  return schemaSql.replace(re, (m, a, old, b) => a + hash + b);
}

async function main() {
  const [slug, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(' ').trim();
  if (!slug || !name) die('Usage: node tools/new-gym.mjs <slug> "<Gym Name>"\n  example: node tools/new-gym.mjs power-house "Power House Gym"');
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) die('slug must be 2–40 characters using only a-z, 0-9 and "-" (it becomes the web address)');
  if (RESERVED.has(slug)) die(`"${slug}" is reserved, pick another slug`);
  if (name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) die('gym name must be 1–60 normal characters');
  const gymDir = path.join(ROOT, 'gyms', slug);
  const privDir = path.join(ROOT, 'private', slug);
  if (existsSync(gymDir)) die(`gyms/${slug} already exists`);
  if (existsSync(privDir)) die(`private/${slug} already exists (delete it first if you really want a new setup key)`);

  const gitignore = existsSync(path.join(ROOT, '.gitignore')) ? await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8') : '';
  if (!/^\/?private\/?$/m.test(gitignore)) die('private/ is not in .gitignore. Add it before creating setup keys.');

  const key = makeSetupKey();
  let sql = '';
  for (const f of SQL_FILES) {
    let part = await fs.readFile(path.join(ROOT, 'supabase', f), 'utf8');
    if (f === 'schema.sql') part = schemaWithKey(part, key);
    sql += `\n-- ===================================================== ${f}\n` + part + '\n';
  }
  const header = `-- Database install for "${name.replace(/[\r\n]/g, ' ')}" (${slug}).\n` +
    `-- Paste ALL of this into a NEW, empty Supabase project: SQL Editor → New query → Run.\n` +
    `-- It contains this gym's setup key fingerprint: keep it private, do not commit it.\n`;

  const gym = {
    slug, name, shortName: name.length <= 20 ? name : name.slice(0, 20).trim(),
    supabaseUrl: 'https://PASTE-YOUR-PROJECT-ID.supabase.co',
    supabaseKey: 'sb_publishable_PASTE_YOUR_KEY_HERE',
    colors: { a1: '#ffb300', a2: '#ff6a00', a3: '#ff2e63', accent: '#ff8a00', bg: '#0f1115' },
    setupDone: false,
  };

  await fs.mkdir(gymDir, { recursive: true });
  await fs.mkdir(privDir, { recursive: true });
  await fs.writeFile(path.join(gymDir, 'gym.json'), JSON.stringify(gym, null, 2) + '\n');
  await fs.writeFile(path.join(privDir, 'schema.sql'), header + sql);
  await fs.writeFile(path.join(privDir, 'SETUP-KEY.txt'),
    `Gym: ${name} (${slug})\nSetup key: ${key}\n\nThe gym owner types this once on https://info-adi.github.io/gym-app/${slug}/setup.html\nKeep it private. Never commit it.\n`, { mode: 0o600 });

  console.log(`
✓ Created gyms/${slug}/gym.json
✓ Setup key: ${key}   (saved in private/${slug}/SETUP-KEY.txt, not committed)
✓ Database install: private/${slug}/schema.sql

Next steps:
 1. Make a free Supabase account using the GYM'S OWN email, then create a project (region: Mumbai).
 2. SQL Editor → New query → paste ALL of private/${slug}/schema.sql → Run.
 3. Authentication → Sign In / Providers → Email: turn OFF "Confirm email".
    Authentication → URL Configuration → Site URL: https://info-adi.github.io/gym-app/${slug}/
 4. Project Settings → API Keys: copy the Project URL and the PUBLISHABLE key into gyms/${slug}/gym.json
    (never the secret / service_role key).
 5. Optional: change the colours in gym.json and add gyms/${slug}/logo.png (square, 512×512 or bigger).
 6. Commit and push to main. GitHub builds and publishes it in about a minute.
 7. Open https://info-adi.github.io/gym-app/${slug}/setup.html and enter the setup key.
 8. Back in Supabase: Authentication → Sign In / Providers: turn OFF "Allow new users to sign up".
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => die(e.message));
}
