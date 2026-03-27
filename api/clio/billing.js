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
    const MAX_PAGES = 25; // Up to 5,000 records

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
        activities = await fetchAllPages(accessToken, '/activities.json', activityParams, MAX_PAGES);
      } catch (e) {
        console.log('Retrying activities without association fields:', e.message);
        activityParams.fields = 'id,type,date,quantity,price,total,note';
        activities = await fetchAllPages(accessToken, '/activities.json', activityParams, MAX_PAGES);
      }

      // Client-side date filter as backup (Clio's created_since filters by creation date, not activity date)
      if (date_from || date_to) {
        activities = activities.filter(a => {
          if (!a.date) return true;
          if (date_from && a.date < date_from) return false;
          if (date_to && a.date > date_to) return false;
          return true;
        });
      }

      const activitiesCapped = activities.length >= MAX_PAGES * 200;

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

      results.activities_capped = activitiesCapped;
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
        bills = await fetchAllPages(accessToken, '/bills.json', billParams, MAX_PAGES);
      } catch (e) {
        console.log('Retrying bills without association fields:', e.message);
        billParams.fields = 'id,number,issued_at,due_at,total,balance,state';
        bills = await fetchAllPages(accessToken, '/bills.json', billParams, MAX_PAGES);
      }

      // Client-side date filter as backup
      if (date_from || date_to) {
        bills = bills.filter(b => {
          if (!b.issued_at) return true;
          if (date_from && b.issued_at < date_from) return false;
          if (date_to && b.issued_at > date_to) return false;
          return true;
        });
      }

      // Filter out void and deleted bills
      bills = bills.filter(b => b.state !== 'void' && b.state !== 'deleted');

      const billsCapped = bills.length >= MAX_PAGES * 200;

      results.bills = bills.map(b => {
        let matterNum = '';
        let matterDesc = '';
        if (b.matters && b.matters.length > 0) {
          matterNum = b.matters[0].display_number || b.matters[0].id || '';
          matterDesc = b.matters[0].description || '';
        } else if (b.matter) {
          matterNum = b.matter.display_number || b.matter.id || '';
          matterDesc = b.matter.description || '';
        }

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

      results.bills_capped = billsCapped;
    }

    // Compute summary
    if (results.activities) {
      const totalHours = results.activities
        .filter(a => a.type === 'TimeEntry')
        .reduce((sum, a) => sum + (a.quantity || 0), 0);
      const totalBilled = results.activities
        .filter(a => a.total && a.total > 0)
        .reduce((sum, a) => sum + a.total, 0);
      const totalUnbilled = results.activities
        .filter(a => !a.total || a.total === 0)
        .length;

      // Clio returns quantity in seconds - convert to hours
      const totalHoursConverted = totalHours / 3600;
      results.summary = {
        total_hours: Math.round(totalHoursConverted * 100) / 100,
        total_billed: Math.round(totalBilled * 100) / 100,
        activity_count: results.activities.length,
        unbilled_count: totalUnbilled,
      };
    }

    if (results.bills) {
      const unpaidBills = results.bills.filter(b => b.state !== 'paid');
      const paidBills = results.bills.filter(b => b.state === 'paid');
      const totalOutstanding = unpaidBills.reduce((sum, b) => sum + (b.balance || 0), 0);
      const totalPaid = paidBills.reduce((sum, b) => sum + (b.total || 0), 0);

      results.summary = {
        ...(results.summary || {}),
        total_outstanding: Math.round(totalOutstanding * 100) / 100,
        total_paid: Math.round(totalPaid * 100) / 100,
        bill_count: results.bills.length,
        unpaid_count: unpaidBills.length,
        paid_count: paidBills.length,
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
