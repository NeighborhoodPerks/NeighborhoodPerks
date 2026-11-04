(function () {
  var NP = window.NP;
  var form = document.getElementById("invite");
  if (!form || !NP) return;
  var t = new URLSearchParams(location.search).get("t") || "";
  var status = form.querySelector(".form-status");
  var who = form.querySelector('[data-bind="who"]');
  var err = function (m) { status.className = "form-status err"; status.textContent = m; };

  NP.api("GET", "/api/auth/invite?t=" + encodeURIComponent(t)).then(function (res) {
    who.textContent = "For " + res.email + ". You'll use this email and password to sign in.";
    form.querySelector("[data-fields]").hidden = false;
    form.querySelector("#i-pass").focus();
  }, function (e) { who.textContent = ""; err(e.message); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var a = form.querySelector("#i-pass").value;
    var b = form.querySelector("#i-pass2").value;
    if (a.length < 10) return err("Use at least 10 characters.");
    if (a !== b) return err("Those two passwords don't match.");
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    NP.api("POST", "/api/auth/invite", { t: t, password: a }).then(function () {
      location.href = "/vendor/";
    }, function (e2) { err(e2.message); btn.disabled = false; });
  });
})();
