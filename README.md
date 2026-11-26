# ExamDesk – Online MCQ Examination Portal

Ramkrishna Mahato Government Engineering College, Purulia, West Bengal.

ExamDesk has two portals:

| Portal | URL | Who |
|---|---|---|
| Student examination | `/e/<link-id>` (or `/` and enter the code) | Anyone with the link + exam code. **No account of any kind** (no ChatGPT, Google, etc.). |
| Faculty admin | `/faculty` | Faculty accounts created by the administrator. |

Stack: Node.js 20+ (Express 5) · PostgreSQL 14+ (works with Supabase) · no build step.
Everything the browser needs (KaTeX for maths, OCR language data) is served by the app itself, so it works on networks that block CDNs.

---

## 1. Deploy (Render + Supabase, free tiers are enough for a class)

1. **Database.** Create a Supabase project, then copy *Project Settings → Database → Connection string → URI (Session pooler)*. Any PostgreSQL works (Neon, Railway, RDS, or a college server).
2. **Code.** Push this folder to a private GitHub repository.
3. **App.** On Render, create a *New → Web Service* from the repo and choose **Docker** (the Dockerfile installs `poppler-utils` for PDF import/OCR). Set the environment variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase URI |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first administrator (10+ char password; used only when no faculty exist) |
   | `NODE_ENV` | `production` |
   | `TRUST_PROXY` | `1` |

4. Deploy. Tables are created automatically on the first start. Visit `https://<your-app>.onrender.com/faculty` and sign in.
5. In **Administration**, create accounts for other faculty, then sign in and change your password.

> On Render's free plan the service sleeps when idle and takes about 30–60 s to wake. Open the link a few minutes before the exam, or use a paid instance during exam weeks.

**College server instead:** `docker build -t examdesk . && docker run -p 3000:3000 --env-file .env examdesk`, behind Nginx with HTTPS.

**Local development:**
```bash
npm install
DATABASE_URL=postgres://examdesk:examdesk@localhost:5432/examdesk PGSSL=off npm start
```
Without `ADMIN_EMAIL` in development, an `admin@examdesk.local` account is created and its password is printed once in the console.

**Logo:** replace `public/logo.png` with the official college logo (square PNG, 256×256 or larger). The file shipped here is a placeholder.

---

## 2. Faculty workflow

1. **New examination:** title, session, academic year, department, duration, marks per question, negative marks, optional open/close times, optional per-student shuffle.
2. **Import** a `.docx` (best), a text PDF, a scanned PDF, or a photo (`.png`/`.jpg`, read by OCR).
3. **Review** every question: edit the text (B / I / x² / x₂ / θ φ ω Δ √ … / LaTeX `\( … \)` / insert diagram image), choose the correct option, and tick **Faculty approved**.
   - A printed `Answer: B` line is only shown as **Document answer**. It is never used until you press *Use* or the explicit *use document answers* button.
   - Flags highlight diagrams, converted equations, OCR text, and wrong option counts.
4. **Publish.** This is refused until every question has 4 options, a correct answer, and approval. Then copy the link + code.
5. **Results & monitoring:** live table (auto-refresh), search, warnings with a per-student activity log, **Release session** for a student whose device failed, and **Excel / PDF** export.
6. **Close** the examination to submit everyone still writing immediately.
7. **Free space (optional):** after downloading the Excel/PDF results, a closed examination can be deleted with **Delete exam & results** (you type the exam code to confirm). This permanently removes its questions, student answers and activity logs.

### Question types and exam tools
- **MCQ:** four options, one correct answer, optional negative marking.
- **NAT (Numerical Answer Type):** no options. The student types the answer on an **on-screen keypad** (0–9, decimal point, minus, Backspace, Clear), with up to **two decimal places**, and negative values are allowed. The key is a range (for example 3.95 to 4.05), as in GATE; an exact answer uses the same number twice. **No negative marking** for NAT.
- **Scientific calculator:** a GATE-style calculator opens from the top bar during the exam (sin/cos/tan and inverses, sinh/cosh/tanh, log, ln, eˣ, 10ˣ, √, ∛, xʸ, n!, π, e, memory keys, Deg/Rad).
- **Diagrams:** insert circuit diagrams, graphs and figures (PNG, JPG, SVG, WebP; up to 5 MB each) with the 🖼 Image button. Students click a diagram to open it full-screen and zoom in/out.

