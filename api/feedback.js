const { getSupabase } = require('./lib/supabase');

module.exports = async function handler(req, res) {
  const supabase = getSupabase();

  if (req.method === 'POST') {
    const { name, message, page } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const { error } = await supabase
      .from('feedback')
      .insert({
        name: name || 'Anonymous',
        message: message.trim(),
        page: page || 'Dashboard',
      });

    if (error) {
      console.error('Feedback insert error:', error);
      return res.status(500).json({ error: 'Failed to save feedback' });
    }

    return res.json({ success: true });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('feedback')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Feedback fetch error:', error);
      return res.status(500).json({ error: 'Failed to load feedback' });
    }

    return res.json({ feedback: data, count: data.length });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
