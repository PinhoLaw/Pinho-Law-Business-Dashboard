const { getSupabase } = require('./supabase');

const CLIO_API_BASE = 'https://app.clio.com';
const CLIO_TOKEN_URL = `${CLIO_API_BASE}/oauth/token`;
const CLIO_AUTHORIZE_URL = `${CLIO_API_BASE}/oauth/authorize`;
const CLIO_API_V4 = `${CLIO_API_BASE}/api/v4`;

// Rate limiting: track requests per minute
let requestLog = [];
const RATE_LIMIT = 45; // stay under Clio's 50/min limit

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  // Remove requests older than 60 seconds
  requestLog = requestLog.filter(t => now - t < 60000);

  if (requestLog.length >= RATE_LIMIT) {
    const waitTime = 60000 - (now - requestLog[0]) + 100;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  requestLog.push(Date.now());
  return fetch(url, options);
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(CLIO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.CLIO_CLIENT_ID,
      client_secret: process.env.CLIO_CLIENT_SECRET,
      redirect_uri: process.env.CLIO_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(CLIO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.CLIO_CLIENT_ID,
      client_secret: process.env.CLIO_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  return res.json();
}

async function getValidToken(userEmail) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('clio_tokens')
    .select('*')
    .eq('user_email', userEmail)
    .single();

  if (error || !data) {
    throw new Error('No Clio token found for this user');
  }

  // Check if token is expired (with 5 min buffer)
  const expiresAt = new Date(data.expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;

  if (expiresAt.getTime() - bufferMs > now.getTime()) {
    return data.access_token;
  }

  // Refresh the token
  const tokenData = await refreshAccessToken(data.refresh_token);
  const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  await supabase
    .from('clio_tokens')
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: newExpiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_email', userEmail);

  return tokenData.access_token;
}

async function clioApiGet(accessToken, endpoint, params = {}) {
  const url = new URL(`${CLIO_API_V4}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await rateLimitedFetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clio API error (${res.status}): ${err}`);
  }

  return res.json();
}

async function fetchAllPages(accessToken, endpoint, params = {}, maxPages = 5) {
  let allData = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await clioApiGet(accessToken, endpoint, {
      ...params,
      page,
      limit: 200,
    });

    if (result.data) {
      allData = allData.concat(result.data);
    }

    hasMore = result.meta && result.meta.paging && result.meta.paging.next;
    page++;

    // Safety limit - configurable, default 5 pages (1000 records)
    if (page > maxPages) break;
  }

  return allData;
}

function getAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.CLIO_CLIENT_ID,
    redirect_uri: process.env.CLIO_REDIRECT_URI,
    state,
  });
  return `${CLIO_AUTHORIZE_URL}?${params.toString()}`;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...vals] = c.trim().split('=');
    if (key) cookies[key.trim()] = vals.join('=').trim();
  });
  return cookies;
}

module.exports = {
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidToken,
  clioApiGet,
  fetchAllPages,
  getAuthorizeUrl,
  parseCookies,
  CLIO_API_BASE,
};
