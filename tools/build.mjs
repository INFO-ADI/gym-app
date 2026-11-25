#!/usr/bin/env node
// Builds one ready-to-host app per gym:  gyms/<slug>/gym.json  ->  dist/<slug>/
// The code in app/ is shared by every gym; only the values in gym.json (and an optional logo.png) differ.
// Usage: node tools/build.mjs            (builds every gym)
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const GYMS = path.join(ROOT, 'gyms');
const DIST = path.join(ROOT, 'dist');

const RULES = {
  slug: /^[a-z0-9-]{2,40}$/,
  supabaseUrl: /^https:\/\/[a-z0-9]{20}\.supabase\.co$/,
  supabaseKey: /^sb_publishable_[A-Za-z0-9_-]+$/,
  color: /^#[0-9a-fA-F]{6}$/,
};
// "shell" would collide with the old app's cache names (gym-shell-…), which the site root deletes.
const RESERVED_SLUGS = new Set(['shell', 'assets', 'app', 'dist', 'tools', 'gyms']);
const ALLOWED_KEYS = new Set(['slug', 'name', 'shortName', 'supabaseUrl', 'supabaseKey', 'colors', 'setupDone', 'legacyToken']);
const COLOR_KEYS = ['a1', 'a2', 'a3', 'accent', 'bg'];
const isPlaceholder = g => /PASTE|YOUR[-_]|XXXX|example/i.test(String(g.supabaseUrl) + String(g.supabaseKey));

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsJson = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));

class BuildError extends Error {}
const fail = (where, msg) => { throw new BuildError(`${where}: ${msg}`); };

/** Strict check of one gym.json. Nothing from gym.json is written anywhere before this passes. */
export function validateGym(g, folder) {
  const where = `gyms/${folder}/gym.json`;
  if (!g || typeof g !== 'object' || Array.isArray(g)) fail(where, 'must be a JSON object');
  for (const k of Object.keys(g)) if (!ALLOWED_KEYS.has(k)) fail(where, `unknown field "${k}"`);
  if (typeof g.slug !== 'string' || !RULES.slug.test(g.slug)) fail(where, 'slug must be 2–40 characters: a-z, 0-9 and "-"');
  if (g.slug !== folder) fail(where, `slug "${g.slug}" must match the folder name "${folder}"`);
  if (RESERVED_SLUGS.has(g.slug)) fail(where, `slug "${g.slug}" is reserved, pick another`);
  for (const k of ['name', 'shortName']) {
    if (typeof g[k] !== 'string' || !g[k].trim()) fail(where, `${k} is required`);
    if (/[\u0000-\u001f\u007f]/.test(g[k])) fail(where, `${k} contains control characters`);
  }
  if (g.name.length > 60) fail(where, 'name must be at most 60 characters');
  if (g.shortName.length > 20) fail(where, 'shortName must be at most 20 characters (it is shown under the app icon)');
  if (typeof g.setupDone !== 'boolean') fail(where, 'setupDone must be true or false');
  if ('legacyToken' in g && typeof g.legacyToken !== 'boolean') fail(where, 'legacyToken must be true or false');
  if (!g.colors || typeof g.colors !== 'object') fail(where, 'colors is required');
  for (const k of Object.keys(g.colors)) if (!COLOR_KEYS.includes(k)) fail(where, `unknown colour "${k}"`);
  for (const k of COLOR_KEYS) if (typeof g.colors[k] !== 'string' || !RULES.color.test(g.colors[k])) fail(where, `colors.${k} must look like #ff6a00`);
  if (typeof g.supabaseUrl !== 'string' || typeof g.supabaseKey !== 'string') fail(where, 'supabaseUrl and supabaseKey are required');
  if (isPlaceholder(g)) return 'placeholder';
  if (!RULES.supabaseUrl.test(g.supabaseUrl)) fail(where, 'supabaseUrl must look like https://abcdefghijklmnopqrst.supabase.co');
  if (!RULES.supabaseKey.test(g.supabaseKey)) fail(where, 'supabaseKey must be the publishable key (starts with sb_publishable_), never the secret key');
  return 'ok';
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function fill(template, values, where) {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in values)) fail(where, `template uses unknown placeholder ${m}`);
    return values[k];
  });
  if (out.includes('{{')) fail(where, 'template still has an unfilled {{…}}');
  return out;
}

