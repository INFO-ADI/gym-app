<?php
// Site settings. Only the PUBLISHABLE Supabase key belongs here (it is public by design).
// Never put the secret / service_role key on the website.
const SUPABASE_URL = 'https://ywsnaangjlkpvwfvcoxa.supabase.co';
const SUPABASE_KEY = 'sb_publishable_B6rX4JDwh3A3CHfs1jmCcQ_gUrgePI5';
const BASE_DOMAIN  = 'kanpurgym.com';      // gyms live at <slug>.kanpurgym.com (or kanpurgym.com/g/<slug>/)
const SITE_NAME    = 'KanpurGym';
const VERSION      = 'dev';                // the deploy job replaces this with the commit id (cache busting)
