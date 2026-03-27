const { exchangeCodeForTokens, clioApiGet, parseCookies } = require('../lib/clio');
const { getSupabase } = require('../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?clio_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return res.redirect('/?clio_error=missing_params');
  }

  // Validate state
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.clio_oauth_state !== state) {
    return res.redirect('/?clio_error=invalid_state');
  }

  try {
    // Exchange code for tokens
    const tokenData = await exchangeCodeForTokens(code);
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    // Try to fetch user info, but don't fail if it's forbidden
    let userEmail = 'admin@pinholaw.com';
    let userName = 'Pinho Law';
    let userId = 'default';

    try {
      const userInfo = await clioApiGet(tokenData.access_token, '/users/who_am_i.json', {
        fields: 'id,name,email',
      });
      if (userInfo && userInfo.data) {
        userEmail = userInfo.data.email || userEmail;
        userName = userInfo.data.name || userName;
        userId = String(userInfo.data.id || userId);
      }
    } catch (userErr) {
      console.log('Could not fetch Clio user info (using defaults):', userErr.message);
    }

    // Store tokens in Supabase
    const supabase = getSupabase();
    const { error: dbError } = await supabase
      .from('clio_tokens')
      .upsert({
        user_email: userEmail,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt.toISOString(),
        clio_user_id: userId,
        clio_user_name: userName,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_email' });

    if (dbError) {
      console.error('Supabase error:', dbError);
      return res.redirect('/?clio_error=db_error');
    }

    // Set session cookie
    res.setHeader('Set-Cookie', [
      `clio_user=${encodeURIComponent(userEmail)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      'clio_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);

    res.redirect('/?clio_connected=true');
  } catch (err) {
    console.error('Clio callback error:', err);
    res.redirect(`/?clio_error=${encodeURIComponent(err.message)}`);
  }
};
