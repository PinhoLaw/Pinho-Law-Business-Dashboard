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
      if (date_from) activityParams['created_since'] = date_from + 'T00:00:00+00:00';
      if (date_to) activityParams['created_before'] = date_to + 'T23:59:59+00:00';

      let activities = [];
      try {
        activities = await fetchAllPages(accessToken, '/activities.json', activityParams);
      } catch (e) {
        // If matter/user fields fail, try without them
        console.log('Retrying activities without association fields:', e.message);
        activityParams.fields = 'id,type,date,quantity,price,total,note';
        activities = await fetchAllPages(accessToken, '/activities.json', activityParams);
      }

      results.activities = activities.map(a => ({
        id: a.id,
        type: a.type,
        date: a.date,
        quantity: a.quantity,
        price: a.price,
        total: a.total,
        note: a.note || '',
        matter_number: a.matter ? (a.matter.display_number || a.matter.id || '') : '',
        matter_description: a.matter ? (a.matter.description || '') : '',
        user_name: a.user ? (a.user.name || '') : '',
      }));
    }

    // Fetch bills with client and matter associations
    if (type === 'all' || type === 'bills') {
      const billParams = {
        fields: 'id,number,issued_at,due_at,total,balance,state,client{id,name},matters{id,display_number,description}',
        order: 'issued_at(desc)',
      };
      if (date_from) billParams['issued_since'] = date_from + 'T00:00:00+00:00';
      if (date_to) billParams['issued_before'] = date_to + 'T23:59:59+00:00';

      let bills = [];
      try {
        bills = await fetchAllPages(accessToken, '/bills.json', billParams);
      } catch (e) {
        // If association fields fail, try simpler fields
        console.log('Retrying bills without association fields:', e.message);
        billParams.fields = 'id,number,issued_at,due_at,total,balance,state';
        bills = await fetchAllPages(accessToken, '/bills.json', billParams);
      }

      results.bills = bills.map(b => {
        // Extract matter info - could be in 'matter', 'matters', or absent
        let matterNum = '';
        let matterDesc = '';
        if (b.matters && b.matters.length > 0) {
          matterNum = b.matters[0].display_number || b.matters[0].id || '';
          matterDesc = b.matters[0].description || '';
        } else if (b.matter) {
          matterNum = b.matter.display_number || b.matter.id || '';
          matterDesc = b.matter.description || '';
        }

        // Extract client info
        let clientName = '';
        if (b.client) {
          clientName = b.client.name || '';
        }

        return {
          id: b.id,
          number: b.number,
          issued_at: b.issued_at,
          due_at: b.due_at,
          total: b.total,
          balance: b.balance,
          state: b.state,
          client_name: clientName,
          matter_number: matterNum,
          matter_description: matterDesc,
        };
      });
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
