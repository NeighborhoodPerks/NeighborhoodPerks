// Customer booking on /book/: location → pros in that area → a pro's calendar → details → confirmed.
(function () {
  var NP = window.NP;
  var root = document.getElementById("booker");
  if (!root || !NP) return;
  var esc = NP.esc;
  var $ = function (sel) { return root.querySelector(sel); };

  var params = new URLSearchParams(location.search);
  var SERVICE_ALIASES = { "window re-screening": "window-rescreening", "pet walking": "pet-walking", "pet sitting": "pet-sitting" };
  var state = {
    area: null,          // { slug, name }
    filter: SERVICE_ALIASES[(params.get("service") || "").toLowerCase()] || params.get("service") || "",
    pros: [],
    pro: null,
    service: null,       // { slug, name, price_cents }
    start: null,
  };
  var steps = ["where", "pros", "time", "details", "done"];
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
  root.querySelectorAll("[data-go]").forEach(function (b) { b.addEventListener("click", function () { go(b.getAttribute("data-go")); }); });

  function showRequest(reason) {
    if (!requestBox) return;
    requestBox.hidden = false;
    if (reason) requestBox.querySelector("[data-request-reason]").textContent = reason;
    requestBox.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-show-request]");
    if (a) { e.preventDefault(); showRequest(); }
  });

  var initials = function (name) { return name.split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase(); };
  function avatar(p, size) {
    return p.photo_url
      ? '<img class="avatar" src="' + esc(p.photo_url) + '" alt="" width="' + size + '" height="' + size + '" loading="lazy">'
      : '<span class="avatar avatar-initials" style="width:' + size + "px;height:" + size + 'px" aria-hidden="true">' + esc(initials(p.name)) + "</span>";
  }
  function shortWhen(iso) {
    var today = NP.todayLocal();
    var key = NP.dateKey(iso);
    var tomorrow = NP.dateKey(new Date(Date.now() + 864e5).toISOString());
    var day = key === today ? "Today" : key === tomorrow ? "Tomorrow" : new Intl.DateTimeFormat("en-US", { timeZone: NP.TZ, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
    return day + ", " + NP.time(iso);
  }

  // --- 1. location -----------------------------------------------------------------
  var whereStatus = $("[data-where-status]");
  function whereErr(msg) { whereStatus.className = "form-status err"; whereStatus.innerHTML = msg; }
  var areas = [];

  function offline() {
    root.classList.add("is-offline");
    $("[data-areas]").innerHTML = "";
    whereErr('Online booking isn\'t switched on yet. <a href="#request" data-show-request>Send us a request</a> or call <a href="tel:+16197363618">(619) 736-3618</a>.');
  }

  NP.api("GET", "/api/areas").then(function (res) {
    areas = res.areas;
    $("[data-areas]").innerHTML = areas.map(function (a) {
      return '<button type="button" class="area-chip" data-area="' + esc(a.slug) + '">' + esc(a.name) + "</button>";
    }).join("") || '<span class="muted">No neighborhoods set up yet.</span>';
    var remembered = params.get("area");
    try { remembered = remembered || localStorage.getItem("np-area"); } catch (e) {}
    var match = areas.find(function (a) { return a.slug === remembered; });
    if (match) chooseArea(match);
  }, function (err) { if (err.offline) offline(); else whereErr(esc(err.message)); });

  $("[data-areas]").addEventListener("click", function (e) {
    var b = e.target.closest("[data-area]");
    if (!b) return;
    chooseArea(areas.find(function (a) { return a.slug === b.getAttribute("data-area"); }));
  });

  $("[data-zip]").addEventListener("submit", function (e) {
    e.preventDefault();
    whereStatus.className = "form-status";
    var zip = $("#w-zip").value.trim();
    if (!/^\d{5}$/.test(zip)) return whereErr("Please enter a 5-digit ZIP code.");
    var hits = areas.filter(function (a) { return (a.zips || []).indexOf(zip) !== -1; });
    if (!hits.length) {
      return whereErr("We don't have pros in " + esc(zip) + ' yet. <a href="#request" data-show-request>Send us a request</a> and we\'ll let you know when we do.');
    }
    if (hits.length === 1) return chooseArea(hits[0]);
    // Several neighborhoods share this ZIP: narrow the chips to those
    root.querySelectorAll("[data-area]").forEach(function (c) {
      c.hidden = !hits.some(function (h) { return h.slug === c.getAttribute("data-area"); });
    });
    whereStatus.className = "form-status ok";
    whereStatus.textContent = zip + " covers a few neighborhoods. Which one is yours?";
  });

  function chooseArea(area) {
    state.area = area;
    try { localStorage.setItem("np-area", area.slug); } catch (e) {}
    $('[data-bind="area-name"]').textContent = area.name;
    root.querySelectorAll("[data-area]").forEach(function (c) { c.hidden = false; });
    go("pros");
    loadPros();
  }

  // --- 2. pros ------------------------------------------------------------------------
  var prosBox = $("[data-pros]");
  function setFilter(slug) {
    state.filter = slug;
    root.querySelectorAll("[data-filter] [data-svc]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-svc") === slug)); });
  }
  $("[data-filter]").addEventListener("click", function (e) {
    var b = e.target.closest("[data-svc]");
    if (!b) return;
    setFilter(b.getAttribute("data-svc"));
    renderPros();
  });

  function loadPros() {
    prosBox.innerHTML = '<p class="muted">Finding pros…</p>';
    setFilter(state.filter);
    NP.api("GET", "/api/pros?area=" + encodeURIComponent(state.area.slug)).then(function (res) {
      state.pros = res.pros;
      renderPros();
    }, function (err) {
      if (err.offline) { go("where"); return offline(); }
      prosBox.innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>";
    });
  }

  function renderPros() {
    var f = state.filter;
    var list = state.pros.filter(function (p) { return !f || p.services.some(function (s) { return s.slug === f; }); });
    if (!list.length) {
      var what = f ? (document.querySelector('[data-filter] [data-svc="' + f + '"]') || {}).textContent.toLowerCase() : "home services";
      prosBox.innerHTML = '<div class="empty-pros"><p><strong>No pros for ' + esc(what) + " in " + esc(state.area.name) + " yet.</strong></p>" +
        '<p class="muted">We\'re adding pros all the time. <a href="#request" data-show-request>Send us a request</a> and we\'ll find someone for you.</p></div>';
      return;
    }
    prosBox.innerHTML = list.map(function (p) {
      var svcs = p.services.filter(function (s) { return !f || s.slug === f; });
      var next = f ? (svcs[0] && svcs[0].next_open) : p.next_open;
      return '<article class="pro-card">' +
        '<div class="pro-top">' + avatar(p, 64) +
        '<div><h3>' + esc(p.business_name || p.name) + "</h3>" + (p.business_name ? '<p class="muted pro-person">' + esc(p.name) + "</p>" : "") + "</div></div>" +
        (p.bio ? '<p class="pro-bio">' + esc(p.bio) + "</p>" : "") +
        '<ul class="pro-svcs">' + svcs.map(function (s) {
          return "<li><span>" + esc(s.name) + "</span>" + (s.price_cents != null ? "<strong>from " + NP.money(s.price_cents) + "</strong>" : "") + "</li>";
        }).join("") + "</ul>" +
        '<div class="pro-foot"><span class="pro-next' + (next ? "" : " is-none") + '">' + (next ? "Next opening: <strong>" + esc(shortWhen(next)) + "</strong>" : "No openings in the next 3 weeks") + "</span>" +
        '<button type="button" class="btn btn-primary btn-sm" data-pro="' + esc(p.id) + '"' + (next ? "" : " disabled") + ">See times</button></div>" +
        "</article>";
    }).join("");
  }
  prosBox.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pro]");
    if (!b) return;
    choosePro(state.pros.find(function (p) { return p.id === b.getAttribute("data-pro"); }));
  });

  // --- 3. a pro's calendar ----------------------------------------------------------------
  var svcSelect = $("#t-svc");
  function choosePro(p) {
    state.pro = p;
    state.start = null;
    var offered = p.services.filter(function (s) { return s.next_open; });
    if (!offered.length) offered = p.services;
    var pick = offered.find(function (s) { return s.slug === state.filter; }) || offered[0];
    state.service = pick;
    $('[data-bind="pro-head"]').innerHTML = avatar(p, 52) + "<div><strong>" + esc(p.business_name || p.name) + "</strong>" +
      '<span class="muted">' + esc(p.business_name ? p.name + " · " : "") + esc(state.area.name) + "</span></div>";
    svcSelect.innerHTML = p.services.map(function (s) {
      return '<option value="' + esc(s.slug) + '"' + (s.slug === pick.slug ? " selected" : "") + ">" + esc(s.name) + (s.price_cents != null ? " · from " + NP.money(s.price_cents) : "") + "</option>";
    }).join("");
    $("[data-svc-pick]").hidden = p.services.length < 2;
    go("time");
    loadCalendar();
  }
  svcSelect.addEventListener("change", function () {
    state.service = state.pro.services.find(function (s) { return s.slug === svcSelect.value; });
    state.start = null;
    loadCalendar();
  });

  var slotsBox = $("[data-slots]");
  var picker = NP.DatePicker($("[data-cal]"), {
    load: function (from, to) {
      return NP.api("GET", "/api/availability?service=" + encodeURIComponent(state.service.slug) + "&vendor=" + encodeURIComponent(state.pro.id) + "&from=" + from + "&to=" + to);
    },
    onPick: function (day, slots) {
      NP.renderSlots(slotsBox, slots, function (start) {
        state.start = start;
        $('[data-bind="summary"]').innerHTML = summary();
        $("#d-hood").value = state.area.name;
        go("details");
      }, state.start);
    },
    onError: function (err) { slotsBox.innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>"; },
  });

  function loadCalendar() {
    slotsBox.innerHTML = '<p class="muted">Loading open times…</p>';
    var next = state.service.next_open;
    picker.reload().then(function () {
      var first = picker.firstOpen();
      if (first) return picker.select(first);
      if (next) {
        // First opening is in a later month: step forward to it
        var hops = 0;
        var step = function () {
          return picker.nextMonth().then(function () {
            var f = picker.firstOpen();
            if (f) return picker.select(f);
            if (++hops < 3) return step();
          });
        };
        return step();
      }
      slotsBox.innerHTML = '<p class="muted">' + esc(state.pro.first_name) + ' has no open times coming up. <button type="button" class="linklike" data-go-pros>See other pros</button>.</p>';
    });
  }
  slotsBox.addEventListener("click", function (e) { if (e.target.closest("[data-go-pros]")) go("pros"); });

  function summary() {
    return "<strong>" + esc(state.service.name) + "</strong><span>" + esc(NP.when(state.start)) + "</span>" +
      '<span class="muted">With ' + esc(state.pro.business_name || state.pro.name) + "</span>" +
      (state.service.price_cents != null ? '<span class="muted">From ' + NP.money(state.service.price_cents) + ", final price confirmed by your pro</span>" : "");
  }

  // --- 4. details --------------------------------------------------------------------------
  var form = root.querySelector('form[data-step="details"]');
  var status = form.querySelector(".form-status");
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem("np-contact") || "{}"); } catch (e) {}
  ["name", "phone", "email", "address"].forEach(function (k) { if (saved[k] && form.elements[k]) form.elements[k].value = saved[k]; });

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
      vendor: state.pro.id, area: state.area.slug, service: state.service.slug, start: state.start, website: f.website.value,
      name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value, neighborhood: state.area.name, notes: f.notes.value,
    };
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    var label = btn.innerHTML;
    btn.textContent = "Booking…";
    NP.api("POST", "/api/bookings", body).then(function (res) {
      try { localStorage.setItem("np-contact", JSON.stringify({ name: body.name, phone: body.phone, email: body.email, address: body.address })); } catch (e) {}
      var link = location.origin + "/booking/?t=" + encodeURIComponent(res.manageToken);
      var b = res.booking;
      $('[data-bind="confirmation"]').innerHTML =
        "<strong>" + esc(b.service_name) + "</strong><span>" + esc(NP.when(b.starts_at)) + "</span><span>" + esc(b.address) + "</span>" +
        '<span class="muted">With ' + esc(b.vendor_business || b.vendor_first_name) + ", who has been notified</span>";
      var a = $('[data-bind="manage-link"]');
      a.href = link; a.textContent = link;
      $('[data-bind="manage-btn"]').href = link;
      go("done");
    }, function (err) {
      status.className = "form-status err";
      status.textContent = err.message;
      if (err.code === "slot_taken") {
        var key = NP.dateKey(state.start);
        state.start = null;
        picker.reload().then(function () {
          go("time");
          picker.select(key);
          slotsBox.insertAdjacentHTML("afterbegin", '<p class="form-status err" style="display:block">Sorry, someone just booked that time. Here\'s what\'s still open that day.</p>');
        });
      }
    }).then(function () { btn.disabled = false; btn.innerHTML = label; });
  });
})();
