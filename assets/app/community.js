// /community/ — a resident enters their HOA's code and sees resident pricing, pros and group days.
(function () {
  var NP = window.NP;
  var root = document.getElementById("community");
  if (!root || !NP) return;
  var esc = NP.esc;
  var $ = function (sel) { return root.querySelector(sel); };
  var form = $("[data-code-form]");
  var status = form.querySelector(".form-status");

  function saved() { try { return JSON.parse(localStorage.getItem("np-community") || "null"); } catch (e) { return null; } }
  function remember(v) { try { v ? localStorage.setItem("np-community", JSON.stringify(v)) : localStorage.removeItem("np-community"); } catch (e) {} }
  var isCustomer = /(?:^|;\s*)np_role=customer/.test(document.cookie);

  function day(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: NP.TZ, weekday: "long", month: "long", day: "numeric" }).format(new Date(iso)); }

  /** A group day card: prices, how many neighbors have booked, and the button. Shared look with the dashboard. */
  function groupDayCard(g, code) {
    var pct = Math.min(100, Math.round((g.booked / g.min_homes) * 100));
    var left = Math.max(0, g.min_homes - g.booked);
    return '<article class="gd-card">' +
      "<h3>" + esc(g.service.name) + " group day</h3>" +
      '<p class="gd-when">' + esc(day(g.starts_at)) + " · " + esc(NP.time(g.starts_at)) + "–" + esc(NP.time(g.ends_at)) + " · with " + esc(g.pro) + "</p>" +
      '<p class="gd-prices"><span>Resident price <b>' + NP.money(g.resident_price_cents) + "</b></span><span>Group price <b>" + NP.money(g.group_price_cents) + '</b></span><span class="muted">Usually ' + NP.money(g.list_price_cents) + "</span></p>" +
      '<div class="gd-meter' + (g.unlocked ? " is-on" : "") + '" role="img" aria-label="' + g.booked + " of " + g.min_homes + ' homes booked"><i style="width:' + Math.max(pct, 4) + '%"></i></div>' +
      '<p class="gd-progress">' + (g.unlocked
        ? "<strong>Group price unlocked!</strong> " + g.booked + " homes booked. Everyone pays " + NP.money(g.group_price_cents) + "."
        : g.booked + " of " + g.min_homes + " homes booked. " + left + " more and everyone pays " + NP.money(g.group_price_cents) + ".") + "</p>" +
      (g.common_area_job ? '<p class="gd-bonus">When it fills, the community gets a free extra: ' + esc(g.common_area_job) + "</p>" : "") +
      '<div class="gd-foot"><span class="muted">Prices are from-prices; your pro confirms the final price.</span>' +
      '<a class="btn btn-primary btn-sm" href="/book/?groupday=' + encodeURIComponent(g.id) + "&code=" + encodeURIComponent(code) + '">Book a slot</a></div>' +
      "</article>";
  }

  function render(res, code) {
    var c = res.community;
    remember({ code: code, name: c.name, area: c.area.slug, areaName: c.area.name });
    if (isCustomer) NP.api("PUT", "/api/account/community", { code: code }).catch(function () {});
    form.hidden = true;
    $("[data-perks]").hidden = false;
    $('[data-bind="name"]').textContent = c.name;
    document.querySelector('[data-bind="title"]').textContent = c.name + " perks";
    document.querySelector('[data-bind="lede"]').textContent = "Resident pricing and group days with vetted local pros in " + c.area.name + ".";
    $("[data-groupdays]").innerHTML = res.groupDays.length
      ? res.groupDays.map(function (g) { return groupDayCard(g, code); }).join("")
      : '<p class="muted">No group days scheduled yet. We\'ll let your HOA know when one opens.</p>';
    $("[data-pros]").innerHTML = res.pros.length ? res.pros.map(function (p) {
      return '<article class="pro-card"><div class="pro-top">' +
        (p.photo_url ? '<img class="avatar" src="' + esc(p.photo_url) + '" alt="" width="56" height="56" loading="lazy">' : "") +
        "<div><h3>" + esc(p.name) + '</h3><span class="price-tag">' + p.resident_pct + "% off for residents</span></div></div>" +
        '<ul class="pro-svcs">' + p.services.map(function (s) {
          return "<li><span>" + esc(s.name) + "</span>" + (s.price_cents != null ? "<strong>from " + NP.money(s.resident_price_cents) + '<span class="price-was">' + NP.money(s.price_cents) + "</span></strong>" : "") + "</li>";
        }).join("") + "</ul>" +
        '<div class="pro-foot"><span class="muted">Group days: ' + p.group_pct + "% off once " + p.group_min + ' homes book</span>' +
        '<a class="btn btn-primary btn-sm" href="/book/?area=' + encodeURIComponent(c.area.slug) + "&code=" + encodeURIComponent(code) + (p.services[0] ? "&service=" + encodeURIComponent(p.services[0].slug) : "") + '">Book</a></div></article>';
    }).join("") : '<p class="muted">Pros are joining the program now. In the meantime you can <a href="/book/">book any of our pros</a>.</p>';
  }

  function load(code) {
    status.className = "form-status";
    status.textContent = "Checking…";
    NP.api("GET", "/api/community?code=" + encodeURIComponent(code)).then(function (res) {
      status.textContent = "";
      render(res, code.trim().toUpperCase());
    }, function (err) {
      remember(null);
      form.hidden = false;
      $("[data-perks]").hidden = true;
      status.className = "form-status err";
      status.textContent = err.message;
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var code = form.elements.code.value.trim();
    if (!code) { status.className = "form-status err"; status.textContent = "Enter your community's code."; return; }
    load(code);
  });
  $("[data-forget]").addEventListener("click", function () {
    remember(null);
    if (isCustomer) NP.api("PUT", "/api/account/community", { code: "" }).catch(function () {});
    $("[data-perks]").hidden = true;
    form.hidden = false;
    form.elements.code.value = "";
    form.elements.code.focus();
  });

  var fromUrl = new URLSearchParams(location.search).get("code");
  var stored = saved();
  if (fromUrl) { form.elements.code.value = fromUrl; load(fromUrl); }
  else if (stored && stored.code) { form.elements.code.value = stored.code; load(stored.code); }
})();
