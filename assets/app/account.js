// /account/ — a homeowner's bookings and saved details.
(function () {
  var NP = window.NP;
  var root = document.getElementById("account");
  if (!root || !NP) return;
  var esc = NP.esc;
  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var bookings = [];
  var STATUS = { confirmed: "Booked", completed: "Done", cancelled: "Cancelled", no_show: "Missed" };

  var sheet = $("[data-sheet]");
  function openSheet(html) { $('[data-bind="sheet"]', sheet).innerHTML = html; if (sheet.showModal) sheet.showModal(); else sheet.setAttribute("open", ""); }
  function closeSheet() { if (sheet.close) sheet.close(); else sheet.removeAttribute("open"); }

  function initials(n) { return String(n || "?").split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase(); }
  function card(b) {
    var upcoming = b.status === "confirmed" && new Date(b.starts_at) > new Date();
    var pro = b.vendor_business || b.vendor_name;
    return '<article class="acct-card' + (upcoming ? "" : " is-past") + '">' +
      '<div class="acct-card-top">' +
      (b.vendor_photo_url ? '<img class="avatar" src="' + esc(b.vendor_photo_url) + '" alt="" width="48" height="48">' : '<span class="avatar avatar-initials" style="width:48px;height:48px">' + esc(initials(b.vendor_name)) + "</span>") +
      "<div><strong>" + esc(b.service_name) + "</strong><span>" + esc(NP.when(b.starts_at)) + '</span><span class="muted">With ' + esc(pro) + "</span></div>" +
      '<span class="status-pill is-' + b.status + '">' + STATUS[b.status] + "</span></div>" +
      (b.payment_status && b.payment_status !== "none"
        ? '<p class="pay-line pay-' + b.payment_status + '">' + NP.PAY_LABEL[b.payment_status] + (b.amount_charged_cents ? ": " + NP.money(b.amount_charged_cents) : "") +
          (b.payment_status === "failed" ? ' <button type="button" class="btn btn-primary btn-sm" data-pay="' + b.id + '">Pay now</button>' : "") + "</p>"
        : "") +
      '<p class="muted acct-addr">' + esc(b.address) + "</p>" +
      (upcoming ? '<div class="btn-row"><button type="button" class="btn btn-dark btn-sm" data-move="' + b.id + '">Change time</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-cancel="' + b.id + '">Cancel</button>' +
        (b.vendor_phone ? '<a class="btn btn-ghost btn-sm" href="tel:' + esc(b.vendor_phone.replace(/[^\d+]/g, "")) + '">Call ' + esc(b.vendor_name.split(" ")[0]) + "</a>" : "") + "</div>"
        : (b.status !== "cancelled" ? '<a class="linklike" href="/book/?service=' + encodeURIComponent(b.service_slug) + '">Book again</a>' : "")) +
      "</article>";
  }

  function render() {
    var up = bookings.filter(function (b) { return b.status === "confirmed" && new Date(b.starts_at) > new Date(); });
    var past = bookings.filter(function (b) { return up.indexOf(b) === -1; });
    $('[data-bind="upcoming"]').innerHTML = up.length ? up.map(card).join("")
      : '<div class="empty-pros"><p class="mb-0"><strong>Nothing booked yet.</strong> <a href="/book/">Find a local pro</a> and book in a minute.</p></div>';
    $('[data-bind="past"]').innerHTML = past.length ? past.map(card).join("") : '<p class="muted">Nothing here yet.</p>';
  }

  function load() {
    return NP.api("GET", "/api/account").then(function (res) {
      var p = res.profile;
      bookings = res.bookings;
      $('[data-bind="hello"]').textContent = "Hi, " + (p.name || "there").split(" ")[0];
      $('[data-bind="email"]').textContent = p.email;
      $('[data-bind="email-input"]').value = p.email;
      $("[data-verify]").hidden = !!p.email_verified_at;
      var f = $('[data-form="profile"]');
      f.name.value = p.name || ""; f.phone.value = p.phone || ""; f.address.value = p.address || "";
      f.area.dataset.want = p.area || "";
      f.area.value = p.area || "";
      render();
    }, function (err) {
      if (err.status === 401 || err.status === 403) { location.replace("/signin/?next=/account/"); return; }
      $('[data-bind="upcoming"]').innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>";
    });
  }

  NP.api("GET", "/api/areas").then(function (res) {
    var sel = $('[data-form="profile"] [name="area"]');
    sel.innerHTML = '<option value="">Choose…</option>' + res.areas.map(function (a) { return '<option value="' + esc(a.slug) + '">' + esc(a.name) + "</option>"; }).join("");
    if (sel.dataset.want) sel.value = sel.dataset.want;
  }, function () {});

  if (new URLSearchParams(location.search).get("welcome")) $("[data-welcome]").hidden = false;

  // --- actions ---
  root.addEventListener("click", function (e) {
    var mv = e.target.closest("[data-move]");
    var cx = e.target.closest("[data-cancel]");
    if (mv) openMove(bookings.find(function (b) { return b.id === mv.getAttribute("data-move"); }));
    if (cx) openCancel(bookings.find(function (b) { return b.id === cx.getAttribute("data-cancel"); }));
    var pv = e.target.closest("[data-pay]");
    if (pv) openPay(pv.getAttribute("data-pay"));
    if (e.target.closest('[data-act="resend"]')) {
      NP.api("POST", "/api/auth/verify/resend", {}).then(function () {
        e.target.textContent = "Sent! Check your inbox";
        e.target.disabled = true;
      }, function (err) { e.target.textContent = err.message; });
    }
  });

  function openPay(id) {
    openSheet("<h2>Pay with another card</h2><div data-pay-now><p class=\"muted\">Loading…</p></div>");
    NP.api("POST", "/api/account/bookings/" + id + "/pay", {}).then(function (r) {
      return NP.payNow($("[data-pay-now]", sheet), r.clientSecret, r.amount, function () {
        return NP.api("POST", "/api/account/bookings/" + id + "/pay/done", {}).then(function () { closeSheet(); load(); });
      });
    }, function (err) { $("[data-pay-now]", sheet).textContent = err.message; });
  }

  function openCancel(b) {
    openSheet("<h2>Cancel this booking?</h2><p><strong>" + esc(b.service_name) + "</strong>, " + esc(NP.when(b.starts_at)) + "</p>" +
      '<div class="field"><label for="cx-reason">Reason <span class="hint">(optional, shared with your pro)</span></label><input id="cx-reason" maxlength="500"></div>' +
      '<div class="btn-row mt-s"><button class="btn btn-primary btn-sm" data-yes>Yes, cancel it</button><button class="btn btn-ghost btn-sm" data-no>Keep it</button></div><div class="form-status" role="alert"></div>');
    $("[data-no]", sheet).onclick = closeSheet;
    $("[data-yes]", sheet).onclick = function () {
      NP.api("POST", "/api/account/bookings/" + b.id + "/cancel", { reason: $("#cx-reason", sheet).value }).then(function () {
        closeSheet(); load();
      }, function (err) { var s = $(".form-status", sheet); s.className = "form-status err"; s.textContent = err.message; });
    };
  }

  function openMove(b) {
    openSheet("<h2>Pick a new time</h2><p class=\"muted\">" + esc(b.service_name) + " with " + esc(b.vendor_business || b.vendor_name) + "</p>" +
      '<div class="cal" data-cal><div class="cal-head"><button type="button" class="cal-nav" data-cal-prev aria-label="Previous month">‹</button><strong data-cal-label></strong>' +
      '<button type="button" class="cal-nav" data-cal-next aria-label="Next month">›</button></div><div class="cal-grid" data-cal-grid role="grid"></div></div>' +
      '<div class="slots" data-slots><p class="muted">Pick a day.</p></div><p class="tz-note">Times are San Diego time.</p><div class="form-status" role="alert"></div>');
    var slotsBox = $("[data-slots]", sheet);
    var say = function (m) { var s = $(".form-status", sheet); s.className = "form-status err"; s.textContent = m; };
    var picker = NP.DatePicker($("[data-cal]", sheet), {
      load: function (from, to) {
        return NP.api("GET", "/api/availability?service=" + encodeURIComponent(b.service_slug) + "&booking=" + b.id + "&from=" + from + "&to=" + to);
      },
      onPick: function (day, slots) {
        NP.renderSlots(slotsBox, slots, function (start) {
          NP.api("POST", "/api/account/bookings/" + b.id + "/reschedule", { start: start }).then(function () {
            closeSheet(); load();
          }, function (err) { say(err.message); if (err.code === "slot_taken") picker.reload(); });
        });
      },
      onError: function (err) { say(err.message); },
    });
    picker.reload().then(function () { var f = picker.firstOpen(); if (f) picker.select(f); });
  }

  $('[data-form="profile"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var s = $(".form-status", f);
    NP.api("PUT", "/api/account", { name: f.name.value, phone: f.phone.value, address: f.address.value, area: f.area.value }).then(function () {
      s.className = "form-status ok"; s.textContent = "Saved.";
    }, function (err) { s.className = "form-status err"; s.textContent = err.message; });
  });

  $('[data-act="signout"]').addEventListener("click", function () {
    NP.api("POST", "/api/auth/logout", {}).then(function () { location.href = "/"; }, function () { location.href = "/"; });
  });

  load();
})();
