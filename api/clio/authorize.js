const crypto = require('crypto');
const { getAuthorizeUrl } = require('../lib/clio');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Generate random state for CSRF protection
  const state = crypto.randomBytes(32).toString('hex');

  // Store state in a cookie for validation on callback
  res.setHeader('Set-Cookie', `clio_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);

  const authorizeUrl = getAuthorizeUrl(state);
  res.redirect(302, authorizeUrl);
};
