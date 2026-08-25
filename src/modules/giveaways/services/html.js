const { formatPrizeSummary } = require("./prize");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shell(title, body, canonicalPath = "/giveaways") {
  const canonical = `https://barastep.com${canonicalPath}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:auto;padding:24px;color:#272015;background:#fff8e8}h1,h2{line-height:1.15}.card{background:#fff;border:2px solid #4b3621;border-radius:14px;padding:18px;margin:16px 0}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #d8c7a5}.muted{color:#665b49}</style><link rel="canonical" href="${escapeHtml(canonical)}"></head><body>${body}</body></html>`;
}

function renderRules(contest) {
  const sections = (contest.rulesSections || []).map((section) => `<section class="card"><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body).replaceAll("\n", "<br>")}</p></section>`).join("");
  const sponsor = contest.sponsor || {};
  return shell(
    `${contest.title} — Official Rules`,
    `<h1>${escapeHtml(contest.title)} — Official Rules</h1><p class="muted">Version ${escapeHtml(contest.rulesVersion)} · ${escapeHtml(contest.rulesHash)}</p><section class="card"><h2>Material terms</h2><p><strong>Sponsor:</strong> ${escapeHtml(sponsor.legalName)} · ${escapeHtml(sponsor.mailingAddress)}</p><p><strong>Contest period:</strong> ${escapeHtml(contest.startsAt)} through ${escapeHtml(contest.endsAt)} (${escapeHtml(contest.governingTimeZone)}).</p><p><strong>Prize:</strong> ${escapeHtml(formatPrizeSummary(contest, { joiner: " and " }))} to one winner.</p><p>No purchase necessary. Open to legal residents of the 50 United States and D.C., age 18 or older. Social follows are optional and provide no advantage.</p><p>The eligible entrant with the most verified completed referrals wins. Ties go to whoever reached the final verified referral count first. Apple and Google are not sponsors or involved.</p></section>${sections}`,
    `/giveaways/${encodeURIComponent(contest.slug)}/rules`,
  );
}

function renderLanding(data) {
  const rows = data.leaderboard.map((row) => `<tr><td>${row.rank}</td><td>${escapeHtml(row.displayName)}</td><td>${row.completedCount}</td></tr>`).join("");
  const socialLinks = (data.contest.socialLinks || []).map((link) =>
    `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a></li>`
  ).join("");
  const social = socialLinks
    ? `<section class="card"><h2>Follow Bara</h2><p class="muted">Optional — does not affect contest.</p><ul>${socialLinks}</ul></section>`
    : "";
  const reason = data.contest.publicReason ? `<div class="card"><strong>${escapeHtml(data.contest.publicReason)}</strong></div>` : "";
  const winner = data.winner ? `<p><strong>Winner:</strong> ${escapeHtml(data.winner.displayName)}</p>` : "";
  const noWinner = !data.winner && !data.contest.publicReason && ["FINAL", "ARCHIVED"].includes(data.contest.status)
    ? "<p><strong>No eligible winner was selected.</strong></p>" : "";
  const lifecycle = data.contest.status === "CANCELLED"
    ? "Cancelled"
    : data.winner
      ? (data.contest.status === "ARCHIVED" ? "Final results (Archived)" : "Final")
      : data.contest.status === "ARCHIVED" ? "Archived" : data.contest.status;
  const provisional = ["SCHEDULED", "ACTIVE", "VERIFYING"].includes(data.contest.status)
    ? `<p class="muted">Provisional—positions may change after fraud review.</p>` : "";
  const sponsor = data.contest.sponsor || {};
  const prize = formatPrizeSummary({
    cashMinor: data.contest.prize?.cashMinor || 0,
    coinPrize: data.contest.prize?.coins || 0,
  });
  return shell(
    data.contest.title,
    `<h1>${escapeHtml(data.contest.title)}</h1><p><strong>${escapeHtml(lifecycle)}</strong></p><div class="card"><h2>Win ${escapeHtml(prize)}</h2><p>Sponsored by ${escapeHtml(sponsor.legalName)}. Open to legal residents of the 50 United States and D.C., age 18+. No purchase necessary.</p><p>Runs ${escapeHtml(data.contest.startsAt)} through ${escapeHtml(data.contest.endsAt)} (${escapeHtml(data.contest.governingTimeZone)}).</p><p>The entrant with the most verified completed referrals wins. Ties go to whoever reached the final count first.</p>${winner}${noWinner}</div>${reason}<h2>Leaderboard</h2><table><thead><tr><th>Rank</th><th>Display name</th><th>Completed referrals</th></tr></thead><tbody>${rows}</tbody></table>${provisional}${social}<p><a href="/giveaways/${encodeURIComponent(data.contest.slug)}/rules">Official Rules</a> · Social follows are optional and provide no advantage. Apple and Google are not sponsors or involved.</p>`,
    `/giveaways/${encodeURIComponent(data.contest.slug)}`,
  );
}

function renderNoContest() {
  return shell("Bara Giveaways", "<h1>Bara Giveaways</h1><p>No active contest.</p>");
}

module.exports = { escapeHtml, renderLanding, renderNoContest, renderRules };
