/* FindCNG Nigeria — "Ask about CNG" chat.
   Self-initializing: wires the #view-chat section, probes /api/chat once
   (the first time the view opens) to learn whether the AI key is set, and
   renders plain answers. No sources are shown anywhere in the chat
   (Saheed, 18 Nov 2026: the links were link spam, and the web search
   sometimes surfaced junk like login pages).
   No chat history is stored anywhere — messages live only in this page's
   memory and disappear on reload. */
(function () {
  "use strict";
  var MAX_LEN = 500;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Plain-text answer -> safe HTML: paragraphs on blank lines, <br> on newlines.
  function answerHtml(text) {
    return String(text).split(/\n\s*\n/).map(function (para) {
      return "<p>" + esc(para).replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  var log, input, sendBtn, countEl, boxEl, setupEl, probed = false, busy = false;

  function scrollLog() {
    if (log) log.scrollTop = log.scrollHeight;
  }

  function addUserBubble(text) {
    var d = document.createElement("div");
    d.className = "chat-msg user";
    d.textContent = text;
    log.appendChild(d);
    scrollLog();
  }

  // Plain answer only — no sources are shown in the chat at all.
  function addAnswerBubble(answer) {
    var d = document.createElement("div");
    d.className = "chat-msg ai";
    d.innerHTML = answerHtml(answer);
    log.appendChild(d);
    scrollLog();
  }

  function addErrorBubble(text) {
    var d = document.createElement("div");
    d.className = "chat-msg ai err";
    d.textContent = text;
    log.appendChild(d);
    scrollLog();
  }

  function addTyping() {
    var d = document.createElement("div");
    d.className = "chat-msg ai typing";
    d.setAttribute("aria-label", "Thinking");
    d.innerHTML = "<span></span><span></span><span></span>";
    log.appendChild(d);
    scrollLog();
    return d;
  }

  function showSetupNote() {
    if (setupEl) setupEl.classList.remove("hidden");
    if (boxEl) boxEl.classList.add("hidden");
  }

  function setBusy(v) {
    busy = v;
    if (sendBtn) sendBtn.disabled = v || !input.value.trim();
    if (input) input.disabled = v;
  }

  function updateCount() {
    var n = input.value.length;
    if (countEl) {
      countEl.textContent = n + "/" + MAX_LEN;
      countEl.classList.toggle("over", n > MAX_LEN);
    }
    if (sendBtn) sendBtn.disabled = busy || !input.value.trim() || n > MAX_LEN;
  }

  function ask(question) {
    if (busy || !question) return;
    addUserBubble(question);
    setBusy(true);
    var typing = addTyping();
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) {
        typing.remove();
        var b = r.body || {};
        if (r.status === 200 && b.configured === false) {
          showSetupNote();
          return;
        }
        if (r.status === 200 && b.ok && b.answer) {
          addAnswerBubble(b.answer);
        } else {
          addErrorBubble(b.error || "Something went wrong — please try again.");
        }
      })
      .catch(function () {
        typing.remove();
        addErrorBubble("Could not reach the server — check your connection and try again.");
      })
      .finally(function () {
        input.value = "";
        setBusy(false);
        updateCount();
        input.focus();
      });
  }

  // One lightweight probe: POST with no question. With no key the API answers
  // { configured: false } before validating; with a key it answers 400
  // ("question is required") — either way we learn the setup state.
  function probe() {
    if (probed) return;
    probed = true;
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (b) {
        if (b && b.configured === false) showSetupNote();
      })
      .catch(function () { /* probe failure: leave the chat enabled; the first ask will tell us */ });
  }

  function init() {
    var view = $("view-chat");
    if (!view) return;
    log = $("chat-log");
    input = $("chat-input");
    sendBtn = $("chat-send");
    countEl = $("chat-count");
    boxEl = $("chat-box");
    setupEl = $("chat-setup");
    if (!log || !input || !sendBtn) return;

    sendBtn.addEventListener("click", function () {
      var q = input.value.trim();
      if (q && q.length <= MAX_LEN) ask(q);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var q = input.value.trim();
        if (q && q.length <= MAX_LEN) ask(q);
      }
    });
    input.addEventListener("input", updateCount);
    updateCount();

    view.querySelectorAll("[data-q]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var q = chip.getAttribute("data-q");
        if (q) ask(q);
      });
    });

    // Probe when the chat view first opens (and at once if it is already open,
    // e.g. a direct ?view=chat link).
    if (view.classList.contains("active")) {
      probe();
    } else if (window.MutationObserver) {
      var obs = new MutationObserver(function () {
        if (view.classList.contains("active")) { probe(); obs.disconnect(); }
      });
      obs.observe(view, { attributes: true, attributeFilter: ["class"] });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
