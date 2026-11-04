// /signin/ — sign in or create an account, as a homeowner or a service pro.
(function () {
  var NP = window.NP;
  var root = document.getElementById("signin");
  if (!root || !NP) return;
  var esc = NP.esc;
  var $ = function (sel, el) { return (el || root).querySelector(sel); };
  var params = new URLSearchParams(location.search);
  var who = params.get("as") === "pro" ? "provider" : "customer";
  var mode = params.get("mode") === "signup" ? "signup" : params.get("mode") === "forgot" ? "forgot" : "signin";
  // Only same-site paths are allowed as a return address
  var next = params.get("next");
  if (!next || !/^\/[a-z0-9/_-]*\/?(\?[\w=&%.-]*)?$/i.test(next)) next = null;

  function destination(role) {
    if (role === "customer") return next || "/account/";
    return "/vendor/";
  }

  var TEXT = {
    customer: { title: "Welcome back", sub: "Sign in to see and manage your bookings." },
    provider: { title: "Pro sign in", sub: "Sign in to your calendar, profile and hours." },
  };

  function render() {
    root.querySelectorAll("[data-who]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-who") === who)); });
    var show = mode === "signup" ? "signup-" + who : mode;
    root.querySelectorAll("form[data-form]").forEach(function (f) { f.hidden = f.getAttribute("data-form") !== show; });
    $('[data-bind="signin-title"]').textContent = TEXT[who].title;
    $('[data-bind="signin-sub"]').textContent = TEXT[who].sub;
    var first = $('form[data-form="' + show + '"] input:not([type=hidden])');
    if (first) first.focus({ preventScroll: true });
    if (show === "signup-provider") loadChoices();
  }

  root.addEventListener("click", function (e) {
    var w = e.target.closest("[data-who]");
    if (w) { who = w.getAttribute("data-who"); render(); }
    var g = e.target.closest("[data-go]");
    if (g) { mode = g.getAttribute("data-go"); render(); }
  });

  function status(form, msg, ok) {
    var s = $(".form-status", form);
    s.className = "form-status " + (ok ? "ok" : "err");
    s.textContent = msg;
  }
  function busy(form, on, label) {
    var b = $('button[type="submit"]', form);
    if (on) { b.dataset.label = b.textContent; b.textContent = label; } else if (b.dataset.label) b.textContent = b.dataset.label;
    b.disabled = on;
  }
  function missing(form) {
    var bad = Array.prototype.find.call(form.querySelectorAll("[required]"), function (el) { return !el.value.trim(); });
    if (!bad) return false;
    var label = form.querySelector('label[for="' + bad.id + '"]');
    status(form, "Please fill in " + (label ? label.textContent.replace(/\(.*\)/, "").trim().toLowerCase() : "every field") + ".");
    bad.focus();
    return true;
  }

  // --- sign in ---
  $('form[data-form="signin"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    if (missing(f)) return;
    busy(f, true, "Signing in…");
    NP.api("POST", "/api/auth/login", { email: f.email.value, password: f.password.value }).then(function (res) {
      location.href = destination(res.role);
    }, function (err) { status(f, err.message); busy(f, false); });
  });

  // --- homeowner sign up ---
  $('form[data-form="signup-customer"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    if (missing(f)) return;
    if (f.password.value.length < 10) return status(f, "Use at least 10 characters for your password.");
    busy(f, true, "Creating…");
    NP.api("POST", "/api/auth/signup", { as: "customer", name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value }).then(function (res) {
      location.href = destination(res.role) + (destination(res.role).indexOf("?") === -1 ? "?welcome=1" : "");
    }, function (err) { status(f, err.message); busy(f, false); });
  });

  // --- provider sign up ---
  var choicesLoaded = false;
  function loadChoices() {
    if (choicesLoaded) return;
    choicesLoaded = true;
    Promise.all([NP.api("GET", "/api/services"), NP.api("GET", "/api/areas")]).then(function (r) {
      $('[data-bind="svc-checks"]').innerHTML = r[0].services.map(function (s) {
        return '<label><input type="checkbox" name="services" value="' + esc(s.slug) + '"> ' + esc(s.name) + "</label>";
      }).join("");
      $('[data-bind="area-checks"]').innerHTML = r[1].areas.map(function (a) {
        return '<label><input type="checkbox" name="areas" value="' + esc(a.slug) + '"> ' + esc(a.name) + "</label>";
      }).join("");
    }, function (err) {
      choicesLoaded = false;
      status($('form[data-form="signup-provider"]'), err.offline ? "Sign-up isn't available right now. Please call or text (619) 736-3618." : err.message);
    });
  }
  $('form[data-form="signup-provider"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    if (missing(f)) return;
    if (f.password.value.length < 10) return status(f, "Use at least 10 characters for your password.");
    var services = Array.prototype.map.call(f.querySelectorAll('input[name="services"]:checked'), function (i) { return i.value; });
    var areas = Array.prototype.map.call(f.querySelectorAll('input[name="areas"]:checked'), function (i) { return i.value; });
    if (!services.length) return status(f, "Choose at least one service you offer.");
    if (!areas.length) return status(f, "Choose at least one neighborhood you work in.");
    busy(f, true, "Creating…");
    NP.api("POST", "/api/auth/signup", {
      as: "provider", name: f.name.value, business_name: f.business_name.value, email: f.email.value, phone: f.phone.value,
      password: f.password.value, services: services, areas: areas, notes: f.notes.value,
    }).then(function () { location.href = "/vendor/?welcome=1"; }, function (err) { status(f, err.message); busy(f, false); });
  });

  // --- forgot password ---
  $('form[data-form="forgot"]').addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    if (missing(f)) return;
    busy(f, true, "Sending…");
    NP.api("POST", "/api/auth/forgot", { email: f.email.value }).then(function () {
      status(f, "If there's an account for that email, we've sent a link to reset your password. Check your inbox (and spam folder).", true);
    }, function (err) { status(f, err.message); }).then(function () { busy(f, false); });
  });

  // Already signed in? Go straight to the right place.
  NP.api("GET", "/api/auth/me").then(function (res) {
    if (res.user) location.replace(destination(res.user.role));
  }, function () {});

  render();
})();
