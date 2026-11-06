// /hoa/report/?t=… — the HOA board's private report. No personal details are ever sent here.
(function () {
  var NP = window.NP;
  var root = document.getElementById("report");
  if (!root || !NP) return;
  var esc = NP.esc;
  var $ = function (sel) { return root.querySelector(sel); };
  var t = new URLSearchParams(location.search).get("t");
  var statusBox = $("[data-status]");

  function fail(msg) { statusBox.innerHTML = '<p class="form-status err" style="display:block">' + esc(msg) + "</p>"; }
  if (!t) return fail("This report link is missing its key. Ask Neighborhood Perks for your board's link.");

  var day = function (iso) { return new Intl.DateTimeFormat("en-US", { timeZone: NP.TZ, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso)); };
  var stat = function (v, label) { return '<div class="stat"><b>' + v + "</b><span>" + esc(label) + "</span></div>"; };
  var table = function (head, rows) {
    return '<table class="report-table"><thead><tr>' + head.map(function (h) { return "<th" + (h[1] ? ' class="num"' : "") + ">" + esc(h[0]) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r) { return "<tr>" + r.map(function (c, i) { return "<td" + (head[i][1] ? ' class="num"' : "") + ">" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>";
  };

  NP.api("GET", "/api/hoa/report?t=" + encodeURIComponent(t)).then(function (r) {
    var c = r.community, tot = r.totals;
    document.title = c.name + " report | Neighborhood Perks";
    document.querySelector('[data-bind="title"]').textContent = c.name;
    statusBox.hidden = true;
    $("[data-body]").hidden = false;
    $('[data-bind="pct"]').textContent = c.give_back_pct + "%";
    var savings = r.quarters.reduce(function (s, q) { return s + q.savings_cents; }, 0);
    $('[data-bind="totals"]').innerHTML =
      stat(tot.bookings, "resident bookings") + stat(NP.money(savings), "saved by residents (recent quarters)") +
      stat(NP.money(tot.give_back_cents), "give-back earned") + stat(NP.money(tot.paid_out_cents), "paid to the association") + stat(NP.money(tot.owed_cents), "coming to the association");
    $('[data-bind="quarters"]').innerHTML = r.quarters.length
      ? table([["Quarter"], ["Bookings", 1], ["Homes", 1], ["Residents paid", 1], ["Residents saved", 1], ["Give-back", 1]],
          r.quarters.map(function (q) { return [esc(q.quarter.replace("-", " ")), q.bookings, q.homes, NP.money(q.paid_cents), NP.money(q.savings_cents), NP.money(q.give_back_cents)]; }))
      : '<p class="muted">No resident bookings yet.</p>';
    $('[data-bind="services"]').innerHTML = r.services.length
      ? table([["Service"], ["Bookings", 1]], r.services.map(function (s) { return [esc(s.name), s.bookings]; }))
      : '<p class="muted">Nothing booked yet.</p>';
    $('[data-bind="payouts"]').innerHTML = r.payouts.length
      ? table([["Date"], ["Amount", 1], ["Note"]], r.payouts.map(function (p) { return [esc(p.paid_on), NP.money(p.amount_cents), esc(p.note || "")]; }))
      : '<p class="muted">No payments yet. Give-back is paid to the association each quarter.</p>';
    $('[data-bind="groupdays"]').innerHTML = r.groupDays.length ? r.groupDays.map(function (g) {
      return '<article class="gd-card' + (g.status === "cancelled" ? " is-cancelled" : "") + '"><h3>' + esc(g.service.name) + " · " + esc(day(g.starts_at)) + "</h3>" +
        '<p class="gd-when">With ' + esc(g.pro) + (g.status === "cancelled" ? " · cancelled" : "") + "</p>" +
        '<p class="gd-progress">' + g.booked + " of " + g.min_homes + " homes booked" + (g.unlocked ? " · group price unlocked (" + NP.money(g.group_price_cents) + " instead of " + NP.money(g.list_price_cents) + ")" : "") + "</p>" +
        (g.common_area_job ? '<p class="gd-bonus">Free for the community: ' + esc(g.common_area_job) + "</p>" : "") + "</article>";
    }).join("") : '<p class="muted">No group days in the last year.</p>';
  }, function (err) { fail(err.message); });
})();