async function makeIcons(gym, logoPath, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  if (!logoPath) {
    for (const f of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png']) await fs.copyFile(path.join(APP, 'assets/icons', f), path.join(outDir, f));
    return 'default icons';
  }
  const { default: sharp } = await import('sharp');
  const meta = await sharp(logoPath).metadata();
  if (meta.format !== 'png') fail(`gyms/${gym.slug}/logo.png`, 'must be a PNG file');
  if (Math.min(meta.width, meta.height) < 256) fail(`gyms/${gym.slug}/logo.png`, `is ${meta.width}×${meta.height}; use a square logo of 512×512 or bigger`);
  if (meta.width !== meta.height || meta.width < 512) console.warn(`  ! gyms/${gym.slug}/logo.png is ${meta.width}×${meta.height}; a square 512×512+ logo looks best`);
  const bg = gym.colors.bg;
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const square = size => sharp(logoPath).resize(size, size, { fit: 'contain', background: clear }).png();
  await square(192).toFile(path.join(outDir, 'icon-192.png'));
  await square(512).toFile(path.join(outDir, 'icon-512.png'));
  // iOS fills transparency with black, so give the home-screen icon the gym's background colour
  await sharp(logoPath).resize(180, 180, { fit: 'contain', background: bg }).flatten({ background: bg }).png().toFile(path.join(outDir, 'apple-touch-icon.png'));
  // Android "maskable" icons get cropped to circles/squircles: keep the logo inside the middle 60 % (20 % padding each side)
  const inner = await sharp(logoPath).resize(308, 308, { fit: 'contain', background: clear }).png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: bg } }).composite([{ input: inner, gravity: 'centre' }]).png().toFile(path.join(outDir, 'maskable-512.png'));
  return 'icons from logo.png';
}

async function buildGym(gym, sharedHashInput) {
  const slug = gym.slug;
  const gymDir = path.join(GYMS, slug);
  const out = path.join(DIST, slug);
  const logoPath = existsSync(path.join(gymDir, 'logo.png')) ? path.join(gymDir, 'logo.png') : null;

  // one content hash per gym build: shared code + this gym's settings + its logo
  const h = createHash('sha256').update(sharedHashInput).update(await fs.readFile(path.join(gymDir, 'gym.json')));
  if (logoPath) h.update(await fs.readFile(logoPath));
  const V = h.digest('hex').slice(0, 12);

  const origin = new URL(gym.supabaseUrl).origin;            // validated: https://<20 chars>.supabase.co
  const values = {
    V, TITLE: escHtml(gym.name), THEME_COLOR: gym.colors.bg,
    SUPABASE_HTTPS: origin, SUPABASE_WSS: origin.replace(/^https:/, 'wss:'),
  };

  await fs.mkdir(path.join(out, 'assets'), { recursive: true });
  for (const f of await listFiles(path.join(APP, 'assets'))) {
    if (f.startsWith('icons/')) continue;
    if (f === 'setup.js' && gym.setupDone) continue;
    await fs.mkdir(path.dirname(path.join(out, 'assets', f)), { recursive: true });
    await fs.copyFile(path.join(APP, 'assets', f), path.join(out, 'assets', f));
  }
  const icons = await makeIcons(gym, logoPath, path.join(out, 'assets/icons'));

  await fs.writeFile(path.join(out, 'index.html'), fill(await fs.readFile(path.join(APP, 'index.html'), 'utf8'), values, `${slug}/index.html`));
  if (!gym.setupDone) await fs.writeFile(path.join(out, 'setup.html'), fill(await fs.readFile(path.join(APP, 'setup.html'), 'utf8'), values, `${slug}/setup.html`));

  const cfg = { url: gym.supabaseUrl, key: gym.supabaseKey, slug };
  if (gym.legacyToken) cfg.legacyToken = true;
  await fs.writeFile(path.join(out, 'config.js'), `// Built for ${slug}. Do not edit: change gyms/${slug}/gym.json instead.\nwindow.GYM_CONFIG = ${jsJson(cfg)};\n`);

  const c = gym.colors;
  await fs.writeFile(path.join(out, 'assets/theme.css'),
    `/* ${slug} brand colours (from gyms/${slug}/gym.json). Loaded after app.css. */\n` +
    `:root{--a1:${c.a1};--a2:${c.a2};--a3:${c.a3};--accent:${c.accent}}\n` +
    `:root:not([data-theme=light]){--bg:${c.bg}}\n`);

  // manifest: placeholders are replaced inside parsed JSON strings, then re-serialised, so names can't break the JSON
  const mValues = { NAME: gym.name, SHORT_NAME: gym.shortName, BG: c.bg, V };
  const walk = v => typeof v === 'string' ? v.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => { if (!(k in mValues)) fail('manifest', `unknown ${m}`); return mValues[k]; })
    : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  const manifest = walk(JSON.parse(await fs.readFile(path.join(APP, 'manifest.template.json'), 'utf8')));
  await fs.writeFile(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

  const shell = ['./', 'index.html', `config.js?v=${V}`, `assets/app.css?v=${V}`, `assets/theme.css?v=${V}`, `assets/app.js?v=${V}`,
    `assets/qrcode.js?v=${V}`, `assets/supabase.js?v=${V}`, `assets/icons/icon-192.png?v=${V}`, `manifest.webmanifest?v=${V}`];
  await fs.writeFile(path.join(out, 'sw.js'), fill(await fs.readFile(path.join(APP, 'sw.js'), 'utf8'),
    { SLUG: slug, HASH: V, SHELL: JSON.stringify(shell) }, `${slug}/sw.js`));

  return { V, icons };
}

