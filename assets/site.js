(function () {
  document.documentElement.classList.remove("no-js");

  // Header: shadow line once scrolled, mobile menu toggle
  var header = document.querySelector(".site-header");
  var toggle = document.querySelector(".menu-toggle");
  if (header) {
    var onScroll = function () { header.classList.toggle("scrolled", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }
  if (header && toggle) {
    toggle.addEventListener("click", function () {
      var open = header.classList.toggle("menu-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    header.querySelectorAll(".nav a").forEach(function (a) {
      a.addEventListener("click", function () {
        header.classList.remove("menu-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Preselect a service from ?service= (links from service cards)
  var params = new URLSearchParams(window.location.search);
  var wanted = params.get("service");
  if (wanted) {
    var sel = document.querySelector('select[name="service"]');
    if (sel) {
      Array.prototype.forEach.call(sel.options, function (o) {
        if (o.value === wanted) sel.value = wanted;
      });
    }
  }

  // Netlify Forms, submitted in place so the visitor never leaves the page.
  // Without JS the form still posts normally and lands on /thanks.
  document.querySelectorAll("form[data-netlify]").forEach(function (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var status = form.querySelector(".form-status");
      var btn = form.querySelector('button[type="submit"]');
      var label = btn ? btn.innerHTML : "";
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      var body = new URLSearchParams(new FormData(form)).toString();
      fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          if (status) {
            status.className = "form-status ok";
            status.textContent = form.getAttribute("data-success") || "Thanks — we got it and will be in touch shortly.";
          }
          form.reset();
        })
        .catch(function () {
          if (status) {
            status.className = "form-status err";
            status.innerHTML = 'That didn’t go through. Please call or text <a href="tel:+16197363618">(619) 736-3618</a> and we’ll take care of you.';
          }
        })
        .then(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = label; }
        });
    });
  });

  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();
