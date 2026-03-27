const { parseCookies } = require('../lib/clio');
const { getSupabase } = require('../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cookies = parseCookies(req.headers.cookie);
  const userEmail = cookies.clio_user ? decodeURIComponent(cookies.clio_user) : null;

  if (!userEmail) {
    return res.json({ connected: false });
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('clio_tokens')
      .select('clio_user_name, clio_user_id, expires_at')
      .eq('user_email', userEmail)
      .single();

    if (error || !data) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      userName: data.clio_user_name,
      userEmail,
    });
  } catch (err) {
    console.error('Status check error:', err);
    res.json({ connected: false });
  }
};
