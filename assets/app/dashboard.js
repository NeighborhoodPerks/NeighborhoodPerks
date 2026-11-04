// /vendor/ — provider + admin dashboard. Calendar (FullCalendar), hours, services, calendar sync, providers.
(function () {
  var NP = window.NP;
  var root = document.getElementById("dash");
  if (!root || !NP) return;
  var $ = function (sel, el) { return (el || root).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || root).querySelectorAll(sel)); };
  var esc = NP.esc;

  var me = null;
  var cal = null;
  var vendorFilter = ""; // admin: "" = everyone
  var vendors = [];
  var allServices = [];
  var allAreas = [];
  var DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  function view(name) { $$("[data-view]").forEach(function (el) { el.hidden = el.getAttribute("data-view") !== name; }); }
  var isAdmin = function () { return me && me.role === "admin"; };
  // Which vendor the settings tabs act on (admins pick from the filter)
  var scope = function () { return isAdmin() ? (vendorFilter ? "?vendor=" + vendorFilter : null) : ""; };

  var toastTimer;
  function toast(msg, bad) {
    var t = $("[data-toast]");
    t.textContent = msg;
    t.className = "toast" + (bad ? " is-bad" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 7000 : 4000);
  }

  // --- sheet (dialog) ------------------------------------------------------------
  var sheet = $("[data-sheet]");
  function openSheet(html) {
    $('[data-bind="sheet"]').innerHTML = html;
    if (sheet.showModal) sheet.showModal(); else sheet.setAttribute("open", "");
  }
  function closeSheet() { if (sheet.close) sheet.close(); else sheet.removeAttribute("open"); }
  sheet.addEventListener("click", function (e) { if (e.target === sheet) closeSheet(); });

  // --- auth -----------------------------------------------------------------------
  function start() {
    NP.api("GET", "/api/auth/me").then(function (res) {
      me = res.user;
      if (!me) return view("signin");
      if (me.role === "customer") { location.replace("/account/"); return; }
      boot();
    }, function (err) {
      view("signin");
      var s = $('[data-form="signin"] .form-status');
      s.className = "form-status err";
      s.textContent = err.offline ? "The booking system isn't reachable right now. Please try again shortly." : err.message;
    });
  }

  $('[data-form="signin"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var s = $(".form-status", f);
    var btn = $('button[type="submit"]', f);
    btn.disabled = true;
    NP.api("POST", "/api/auth/login", { email: f.email.value, password: f.password.value }).then(function (res) {
      f.password.value = "";
      if (res.role === "customer") { location.href = "/account/"; return; }
      start();
    }, function (err) {
      s.className = "form-status err";
      s.textContent = err.message;
    }).then(function () { btn.disabled = false; });
  });

  function boot() {
    view("app");
    $('[data-bind="hello"]').textContent = isAdmin() ? "Bookings" : "Hi, " + (me.vendor_name || "").split(" ")[0];
    $('[data-bind="role"]').textContent = isAdmin() ? "Admin" : "Provider";
    $$("[data-admin]").forEach(function (el) { el.hidden = !isAdmin(); });
    if (isAdmin()) loadVendors();
    $("[data-pending]").hidden = me.vendor_status !== "pending";
    initCalendar();
    loadInbox();
    var welcome = new URLSearchParams(location.search).get("welcome");
    tab(me.vendor_status === "pending" && welcome ? "profile" : "calendar");
  }

  // --- tabs --------------------------------------------------------------------------
  function tab(name) {
    $$("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === name)); });
    $$("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== name; });
    if (name === "calendar" && cal) setTimeout(function () { cal.updateSize(); }, 0);
    if (name === "hours") loadHours();
    if (name === "profile") loadProfile();
    if (name === "services") loadServices();
    if (name === "sync") loadIcs();
    if (name === "vendors") loadVendors();
  }
  $$("[data-tab]").forEach(function (b) { b.addEventListener("click", function () { tab(b.getAttribute("data-tab")); }); });
  root.addEventListener("click", function (e) { if (e.target.closest("[data-goto-providers]")) tab("vendors"); });

  // --- calendar ---------------------------------------------------------------------
  var COLORS = { confirmed: "#2c6a4b", completed: "#8aa596", cancelled: "#c9bfb0", no_show: "#c24c28" };

  function initCalendar() {
    if (cal || !window.FullCalendar) {
      if (!window.FullCalendar) $("#fc").innerHTML = '<p class="muted">The calendar didn\'t load. Please refresh the page.</p>';
      return;
    }
    var narrow = window.matchMedia("(max-width: 700px)").matches;
    cal = new FullCalendar.Calendar($("#fc"), {
      initialView: narrow ? "listWeek" : "timeGridWeek",
      headerToolbar: narrow
        ? { left: "prev,next", center: "title", right: "today" }
        : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek" },
      footerToolbar: narrow ? { center: "listWeek,timeGridDay,dayGridMonth" } : false,
      buttonText: { today: "Today", month: "Month", week: "Week", day: "Day", list: "List" },
      height: "auto",
      slotMinTime: "06:00:00",
      slotMaxTime: "21:00:00",
      scrollTime: "08:00:00",
      allDaySlot: false,
      eventMinHeight: 40,
      nowIndicator: true,
      firstDay: 1,
      expandRows: true,
      selectable: true,
      selectMirror: true,
      editable: true,
      eventDurationEditable: false,
      longPressDelay: 350,
      noEventsContent: "Nothing booked this week.",
      events: fetchEvents,
      eventClick: function (info) {
        info.jsEvent.preventDefault();
        var p = info.event.extendedProps;
        if (p.kind === "booking") showBooking(p.id);
        if (p.kind === "off") showTimeOff(info.event);
      },
      select: function (info) {
        cal.unselect();
        if (isAdmin() && !vendorFilter) return toast("Choose a provider at the top to block their time.", true);
        askTimeOff(info.start, info.end);
      },
      eventAllow: function (span, ev) { return ev.extendedProps.kind === "booking" && ev.extendedProps.status === "confirmed" && span.start > new Date(); },
      eventDrop: function (info) {
        var ev = info.event;
        confirmMove(ev.extendedProps.id, ev.start, function (ok) { if (!ok) info.revert(); });
      },
      eventDidMount: function (info) {
        var p = info.event.extendedProps;
        if (p.kind === "booking") info.el.title = info.event.title + (p.address ? "\n" + p.address : "");
      },
    });
    cal.render();
    loadBusinessHours();
  }

  function fetchEvents(range, ok, fail) {
    var q = "/api/calendar?from=" + encodeURIComponent(range.start.toISOString()) + "&to=" + encodeURIComponent(range.end.toISOString()) +
      (isAdmin() && vendorFilter ? "&vendor=" + vendorFilter : "");
    NP.api("GET", q).then(function (res) {
      var showVendor = isAdmin() && !vendorFilter;
      var evs = res.bookings.map(function (b) {
        return {
          id: "b-" + b.id,
          title: (b.status === "cancelled" ? "Cancelled · " : "") + b.service_name + " · " + b.customer_name + (showVendor ? " (" + b.vendor_name.split(" ")[0] + ")" : ""),
          start: b.starts_at, end: b.ends_at,
          backgroundColor: COLORS[b.status], borderColor: COLORS[b.status],
          textColor: b.status === "cancelled" ? "#4a5a50" : "#fff",
          classNames: ["ev-" + b.status],
          editable: b.status === "confirmed" && new Date(b.starts_at) > new Date(),
          extendedProps: { kind: "booking", id: b.id, status: b.status, address: b.address },
        };
      }).concat(res.timeOff.map(function (t) {
        return {
          id: "t-" + t.id, title: "Blocked" + (t.note ? " · " + t.note : "") + (showVendor ? " (" + t.vendor_name.split(" ")[0] + ")" : ""),
          start: t.starts_at, end: t.ends_at, editable: false, classNames: ["ev-off"],
          backgroundColor: "#f3ecdf", borderColor: "#d8ccb5", textColor: "#4a5a50",
          extendedProps: { kind: "off", id: t.id },
        };
      }));
      ok(evs);
    }, function (err) {
      if (err.status === 401) return view("signin");
      toast(err.message, true);
      fail(err);
    });
  }

  function loadBusinessHours() {
    if (!cal) return;
    var s = scope();
    if (s === null) { cal.setOption("businessHours", false); return; }
    NP.api("GET", "/api/hours" + s).then(function (res) {
      cal.setOption("businessHours", res.rules.map(function (r) {
        return { daysOfWeek: [r.weekday % 7], startTime: r.start, endTime: r.end };
      }));
    }, function () {});
  }

  var STATUS = { confirmed: "Booked", completed: "Completed", cancelled: "Cancelled", no_show: "No-show" };

  function showBooking(id) {
    openSheet('<p class="muted">Loading…</p>');
    NP.api("GET", "/api/bookings/" + id).then(function (res) {
      var b = res.booking;
      var upcoming = b.status === "confirmed" && new Date(b.starts_at) > new Date();
      var started = new Date(b.starts_at) <= new Date();
      var maps = "https://maps.google.com/?q=" + encodeURIComponent(b.address);
      var history = res.events.map(function (e) {
        return "<li>" + esc(e.type) + " · " + esc(NP.when(e.at)) + ' <span class="muted">by ' + esc(e.actor.replace(/^(vendor|admin):/, "")) + "</span></li>";
      }).join("");
      openSheet(
        '<span class="status-pill is-' + b.status + '">' + STATUS[b.status] + "</span>" +
        "<h2>" + esc(b.service_name) + "</h2>" +
        '<p class="sheet-when">' + esc(NP.when(b.starts_at)) + " – " + esc(NP.time(b.ends_at)) + "</p>" +
        '<dl class="facts">' +
        "<div><dt>Customer</dt><dd>" + esc(b.customer_name) + "</dd></div>" +
        '<div><dt>Phone</dt><dd><a href="tel:' + esc(b.customer_phone.replace(/[^\d+]/g, "")) + '">' + esc(b.customer_phone) + "</a></dd></div>" +
        '<div><dt>Email</dt><dd><a href="mailto:' + esc(b.customer_email) + '">' + esc(b.customer_email) + "</a></dd></div>" +
        '<div><dt>Address</dt><dd><a href="' + maps + '" target="_blank" rel="noopener">' + esc(b.address) + "</a>" + (b.neighborhood ? " · " + esc(b.neighborhood) : "") + "</dd></div>" +
        (b.notes ? "<div><dt>Notes</dt><dd>" + esc(b.notes) + "</dd></div>" : "") +
        (b.price_cents != null ? "<div><dt>Price</dt><dd>From " + NP.money(b.price_cents) + "</dd></div>" : "") +
        (isAdmin() ? "<div><dt>Provider</dt><dd>" + esc(b.vendor_name) + "</dd></div>" : "") +
        (b.cancel_reason ? "<div><dt>Cancel reason</dt><dd>" + esc(b.cancel_reason) + "</dd></div>" : "") +
        "</dl>" +
        '<div class="sheet-actions">' +
        (upcoming ? '<button class="btn btn-dark btn-sm" data-sa="move">Move</button>' : "") +
        (b.status === "confirmed" && started ? '<button class="btn btn-dark btn-sm" data-sa="completed">Mark done</button><button class="btn btn-ghost btn-sm" data-sa="no_show">No-show</button>' : "") +
        (b.status === "confirmed" ? '<button class="btn btn-ghost btn-sm danger" data-sa="cancel">Cancel booking</button>' : "") +
        "</div>" +
        '<div data-sa-panel></div>' +
        '<details class="history"><summary>History</summary><ul>' + history + "</ul></details>"
      );
      bindSheetActions(b);
    }, function (err) { openSheet('<p class="form-status err" style="display:block">' + esc(err.message) + "</p>"); });
  }

  function bindSheetActions(b) {
    var panel = $("[data-sa-panel]", sheet);
    $$("[data-sa]", sheet).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var a = btn.getAttribute("data-sa");
        if (a === "cancel") {
          panel.innerHTML = '<div class="confirm-box"><p><strong>Cancel this booking?</strong> The customer is emailed right away.</p>' +
            '<div class="field"><label for="sx-reason">Reason for the customer <span class="hint">(optional)</span></label><input id="sx-reason" maxlength="500"></div>' +
            '<div class="btn-row mt-s"><button class="btn btn-primary btn-sm" data-yes>Yes, cancel</button><button class="btn btn-ghost btn-sm" data-no>Keep it</button></div></div>';
          $("[data-no]", panel).onclick = function () { panel.innerHTML = ""; };
          $("[data-yes]", panel).onclick = function () {
            NP.api("POST", "/api/bookings/" + b.id + "/cancel", { reason: $("#sx-reason", panel).value }).then(function () {
              closeSheet(); cal.refetchEvents(); toast("Booking cancelled. The customer has been emailed.");
            }, function (err) { toast(err.message, true); });
          };
        }
        if (a === "completed" || a === "no_show") {
          NP.api("POST", "/api/bookings/" + b.id + "/status", { status: a }).then(function () {
            closeSheet(); cal.refetchEvents(); toast(a === "completed" ? "Marked as done." : "Marked as a no-show.");
          }, function (err) { toast(err.message, true); });
        }
        if (a === "move") {
          var d = NP.dateKey(b.starts_at);
          var t = new Intl.DateTimeFormat("en-GB", { timeZone: NP.TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(b.starts_at));
          panel.innerHTML = '<div class="confirm-box"><p><strong>Move to</strong></p><div class="form-grid">' +
            '<div class="field"><label for="mv-d">Date</label><input id="mv-d" type="date" value="' + d + '"></div>' +
            '<div class="field"><label for="mv-t">Time</label><input id="mv-t" type="time" step="900" value="' + t + '"></div></div>' +
            '<div class="btn-row mt-s"><button class="btn btn-primary btn-sm" data-yes>Move booking</button><button class="btn btn-ghost btn-sm" data-no>Never mind</button></div>' +
            '<p class="muted mt-s" style="font-size:.9rem">It has to fit your hours and not clash with other bookings or time off. The customer is emailed.</p></div>';
          $("[data-no]", panel).onclick = function () { panel.innerHTML = ""; };
          $("[data-yes]", panel).onclick = function () {
            var when = localToIso($("#mv-d", panel).value, $("#mv-t", panel).value);
            if (!when) return toast("Pick a date and time.", true);
            doMove(b.id, when, function (ok) { if (ok) closeSheet(); });
          };
        }
      });
    });
  }

  // "2026-11-12" + "14:30" in San Diego → ISO instant
  function localToIso(dateStr, timeStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) return null;
    var guess = new Date(dateStr + "T" + timeStr + ":00Z");
    for (var i = 0; i < 2; i++) {
      var shown = new Intl.DateTimeFormat("en-CA", { timeZone: NP.TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(guess).replace(", ", "T");
      var diff = new Date(dateStr + "T" + timeStr + ":00Z") - new Date(shown + ":00Z");
      guess = new Date(guess.getTime() + diff);
    }
    return guess.toISOString();
  }

  function doMove(id, startIso, done) {
    NP.api("POST", "/api/bookings/" + id + "/reschedule", { start: startIso, keepVendor: true }).then(function (res) {
      cal.refetchEvents();
      toast("Moved to " + NP.when(res.booking.starts_at) + ". The customer has been emailed.");
      done(true);
    }, function (err) {
      toast(err.code === "slot_taken" ? "That time doesn't fit: it's outside your hours, too soon, or clashes with another booking or time off." : err.message, true);
      done(false);
    });
  }

  function confirmMove(id, start, done) {
    openSheet('<h2>Move this booking?</h2><p>New time: <strong>' + esc(NP.when(start.toISOString())) + "</strong></p><p class=\"muted\">The customer will be emailed the new time.</p>" +
      '<div class="btn-row"><button class="btn btn-primary btn-sm" data-yes>Move it</button><button class="btn btn-ghost btn-sm" data-no>Cancel</button></div>');
    var settled = false;
    var finish = function (ok) { if (!settled) { settled = true; done(ok); } };
    $("[data-no]", sheet).onclick = function () { closeSheet(); finish(false); };
    sheet.addEventListener("close", function onClose() { sheet.removeEventListener("close", onClose); finish(false); });
    $("[data-yes]", sheet).onclick = function () {
      doMove(id, start.toISOString(), function (ok) { finish(ok); closeSheet(); });
    };
  }

  function askTimeOff(startD, endD) {
    var allDay = endD - startD >= 86400000 && startD.getHours() === 0;
    openSheet('<h2>Block this time?</h2><p><strong>' + esc(allDay ? NP.dayLong(startD.toISOString()) + (endD - startD > 86400000 ? " – " + NP.dayLong(new Date(endD - 1).toISOString()) : "") : NP.when(startD.toISOString()) + " – " + NP.time(endD.toISOString())) +
      '</strong></p><p class="muted">Customers won\'t be able to book you then.</p>' +
      '<div class="field"><label for="to-note">Note <span class="hint">(only you see this)</span></label><input id="to-note" maxlength="200" placeholder="e.g. Vacation"></div>' +
      '<div class="btn-row mt-s"><button class="btn btn-primary btn-sm" data-yes>Block it</button><button class="btn btn-ghost btn-sm" data-no>Cancel</button></div><div data-msg></div>');
    $("[data-no]", sheet).onclick = closeSheet;
    var send = function (force) {
      NP.api("POST", "/api/time-off" + (isAdmin() ? "?vendor=" + vendorFilter : ""), { start: startD.toISOString(), end: endD.toISOString(), note: $("#to-note", sheet).value, force: force }).then(function () {
        closeSheet(); cal.refetchEvents(); toast("Time blocked.");
      }, function (err) {
        if (err.code === "has_bookings") {
          $("[data-msg]", sheet).innerHTML = '<div class="confirm-box mt-s"><p>' + esc(err.message) + '</p><button class="btn btn-ghost btn-sm" data-force>Block it anyway (keep those bookings)</button></div>';
          $("[data-force]", sheet).onclick = function () { send(true); };
        } else toast(err.message, true);
      });
    };
    $("[data-yes]", sheet).onclick = function () { send(false); };
  }

  function showTimeOff(ev) {
    openSheet("<h2>" + esc(ev.title) + "</h2><p>" + esc(NP.when(ev.start.toISOString())) + " – " + esc(NP.when(ev.end.toISOString())) + "</p>" +
      '<div class="btn-row"><button class="btn btn-ghost btn-sm danger" data-yes>Remove this block</button></div>');
    $("[data-yes]", sheet).onclick = function () {
      NP.api("DELETE", "/api/time-off/" + ev.extendedProps.id, {}).then(function () {
        closeSheet(); cal.refetchEvents(); toast("Block removed. Those times are open again.");
      }, function (err) { toast(err.message, true); });
    };
  }

  // --- hours -------------------------------------------------------------------------
  var hoursState = [];
  function loadHours() {
    var s = scope();
    var box = $('[data-bind="hours"]');
    if (s === null) { box.innerHTML = '<p class="muted">Choose a provider at the top to see their hours.</p>'; return; }
    box.innerHTML = '<p class="muted">Loading…</p>';
    NP.api("GET", "/api/hours" + s).then(function (res) {
      hoursState = res.rules.map(function (r) { return { weekday: r.weekday, start: r.start, end: r.end }; });
      ["min_notice_min", "max_days_ahead", "slot_step_min"].forEach(function (k) {
        var el = $('[name="' + k + '"]');
        if (!Array.prototype.some.call(el.options, function (o) { return o.value === String(res.settings[k]); })) {
          el.insertAdjacentHTML("beforeend", '<option value="' + res.settings[k] + '">' + res.settings[k] + "</option>");
        }
        el.value = String(res.settings[k]);
      });
      renderHours();
    }, function (err) { box.innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>"; });
  }

  function renderHours() {
    var box = $('[data-bind="hours"]');
    box.innerHTML = [1, 2, 3, 4, 5, 6, 7].map(function (d) {
      var blocks = hoursState.filter(function (r) { return r.weekday === d; });
      return '<div class="hours-row" data-day="' + d + '"><label class="day-toggle"><input type="checkbox" ' + (blocks.length ? "checked" : "") + '> ' + DAYS[d] + "</label>" +
        '<div class="hours-blocks">' + (blocks.length ? blocks.map(function (b, i) {
          return '<span class="hours-block"><input type="time" step="900" value="' + b.start + '" data-k="start" data-i="' + i + '" aria-label="' + DAYS[d] + ' start"> – ' +
            '<input type="time" step="900" value="' + b.end + '" data-k="end" data-i="' + i + '" aria-label="' + DAYS[d] + ' end">' +
            (blocks.length > 1 ? '<button type="button" class="linklike" data-rm="' + i + '" aria-label="Remove block">✕</button>' : "") + "</span>";
        }).join("") + '<button type="button" class="linklike" data-add>+ add a break</button>' : '<span class="muted">Not working</span>') + "</div></div>";
    }).join("");
  }

  $('[data-panel="hours"]').addEventListener("change", function (e) {
    var row = e.target.closest(".hours-row");
    if (!row) return;
    var d = Number(row.getAttribute("data-day"));
    if (e.target.type === "checkbox") {
      hoursState = hoursState.filter(function (r) { return r.weekday !== d; });
      if (e.target.checked) hoursState.push({ weekday: d, start: "09:00", end: "17:00" });
      renderHours();
    } else if (e.target.type === "time") {
      var blocks = hoursState.filter(function (r) { return r.weekday === d; });
      blocks[Number(e.target.getAttribute("data-i"))][e.target.getAttribute("data-k")] = e.target.value;
    }
  });
  $('[data-panel="hours"]').addEventListener("click", function (e) {
    var row = e.target.closest(".hours-row");
    if (!row) return;
    var d = Number(row.getAttribute("data-day"));
    var blocks = hoursState.filter(function (r) { return r.weekday === d; });
    if (e.target.hasAttribute("data-add")) {
      // Split the last block with a 1-hour break in the middle
      var last = blocks[blocks.length - 1];
      var mid = Math.round((toMin(last.start) + toMin(last.end)) / 2 / 30) * 30;
      if (toMin(last.end) - toMin(last.start) < 120) return toast("That block is too short to split.", true);
      var oldEnd = last.end;
      last.end = fromMin(mid - 30);
      hoursState.push({ weekday: d, start: fromMin(mid + 30), end: oldEnd });
      renderHours();
    }
    if (e.target.hasAttribute("data-rm")) {
      var victim = blocks[Number(e.target.getAttribute("data-rm"))];
      hoursState = hoursState.filter(function (r) { return r !== victim; });
      renderHours();
    }
  });
  function toMin(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
  function fromMin(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }

  $('[data-act="save-hours"]').addEventListener("click", function () {
    var s = scope();
    if (s === null) return toast("Choose a provider at the top first.", true);
    var body = {
      rules: hoursState.slice().sort(function (a, b) { return a.weekday - b.weekday || a.start.localeCompare(b.start); }),
      settings: { min_notice_min: Number($('[name="min_notice_min"]').value), max_days_ahead: Number($('[name="max_days_ahead"]').value), slot_step_min: Number($('[name="slot_step_min"]').value) },
    };
    NP.api("PUT", "/api/hours" + s, body).then(function (res) {
      hoursState = res.rules.map(function (r) { return { weekday: r.weekday, start: r.start, end: r.end }; });
      renderHours();
      loadBusinessHours();
      toast("Hours saved. Customers see the new times right away.");
    }, function (err) { toast(err.message, true); });
  });

  // --- services -----------------------------------------------------------------------
  function loadServices() {
    var s = scope();
    var box = $('[data-bind="services"]');
    if (s === null) { box.innerHTML = '<p class="muted">Choose a provider at the top to see their services.</p>'; return; }
    NP.api("GET", "/api/my/services" + s).then(function (res) {
      if (!res.services.length) { box.innerHTML = '<p class="muted">No services set up yet. ' + (isAdmin() ? "Add them below." : "Call us and we'll add them.") + "</p>"; }
      else box.innerHTML = res.services.map(serviceRow).join("");
      if (isAdmin()) addServiceForm(box, res.services);
    }, function (err) { box.innerHTML = '<p class="form-status err" style="display:block">' + esc(err.message) + "</p>"; });
  }
  function serviceRow(sv) {
    return '<form class="svc-row" data-svc="' + esc(sv.slug) + '"><strong>' + esc(sv.name) + "</strong>" +
      '<label>Job length <select name="duration_min">' + [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480].map(function (m) {
        return '<option value="' + m + '"' + (m === sv.duration_min ? " selected" : "") + ">" + (m < 60 ? m + " min" : (m / 60) + " hr" + (m > 60 ? "s" : "")) + "</option>";
      }).join("") + (/^(15|30|45|60|90|120|180|240|300|360|480)$/.test(String(sv.duration_min)) ? "" : '<option selected value="' + sv.duration_min + '">' + sv.duration_min + " min</option>") + "</select></label>" +
      '<label>Gap after <select name="buffer_min">' + [0, 15, 30, 45, 60, 90, 120].map(function (m) {
        return '<option value="' + m + '"' + (m === sv.buffer_min ? " selected" : "") + ">" + (m ? m + " min" : "None") + "</option>";
      }).join("") + "</select></label>" +
      (isAdmin() ? '<label>Price from $ <input name="price" inputmode="decimal" size="6" value="' + (sv.price_cents != null ? (sv.price_cents / 100) : "") + '"></label>' : (sv.price_cents != null ? '<span class="muted">From ' + NP.money(sv.price_cents) + "</span>" : "")) +
      '<label class="day-toggle"><input type="checkbox" name="active"' + (sv.active ? " checked" : "") + "> Taking bookings</label>" +
      '<button class="btn btn-dark btn-sm" type="submit">Save</button></form>';
  }
  function addServiceForm(box, have) {
    var missing = allServices.filter(function (s) { return !have.some(function (h) { return h.slug === s.slug; }); });
    if (!missing.length) return;
    box.insertAdjacentHTML("beforeend", '<form class="svc-row add" data-svc-add><strong>Add</strong><select name="slug">' +
      missing.map(function (s) { return '<option value="' + esc(s.slug) + '">' + esc(s.name) + "</option>"; }).join("") +
      '</select><label>Job length (min) <input name="duration_min" type="number" min="15" max="720" step="15" value="60"></label>' +
      '<label>Gap after (min) <input name="buffer_min" type="number" min="0" max="240" step="15" value="15"></label>' +
      '<label>Price from $ <input name="price" inputmode="decimal" size="6"></label><button class="btn btn-dark btn-sm" type="submit">Add service</button></form>');
  }
  function priceCents(v) {
    v = String(v || "").replace(/[$,\s]/g, "");
    if (!v) return null;
    var n = Math.round(Number(v) * 100);
    return isFinite(n) && n >= 0 ? n : NaN;
  }
  $('[data-panel="services"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var add = f.hasAttribute("data-svc-add");
    var body = {
      service: add ? f.slug.value : f.getAttribute("data-svc"),
      duration_min: Number(f.duration_min.value),
      buffer_min: Number(f.buffer_min.value),
      active: add ? true : f.active.checked,
    };
    if (isAdmin()) {
      body.price_cents = priceCents(f.price.value);
      if (Number.isNaN(body.price_cents)) return toast("Price must be a number, like 120 or 89.50.", true);
    }
    NP.api("PUT", "/api/my/services" + scope(), body).then(function () { toast("Saved."); loadServices(); }, function (err) { toast(err.message, true); });
  });

  // --- calendar sync -------------------------------------------------------------------
  function loadIcs(rotate) {
    var s = scope();
    var input = $('[data-bind="ics-url"]');
    if (s === null) { input.value = "Choose a provider at the top first"; return; }
    NP.api(rotate ? "POST" : "GET", "/api/my/ics" + (rotate ? "/rotate" : "") + s, rotate ? {} : undefined).then(function (res) {
      input.value = res.url;
      if (rotate) toast("New link made. The old one no longer works, so subscribe again with this one.");
    }, function (err) { toast(err.message, true); });
  }
  $('[data-act="copy-ics"]').addEventListener("click", function () {
    var input = $('[data-bind="ics-url"]');
    input.select();
    (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.reject()).then(function () { toast("Link copied."); }, function () {
      document.execCommand && document.execCommand("copy"); toast("Link copied.");
    });
  });
  $('[data-act="rotate-ics"]').addEventListener("click", function () { loadIcs(true); });

  // --- admin: providers ------------------------------------------------------------------
  function loadVendors() {
    if (!isAdmin()) return;
    Promise.all([NP.api("GET", "/api/admin/vendors"), NP.api("GET", "/api/admin/services"), NP.api("GET", "/api/admin/areas")]).then(function (r) {
      vendors = r[0].vendors;
      allServices = r[1].services;
      allAreas = r[2].areas;
      renderAreasAdmin();
      var sel = $('[data-bind="vendor-filter"]');
      var keep = sel.value;
      sel.innerHTML = '<option value="">All providers</option>' + vendors.map(function (v) {
        return '<option value="' + v.id + '">' + esc(v.name) + (v.active ? "" : " (paused)") + "</option>";
      }).join("");
      sel.value = keep;
      renderVendors();
      renderNewVendorServices();
      var waiting = vendors.filter(function (v) { return v.status === "pending"; }).length;
      var ab = $("[data-applications]");
      ab.hidden = !waiting;
      if (waiting) ab.innerHTML = "<strong>" + waiting + " provider application" + (waiting === 1 ? " is" : "s are") + " waiting for you.</strong> " +
        '<button type="button" class="linklike" data-goto-providers>Review in Providers</button>';
    }, function (err) { toast(err.message, true); });
  }
  function renderVendors() {
    var box = $('[data-bind="vendors"]');
    if (!vendors.length) { box.innerHTML = '<p class="muted">No providers yet. Add your first one below.</p>'; return; }
    box.innerHTML = '<div class="vendor-list">' + vendors.map(function (v) {
      var stateTag = v.status === "pending" ? '<span class="tag-pending">Waiting for approval</span>' : v.status === "declined" ? '<span class="tag-declined">Declined</span>' : (v.active ? "" : '<span class="tag-declined">Paused</span>');
      return '<div class="vendor-card' + (v.status === "pending" ? " is-pending" : v.active ? "" : " is-paused") + '"><div><strong>' + esc(v.name) + "</strong>" + (v.business_name ? ' <span class="muted">· ' + esc(v.business_name) + "</span>" : "") + " " + stateTag +
        '<div class="muted">' + esc(v.email) + (v.phone ? " · " + esc(v.phone) : "") + "</div>" +
        '<div class="muted" style="font-size:.9rem;margin-top:4px">' + (v.areas && v.areas.length ? esc(v.areas.map(areaName).join(", ")) : "No neighborhoods yet") + "</div>" +
        '<div class="vendor-svcs">' + (v.services.length ? v.services.map(function (s) { return '<span class="chip-sm">' + esc(s.name) + (s.active ? "" : " (off)") + "</span>"; }).join("") : '<span class="muted">No services</span>') + "</div>" +
        (v.has_password ? "" : '<div class="warn-sm">Hasn\'t set a password yet</div>') + "</div>" +
        '<div class="vendor-actions"><button class="btn btn-ghost btn-sm" data-v-cal="' + v.id + '">Calendar</button>' +
        '<button class="btn btn-ghost btn-sm" data-v-invite="' + v.id + '">' + (v.has_password ? "Reset link" : "Sign-in link") + "</button>" +
        (v.status === "approved"
          ? '<button class="btn btn-ghost btn-sm" data-v-active="' + v.id + '" data-on="' + (v.active ? "1" : "0") + '">' + (v.active ? "Pause" : "Resume") + "</button>"
          : '<button class="btn btn-primary btn-sm" data-v-approve="' + v.id + '">Approve</button>' +
            (v.status === "pending" ? '<button class="btn btn-ghost btn-sm danger" data-v-decline="' + v.id + '">Decline</button>' : "")) +
        "</div></div>";
    }).join("") + "</div>";
  }
  function renderNewVendorServices() {
    $('[data-bind="new-vendor-services"]').innerHTML = allServices.filter(function (s) { return s.active; }).map(function (s) {
      return '<div class="svc-row new"><label class="day-toggle"><input type="checkbox" name="svc" value="' + esc(s.slug) + '"> ' + esc(s.name) + "</label>" +
        '<label>Job length (min) <input type="number" data-k="duration_min" min="15" max="720" step="15" value="60"></label>' +
        '<label>Gap after (min) <input type="number" data-k="buffer_min" min="0" max="240" step="15" value="15"></label>' +
        '<label>Price from $ <input data-k="price" inputmode="decimal" size="6"></label></div>';
    }).join("");
  }
  $('[data-panel="vendors"]').addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-v-cal")) {
      $('[data-bind="vendor-filter"]').value = b.getAttribute("data-v-cal");
      $('[data-bind="vendor-filter"]').dispatchEvent(new Event("change"));
      tab("calendar");
    }
    if (b.hasAttribute("data-v-invite")) {
      NP.api("POST", "/api/admin/vendors/" + b.getAttribute("data-v-invite") + "/invite", {}).then(function (res) { showInvite(res.inviteUrl); }, function (err) { toast(err.message, true); });
    }
    if (b.hasAttribute("data-v-approve")) {
      NP.api("POST", "/api/admin/vendors/" + b.getAttribute("data-v-approve") + "/approve", {}).then(function () {
        toast("Approved. They're now bookable in their neighborhoods, and we've emailed them."); loadVendors();
      }, function (err) { toast(err.message, true); });
    }
    if (b.hasAttribute("data-v-decline")) {
      var row = b.closest(".vendor-card");
      if (!row.querySelector("[data-confirm-decline]")) {
        row.insertAdjacentHTML("beforeend", '<div class="confirm-box" data-confirm-decline style="width:100%">Decline this application? They won\'t be able to sign in. <button class="btn btn-ghost btn-sm danger" data-v-decline-yes="' + b.getAttribute("data-v-decline") + '">Yes, decline</button></div>');
        return;
      }
    }
    if (b.hasAttribute("data-v-decline-yes")) {
      NP.api("POST", "/api/admin/vendors/" + b.getAttribute("data-v-decline-yes") + "/decline", {}).then(function () {
        toast("Application declined."); loadVendors();
      }, function (err) { toast(err.message, true); });
    }
    if (b.hasAttribute("data-v-active")) {
      NP.api("PATCH", "/api/admin/vendors/" + b.getAttribute("data-v-active"), { active: b.getAttribute("data-on") !== "1" }).then(function () {
        toast(b.getAttribute("data-on") === "1" ? "Paused. They can't sign in and customers can't book them." : "Resumed."); loadVendors();
      }, function (err) { toast(err.message, true); });
    }
  });
  function showInvite(url) {
    openSheet('<h2>Sign-in link</h2><p>Send this to the provider by text or email. It works once and expires in 7 days. They\'ll choose their own password.</p>' +
      '<div class="copy-row"><input readonly value="' + esc(url) + '" aria-label="Sign-in link"><button class="btn btn-dark btn-sm" data-copy>Copy</button></div>');
    $("[data-copy]", sheet).onclick = function () {
      var i = $("input", sheet); i.select();
      (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(function () { toast("Link copied."); }, function () { toast("Select the link and copy it."); });
    };
  }
  $('[data-form="add-vendor"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var s = $(".form-status", f);
    var services = [];
    var bad = null;
    $$(".svc-row.new", f).forEach(function (row) {
      var cb = $('input[name="svc"]', row);
      if (!cb.checked) return;
      var price = priceCents($('[data-k="price"]', row).value);
      if (Number.isNaN(price)) bad = "Prices must be numbers, like 120.";
      services.push({ service: cb.value, duration_min: Number($('[data-k="duration_min"]', row).value), buffer_min: Number($('[data-k="buffer_min"]', row).value), price_cents: price });
    });
    if (bad) { s.className = "form-status err"; s.textContent = bad; return; }
    var areaSlugs = $$('[data-bind="new-vendor-areas"] input:checked', f).map(function (i) { return i.value; });
    NP.api("POST", "/api/admin/vendors", { name: f.name.value, business_name: f.business_name.value, email: f.email.value, phone: f.phone.value, services: services, areas: areaSlugs }).then(function (res) {
      f.reset();
      s.className = "form-status";
      loadVendors();
      showInvite(res.inviteUrl);
    }, function (err) { s.className = "form-status err"; s.textContent = err.message; });
  });


  // --- areas (admin) -------------------------------------------------------------------
  function areaName(slug) { var a = allAreas.find(function (x) { return x.slug === slug; }); return a ? a.name : slug; }
  function renderAreasAdmin() {
    $('[data-bind="areas-admin"]').innerHTML = allAreas.map(function (a) {
      var n = vendors.filter(function (v) { return v.active && (v.areas || []).indexOf(a.slug) !== -1; }).length;
      return '<div class="area-row"><strong>' + esc(a.name) + '</strong><span class="muted">' + esc((a.zips || []).join(", ") || "no ZIPs") + "</span>" +
        '<span class="chip-sm">' + n + " provider" + (n === 1 ? "" : "s") + "</span>" + (a.active ? "" : '<span class="warn-sm">hidden</span>') + "</div>";
    }).join("");
    $('[data-bind="new-vendor-areas"]').innerHTML = allAreas.filter(function (a) { return a.active; }).map(function (a) {
      return '<label><input type="checkbox" value="' + esc(a.slug) + '"> ' + esc(a.name) + "</label>";
    }).join("");
  }
  $('[data-form="add-area"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    NP.api("POST", "/api/admin/areas", { name: f.name.value, zips: f.zips.value }).then(function (res) {
      allAreas = res.areas; f.reset(); renderAreasAdmin(); toast("Neighborhood saved.");
    }, function (err) { toast(err.message, true); });
  });

  // --- profile ---------------------------------------------------------------------------
  var profileAreas = [];
  function photoHtml(url, name) {
    return url ? '<img class="avatar" src="' + esc(url) + '" alt="Your photo" width="88" height="88">'
      : '<span class="avatar avatar-initials" style="width:88px;height:88px">' + esc((name || "?").split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase()) + "</span>";
  }
  function renderProfile(p) {
    $('[data-bind="photo"]').innerHTML = photoHtml(p.photo_url, p.name);
    $('[data-act="remove-photo"]').hidden = !p.photo_url;
    var f = $('[data-form="profile"]');
    f.business_name.value = p.business_name || "";
    f.phone.value = p.phone || "";
    f.bio.value = p.bio || "";
    $('[data-bind="profile-areas"]').innerHTML = profileAreas.map(function (a) {
      return '<label><input type="checkbox" value="' + esc(a.slug) + '"' + (p.areas.indexOf(a.slug) !== -1 ? " checked" : "") + "> " + esc(a.name) + "</label>";
    }).join("");
  }
  function loadProfile() {
    var s = scope();
    if (s === null) { $('[data-bind="profile-areas"]').innerHTML = '<p class="muted">Choose a provider at the top to edit their profile.</p>'; return; }
    NP.api("GET", "/api/my/profile" + s).then(function (res) { profileAreas = res.areas; renderProfile(res.profile); }, function (err) { toast(err.message, true); });
  }
  $('[data-form="profile"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var s = scope();
    if (s === null) return toast("Choose a provider at the top first.", true);
    var f = e.target;
    var areas = $$('[data-bind="profile-areas"] input:checked').map(function (i) { return i.value; });
    if (!areas.length) return toast("Pick at least one neighborhood, or customers won't find you.", true);
    NP.api("PUT", "/api/my/profile" + s, { business_name: f.business_name.value, phone: f.phone.value, bio: f.bio.value, areas: areas }).then(function (res) {
      renderProfile(res.profile); toast("Profile saved. Homeowners see it right away.");
      if (isAdmin()) loadVendors();
    }, function (err) { toast(err.message, true); });
  });

  // Resize in the browser so uploads stay small and fast (max 600px, JPEG)
  function resizeImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 600;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("We couldn't read that image. Try a JPG or PNG.")); };
      img.src = url;
    });
  }
  $("#p-photo").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    var s = scope();
    if (s === null) return toast("Choose a provider at the top first.", true);
    if (!/^image\//.test(file.type)) return toast("Please choose an image file.", true);
    toast("Uploading…");
    resizeImage(file).then(function (dataUrl) {
      return NP.api("POST", "/api/my/photo" + s, { dataUrl: dataUrl });
    }).then(function (res) { renderProfile(res.profile); toast("Photo updated."); if (isAdmin()) loadVendors(); }, function (err) { toast(err.message, true); });
  });
  $('[data-act="remove-photo"]').addEventListener("click", function () {
    NP.api("DELETE", "/api/my/photo" + scope(), {}).then(function (res) { renderProfile(res.profile); toast("Photo removed."); }, function (err) { toast(err.message, true); });
  });

  // --- what's new --------------------------------------------------------------------------
  var INBOX_LABEL = { created: "New booking", rescheduled: "Moved", cancelled: "Cancelled" };
  function loadInbox() {
    NP.api("GET", "/api/my/inbox").then(function (res) {
      var box = $("[data-inbox]");
      if (!res.items.length) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = "<h2>What's new since you last checked</h2><ul>" + res.items.map(function (i) {
        return '<li><span class="tag-new tag-' + i.type + '">' + INBOX_LABEL[i.type] + "</span>" +
          "<span><strong>" + esc(i.service_name) + "</strong> · " + esc(i.customer_name) + " · " + esc(NP.when(i.starts_at)) + (isAdmin() ? ' <span class="muted">(' + esc(i.vendor_name) + ")</span>" : "") + "</span>" +
          '<button type="button" class="linklike" data-open="' + i.booking_id + '">Details</button></li>';
      }).join("") + '</ul><div class="inbox-foot"><button type="button" class="btn btn-ghost btn-sm" data-act="inbox-seen">Got it</button></div>';
    }, function () {});
  }
  $("[data-inbox]").addEventListener("click", function (e) {
    var o = e.target.closest("[data-open]");
    if (o) showBooking(o.getAttribute("data-open"));
    if (e.target.closest('[data-act="inbox-seen"]')) {
      NP.api("POST", "/api/my/inbox/seen", {}).then(function () { $("[data-inbox]").hidden = true; });
    }
  });

  $('[data-bind="vendor-filter"]').addEventListener("change", function (e) {
    vendorFilter = e.target.value;
    if (cal) { cal.refetchEvents(); loadBusinessHours(); }
    var active = ($('[role="tab"][aria-selected="true"]') || {}).getAttribute && $('[role="tab"][aria-selected="true"]').getAttribute("data-tab");
    if (active && active !== "calendar" && active !== "vendors") tab(active);
  });

  $('[data-act="signout"]').addEventListener("click", function () {
    NP.api("POST", "/api/auth/logout", {}).then(function () { location.reload(); }, function () { location.reload(); });
  });

  // Keep the calendar fresh if the tab sits open all day
  setInterval(function () { if (cal && !document.hidden) { cal.refetchEvents(); loadInbox(); } }, 120000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden && cal) { cal.refetchEvents(); loadInbox(); } });

  start();
})();
