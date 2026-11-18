// Customer booking on /book/: location → search a service → pick a time (with a pro who offers it) → details → confirmed.
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
    want: SERVICE_ALIASES[(params.get("service") || "").toLowerCase()] || params.get("service") || "", // ?service= from a link
    pros: [],
    slug: null,          // the service the customer chose
    allServices: [],     // every service we list, so a search can say "not here yet" instead of nothing
    pro: null,
    service: null,       // { slug, name, price_cents }
    start: null,
    community: null,     // { code, name, area, areaName } once a resident has entered their HOA's code
    groupDay: null,      // booking a slot on a community group day
  };
  var steps = ["where", "service", "time", "details", "done"];
  var requestBox = document.querySelector("[data-request]");

  function go(step) {
    root.querySelectorAll(".bk-step").forEach(function (el) { el.hidden = el.getAttribute("data-step") !== step; });
    var idx = steps.indexOf(step === "quote" ? "time" : step === "quote-done" ? "done" : step);
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
    box.innerHTML = "<span>Resident pricing for <strong>" + esc(state.community.name) + "</strong> is on. Pros in the program take it off automatically.</span>" +
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
    // Our home neighborhoods first; wider areas (only listed once a pro serves them) behind "More areas"
    var more = areas.filter(function (a) { return a.home === false; }).length;
    $("[data-areas]").innerHTML = areas.map(function (a) {
      return '<button type="button" class="area-chip' + (a.home === false ? " more" : "") + '" data-area="' + esc(a.slug) + '">' + esc(a.name) + "</button>";
    }).join("") + (more ? '<button type="button" class="area-more" data-more-areas>More areas (' + more + ")</button>" : "") ||
      '<span class="muted">No neighborhoods set up yet.</span>';
    if (more) $("[data-areas]").classList.add("collapsed");
    var remembered = params.get("area");
    try { remembered = remembered || localStorage.getItem("np-area"); } catch (e) {}
    var match = areas.find(function (a) { return a.slug === remembered; });
    if (match && !params.get("groupday")) communityReady.then(function () { chooseArea(match); });
  }, function (err) { if (err.offline) offline(); else whereErr(esc(err.message)); });

  function showAllAreas() { $("[data-areas]").classList.remove("collapsed"); }
  $("[data-areas]").addEventListener("click", function (e) {
    if (e.target.closest("[data-more-areas]")) return showAllAreas();
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
    showAllAreas();
    root.querySelectorAll("[data-area]").forEach(function (c) {
      c.hidden = !hits.some(function (h) { return h.slug === c.getAttribute("data-area"); });
    });
    whereStatus.className = "form-status ok";
    whereStatus.textContent = zip + " covers a few neighborhoods. Which one is yours?";
  });

  function chooseArea(area) {
    state.area = area;
    try { localStorage.setItem("np-area", area.slug); } catch (e) {}
    root.querySelectorAll('[data-bind="area-name"]').forEach(function (el) { el.textContent = area.name; });
    root.querySelectorAll("[data-area]").forEach(function (c) { c.hidden = false; });
    go("service");
    loadPros();
  }

  // --- 2. service: search what the pros here offer ------------------------------------------
  var resultsBox = $("[data-svc-results]");
  var qInput = $("#s-q");
  NP.api("GET", "/api/services").then(function (res) { state.allServices = res.services || []; if (state.pros.length || state.area) renderServices(); }, function () {});

  function loadPros() {
    resultsBox.innerHTML = '<li class="muted">Finding services…</li>';
    NP.api("GET", "/api/pros?area=" + encodeURIComponent(state.area.slug)).then(function (res) {
      state.pros = res.pros;
      communityBanner();
      var want = state.want;
      state.want = "";
      if (want && offered().some(function (s) { return s.slug === want; })) return chooseService(want);
      if (want) qInput.value = (state.allServices.find(function (s) { return s.slug === want; }) || { name: want.replace(/-/g, " ") }).name;
      renderServices();
      if (window.matchMedia("(min-width: 760px)").matches) qInput.focus({ preventScroll: true });
    }, function (err) {
      if (err.offline) { go("where"); return offline(); }
      resultsBox.innerHTML = '<li class="form-status err" style="display:block">' + esc(err.message) + "</li>";
    });
  }

  /** Services bookable in this area, one row each, rolled up across the pros who offer them. */
  function offered() {
    var map = {}, list = [];
    state.pros.forEach(function (p) {
      p.services.forEach(function (s) {
        var row = map[s.slug];
        if (!row) { row = map[s.slug] = { slug: s.slug, name: s.name, pros: 0, price: null, next: null, quotes: false, discount: false }; list.push(row); }
        row.pros++;
        var price = residentPrice(p, s.price_cents);
        if (price != null && (row.price == null || price < row.price)) row.price = price;
        if (s.next_open && (!row.next || s.next_open < row.next)) row.next = s.next_open;
        if (s.quotes) row.quotes = true;
        if (p.hoa && residentHere()) row.discount = true;
      });
    });
    return list;
  }
  var norm = function (t) { return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); };
  var SYNONYMS = { dog: "pet walking pet sitting", cat: "pet sitting", maid: "cleaning", clean: "cleaning", yard: "landscaping", lawn: "landscaping", pool: "pool", car: "auto detailing mechanic", pipe: "plumbing", leak: "plumbing" };
  function matches(name, q) {
    if (!q) return true;
    var n = " " + norm(name);
    var has = function (w) { return n.indexOf(" " + w) !== -1; }; // word starts only: "pet" must not hit "carpet"
    return q.split(" ").every(function (w) {
      if (has(w)) return true;
      return Object.keys(SYNONYMS).some(function (k) { return k.indexOf(w) === 0 && SYNONYMS[k].split(" ").filter(function (x) { return x.length > 2; }).some(has); });
    });
  }

  function renderServices() {
    if (!state.area) return;
    var q = norm(qInput.value);
    var here = offered();
    var hits = here.filter(function (s) { return matches(s.name, q); });
    var hereSlugs = here.map(function (s) { return s.slug; });
    var elsewhere = q ? state.allServices.filter(function (s) { return hereSlugs.indexOf(s.slug) === -1 && matches(s.name, q); }).slice(0, 4) : [];
    var html = hits.map(function (s) {
      var meta = [s.pros + (s.pros === 1 ? " pro" : " pros")];
      if (s.price != null) meta.push("from " + NP.money(s.price));
      else if (s.quotes) meta.push("priced by quote");
      return '<li><button type="button" class="svc-result" data-pick-svc="' + esc(s.slug) + '">' +
        '<span class="svc-result-main"><strong>' + esc(s.name) + "</strong><span>" + esc(meta.join(" · ")) + (s.discount ? ' · <span class="price-tag">resident price</span>' : "") + "</span></span>" +
        '<span class="svc-result-next' + (s.next ? "" : " is-none") + '">' + (s.next ? "Next: " + esc(shortWhen(s.next)) : s.quotes ? "Get a quote" : "Fully booked") + "</span>" +
        '<span class="svc-result-go" aria-hidden="true">›</span></button></li>';
    }).join("");
    html += elsewhere.map(function (s) {
      return '<li><div class="svc-result is-soon"><span class="svc-result-main"><strong>' + esc(s.name) + "</strong><span>No pros in " + esc(state.area.name) + ' yet</span></span>' +
        '<button type="button" class="linklike" data-request-svc="' + esc(s.name) + '">Request it</button></div></li>';
    }).join("");
    if (!html) {
      html = here.length
        ? '<li class="svc-none"><strong>No match for “' + esc(qInput.value.trim()) + '”.</strong> <button type="button" class="linklike" data-request-svc="' + esc(qInput.value.trim()) + '">Ask us to find a pro</button></li>'
        : '<li class="svc-none"><strong>No pros are booking in ' + esc(state.area.name) + ' yet.</strong> <button type="button" class="linklike" data-request-svc="">Send us a request</button> and we\'ll find someone.</li>';
    }
    resultsBox.innerHTML = html;
  }
  qInput.addEventListener("input", renderServices);
  qInput.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    var first = resultsBox.querySelector("[data-pick-svc]");
    if (first) first.click();
  });
  resultsBox.addEventListener("click", function (e) {
    var r = e.target.closest("[data-request-svc]");
    if (r) {
      var field = document.getElementById("b-service");
      if (field && r.getAttribute("data-request-svc")) field.value = r.getAttribute("data-request-svc");
      return showRequest("Tell us what you need in " + state.area.name + " and we'll find a pro for it.");
    }
    var b = e.target.closest("[data-pick-svc]");
    if (b) chooseService(b.getAttribute("data-pick-svc"));
  });

  // --- 3. time: the pros who offer it, and the chosen pro's calendar --------------------------
  function prosFor(slug) {
    return state.pros.filter(function (p) { return p.services.some(function (s) { return s.slug === slug; }); }).sort(function (a, b) {
      var na = svcOf(a, slug).next_open || "9999", nb = svcOf(b, slug).next_open || "9999";
      return na.localeCompare(nb) || a.name.localeCompare(b.name);
    });
  }
  function svcOf(p, slug) { return p.services.find(function (s) { return s.slug === slug; }); }

  function chooseService(slug) {
    state.slug = slug;
    var list = prosFor(slug);
    if (!list.length) return;
    $('[data-bind="svc-kicker"]').textContent = svcOf(list[0], slug).name + " · " + state.area.name;
    renderProChoice(list);
    go("time");
    choosePro(list.find(function (p) { return svcOf(p, slug).next_open; }) || list[0]);
  }

  var choiceBox = $("[data-pro-choice]");
  function renderProChoice(list) {
    list = list || prosFor(state.slug);
    choiceBox.hidden = list.length < 2;
    if (list.length < 2) { choiceBox.innerHTML = ""; return; }
    choiceBox.innerHTML = '<p class="pro-choice-label">' + list.length + " pros offer this here. Pick one:</p>" + list.map(function (p) {
      var s = svcOf(p, state.slug);
      var on = state.pro && state.pro.id === p.id;
      return '<button type="button" role="radio" aria-checked="' + on + '" class="pro-opt" data-pro="' + esc(p.id) + '">' + avatar(p, 40) +
        '<span class="pro-opt-main"><strong>' + esc(p.business_name || p.name) + "</strong>" +
        "<span>" + (s.price_cents != null ? "from " + priceHtml(p, s.price_cents) + " · " : "") + (s.next_open ? "next " + esc(shortWhen(s.next_open)) : "no openings soon") + "</span></span></button>";
    }).join("");
  }
  choiceBox.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pro]");
    if (b) choosePro(state.pros.find(function (p) { return p.id === b.getAttribute("data-pro"); }));
  });

  function choosePro(p) {
    state.pro = p;
    state.start = null;
    state.service = svcOf(p, state.slug);
    renderProChoice();
    var quote = state.service.quotes;
    $('[data-bind="pro-head"]').innerHTML = avatar(p, 52) + '<div class="pro-head-main"><strong>' + esc(p.business_name || p.name) + "</strong>" +
      '<span class="muted">' + esc(p.business_name ? p.name + " · " : "") + (state.service.price_cents != null ? "from " + priceHtml(p, state.service.price_cents) : "Priced by quote") +
      (p.hoa && residentHere() ? " · " + p.hoa.resident_pct + "% resident discount" : "") + "</span>" +
      (p.bio ? '<p class="pro-bio">' + esc(p.bio) + "</p>" + (p.bio.length > 160 || p.bio.split("\n").length > 3 ? '<button type="button" class="linklike pro-more" data-more>Read more</button>' : "") : "") +
      "</div>" + (quote ? '<button type="button" class="btn btn-ghost btn-sm" data-quote>Get a quote</button>' : "");
    // With the picker showing, the header only adds the pro's bio (and quote button), not their name again
    var head = $('[data-bind="pro-head"]');
    var compact = !choiceBox.hidden;
    head.classList.toggle("is-compact", compact);
    head.hidden = compact && !p.bio && !quote;
    loadCalendar();
  }
  $('[data-bind="pro-head"]').addEventListener("click", function (e) {
    var more = e.target.closest("[data-more]");
    if (more) {
      var open = more.previousElementSibling.classList.toggle("is-open");
      more.textContent = open ? "Show less" : "Read more";
      return;
    }
    if (e.target.closest("[data-quote]")) openQuote(state.pro);
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
        askHomeSize();
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
      var others = prosFor(state.slug).length > 1;
      slotsBox.innerHTML = '<p class="muted">' + esc(state.pro.first_name) + " has no open times coming up." +
        (state.service.quotes ? ' <button type="button" class="linklike" data-quote-here>Ask for a quote instead</button>.' : others ? " Try another pro above." : ' <button type="button" class="linklike" data-go-service>Pick another service</button>.') + "</p>";
    });
  }
  slotsBox.addEventListener("click", function (e) {
    if (e.target.closest("[data-go-service]")) go("service");
    if (e.target.closest("[data-quote-here]")) openQuote(state.pro);
  });

  // House cleaning is priced by home size, so the pro needs it to confirm the price
  var SIZED_SERVICES = ["house-cleaning", "recurring-cleaning", "deep-cleaning"];
  function askHomeSize() {
    var on = !!(state.service && SIZED_SERVICES.indexOf(state.service.slug) !== -1);
    $("[data-home-size]").hidden = !on;
    $("#d-size").required = on;
  }

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
        if (state.area && state.pros.length) { communityBanner(); renderServices(); }
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
    if (f.home_size.required && f.home_size.value) body.notes = ("Home size: " + f.home_size.value + "\n" + body.notes).trim();
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

  // --- quote request: the pro sees the job first, then sends a price ------------------------
  function quoteSvcs(p, slug) {
    return p.services.filter(function (s) { return s.quotes && (!slug || s.slug === slug); });
  }
  var qForm = root.querySelector('form[data-step="quote"]');
  var qStatus = qForm.querySelector(".form-status");
  var qPhotos = [];
  var qToken = null;
  function formToken() {
    return NP.api("GET", "/api/auth/form-token").then(function (r) { qToken = r.token; }, function () {});
  }
  function openQuote(p) {
    state.pro = p;
    var svcs = quoteSvcs(p, state.slug);
    if (!svcs.length) svcs = quoteSvcs(p);
    $('[data-bind="quote-head"]').innerHTML = avatar(p, 52) + "<div><strong>" + esc(p.business_name || p.name) + "</strong>" +
      '<span class="muted">' + esc(p.business_name ? p.name + " · " : "") + esc(state.area.name) + "</span></div>";
    $('[data-bind="quote-pro"]').textContent = p.first_name;
    $("#q-svc").innerHTML = svcs.map(function (s) { return '<option value="' + esc(s.slug) + '">' + esc(s.name) + "</option>"; }).join("");
    $("[data-quote-svc-pick]").hidden = svcs.length < 2;
    ["name", "phone", "email", "address"].forEach(function (k) { if (!qForm.elements[k].value) qForm.elements[k].value = form.elements[k].value || saved[k] || ""; });
    qStatus.className = "form-status";
    formToken();
    go("quote");
  }
  function renderQuotePhotos() {
    $("[data-quote-photos]").innerHTML = qPhotos.map(function (src, i) {
      return '<li><img src="' + src + '" alt="Photo ' + (i + 1) + '"><button type="button" class="linklike" data-drop-photo="' + i + '">Remove</button></li>';
    }).join("");
  }
  $("#q-photos").addEventListener("change", function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = "";
    var room = 3 - qPhotos.length;
    if (files.length > room) { qStatus.className = "form-status err"; qStatus.textContent = "You can add up to 3 photos."; files = files.slice(0, room); }
    Promise.all(files.filter(function (f) { return /^image\//.test(f.type); }).map(function (f) { return NP.resizeImage(f, 1400); })).then(function (urls) {
      qPhotos = qPhotos.concat(urls).slice(0, 3);
      renderQuotePhotos();
    }, function (err) { qStatus.className = "form-status err"; qStatus.textContent = err.message; });
  });
  $("[data-quote-photos]").addEventListener("click", function (e) {
    var d = e.target.closest("[data-drop-photo]");
    if (!d) return;
    qPhotos.splice(Number(d.getAttribute("data-drop-photo")), 1);
    renderQuotePhotos();
  });
  qForm.addEventListener("submit", function (e) {
    e.preventDefault();
    qStatus.className = "form-status";
    var bad = Array.prototype.find.call(qForm.querySelectorAll("[required]"), function (el) { return !el.value.trim(); });
    if (bad) {
      qStatus.className = "form-status err";
      qStatus.textContent = "Please fill in " + (qForm.querySelector('label[for="' + bad.id + '"]') || {}).textContent.replace(/\(.*\)/, "").replace("?", "").trim().toLowerCase() + ".";
      bad.focus();
      return;
    }
    var f = qForm.elements;
    if (f.details.value.trim().length < 10) { qStatus.className = "form-status err"; qStatus.textContent = "Please say a little more about the job."; f.details.focus(); return; }
    var btn = qForm.querySelector('button[type="submit"]');
    var label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "Sending…";
    NP.api("POST", "/api/quotes", {
      vendor: state.pro.id, area: state.area.slug, service: f.service.value, details: f.details.value, photos: qPhotos,
      name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value, website: f.website.value, form_token: qToken,
    }).then(function (res) {
      try { localStorage.setItem("np-contact", JSON.stringify({ name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value })); } catch (e) {}
      $('[data-bind="quote-done-text"]').textContent = "We sent your request to " + (state.pro.business_name || state.pro.name) + ". " + state.pro.first_name + " will reply with a price, usually within 2 days.";
      var link = res.token ? "/quote/?t=" + encodeURIComponent(res.token) : "/";
      $('[data-bind="quote-link"]').href = link;
      qPhotos = []; renderQuotePhotos(); f.details.value = "";
      go("quote-done");
    }, function (err) {
      qStatus.className = "form-status err";
      qStatus.textContent = err.message;
      if (err.code === "form_token") formToken();
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
      $('[data-step="time"] [data-go="service"]').hidden = true;
      $("[data-group-back]").hidden = false;
      $("[data-cal]").hidden = true;
      $(".tz-note").textContent = "Times are San Diego time. No travel buffer on group days: the next home is next door.";
      go("time");
      loadGroupDay();
    });
  }
})();
