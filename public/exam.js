'use strict';
// ExamDesk student client. The server is the authority for time, answers and scoring;
// this file only renders, autosaves and reports integrity events.
(() => {
  const slug = location.pathname.split('/').filter(Boolean)[1] || '';
  const TOK = `ed_tok_${slug}`, PEND = `ed_pend_${slug}`;
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: in-memory only */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const fmtTime = (d) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const math = (el) => { try { window.renderMathInElement && renderMathInElement(el, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }, { left: '$$', right: '$$', display: true }], throwOnError: false }); } catch { /* leave raw */ } };

  let meta = null;      // public exam info
  let S = null;         // attempt state from server
  let calc = null, natDraft = '';
  let cur = 0, offset = 0, running = false, pending = {}, inflight = false, backoff = 0, offlineSince = null, warnings = 0;
  const timers = [];

  async function api(path, body, token = store.get(TOK)) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.code = data.code; throw e; }
    return data;
  }

  function modal(html, cls = '') {
    $('#modalBox').className = `box ${cls}`;
    $('#modalBox').innerHTML = html;
    $('#modal').classList.remove('hidden');
    const b = $('#modalBox button'); if (b) b.focus();
  }
  const closeModal = () => $('#modal').classList.add('hidden');

  function header() {
    $('#hdrDept').textContent = meta.department;
    $('#subbar').innerHTML = `<span><b>${esc(meta.title)}</b></span>${meta.session ? `<span>${esc(meta.session)}</span>` : ''}${meta.academicYear ? `<span>Academic Year ${esc(meta.academicYear)}</span>` : ''}`;
    document.title = `${meta.title} – RMGEC ExamDesk`;
  }

  // ---------------- Registration ----------------
  function registration(error = '', resume = false) {
    document.body.classList.remove('exam-on');
    const neg = meta.negative > 0 ? `${meta.negative} mark(s) deducted for each wrong answer` : 'No negative marking';
    app.innerHTML = `
    <div class="wrap"><div class="reg">
      <section class="card">
        <h2>Candidate Registration</h2>
        ${!meta.open && !resume ? `<div class="err">${esc(meta.reason || 'This examination is not open.')}</div>` : ''}
        ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
        ${resume ? '<div class="note">An examination session was found on this device. Enter your details again to continue where you left off.</div>' : ''}
        <form id="regForm" novalidate>
          <label class="f" for="name">Full name of the student *</label>
          <input type="text" id="name" autocomplete="name" required maxlength="100" placeholder="As in university records">
          <label class="f" for="roll">University roll number *</label>
          <input type="text" id="roll" autocomplete="off" required maxlength="30" placeholder="e.g. 12500121045" style="text-transform:uppercase">
          <label class="f" for="code">Examination code *</label>
          <input type="text" id="code" autocomplete="off" required maxlength="12" placeholder="Given by your teacher" style="text-transform:uppercase;letter-spacing:2px">
          <label class="row" style="margin:14px 0 4px;align-items:flex-start;gap:10px;font-size:14px;flex-wrap:nowrap"><input type="checkbox" id="agree" style="margin-top:3px;width:18px;height:18px">
            <span>I have read the instructions. I will not switch tabs, leave full screen, or use unfair means. I understand that such activity is recorded.</span></label>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="startBtn" type="submit" style="min-width:200px">${resume ? 'Resume Examination' : 'Start Examination'}</button></div>
          <p class="muted">No login account is needed. Use one device only; opening the exam elsewhere is blocked.</p>
        </form>
      </section>
      <section class="card">
        <h2>Instructions</h2>
        <div class="facts">
          <div>Duration<b>${meta.durationMin} min</b></div><div>Questions<b>${meta.questions}</b></div>
          <div>Marks per question<b>${meta.marksPerQ}</b></div><div>Negative marking<b>${meta.negative > 0 ? '−' + meta.negative : 'None'}</b></div>
        </div>
        ${meta.startAt || meta.endAt ? `<p class="muted">Window: ${meta.startAt ? fmtTime(meta.startAt) : 'now'} to ${meta.endAt ? fmtTime(meta.endAt) : 'open'}</p>` : ''}
        <ol>
          <li>Each question has four options (A–D) with exactly one correct answer. ${esc(neg)}.</li>
          <li>Your answer is saved automatically as soon as you select an option.</li>
          <li>Use <b>Save &amp; Next</b>, <b>Previous</b>, <b>Mark for Review</b> and <b>Clear Response</b>, or jump with the question palette.</li>
          <li>Questions answered and marked for review are evaluated.</li>
          <li><b>Numerical Answer Type (NAT)</b> questions have no options: enter the number with the on-screen keypad (up to two decimal places; negative values allowed). There is no negative marking for NAT questions.</li>
          <li>A <b>scientific calculator</b> is available from the top bar during the examination. Click a diagram to enlarge it.</li>
          <li>The examination is submitted automatically when the timer reaches zero.</li>
          <li>The examination runs in full screen. Switching tabs or apps, leaving full screen, copying and right-clicking are recorded and reported to the faculty.</li>
          <li>If your internet drops, keep working: answers are kept on this device and sent when the connection returns.</li>
          <li>After submission the examination is locked and cannot be attempted again.</li>
        </ol>
        ${meta.instructions ? `<div class="note" style="white-space:pre-wrap">${esc(meta.instructions)}</div>` : ''}
        <div class="row" style="gap:10px;font-size:12px;margin-top:8px">
          <span class="row" style="gap:4px"><i class="lg"></i>Not visited</span><span class="row" style="gap:4px"><i class="lg na"></i>Not answered</span>
          <span class="row" style="gap:4px"><i class="lg ans"></i>Answered</span><span class="row" style="gap:4px"><i class="lg mk"></i>Marked</span>
          <span class="row" style="gap:4px"><i class="lg amk"></i>Answered &amp; marked</span>
        </div>
      </section>
    </div></div>`;
    $('#regForm').addEventListener('submit', onStart);
    $('#name').focus();
  }

  async function onStart(ev) {
    ev.preventDefault();
    const name = $('#name').value.trim(), roll = $('#roll').value.trim(), code = $('#code').value.trim();
    if (!name || !roll || !code) return registration('Full name, roll number and examination code are all required.'), refill(name, roll, code);
    if (!$('#agree').checked) return registration('Please confirm that you have read the instructions.'), refill(name, roll, code);
    const btn = $('#startBtn'); btn.disabled = true; btn.textContent = 'Please wait…';
    enterFullscreen(); // must run inside the click gesture
    try {
      const r = await api(`/api/public/exam/${encodeURIComponent(slug)}/start`, { name, roll, code, token: store.get(TOK) || undefined }, null);
      store.set(TOK, r.token);
      await loadAttempt();
    } catch (e) {
      exitFullscreen();
      registration(e.message);
      refill(name, roll, code);
    }
  }
  function refill(n, r, c) { $('#name').value = n; $('#roll').value = r; $('#code').value = c; }

  // ---------------- Fullscreen & integrity ----------------
  function enterFullscreen() {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) { report('fullscreen_denied', 'not supported'); return; }
    try { const p = fn.call(el, { navigationUI: 'hide' }); if (p && p.catch) p.catch(() => report('fullscreen_denied', 'refused')); } catch { report('fullscreen_denied', 'error'); }
  }
  function exitFullscreen() { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); }
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  const lastReport = {};
  function report(type, detail = '') {
    if (!running && type !== 'fullscreen_denied') return;
    const now = Date.now();
    if (lastReport[type] && now - lastReport[type] < 2500) return; // one event per burst
    lastReport[type] = now;
    fetch('/api/attempt/event', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.get(TOK)}` }, body: JSON.stringify({ type, detail }) })
      .then((r) => r.json()).then((d) => { if (d.warnings !== undefined) { warnings = d.warnings; const w = $('#warnCount'); if (w) w.textContent = warnings; } }).catch(() => {});
  }
  function warn(title, text, fsButton) {
    if (!running) return;
    modal(`<h2 id="modalTitle">⚠ ${esc(title)}</h2><p>${esc(text)}</p><p class="muted">This event has been recorded and will be visible to the faculty.</p>
      <div class="row"><button class="btn primary" id="wOk">${fsButton ? 'Return to full screen' : 'Continue examination'}</button></div>`, 'warn');
    $('#wOk').onclick = () => { closeModal(); if (fsButton) enterFullscreen(); };
  }

  let blurTimer = null, hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.hidden) { hiddenAt = Date.now(); report('tab_hidden', 'page hidden'); }
    else warn('You left the examination page', `You switched to another tab or app for ${Math.round((Date.now() - hiddenAt) / 1000)} s. Do not leave the examination.`, !isFull());
  });
  window.addEventListener('blur', () => { if (running) blurTimer = setTimeout(() => { if (!document.hidden) { report('window_blur', 'focus lost'); warn('Examination window lost focus', 'Another window or app took focus. Keep the examination window active.', !isFull()); } }, 600); });
  window.addEventListener('focus', () => clearTimeout(blurTimer));
  const onFs = () => {
    if (!running) return;
    if (isFull()) report('fullscreen_enter');
    else { report('fullscreen_exit', 'left full screen'); warn('Full screen exited', 'The examination must be taken in full-screen mode.', true); }
  };
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('webkitfullscreenchange', onFs);
  for (const t of ['copy', 'cut', 'paste']) document.addEventListener(t, (e) => { if (running) { e.preventDefault(); report(t); } });
  document.addEventListener('contextmenu', (e) => { if (running) { e.preventDefault(); report('context_menu'); } });
  document.addEventListener('keydown', (e) => {
    if (!running) return;
    const k = e.key.toLowerCase();
    if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(k)) || ((e.ctrlKey || e.metaKey) && k === 'u')) { e.preventDefault(); report('devtools_key', e.key); }
    else if ((e.ctrlKey || e.metaKey) && ['p', 's'].includes(k)) { e.preventDefault(); report('print_key', e.key); }
    else if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v', 'a'].includes(k)) e.preventDefault();
  });
  window.addEventListener('beforeunload', (e) => { if (running) { savePending(); e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('online', () => { if (offlineSince) { const s = Math.round((Date.now() - offlineSince) / 1000); offlineSince = null; report('offline', `offline for ${s}s`); } backoff = 0; flush(); });
  window.addEventListener('offline', () => { offlineSince = offlineSince || Date.now(); syncStatus(); });

  // ---------------- Attempt ----------------
  async function loadAttempt() {
    let d;
    try { d = await api('/api/attempt'); } catch (e) {
      if (e.status === 401) { store.del(TOK); return registration(e.message); }
      throw e;
    }
    if (d.submitted) return showReceipt(d.receipt);
    S = d;
    offset = new Date(d.serverNow).getTime() - Date.now();
    // Answers saved locally but not yet acknowledged by the server win over the server copy.
    try { pending = JSON.parse(store.get(PEND) || '{}'); } catch { pending = {}; }
    for (const [qid, it] of Object.entries(pending)) S.answers[qid] = { c: it.c, m: it.m, v: true };
    const firstUnseen = S.questions.findIndex((q) => !S.answers[q.id]);
    cur = firstUnseen > 0 ? firstUnseen : 0;
    startExam();
    flush();
  }

  function startExam() {
    running = true;
    document.body.classList.add('exam-on');
    $('#hdrRight').innerHTML = `<div class="row" style="gap:12px;justify-content:flex-end"><button type="button" class="btn small calc-btn" id="calcBtn" aria-expanded="false" aria-label="Calculator">🖩<span class="calc-lbl"> Calculator</span></button>
      <div><div>${esc(S.student.name)}</div><div>${esc(S.student.roll)}</div></div></div>`;
    calc = window.Calc.mount($('#calcBtn'));
    app.innerHTML = `
    <div class="exam">
      <section class="qpane">
        <div class="qhead"><span class="qno" id="qno"></span><span class="marks" id="qmarks"></span><span class="spacer"></span>
          <button class="btn small palette-toggle" id="palBtn" type="button">☰ Questions</button></div>
        <div class="qbody" id="qbody" aria-live="polite"></div>
        <div class="qfoot">
          <button class="btn mark" id="bMark" type="button">Mark for Review &amp; Next</button>
          <button class="btn" id="bClear" type="button">Clear Response</button>
          <span class="spacer"></span>
          <button class="btn" id="bPrev" type="button">◀ Previous</button>
          <button class="btn ok" id="bNext" type="button">Save &amp; Next ▶</button>
        </div>
      </section>
      <aside class="side" id="side">
        <div class="who"><div class="row"><div><b>Time left</b></div><span class="spacer"></span><span class="timer" id="timer" role="timer" aria-live="off">--:--</span></div>
          <div class="muted" style="margin-top:6px">Warnings recorded: <b id="warnCount">${warnings}</b></div>
          <button class="btn small palette-toggle" id="palClose" type="button" style="margin-top:6px">Close ✕</button></div>
        <div class="legend" id="legend"></div>
        <div class="palette" id="palette" role="navigation" aria-label="Question palette"></div>
        <div class="sync" id="sync">All answers saved</div>
        <div class="actions"><button class="btn primary" id="bSubmit" type="button" style="width:100%">Submit Examination</button></div>
      </aside>
    </div>`;
    $('#bNext').onclick = () => { setMark(false); go(cur + 1); };
    $('#bPrev').onclick = () => go(cur - 1);
    $('#bMark').onclick = () => { setMark(true); go(cur + 1); };
    $('#bClear').onclick = () => { const q = S.questions[cur]; save(q.id, null, ans(q).m); renderQ(); };
    $('#bSubmit').onclick = confirmSubmit;
    $('#palBtn').onclick = () => $('#side').classList.add('open');
    $('#palClose').onclick = () => $('#side').classList.remove('open');
    renderQ();
    timers.push(setInterval(tick, 250), setInterval(heartbeat, 20000));
    tick();
  }

  const ans = (q) => S.answers[q.id] || { c: null, m: false, v: false };
  function state(q) {
    const a = S.answers[q.id];
    if (!a || !a.v) return '';
    const answered = a.c !== null && a.c !== undefined;
    return a.m ? (answered ? 'amk' : 'mk') : answered ? 'ans' : 'na';
  }

  function go(i) {
    if (i < 0 || i >= S.questions.length) { if (i >= S.questions.length) renderQ(); return; }
    cur = i; renderQ();
    $('#side').classList.remove('open');
  }

  function renderQ() {
    const q = S.questions[cur];
    const a = ans(q);
    if (!a.v) save(q.id, a.c, a.m);
    $('#qno').textContent = `Question ${cur + 1} of ${S.questions.length}`;
    $('#qmarks').textContent = `Marks: +${q.marks}${q.negative ? `  |  Negative: −${q.negative}` : ''}`;
    const body = $('#qbody');
    if (q.type === 'nat') {
      natDraft = a.c === null || a.c === undefined ? '' : String(a.c);
      body.innerHTML = `<div class="stem">${q.stem}</div>
        <div class="nat"><label class="f" for="natIn">Your answer (numerical, up to 2 decimal places)</label>
          <input id="natIn" class="nat-in" type="text" readonly inputmode="none" autocomplete="off" value="${esc(natDraft)}" aria-describedby="natHint">
          <div class="nat-hint" id="natHint" aria-live="polite"></div>
          <div class="keypad" role="group" aria-label="Number pad">${['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', '-'].map((k) => `<button type="button" data-k="${k}">${k === '-' ? '−' : k}</button>`).join('')}
            <button type="button" data-k="back" class="wide">⌫ Backspace</button><button type="button" data-k="clear" class="wide">Clear</button></div></div>`;
      body.querySelector('.keypad').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) natKey(q, b.dataset.k); });
    } else {
      body.innerHTML = `<div class="stem">${q.stem}</div>` + q.options.map((o, i) => `
        <label class="opt${a.c === i ? ' sel' : ''}"><input type="radio" name="opt" value="${i}"${a.c === i ? ' checked' : ''}>
          <span class="letter">(${'ABCD'[i]})</span><span>${o}</span></label>`).join('');
      body.querySelectorAll('input[name=opt]').forEach((r) => r.addEventListener('change', () => { save(q.id, Number(r.value), ans(q).m); renderQ(); }));
    }
    body.querySelectorAll('img').forEach((img) => { img.classList.add('zoomable'); img.title = 'Click to enlarge'; img.addEventListener('click', () => openZoom(img.src)); });
    math(body);
    body.scrollTop = 0;
    $('#bPrev').disabled = cur === 0;
    $('#bNext').textContent = cur === S.questions.length - 1 ? 'Save' : 'Save & Next ▶';
    renderPalette();
  }

  // GATE NAT: on-screen keypad only. Saved as soon as the text is a complete number; partial input ("-", "5.") is not saved.
  const NAT_RE = /^-?\d{1,7}(\.\d{1,2})?$/;
  function natKey(q, k) {
    let v = natDraft;
    if (k === 'back') v = v.slice(0, -1);
    else if (k === 'clear') v = '';
    else if (k === '-') v = v.startsWith('-') ? v.slice(1) : '-' + v;
    else if (k === '.') { if (!v.includes('.')) v = (v === '' || v === '-' ? v + '0' : v) + '.'; }
    else if (/^\d$/.test(k)) {
      const [intPart, dec] = v.replace('-', '').split('.');
      if (dec !== undefined && dec.length >= 2) return natHint('Only two decimal places are allowed.');
      if (dec === undefined && intPart.length >= 7) return natHint('Maximum 7 digits before the decimal point.');
      v = intPart === '0' && dec === undefined ? v.replace(/0$/, k) : v + k; // no leading zeros like "007"
    }
    natDraft = v;
    $('#natIn').value = v;
    if (v === '') { save(q.id, null, ans(q).m); natHint(''); }
    else if (NAT_RE.test(v)) { save(q.id, v, ans(q).m); natHint(''); }
    else return natHint('Incomplete number: not saved yet.');
    renderPalette();
  }
  const natHint = (t) => { const h = $('#natHint'); if (h) h.textContent = t; };

  let zoomScale = 1;
  function openZoom(src) {
    const img = $('#zoomImg');
    img.src = src;
    zoomScale = 1;
    img.onload = () => setZoom('fit');
    $('#zoom').classList.remove('hidden');
    $('#zoom [data-z=x]').focus();
  }
  function setZoom(z) {
    const img = $('#zoomImg'), area = $('#zoomArea');
    if (z === 'fit') zoomScale = Math.min(1, area.clientWidth / img.naturalWidth, area.clientHeight / img.naturalHeight) || 1;
    else zoomScale = Math.min(8, Math.max(0.2, zoomScale * (z === '+' ? 1.25 : 0.8)));
    img.style.width = `${Math.round(img.naturalWidth * zoomScale)}px`;
    $('#zoomPct').textContent = `${Math.round(zoomScale * 100)}%`;
  }
  $('#zoom').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-z]');
    if (b) { if (b.dataset.z === 'x') $('#zoom').classList.add('hidden'); else setZoom(b.dataset.z); }
  });
  $('#zoomArea').addEventListener('wheel', (ev) => { ev.preventDefault(); setZoom(ev.deltaY < 0 ? '+' : '-'); }, { passive: false });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') $('#zoom').classList.add('hidden'); });

  function renderPalette() {
    const counts = { '': 0, na: 0, ans: 0, mk: 0, amk: 0 };
    $('#palette').innerHTML = S.questions.map((q, i) => {
      const s = state(q); counts[s]++;
      const label = { '': 'not visited', na: 'not answered', ans: 'answered', mk: 'marked for review', amk: 'answered and marked for review' }[s];
      return `<button type="button" class="pq ${s}${i === cur ? ' cur' : ''}" data-i="${i}" aria-label="Question ${i + 1}, ${label}">${i + 1}</button>`;
    }).join('');
    $('#palette').querySelectorAll('.pq').forEach((b) => { b.onclick = () => go(Number(b.dataset.i)); });
    $('#legend').innerHTML = `<span><i class="lg ans">${counts.ans}</i>Answered</span><span><i class="lg na">${counts.na}</i>Not answered</span>
      <span><i class="lg">${counts['']}</i>Not visited</span><span><i class="lg mk">${counts.mk}</i>Marked for review</span>
      <span style="grid-column:span 2"><i class="lg amk">${counts.amk}</i>Answered &amp; marked (evaluated)</span>`;
    return counts;
  }

  function setMark(m) { const q = S.questions[cur]; const a = ans(q); if (a.m !== m || !a.v) save(q.id, a.c, m); }

  // ---------------- Autosave ----------------
  function save(qid, c, m) {
    S.answers[qid] = { c, m: !!m, v: true };
    pending[qid] = { qid, c, m: !!m };
    savePending();
    flush();
  }
  const savePending = () => store.set(PEND, JSON.stringify(pending));

  async function flush() {
    if (inflight || !running) return syncStatus();
    const items = Object.values(pending);
    if (!items.length) return syncStatus();
    inflight = true; syncStatus();
    const sent = JSON.stringify(items);
    try {
      await api('/api/attempt/answers', { items });
      for (const it of items) if (JSON.stringify(pending[it.qid]) === JSON.stringify(it)) delete pending[it.qid];
      savePending(); backoff = 0; offlineSince = null;
    } catch (e) {
      if (e.code === 'SUBMITTED') { inflight = false; return finished(); }
      if (e.code === 'SESSION_REPLACED') { inflight = false; return replaced(e.message); }
      if (e.status && e.status < 500 && e.status !== 429) { console.warn('save rejected', e.message, sent); pending = {}; savePending(); }
      else { offlineSince = offlineSince || Date.now(); backoff = Math.min((backoff || 1000) * 2, 15000); setTimeout(flush, backoff); }
    }
    inflight = false;
    if (Object.keys(pending).length && !backoff) flush();
    syncStatus();
  }

  function syncStatus() {
    const el = $('#sync'); if (!el) return;
    const n = Object.keys(pending).length;
    const off = !navigator.onLine || offlineSince;
    el.classList.toggle('off', !!(off && n));
    el.textContent = n ? (off ? `Offline: ${n} answer(s) kept on this device and will be sent automatically` : 'Saving…') : 'All answers saved ✓';
  }

  // ---------------- Timer ----------------
  let autoSubmitting = false;
  function tick() {
    if (!running) return;
    const left = new Date(S.deadline).getTime() - (Date.now() + offset);
    const s = Math.max(0, Math.floor(left / 1000));
    const t = $('#timer');
    t.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    t.classList.toggle('low', s <= 300);
    if (left <= 0 && !autoSubmitting) { autoSubmitting = true; submit(true); }
  }
  async function heartbeat() {
    try {
      const h = await api('/api/attempt/heartbeat', {});
      offset = new Date(h.serverNow).getTime() - Date.now();
      if (h.status === 'submitted') finished();
    } catch (e) { if (e.code === 'SESSION_REPLACED') replaced(e.message); }
  }

  // ---------------- Submit ----------------
  function confirmSubmit() {
    const c = renderPalette();
    modal(`<h2 id="modalTitle">Submit examination?</h2>
      <table class="t"><tr><th>Answered</th><td>${c.ans}</td></tr><tr><th>Answered &amp; marked for review (evaluated)</th><td>${c.amk}</td></tr>
      <tr><th>Marked for review, not answered</th><td>${c.mk}</td></tr><tr><th>Not answered</th><td>${c.na}</td></tr><tr><th>Not visited</th><td>${c['']}</td></tr></table>
      <p><b>After submission you cannot change any answer or attempt this examination again.</b></p>
      <div class="row"><button class="btn" id="sNo" type="button">Go back</button><span class="spacer"></span><button class="btn primary" id="sYes" type="button">Yes, submit</button></div>`);
    $('#sNo').onclick = closeModal;
    $('#sYes').onclick = () => { closeModal(); submit(false); };
  }

  async function submit(auto) {
    modal(`<h2 id="modalTitle">${auto ? 'Time is over' : 'Submitting…'}</h2><p id="subMsg">Sending your answers to the server. Do not close this page.</p>`);
    for (let i = 0; ; i++) {
      try {
        if (Object.keys(pending).length) { await api('/api/attempt/answers', { items: Object.values(pending) }); pending = {}; savePending(); }
      } catch (e) { if (e.code !== 'SUBMITTED' && (!e.status || e.status >= 500)) { await retryWait(i); continue; } }
      try { const r = await api('/api/attempt/submit', {}); return showReceipt(r.receipt); } catch (e) {
        if (e.code === 'SESSION_REPLACED') return replaced(e.message);
        await retryWait(i);
      }
    }
  }
  async function retryWait(i) {
    const m = $('#subMsg');
    if (m) m.textContent = 'No connection to the server. Retrying automatically… Your answers are safe on this device; the server will also close your examination at the deadline.';
    await new Promise((r) => setTimeout(r, Math.min(2000 * (i + 1), 10000)));
  }

  async function finished() {
    try { const d = await api('/api/attempt'); if (d.submitted) return showReceipt(d.receipt); } catch { /* fall through */ }
  }

  function stop() {
    running = false;
    if (calc) calc.close();
    $('#zoom').classList.add('hidden');
    timers.splice(0).forEach(clearInterval);
    document.body.classList.remove('exam-on');
    exitFullscreen();
  }

  function replaced(msg) {
    stop();
    modal(`<h2 id="modalTitle">Session ended on this device</h2><p>${esc(msg)}</p><div class="row"><button class="btn primary" id="rOk" type="button">OK</button></div>`, 'warn');
    $('#rOk').onclick = () => { closeModal(); store.del(TOK); registration('', false); };
  }

  function showReceipt(r) {
    stop();
    closeModal();
    store.del(PEND);
    $('#hdrRight').innerHTML = '';
    const mode = { manual: 'Submitted by candidate', timeout: 'Auto-submitted when time expired', closed: 'Submitted when the examination was closed' }[r.submit_mode] || 'Submitted';
    app.innerHTML = `<div class="wrap"><div class="card receipt">
      <div class="tick" aria-hidden="true">✓</div>
      <h2 style="text-align:center">Examination submitted successfully</h2>
      <p class="muted" style="text-align:center">Your responses are locked. Keep this receipt for your records.</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td>Receipt number</td><td><b>${esc(r.receipt_no)}</b></td></tr>
        <tr><td>Student name</td><td>${esc(r.student_name)}</td></tr>
        <tr><td>Roll number</td><td>${esc(r.roll_no)}</td></tr>
        <tr><td>Examination</td><td>${esc(r.title)}</td></tr>
        <tr><td>Session / Year</td><td>${esc(r.session_label)} ${r.academic_year ? '· ' + esc(r.academic_year) : ''}</td></tr>
        <tr><td>Started</td><td>${fmtTime(r.started_at)}</td></tr>
        <tr><td>Submitted</td><td>${fmtTime(r.submitted_at)} (${esc(mode)})</td></tr>
        <tr><td>Questions attempted</td><td>${r.attempted}</td></tr>
        <tr><td>Not answered</td><td>${r.unanswered}</td></tr>
      </table>
      <div class="row no-print" style="margin-top:16px;justify-content:center"><button class="btn" id="pr" type="button">Print receipt</button></div>
    </div></div>`;
    $('#pr').onclick = () => window.print();
  }

  // ---------------- Boot ----------------
  (async () => {
    try {
      meta = await api(`/api/public/exam/${encodeURIComponent(slug)}`, undefined, null);
    } catch (e) {
      app.innerHTML = `<div class="wrap"><div class="card"><h2>Examination unavailable</h2><div class="err">${esc(e.message)}</div></div></div>`;
      return;
    }
    header();
    if (store.get(TOK)) {
      try {
        const d = await api('/api/attempt');
        if (d.submitted) return showReceipt(d.receipt);
        return registration('', true); // a click is needed to re-enter full screen
      } catch { store.del(TOK); }
    }
    registration();
  })();
})();
