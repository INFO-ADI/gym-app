<?php
// Every request that isn't a real file comes here (see .htaccess) and is sent to the right page:
//   kanpurgym.com/            landing page
//   kanpurgym.com/admin/      super admin panel
//   <slug>.kanpurgym.com/     a gym's app          (or kanpurgym.com/g/<slug>/ when wildcard subdomains aren't set up)
declare(strict_types=1);
require __DIR__ . '/inc/lib.php';

$hostPort = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
$host = preg_replace('/:\d+$/', '', $hostPort);
if (!preg_match('/^[a-z0-9.-]{1,253}$/', $host) || !preg_match('/^[a-z0-9.-]+(:\d{1,5})?$/', $hostPort)) { http_response_code(400); exit; }
$path = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
$base = BASE_DOMAIN;

if ($host === 'www.' . $base) {                       // one address for the main site
    header('Location: https://' . $base . $path, true, 301);
    exit;
}

$slug = null;
$prefix = '/';
if (substr($host, -strlen('.' . $base)) === '.' . $base) {
    $sub = substr($host, 0, -strlen('.' . $base));
    if (!preg_match(SLUG_RE, $sub)) not_found('Page not found', 'This address is not a gym on ' . SITE_NAME . '.');
    $slug = $sub;
} elseif (preg_match('#^/g/([a-z0-9-]{1,40})(/.*)?$#', $path, $m)) {
    if (!preg_match(SLUG_RE, $m[1])) not_found('Gym not found', 'Check the link the gym gave you.');
    if (!isset($m[2])) { header('Location: /g/' . $m[1] . '/', true, 301); exit; }
    $slug = $m[1];
    $prefix = '/g/' . $slug . '/';
    $path = $m[2];
}

// ------------------------------------------------------------------ main site
if ($slug === null) {
    $siteCfg = ['url' => SUPABASE_URL, 'key' => SUPABASE_KEY, 'domain' => $base, 'site' => SITE_NAME];
    switch ($path) {
        case '/':
        case '/index.html':
            send_headers('text/html; charset=utf-8');
            echo render('landing.html', ['V' => e(VERSION), 'SITE' => e(SITE_NAME), 'DOMAIN' => e($base)]);
            exit;
        case '/admin':
            header('Location: /admin/', true, 301);
            exit;
        case '/admin/':
            send_headers('text/html; charset=utf-8');
            header('X-Robots-Tag: noindex, nofollow');
            echo render('admin.html', ['V' => e(VERSION), 'SITE' => e(SITE_NAME)]);
            exit;
        case '/site-config.js':
            send_headers('application/javascript; charset=utf-8', false);
            header('Cache-Control: no-cache');
            echo 'window.SITE_CONFIG = ' . js_json($siteCfg) . ";\n";
            exit;
        case '/terms':
        case '/privacy':
        case '/refunds':
        case '/contact':
        case '/shipping':
            send_headers('text/html; charset=utf-8');
            $pages = ['/terms' => 'Terms of service', '/privacy' => 'Privacy policy', '/refunds' => 'Cancellation and refunds', '/contact' => 'Contact us', '/shipping' => 'Shipping and delivery'];
            echo render('policy-' . substr($path, 1) . '.html', ['V' => e(VERSION), 'SITE' => e(SITE_NAME), 'DOMAIN' => e($base), 'TITLE' => e($pages[$path])]);
            exit;
        case '/pay':
            send_headers('text/html; charset=utf-8');
            header('X-Robots-Tag: noindex');
            echo render('pay.html', ['V' => e(VERSION), 'SITE' => e(SITE_NAME)]);
            exit;
        case '/robots.txt':
            header('Content-Type: text/plain');
            echo "User-agent: *\nDisallow: /admin/\nDisallow: /g/\n";
            exit;
    }
    not_found('Page not found', 'This page does not exist.');
}

