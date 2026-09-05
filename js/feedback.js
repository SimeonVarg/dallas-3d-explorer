/**
 * js/feedback.js — the recommendations box actually delivers (QUEUE I4, part 2).
 *
 * THE STATE THIS FILE FIXES. The box itself shipped in PR #128 (js/graphics.js
 * builds #fb-button / #fb-panel; style.css already dressed it and hides it in
 * every capture mode). But its Send button was disabled on purpose until a
 * form-service endpoint (FEEDBACK_ENDPOINT in js/graphics.js) was configured —
 * and none ever was. Honest, but the practical result is a feedback channel
 * that has never carried a message.
 *
 * WHAT THIS MODULE DOES. When NO endpoint is configured, it takes over the
 * Send button with the one zero-backend path that exists: a prefilled
 * `mailto:` handed to the visitor's own mail app, plus a "Copy" fallback that
 * puts the address and the message on the clipboard for anyone whose machine
 * has no mail client wired up. Nothing is created, nothing can pause or
 * expire, no third-party service, no key.
 *
 * THE TRADE, STATED PLAINLY (js/graphics.js's header argues the other side):
 *   - `mailto:` does not send; it opens the visitor's mail app pre-filled and
 *     they press send there. On a machine with no mail client it does nothing
 *     visible — which is exactly what the Copy button is for, and why the
 *     status line never claims anything was "sent".
 *   - The address is in this file, split into two constants and assembled at
 *     run time, so it never appears in any served source as the user@domain
 *     pattern address harvesters regex for. A harvester that executes JS gets
 *     it anyway; that is the accepted cost of a channel that works today, and
 *     it is the address Simeon himself asked messages to go to.
 *
 * PRECEDENCE. If FEEDBACK_ENDPOINT in js/graphics.js is ever filled in,
 * window.__feedback.on() goes true and this module steps aside untouched — the
 * form-service POST path (which keeps the address out of the page entirely)
 * simply takes over. This file needs no edit for that upgrade.
 *
 * Self-booting off the DOM graphics.js builds; app.js never calls it.
 * KEEP THE <script> TAG IN BOTH index.html AND _harness.html.
 */
