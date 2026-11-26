'use strict';
// GATE-style scientific calculator. evaluate() is a small recursive-descent parser
// (no eval: the CSP forbids it, and it would run arbitrary code). Works in Node for tests.
(function (root) {
  const FN = {
    sin: (x, d) => Math.sin(d ? (x * Math.PI) / 180 : x), cos: (x, d) => Math.cos(d ? (x * Math.PI) / 180 : x),
    tan: (x, d) => { if (d && Math.abs(x % 180) === 90) return NaN; return Math.tan(d ? (x * Math.PI) / 180 : x); },
    asin: (x, d) => (d ? (Math.asin(x) * 180) / Math.PI : Math.asin(x)), acos: (x, d) => (d ? (Math.acos(x) * 180) / Math.PI : Math.acos(x)),
    atan: (x, d) => (d ? (Math.atan(x) * 180) / Math.PI : Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
    log: Math.log10, ln: Math.log, log2: Math.log2, exp: Math.exp, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  };
  const CONST = { 'π': Math.PI, pi: Math.PI, e: Math.E };

  function fact(n) {
    if (n < 0 || !Number.isInteger(n) || n > 170) return NaN;
    let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
  }

  function tokenize(s) {
    s = String(s).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/√/g, 'sqrt').replace(/∛/g, 'cbrt').replace(/\s+/g, '');
    const out = [];
    for (let i = 0; i < s.length;) {
      const rest = s.slice(i);
      let m;
      if ((m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest))) { out.push({ t: 'n', v: Number(m[0]) }); i += m[0].length; continue; }
      if ((m = /^(asinh|acosh|atanh|asin|acos|atan|sinh|cosh|tanh|sin|cos|tan|log2|log|ln|exp|sqrt|cbrt|abs)/.exec(rest))) { out.push({ t: 'f', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^(π|pi|e)/.exec(rest))) { out.push({ t: 'n', v: CONST[m[0]] }); i += m[0].length; continue; }
      if ('+-*/^()!%'.includes(s[i])) { out.push({ t: s[i] }); i++; continue; }
      throw new Error('Invalid input');
    }
    return out;
  }

  function evaluate(expr, opts = {}) {
    const deg = opts.deg !== false;
    const tk = tokenize(expr);
    if (!tk.length) throw new Error('Empty');
    let p = 0;
    const peek = () => tk[p] && tk[p].t;
    const take = (t) => { if (peek() !== t) throw new Error('Syntax error'); p++; };
    const startsPrimary = () => ['n', 'f', '('].includes(peek());

    function expression() {
      let v = term();
      while (peek() === '+' || peek() === '-') { const op = tk[p++].t; const r = term(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    function term() {
      let v = power();
      for (;;) {
        if (peek() === '*' || peek() === '/') { const op = tk[p++].t; const r = power(); v = op === '*' ? v * r : v / r; }
        else if (startsPrimary()) v *= power(); // implicit multiplication: 2π, 3(4+1), 2sin(30)
        else return v;
      }
    }
    function power() { // right-associative; -2^2 = -4
      if (peek() === '-') { p++; return -power(); }
      if (peek() === '+') { p++; return power(); }
      const b = postfix();
      if (peek() === '^') { p++; return Math.pow(b, power()); }
      return b;
    }
    function postfix() {
      let v = primary();
      while (peek() === '!' || peek() === '%') v = tk[p++].t === '!' ? fact(v) : v / 100;
      return v;
    }
    function primary() {
      const tok = tk[p];
      if (!tok) throw new Error('Syntax error');
      if (tok.t === 'n') { p++; return tok.v; }
      if (tok.t === 'f') { p++; take('('); const x = expression(); if (peek() === ')') p++; return FN[tok.v](x, deg); }
      if (tok.t === '(') { p++; const x = expression(); if (peek() === ')') p++; return x; } // a missing ")" at the end is tolerated
      throw new Error('Syntax error');
    }
    const v = expression();
    if (p !== tk.length) throw new Error('Syntax error');
    if (!Number.isFinite(v)) throw new Error('Math error');
    return Number(v.toPrecision(12));
  }

  // ---------------- Browser UI ----------------
  const KEYS = [
    ['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['(', '('], [')', ')'], ['MC', '@mc'],
    ['sin⁻¹', 'asin('], ['cos⁻¹', 'acos('], ['tan⁻¹', 'atan('], ['x²', '^2'], ['xʸ', '^'], ['MR', '@mr'],
    ['sinh', 'sinh('], ['cosh', 'cosh('], ['tanh', 'tanh('], ['√', 'sqrt('], ['∛', 'cbrt('], ['MS', '@ms'],
    ['log', 'log('], ['ln', 'ln('], ['eˣ', 'exp('], ['10ˣ', '10^('], ['n!', '!'], ['M+', '@m+'],
    ['π', 'π'], ['e', 'e'], ['1/x', '1/('], ['|x|', 'abs('], ['%', '%'], ['M−', '@m-'],
    ['7', '7'], ['8', '8'], ['9', '9'], ['÷', '÷'], ['←', '@back'], ['C', '@clear'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['×', '×'], ['x³', '^3'], ['(−)', '@neg'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['−', '−'], ['+', '+'], ['Ans', '@ans'],
    ['0', '0'], ['.', '.'], ['=', '@eq'],
  ];

  function mount(button) {
    let expr = '', last = 0, mem = 0, deg = true, fresh = false;
    const panel = document.createElement('div');
    panel.className = 'calc hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Scientific calculator');
    panel.innerHTML = `<div class="calc-head"><b>Scientific Calculator</b><span class="spacer"></span>
        <button type="button" class="calc-x" aria-label="Close calculator">✕</button></div>
      <div class="calc-screen"><div class="calc-expr" aria-live="polite"></div><div class="calc-res">0</div></div>
      <div class="calc-mode"><label><input type="radio" name="calcdeg" value="deg" checked> Deg</label>
        <label><input type="radio" name="calcdeg" value="rad"> Rad</label><span class="spacer"></span><span class="calc-mem"></span></div>
      <div class="calc-keys">${KEYS.map(([l, v]) => `<button type="button" data-k="${v}" class="${v === '@eq' ? 'eq' : /^[\d.]$/.test(v) ? 'num' : /^@(clear|back)$/.test(v) ? 'clr' : ''}">${l}</button>`).join('')}</div>`;
    document.body.appendChild(panel);
    const $e = panel.querySelector('.calc-expr'), $r = panel.querySelector('.calc-res'), $m = panel.querySelector('.calc-mem');
    const show = () => { $e.textContent = expr || ' '; $m.textContent = mem ? 'M' : ''; };
    const result = () => { try { return evaluate(expr, { deg }); } catch { return null; } };

    panel.querySelector('.calc-keys').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      const k = b.dataset.k;
      if (k === '@eq') {
        try { last = evaluate(expr, { deg }); $r.textContent = String(last); expr = String(last); fresh = true; }
        catch (err) { $r.textContent = err.message === 'Math error' ? 'Math error' : 'Syntax error'; }
        return show();
      }
      // After "=", typing a number or function starts a new calculation; an operator continues from the result.
      if (fresh && !k.startsWith('@') && !/^[+\-−×÷^!%]/.test(k)) expr = '';
      fresh = false;
      if (k === '@clear') { expr = ''; $r.textContent = '0'; }
      else if (k === '@back') expr = expr.slice(0, -1);
      else if (k === '@neg') expr += '−';
      else if (k === '@ans') expr += String(last);
      else if (k === '@mc') mem = 0;
      else if (k === '@mr') expr += String(mem);
      else if (k === '@ms') { const v = result(); if (v !== null) mem = v; }
      else if (k === '@m+' || k === '@m-') { const v = result(); if (v !== null) mem = Number((mem + (k === '@m+' ? v : -v)).toPrecision(12)); }
      else expr += k;
      show();
    });
    panel.querySelectorAll('input[name=calcdeg]').forEach((r) => r.addEventListener('change', () => { deg = r.value === 'deg'; }));
    const toggle = (open) => { panel.classList.toggle('hidden', !open); button.setAttribute('aria-expanded', String(open)); };
    button.addEventListener('click', () => toggle(panel.classList.contains('hidden')));
    panel.querySelector('.calc-x').addEventListener('click', () => toggle(false));

    // Drag by the title bar (pointer events cover mouse and touch).
    const head = panel.querySelector('.calc-head');
    head.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('button')) return;
      const r = panel.getBoundingClientRect(), dx = ev.clientX - r.left, dy = ev.clientY - r.top;
      head.setPointerCapture(ev.pointerId);
      const move = (e) => {
        panel.style.left = `${Math.max(0, Math.min(innerWidth - r.width, e.clientX - dx))}px`;
        panel.style.top = `${Math.max(0, Math.min(innerHeight - 40, e.clientY - dy))}px`;
        panel.style.right = 'auto';
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', () => head.removeEventListener('pointermove', move), { once: true });
    });
    show();
    return { close: () => toggle(false) };
  }

  const api = { evaluate, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
