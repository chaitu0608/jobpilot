/**
 * Clinqy × Browsy — application form filler.
 * Injected on demand (chrome.scripting) into every frame of an application page.
 * Fills by matching field labels against your profile + answer bank, then shows a
 * review bar. It NEVER submits on its own — the submit button in the bar is what
 * clicks the site's real submit button, and only when you press it.
 */
(() => {
  if (window.__jobpilotATSFill) return;

  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];

  function visible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0;
  }

  function labelText(el) {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      for (const id of labelledby.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n) parts.push(n.innerText || '');
      }
    }
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) parts.push(l.innerText || '');
      } catch { /* ignore */ }
    }
    const closestLabel = el.closest('label');
    if (closestLabel) parts.push(closestLabel.innerText || '');
    const fieldset = el.closest('fieldset');
    if (fieldset?.querySelector('legend')) parts.push(fieldset.querySelector('legend').innerText || '');
    const group = el.closest('[role="group"], [data-field], .field, .application-question, .question');
    if (group && parts.length === 0) parts.push((group.innerText || '').slice(0, 200));
    parts.push(el.getAttribute('placeholder') || '');
    parts.push(el.getAttribute('name') || '');
    parts.push(el.id || '');
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function selectValue(el, value) {
    const want = String(value).trim().toLowerCase();
    const opts = [...el.options];
    let opt =
      opts.find((o) => o.text.trim().toLowerCase() === want) ||
      opts.find((o) => o.value.trim().toLowerCase() === want) ||
      opts.find((o) => o.text.toLowerCase().includes(want)) ||
      opts.find((o) => want.includes(o.text.trim().toLowerCase()) && o.text.trim().length > 2);
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function attachFile(input, resume) {
    const bin = atob(resume.dataB64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], resume.name || 'resume.pdf', { type: resume.type || 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // label → profile key. Order matters: first match wins.
  const PROFILE_RULES = [
    { key: 'firstName', re: /\b(first|given)\s*names?\b|firstname|^first$/i },
    { key: 'lastName', re: /\b(last|family|sur)\s*names?\b|lastname|surname/i },
    { key: 'email', re: /e-?mail/i },
    { key: 'phone', re: /\b(phone|mobile|contact\s*number|telephone)\b/i },
    { key: 'fullName', re: /\b(full|legal)\s*name\b|^name$|your\s+name/i, exclude: /company|organi[sz]ation|user\s?name|nickname|last|first|middle/i },
    { key: 'linkedin', re: /linked\s?in/i },
    { key: 'github', re: /git\s?hub/i },
    { key: 'portfolio', re: /\b(portfolio|personal\s+(site|website)|website|homepage|blog)\b/i },
    { key: 'twitter', re: /\b(twitter|x)\s*(handle|profile|url|account)?\b/i, exclude: /whatsapp/i },
    { key: 'location', re: /\b(location|city|where\s+(are\s+you|you\s+are)?\s*(based|located)|current\s+(city|location))\b/i },
    { key: 'country', re: /\bcountry\b/i },
    { key: 'currentCompany', re: /\b(current|present|latest)\s*(company|employer|organi[sz]ation)\b|company\s+(you\s+)?(currently\s+)?work/i },
    { key: 'currentTitle', re: /\b(current|present)\s*(title|role|position|designation)\b|\bjob\s*title\b/i },
    { key: 'yearsExperience', re: /\b(years?|yrs?)\b[^.]{0,20}\b(experience|exp)\b|total\s+experience|how\s+many\s+years/i },
    { key: 'noticePeriod', re: /notice\s*period|availability\s+to\s+(join|start)|when\s+can\s+you\s+(start|join)/i },
    { key: 'expectedSalary', re: /\b(expected|desired)\s*(salary|ctc|compensation|pay|package)\b|salary\s+expectation|compensation\s+expectation/i },
    { key: 'currentCompany', re: /organi[sz]ation\s*name|employer\s*name/i },
  ];

  function matchRule(label, profile, answers) {
    for (const r of PROFILE_RULES) {
      if (r.exclude?.test(label)) continue;
      if (!r.re.test(label)) continue;
      const value = profile[r.key];
      if (value != null && String(value).trim() !== '') return { value: String(value).trim(), from: r.key };
    }
    for (const a of answers) {
      if (a.re.test(label)) return { value: String(a.value).trim(), from: 'answer' };
    }
    return null;
  }

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function findSubmit() {
    const cands = qa('button, input[type=submit], a[role=button]').filter(visible);
    return (
      cands.find((b) => b.matches('button[type="submit"], input[type="submit"]') && !/cancel|back|save|draft/i.test(b.innerText || b.value || '')) ||
      cands.find((b) => /\b(submit|send\s+application|apply( now)?|finish|complete)\b/i.test((b.innerText || b.value || '').trim()) && !/cancel|back|preview|draft|linkedin|indeed/i.test((b.innerText || b.value || '').trim())) ||
      null
    );
  }

  function removeBar() {
    document.getElementById('__jobpilot_bar_host')?.remove();
  }

  function showBar({ filledCount, missing, resumeAttached, jobId, onSubmit, noForm = false }) {
    removeBar();
    const host = document.createElement('div');
    host.id = '__jobpilot_bar_host';
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;';
    const sh = host.attachShadow({ mode: 'open' });
    const missingTxt = missing.length
      ? `· <b style="color:#f0b849">review ${missing.length}</b>: ${missing.slice(0, 4).map((m) => m).join(', ')}${missing.length > 4 ? '…' : ''}`
      : '· everything matched 🎉';
    const leftTxt = noForm
      ? 'no application form found on this page — fill it yourself, or use the posting\'s direct apply link'
      : `filled <b class="ok">${filledCount}</b> field${filledCount === 1 ? '' : 's'}${resumeAttached ? ' + resume' : ''} ${missingTxt}`;
    sh.innerHTML = `
      <style>
        .bar { background:#10141d; color:#e7eaf3; border-top:1px solid #2c3450;
               font:13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
               padding:9px 14px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;
               box-shadow:0 -8px 30px rgba(0,0,0,.45) }
        .jp { font-weight:800; letter-spacing:-.02em }
        .jp span { color:#7aa2ff }
        .dim { color:#8b93a7 }
        button { font:inherit; font-weight:600; cursor:pointer; border-radius:8px; padding:6px 13px;
                 border:1px solid #38405e; background:#1b2130; color:#e7eaf3 }
        button.primary { background:#2f6df6; border-color:#2f6df6; color:#fff }
        button.primary:hover { background:#4a83ff }
        button.ghost { background:transparent; border-color:transparent; color:#8b93a7 }
        .spacer { flex:1 }
        .ok { color:#6ee787 }
      </style>
      <div class="bar">
        <div class="jp">job<span>pilot</span></div>
        <div class="dim">${leftTxt}</div>
        <div class="spacer"></div>
        <button class="ghost" id="jp-hide">hide</button>
        <button id="jp-open">dashboard</button>
        ${noForm ? '' : '<button class="primary" id="jp-submit">Submit application ▶</button>'}
      </div>`;
    sh.getElementById('jp-hide').onclick = () => removeBar();
    sh.getElementById('jp-open').onclick = () => window.open('http://127.0.0.1:8787', '_blank');
    if (sh.getElementById('jp-submit')) sh.getElementById('jp-submit').onclick = async () => {
      const bar = sh.querySelector('.bar');
      onSubmit();
      bar.innerHTML = `<div class="jp">job<span>pilot</span></div>
        <div class="dim">submitting… Clinqy × Browsy marked this application <b class="ok">applied</b>. good luck 🍀</div>`;
      setTimeout(removeBar, 4000);
    };
    document.documentElement.appendChild(host);
  }

  window.__jobpilotATSFill = async function (pkt) {
    const profile = pkt.profile || {};
    const answers = (pkt.answers || []).map((a) => ({ re: new RegExp(a.pattern, 'i'), value: a.value }));
    const filled = [];
    const missing = [];
    let resumeAttached = false;

    const fields = qa('input, textarea, select').filter(visible);
    const handledRadioGroups = new Set();

    for (const el of fields) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search'].includes(type)) continue;
      const ident = `${el.name || ''} ${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
      if (/captcha|recaptcha|hcaptcha|turnstile/i.test(ident)) continue;

      const label = labelText(el);

      if (type === 'file') continue; // resume handled separately

      if (tag === 'select') {
        const rule = matchRule(label, profile, answers);
        if (rule) {
          const ok = selectValue(el, rule.value);
          if (ok) filled.push({ label: label.slice(0, 70), value: rule.value });
          else missing.push(label.slice(0, 70));
        } else if (el.required) {
          missing.push(label.slice(0, 70));
        }
        continue;
      }

      if (type === 'checkbox') {
        const rule = matchRule(label, profile, answers);
        if (rule && /^(yes|true|i agree|agree|acknowledge|confirm)$/i.test(String(rule.value).trim())) {
          if (!el.checked) el.click();
          filled.push({ label: label.slice(0, 70), value: rule.value });
        } else if (el.required && !el.checked) {
          missing.push(label.slice(0, 70));
        }
        continue;
      }

      if (type === 'radio') {
        const groupName = el.name || label;
        if (handledRadioGroups.has(groupName)) continue;
        handledRadioGroups.add(groupName);
        const groupLabel = labelText(el);
        const rule = matchRule(groupLabel, profile, answers);
        const radios = el.name
          ? qa(`input[type=radio][name="${CSS.escape(el.name)}"]`).filter(visible)
          : [el];
        if (rule) {
          const want = String(rule.value).trim();
          const target =
            radios.find((r) => new RegExp(`^\\s*${escapeRe(want)}\\s*$`, 'i').test(labelText(r))) ||
            radios.find((r) => labelText(r).toLowerCase().includes(want.toLowerCase()));
          if (target) {
            if (!target.checked) target.click();
            filled.push({ label: groupLabel.slice(0, 70), value: want });
          } else {
            missing.push(groupLabel.slice(0, 70));
          }
        } else if (radios.some((r) => r.required)) {
          missing.push(groupLabel.slice(0, 70));
        }
        continue;
      }

      // text-likes
      if (el.value && el.value.trim()) continue; // never clobber existing input
      const rule = matchRule(label, profile, answers);
      if (rule) {
        setNative(el, rule.value);
        el.style.outline = '2px solid rgba(110,231,135,.55)';
        el.style.outlineOffset = '1px';
        filled.push({ label: label.slice(0, 70), value: rule.value });
      } else if (el.required || el.getAttribute('aria-required') === 'true') {
        el.style.outline = '2px dashed rgba(240,184,73,.6)';
        el.style.outlineOffset = '1px';
        missing.push(label.slice(0, 70) || el.name || el.id || 'unnamed field');
      }
    }

    // resume upload
    if (pkt.resume?.dataB64) {
      const fileInputs = qa('input[type=file]').filter((i) => !i.disabled);
      const target =
        fileInputs.find((i) => /resume|\bcv\b|attach/i.test(labelText(i))) ||
        (fileInputs.length === 1 ? fileInputs[0] : null);
      if (target) {
        try {
          attachFile(target, pkt.resume);
          resumeAttached = true;
          filled.push({ label: (labelText(target) || 'resume').slice(0, 70), value: pkt.resume.name });
        } catch (err) {
          missing.push('resume upload (failed: ' + err.message + ')');
        }
      } else if (fileInputs.length) {
        missing.push('resume upload (multiple file fields — pick manually)');
      }
    }

    if (filled.length || missing.length) {
      showBar({
        filledCount: filled.length,
        missing,
        resumeAttached,
        jobId: pkt.jobId,
        onSubmit: () => {
          const btn = findSubmit();
          try {
            chrome.runtime.sendMessage({ type: 'jp_submitted', jobId: pkt.jobId, url: location.href, summary: `filled ${filled.length}, missing ${missing.length}` });
          } catch { /* ignore */ }
          if (btn) {
            btn.click();
          } else {
            const form = document.querySelector('form');
            if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
            else alert('Clinqy × Browsy could not find the submit button — submit it yourself, the form is filled.');
          }
        },
      });
      try {
        chrome.runtime.sendMessage({
          type: 'jp_fill_report',
          jobId: pkt.jobId,
          summary: `filled ${filled.length}, missing: ${missing.slice(0, 5).join('; ') || 'none'}`,
        });
      } catch { /* ignore */ }
    } else if (!fields.length && window.top === window.self && pkt.jobId) {
      // No form in this page at all — tell the user instead of silently doing nothing.
      showBar({
        filledCount: 0,
        missing: [],
        resumeAttached: false,
        jobId: pkt.jobId,
        noForm: true,
        onSubmit: () => {},
      });
    }

    return {
      filled,
      missing: missing.map((m) => ({ label: m })),
      resumeAttached,
      url: location.href,
      fieldsSeen: fields.length,
    };
  };
})();
