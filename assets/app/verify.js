(function () {
  var NP = window.NP;
  var root = document.getElementById("verify");
  if (!root || !NP) return;
  var t = new URLSearchParams(location.search).get("t") || "";
  var title = root.querySelector('[data-bind="title"]');
  var msg = root.querySelector('[data-bind="msg"]');
  NP.api("POST", "/api/auth/verify", { t: t }).then(function (res) {
    title.textContent = "Email confirmed. Thank you!";
    msg.textContent = res.linked
      ? res.linked + " earlier booking" + (res.linked === 1 ? " is" : "s are") + " now in your account."
      : "Any bookings you make with this email will show up in your account.";
  }, function (err) {
    title.textContent = "That link didn't work";
    msg.textContent = err.message + " If you're signed in, you can send a new one from your account page.";
  });
})();
