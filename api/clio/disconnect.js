const { parseCookies } = require('../lib/clio');
const { getSupabase } = require('../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cookies = parseCookies(req.headers.cookie);
  const userEmail = cookies.clio_user ? decodeURIComponent(cookies.clio_user) : null;

  if (!userEmail) {
    return res.json({ success: true });
  }

  try {
    const supabase = getSupabase();
    await supabase
      .from('clio_tokens')
      .delete()
      .eq('user_email', userEmail);
  } catch (err) {
    console.error('Disconnect error:', err);
  }

  // Clear session cookie
  res.setHeader('Set-Cookie', 'clio_user=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ success: true });
};
