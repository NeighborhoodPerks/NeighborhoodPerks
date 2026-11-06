// /tip/?t=… — the one-time tip link from the "paid" email.
(function () {
  var NP = window.NP;
  var root = document.getElementById("tip");
  if (!root || !NP) return;
  var esc = NP.esc;
  var $ = function (sel) { return root.querySelector(sel); };
  var t = new URLSearchParams(location.search).get("t");
  var statusBox = $("[data-status]");
  var thanks = function (cents, pro) {
    $("[data-body]").hidden = true;
    statusBox.hidden = false;
    statusBox.innerHTML = '<div class="done-badge" aria-hidden="true">✓</div><h1 class="bk-title">Thank you!</h1><p>Your ' + NP.money(cents) + " tip is on its way to " + esc(pro) + '. All of it.</p><p><a class="btn btn-ghost" href="/">Back to Neighborhood Perks</a></p>';
  };
  if (!t) { statusBox.innerHTML = '<p class="form-status err" style="display:block">This tip link is missing its key. Use the link in your "Paid" email.</p>'; return; }

  NP.api("GET", "/api/tip?t=" + encodeURIComponent(t)).then(function (info) {
    if (info.tip_cents) return thanks(info.tip_cents, info.pro);
    statusBox.hidden = true;
    $("[data-body]").hidden = false;
    $('[data-bind="photo"]').innerHTML = info.pro_photo_url ? '<img class="avatar" src="' + esc(info.pro_photo_url) + '" alt="" width="64" height="64">' : "";
    $('[data-bind="title"]').textContent = "Tip " + info.pro + " for " + info.service_name.toLowerCase();
    if (!info.can_tip) {
      $('[data-bind="sub"]').textContent = info.tip_status === "processing" ? "Your tip is being processed. Thank you!" : "Tips for this job are closed (they're open for 30 days after the job).";
      return;
    }
    $('[data-bind="sub"]').textContent = "Hi " + info.customer_first + "! You paid " + NP.money(info.amount_charged_cents) + ". If " + info.pro + " did a great job, a tip goes straight to them.";
    NP.tipBox($("[data-tip]"), info,
      function (dollars) { return NP.api("POST", "/api/tip", { t: t, amount: dollars }); },
      function () { return NP.api("POST", "/api/tip/done", { t: t }); },
      function (cents) { thanks(cents, info.pro); });
  }, function (err) {
    statusBox.innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>";
  });
})();
