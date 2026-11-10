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
    community: null,     // { code, name, area, areaName } once a resident has entered their HOA's code
    groupDay: null,      // booking a slot on a community group day
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

  // --- HOA residents ---------------------------------------------------------------------
  function savedCommunity() { try { return JSON.parse(localStorage.getItem("np-community") || "null"); } catch (e) { return null; } }
  function rememberCommunity(v) { try { v ? localStorage.setItem("np-community", JSON.stringify(v)) : localStorage.removeItem("np-community"); } catch (e) {} }
  /** The resident discount applies in the community's own neighborhood, with pros in the program. */
  var residentHere = function () { return !!(state.community && state.area && state.area.slug === state.community.area); };
  var residentPrice = function (p, cents) { return cents == null || !p.hoa || !residentHere() ? cents : Math.round(cents * (100 - p.hoa.resident_pct) / 100); };
  function priceHtml(p, cents) {
    var r = residentPrice(p, cents);
    return r !== cents ? NP.money(r) + '<span class="price-was">' + NP.money(cents) + "</span>" : NP.money(cents);
  }
  var communityReady = (function () {
    var code = params.get("code");
    var stored = savedCommunity();
    if (!code) { state.community = stored && stored.code ? stored : null; return Promise.resolve(); }
    if (stored && stored.code === code.trim().toUpperCase()) { state.community = stored; return Promise.resolve(); }
    return NP.api("GET", "/api/community?code=" + encodeURIComponent(code)).then(function (res) {
      state.community = { code: code.trim().toUpperCase(), name: res.community.name, area: res.community.area.slug, areaName: res.community.area.name };
      rememberCommunity(state.community);
    }, function () { state.community = null; });
  })();
  function communityBanner() {
    var box = $("[data-community-banner]");
    if (!box) return;
    if (!residentHere()) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = "<span>Resident pricing for <strong>" + esc(state.community.name) + "</strong> is on. Pros marked below take it off automatically.</span>" +
      '<a class="linklike" href="/community/">Group days</a>';
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
    if (match && !params.get("groupday")) communityReady.then(function () { chooseArea(match); });
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
      renderChips();
      renderPros();
    }, function (err) {
      if (err.offline) { go("where"); return offline(); }
      prosBox.innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>";
    });
  }

  // Filter buttons = the services the pros here actually offer (a new trade shows up once a pro offers it)
  function renderChips() {
    var seen = {}, list = [];
    state.pros.forEach(function (p) {
      p.services.forEach(function (s) { if (!seen[s.slug]) { seen[s.slug] = true; list.push(s); } });
    });
    if (state.filter && !seen[state.filter]) list.push({ slug: state.filter, name: state.filter.replace(/-/g, " ") });
    $("[data-filter]").innerHTML = '<button type="button" data-svc="" aria-pressed="false">All</button>' + list.map(function (s) {
      return '<button type="button" data-svc="' + esc(s.slug) + '" aria-pressed="false">' + esc(s.name) + "</button>";
    }).join("");
    $("[data-filter]").hidden = list.length < 2 && !state.filter;
    setFilter(state.filter);
  }

  function renderPros() {
    communityBanner();
    var f = state.filter;
    var list = state.pros.filter(function (p) { return !f || p.services.some(function (s) { return s.slug === f; }); });
    if (!list.length) {
      var chip = document.querySelector('[data-filter] [data-svc="' + f + '"]');
      var what = f ? (chip ? chip.textContent : f.replace(/-/g, " ")).toLowerCase() : "home services";
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
          return "<li><span>" + esc(s.name) + "</span>" + (s.price_cents != null ? "<strong>from " + priceHtml(p, s.price_cents) + "</strong>" : "") + "</li>";
        }).join("") + "</ul>" +
        (p.hoa && residentHere() ? '<p class="mb-0"><span class="price-tag">' + p.hoa.resident_pct + "% resident discount</span></p>" : "") +
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
      return '<option value="' + esc(s.slug) + '"' + (s.slug === pick.slug ? " selected" : "") + ">" + esc(s.name) + (s.price_cents != null ? " · from " + NP.money(residentPrice(p, s.price_cents)) : "") + "</option>";
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
    var g = state.groupDay;
    var price = g
      ? '<span class="muted">' + (g.unlocked || g.booked + 1 >= g.min_homes
          ? "Group price: from " + NP.money(g.group_price_cents) + '<span class="price-was">' + NP.money(g.list_price_cents) + "</span>"
          : "Resident price: from " + NP.money(g.resident_price_cents) + ". Drops to " + NP.money(g.group_price_cents) + " for everyone when " + g.min_homes + " homes book.") + "</span>"
      : state.service.price_cents != null ? '<span class="muted">From ' + priceHtml(state.pro, state.service.price_cents) + (residentPrice(state.pro, state.service.price_cents) !== state.service.price_cents ? " (resident price)" : "") + ", final price confirmed by your pro</span>" : "";
    return "<strong>" + esc(state.service.name) + (g ? " · group day" : "") + "</strong><span>" + esc(NP.when(state.start)) + "</span>" +
      '<span class="muted">With ' + esc(g ? g.pro : state.pro.business_name || state.pro.name) + "</span>" + price;
  }

  // --- payments: card saved now, charged after the job ------------------------------------
  var pay = { on: false, stripe: null, elements: null, setupIntentId: null };
  NP.config().then(function (c) {
    if (!c.payments) return;
    pay.on = true;
    $("[data-pay]").hidden = false;
    $('[data-bind="charge-note"]').textContent = "Your card isn't charged until the job is done.";
    return NP.stripeJs().then(function (stripe) {
      if (!stripe) return;
      pay.stripe = stripe;
      pay.elements = stripe.elements({ mode: "setup", currency: "usd", paymentMethodTypes: ["card"], appearance: NP.stripeAppearance });
      pay.elements.create("payment", { fields: { billingDetails: { email: "never" } } }).mount($("[data-pay-element]"));
    });
  }).catch(function (err) {
    $("[data-pay-element]").innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>";
  });

  /** Saves the card once (reused if the customer has to pick another time). Resolves to the SetupIntent id. */
  function saveCard(f) {
    if (!pay.on) return Promise.resolve(null);
    if (pay.setupIntentId) return Promise.resolve(pay.setupIntentId);
    if (!pay.stripe || !pay.elements) return Promise.reject(new Error("The card form is still loading. Please try again in a moment."));
    return pay.elements.submit().then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return NP.api("POST", "/api/payments/setup", { email: f.email.value, name: f.name.value, phone: f.phone.value });
    }).then(function (setup) {
      return pay.stripe.confirmSetup({
        elements: pay.elements, clientSecret: setup.clientSecret, redirect: "if_required",
        confirmParams: { return_url: location.href, payment_method_data: { billing_details: { email: f.email.value } } },
      });
    }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      pay.setupIntentId = r.setupIntent.id;
      return pay.setupIntentId;
    });
  }

  // --- 4. details --------------------------------------------------------------------------
  var form = root.querySelector('form[data-step="details"]');
  var status = form.querySelector(".form-status");
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem("np-contact") || "{}"); } catch (e) {}
  ["name", "phone", "email", "address"].forEach(function (k) { if (saved[k] && form.elements[k]) form.elements[k].value = saved[k]; });
  // Signed-in homeowners: fill in their saved details (the server decides; the cookie is only a hint to ask)
  if (/(?:^|;\s*)np_role=customer/.test(document.cookie)) {
    NP.api("GET", "/api/account").then(function (res) {
      var p = res.profile;
      if (p.name) form.elements.name.value = p.name;
      if (p.phone) form.elements.phone.value = p.phone;
      if (p.email) { form.elements.email.value = p.email; form.elements.email.readOnly = true; form.elements.email.classList.add("readonly"); }
      if (p.address) form.elements.address.value = p.address;
      // Their saved HOA community: show resident prices (the server applies it either way)
      if (p.community_code && !state.community) {
        state.community = { code: p.community_code, name: p.community_name, area: p.community_area, areaName: p.community_area_name };
        rememberCommunity(state.community);
        if (state.area && state.pros.length) renderPros();
      }
    }, function () {});
  }

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
    var body = state.groupDay
      ? { group_day: state.groupDay.id, community_code: state.community.code, start: state.start, website: f.website.value,
          name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value, neighborhood: state.community.areaName, notes: f.notes.value }
      : { vendor: state.pro.id, area: state.area.slug, service: state.service.slug, start: state.start, website: f.website.value,
          name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value, neighborhood: state.area.name, notes: f.notes.value };
    if (!state.groupDay && residentHere()) body.community_code = state.community.code;
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    var label = btn.innerHTML;
    btn.textContent = pay.on && !pay.setupIntentId ? "Saving card…" : "Booking…";
    saveCard(form.elements).then(function (setupIntent) {
      if (setupIntent) body.setup_intent = setupIntent;
      btn.textContent = "Booking…";
      return NP.api("POST", "/api/bookings", body);
    }).then(function (res) {
      try { localStorage.setItem("np-contact", JSON.stringify({ name: body.name, phone: body.phone, email: body.email, address: body.address })); } catch (e) {}
      var link = location.origin + "/booking/?t=" + encodeURIComponent(res.manageToken);
      var b = res.booking;
      $('[data-bind="confirmation"]').innerHTML =
        "<strong>" + esc(b.service_name) + "</strong><span>" + esc(NP.when(b.starts_at)) + "</span><span>" + esc(b.address) + "</span>" +
        '<span class="muted">With ' + esc(b.vendor_business || b.vendor_first_name) + ", who has been notified</span>" +
        (b.price_kind && b.price_cents != null ? '<span class="muted">' + (b.price_kind === "group" ? "Group price" : "Resident price") + ": from " + NP.money(b.price_cents) +
          (b.list_price_cents > b.price_cents ? '<span class="price-was">' + NP.money(b.list_price_cents) + "</span>" : "") + "</span>" : "") +
        (res.groupUnlocked ? "<span><strong>You unlocked the group price for everyone on this group day!</strong></span>" : "");
      var a = $('[data-bind="manage-link"]');
      a.href = link; a.textContent = link;
      $('[data-bind="manage-btn"]').href = res.inAccount ? "/account/" : link;
      $('[data-bind="manage-btn"]').textContent = res.inAccount ? "See it in My account" : "View my booking";
      $('[data-bind="account-note"]').innerHTML = res.inAccount
        ? "It's saved in your account too."
        : 'Want all your bookings in one place? <a href="/signin/?mode=signup">Create a free account</a> with the same email.';
      go("done");
    }, function (err) {
      status.className = "form-status err";
      status.textContent = err.message;
      if (err.code === "invalid_community_code") { rememberCommunity(null); state.community = null; communityBanner(); }
      if (err.code === "slot_taken" && state.groupDay) {
        state.start = null;
        loadGroupDay().then(function () {
          go("time");
          slotsBox.insertAdjacentHTML("afterbegin", '<p class="form-status err" style="display:block">Sorry, a neighbor just took that slot. Here\'s what\'s still open.</p>');
        });
        return;
      }
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

  // --- group day: one pro, one day, residents pick a slot --------------------------------
  var groupDayId = params.get("groupday");
  function loadGroupDay() {
    slotsBox.innerHTML = '<p class="muted">Loading open times…</p>';
    return NP.api("GET", "/api/group-days/" + encodeURIComponent(groupDayId) + "?code=" + encodeURIComponent(state.community.code)).then(function (res) {
      var g = res.groupDay;
      state.groupDay = g;
      state.service = { slug: g.service.slug, name: g.service.name };
      state.area = { slug: state.community.area, name: state.community.areaName };
      $('[data-bind="pro-head"]').innerHTML = "<div><strong>" + esc(g.service.name) + " group day</strong>" +
        '<span class="muted">' + esc(res.community.name) + " · with " + esc(g.pro) + "</span></div>";
      var left = Math.max(0, g.min_homes - g.booked);
      var info = $("[data-group-info]");
      info.hidden = false;
      info.innerHTML = '<div class="gd-meter' + (g.unlocked ? " is-on" : "") + '"><i style="width:' + Math.max(4, Math.min(100, Math.round(g.booked / g.min_homes * 100))) + '%"></i></div>' +
        '<p class="gd-progress mt-s">' + (g.unlocked ? "<strong>Group price unlocked:</strong> everyone pays from " + NP.money(g.group_price_cents) + "."
          : g.booked + " of " + g.min_homes + " homes booked. " + left + " more and everyone pays from " + NP.money(g.group_price_cents) + " instead of " + NP.money(g.resident_price_cents) + ".") + "</p>";
      $("[data-group-back]").href = "/community/?code=" + encodeURIComponent(state.community.code);
      if (g.status !== "open") { slotsBox.innerHTML = '<p class="muted">This group day was cancelled.</p>'; return; }
      NP.renderSlots(slotsBox, res.slots, function (start) {
        state.start = start;
        $('[data-bind="summary"]').innerHTML = summary();
        $("#d-hood").value = state.community.areaName;
        go("details");
      }, state.start);
      if (!res.slots.length) slotsBox.innerHTML = '<p class="muted">Every slot on this group day is taken. <a href="/community/">See other group days</a>.</p>';
    }, function (err) {
      slotsBox.innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>";
    });
  }
  if (groupDayId) {
    communityReady.then(function () {
      if (!state.community) {
        go("where");
        whereErr('Booking a group day needs your community code. <a href="/community/">Enter it here</a>.');
        return;
      }
      root.classList.add("is-group-day");
      $('[data-go="pros"]').hidden = true;
      $("[data-group-back]").hidden = false;
      $("[data-cal]").hidden = true;
      $(".tz-note").textContent = "Times are San Diego time. No travel buffer on group days: the next home is next door.";
      go("time");
      loadGroupDay();
    });
  }
})();
