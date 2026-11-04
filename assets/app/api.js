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

  window.NP = { api: api, dateKey: dateKey, time: time, dayLong: dayLong, when: when, money: money, esc: esc, todayLocal: todayLocal, DatePicker: DatePicker, renderSlots: renderSlots, TZ: TZ };
})();