### Question paper format
```
1. A 4-pole, 50 Hz induction motor runs at 1440 rpm. The slip is
(A) 2%
(B) 4%
(C) 5%
(D) 6%
Answer: B                      <- optional; shown as a suggestion only

Q2. The RMS value of v(t) = Vm sin ωt is  (A) Vm/√2  (B) Vm/2  (C) √2Vm  (D) Vm
```
- A question with **no options** is imported as **NAT**; `Answer: 4.95 to 5.05` (or `Answer: 5`) pre-fills its range for you to confirm.
- Questions: `1.`, `1)`, `Q1.`, `Q.1`, or Word auto-numbering. Options: `(A)`, `A)`, `A.`, `(a)`, or Word lettered lists, one per line or all on one line.
- Word equations (Equation Editor/OMML) are converted to LaTeX and rendered with KaTeX. Unicode symbols, subscripts, superscripts, tables, and embedded images are kept.
- PDFs lose sub/superscripts and figures; attach diagrams in the review screen. Scanned pages are OCR'd (English, up to 20 pages); verify every symbol (OCR often reads √ as V).

---

## 3. Security model

| Requirement | Implementation |
|---|---|
| Exam code & active check | Validated server-side on every start; draft exams are invisible; open/close window enforced. |
| One attempt per roll number | `UNIQUE(exam_id, roll_no)` in the database; a submitted attempt is locked forever. |
| No concurrent sessions | Each start issues a new session token (only its hash is stored). A second device is refused while the first is active (heartbeat < 60 s), and the attempt is logged. Recovery after a crash: wait 60 s or ask faculty to *Release session*. Same roll with a different name is refused. |
| Timing | The deadline is stored at start (`min(start + duration, close time)`). Answers are refused 30 s after it; a sweeper auto-submits every expired attempt even if the browser has disappeared. The client timer is only a display. |
| Autosave & recovery | Each click is saved; failed saves queue in `localStorage` and retry with back-off; reload resumes with all answers. |
| Answer-key secrecy | Student endpoints never select `correct`/`suggested`; scoring happens on the server. Faculty API needs a session cookie (HttpOnly, SameSite=Strict, Secure in production) and a CSRF header. |
| Roles | Faculty see only their own exams; administrators see everything and manage accounts. |
| Input validation / XSS | All question HTML passes an allow-list sanitizer (only `data:` images). Strict CSP (`script-src 'self'`), no inline scripts. |
| Rate limiting | Login (10 / 15 min per IP+email), exam start (8 / min per IP+roll), per-session saves, generous per-IP limits suitable for a lab behind one public IP. |
| Audit log | Logins, failures, exam changes, imports, publishing, exports, starts, submissions, invalid codes, releases. |
| Integrity monitoring | Fullscreen requested at start; tab/app switches, focus loss, fullscreen exit, copy/cut/paste, right-click, and developer-tool/print shortcuts are blocked where possible, warned, counted, and shown to faculty with timestamps. |

### What a website cannot do
A normal web page **cannot** stop a student from opening other tabs or apps, using a second device, or taking photos; it can only detect and record leaving the page. For high-stakes examinations:

- **Safe Exam Browser (SEB)**, free for Windows/macOS/iPad, is the standard. In SEB Config Tool set *Start URL* = the student link, enable *Use Browser Exam Key*, disable *Allow quitting* (or set a quit password), and distribute the `.seb` file. Students then cannot leave the exam window.
- **Lab PCs:** Windows *Assigned Access* (kiosk mode) or a Chrome kiosk launch (`chrome --kiosk --incognito <student link>`) on invigilated machines.
- **Android tablets:** Android *screen pinning* (Settings → Security → App pinning), or managed kiosk mode via Google Workspace/MDM.
- Keep human invigilation; use the warnings report as evidence, not as automatic punishment.

---

## 4. Tests
```bash
npm test        # parser, scoring, validation, sanitizer, Word/PDF/OCR import
npm run e2e     # full browser run against a throw-away database (wipes examdesk_test)
```
`npm run e2e` needs PostgreSQL with a database named `examdesk_test` (or set `E2E_DATABASE_URL`) and Playwright's Chromium. It covers: faculty login, exam creation, Word import, publish blocked until the key is approved, student entry without any account, invalid code, mandatory fields, answer-key secrecy, navigation/palette, integrity warnings, simultaneous session blocked, name mismatch, offline answering and resync, reload recovery, submission + receipt, re-attempt blocked, real 1-minute timer auto-submit, server-side deadline enforcement, results, Excel and PDF export, faculty isolation, audit log, login rate limiting, and an Android phone layout.

## 5. Known limitations
- Rate-limit counters are in memory (one instance). For several instances, move them to Redis.
- OCR is English only and capped at 20 pages per PDF; complex equations in scanned papers need manual correction.
- Questions cannot be re-ordered in the editor (they keep import order; use shuffle if needed).
- Only single-correct MCQs are supported (no MSQ/NAT question types).
