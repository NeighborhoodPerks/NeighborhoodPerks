// Shared helpers for the booking pages and the dashboard. Exposes window.NP.
(function () {
  var TZ = "America/Los_Angeles";

  function api(method, path, body) {
    var opts = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error) || "Something went wrong. Please try again.");
          err.status = res.status;
          err.code = data && data.code;
          // A missing API (static preview, no backend yet) shows up as 404 HTML
          err.offline = (!data && (res.status === 404 || res.status >= 500)) || (data && data.code === "not_configured");
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error("We couldn't reach the booking system. Check your connection and try again.");
      err.offline = true;
      throw err;
    });
  }

  function fmt(iso, opts) {
    return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: TZ }, opts)).format(new Date(iso));
  }
  var time = function (iso) { return fmt(iso, { hour: "numeric", minute: "2-digit" }); };
  var dayLong = function (iso) { return fmt(iso, { weekday: "long", month: "long", day: "numeric" }); };
  var when = function (iso) { return dayLong(iso) + " at " + time(iso); };
  var hourOf = function (iso) { return Number(fmt(iso, { hour: "numeric", hourCycle: "h23" })); };

  // Today's date in San Diego as YYYY-MM-DD
  function todayLocal() {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return p;
  }
  // YYYY-MM-DD of an instant, in San Diego
  function dateKey(iso) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  }
  function money(cents) {
    if (cents == null) return "";
    return "$" + (cents / 100).toFixed(cents % 100 ? 2 : 0);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ymd(y, m, d) { return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"); }

  /** Month-grid date picker. onPick(dateStr); load(fromYmd, toYmd) -> Promise<{days:{ymd:[iso]}}> */
  function DatePicker(root, opts) {
    var grid = root.querySelector("[data-cal-grid]");
    var label = root.querySelector("[data-cal-label]");
    var today = todayLocal();
    var view = { y: +today.slice(0, 4), m: +today.slice(5, 7) };
    var minView = { y: view.y, m: view.m };
    var days = {};
    var selected = null;
    var token = 0;

    function render(loading) {
      label.textContent = new Date(Date.UTC(view.y, view.m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      var first = new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay(); // 0 = Sunday
      var count = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
      var html = ["S", "M", "T", "W", "T", "F", "S"].map(function (d) { return '<span class="cal-dow" aria-hidden="true">' + d + "</span>"; }).join("");
      for (var i = 0; i < first; i++) html += "<span></span>";
      for (var d = 1; d <= count; d++) {
        var key = ymd(view.y, view.m, d);
        var n = (days[key] || []).length;
        var open = !loading && n > 0;
        var cls = "cal-day" + (open ? " is-open" : "") + (key === selected ? " is-selected" : "") + (key === today ? " is-today" : "");
        html += '<button type="button" class="' + cls + '" data-day="' + key + '"' + (open ? "" : " disabled") +
          ' aria-label="' + esc(new Date(key + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })) +
          (open ? ", " + n + " open times" : ", no open times") + '">' + d + "</button>";
      }
      grid.innerHTML = html;
      root.querySelector("[data-cal-prev]").disabled = view.y === minView.y && view.m === minView.m;
      root.classList.toggle("is-loading", !!loading);
    }

    function load() {
      var my = ++token;
      render(true);
      var from = ymd(view.y, view.m, 1);
      if (from < today) from = today;
      var to = ymd(view.y, view.m, new Date(Date.UTC(view.y, view.m, 0)).getUTCDate());
      return opts.load(from, to).then(function (res) {
        if (my !== token) return;
        days = Object.assign(days, res.days);
        render(false);
        return res;
      }, function (err) {
        if (my !== token) return;
        render(false);
        if (opts.onError) opts.onError(err);
      });
    }

    grid.addEventListener("click", function (e) {
      var b = e.target.closest("[data-day]");
      if (!b || b.disabled) return;
      selected = b.getAttribute("data-day");
      render(false);
      opts.onPick(selected, days[selected] || []);
    });
    root.querySelector("[data-cal-prev]").addEventListener("click", function () {
      view.m--; if (view.m < 1) { view.m = 12; view.y--; } load();
    });
    root.querySelector("[data-cal-next]").addEventListener("click", function () {
      view.m++; if (view.m > 12) { view.m = 1; view.y++; } load();
    });

    return {
      reload: function () { days = {}; return load(); },
      slotsFor: function (key) { return days[key] || []; },
      /** Jump to the first month with an open day and select it */
      firstOpen: function () {
        var keys = Object.keys(days).filter(function (k) { return days[k].length; }).sort();
        return keys[0] || null;
      },
      select: function (key) { selected = key; render(false); opts.onPick(key, days[key] || []); },
      nextMonth: function () { view.m++; if (view.m > 12) { view.m = 1; view.y++; } return load(); },
    };
  }

  /** Renders time buttons grouped into Morning / Afternoon / Evening. */
  function renderSlots(container, slots, onPick, chosen) {
    if (!slots.length) {
      container.innerHTML = '<p class="muted">No open times that day. Try another day.</p>';
      return;
    }
    var groups = [["Morning", 0, 12], ["Afternoon", 12, 17], ["Evening", 17, 24]];
    container.innerHTML = groups.map(function (g) {
      var list = slots.filter(function (s) { var h = hourOf(s); return h >= g[1] && h < g[2]; });
      if (!list.length) return "";
      return '<div class="slot-group"><h3>' + g[0] + '</h3><div class="slot-list">' + list.map(function (s) {
        return '<button type="button" class="slot' + (s === chosen ? " is-selected" : "") + '" data-slot="' + s + '">' + time(s) + "</button>";
      }).join("") + "</div></div>";
    }).join("");
    container.onclick = function (e) {
      var b = e.target.closest("[data-slot]");
      if (b) onPick(b.getAttribute("data-slot"));
    };
  }

  // --- payments ---------------------------------------------------------------
  var configP = null;
  function config() {
    return configP || (configP = api("GET", "/api/config").catch(function () { return { payments: false }; }));
  }
  var stripeP = null;
  /** Stripe.js, loaded only when payments are on. Resolves to the Stripe instance (or null). */
  function stripeJs() {
    if (stripeP) return stripeP;
    stripeP = config().then(function (c) {
      if (!c.payments || !c.publishableKey) return null;
      return new Promise(function (resolve, reject) {
        if (window.Stripe) return resolve(window.Stripe(c.publishableKey));
        var s = document.createElement("script");
        s.src = "https://js.stripe.com/v3/";
        s.onload = function () { resolve(window.Stripe(c.publishableKey)); };
        s.onerror = function () { reject(new Error("Couldn't load the secure card form. Check your connection and try again.")); };
        document.head.appendChild(s);
      });
    });
    return stripeP;
  }
  var stripeAppearance = {
    theme: "stripe",
    variables: { colorPrimary: "#1f4d36", colorText: "#17261d", colorDanger: "#c24c28", fontFamily: "Figtree, system-ui, sans-serif", borderRadius: "10px" },
  };
  /**
   * A card form that saves the card for later (SetupIntent), for accepting a quote. Mounts into `box`
   * when payments are on. save({ name, email, phone }) resolves to the SetupIntent id, or null when
   * payments are off. (The booking page keeps its own copy, in booking.js.)
   */
  function cardForm(box) {
    var st = { on: false, stripe: null, elements: null, id: null };
    var ready = stripeJs().then(function (stripe) {
      if (!stripe) return false;
      st.on = true;
      st.stripe = stripe;
      st.elements = stripe.elements({ mode: "setup", currency: "usd", paymentMethodTypes: ["card"], appearance: stripeAppearance });
      st.elements.create("payment", { fields: { billingDetails: { email: "never" } } }).mount(box);
      return true;
    });
    return {
      ready: ready,
      save: function (who) {
        return ready.then(function (on) {
          if (!on) return null;
          if (st.id) return st.id;
          return st.elements.submit().then(function (r) {
            if (r.error) throw new Error(r.error.message);
            return api("POST", "/api/payments/setup", { email: who.email, name: who.name, phone: who.phone });
          }).then(function (setup) {
            return st.stripe.confirmSetup({ elements: st.elements, clientSecret: setup.clientSecret, redirect: "if_required",
              confirmParams: { return_url: location.href, payment_method_data: { billing_details: { email: who.email } } } });
          }).then(function (r) {
            if (r.error) throw new Error(r.error.message);
            st.id = r.setupIntent.id;
            return st.id;
          });
        });
      },
    };
  }

  /** What happens to a price waiting for the customer's OK (same rule as lib/payments.mjs approvalDeadline). */
  function approvalRule(bookedCents) {
    return "Your card isn't charged until you approve. If you don't agree, nothing extra is charged and your pro will get in touch. " +
      (bookedCents == null ? "If you don't answer within 7 days, nothing is charged." : "If you don't answer within 7 days, we charge the " + money(bookedCents) + " you booked at, not the extra.");
  }

  /** Shrink a photo in the browser before upload (JPEG, longest side `max` px). */
  function resizeImage(file, max) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("We couldn't read that image. Try a JPG or PNG.")); };
      img.src = url;
    });
  }

  /**
   * Pay an amount that's due (after a declined card): mounts a card form in `box`, confirms with Stripe,
   * then calls `done()` so the server can check with Stripe directly.
   */
  function payNow(box, clientSecret, amountCents, done) {
    return stripeJs().then(function (stripe) {
      if (!stripe) throw new Error("Payments aren't available right now. Please call us.");
      var elements = stripe.elements({ clientSecret: clientSecret, appearance: stripeAppearance });
      box.innerHTML = '<div class="pay-element"></div><div class="form-foot"><button type="button" class="btn btn-primary">Pay ' + money(amountCents) + '</button><span class="muted pay-secure">Secured by Stripe</span></div><div class="form-status" role="alert"></div>';
      elements.create("payment").mount(box.querySelector(".pay-element"));
      var btn = box.querySelector("button");
      var st = box.querySelector(".form-status");
      btn.onclick = function () {
        btn.disabled = true;
        btn.textContent = "Paying…";
        stripe.confirmPayment({ elements: elements, confirmParams: { return_url: location.href }, redirect: "if_required" }).then(function (r) {
          if (r.error) { st.className = "form-status err"; st.textContent = r.error.message; btn.disabled = false; btn.textContent = "Pay " + money(amountCents); return; }
          return done();
        });
      };
    });
  }
  /**
   * Tip picker: suggested amounts or a custom one, charged to the card on file.
   * send(dollars) posts the tip; finish() records one the browser had to confirm; done(cents) runs after.
   */
  function tipBox(box, info, send, finish, done) {
    var pick = info.suggestions[1] ? info.suggestions[1].cents : 500;
    box.innerHTML = '<div class="tip-choices">' + info.suggestions.map(function (s) {
      return '<button type="button" class="tip-choice" data-cents="' + s.cents + '"><b>' + money(s.cents) + "</b><span>" + s.pct + "%</span></button>";
    }).join("") + '<label class="tip-choice tip-custom"><span>Other $</span><input inputmode="decimal" maxlength="7" aria-label="Other amount"></label></div>' +
      '<div class="form-foot"><button type="button" class="btn btn-primary" data-send>Tip ' + money(pick) + '</button><span class="muted">100% goes to ' + esc(info.pro) + ". Charged to the card you booked with.</span></div>" +
      '<div class="form-status" role="alert"></div><div data-tip-card></div>';
    var btn = box.querySelector("[data-send]");
    var st = box.querySelector(".form-status");
    var custom = box.querySelector(".tip-custom input");
    function choose(cents) {
      pick = cents;
      box.querySelectorAll("[data-cents]").forEach(function (b) { b.classList.toggle("is-selected", Number(b.getAttribute("data-cents")) === cents); });
      btn.textContent = cents >= 100 ? "Tip " + money(cents) : "Choose an amount";
      btn.disabled = !(cents >= 100);
    }
    box.querySelectorAll("[data-cents]").forEach(function (b) { b.onclick = function () { custom.value = ""; choose(Number(b.getAttribute("data-cents"))); }; });
    custom.oninput = function () { var v = Number(String(custom.value).replace(/[$,\s]/g, "")); choose(isFinite(v) ? Math.round(v * 100) : 0); };
    choose(pick);
    btn.onclick = function () {
      if (pick > info.max_cents) { st.className = "form-status err"; st.textContent = "The most you can tip here is " + money(info.max_cents) + "."; return; }
      btn.disabled = true;
      btn.textContent = "Sending…";
      st.className = "form-status";
      send(pick / 100).then(function (r) {
        if (r.status === "paid" || r.status === "processing") return done(pick);
        if (r.status === "needs_card") {
          st.className = "form-status err";
          st.textContent = "Your bank needs you to confirm this, or you can use another card.";
          return payNow(box.querySelector("[data-tip-card]"), r.clientSecret, r.amount, function () { return finish().then(function () { done(pick); }); });
        }
        throw new Error(r.message || "That didn't go through. Please try again.");
      }).catch(function (err) { st.className = "form-status err"; st.textContent = err.message; choose(pick); });
    };
  }
  var PAY_LABEL = { card_saved: "Card on file", needs_approval: "Final price waiting for approval", processing: "Payment processing", paid: "Paid", failed: "Payment needed", refunded: "Refunded", partially_refunded: "Partly refunded" };

  window.NP = { api: api, config: config, stripeJs: stripeJs, stripeAppearance: stripeAppearance, payNow: payNow, tipBox: tipBox, PAY_LABEL: PAY_LABEL, cardForm: cardForm, resizeImage: resizeImage, approvalRule: approvalRule, dateKey: dateKey, time: time, dayLong: dayLong, when: when, money: money, esc: esc, todayLocal: todayLocal, DatePicker: DatePicker, renderSlots: renderSlots, TZ: TZ };
})();
