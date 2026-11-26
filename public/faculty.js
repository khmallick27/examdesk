'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const toLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const fromLocal = (v) => (v ? new Date(v).toISOString() : null);
  const studentLink = (slug) => `${location.origin}/e/${slug}`;
  const math = (el) => { try { renderMathInElement(el, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }, { left: '$$', right: '$$', display: true }], throwOnError: false }); } catch { /* raw */ } };
  let me = null, refreshTimer = null;

  async function api(method, path, body, raw) {
    const opts = { method, headers: { 'X-Requested-With': 'ExamDesk' }, cache: 'no-store' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    if (raw && res.ok) return res;
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/api/auth/login') { me = null; login(data.error); throw Object.assign(new Error(data.error || 'Signed out'), { silent: true }); }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
    return data;
  }
  const fail = (e, where = '#msg') => { if (e.silent) return; const el = $(where); if (el) { el.innerHTML = `<div class="err" role="alert">${esc(e.message)}${e.data && e.data.problems ? '<ul>' + e.data.problems.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul>' : ''}${e.data && e.data.notes ? '<ul>' + e.data.notes.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul>' : ''}</div>`; el.scrollIntoView({ block: 'nearest' }); } else alert(e.message); };
  const flash = (html, where = '#msg') => { const el = $(where); if (el) el.innerHTML = `<div class="note">${html}</div>`; };

  function modal(html) { $('#modalBox').className = 'box'; $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
  const closeModal = () => $('#modal').classList.add('hidden');
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // ---------- auth ----------
  function login(error) {
    clearInterval(refreshTimer);
    $('#nav').classList.add('hidden');
    app.innerHTML = `<div class="wrap" style="max-width:440px"><div class="card">
      <h2>Faculty sign in</h2>${error && error !== 'Please sign in' ? `<div class="err">${esc(error)}</div>` : ''}
      <form id="lf"><label class="f" for="em">Email</label><input type="email" id="em" autocomplete="username" required>
      <label class="f" for="pw">Password</label><input type="password" id="pw" autocomplete="current-password" required>
      <div id="msg"></div><div class="row" style="margin-top:14px"><button class="btn primary" type="submit">Sign in</button></div></form>
      <p class="muted">Authorised faculty only. Accounts are created by the ExamDesk administrator.</p></div></div>`;
    $('#lf').onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api('POST', '/api/auth/login', { email: $('#em').value, password: $('#pw').value }); await boot(); } catch (e) { fail(e); }
    };
    $('#em').focus();
  }
  $('#navOut').onclick = async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); me = null; location.hash = '#/'; login(); };
  $('#navPw').onclick = () => {
    modal(`<h2>Change password</h2><label class="f">Current password</label><input type="password" id="pc"><label class="f">New password (10+ characters)</label><input type="password" id="pn">
      <div id="pmsg"></div><div class="row" style="margin-top:12px"><button class="btn" id="px">Cancel</button><span class="spacer"></span><button class="btn primary" id="ps">Change</button></div>`);
    $('#px').onclick = closeModal;
    $('#ps').onclick = async () => { try { await api('POST', '/api/auth/password', { current: $('#pc').value, next: $('#pn').value }); closeModal(); login('Password changed. Please sign in again.'); } catch (e) { fail(e, '#pmsg'); } };
  };

  // ---------- router ----------
  async function route() {
    clearInterval(refreshTimer);
    if (!me) return;
    const [, view, id] = location.hash.replace(/^#/, '').split('/');
    try {
      if (view === 'exam' && id) return await editor(Number(id));
      if (view === 'results' && id) return await results(Number(id));
      if (view === 'new') return newExam();
      if (view === 'admin' && me.role === 'admin') return await admin();
      return await list();
    } catch (e) { if (!e.silent) app.innerHTML = `<div class="wrap"><div class="err">${esc(e.message)}</div></div>`; }
  }
  window.addEventListener('hashchange', route);

  // ---------- exam list ----------
  async function list() {
    const exams = await api('GET', '/api/exams');
    app.innerHTML = `<div class="wrap">
      <div class="row" style="margin-bottom:12px"><h2 style="margin:0;color:var(--navy)">Examinations</h2><span class="spacer"></span><a class="btn primary" href="#/new">+ New examination</a></div>
      <div class="card"><div class="tablewrap"><table class="t"><thead><tr><th>Title</th><th>Session</th><th>Status</th><th>Code</th><th>Questions</th><th>Submitted / Started</th><th>Window</th>${me.role === 'admin' ? '<th>Owner</th>' : ''}<th></th></tr></thead><tbody>
      ${exams.map((e) => `<tr><td><a href="#/exam/${e.id}"><b>${esc(e.title)}</b></a></td><td>${esc(e.session_label)}<div class="muted">${esc(e.academic_year)}</div></td>
        <td><span class="pill ${e.status}">${e.status}</span></td><td><code>${esc(e.code)}</code></td><td>${e.questions}</td><td>${e.submitted} / ${e.attempts}</td>
        <td class="muted">${e.start_at ? fmt(e.start_at) : 'Any time'}<br>${e.end_at ? 'to ' + fmt(e.end_at) : ''} · ${e.duration_min} min</td>
        ${me.role === 'admin' ? `<td>${esc(e.owner)}</td>` : ''}<td><a class="btn small" href="#/exam/${e.id}">Edit</a> <a class="btn small" href="#/results/${e.id}">Results</a></td></tr>`).join('') ||
        '<tr><td colspan="9" class="muted">No examinations yet. Create one to begin.</td></tr>'}
      </tbody></table></div></div></div>`;
  }

  // ---------- settings form ----------
  function settingsForm(e = {}) {
    return `<div class="grid2">
      <div><label class="f" for="s_title">Examination title *</label><input type="text" id="s_title" maxlength="200" value="${esc(e.title)}" placeholder="e.g. Electrical Machines – Internal Assessment 1"></div>
      <div><label class="f" for="s_session">Examination session</label><input type="text" id="s_session" maxlength="120" value="${esc(e.session_label)}" placeholder="e.g. Odd Semester 2026 · 5th Sem EE"></div>
      <div><label class="f" for="s_year">Academic year</label><input type="text" id="s_year" maxlength="20" value="${esc(e.academic_year)}" placeholder="2026-27"></div>
      <div><label class="f" for="s_dept">Department</label><input type="text" id="s_dept" maxlength="120" value="${esc(e.department || me.department || 'Department of Electrical Engineering')}"></div>
    </div>
    <div class="grid3">
      <div><label class="f" for="s_dur">Duration (minutes) *</label><input type="number" id="s_dur" min="1" max="600" value="${e.duration_min ?? 60}"></div>
      <div><label class="f" for="s_marks">Marks per question</label><input type="number" id="s_marks" min="0.25" step="0.25" value="${e.marks_per_q ?? 1}"></div>
      <div><label class="f" for="s_neg">Negative marks per wrong answer</label><input type="number" id="s_neg" min="0" step="0.01" value="${e.negative_marks ?? 0}"></div>
      <div><label class="f" for="s_start">Opens at (optional)</label><input type="datetime-local" id="s_start" value="${toLocal(e.start_at)}"></div>
      <div><label class="f" for="s_end">Closes at (optional)</label><input type="datetime-local" id="s_end" value="${toLocal(e.end_at)}"></div>
      <div><label class="f">&nbsp;</label><label class="row" style="gap:8px"><input type="checkbox" id="s_shuffle"${e.shuffle ? ' checked' : ''} style="width:18px;height:18px"> Shuffle question order per student</label></div>
    </div>
    <label class="f" for="s_instr">Additional instructions for students</label><textarea id="s_instr" maxlength="5000">${esc(e.instructions)}</textarea>`;
  }
  const readSettings = () => ({
    title: $('#s_title').value, session_label: $('#s_session').value, academic_year: $('#s_year').value, department: $('#s_dept').value,
    duration_min: Number($('#s_dur').value), marks_per_q: Number($('#s_marks').value), negative_marks: Number($('#s_neg').value),
    start_at: fromLocal($('#s_start').value), end_at: fromLocal($('#s_end').value), shuffle: $('#s_shuffle').checked, instructions: $('#s_instr').value,
  });

  function newExam() {
    app.innerHTML = `<div class="wrap"><div class="card"><h2>New examination</h2>${settingsForm()}<div id="msg"></div>
      <div class="row" style="margin-top:14px"><a class="btn" href="#/">Cancel</a><span class="spacer"></span><button class="btn primary" id="create">Create and add questions</button></div></div></div>`;
    $('#create').onclick = async () => { try { const r = await api('POST', '/api/exams', readSettings()); location.hash = `#/exam/${r.id}`; } catch (e) { fail(e); } };
  }

  // ---------- editor ----------
  const SYMBOLS = ['θ', 'φ', 'ω', 'Δ', 'δ', 'α', 'β', 'λ', 'μ', 'π', 'σ', 'τ', 'Ω', '√', '∠', '°', '±', '≈', '≤', '≥', '∞', '×', '→'];
  let activeEd = null;

  async function editor(id) {
    const { exam: e, questions: qs, attempts } = await api('GET', `/api/exams/${id}`);
    const locked = e.status !== 'draft' || attempts > 0;
    const approved = qs.filter((q) => q.approved).length;
    const suggestedPending = qs.filter((q) => q.qtype !== 'nat' && q.suggested !== null && q.correct === null).length;
    app.innerHTML = `<div class="wrap">
      <div class="row" style="margin-bottom:10px"><a href="#/">← Examinations</a><span class="spacer"></span><a class="btn" href="#/results/${e.id}">Results &amp; monitoring</a></div>
      <div class="card">
        <div class="row"><h2 style="margin:0">${esc(e.title)}</h2><span class="pill ${e.status}">${e.status}</span><span class="spacer"></span>
          ${e.status === 'draft' ? '<button class="btn ok" id="pub">Publish examination</button>' : ''}
          ${e.status === 'published' && !attempts ? '<button class="btn" id="unpub">Unpublish</button>' : ''}
          ${e.status === 'published' ? '<button class="btn danger" id="close">Close examination</button>' : ''}
          ${e.status === 'closed' ? '<button class="btn" id="reopen">Reopen</button>' : ''}
          ${!attempts || e.status === 'closed' ? `<button class="btn danger small" id="del">${attempts ? 'Delete exam &amp; results' : 'Delete'}</button>` : ''}</div>
        <div class="row" style="margin-top:12px;gap:14px">
          <div><div class="muted">Examination code</div><span class="code" id="codeTxt">${esc(e.code)}</span></div>
          <div style="flex:1;min-width:240px"><div class="muted">Student link ${e.status === 'draft' ? '(active after publishing)' : ''}</div>
            <div class="row"><span class="linkbox" id="linkTxt">${esc(studentLink(e.slug))}</span><button class="btn small" id="copyLink">Copy link</button><button class="btn small" id="copyBoth">Copy link + code</button></div></div>
        </div>
        <div id="msg"></div>
      </div>

      <details class="card" ${qs.length ? '' : 'open'}><summary><b>Examination settings</b> <span class="muted">· ${e.duration_min} min · ${e.marks_per_q} mark(s) · −${e.negative_marks} per wrong</span></summary>
        ${settingsForm(e)}<div id="smsg"></div><div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" id="saveSettings">Save settings</button></div></details>

      ${locked ? `<div class="note">${attempts ? 'Students have attempted this examination, so questions are locked.' : 'Questions are locked while the examination is published. Unpublish to edit.'}</div>` : `
      <div class="card"><h2>Import questions from Word or PDF</h2>
        <p class="muted">Upload a .docx (recommended: keeps equations, sub/superscripts and diagrams), a text PDF, a scanned PDF, or a photo (.png/.jpg, read by OCR).
        Number questions <b>1.</b> or <b>Q1.</b>; label options <b>(A) (B) (C) (D)</b> on separate lines or on one line. An optional line <b>Answer: B</b> is shown as a suggestion only. A question with <b>no options</b> becomes a <b>numerical (NAT)</b> question; a line like <b>Answer: 4.95 to 5.05</b> pre-fills its answer range for you to confirm.</p>
        <div class="row"><input type="file" id="file" accept=".docx,.pdf,.png,.jpg,.jpeg"><button class="btn primary" id="upload">Upload &amp; extract</button></div>
        <div id="imsg"></div></div>`}

      <div class="card">
        <div class="row"><h2 style="margin:0">Questions &amp; answer key</h2><span class="spacer"></span>
          <div class="stats"><div class="stat"><b>${qs.length}</b>questions</div><div class="stat"><b>${approved}</b>approved</div><div class="stat"><b>${qs.length - approved}</b>need review</div></div></div>
        ${!locked && suggestedPending ? `<div class="warnbox">${suggestedPending} question(s) have an answer printed in the uploaded document that has not been confirmed.
          <button class="btn small" id="acceptAll">Review done – use document answers for these ${suggestedPending}</button></div>` : ''}
        <p class="muted">Each question must have its correct answer selected and be ticked <b>Faculty approved</b> before the examination can be published. Use \\( … \\) for LaTeX maths, e.g. \\( V_{rms} = \\frac{V_m}{\\sqrt{2}} \\).</p>
        <div id="qlist">${qs.map((q, i) => qcard(q, i, locked, e)).join('') || '<p class="muted">No questions yet.</p>'}</div>
        ${locked ? '' : '<div class="row"><button class="btn" id="addQ">+ Add MCQ question</button><button class="btn" id="addNat">+ Add numerical (NAT) question</button></div>'}
      </div>
      <input type="file" id="imgPick" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" class="hidden">
    </div>`;
    math($('#qlist'));

    const reload = () => editor(id);
    const act = async (fn, okMsg) => { try { const r = await fn(); await reload(); if (okMsg) flash(okMsg(r)); } catch (err) { fail(err); } };
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#pub', () => act(() => api('POST', `/api/exams/${id}/publish`), () => `Published. Share the link and the code <b>${esc(e.code)}</b> with students.`));
    on('#unpub', () => act(() => api('POST', `/api/exams/${id}/unpublish`), () => 'Back to draft.'));
    on('#close', () => { if (confirm('Close the examination? Students still writing will be submitted immediately.')) act(() => api('POST', `/api/exams/${id}/close`), (r) => `Closed. ${r.forcedSubmissions} active attempt(s) were submitted.`); });
    on('#reopen', () => act(() => api('POST', `/api/exams/${id}/reopen`), () => 'Reopened.'));
    on('#del', async () => {
      const ok = attempts
        ? prompt(`This permanently deletes the questions AND all ${attempts} student results. Download Excel/PDF first.\n\nType the exam code ${e.code} to confirm:`)?.trim().toUpperCase() === e.code
        : confirm('Delete this examination and all its questions?');
      if (ok) { try { await api('DELETE', `/api/exams/${id}`); location.hash = '#/'; } catch (err) { fail(err); } } });
    on('#copyLink', () => copy(studentLink(e.slug)));
    on('#copyBoth', () => copy(`${e.title}\nLink: ${studentLink(e.slug)}\nExamination code: ${e.code}`));
    on('#saveSettings', async () => { try { await api('PUT', `/api/exams/${id}`, readSettings()); await reload(); flash('Settings saved.'); } catch (err) { fail(err, '#smsg'); } });
    on('#acceptAll', () => { if (confirm('Copy the answers printed in the document into the answer key and approve those questions? Only do this after checking them.')) act(() => api('POST', `/api/exams/${id}/accept-suggested`), (r) => `${r.updated} question(s) updated.`); });
    on('#addQ', () => act(() => api('POST', `/api/exams/${id}/questions`, { stem: '', options: ['', '', '', ''] })));
    on('#addNat', () => act(() => api('POST', `/api/exams/${id}/questions`, { qtype: 'nat', stem: '' })));
    $('#qlist').addEventListener('change', (ev) => { if (ev.target.classList.contains('qt')) ev.target.closest('.qcard').classList.toggle('is-nat', ev.target.value === 'nat'); });
    on('#upload', async () => {
      const f = $('#file').files[0];
      if (!f) return fail(new Error('Choose a file first.'), '#imsg');
      const fd = new FormData(); fd.append('file', f);
      $('#upload').disabled = true; $('#imsg').innerHTML = '<div class="note">Extracting questions… scanned documents can take a minute.</div>';
      try { const r = await api('POST', `/api/exams/${id}/import`, fd); await reload(); flash(`<b>${r.added} question(s) extracted.</b> Review each one below, set the correct answer and approve it.${r.notes.length ? '<ul>' + r.notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>' : ''}`); }
      catch (err) { fail(err, '#imsg'); $('#upload').disabled = false; }
    });

    // question card actions (event delegation)
    $('#qlist').addEventListener('focusin', (ev) => { if (ev.target.classList.contains('ed')) activeEd = ev.target; });
    $('#qlist').addEventListener('mousedown', (ev) => { if (ev.target.closest('.tools button')) ev.preventDefault(); });
    $('#qlist').addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      const card = b.closest('.qcard'); const qid = card && Number(card.dataset.id);
      if (b.dataset.cmd) {
        if (!activeEd || !card.contains(activeEd)) { const first = card.querySelector('.ed'); first.focus(); activeEd = first; }
        const c = b.dataset.cmd;
        if (c === 'img') { $('#imgPick').onchange = () => insertImage(activeEd); $('#imgPick').click(); }
        else if (c.startsWith('sym:')) document.execCommand('insertText', false, c.slice(4));
        else if (c === 'eq') document.execCommand('insertText', false, '\\( \\)');
        else document.execCommand(c);
        return;
      }
      if (b.dataset.act === 'save') {
        try {
          const body = readCard(card);
          await api('PUT', `/api/exams/${id}/questions/${qid}`, body);
          await reload();
          const again = $(`.qcard[data-id="${qid}"]`); if (again) { again.scrollIntoView({ block: 'center' }); again.insertAdjacentHTML('afterbegin', '<div class="note">Saved.</div>'); }
        } catch (err) { card.querySelector('.cmsg').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
      }
      if (b.dataset.act === 'usesug') card.querySelector(`input[type=radio][value="${b.dataset.v}"]`).checked = true;
      if (b.dataset.act === 'del' && confirm('Delete this question?')) act(() => api('DELETE', `/api/exams/${id}/questions/${qid}`));
    });
  }

  function qcard(q, i, locked, e) {
    const ce = locked ? 'false' : 'true';
    const tools = locked ? '' : `<div class="tools" aria-label="Formatting">
      <button type="button" data-cmd="bold" title="Bold"><b>B</b></button><button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" data-cmd="superscript" title="Superscript">x²</button><button type="button" data-cmd="subscript" title="Subscript">x₂</button>
      ${SYMBOLS.map((s) => `<button type="button" data-cmd="sym:${s}">${s}</button>`).join('')}
      <button type="button" data-cmd="eq" title="Insert LaTeX maths">\\(…\\)</button><button type="button" data-cmd="img" title="Insert diagram image">🖼 Image</button></div>`;
    const flags = (q.flags || []).filter((f) => !(q.approved && /answer/i.test(f)));
    const nat = q.qtype === 'nat';
    const opts = q.options.length ? q.options : ['', '', '', ''];
    const dis = locked ? ' disabled' : '';
    return `<div class="qcard ${q.approved ? 'ok' : 'todo'}${nat ? ' is-nat' : ''}" data-id="${q.id}">
      <div class="head"><b>Q${i + 1}</b><span class="pill ${q.approved ? 'published' : 'draft'}">${q.approved ? 'approved' : 'needs review'}</span>
        <select class="qt" aria-label="Question type"${dis}><option value="mcq"${nat ? '' : ' selected'}>MCQ (4 options)</option><option value="nat"${nat ? ' selected' : ''}>Numerical answer (NAT)</option></select>
        <span class="muted">source: ${esc(q.source)}</span><span class="spacer"></span>
        ${q.suggested !== null && !nat ? `<span class="muted">Document answer: <b>${'ABCD'[q.suggested]}</b></span>${locked ? '' : ` <button class="btn small" type="button" data-act="usesug" data-v="${q.suggested}">Use</button>`}` : ''}</div>
      ${flags.length && !q.approved ? `<div class="warnbox"><b>Check:</b><ul>${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
      ${tools}
      <div class="ed" data-k="stem" contenteditable="${ce}" aria-label="Question ${i + 1} text">${q.stem}</div>
      <div class="mcq-only">${opts.map((o, k) => `<div class="optrow"><label><input type="radio" name="c${q.id}" value="${k}"${q.correct === k ? ' checked' : ''}${dis} aria-label="Option ${'ABCD'[k]} is correct"> (${'ABCD'[k]})</label>
        <div class="ed" data-k="o${k}" contenteditable="${ce}" aria-label="Option ${'ABCD'[k]}">${o}</div></div>`).join('')}</div>
      <div class="nat-only natkey"><b>Correct answer range</b> <span class="muted">(GATE style: any answer from … to … is correct; use the same number twice for an exact answer)</span>
        <div class="row" style="margin-top:6px"><label>From <input type="number" class="nmin" step="0.01" style="width:130px" value="${q.nat_min ?? ''}"${dis}></label>
        <label>To <input type="number" class="nmax" step="0.01" style="width:130px" value="${q.nat_max ?? ''}"${dis}></label>
        <span class="muted">Students enter up to 2 decimal places. No negative marking for NAT.</span></div></div>
      <div class="row" style="margin-top:8px">
        <label class="muted">Marks <input type="number" class="qm" step="0.25" min="0" style="width:84px" value="${q.marks ?? ''}" placeholder="${e.marks_per_q}"${locked ? ' disabled' : ''}></label>
        <label class="muted mcq-only">Negative <input type="number" class="qn" step="0.01" min="0" style="width:84px" value="${q.negative ?? ''}" placeholder="${e.negative_marks}"${locked ? ' disabled' : ''}></label>
        <span class="spacer"></span>
        <label class="row" style="gap:6px;font-weight:600"><input type="checkbox" class="qa"${q.approved ? ' checked' : ''}${locked ? ' disabled' : ''} style="width:18px;height:18px"> Faculty approved (question &amp; answer verified)</label>
        ${locked ? '' : '<button class="btn primary small" type="button" data-act="save">Save</button><button class="btn danger small" type="button" data-act="del">Delete</button>'}
      </div>
      <div class="cmsg"></div>
      <details><summary class="muted">Student view preview</summary><div class="preview"><div>${q.stem}</div>${nat ? '<div class="muted">[ numerical answer box + on-screen keypad ]</div>' : `<ol type="A">${q.options.map((o) => `<li>${o}</li>`).join('')}</ol>`}</div></details>
    </div>`;
  }

  function readCard(card) {
    const ed = (k) => card.querySelector(`.ed[data-k="${k}"]`).innerHTML.replace(/^(<br>)+|(<br>)+$/g, '').trim();
    const r = card.querySelector('input[type=radio]:checked');
    return {
      qtype: card.querySelector('.qt').value, stem: ed('stem'), options: [0, 1, 2, 3].map((k) => ed('o' + k)), correct: r ? Number(r.value) : null,
      approved: card.querySelector('.qa').checked, marks: card.querySelector('.qm').value, negative: card.querySelector('.qn').value,
      nat_min: card.querySelector('.nmin').value, nat_max: card.querySelector('.nmax').value,
    };
  }

  function insertImage(target) {
    const f = $('#imgPick').files[0]; $('#imgPick').value = '';
    if (!f || !target) return;
    if (f.size > 5 * 1024 * 1024) return alert('Image is larger than 5 MB. Export it at a smaller size (e.g. 2000 px wide PNG) first.');
    const rd = new FileReader();
    rd.onload = () => { target.focus(); document.execCommand('insertImage', false, rd.result); };
    rd.readAsDataURL(f);
  }

  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => flash('Copied to clipboard.'), () => prompt('Copy this:', text));
  }

  // ---------- results ----------
  async function results(id) {
    let filter = '';
    const draw = async () => {
      const { exam: e, attempts } = await api('GET', `/api/exams/${id}/results`);
      const done = attempts.filter((a) => a.status === 'submitted');
      const avg = done.length ? (done.reduce((s, a) => s + Number(a.score), 0) / done.length).toFixed(2) : '–';
      const rows = attempts.filter((a) => !filter || `${a.student_name} ${a.roll_no}`.toLowerCase().includes(filter));
      const pct = (a) => (a.max_score > 0 ? ((Number(a.score) / Number(a.max_score)) * 100).toFixed(1) + '%' : '');
      const live = (a) => a.status === 'active' && Date.now() - new Date(a.last_seen_at).getTime() < 60000;
      const body = rows.map((a) => `<tr>
        <td>${esc(a.student_name)}</td><td><b>${esc(a.roll_no)}</b></td>
        <td><span class="pill ${a.status}">${a.status === 'active' ? 'writing' : a.submit_mode === 'timeout' ? 'auto-submitted' : a.submit_mode === 'closed' ? 'closed' : 'submitted'}</span>${a.status === 'active' ? `<div class="muted">${live(a) ? '● online' : '○ no signal'}</div>` : ''}</td>
        <td>${fmt(a.started_at)}</td><td>${fmt(a.submitted_at)}</td>
        <td>${a.attempted ?? '–'}</td><td>${a.unanswered ?? '–'}</td><td>${a.correct_count ?? '–'}</td><td>${a.incorrect_count ?? '–'}</td>
        <td><b>${a.score ?? '–'}</b>${a.max_score ? ' / ' + a.max_score : ''}</td><td>${pct(a)}</td>
        <td>${a.warnings ? `<button class="btn small danger" data-ev="${a.id}" data-n="${esc(a.student_name)}">${a.warnings} ⚠</button>` : `<button class="btn small" data-ev="${a.id}" data-n="${esc(a.student_name)}">0</button>`}</td>
        <td>${a.status === 'active' ? `<button class="btn small" data-rel="${a.id}" title="Allow the student to continue on another device">Release session</button>` : ''}</td></tr>`).join('');
      const keepFocus = document.activeElement && document.activeElement.id === 'q';
      app.innerHTML = `<div class="wrap">
        <div class="row" style="margin-bottom:10px"><a href="#/exam/${id}">← ${esc(e.title)}</a><span class="spacer"></span><span class="muted">Auto-refreshes every 15 s</span></div>
        <div class="card"><div class="row"><h2 style="margin:0">Results: ${esc(e.title)}</h2><span class="pill ${e.status}">${e.status}</span></div>
          <p class="muted">${esc(e.session_label)} · ${esc(e.academic_year)} · Code <b>${esc(e.code)}</b></p>
          <div class="stats"><div class="stat"><b>${attempts.length}</b>started</div><div class="stat"><b>${done.length}</b>submitted</div>
            <div class="stat"><b>${attempts.length - done.length}</b>writing now</div><div class="stat"><b>${avg}</b>average marks</div>
            <div class="stat"><b>${attempts.filter((a) => a.warnings).length}</b>with warnings</div></div>
          <div class="row" style="margin-top:12px"><input type="search" id="q" placeholder="Search name or roll number" style="max-width:320px" value="${esc(filter)}">
            <span class="spacer"></span><button class="btn" id="xl">⬇ Excel</button><button class="btn" id="pdf">⬇ PDF</button></div>
          <div id="msg"></div>
          <div class="tablewrap" style="margin-top:10px"><table class="t"><thead><tr><th>Name</th><th>Roll No</th><th>Status</th><th>Started</th><th>Submitted</th><th>Attempted</th><th>Unanswered</th><th>Correct</th><th>Incorrect</th><th>Marks</th><th>%</th><th>Warnings</th><th></th></tr></thead>
          <tbody>${body || '<tr><td colspan="13" class="muted">No attempts yet.</td></tr>'}</tbody></table></div></div></div>`;
      const q = $('#q');
      q.oninput = () => { filter = q.value.trim().toLowerCase(); draw(); };
      if (keepFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      $('#xl').onclick = () => download(`/api/exams/${id}/results.xlsx`, `${e.title}_results.xlsx`);
      $('#pdf').onclick = () => download(`/api/exams/${id}/results.pdf`, `${e.title}_results.pdf`);
      $$('[data-ev]').forEach((b) => { b.onclick = () => events(id, Number(b.dataset.ev), b.dataset.n); });
      $$('[data-rel]').forEach((b) => { b.onclick = async () => { if (confirm('Release this session so the student can continue on another device? Use only when their device failed.')) { try { await api('POST', `/api/exams/${id}/attempts/${b.dataset.rel}/release`, {}); flash('Session released. The student can now re-enter their details on another device.'); } catch (err) { fail(err); } } }; });
    };
    await draw();
    refreshTimer = setInterval(() => { if ($('#modal').classList.contains('hidden')) draw().catch(() => {}); }, 15000);
  }

  async function events(examId, aid, name) {
    const ev = await api('GET', `/api/exams/${examId}/attempts/${aid}/events`);
    const label = { tab_hidden: 'Left page / switched tab', window_blur: 'Window lost focus', fullscreen_exit: 'Exited full screen', fullscreen_enter: 'Entered full screen', copy: 'Copy attempt', cut: 'Cut attempt', paste: 'Paste attempt', context_menu: 'Right-click', devtools_key: 'Developer-tools key', print_key: 'Print/save key', offline: 'Connection lost', online: 'Back online', fullscreen_denied: 'Full screen unavailable', concurrent_login_blocked: 'Blocked login from another device', session_resumed: 'Session resumed', session_released: 'Session released by faculty' };
    modal(`<h2>Activity log: ${esc(name)}</h2><div class="tablewrap" style="max-height:60vh"><table class="t"><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>
      ${ev.map((x) => `<tr><td>${new Date(x.at).toLocaleTimeString('en-IN')}</td><td>${esc(label[x.type] || x.type)}</td><td class="muted">${esc(x.detail)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No events recorded.</td></tr>'}
      </tbody></table></div><div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn" id="mx">Close</button></div>`);
    $('#mx').onclick = closeModal;
  }

  async function download(url, name) {
    try {
      const res = await api('GET', url, undefined, true);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = name.replace(/[^\w.-]+/g, '_');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { fail(e); }
  }

  // ---------- admin ----------
  async function admin() {
    const [fac, log] = await Promise.all([api('GET', '/api/admin/faculty'), api('GET', '/api/admin/audit')]);
    app.innerHTML = `<div class="wrap">
      <div class="card"><h2>Faculty accounts</h2><div id="msg"></div>
        <div class="tablewrap"><table class="t"><thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${fac.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.email)}</td><td>${esc(f.department)}</td><td>${f.role}</td><td>${f.active ? 'Active' : 'Disabled'}</td>
          <td><button class="btn small" data-tog="${f.id}" data-a="${f.active ? 0 : 1}">${f.active ? 'Disable' : 'Enable'}</button> <button class="btn small" data-pw="${f.id}">Reset password</button></td></tr>`).join('')}
        </tbody></table></div>
        <h3 style="margin-top:18px">Add faculty</h3>
        <div class="grid2"><div><label class="f">Name</label><input type="text" id="fn"></div><div><label class="f">Email</label><input type="email" id="fe"></div>
          <div><label class="f">Department</label><input type="text" id="fd" value="Department of Electrical Engineering"></div>
          <div><label class="f">Initial password (10+ characters)</label><input type="text" id="fp" autocomplete="off"></div>
          <div><label class="f">Role</label><select id="fr"><option value="faculty">Faculty</option><option value="admin">Administrator</option></select></div></div>
        <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" id="fadd">Create account</button></div></div>
      <div class="card"><h2>Audit log (latest 500)</h2><div class="tablewrap" style="max-height:480px"><table class="t"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead><tbody>
        ${log.map((l) => `<tr><td>${fmt(l.at)}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td class="muted">${esc(l.detail)}</td><td class="muted">${esc(l.ip)}</td></tr>`).join('')}
      </tbody></table></div></div></div>`;
    $('#fadd').onclick = async () => { try { await api('POST', '/api/admin/faculty', { name: $('#fn').value, email: $('#fe').value, department: $('#fd').value, password: $('#fp').value, role: $('#fr').value }); await admin(); flash('Account created. Share the password privately; they can change it after signing in.'); } catch (e) { fail(e); } };
    $$('[data-tog]').forEach((b) => { b.onclick = async () => { try { await api('PATCH', `/api/admin/faculty/${b.dataset.tog}`, { active: b.dataset.a === '1' }); await admin(); } catch (e) { fail(e); } }; });
    $$('[data-pw]').forEach((b) => { b.onclick = async () => { const p = prompt('New password (10+ characters):'); if (!p) return; try { await api('PATCH', `/api/admin/faculty/${b.dataset.pw}`, { password: p }); flash('Password reset.'); } catch (e) { fail(e); } }; });
  }

  async function boot() {
    try { me = await api('GET', '/api/auth/me'); } catch { return; }
    $('#nav').classList.remove('hidden');
    $('#navAdmin').classList.toggle('hidden', me.role !== 'admin');
    route();
  }
  boot();
})();
