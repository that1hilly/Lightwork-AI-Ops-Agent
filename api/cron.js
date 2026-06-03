module.exports = async function handler(req, res) {
  const SHEET_ID = process.env.SHEET_ID;
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // ── HELPERS ──────────────────────────────────────────────
  const redis = async (cmd, ...args) => {
    const res = await fetch(`${REDIS_URL}/${cmd}/${args.map(a => encodeURIComponent(a)).join('/')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  };

  const pDate = s => {
    if (!s) return null;
    const mo = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const m = s.match(/(\d+)[\s\-]+(\w+)[\s\-]+(\d+)/);
    if (m && mo[m[2]] !== undefined) return new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], mo[m[2]], +m[1]);
    const d = new Date(s); return isNaN(d) ? null : d;
  };
  const dDiff = s => { const d = pDate(s); return !d ? null : Math.round((d - new Date()) / 86400000); };
  const dSince = s => { const d = pDate(s); return !d ? null : Math.round((new Date() - d) / 86400000); };

  const classify = r => {
    if (r.status === 'Complete') return 'complete';
    const d = dDiff(r.deadline);
    if (d !== null && d < 0) return 'overdue';
    const hasBlocker = r.blockers && r.blockers.trim() !== '';
    if (hasBlocker) return 'critical';
    if (d !== null && d <= 7 && r.status === 'At Risk') return 'critical';
    if (r.status === 'At Risk') return 'atrisk';
    return 'ontrack';
  };

  // ── FETCH SHEET ──────────────────────────────────────────
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

  // ── SNAPSHOT: load yesterday, save today ─────────────────
  const todayKey = `snapshot:${new Date().toISOString().slice(0, 10)}`;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = `snapshot:${yesterday.toISOString().slice(0, 10)}`;

  let prevData = null;
  try {
    const raw = await redis('get', yesterdayKey);
    if (raw) prevData = JSON.parse(raw);
  } catch(e) {}

  // Save today's snapshot (expires in 7 days)
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(todayKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(allData), ex: 604800 })
    });
  } catch(e) {}

  // ── CHANGELOG ────────────────────────────────────────────
  const changelog = [];
  if (prevData && prevData.length > 0) {
    const fields = [
      { key: 'status',    label: 'Status changed' },
      { key: 'blockers',  label: 'Blocker updated' },
      { key: 'deadline',  label: 'Deadline changed' },
      { key: 'nextSteps', label: 'Next steps updated' },
      { key: 'notes',     label: 'Notes updated' },
    ];
    allData.forEach(r => {
      const prev = prevData.find(p => p.task === r.task && p.fn === r.fn);
      if (!prev) { changelog.push(`• *New item added:* ${r.task} [${r.fn}]`); return; }
      fields.forEach(f => {
        const oldVal = (prev[f.key]||'').trim();
        const newVal = (r[f.key]||'').trim();
        if (oldVal !== newVal) {
          changelog.push(`• *${f.label}* — ${r.task}: ${oldVal || '(empty)'} → ${newVal || '(empty)'}`);
        }
      });
    });
    prevData.forEach(p => {
      if (!allData.find(r => r.task === p.task && r.fn === p.fn))
        changelog.push(`• *Item removed:* ${p.task} [${p.fn}]`);
    });
  }

  // ── CLASSIFY ─────────────────────────────────────────────
  const buckets = { overdue:[], critical:[], atrisk:[], ontrack:[] };
  allData.forEach(r => { const c = classify(r); if (buckets[c]) buckets[c].push(r); });
  const stale = allData.filter(r => { const d = dSince(r.lastUpdate); return d !== null && d >= 14 && r.status !== 'Complete'; });
  const recent = allData.filter(r => { const d = dSince(r.lastUpdate); return d !== null && d <= 1; });

  // ── BUILD PROMPT ─────────────────────────────────────────
  const today = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const isMonday = new Date().getDay() === 1;
  const dataStr = allData.map(r =>
    `[${r.fn}] ${r.task} | Owner: ${r.owner} | Due: ${r.deadline} | Status: ${r.status} | Updated: ${r.lastUpdate} | Notes: ${r.notes} | Next Steps: ${r.nextSteps} | Blockers: ${r.blockers}`
  ).join('\n');

  const changelogSection = changelog.length > 0
    ? `\nCHANGES SINCE YESTERDAY:\n${changelog.join('\n')}`
    : '\nCHANGES SINCE YESTERDAY:\nNo changes detected since yesterday.';

  const prompt = isMonday
    ? `You are the ops assistant for LightWork AI (20-30 person startup). Today is ${today} (Monday).

TRACKER DATA:
${dataStr}

CLASSIFICATION: overdue: ${buckets.overdue.length} | critical: ${buckets.critical.length} | at risk: ${buckets.atrisk.length} | on track: ${buckets.ontrack.length} | stale: ${stale.length}
${changelogSection}

MONDAY MORNING WEEK-SETTER — w/c ${today}

THIS WEEK'S HEADLINE
[2-3 sentences — what kind of week is this?]

CHANGES SINCE YESTERDAY
[summarise the changelog above — what moved, what was added/removed]

OVERDUE — CLEAR IMMEDIATELY
[each item, owner, action]

CRITICAL THIS WEEK
[blockers to clear, imminent deadlines]

AT RISK — NEEDS INTERVENTION
[specific action per item]

STALE — NOT MOVING
[items drifting without updates]

THIS WEEK'S TOP 5 PRIORITIES
[ranked, specific, owned]

Written for a founder reading at 8am Monday.`
    : `You are the ops assistant for LightWork AI (20-30 person startup). Today is ${today}.

TRACKER DATA:
${dataStr}

CLASSIFICATION: overdue: ${buckets.overdue.length} | critical: ${buckets.critical.length} | at risk: ${buckets.atrisk.length} | stale: ${stale.length} | updated yesterday: ${recent.map(r => r.task).join(', ')||'none'}
${changelogSection}

DAILY MORNING BRIEFING — ${today}

CHANGES SINCE YESTERDAY
[summarise the changelog above concisely — what moved]

OVERDUE — NEEDS IMMEDIATE ACTION
[each overdue item with owner and next step]

CRITICAL — BLOCKERS & IMMINENT DEADLINES
[each critical item with action]

AT RISK
[each at-risk item with suggested action]

STALE ITEMS — CHASE TODAY
[items with no update 14d+]

TODAY'S 3 PRIORITIES
[specific, owned, actionable]

Tight. Scannable in 60 seconds.`;

  // ── GENERATE SUMMARY ─────────────────────────────────────
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const aiData = await aiRes.json();
  const summary = aiData.content?.find(b => b.type === 'text')?.text || 'Could not generate summary.';

  // ── SEND TO SLACK ─────────────────────────────────────────
  const title = isMonday ? '📅 LightWork — Weekly Ops Summary' : '☀️ LightWork — Daily Briefing';
  const changelogBlock = changelog.length > 0
    ? `\n\n*Changes since yesterday:*\n${changelog.slice(0, 10).join('\n')}${changelog.length > 10 ? `\n_...and ${changelog.length - 10} more_` : ''}`
    : '';

  await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${today} · ${allData.length} total · 🔴 ${buckets.overdue.length} overdue · 🟠 ${buckets.critical.length} critical · 🟡 ${buckets.atrisk.length} at risk · 🟢 ${buckets.ontrack.length} on track` }] },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: (summary + changelogBlock).length > 2900 ? (summary + changelogBlock).slice(0, 2900) + '...' : summary + changelogBlock } },
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `LightWork Ops Agent · automated daily briefing · <https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit|View tracker>` }] }
      ]
    })
  });

  res.status(200).json({ ok: true, items: allData.length, changes: changelog.length });
};
