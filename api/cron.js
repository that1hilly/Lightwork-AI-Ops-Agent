module.exports = async function handler(req, res) {
  // Verify it's a legitimate Vercel cron call
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SHEET_ID = process.env.SHEET_ID;
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;

  // Fetch sheet
  const sheetRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Commitment%20Tracker?key=${GOOGLE_API_KEY}`
  );
  const sheetData = await sheetRes.json();
  const rows = sheetData.values || [];
  const allData = rows.slice(1)
    .filter(r => r[0] && r[0] !== 'Function')
    .map(r => ({
      fn: r[0]||'', task: r[1]||'', owner: r[2]||'',
      deadline: r[3]||'', status: r[4]||'', lastUpdate: r[5]||'',
      nextSteps: r[6]||'', blockers: r[7]||'', notes: r[8]||''
    }));

  // Date helpers
  const pDate = s => {
    if (!s) return null;
    const mo = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const m = s.match(/(\d+)[\s\-]+(\w+)[\s\-]+(\d+)/);
    if (m && mo[m[2]]!==undefined) return new Date(+m[3]<100?2000+ +m[3]: +m[3], mo[m[2]], +m[1]);
    const d = new Date(s); return isNaN(d)?null:d;
  };
  const dDiff = s => { const d=pDate(s); return !d?null:Math.round((d-new Date())/86400000); };
  const dSince = s => { const d=pDate(s); return !d?null:Math.round((new Date()-d)/86400000); };

  const classify = r => {
    if (r.status==='Complete') return 'complete';
    const d = dDiff(r.deadline);
    if (d!==null&&d<0) return 'overdue';
    const hasBlocker = r.blockers&&r.blockers.trim()!=='';
    if (hasBlocker) return 'critical';
    if (d!==null&&d<=7&&r.status==='At Risk') return 'critical';
    if (r.status==='At Risk') return 'atrisk';
    return 'ontrack';
  };

  const buckets = {overdue:[],critical:[],atrisk:[],ontrack:[]};
  allData.forEach(r => { const c=classify(r); if(buckets[c]) buckets[c].push(r); });
  const stale = allData.filter(r => { const d=dSince(r.lastUpdate); return d!==null&&d>=14&&r.status!=='Complete'; });
  const recent = allData.filter(r => { const d=dSince(r.lastUpdate); return d!==null&&d<=1; });

  const today = new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const isMonday = new Date().getDay() === 1;
  const dataStr = allData.map(r=>`[${r.fn}] ${r.task} | Owner: ${r.owner} | Due: ${r.deadline} | Status: ${r.status} | Updated: ${r.lastUpdate} | Notes: ${r.notes} | Next Steps: ${r.nextSteps} | Blockers: ${r.blockers}`).join('\n');

  const prompt = isMonday
    ? `You are the ops assistant for LightWork AI. Today is ${today} (Monday). TRACKER:\n${dataStr}\nCLASSIFICATION: overdue: ${buckets.overdue.length} | critical: ${buckets.critical.length} | at risk: ${buckets.atrisk.length} | on track: ${buckets.ontrack.length} | stale: ${stale.length}\n\nMONDAY MORNING WEEK-SETTER — w/c ${today}\n\nTHIS WEEK'S HEADLINE\n[2-3 sentences]\n\nOVERDUE — CLEAR IMMEDIATELY\n[each item, owner, action]\n\nCRITICAL THIS WEEK\n[blockers to clear, imminent deadlines]\n\nAT RISK — NEEDS INTERVENTION\n[specific action per item]\n\nSTALE — NOT MOVING\n[items drifting without updates]\n\nTHIS WEEK'S TOP 5 PRIORITIES\n[ranked, specific, owned]\n\nWritten for a founder reading at 8am Monday.`
    : `You are the ops assistant for LightWork AI. Today is ${today}. TRACKER:\n${dataStr}\nCLASSIFICATION: overdue: ${buckets.overdue.length} | critical: ${buckets.critical.length} | at risk: ${buckets.atrisk.length} | stale: ${stale.length} | updated yesterday: ${recent.map(r=>r.task).join(', ')||'none'}\n\nDAILY MORNING BRIEFING — ${today}\n\nUPDATES SINCE YESTERDAY\n[what moved]\n\nOVERDUE — NEEDS IMMEDIATE ACTION\n[each item with owner and next step]\n\nCRITICAL — BLOCKERS & IMMINENT DEADLINES\n[each item with action]\n\nAT RISK\n[each item with suggested action]\n\nSTALE ITEMS — CHASE TODAY\n[items with no update 14d+]\n\nTODAY'S 3 PRIORITIES\n[specific, owned, actionable]\n\nTight. Scannable in 60 seconds.`;

  // Generate summary
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
  });
  const aiData = await aiRes.json();
  const summary = aiData.content?.find(b=>b.type==='text')?.text || 'Could not generate summary.';

  // Send to Slack
  const title = isMonday ? '📅 LightWork — Weekly Ops Summary' : '☀️ LightWork — Daily Briefing';
  await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [
        { type:'header', text:{type:'plain_text',text:title,emoji:true} },
        { type:'context', elements:[{type:'mrkdwn',text:`${today} · ${allData.length} total · 🔴 ${buckets.overdue.length} overdue · 🟠 ${buckets.critical.length} critical · 🟡 ${buckets.atrisk.length} at risk · 🟢 ${buckets.ontrack.length} on track`}] },
        { type:'divider' },
        { type:'section', text:{type:'mrkdwn',text:summary.length>2900?summary.slice(0,2900)+'...':summary} },
        { type:'divider' },
        { type:'context', elements:[{type:'mrkdwn',text:`LightWork Ops Agent · automated daily briefing`}] }
      ]
    })
  });

  res.status(200).json({ ok: true, summary: summary.slice(0, 100) + '...' });
};
