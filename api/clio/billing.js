const { getValidToken, clioApiGet, fetchAllPages, parseCookies } = require('../lib/clio');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cookies = parseCookies(req.headers.cookie);
  const userEmail = cookies.clio_user ? decodeURIComponent(cookies.clio_user) : null;

  if (!userEmail) {
    return res.status(401).json({ error: 'Not authenticated with Clio' });
  }

  try {
    const accessToken = await getValidToken(userEmail);

    const { type = 'all', date_from, date_to } = req.query;

    const results = {};

    // Fetch activities (time entries + expense entries)
    if (type === 'all' || type === 'activities') {
      const activityParams = {
        fields: 'id,type,date,quantity,price,total,note,matter{id,display_number,description},user{id,name}',
        order: 'date(desc)',
      };
      if (date_from) activityParams['created_since'] = date_from;
      if (date_to) activityParams['created_before'] = date_to;

      const activities = await fetchAllPages(accessToken, '/activities.json', activityParams);
      results.activities = activities.map(a => ({
        id: a.id,
        type: a.type,
        date: a.date,
        quantity: a.quantity,
        price: a.price,
        total: a.total,
        note: a.note,
        matter_number: a.matter ? a.matter.display_number : '',
        matter_description: a.matter ? a.matter.description : '',
        user_name: a.user ? a.user.name : '',
      }));
    }

    // Fetch bills
    if (type === 'all' || type === 'bills') {
      const billParams = {
        fields: 'id,number,issued_at,due_at,total,balance,state,matter{id,display_number,description}',
        order: 'issued_at(desc)',
      };

      const bills = await fetchAllPages(accessToken, '/bills.json', billParams);
      results.bills = bills.map(b => ({
        id: b.id,
        number: b.number,
        issued_at: b.issued_at,
        due_at: b.due_at,
        total: b.total,
        balance: b.balance,
        state: b.state,
        matter_number: b.matter ? b.matter.display_number : '',
        matter_description: b.matter ? b.matter.description : '',
      }));
    }

    // Compute summary
    if (results.activities) {
      const totalHours = results.activities
        .filter(a => a.type === 'TimeEntry')
        .reduce((sum, a) => sum + (a.quantity || 0), 0);
      const totalBilled = results.activities
        .reduce((sum, a) => sum + (a.total || 0), 0);

      results.summary = {
        total_hours: Math.round(totalHours * 100) / 100,
        total_billed: Math.round(totalBilled * 100) / 100,
        activity_count: results.activities.length,
      };
    }

    if (results.bills) {
      const totalOutstanding = results.bills
        .filter(b => b.state !== 'paid')
        .reduce((sum, b) => sum + (b.balance || 0), 0);

      results.summary = {
        ...(results.summary || {}),
        total_outstanding: Math.round(totalOutstanding * 100) / 100,
        bill_count: results.bills.length,
      };
    }

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.json(results);
  } catch (err) {
    console.error('Billing API error:', err);
    res.status(500).json({ error: err.message });
  }
};
