// /quote/?t=… — the customer's private page for one quote: see it, accept it and pick a time, or pass.
(function () {
  var NP = window.NP;
  var root = document.getElementById("quote");
  if (!root || !NP) return;
  var esc = NP.esc;
  var token = new URLSearchParams(location.search).get("t") || "";
  var q = null;
  var start = null;
  var card = null;
  var status = root.querySelector(".form-status");
  var $ = function (sel) { return root.querySelector(sel); };

  function view(name) { root.querySelectorAll("[data-view]").forEach(function (el) { el.hidden = el.getAttribute("data-view") !== name; }); }
  function say(msg, ok) { status.className = "form-status " + (ok ? "ok" : "err"); status.textContent = msg; }
  function hours(min) { return min < 60 ? min + " minutes" : (min % 60 ? (min / 60).toFixed(1) : min / 60) + " hour" + (min > 60 ? "s" : ""); }
  function day(iso) { return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: NP.TZ }); }

  var LABELS = { requested: "Waiting for a price", quoted: "Price ready", accepted: "Booked", declined: "You passed", passed: "Pro can't take it", expired: "Closed" };
  var HEADINGS = { requested: "Your request is in", quoted: "Your quote is ready", accepted: "You're booked", declined: "You passed on this quote", passed: "This pro can't take the job", expired: "This request is closed" };

  function render() {
    var open = q.status === "quoted" && new Date(q.valid_until) > new Date();
    var pro = q.vendor_business || q.vendor_first_name;
    document.querySelector('[data-bind="heading"]').textContent = q.status === "quoted" && !open ? "This price has run out" : HEADINGS[q.status];
    var pill = $('[data-bind="status"]');
    pill.textContent = q.status === "quoted" && !open ? "Price ran out" : LABELS[q.status];
    pill.className = "status-pill is-" + (q.status === "accepted" ? "completed" : q.status === "quoted" && open ? "confirmed" : "cancelled");
    $('[data-bind="pro"]').innerHTML = (q.vendor_photo_url ? '<img class="avatar" src="' + esc(q.vendor_photo_url) + '" alt="" width="52" height="52">' : "") +
      "<div><strong>" + esc(pro) + "</strong><span class=\"muted\">" + esc(q.service_name) + " · " + esc(q.area_name) + "</span></div>";
    var body = "";
    if (q.status === "quoted") {
      body += '<div class="quote-card"><p class="muted mb-0">The price</p><p class="quote-price">' + NP.money(q.price_cents) + "</p>" +
        "<p class=\"mb-0\">About " + esc(hours(q.duration_min)) + " of work. " + (open ? "This price holds until " + esc(day(q.valid_until)) + "." : "It held until " + esc(day(q.valid_until)) + ".") + "</p>" +
        (q.message ? '<p class="quote-details">' + esc(q.message) + "</p>" : "") +
        (open ? '<div class="btn-row"><button type="button" class="btn btn-primary" data-act="accept">Accept and pick a time</button><button type="button" class="btn btn-ghost" data-act="decline">Pass on it</button></div>'
          : '<p class="muted">Ask ' + esc(q.vendor_first_name) + ' for a new price, or <a href="/book/?service=' + encodeURIComponent(q.service_slug) + '">see other pros</a>.</p>') + "</div>";
    }
    if (q.status === "requested") body += "<p class=\"mt-s\">" + esc(q.vendor_first_name) + " will reply with a price, usually within 2 days. We'll email you as soon as it's ready.</p>";
    if (q.status === "accepted") body += '<p class="mt-s">Booked for <strong>' + esc(NP.when(q.booked_at)) + "</strong> at " + NP.money(q.price_cents) + ". Your booking confirmation email has a link to see, move or cancel it.</p>";
    if (q.status === "passed") body += '<p class="mt-s">' + (q.response_note ? "Their note: “" + esc(q.response_note) + "” " : "") + '<a href="/book/?service=' + encodeURIComponent(q.service_slug) + '">See other pros</a>, or call us and we\'ll find someone.</p>';
    if (q.status === "expired" || q.status === "declined") body += '<p class="mt-s"><a href="/book/?service=' + encodeURIComponent(q.service_slug) + '">Find a pro</a> whenever you\'re ready.</p>';
    body += '<details class="history mt-s"' + (q.status === "requested" ? " open" : "") + '><summary>What you asked for</summary><p class="quote-details">' + esc(q.details) + "</p>" +
      '<p class="muted mb-0">' + esc(q.address) + (q.photos ? " · " + q.photos + " photo" + (q.photos > 1 ? "s" : "") : "") + "</p></details>";
    $('[data-bind="body"]').innerHTML = body;
    $('[data-box="accept"]').hidden = true;
    $('[data-box="decline"]').hidden = true;
  }

  function load() {
    if (!token) return view("missing");
    return NP.api("GET", "/api/quote?t=" + encodeURIComponent(token)).then(function (res) {
      q = res.quote;
      render();
      view("quote");
    }, function (err) {
      view("missing");
      if (err.status !== 404) root.querySelector('[data-view="missing"] p').textContent = err.message;
    });
  }

  // --- accepting: that pro's calendar, slots as long as the job ---------------------------
  var picker = null;
  var slotsBox = root.querySelector("[data-slots]");
  function openAccept() {
    $('[data-box="decline"]').hidden = true;
    $('[data-box="accept"]').hidden = false;
    $('[data-bind="length-note"]').textContent = "Times that fit a " + (q.duration_min < 60 ? q.duration_min + "-minute" : (q.duration_min % 60 ? (q.duration_min / 60).toFixed(1) : q.duration_min / 60) + "-hour") + " job on " + q.vendor_first_name + "'s calendar.";
    if (!card) {
      card = NP.cardForm(root.querySelector("[data-pay-element]"));
      card.ready.then(function (on) { $("[data-pay]").hidden = !on; }, function (err) { say(err.message); });
    }
    if (!picker) {
      picker = NP.DatePicker(root.querySelector("[data-cal]"), {
        load: function (from, to) {
          return NP.api("GET", "/api/availability?service=" + encodeURIComponent(q.service_slug) + "&from=" + from + "&to=" + to + "&quote=" + encodeURIComponent(token));
        },
        onPick: function (d, slots) {
          NP.renderSlots(slotsBox, slots, function (s) {
            start = s;
            $('[data-bind="picked"]').innerHTML = "<strong>" + esc(q.service_name) + "</strong><span>" + esc(NP.when(s)) + "</span><span class=\"muted\">" + NP.money(q.price_cents) + ", about " + esc(hours(q.duration_min)) + "</span>";
            $('[data-box="confirm"]').hidden = false;
            $('[data-act="book"]').focus();
          }, start);
        },
        onError: function (err) { say(err.message); },
      });
    }
    picker.reload().then(function () {
      var first = picker.firstOpen();
      if (first) picker.select(first);
      else slotsBox.innerHTML = '<p class="muted">No open times this month. Use › to look ahead, or call us.</p>';
    });
  }

  function book(btn) {
    if (!start) return say("Pick a time first.");
    btn.disabled = true;
    var label = btn.innerHTML;
    btn.textContent = "Booking…";
    // The card is saved under the details already on the quote; the server checks the card is real
    card.save({ name: q.customer_name, email: q.customer_email, phone: q.customer_phone }).then(function (setupIntent) {
      return NP.api("POST", "/api/quote/accept", { t: token, start: start, setup_intent: setupIntent || undefined });
    }).then(function (res) {
      location.href = "/booking/?t=" + encodeURIComponent(res.manageToken);
    }, function (err) {
      say(err.message);
      if (err.code === "slot_taken") { start = null; $('[data-box="confirm"]').hidden = true; picker.reload(); }
      if (err.code === "quote_expired" || err.code === "quote_closed" || err.code === "quote_accepted") load();
    }).then(function () { btn.disabled = false; btn.innerHTML = label; });
  }

  root.addEventListener("click", function (e) {
    var act = e.target.closest("[data-act]");
    if (!act) return;
    var a = act.getAttribute("data-act");
    status.className = "form-status";
    if (a === "accept") openAccept();
    if (a === "book") book(act);
    if (a === "decline") { $('[data-box="accept"]').hidden = true; $('[data-box="decline"]').hidden = false; }
    if (a === "decline-no") $('[data-box="decline"]').hidden = true;
    if (a === "decline-yes") {
      act.disabled = true;
      NP.api("POST", "/api/quote/decline", { t: token, reason: $("#dq-reason").value }).then(function () {
        say("Done. We've let your pro know.", true);
        load();
      }, function (err) { say(err.message); }).then(function () { act.disabled = false; });
    }
  });

  load();
})();
