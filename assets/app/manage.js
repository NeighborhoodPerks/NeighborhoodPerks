// /booking/?t=… — the customer's private page to see, move or cancel a booking.
(function () {
  var NP = window.NP;
  var root = document.getElementById("manage");
  if (!root || !NP) return;
  var token = new URLSearchParams(location.search).get("t") || "";
  var booking = null;
  var status = root.querySelector(".form-status");
  var $ = function (sel) { return root.querySelector(sel); };

  function view(name) {
    root.querySelectorAll("[data-view]").forEach(function (el) { el.hidden = el.getAttribute("data-view") !== name; });
  }
  function say(msg, ok) {
    status.className = "form-status " + (ok ? "ok" : "err");
    status.textContent = msg;
  }

  var LABELS = { confirmed: "Confirmed", cancelled: "Cancelled", completed: "Completed", no_show: "Missed" };

  function render() {
    var b = booking;
    var past = new Date(b.starts_at) <= new Date();
    document.querySelector('[data-bind="heading"]').textContent = b.status === "cancelled" ? "This booking is cancelled" : (past ? "Your past booking" : "You're all set");
    var pill = $('[data-bind="status"]');
    pill.textContent = LABELS[b.status] || b.status;
    pill.className = "status-pill is-" + b.status;
    $('[data-bind="summary"]').innerHTML =
      "<strong>" + NP.esc(b.service_name) + "</strong><span>" + NP.esc(NP.when(b.starts_at)) + "</span>" +
      "<span>" + NP.esc(b.address) + "</span>" +
      (b.vendor_first_name ? '<span class="muted">Your pro: ' + NP.esc(b.vendor_first_name) + "</span>" : "") +
      (b.price_cents != null ? '<span class="muted">From ' + NP.money(b.price_cents) + "</span>" : "") +
      (b.notes ? '<span class="muted">Notes: ' + NP.esc(b.notes) + "</span>" : "");
    $('[data-bind="actions"]').hidden = b.status !== "confirmed" || past;
    $('[data-box="cancel"]').hidden = true;
    $('[data-box="reschedule"]').hidden = true;
  }

  function load() {
    if (!token) return view("missing");
    NP.api("GET", "/api/booking?t=" + encodeURIComponent(token)).then(function (res) {
      booking = res.booking;
      render();
      view("booking");
    }, function (err) {
      view("missing");
      if (err.status !== 404) root.querySelector('[data-view="missing"] p').textContent = err.message;
    });
  }

  var picker = null;
  var slotsBox = root.querySelector("[data-slots]");
  function openReschedule() {
    $('[data-box="cancel"]').hidden = true;
    $('[data-box="reschedule"]').hidden = false;
    if (!picker) {
      picker = NP.DatePicker(root.querySelector("[data-cal]"), {
        load: function (from, to) {
          return NP.api("GET", "/api/availability?service=" + encodeURIComponent(booking.service_slug) + "&from=" + from + "&to=" + to + "&t=" + encodeURIComponent(token));
        },
        onPick: function (day, slots) {
          NP.renderSlots(slotsBox, slots, move);
        },
        onError: function (err) { say(err.message); },
      });
    }
    picker.reload().then(function () {
      var first = picker.firstOpen();
      if (first) picker.select(first);
    });
  }

  function move(start) {
    say("Moving your booking…", true);
    NP.api("POST", "/api/booking/reschedule", { t: token, start: start }).then(function (res) {
      booking = res.booking;
      render();
      say("Done! Your booking is now " + NP.when(booking.starts_at) + ". We've emailed you and your pro.", true);
    }, function (err) {
      say(err.message);
      if (err.code === "slot_taken" && picker) picker.reload();
    });
  }

  root.addEventListener("click", function (e) {
    var act = e.target.closest("[data-act]");
    if (!act) return;
    var a = act.getAttribute("data-act");
    status.className = "form-status";
    if (a === "reschedule") openReschedule();
    if (a === "cancel") { $('[data-box="reschedule"]').hidden = true; $('[data-box="cancel"]').hidden = false; }
    if (a === "cancel-no") $('[data-box="cancel"]').hidden = true;
    if (a === "cancel-yes") {
      act.disabled = true;
      NP.api("POST", "/api/booking/cancel", { t: token, reason: $("#c-reason").value }).then(function (res) {
        booking = res.booking;
        render();
        say("Your booking is cancelled. We've let your pro know.", true);
      }, function (err) { say(err.message); }).then(function () { act.disabled = false; });
    }
  });

  load();
})();
