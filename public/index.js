'use strict';
document.getElementById('cf').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  msg.textContent = '';
  try {
    const res = await fetch('/api/public/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('code').value }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Invalid examination code.');
    location.href = `/e/${d.slug}`;
  } catch (err) {
    msg.innerHTML = '<div class="err"></div>';
    msg.firstChild.textContent = err.message;
  }
});
