// Customer booking flow on /book/: service → day → time → details → confirmed.
(function () {
  var NP = window.NP;
  var root = document.getElementById("booker");
  if (!root || !NP) return;

  var state = { service: null, serviceName: "", priceFrom: null, start: null };
  var steps = ["service", "time", "details", "done"];
  var requestBox = document.querySelector("[data-request]");

  function go(step) {
    root.querySelectorAll(".bk-step").forEach(function (el) { el.hidden = el.getAttribute("data-step") !== step; });
    var idx = steps.indexOf(step);
    root.querySelectorAll(".steps-bar li").forEach(function (li, i) {
      li.classList.toggle("is-current", i === idx);
      li.classList.toggle("is-done", i < idx);
    });
    var title = root.querySelector('.bk-step[data-step="' + step + '"] .bk-title');
    if (title) { title.setAttribute("tabindex", "-1"); title.focus({ preventScroll: true }); }
    var top = root.getBoundingClientRect().top + window.scrollY - 90;
    if (window.scrollY > top) window.scrollTo({ top: top, behavior: "smooth" });
  }

  function showRequest(reason) {
    if (!requestBox) return;
    requestBox.hidden = false;
    if (reason) requestBox.querySelector("[data-request-reason]").textContent = reason;
    requestBox.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.querySelectorAll("[data-show-request]").forEach(function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); showRequest(); });
  });
  root.querySelectorAll("[data-go]").forEach(function (b) {
    b.addEventListener("click", function () { go(b.getAttribute("data-go")); });
  });

  // --- 1. services (prices + who's taking bookings) ---------------------------
  var serviceInfo = {};
  NP.api("GET", "/api/services").then(function (res) {
    res.services.forEach(function (s) { serviceInfo[s.slug] = s; });
    root.querySelectorAll(".svc").forEach(function (btn) {
      var s = serviceInfo[btn.getAttribute("data-slug")];
      var meta = btn.querySelector(".svc-meta");
      if (!s || !s.vendors) { meta.textContent = "Request only"; btn.classList.add("is-request"); }
      else if (s.price_from_cents != null) meta.textContent = "From " + NP.money(s.price_from_cents);
      else meta.textContent = "Book online";
    });
  }, function (err) {
    if (err.offline) {
      root.querySelectorAll(".svc .svc-meta").forEach(function (m) { m.textContent = "Request"; });
      root.classList.add("is-offline");
    }
  });

  root.querySelectorAll(".svc").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var slug = btn.getAttribute("data-slug");
      var name = btn.querySelector(".svc-name").textContent;
      var s = serviceInfo[slug];
      if (root.classList.contains("is-offline") || (s && !s.vendors)) {
        var input = document.getElementById("b-service");
        if (input) input.value = name;
        showRequest("Online booking for " + name.toLowerCase() + " isn't open yet. Send us a request and we'll set up a time with you.");
        return;
      }
      state.service = slug;
      state.serviceName = name;
      state.priceFrom = s ? s.price_from_cents : null;
      state.start = null;
      root.querySelector('[data-bind="service-name"]').textContent = "· " + name;
      go("time");
      picker.reload().then(function () {
        // Jump straight to the first day with open times (this month or next)
        var first = picker.firstOpen();
        if (first) return picker.select(first);
        return picker.nextMonth().then(function () {
          var f = picker.firstOpen();
          if (f) picker.select(f);
          else slotsBox.innerHTML = '<p class="muted">No open times in the next few weeks. <a href="#request" data-show-request>Send us a request</a> and we\'ll fit you in.</p>';
        });
      });
    });
  });

  // --- 2. day + time -------------------------------------------------------------
  var slotsBox = root.querySelector("[data-slots]");
  slotsBox.addEventListener("click", function (e) {
    if (e.target.closest("[data-show-request]")) { e.preventDefault(); showRequest(); }
  });
  var picker = NP.DatePicker(root.querySelector("[data-cal]"), {
    load: function (from, to) {
      return NP.api("GET", "/api/availability?service=" + encodeURIComponent(state.service) + "&from=" + from + "&to=" + to);
    },
    onPick: function (day, slots) {
      NP.renderSlots(slotsBox, slots, function (start) {
        state.start = start;
        root.querySelector('[data-bind="summary"]').innerHTML = summary();
        go("details");
      }, state.start);
    },
    onError: function (err) {
      slotsBox.innerHTML = '<p class="form-status err" style="display:block">' + NP.esc(err.message) + "</p>";
    },
  });

  function summary() {
    return "<strong>" + NP.esc(state.serviceName) + "</strong><span>" + NP.esc(NP.when(state.start)) + "</span>" +
      (state.priceFrom != null ? '<span class="muted">From ' + NP.money(state.priceFrom) + ", confirmed by your pro</span>" : "");
  }

  // --- 3. details ----------------------------------------------------------------
  var form = root.querySelector('form[data-step="details"]');
  var status = form.querySelector(".form-status");
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem("np-contact") || "{}"); } catch (e) {}
  ["name", "phone", "email", "address", "neighborhood"].forEach(function (k) {
    if (saved[k] && form.elements[k]) form.elements[k].value = saved[k];
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    status.className = "form-status";
    status.textContent = "";
    var bad = Array.prototype.find.call(form.querySelectorAll("[required]"), function (el) { return !el.value.trim(); });
    if (bad) {
      status.className = "form-status err";
      status.textContent = "Please fill in " + (form.querySelector('label[for="' + bad.id + '"]') || {}).textContent.replace(/\(.*\)/, "").trim().toLowerCase() + ".";
      bad.focus();
      return;
    }
    var f = form.elements;
    var body = {
      service: state.service, start: state.start, website: f.website.value,
      name: f.name.value, phone: f.phone.value, email: f.email.value,
      address: f.address.value, neighborhood: f.neighborhood.value, notes: f.notes.value,
    };
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    var label = btn.innerHTML;
    btn.textContent = "Booking…";
    NP.api("POST", "/api/bookings", body).then(function (res) {
      try { localStorage.setItem("np-contact", JSON.stringify({ name: body.name, phone: body.phone, email: body.email, address: body.address, neighborhood: body.neighborhood })); } catch (e) {}
      var link = location.origin + "/booking/?t=" + encodeURIComponent(res.manageToken);
      var b = res.booking;
      root.querySelector('[data-bind="confirmation"]').innerHTML =
        "<strong>" + NP.esc(b.service_name) + "</strong><span>" + NP.esc(NP.when(b.starts_at)) + "</span><span>" + NP.esc(b.address) + "</span>" +
        (b.vendor_first_name ? '<span class="muted">Your pro: ' + NP.esc(b.vendor_first_name) + "</span>" : "");
      var a = root.querySelector('[data-bind="manage-link"]');
      a.href = link; a.textContent = link;
      root.querySelector('[data-bind="manage-btn"]').href = link;
      go("done");
    }, function (err) {
      status.className = "form-status err";
      status.textContent = err.message;
      if (err.code === "slot_taken") {
        // Someone just took it: refresh times and send them back to choose again
        var key = NP.dateKey(state.start);
        state.start = null;
        picker.reload().then(function () {
          go("time");
          picker.select(key);
          slotsBox.insertAdjacentHTML("afterbegin", '<p class="form-status err" style="display:block">Sorry, that time was just taken. Here\'s what\'s still open that day.</p>');
        });
      }
    }).then(function () {
      btn.disabled = false;
      btn.innerHTML = label;
    });
  });

  // Deep link from service pages: /book/?service=Window%20re-screening
  var want = new URLSearchParams(location.search).get("service");
  if (want) {
    var match = Array.prototype.find.call(root.querySelectorAll(".svc"), function (b) {
      return b.querySelector(".svc-name").textContent.toLowerCase() === want.toLowerCase() || b.getAttribute("data-slug") === want;
    });
    if (match) setTimeout(function () { match.click(); }, 300);
  }
})();