// ------------------------------------------------------------------ a gym's app
$r = gym_brand($slug);
if (isset($r['error'])) { http_response_code(503); send_headers('text/plain; charset=utf-8', false); echo "The app can't reach its database right now. Please try again in a minute."; exit; }
if (empty($r['found'])) not_found('Gym not found', 'This gym is not on ' . SITE_NAME . '. Check the link the gym gave you.');
$b = $r['brand'];
$c = brand_colors($b);
$name = (string)($b['name'] ?? 'Gym');
$short = (string)($b['short_name'] ?? $name);
$v = substr(sha1(VERSION . '|' . json_encode($b)), 0, 12);
$appUrl = scheme() . '://' . $hostPort . $prefix;
$values = ['V' => e($v), 'TITLE' => e($name), 'THEME_COLOR' => e($c['bg']), 'ICON' => e(brand_icon($b, 'icon-192.png')),
           'APPLE_ICON' => e(brand_icon($b, 'apple-touch-icon.png'))];

switch ($path) {
    case '/':
    case '/index.html':
        send_headers('text/html; charset=utf-8');
        echo render('app.html', $values);
        exit;
    case '/setup':
        send_headers('text/html; charset=utf-8');
        header('X-Robots-Tag: noindex, nofollow');
        echo render('setup.html', $values);
        exit;
    case '/config.js':
        send_headers('application/javascript; charset=utf-8', false);
        header('Cache-Control: no-cache');
        echo 'window.GYM_CONFIG = ' . js_json(['url' => SUPABASE_URL, 'key' => SUPABASE_KEY, 'slug' => $slug, 'base' => $appUrl,
            'name' => $name, 'domain' => $base, 'site' => SITE_NAME]) . ";\n";
        exit;
    case '/theme.css':
        send_headers('text/css; charset=utf-8', false);
        header('Cache-Control: public, max-age=300');
        $lin = function ($h) { $v = hexdec($h) / 255; return $v <= 0.03928 ? $v / 12.92 : pow(($v + 0.055) / 1.055, 2.4); };
        $acc = ltrim($c['accent'], '#');
        $lum = 0.2126 * $lin(substr($acc, 0, 2)) + 0.7152 * $lin(substr($acc, 2, 2)) + 0.0722 * $lin(substr($acc, 4, 2));
        $ink = $lum > 0.36 ? '#111111' : '#ffffff';
        echo ":root{--a1:{$c['a1']};--a2:{$c['a2']};--a3:{$c['a3']};--accent:{$c['accent']};--accent-ink:$ink}\n:root:not([data-theme=light]){--bg:{$c['bg']}}\n";
        exit;
    case '/manifest.webmanifest':
        send_headers('application/manifest+json; charset=utf-8', false);
        header('Cache-Control: public, max-age=300');
        echo json_encode(['id' => './', 'name' => $name, 'short_name' => $short, 'description' => 'Members, renewals, payments and shop for ' . $name,
            'start_url' => './', 'scope' => './', 'display' => 'standalone', 'orientation' => 'portrait',
            'background_color' => $c['bg'], 'theme_color' => $c['bg'],
            'icons' => [
                ['src' => brand_icon($b, 'icon-192.png'), 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'],
                ['src' => brand_icon($b, 'icon-512.png'), 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'],
                ['src' => brand_icon($b, 'maskable-512.png'), 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable']]],
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        exit;
    case '/sw.js':
        send_headers('application/javascript; charset=utf-8', false);
        header('Cache-Control: no-cache');
        $shell = ['./', "config.js?v=$v", "theme.css?v=$v", "manifest.webmanifest?v=$v", "/assets/app.css?v=$v", "/assets/app.js?v=$v",
                  "/assets/qrcode.js?v=$v", "/assets/supabase.js?v=$v"];
        echo render('sw.js', ['SLUG' => $slug, 'HASH' => $v, 'SHELL' => json_encode($shell, JSON_UNESCAPED_SLASHES)]);
        exit;
}
not_found('Page not found', 'This page does not exist.');
