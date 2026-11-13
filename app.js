/* Copycat Writer. An unofficial copy of Jason Fried's Write_On.
   If he ever releases it, go use his instead. It will be better.
   (c) Paretile. MIT License. No server, no tracking. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var editor = $('#editor'), dotsLayer = $('#dots'), paper = $('#paper');
  var LS = { docs: 'ccw.docs', cur: 'ccw.current', settings: 'ccw.settings', ws: 'ccw.workspace', hint: 'ccw.hintDismissed', seeded: 'ccw.sampleSeeded' };

  var state = {
    docId: null, alts: {}, dirty: false,
    level: 'word', selAlt: null, hoverAlt: null, target: null,
    savedRange: null, cuts: null, walk: null, flags: []
  };

  // ---------- utilities ----------
  function uid(p) { return (p || 'a') + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function store(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function settings() { return Object.assign({ base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '', dark: false }, load(LS.settings, {})); }

  // Text nodes inside the editor, in order, with global offsets.
  function textMap(skipGhosts) {
    var w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null), n, out = [], pos = 0;
    while ((n = w.nextNode())) {
      if (skipGhosts && n.parentNode.closest && n.parentNode.closest('.ghost')) { pos += n.data.length; out.push({ node: n, start: pos - n.data.length, end: pos, ghost: true }); continue; }
      out.push({ node: n, start: pos, end: pos + n.data.length });
      pos += n.data.length;
    }
    return out;
  }
  function fullText() { return editor.textContent; }
  function visibleText() {
    var c = editor.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.ghost'), function (g) { g.remove(); });
    return c.textContent;
  }
  function pointAt(map, off, preferEnd) {
    for (var i = 0; i < map.length; i++) {
      var m = map[i];
      if (off < m.end || (off === m.end && (preferEnd || i === map.length - 1))) return { node: m.node, offset: off - m.start };
    }
    if (!map.length) return { node: editor, offset: 0 };
    var last = map[map.length - 1]; return { node: last.node, offset: last.node.data.length };
  }
  function rangeFromOffsets(s, e) {
    var map = textMap(), r = document.createRange();
    var a = pointAt(map, s, false), b = pointAt(map, e, true);
    r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); return r;
  }
  function offsetOf(node, offset) {
    var r = document.createRange(); r.selectNodeContents(editor); r.setEnd(node, offset);
    return r.toString().length;
  }
  function selectionOffsets() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
    return { s: offsetOf(r.startContainer, r.startOffset), e: offsetOf(r.endContainer, r.endOffset), range: r };
  }
  function currentRange() {
    var sel = window.getSelection();
    if (sel.rangeCount) { var r = sel.getRangeAt(0); if (editor.contains(r.commonAncestorContainer)) return r; }
    if (state.savedRange && editor.contains(state.savedRange.commonAncestorContainer)) return state.savedRange;
    return null;
  }
  function restoreRange(r) { if (!r) return; var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  function placeCaret(node, off) { var r = document.createRange(); r.setStart(node, off); r.collapse(true); restoreRange(r); }

  // ---------- segments ----------
  function wordAt(text, i) {
    var re = /[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F'\u2019-]*/g, m;
    while ((m = re.exec(text))) { if (i >= m.index && i <= m.index + m[0].length) return { s: m.index, e: m.index + m[0].length }; if (m.index > i) break; }
    return null;
  }
  function paragraphAt(text, i) {
    var s = text.lastIndexOf('\n', i - 1) + 1, e = text.indexOf('\n', i); if (e < 0) e = text.length;
    while (s < e && /\s/.test(text[s])) s++; while (e > s && /\s/.test(text[e - 1])) e--;
    return e > s ? { s: s, e: e } : null;
  }
  function sentences(text) {
    var out = [], re = /[^.!?\n]+(?:[.!?]+["'\u201d\u2019)\]]*|$)/gm, m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      var s = m.index, e = m.index + m[0].length;
      while (s < e && /\s/.test(text[s])) s++; while (e > s && /\s/.test(text[e - 1])) e--;
      if (e > s && /[A-Za-z0-9]/.test(text.slice(s, e))) out.push({ s: s, e: e, text: text.slice(s, e) });
    }
    return out;
  }
  function sentenceAt(text, i) {
    var ss = sentences(text);
    for (var k = 0; k < ss.length; k++) if (i >= ss[k].s && i <= ss[k].e) return ss[k];
    return null;
  }
  function segmentAt(level, i) {
    var t = fullText();
    return level === 'word' ? wordAt(t, i) : level === 'sentence' ? sentenceAt(t, i) : paragraphAt(t, i);
  }
  function inferLevel(s, e) {
    var t = fullText(), str = t.slice(s, e).trim();
    if (!/\s/.test(str)) return 'word';
    var p = paragraphAt(t, s);
    if (p && p.s >= s - 1 && p.e <= e + 1) return 'paragraph';
    return 'sentence';
  }

  // ---------- alternates ----------
  function altSpan(id) { return editor.querySelector('.alt[data-id="' + id + '"]'); }
  function wrapOffsets(s, e, cls) {
    var r = rangeFromOffsets(s, e), span = document.createElement('span');
    span.className = cls;
    if (r.startContainer === r.endContainer && r.startContainer.nodeType === 3) r.surroundContents(span);
    else { span.appendChild(r.extractContents()); r.insertNode(span); }
    return span;
  }
  function createAlt(s, e, level) {
    var t = fullText();
    while (s < e && /\s/.test(t[s])) s++; while (e > s && /\s/.test(t[e - 1])) e--;
    if (e <= s) return null;
    // already an alternate exactly here (or caret inside one of that level)?
    var r = rangeFromOffsets(s, e), anc = r.commonAncestorContainer;
    var existing = (anc.nodeType === 3 ? anc.parentNode : anc).closest('.alt');
    if (existing && existing.textContent.trim() === t.slice(s, e)) return existing.dataset.id;
    var span = wrapOffsets(s, e, 'alt'), id = uid('a');
    span.dataset.id = id;
    state.alts[id] = { level: level, versions: [{ text: span.textContent, ai: false }], active: 0 };
    markDirty(); return id;
  }
  function articleFor(word) {
    var w = word.toLowerCase();
    if (/^(hour|honest|honou?r|heir)/.test(w)) return 'an';
    if (/^(uni|use|usu|uti|ura|ure|uro|eu|ewe|one|once|ufo|u\b)/.test(w)) return 'a';
    if (/^[aeiou]/.test(w)) return 'an';
    if (/^[fhlmnrsx]$/.test(w) || /^(fbi|mba|mri|nba|sql|html|x-?ray)/.test(w)) return 'an';
    return 'a';
  }
  function fixArticle(span) {
    var first = (span.textContent.match(/^\s*([A-Za-z][\w'-]*)/) || [])[1];
    if (!first) return;
    var map = textMap(), startOff = offsetOf(span, 0);
    var before = fullText().slice(Math.max(0, startOff - 12), startOff);
    var m = before.match(/(^|[^A-Za-z])(a|an)(\s+)$/i);
    if (!m) return;
    var want = articleFor(first), cur = m[2];
    if (cur.toLowerCase() === want) return;
    var repl = want;
    if (cur[0] === cur[0].toUpperCase()) repl = want[0].toUpperCase() + want.slice(1);
    var aStart = startOff - m[3].length - cur.length;
    var p = pointAt(map, aStart, false);
    if (p.node.data.slice(p.offset, p.offset + cur.length) === cur) {
      p.node.data = p.node.data.slice(0, p.offset) + repl + p.node.data.slice(p.offset + cur.length);
    }
  }
  function setVersion(id, idx) {
    var a = state.alts[id], span = altSpan(id); if (!a || !span) return;
    syncAlt(id);
    a.active = (idx + a.versions.length) % a.versions.length;
    var v = a.versions[a.active];
    if (v.html) span.innerHTML = sanitize(v.html); else span.textContent = v.text;
    fixArticle(span);
    markDirty(); refresh();
    if (state.selAlt === id) renderSidebar();
  }
  function cycle(id, dir) { var a = state.alts[id]; if (a) setVersion(id, a.active + dir); }
  function syncAlt(id) {
    var a = state.alts[id], span = altSpan(id); if (!a || !span) return;
    var v = a.versions[a.active]; v.text = span.textContent;
    // keep nested alternates/ghosts inside this version so switching back restores them
    if (span.querySelector('span')) v.html = span.innerHTML.replace(/ (hover|sel)(?=["\s])/g, ''); else delete v.html;
  }
  function nestedIds() {
    var keep = {};
    Object.keys(state.alts).forEach(function (id) {
      state.alts[id].versions.forEach(function (v) { (v.html || '').replace(/data-id="([^"]+)"/g, function (_, k) { keep[k] = 1; }); });
    });
    return keep;
  }
  function addVersion(id, text, ai) {
    var a = state.alts[id]; text = (text || '').replace(/\s+$/, ''); if (!a || !text.trim()) return;
    if (a.versions.some(function (v) { return v.text === text; })) return;
    a.versions.push({ text: text, ai: !!ai }); markDirty(); refresh(); renderSidebar();
  }
  function deleteVersion(id, idx) {
    var a = state.alts[id], span = altSpan(id); if (!a) return;
    syncAlt(id);
    a.versions.splice(idx, 1);
    if (a.active >= idx && a.active > 0) a.active--;
    var cur = a.versions[a.active];
    if (span && cur) { if (cur.html) span.innerHTML = sanitize(cur.html); else span.textContent = cur.text; fixArticle(span); }
    if (a.versions.length <= 1) unwrapAlt(id);
    markDirty(); refresh(); renderSidebar();
  }
  function unwrapAlt(id) {
    var span = altSpan(id); delete state.alts[id];
    if (span) { var p = span.parentNode; while (span.firstChild) p.insertBefore(span.firstChild, span); span.remove(); p.normalize(); }
    if (state.selAlt === id) { state.selAlt = null; }
  }
  function pruneAlts() {
    Object.keys(state.alts).forEach(function (id) { if (altSpan(id)) syncAlt(id); });
    var keep = nestedIds();
    Object.keys(state.alts).forEach(function (id) {
      var span = altSpan(id);
      if (!span && keep[id]) return; // parked inside another alternate's inactive version
      if (!span || !span.textContent.trim()) { if (span) span.remove(); delete state.alts[id]; if (state.selAlt === id) state.selAlt = null; }
      else syncAlt(id);
    });
    // orphan spans (e.g. duplicated by the browser while editing)
    $$('#editor .alt').forEach(function (s) {
      if (!state.alts[s.dataset.id] || altSpan(s.dataset.id) !== s) { var p = s.parentNode; while (s.firstChild) p.insertBefore(s.firstChild, s); s.remove(); }
    });
  }

  // Selecting a target for the sidebar.
  function setTargetFromCaret(levelOverride) {
    var so = selectionOffsets(); if (!so) return;
    var node = so.range.startContainer, el = node.nodeType === 3 ? node.parentNode : node;
    var altEl = el.closest && el.closest('.alt');
    if (so.s === so.e && altEl && !levelOverride) {
      state.selAlt = altEl.dataset.id; state.target = null;
      state.level = state.alts[state.selAlt].level;
    } else if (so.s !== so.e) {
      state.selAlt = null; state.level = levelOverride || inferLevel(so.s, so.e);
      state.target = { s: so.s, e: so.e };
    } else {
      state.selAlt = null; if (levelOverride) state.level = levelOverride;
      state.target = segmentAt(state.level, so.s);
      if (state.target) { var t = fullText(); var hit = altContaining(state.target.s, state.target.e); if (hit) { state.selAlt = hit; state.target = null; } }
    }
    renderSidebar(); refresh();
  }
  function altContaining(s, e) {
    var found = null;
    Object.keys(state.alts).forEach(function (id) {
      var sp = altSpan(id); if (!sp) return;
      var a = offsetOf(sp, 0), b = a + sp.textContent.length, txt = fullText();
      while (a < b && /\s/.test(txt[a])) a++; while (b > a && /\s/.test(txt[b - 1])) b--;
      if (a === s && b === e) found = id;
    });
    return found;
  }
  function ensureTargetAlt() {
    if (state.selAlt && state.alts[state.selAlt]) return state.selAlt;
    if (!state.target) return null;
    var id = createAlt(state.target.s, state.target.e, state.level);
    state.selAlt = id; state.target = null; return id;
  }
  function renderSidebar() {
    $$('.tab').forEach(function (t) { t.classList.toggle('on', t.dataset.level === state.level); });
    var para = state.level === 'paragraph';
    $('#alt-input').hidden = para; $('#alt-textarea').hidden = !para;
    var list = $('#alt-list'), tgt = $('#alt-target'), html = '';
    var a = state.selAlt && state.alts[state.selAlt];
    if (a) {
      tgt.textContent = a.versions.length + ' version' + (a.versions.length === 1 ? '' : 's') + ' of this ' + a.level + '. Hover the text and press ↑/↓.';
      a.versions.forEach(function (v, i) {
        html += '<li data-i="' + i + '" class="' + (i === a.active ? 'on' : '') + '" title="Use this version">' +
          '<span class="mark">' + (v.ai ? '<svg><use href="#i-spark"/></svg>' : '•') + '</span>' +
          '<span class="txt">' + esc(v.text) + '</span>' +
          '<button class="del" data-del="' + i + '" title="Delete this version" aria-label="Delete version">×</button></li>';
      });
    } else if (state.target) {
      var t = fullText().slice(state.target.s, state.target.e);
      tgt.textContent = 'This ' + state.level + ': “' + (t.length > 90 ? t.slice(0, 90) + '…' : t) + '”';
      html = '<li class="empty">No alternates yet. Add one below.</li>';
    } else {
      tgt.textContent = 'Click a ' + state.level + ' in your text, or select some.';
    }
    list.innerHTML = html;
  }

  // ---------- dots + hover ----------
  function renderDots() {
    var base = paper.getBoundingClientRect(), html = '';
    Object.keys(state.alts).forEach(function (id) {
      var sp = altSpan(id), a = state.alts[id]; if (!sp || a.versions.length < 2) return;
      sp.classList.toggle('sel', state.selAlt === id);
      var rects = sp.getClientRects(); if (!rects.length) return;
      var r = rects[rects.length - 1];
      html += '<div class="dots" data-id="' + id + '" style="left:' + (r.right - base.left) + 'px;top:' + (r.bottom - base.top + 1) + 'px">';
      a.versions.forEach(function (v, i) { html += '<i class="' + (i === a.active ? 'on' : '') + '" data-i="' + i + '" title="Version ' + (i + 1) + '"></i>'; });
      html += '</div>';
    });
    $$('#editor .alt').forEach(function (sp) { sp.classList.toggle('sel', state.selAlt === sp.dataset.id); });
    dotsLayer.innerHTML = html;
  }
  dotsLayer.addEventListener('mousedown', function (e) {
    var i = e.target.closest('i'), d = e.target.closest('.dots');
    if (i && d) { e.preventDefault(); setVersion(d.dataset.id, +i.dataset.i); }
  });
  editor.addEventListener('mouseover', function (e) {
    var a = e.target.closest && e.target.closest('.alt');
    $$('#editor .alt.hover').forEach(function (x) { if (x !== a) x.classList.remove('hover'); });
    state.hoverAlt = a ? a.dataset.id : null; if (a) a.classList.add('hover');
  });
  editor.addEventListener('mouseleave', function () { state.hoverAlt = null; $$('#editor .alt.hover').forEach(function (x) { x.classList.remove('hover'); }); });

  // ---------- counts ----------
  function updateCount() {
    var t = visibleText(), words = (t.match(/[A-Za-z0-9\u00C0-\u024F'\u2019]+(?:[-][A-Za-z0-9]+)*/g) || []).length;
    $('#count').textContent = words + ' word' + (words === 1 ? '' : 's') + ' · ' + t.length + ' chars';
  }
  function refresh() { updateCount(); renderDots(); if (state.flags.length) paintFlags(); }

  // ---------- ghosts ----------
  function ghostToggle() {
    var r = currentRange(); if (!r) return;
    var el = r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
    var g = el.closest('.ghost');
    var inner = [];
    if (!r.collapsed) { var frag = r.cloneContents(); if (frag.querySelector && frag.querySelector('.ghost')) inner = $$('#editor .ghost').filter(function (x) { return r.intersectsNode(x); }); }
    if (g || inner.length) { (g ? [g] : []).concat(inner).forEach(unwrap); toast('Revived.', [], 1400); }
    else if (!r.collapsed) {
      var so = { s: offsetOf(r.startContainer, r.startOffset), e: offsetOf(r.endContainer, r.endOffset) };
      wrapGhost(so.s, so.e, 'ghost');
    } else return;
    markDirty(); refresh();
  }
  function wrapGhost(s, e, cls) {
    var r = rangeFromOffsets(s, e), span = document.createElement('span'); span.className = cls;
    if (r.startContainer === r.endContainer && r.startContainer.nodeType === 3) { r.surroundContents(span); return span; }
    span.appendChild(r.extractContents()); r.insertNode(span);
    $$('#editor .alt').forEach(function (x) { if (!x.textContent) x.remove(); });
    return span;
  }
  function unwrap(el) { if (!el.parentNode) return; var p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); el.remove(); p.normalize(); }

  // ---------- stash ----------
  function stash() {
    var r = currentRange(); if (!r || r.collapsed) { toast('Select something to stash.', [], 1600); return; }
    var txt = r.toString();
    r.deleteContents(); pruneAlts();
    var ov = $('#overflow-text');
    ov.value = ov.value ? ov.value.replace(/\s*$/, '') + '\n\n' + txt.trim() : txt.trim();
    showOverflow(true); markDirty(); refresh();
    toast('Stashed in Overflow.', [], 1400);
  }
  function showOverflow(on) {
    $('#overflow').hidden = !on; document.body.classList.toggle('ov', on);
    $('#btn-overflow').classList.toggle('on', on); setTimeout(renderDots, 0);
  }
  // Drag from the Overflow into the editor moves text; drop into the editor is always plain text.
  var ovDrag = null;
  $('#overflow-text').addEventListener('dragstart', function (e) { var t = e.target; ovDrag = { s: t.selectionStart, e: t.selectionEnd }; });
  $('#overflow-text').addEventListener('dragend', function () { ovDrag = null; });
  editor.addEventListener('drop', function (e) {
    var txt = e.dataTransfer.getData('text/plain'); if (!txt) return;
    if (!ovDrag) return; // editor-internal drags: let the browser move plain text
    e.preventDefault();
    var pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if (pos && editor.contains(pos.startContainer)) restoreRange(pos);
    document.execCommand('insertText', false, txt);
    var ov = $('#overflow-text'); ov.value = ov.value.slice(0, ovDrag.s) + ov.value.slice(ovDrag.e); ovDrag = null;
    markDirty(); refresh();
  });
  editor.addEventListener('paste', function (e) {
    var txt = e.clipboardData && e.clipboardData.getData('text/plain'); if (txt == null) return;
    e.preventDefault(); document.execCommand('insertText', false, txt);
  });

  // ---------- documents ----------
  function allDocs() { return load(LS.docs, []); }
  function titleOf(text) { var l = (text || '').trim().split('\n')[0] || 'Untitled'; return l.length > 48 ? l.slice(0, 48) + '…' : l; }
  function cleanHTML() {
    var c = editor.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.cut'), function (x) { x.classList.remove('cut', 'focus'); });
    Array.prototype.forEach.call(c.querySelectorAll('.alt'), function (x) { x.className = 'alt'; });
    return c.innerHTML;
  }
  function save(silent) {
    pruneAlts();
    var docs = allDocs(), id = state.docId || uid('d');
    state.docId = id;
    var doc = { id: id, title: titleOf(fullText()), html: cleanHTML(), alts: state.alts, overflow: $('#overflow-text').value, updated: Date.now() };
    var i = docs.findIndex(function (d) { return d.id === id; });
    if (i >= 0) docs[i] = doc; else docs.unshift(doc);
    store(LS.docs, docs); localStorage.setItem(LS.cur, id);
    state.dirty = false; setSaveState('saved');
    if (!silent) toast('Saved in this browser.', [], 1200);
  }
  function sanitize(html) {
    var t = document.createElement('template'); t.innerHTML = html || '';
    Array.prototype.forEach.call(t.content.querySelectorAll('*'), function (el) {
      if (el.tagName !== 'SPAN') { el.replaceWith(document.createTextNode(el.textContent)); return; }
      Array.prototype.slice.call(el.attributes).forEach(function (at) { if (at.name !== 'class' && at.name !== 'data-id') el.removeAttribute(at.name); });
    });
    return t.innerHTML;
  }
  function openDoc(id) {
    var d = allDocs().find(function (x) { return x.id === id; });
    endTrim(true); clearFlags();
    if (!d) { state.docId = null; editor.innerHTML = ''; state.alts = {}; $('#overflow-text').value = ''; }
    else { state.docId = d.id; editor.innerHTML = sanitize(d.html); state.alts = d.alts || {}; $('#overflow-text').value = d.overflow || ''; }
    localStorage.setItem(LS.cur, state.docId || '');
    state.selAlt = null; state.target = null; state.dirty = false; setSaveState('saved');
    pruneAlts(); renderSidebar(); refresh();
  }
  function newDoc() { if (state.dirty || fullText().trim()) save(true); openDoc(null); state.docId = uid('d'); editor.focus(); toast('New document.', [], 1000); }
  function renderDocs() {
    var docs = allDocs(), html = '<div class="pop-h">Documents</div>';
    if (!docs.length) html += '<div class="pop-foot">Nothing saved yet.</div>';
    docs.sort(function (a, b) { return b.updated - a.updated; }).forEach(function (d) {
      html += '<div class="doc-row' + (d.id === state.docId ? ' cur' : '') + '"><button class="open" data-open="' + d.id + '">' + esc(d.title) + '</button><button class="del" data-deldoc="' + d.id + '" title="Delete document">×</button></div>';
    });
    $('#docs-pop').innerHTML = html;
  }
  function markDirty() { state.dirty = true; setSaveState('dirty'); scheduleAutosave(); }
  var autoT = null;
  function scheduleAutosave() { clearTimeout(autoT); autoT = setTimeout(function () { if (state.dirty && !state.walk) save(true); }, 4000); }
  function setSaveState(s) { var el = $('#savestate'); el.textContent = s === 'dirty' ? 'unsaved' : 'saved'; el.classList.toggle('dirty', s === 'dirty'); }

  // ---------- post to X ----------
  function xIntentURL(text) { return 'https://x.com/intent/post?text=' + encodeURIComponent(text); }
  function postToX() {
    var t = visibleText().replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1').replace(/[ \t]+\n/g, '\n').trim();
    if (!t) { toast('Nothing to post yet.', [], 1400); return; }
    if (t.length > 280) toast('Heads up: ' + t.length + ' characters. X may ask you to trim.', [], 2600);
    window.open(xIntentURL(t), '_blank', 'noopener');
  }

  // ---------- toast ----------
  var toastT = null;
  function toast(msg, buttons, ms) {
    var el = $('#toast'); clearTimeout(toastT);
    el.innerHTML = '<span class="msg">' + msg + '</span>';
    (buttons || []).forEach(function (b) {
      var bt = document.createElement('button'); bt.textContent = b.label; if (b.primary) bt.className = 'primary';
      if (b.id) bt.id = b.id;
      bt.addEventListener('mousedown', function (e) { e.preventDefault(); });
      bt.addEventListener('click', b.fn); el.appendChild(bt);
    });
    el.hidden = false;
    if (ms) toastT = setTimeout(function () { el.hidden = true; }, ms);
  }
  function hideToast() { $('#toast').hidden = true; }

  // ---------- AI (bring your own key) ----------
  function hasKey() { return !!settings().key; }
  function ai(system, user) {
    var s = settings();
    return fetch(s.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.key },
      body: JSON.stringify({ model: s.model, temperature: 0.7, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
        var m = c.match(/\{[\s\S]*\}/); if (!m) throw new Error('No JSON in reply');
        return JSON.parse(m[0]);
      });
  }
  function needKey(what) {
    toast(what + ' needs your own AI key. It stays in this browser.', [{ label: 'Add a key', primary: true, fn: function () { hideToast(); openSettings(); } }, { label: 'Not now', fn: hideToast }]);
  }
  function aiAlternatives() {
    var r = currentRange();
    if (r && !r.collapsed) { restoreRange(r); setTargetFromCaret(); }
    else if (!state.selAlt && !state.target) setTargetFromCaret();
    var id = ensureTargetAlt();
    if (!id) { toast('Select some text first.', [], 1600); return; }
    openWorkspace(true); state.selAlt = id; renderSidebar(); refresh();
    if (!hasKey()) { needKey('AI Alternatives'); return; }
    var a = state.alts[id], ctx = fullText();
    toast('Asking for alternatives…');
    ai('You are a careful writing assistant. Reply only with JSON: {"alternatives":["..."]}. Give 4 distinct alternatives for the given ' + a.level + ' that fit the surrounding text. Keep the meaning. No quotes around items, no numbering.',
      'Surrounding text:\n' + ctx.slice(0, 6000) + '\n\nThe ' + a.level + ' to rewrite:\n' + a.versions[a.active].text)
      .then(function (j) {
        (j.alternatives || []).forEach(function (t) { if (typeof t === 'string') addVersion(id, t.trim(), true); });
        toast('Added AI alternatives. Hover and press ↑/↓ to try them.', [], 2400);
      }).catch(function (err) { toast('AI request failed (' + esc(err.message) + '). Check the settings.', [], 4000); });
  }

  // ---------- the lab: scans ----------
  var HEDGES = /\b(i think|i believe|i feel|kind of|sort of|a bit|a little|somewhat|perhaps|maybe|probably|basically|actually|really|very|just|quite|rather|pretty much|in my opinion|it seems)\b/gi;
  function weakReason(s) {
    var t = s.toLowerCase(), r = [];
    if (/\b(is|are|was|were|be|been|being)\s+(\w+ly\s+)?\w+(ed|en)\b/.test(t)) r.push('passive voice');
    if (/^(there|it)\s+(is|are|was|were)\b/.test(t)) r.push('slow opener');
    var h = (s.match(HEDGES) || []).length; if (h >= 2) r.push('hedging');
    if (/\b(thing|things|stuff|nice|good|bad|a lot)\b/.test(t)) r.push('vague words');
    return r;
  }
  function convolutedReason(s) {
    var words = s.split(/\s+/).length, commas = (s.match(/[,;:\u2014()]/g) || []).length, r = [];
    if (words > 30) r.push(words + ' words');
    if (commas >= 4) r.push(commas + ' clauses');
    if ((s.match(/\b(which|that|who|whom|whereas|although|because)\b/gi) || []).length >= 3) r.push('stacked clauses');
    return r;
  }
  function clearFlags() { state.flags = []; if (window.CSS && CSS.highlights) { CSS.highlights.delete('cc-weak'); CSS.highlights.delete('cc-conv'); } }
  function paintFlags() {
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    var weak = [], conv = [], t = fullText();
    state.flags = state.flags.filter(function (f) { return t.indexOf(f.text) >= 0; });
    state.flags.forEach(function (f) {
      var i = t.indexOf(f.text); var r = rangeFromOffsets(i, i + f.text.length);
      (f.kind === 'weak' ? weak : conv).push(r);
    });
    CSS.highlights.set('cc-weak', new Highlight(...weak)); CSS.highlights.set('cc-conv', new Highlight(...conv));
  }
  function scan(kind) {
    var t = fullText(); if (!t.trim()) { toast('Write something first.', [], 1400); return; }
    var finish = function (flags, how) {
      state.flags = state.flags.filter(function (f) { return f.kind !== kind; }).concat(flags);
      paintFlags();
      var n = flags.length;
      toast(n ? 'Marked ' + n + ' ' + (kind === 'weak' ? 'weak' : 'convoluted') + ' sentence' + (n === 1 ? '' : 's') + ' (' + how + '). ' + esc(flags.slice(0, 2).map(function (f) { return f.why; }).join('; ')) : 'Nothing ' + (kind === 'weak' ? 'weak' : 'convoluted') + ' found (' + how + ').',
        [{ label: 'Clear marks', fn: function () { clearFlags(); hideToast(); } }, { label: 'Done', fn: hideToast }]);
    };
    var heuristic = function () {
      return sentences(visibleText()).map(function (s) {
        var r = kind === 'weak' ? weakReason(s.text) : convolutedReason(s.text);
        return r.length ? { text: s.text, kind: kind, why: r.join(', ') } : null;
      }).filter(Boolean);
    };
    if (!hasKey()) { finish(heuristic(), 'quick scan, no AI key'); return; }
    toast('Scanning…');
    ai('You are an exacting editor. Reply only with JSON: {"flags":[{"text":"exact sentence copied verbatim","why":"short reason"}]}. Flag only ' + (kind === 'weak' ? 'weak sentences: vague, hedged, passive, or flat.' : 'convoluted sentences: overlong, tangled, hard to follow.'), visibleText().slice(0, 12000))
      .then(function (j) {
        var t2 = fullText();
        finish((j.flags || []).filter(function (f) { return f && f.text && t2.indexOf(f.text) >= 0; }).map(function (f) { return { text: f.text, kind: kind, why: f.why || '' }; }), 'AI');
      }).catch(function (err) { finish(heuristic(), 'AI failed: ' + err.message + '; quick scan'); });
  }

  // ---------- the lab: trims ----------
  var TRIMS = {
    slight: { label: 'Slight trim', pct: 10, pats: [/\b(very|really|just|actually|basically|literally|totally|simply|quite|truly|definitely|certainly)\s+(?!put\b)/gi] },
    tighten: { label: 'Tighten some', pct: 20, pats: [/\b(I think|I believe|I feel like|kind of|sort of|a bit|a little bit|pretty much|in my opinion|it seems that|needless to say|of course|at the end of the day|for what it's worth)\s*,?\s+/gi, /\bin order (?=to\b)/gi, /\b(that is|which is|who are|which are)\s+(?=\w+ly\b|\w+ed\b)/gi, /\b(completely|absolutely|extremely|incredibly|highly|fairly|rather|somewhat)\s+/gi] },
    sharper: { label: 'Even sharper', pct: 35, pats: [/\s*\([^)]{1,120}\)/g, /,\s*(of course|however|in fact|as you know|to be honest|frankly|honestly),?/gi, /\b(\w+ly)\s+(?=\w)/g, /\b(the fact that|due to the fact that|it is important to note that|it should be noted that|what this means is that)\s*/gi] },
    half: { label: 'Cut in half', pct: 50, pats: [] }
  };
  var ORDER = ['slight', 'tighten', 'sharper', 'half'];
  var KEEP_LY = /^(only|early|daily|family|reply|apply|supply|holy|fly|july|italy|lonely|ugly|likely|friendly|rely|ally|belly|bully|jelly|rally|silly|hilly|curly|reply|imply|comply|multiply|oily|lovely)$/i;
  function heuristicCuts(level) {
    var t = fullText(), map = textMap(true), cuts = [];
    var ghostAt = function (i) { for (var k = 0; k < map.length; k++) if (i >= map[k].start && i < map[k].end) return !!map[k].ghost; return false; };
    var upto = ORDER.indexOf(level === 'half' ? 'sharper' : level);
    for (var L = 0; L <= upto; L++) TRIMS[ORDER[L]].pats.forEach(function (re) {
      re.lastIndex = 0; var m;
      while ((m = re.exec(t))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        if (/ly\s*$/.test(m[0]) && m[1] && KEEP_LY.test(m[1])) continue;
        cuts.push({ s: m.index, e: m.index + m[0].length });
      }
    });
    if (level === 'half') {
      var vis = visibleText(), totalWords = (vis.match(/\S+/g) || []).length, goal = totalWords / 2;
      var cutWords = cuts.reduce(function (n, c) { return n + (t.slice(c.s, c.e).match(/\S+/g) || []).length; }, 0);
      var ss = sentences(t), firsts = {};
      ss.forEach(function (s) { var p = paragraphAt(t, s.s); var k = p ? p.s : -1; if (!(k in firsts)) firsts[k] = s.s; });
      var cands = ss.filter(function (s) { var p = paragraphAt(t, s.s); return firsts[p ? p.s : -1] !== s.s; })
        .map(function (s) { return { s: s.s, e: s.e, score: weakReason(s.text).length * 3 + convolutedReason(s.text).length * 2 + (s.text.match(HEDGES) || []).length, words: (s.text.match(/\S+/g) || []).length }; })
        .sort(function (a, b) { return b.score - a.score || b.s - a.s; });
      for (var i = 0; i < cands.length && cutWords < goal; i++) {
        var c = cands[i], e = c.e; while (e < t.length && t[e] === ' ') e++;
        cuts = cuts.filter(function (x) { return x.e <= c.s || x.s >= e; });
        cuts.push({ s: c.s, e: e }); cutWords += c.words;
      }
    }
    cuts = cuts.filter(function (c) { return !ghostAt(c.s); }).sort(function (a, b) { return a.s - b.s; });
    var out = [];
    cuts.forEach(function (c) { if (!out.length || c.s >= out[out.length - 1].e) out.push(c); });
    return out;
  }
  function applyCuts(cuts) {
    var made = [];
    cuts.slice().sort(function (a, b) { return b.s - a.s; }).forEach(function (c) {
      var r = rangeFromOffsets(c.s, c.e);
      if (r.startContainer !== r.endContainer || r.startContainer.nodeType !== 3) return; // skip cuts crossing alternates
      var sp = document.createElement('span'); sp.className = 'ghost cut'; sp.dataset.cut = '1';
      r.surroundContents(sp); made.unshift(sp);
    });
    return made;
  }
  function trim(level) {
    var t = fullText(); if (!t.trim()) { toast('Write something first.', [], 1400); return; }
    endTrim(false); clearFlags();
    var go = function (cuts, how) {
      var made = applyCuts(cuts);
      state.cuts = made; refresh();
      if (!made.length) { toast(TRIMS[level].label + ': nothing to cut (' + how + '). Nice.', [{ label: 'Done', fn: hideToast }]); return; }
      var words = made.reduce(function (n, s) { return n + (s.textContent.match(/\S+/g) || []).length; }, 0);
      toast(TRIMS[level].label + ': ' + made.length + ' suggested cut' + (made.length === 1 ? '' : 's') + ', ' + words + ' words ghosted (' + how + ').', [
        { label: 'Make the cuts', primary: true, id: 'trim-make', fn: makeCuts },
        { label: 'Walk through', id: 'trim-walk', fn: walkStart },
        { label: 'Done', id: 'trim-done', fn: function () { endTrim(false); hideToast(); } }
      ]);
      markDirty();
    };
    if (!hasKey()) { go(heuristicCuts(level), 'quick trim, no AI key'); return; }
    toast(TRIMS[level].label + '…');
    ai('You are a ruthless but faithful editor. Reply only with JSON: {"cuts":["exact substring"]}. Each cut is a contiguous substring copied verbatim from the text that can be deleted while the text still reads correctly. Together the cuts should shorten the text by about ' + TRIMS[level].pct + '%. Prefer filler, hedges, redundancy' + (level === 'half' ? ', then whole sentences that add the least' : '') + '. Include a trailing space in a cut when needed so spacing stays right.', visibleText().slice(0, 12000))
      .then(function (j) {
        var cuts = [], from = {};
        (j.cuts || []).forEach(function (s) {
          if (typeof s !== 'string' || !s) return;
          var i = t.indexOf(s, from[s] || 0); if (i < 0) return; from[s] = i + s.length; cuts.push({ s: i, e: i + s.length });
        });
        cuts.sort(function (a, b) { return a.s - b.s; });
        var out = []; cuts.forEach(function (c) { if (!out.length || c.s >= out[out.length - 1].e) out.push(c); });
        go(out, 'AI');
      }).catch(function (err) { go(heuristicCuts(level), 'AI failed: ' + err.message + '; quick trim'); });
  }
  function removeCut(sp) {
    var prev = sp.previousSibling, next = sp.nextSibling, p = sp.parentNode;
    sp.remove();
    if (prev && prev.nodeType === 3 && next && next.nodeType === 3) {
      var a = prev.data, b = next.data;
      if (/ $/.test(a) && /^[ ,.;:!?]/.test(b)) a = a.replace(/ +$/, '');
      if ((/(^|[.!?]\s+|\n\s*)$/.test(a)) && /^[a-z]/.test(b)) b = b[0].toUpperCase() + b.slice(1);
      if (/(^|\n)$/.test(a)) b = b.replace(/^ +/, '');
      prev.data = a; next.data = b;
    } else if (next && next.nodeType === 3 && (!prev || /\n$/.test(prev.textContent || ''))) {
      next.data = next.data.replace(/^ +/, ''); if (/^[a-z]/.test(next.data)) next.data = next.data[0].toUpperCase() + next.data.slice(1);
    }
    p.normalize();
  }
  function makeCuts() {
    var n = 0; (state.cuts || []).forEach(function (sp) { if (sp.isConnected) { removeCut(sp); n++; } });
    state.cuts = null; state.walk = null; pruneAlts(); markDirty(); refresh();
    toast('Made ' + n + ' cut' + (n === 1 ? '' : 's') + '.', [], 1800);
  }
  function endTrim(revive) {
    // Done: keep the suggestions as ordinary ghosts so you can revive any of them later.
    (state.cuts || []).forEach(function (sp) { if (!sp.isConnected) return; if (revive) unwrap(sp); else { sp.classList.remove('cut', 'focus'); delete sp.dataset.cut; } });
    state.cuts = null; state.walk = null;
  }
  function walkStart() { state.walk = { cut: 0, kept: 0 }; walkNext(); }
  function walkNext() {
    var w = state.walk; if (!w) return;
    $$('#editor .cut.focus').forEach(function (x) { x.classList.remove('focus'); });
    // cut/skip remove the current suggestion from the list, so always take the first remaining
    var list = (state.cuts || []).filter(function (s) { return s.isConnected && s.classList.contains('cut'); });
    state.cuts = list;
    if (!list.length) {
      state.cuts = null; state.walk = null; markDirty(); refresh();
      toast('Walked through: ' + w.cut + ' cut, ' + w.kept + ' kept.', [{ label: 'Done', fn: hideToast }], 3000); return;
    }
    var sp = list[0]; sp.classList.add('focus'); sp.scrollIntoView({ block: 'center', behavior: 'smooth' });
    var total = w.cut + w.kept + list.length;
    var txt = sp.textContent.trim(); if (txt.length > 70) txt = txt.slice(0, 70) + '…';
    toast('Cut ' + (w.cut + w.kept + 1) + ' of ' + total + ': <q>' + esc(txt) + '</q>', [
      { label: 'Cut it', primary: true, id: 'walk-accept', fn: function () { removeCut(sp); w.cut++; refresh(); walkNext(); } },
      { label: 'Skip', id: 'walk-skip', fn: function () { unwrap(sp); w.kept++; refresh(); walkNext(); } },
      { label: 'Stop', id: 'walk-stop', fn: function () { endTrim(true); hideToast(); refresh(); } }
    ]);
  }

  // ---------- workspace, menus, settings ----------
  function openWorkspace(on) {
    document.body.classList.toggle('ws', on);
    localStorage.setItem(LS.ws, on ? '1' : '0');
    if (!on) { closePops(); showOverflow(false); }
    setTimeout(renderDots, 0);
  }
  function closePops() { $('#lab-menu').hidden = true; $('#docs-pop').hidden = true; $('#ctx').hidden = true; }
  function openSettings() {
    var s = settings(); $('#s-base').value = s.base; $('#s-model').value = s.model; $('#s-key').value = s.key; $('#s-dark').checked = !!s.dark;
    $('#settings').hidden = false; $('#s-base').focus();
  }
  function applyTheme() { document.body.classList.toggle('dark', !!settings().dark); }
  function labMode() { $('#lab-mode').textContent = hasKey() ? 'AI: ' + settings().model + '. Your key, your bill.' : 'No AI key set: quick built-in scans and trims. Add a key in settings for AI.'; }

  $('#count').addEventListener('click', function () { openWorkspace(!document.body.classList.contains('ws')); });
  $('#btn-save').addEventListener('click', function () { save(false); });
  $('#btn-overflow').addEventListener('click', function () { showOverflow($('#overflow').hidden); });
  $('#btn-x').addEventListener('click', postToX);
  $('#btn-linkedin').addEventListener('click', function () {
    var b = this; b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
    setTimeout(function () { b.classList.remove('shake'); }, 500);
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-new').addEventListener('click', newDoc);
  $('#btn-docs').addEventListener('click', function (e) { e.stopPropagation(); var p = $('#docs-pop'); var h = p.hidden; closePops(); if (h) { renderDocs(); p.hidden = false; } });
  $('#docs-pop').addEventListener('click', function (e) {
    e.stopPropagation();
    var o = e.target.closest('[data-open]'), d = e.target.closest('[data-deldoc]');
    if (o) { if (state.dirty) save(true); openDoc(o.dataset.open); closePops(); }
    if (d) {
      if (!confirm('Delete this document? This cannot be undone.')) return;
      store(LS.docs, allDocs().filter(function (x) { return x.id !== d.dataset.deldoc; }));
      if (d.dataset.deldoc === state.docId) openDoc((allDocs()[0] || {}).id || null);
      renderDocs();
    }
  });
  $('#btn-lab').addEventListener('click', function (e) { e.stopPropagation(); var m = $('#lab-menu'), h = m.hidden; closePops(); if (h) { labMode(); m.hidden = false; } });
  $('#lab-menu').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('#lab-menu').addEventListener('click', function (e) {
    e.stopPropagation(); var b = e.target.closest('[data-lab]'); if (!b) return; closePops();
    var k = b.dataset.lab;
    if (k === 'scan-weak') scan('weak'); else if (k === 'scan-convoluted') scan('convoluted'); else if (k === 'scan-clear') { clearFlags(); toast('Marks cleared.', [], 1000); }
    else trim(k.replace('trim-', ''));
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.pop')) closePops(); });

  // Tabs and sidebar
  $$('.tab').forEach(function (t) {
    t.addEventListener('mousedown', function (e) { e.preventDefault(); });
    t.addEventListener('click', function () {
      state.level = t.dataset.level;
      var r = currentRange();
      if (r) { restoreRange(r); setTargetFromCaret(state.level); } else renderSidebar();
    });
  });
  $('#alt-list').addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]'), li = e.target.closest('li[data-i]');
    if (del) { e.stopPropagation(); deleteVersion(state.selAlt, +del.dataset.del); return; }
    if (li && state.selAlt) setVersion(state.selAlt, +li.dataset.i);
  });
  function submitVersion(el) {
    var v = el.value; if (!v.trim()) return;
    var id = ensureTargetAlt();
    if (!id) { toast('Click a ' + state.level + ' in your text first.', [], 1600); return; }
    addVersion(id, v, false); el.value = '';
  }
  $('#alt-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitVersion(this); } });
  $('#alt-textarea').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitVersion(this); } });
  $('#alt-ai').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('#alt-ai').addEventListener('click', aiAlternatives);

  // Context menu
  function rangeContainsPoint(r, x, y) {
    var rects = r.getClientRects();
    for (var i = 0; i < rects.length; i++) { var b = rects[i]; if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1) return true; }
    return false;
  }
  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) { var p = document.caretPositionFromPoint(x, y); if (!p) return null; var r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); return r; }
    return null;
  }
  // Right-click with no selection (or outside it) acts on the word under the pointer.
  function selectWordAtPoint(x, y) {
    var c = caretFromPoint(x, y); if (!c || !editor.contains(c.startContainer)) return null;
    var off = offsetOf(c.startContainer, c.startOffset), w = wordAt(fullText(), off);
    if (!w) { restoreRange(c); return c; }
    var r = rangeFromOffsets(w.s, w.e); restoreRange(r); return r;
  }
  editor.addEventListener('contextmenu', function (e) {
    e.preventDefault(); e.stopPropagation();
    var r = currentRange();
    if (!r || r.collapsed || !rangeContainsPoint(r, e.clientX, e.clientY)) r = selectWordAtPoint(e.clientX, e.clientY) || r;
    state.savedRange = r ? r.cloneRange() : null;
    var el = e.target.closest ? e.target : e.target.parentNode;
    var inGhost = !!(el.closest('.ghost') || (r && !r.collapsed && $$('#editor .ghost').some(function (g) { return r.intersectsNode(g); })));
    $('#ctx-ghost-label').textContent = inGhost ? 'Revive it' : 'Ghost it';
    var m = $('#ctx'); closePops(); m.hidden = false;
    m.style.left = Math.max(8, Math.min(e.clientX, innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(e.clientY, innerHeight - m.offsetHeight - 8)) + 'px';
  });
  $('#ctx').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('#ctx').addEventListener('click', function (e) {
    e.stopPropagation(); var b = e.target.closest('[data-ctx]'); if (!b) return; closePops();
    restoreRange(state.savedRange);
    var k = b.dataset.ctx;
    if (k === 'ghost') ghostToggle(); else if (k === 'stash') stash(); else if (k === 'ai') aiAlternatives(); else addAltShortcut();
  });

  function addAltShortcut() {
    openWorkspace(true);
    var so = selectionOffsets();
    if (so) setTargetFromCaret(so.s === so.e ? state.level : null);
    ensureTargetAlt(); renderSidebar(); refresh();
    var inp = state.level === 'paragraph' ? $('#alt-textarea') : $('#alt-input'); inp.focus();
  }

  // Keyboard
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && !e.shiftKey && k === 's') { e.preventDefault(); save(false); return; }
    if (mod && !e.shiftKey && (k === '/' || e.code === 'Slash')) { e.preventDefault(); ghostToggle(); return; }
    if (mod && e.shiftKey && k === 'a') { e.preventDefault(); addAltShortcut(); return; }
    if (mod && e.shiftKey && k === 'e') { e.preventDefault(); aiAlternatives(); return; }
    if (mod && e.shiftKey && k === 's') { e.preventDefault(); stash(); return; }
    if (e.key === 'Escape') { closePops(); $('#settings').hidden = true; $('#help').hidden = true; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.shiftKey && !e.altKey &&
        state.hoverAlt && state.alts[state.hoverAlt] && !(document.activeElement.tagName === 'TEXTAREA' && document.activeElement.value) && !document.activeElement.closest('#settings')) {
      e.preventDefault(); cycle(state.hoverAlt, e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  // Editor events
  editor.addEventListener('input', function () { pruneAlts(); markDirty(); refresh(); if (state.selAlt) renderSidebar(); });
  editor.addEventListener('mouseup', function () { setTimeout(function () { var r = currentRange(); if (r) state.savedRange = r.cloneRange(); setTargetFromCaret(); }, 0); });
  editor.addEventListener('keyup', function (e) { if (/^Arrow|Home|End/.test(e.key)) { var r = currentRange(); if (r) state.savedRange = r.cloneRange(); } });
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) state.savedRange = sel.getRangeAt(0).cloneRange();
  });
  window.addEventListener('resize', renderDots);
  window.addEventListener('beforeunload', function () { if (state.dirty) save(true); });

  // Settings
  $('#s-cancel').addEventListener('click', function () { $('#settings').hidden = true; });
  $('#s-clear').addEventListener('click', function () { var s = settings(); s.key = ''; store(LS.settings, s); $('#s-key').value = ''; toast('Key forgotten.', [], 1200); });
  $('#s-save').addEventListener('click', function () {
    store(LS.settings, { base: $('#s-base').value.trim() || 'https://api.openai.com/v1', model: $('#s-model').value.trim() || 'gpt-4o-mini', key: $('#s-key').value.trim(), dark: $('#s-dark').checked });
    $('#settings').hidden = true; applyTheme(); toast('Settings saved in this browser.', [], 1200);
  });
  $('#settings').addEventListener('click', function (e) { if (e.target.id === 'settings') this.hidden = true; });

  // Help, hint and sample
  $('#btn-help').addEventListener('click', function () { $('#help').hidden = false; });
  $('#help-close').addEventListener('click', function () { $('#help').hidden = true; });
  $('#help').addEventListener('click', function (e) { if (e.target.id === 'help') this.hidden = true; });
  $('#hint-close').addEventListener('click', function () { $('#hint').hidden = true; document.body.classList.remove('hinted'); localStorage.setItem(LS.hint, '1'); setTimeout(renderDots, 0); });
  $('#hint-help').addEventListener('click', function () { $('#help').hidden = false; });
  if (!localStorage.getItem(LS.hint)) { $('#hint').hidden = false; document.body.classList.add('hinted'); }

  var SAMPLE_ID = 'd-sample';
  function sampleDoc() {
    var html = 'Welcome to Copycat Writer.\n\n' +
      'I wrote this with a <span class="alt" data-id="s-word">thumbtack</span> in one hand. Hover the squiggly word and press \u2193 to swap it, and watch \u201ca\u201d turn into \u201can\u201d. The dots under it are its versions.\n\n' +
      '<span class="alt" data-id="s-sent">This sentence has a spare version, so hover it and press \u2193.</span> Click any underlined text to see every version in the sidebar on the left.\n\n' +
      'Ghosted text stays in place but fades, <span class="ghost">like this aside I am not sure about yet</span>. Right-click it to revive it.\n\n' +
      'Right-click any word for Ghost it, alternates, AI and Stash. The beaker at the bottom opens the Lab for scans and trims. Click + at the bottom left for a blank page.';
    return {
      id: SAMPLE_ID, title: 'Welcome to Copycat Writer', html: html, updated: Date.now(),
      overflow: 'Overflow is a scratchpad for lines you are not ready to delete.\n\nDrag or paste text in and out of it.',
      alts: {
        's-word': { level: 'word', active: 0, versions: [{ text: 'thumbtack', ai: false }, { text: 'eraser', ai: false }, { text: 'pushpin', ai: false }] },
        's-sent': { level: 'sentence', active: 0, versions: [{ text: 'This sentence has a spare version, so hover it and press \u2193.', ai: false }, { text: 'Here is the spare version. Press \u2191 to go back.', ai: false }] }
      }
    };
  }
  function seedSample() {
    var docs = allDocs().filter(function (d) { return d.id !== SAMPLE_ID; });
    docs.unshift(sampleDoc()); store(LS.docs, docs); localStorage.setItem(LS.seeded, '1');
  }

  // Boot
  applyTheme();
  document.body.classList.toggle('ws', localStorage.getItem(LS.ws) !== '0'); // workspace is on unless you hid it
  var cur = localStorage.getItem(LS.cur);
  var curDoc = allDocs().find(function (d) { return d.id === cur; });
  var curEmpty = curDoc && !String(curDoc.html || '').replace(/<[^>]*>/g, '').trim();
  if (!localStorage.getItem(LS.seeded) || !allDocs().length || (curDoc && curEmpty && curDoc.id !== SAMPLE_ID)) {
    seedSample(); openDoc(SAMPLE_ID); showOverflow(true);
  } else if (curDoc) openDoc(cur);
  else openDoc(allDocs()[0].id);
  renderDots();
  editor.focus();

  // Small hook for tests and the curious.
  window.CopycatWriter = { state: state, save: save, openDoc: openDoc, xIntentURL: xIntentURL, articleFor: articleFor, visibleText: visibleText, setVersion: setVersion, cycle: cycle, createAlt: createAlt, addVersion: addVersion, seedSample: seedSample };
})();
