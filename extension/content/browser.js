/**
 * Job Pilot — in-page browser engine (Browsy-style, built in).
 *
 * Injected on demand into the tab the local server asks about. Gives the MCP
 * agent a compact snapshot with short-lived `eN` refs, then lets it click,
 * type, press keys, scroll and read HTML. No remote debugging port; control
 * flows through the extension's existing local HTTP bridge.
 *
 * Safety: clicks on submit-like / pay / delete elements are refused unless the
 * caller explicitly passes approved:true. The user always sees and approves
 * consequential actions; application submission is never automated.
 */
(() => {
  if (window.__jpBrowser && window.__jpBrowser.version >= 1) return;

  const MAX_ELEMENTS = 450;
  const refs = new Map();
  let seq = 0;

  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="combobox"]',
    '[role="textbox"]', '[role="searchbox"]', '[contenteditable="true"]', '[onclick]',
  ].join(',');

  const RISKY = /\b(submit(\s+application)?|send\s+application|send\s+message|place\s+order|pay(\s+now)?|purchase|delete|remove\s+account|apply\s+now|confirm\s+application|complete\s+application)\b/i;

  /* ------------------------------------------------------------------ utils */

  const clip = (s, n = 80) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }

  function labelText(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clip(t)) return clip(t);
    }
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && clip(lab.innerText)) return clip(lab.innerText);
      } catch { /* invalid id */ }
    }
    const wrap = el.closest('label');
    if (wrap && clip(wrap.innerText)) return clip(wrap.innerText);
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return clip(el.value || t);
      if (t === 'image') return clip(el.alt || 'image button');
    }
    const ph = el.getAttribute('placeholder');
    if (ph && clip(ph)) return clip(ph);
    const title = el.getAttribute('title');
    if (title && clip(title)) return clip(title);
    if (tag === 'IMG') return clip(el.alt || '');
    const txt = clip(el.innerText);
    if (txt) return txt.slice(0, 100);
    return clip(el.getAttribute('name') || '');
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'element';
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) {
      const sel = `#${CSS.escape(el.id)}`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* ignore */ }
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 7) {
      let sel = cur.tagName.toLowerCase();
      const name = cur.getAttribute('name');
      if (name) {
        sel += `[name="${CSS.escape(name)}"]`;
      } else {
        const parent = cur.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
          if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(sel);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch { /* ignore */ }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function descriptor(el) {
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: labelText(el),
      text: clip(el.innerText || el.value || '', 120),
    };
  }

  function resolve(args = {}) {
    if (args.ref) {
      const el = refs.get(String(args.ref));
      if (!el || !el.isConnected) throw new Error(`stale ref "${args.ref}" — take a fresh snapshot`);
      return el;
    }
    if (args.selector) {
      let el;
      try { el = document.querySelector(args.selector); } catch { throw new Error('invalid selector'); }
      if (!el) throw new Error(`selector not found: ${args.selector}`);
      return el;
    }
    return null;
  }

  function clearRefs() {
    for (const el of refs.values()) {
      try { el.removeAttribute('data-jp-ref'); } catch { /* ignore */ }
    }
    refs.clear();
    seq = 0;
  }

  function nextRef(el) {
    seq += 1;
    const ref = `e${seq}`;
    refs.set(ref, el);
    try { el.setAttribute('data-jp-ref', ref); } catch { /* ignore */ }
    return ref;
  }

  function valueOf(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      return { value: clip(opt ? opt.textContent : el.value, 60), options: [...el.options].slice(0, 14).map((o) => clip(o.textContent, 40)) };
    }
    if (el.type === 'password') return { value: el.value ? '••••••' : '' };
    if (el.type === 'file') return { value: el.files && el.files.length ? `${el.files.length} file(s)` : '' };
    if (el.type === 'checkbox' || el.type === 'radio') return { checked: Boolean(el.checked) };
    if (el.isContentEditable) return { value: clip(el.innerText, 80) };
    return { value: clip(el.value || '', 80) };
  }

  /* --------------------------------------------------------------- snapshot */

  function snapshot() {
    clearRefs();
    const lines = [];
    const meta = { url: location.href, title: document.title, refs: 0, truncated: false };

    const heads = [...document.querySelectorAll('h1, h2, h3')].filter(isVisible).slice(0, 10);
    for (const h of heads) lines.push(`heading "${clip(h.innerText, 120)}"`);

    const seen = new Set();
    let count = 0;
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (count >= MAX_ELEMENTS) { meta.truncated = true; break; }
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      // Skip our own review bar and extension UI.
      if (el.closest('[data-jp-ui]')) continue;
      const ref = nextRef(el);
      const role = roleOf(el);
      const name = labelText(el);
      let line = `[${ref}] ${role} "${name}"`;
      const v = valueOf(el);
      if (v.value !== undefined && v.value !== '') line += ` value="${v.value}"`;
      if (v.checked !== undefined) line += v.checked ? ' checked' : ' unchecked';
      if (v.options && v.options.length) line += ` options="${v.options.join(' | ')}"`;
      if (el.disabled) line += ' disabled';
      if (el.required) line += ' required';
      lines.push(line);
      count += 1;
    }

    const text = clip(document.body ? document.body.innerText : '', 1800);
    meta.refs = seq;
    return { snapshot: lines.join('\n'), meta, pageText: text };
  }

  /* ------------------------------------------------------------------ html */

  function getHtml({ selector, maxLength } = {}) {
    let node;
    if (selector) {
      try { node = document.querySelector(selector); } catch { throw new Error('invalid selector'); }
      if (!node) throw new Error(`selector not found: ${selector}`);
    } else {
      node = document.documentElement;
    }
    const full = node.outerHTML || '';
    const max = Math.min(Number(maxLength) || 200000, 2000000);
    return { html: full.slice(0, max), length: full.length, truncated: full.length > max };
  }

  /* ----------------------------------------------------------------- click */

  function isRisky(el, label) {
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && (t === 'submit' || t === 'image')) return true;
    if (el.tagName === 'BUTTON' && (t === 'submit' || el.closest('form') && !t)) {
      if (RISKY.test(label)) return true;
    }
    return RISKY.test(label);
  }

  function click({ ref, selector, x, y, approved } = {}) {
    // Coordinate click (canvas editors). Best-effort synthetic events.
    if (x != null && y != null) {
      const el = document.elementFromPoint(Number(x), Number(y));
      if (!el) throw new Error('nothing at those coordinates');
      const opts = { bubbles: true, clientX: Number(x), clientY: Number(y), button: 0 };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return { ok: true, target: descriptor(el), message: `clicked at (${x}, ${y})` };
    }

    const el = resolve({ ref, selector });
    if (!el) throw new Error('click needs ref, selector, or x+y');
    const label = labelText(el);
    if (isRisky(el, label) && approved !== true) {
      return {
        ok: false,
        needsApproval: true,
        label,
        target: descriptor(el),
        message: `"${label || 'this control'}" looks consequential (submit/pay/delete). Ask the user, then retry with approved=true.`,
      };
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* ignore */ }
    el.click();
    return { ok: true, target: descriptor(el), message: `clicked ${roleOf(el)} "${label}"` };
  }

  /* ------------------------------------------------------------------ type */

  function nativeSet(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function type({ ref, selector, text, replaceExisting = true } = {}) {
    const el = resolve({ ref, selector });
    if (!el) throw new Error('type needs ref or selector');
    const value = String(text == null ? '' : text);
    const label = labelText(el);
    try { el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
    el.focus();

    if (el.tagName === 'SELECT') {
      const options = [...el.options];
      const match =
        options.find((o) => o.value === value) ||
        options.find((o) => clip(o.textContent, 200) === value) ||
        options.find((o) => clip(o.textContent, 200).toLowerCase() === value.toLowerCase()) ||
        options.find((o) => clip(o.textContent, 200).toLowerCase().includes(value.toLowerCase()) && value);
      if (!match) throw new Error(`no option matches "${value}"`);
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, target: descriptor(el), message: `selected "${clip(match.textContent, 60)}"` };
    }

    if (el.isContentEditable) {
      el.focus();
      if (replaceExisting) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const ok = document.execCommand && document.execCommand('insertText', false, value);
      if (!ok) el.textContent = replaceExisting ? value : (el.textContent || '') + value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, target: descriptor(el), message: `typed ${value.length} characters` };
    }

    const current = el.value || '';
    const next = replaceExisting ? value : current + value;
    nativeSet(el, next);
    return { ok: true, target: descriptor(el), message: `typed ${value.length} characters${replaceExisting ? ' (replaced)' : ''}` };
  }

  /* ------------------------------------------------------------- press key */

  function pressKey({ key } = {}) {
    const raw = String(key || '').trim();
    if (!raw) throw new Error('key required');
    const parts = raw.split('+').filter(Boolean);
    const mods = { meta: false, ctrl: false, alt: false, shift: false };
    let k = parts.pop() || '';
    for (const p of parts) {
      const m = p.toLowerCase();
      if (m === 'meta' || m === 'cmd' || m === 'command') mods.meta = true;
      else if (m === 'ctrl' || m === 'control') mods.ctrl = true;
      else if (m === 'alt' || m === 'option') mods.alt = true;
      else if (m === 'shift') mods.shift = true;
    }
    if (k === 'Space') k = ' ';
    const target = document.activeElement || document.body;
    const init = { key: k === ' ' ? ' ' : k, bubbles: true, cancelable: true, ...mods };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (k.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return { ok: true, message: `pressed ${raw}` };
  }

  /* ----------------------------------------------------------------- scroll */

  function scroll({ direction = 'down', amount = 600 } = {}) {
    const n = Math.max(1, Math.min(Number(amount) || 600, 10000));
    const dx = direction === 'left' ? -n : direction === 'right' ? n : 0;
    const dy = direction === 'up' ? -n : direction === 'down' ? n : 0;
    window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return { ok: true, message: `scrolled ${direction} ${n}px`, scrollY: window.scrollY, scrollX: window.scrollX };
  }

  /* -------------------------------------------------------------------- api */

  async function act({ tool, args = {} } = {}) {
    switch (tool) {
      case 'browser_snapshot': return snapshot();
      case 'browser_get_html': return getHtml(args);
      case 'browser_click': return click(args);
      case 'browser_type': return type(args);
      case 'browser_press_key': return pressKey(args);
      case 'browser_scroll': return scroll(args);
      case 'browser_release': clearRefs(); return { ok: true, message: 'refs released' };
      default: throw new Error(`unsupported in-page tool "${tool}"`);
    }
  }

  window.__jpBrowser = { act, version: 1 };
})();