async function buildRoot(home) {
  const refresh = home ? `<meta http-equiv="refresh" content="0; url=${escHtml(home)}/">\n` : '';
  await fs.writeFile(path.join(DIST, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
${refresh}<title>Gym app</title>
</head>
<body style="font:16px system-ui,sans-serif;background:#0f1115;color:#eee;display:grid;place-items:center;min-height:90vh;text-align:center">
<p>${home ? `Opening the app… <a style="color:#ffb300" href="${escHtml(home)}/">Tap here</a> if nothing happens.` : 'Open the link your gym gave you.'}</p>
</body>
</html>
`);
  // The old single-gym app registered its service worker for the whole site. This replacement
  // removes itself and the old "gym-shell-" caches, so it can never serve or delete another gym's files.
  await fs.writeFile(path.join(DIST, 'sw.js'), `/* Retires the old site-wide service worker. Touches only caches named gym-shell-*. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('gym-shell-')).map(k => caches.delete(k)));
  await self.registration.unregister();
  const wins = await self.clients.matchAll({ type: 'window' });
  wins.forEach(w => { try { w.navigate(w.url); } catch (err) { /* page reloads on its own later */ } });
})()));
`);
}

async function main() {
  const problems = [];
  const warnings = [];
  let site = {};
  if (existsSync(path.join(ROOT, 'site.json'))) {
    try { site = JSON.parse(await fs.readFile(path.join(ROOT, 'site.json'), 'utf8')); } catch (e) { problems.push(`site.json: ${e.message}`); }
    for (const k of Object.keys(site)) if (k !== 'home') problems.push(`site.json: unknown field "${k}"`);
    if (site.home != null && (typeof site.home !== 'string' || !RULES.slug.test(site.home))) problems.push('site.json: home must be a gym slug');
  }

  const gyms = [];
  const folders = existsSync(GYMS) ? (await fs.readdir(GYMS, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort() : [];
  for (const folder of folders) {
    const file = path.join(GYMS, folder, 'gym.json');
    if (!existsSync(file)) { problems.push(`gyms/${folder}: gym.json is missing`); continue; }
    let g;
    try { g = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { problems.push(`gyms/${folder}/gym.json: not valid JSON (${e.message})`); continue; }
    try {
      const state = validateGym(g, folder);
      if (state === 'placeholder') { warnings.push(`skipped ${folder}: paste its Supabase URL and publishable key into gyms/${folder}/gym.json first`); continue; }
      gyms.push(g);
    } catch (e) { if (e instanceof BuildError) problems.push(e.message); else throw e; }
  }
  if (site.home && !gyms.some(g => g.slug === site.home)) problems.push(`site.json: home "${site.home}" is not a gym that can be built`);

  if (problems.length) {
    console.error('Build stopped. Fix these first:\n' + problems.map(p => '  ✗ ' + p).join('\n'));
    process.exit(1);
  }

  // shared code hash input: every file in app/ (path + bytes)
  const sh = createHash('sha256');
  for (const f of await listFiles(APP)) { sh.update(f + '\0'); sh.update(await fs.readFile(path.join(APP, f))); }
  const shared = sh.digest();

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });
  for (const g of gyms) {
    try {
      const r = await buildGym(g, shared);
      console.log(`  ✓ ${g.slug.padEnd(24)} v=${r.V}  ${g.setupDone ? 'setup done' : 'setup page ON'}  ${r.icons}`);
    } catch (e) {
      if (e instanceof BuildError) { console.error('Build stopped: ' + e.message); process.exit(1); }
      throw e;
    }
  }
  await buildRoot(site.home || null);
  for (const w of warnings) console.warn('  ! ' + w);
  console.log(`Built ${gyms.length} gym app${gyms.length === 1 ? '' : 's'} into dist/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