(function () {
  'use strict';

  // ── Every value here is the taste/config surface (CLAUDE.md rule 11) ──
  const FB_MAIL = {
    // Assembled at click time as USER + "@" + DOMAIN — never stored joined.
    USER: 'simeonvarg',
    DOMAIN: 'outlook.com',
    SUBJECT: 'Austin 3D Explorer — a recommendation',

    // Copy. The status line must never say "sent" — this path hands off.
    READY: 'Send opens your email app with this written and addressed — press send there. Nothing sends from this page.',
    HANDED: 'Handed to your email app — press send there to deliver it. No app opened? Use Copy.',
    COPY: 'Copy',
    COPY_TITLE: 'Copy the message and the address, to paste into any email',
    COPIED: 'Copied with the address on top — paste it into any email.',
    COPY_FAIL: 'Could not reach the clipboard. Select the text and copy it yourself.',
    EMPTY: 'Write something first.',
    SEND_TITLE: 'Open your email app with this message addressed',

    // Body furniture.
    NAME_PREFIX: '— ',
    REPLY_PREFIX: 'Reply to: ',
    VIEW_PREFIX: 'Looking at: ',

    // Boot: graphics.js builds the panel when app.js hands it the map, which
    // on a cold cache has been measured anywhere from 11 s to 65 s in. Polling
    // a getElementById is nanoseconds, so the window is generous.
    BOOT_POLL_MS: 250,
    BOOT_GIVE_UP_MS: 120000,
  };

  const addr = () => FB_MAIL.USER + '@' + FB_MAIL.DOMAIN;

  /** Where the camera is, in words — mirrors graphics.js's fbView(), which is
   *  not exported. Reconstructed from the same public globals. */
  function viewLine() {
    try {
      const m = window.__map;
      if (!m) return '';
      const c = m.getCenter();
      const p = window.__todCurrentP;
      const g = window.GFX;
      return c.lng.toFixed(5) + ', ' + c.lat.toFixed(5) +
        ' · zoom ' + m.getZoom().toFixed(2) +
        ' · pitch ' + m.getPitch().toFixed(0) + '°' +
        ' · bearing ' + m.getBearing().toFixed(0) + '°' +
        (p != null ? ' · time of day ' + (+p).toFixed(2) : '') +
        ' · ' + window.innerWidth + '×' + window.innerHeight +
        (g && g.preset ? ' · preset ' + g.preset : '');
    } catch (e) { return ''; }
  }

  function setStatus(text, kind) {
    const s = document.querySelector('#fb-panel .fb-status');
    if (!s) return;
    s.textContent = text || '';
    s.className = 'fb-status' + (kind ? ' ' + kind : '');
  }

  /** The message as it should arrive, one string, RFC 6068 line breaks. */
  function composeBody() {
    const q = (id) => document.getElementById(id);
    const msg = q('fb-text') ? q('fb-text').value.trim() : '';
    if (!msg) return null;
    const lines = [msg];
    const nm = q('fb-name') && q('fb-name').value.trim();
    const em = q('fb-email') && q('fb-email').value.trim();
    if (nm) lines.push('', FB_MAIL.NAME_PREFIX + nm);
    if (em) lines.push(FB_MAIL.REPLY_PREFIX + em);
    if (q('fb-view') && q('fb-view').checked) {
      const v = viewLine();
      if (v) lines.push('', FB_MAIL.VIEW_PREFIX + v);
    }
    return lines.join('\r\n');
  }

  function doSend() {
    const body = composeBody();
    const text = document.getElementById('fb-text');
    if (body == null) { setStatus(FB_MAIL.EMPTY, 'bad'); if (text) text.focus(); return; }
    const url = 'mailto:' + addr() +
      '?subject=' + encodeURIComponent(FB_MAIL.SUBJECT) +
      '&body=' + encodeURIComponent(body);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // The text is deliberately NOT cleared: the handoff can fail silently on a
    // machine with no mail client, and retyping a paragraph is how a report
    // gets lost for good. Copy is the recovery path.
    setStatus(FB_MAIL.HANDED, 'good');
  }

  function doCopy() {
    const body = composeBody();
    const text = document.getElementById('fb-text');
    if (body == null) { setStatus(FB_MAIL.EMPTY, 'bad'); if (text) text.focus(); return; }
    const blob = 'To: ' + addr() + '\nSubject: ' + FB_MAIL.SUBJECT + '\n\n' +
      body.replace(/\r\n/g, '\n');
    const done = () => setStatus(FB_MAIL.COPIED, 'good');
    const fail = () => setStatus(FB_MAIL.COPY_FAIL, 'bad');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(blob).then(done, () => legacyCopy(blob) ? done() : fail());
    } else {
      legacyCopy(blob) ? done() : fail();
    }
  }

  /** execCommand fallback for non-secure contexts (plain-http LAN serves). */
  function legacyCopy(s) {
    try {
      const t = document.createElement('textarea');
      t.value = s;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      return ok;
    } catch (e) { return false; }
  }

  function wire(send) {
    send.disabled = false;
    send.title = FB_MAIL.SEND_TITLE;
    setStatus(FB_MAIL.READY, '');

    // graphics.js's own click handler stays bound but returns on line one
    // while no endpoint is configured (fbOn() is false), so the two cannot
    // both act. Same for its Ctrl+Enter path.
    send.addEventListener('click', doSend);
    const panel = document.getElementById('fb-panel');
    if (panel) panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSend();
    });

    const foot = document.getElementById('fb-foot');
    if (foot) {
      const c = document.createElement('button');
      c.id = 'fb-copy';
      c.textContent = FB_MAIL.COPY;
      c.title = FB_MAIL.COPY_TITLE;
      c.addEventListener('click', doCopy);
      foot.classList.add('has-copy');   // style.css lays the two buttons out
      foot.appendChild(c);
    }

    // Debug/test hook, same convention as __gfxToast / __feedback.
    window.__feedbackMail = { address: addr, compose: composeBody, view: viewLine };
  }

  const t0 = Date.now();
  (function arm() {
    const send = document.getElementById('fb-send');
    if (!send) {
      if (Date.now() - t0 < FB_MAIL.BOOT_GIVE_UP_MS) setTimeout(arm, FB_MAIL.BOOT_POLL_MS);
      return;
    }
    // A configured form service outranks the mail-app handoff: it delivers
    // without a mail client and keeps the address out of the page entirely.
    if (window.__feedback && typeof window.__feedback.on === 'function' && window.__feedback.on()) return;
    wire(send);
  })();
})();
