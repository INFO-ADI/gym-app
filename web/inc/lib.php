<?php
declare(strict_types=1);
require __DIR__ . '/config.php';

const SLUG_RE = '/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/';
const HEX_RE = '/^#[0-9a-f]{6}$/';

function e(string $s): string { return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

function js_json($v): string {
    return json_encode($v, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function supabase_origin(): string {
    $u = parse_url(SUPABASE_URL);
    return ($u['scheme'] === 'http' ? 'http' : 'https') . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '');
}

function scheme(): string {
    if ((!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') return 'https';
    return 'http';
}

/** Security headers for every page. $connect / $img add allowed origins. */
function send_headers(string $type, bool $html = true): void {
    header('Content-Type: ' . $type);
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    if ($html) {
        $s = supabase_origin();
        $w = preg_replace('/^https:/', 'wss:', $s);
        // Razorpay Checkout (auto-pay set-up) loads its script and opens its own secure frame
        $rz = 'https://checkout.razorpay.com https://api.razorpay.com';
        header("Content-Security-Policy: default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; " .
            "img-src 'self' data: blob: $s https://*.razorpay.com; frame-src $rz; " .
            "connect-src 'self' $s $w https://api.razorpay.com https://lumberjack.razorpay.com; manifest-src 'self'; worker-src 'self'; " .
            "base-uri 'none'; form-action 'self' https://api.razorpay.com; object-src 'none'; frame-ancestors 'none'");
        header('X-Frame-Options: DENY');
        header('Permissions-Policy: camera=(self), microphone=(), geolocation=()');
        header('Cache-Control: no-cache');
    }
}

/** Calls a public database function the same way the browser does (publishable key only). */
function supabase_rpc(string $fn, array $args): ?array {
    $url = rtrim(SUPABASE_URL, '/') . '/rest/v1/rpc/' . $fn;
    $body = json_encode($args);
    $headers = ['apikey: ' . SUPABASE_KEY, 'Content-Type: application/json', 'Accept: application/json'];
    $raw = false;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 6]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code !== 200) $raw = false;
    } else {
        $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => implode("\r\n", $headers), 'content' => $body, 'timeout' => 6, 'ignore_errors' => false]]);
        $raw = @file_get_contents($url, false, $ctx);
    }
    if ($raw === false) return null;
    $j = json_decode((string)$raw, true);
    return is_array($j) ? $j : null;
}

/**
 * A gym's public branding (name, colours, logo), cached for a minute so pages stay fast.
 * Returns ['found' => true, 'brand' => [...]], ['found' => false] or ['error' => 'unreachable'].
 */
function gym_brand(string $slug): array {
    if (!preg_match(SLUG_RE, $slug)) return ['found' => false];
    $file = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'kg_brand_' . md5(SUPABASE_URL) . '_' . $slug . '.json';
    $cached = is_file($file) ? json_decode((string)@file_get_contents($file), true) : null;
    $age = is_file($file) ? time() - (int)@filemtime($file) : PHP_INT_MAX;
    if (is_array($cached) && $age < ($cached['found'] ? 60 : 20)) return $cached;
    $r = supabase_rpc('site_api', ['p_action' => 'brand', 'p_in' => ['slug' => $slug]]);
    if ($r === null) return is_array($cached) ? $cached : ['error' => 'unreachable'];
    $out = !empty($r['ok']) ? ['found' => true, 'brand' => $r['data']] : ['found' => false];
    @file_put_contents($file, json_encode($out), LOCK_EX);
    return $out;
}

/** Colours from the database are checked again before they go into CSS or HTML. */
function brand_colors(array $b): array {
    $d = ['a1' => '#ffb300', 'a2' => '#ff6a00', 'a3' => '#ff2e63', 'accent' => '#ff8a00', 'bg' => '#0f1115'];
    $c = is_array($b['colors'] ?? null) ? $b['colors'] : [];
    foreach ($d as $k => $v) $d[$k] = (is_string($c[$k] ?? null) && preg_match(HEX_RE, $c[$k])) ? $c[$k] : $v;
    return $d;
}

function brand_icon(array $b, string $file): string {
    $v = (int)($b['logo_version'] ?? 0);
    if ($v > 0 && preg_match(SLUG_RE, (string)($b['slug'] ?? ''))) {
        return rtrim(SUPABASE_URL, '/') . '/storage/v1/object/public/brand/' . $b['slug'] . '/v' . $v . '/' . $file;
    }
    return '/assets/icons/' . $file;
}

/** Fills {{NAME}} placeholders in a template; values must already be escaped for where they go. */
function render(string $template, array $values): string {
    $t = (string)file_get_contents(__DIR__ . '/../templates/' . $template);
    return preg_replace_callback('/\{\{([A-Z_]+)\}\}/', fn($m) => $values[$m[1]] ?? '', $t);
}

function not_found(string $title, string $text): void {
    http_response_code(404);
    send_headers('text/html; charset=utf-8');
    echo render('notfound.html', ['TITLE' => e($title), 'TEXT' => e($text), 'HOME' => e(scheme() . '://' . BASE_DOMAIN . '/'), 'V' => e(VERSION)]);
    exit;
}
