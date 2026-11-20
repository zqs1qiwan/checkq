(function () {
  'use strict';
  var doc = document;
  var root = doc.documentElement;
  var base = root.getAttribute('data-base') || './';
  var THEME_KEY = 'checkq-wiki-theme';

  function mode() { return root.getAttribute('data-mode') === 'light' ? 'light' : 'dark'; }

  /* ---------- 主题切换 ---------- */
  var themeBtn = doc.getElementById('theme-toggle');
  function syncTheme() {
    if (!themeBtn) return;
    var light = mode() === 'light';
    var label = light ? '切换到深色主题' : '切换到浅色主题';
    themeBtn.setAttribute('aria-pressed', light ? 'true' : 'false');
    themeBtn.setAttribute('title', label);
    themeBtn.setAttribute('aria-label', label);
  }
  if (themeBtn) {
    syncTheme();
    themeBtn.addEventListener('click', function () {
      var next = mode() === 'light' ? 'dark' : 'light';
      root.setAttribute('data-mode', next);
      try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
      syncTheme();
    });
  }

  /* ---------- 移动端抽屉 ---------- */
  var navBtn = doc.getElementById('nav-toggle');
  var nav = doc.getElementById('sidenav');
  var scrim = doc.getElementById('scrim');
  function closeNav() {
    if (!doc.body.classList.contains('nav-open')) return;
    var inside = !!(nav && nav.contains(doc.activeElement));
    doc.body.classList.remove('nav-open');
    if (navBtn) navBtn.setAttribute('aria-expanded', 'false');
    if (scrim) scrim.hidden = true;
    if (inside && navBtn) navBtn.focus();
  }
  function openNav() {
    if (!nav || !navBtn) return;
    doc.body.classList.add('nav-open');
    navBtn.setAttribute('aria-expanded', 'true');
    if (scrim) scrim.hidden = false;
    var first = nav.querySelector('a, input');
    if (first) first.focus();
  }
  if (navBtn && nav) {
    navBtn.addEventListener('click', function () {
      if (doc.body.classList.contains('nav-open')) closeNav(); else openNav();
    });
    if (scrim) scrim.addEventListener('click', closeNav);
    nav.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el !== nav) {
        if (el.tagName === 'A') { closeNav(); return; }
        el = el.parentNode;
      }
    });
  }
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && doc.body.classList.contains('nav-open')) closeNav();
  });

  /* ---------- 搜索（combobox / listbox） ---------- */
  var input = doc.getElementById('search');
  var box = doc.getElementById('results');
  var statusEl = doc.getElementById('search-status');
  var entries = null;
  var hits = [];
  var activeIndex = -1;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      if (c === '&') return '&amp;';
      if (c === '<') return '&lt;';
      if (c === '>') return '&gt;';
      return '&quot;';
    });
  }
  function loadIndex() {
    if (entries) return Promise.resolve(entries);
    if (!window.fetch) return Promise.reject(new Error('fetch unavailable'));
    return fetch(base + 'search-index.json', { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .then(function (data) { entries = data; return data; });
  }
  function hasHeading(item, q) {
    var hs = item.headings || [];
    for (var i = 0; i < hs.length; i++) {
      if (String(hs[i].text || '').toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
  }
  function snippetOf(item, q) {
    var text = String(item.text || '');
    var pos = text.toLowerCase().indexOf(q);
    if (pos < 0) return item.desc || '';
    var start = pos > 40 ? pos - 40 : 0;
    return (start > 0 ? '…' : '') + text.slice(start, start + 120) + '…';
  }
  function hideResults() {
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
    if (statusEl) statusEl.textContent = '';
  }
  function setActive(next) {
    var links = box.querySelectorAll('a[role="option"]');
    if (!links.length) return;
    if (next < 0) next = links.length - 1;
    if (next >= links.length) next = 0;
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('aria-selected', i === next ? 'true' : 'false');
    }
    activeIndex = next;
    input.setAttribute('aria-activedescendant', 'sr-' + next);
    if (links[next].scrollIntoView) links[next].scrollIntoView({ block: 'nearest' });
  }
  function render(q) {
    if (!hits.length) {
      box.innerHTML = '<p class="search-empty">没有匹配的页面</p>';
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (statusEl) statusEl.textContent = '没有匹配结果';
      return;
    }
    var html = '';
    for (var i = 0; i < hits.length; i++) {
      html += '<a id="sr-' + i + '" role="option" aria-selected="false" href="' + base + hits[i].file + '">'
        + esc(hits[i].title) + '<em>' + esc(snippetOf(hits[i], q)) + '</em></a>';
    }
    box.innerHTML = html;
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (statusEl) statusEl.textContent = hits.length + ' 个结果';
  }
  function runSearch() {
    if (!input || !box) return;
    var q = String(input.value || '').trim().toLowerCase();
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    if (!q) { hideResults(); return; }
    loadIndex().then(function (data) {
      var found = [];
      for (var i = 0; i < data.length; i++) {
        var it = data[i];
        var score = 0;
        if (String(it.title || '').toLowerCase().indexOf(q) >= 0) score += 100;
        if (String(it.desc || '').toLowerCase().indexOf(q) >= 0) score += 50;
        if (hasHeading(it, q)) score += 30;
        if (String(it.text || '').toLowerCase().indexOf(q) >= 0) score += 10;
        if (score > 0) found.push({ item: it, score: score });
      }
      found.sort(function (a, b) { return b.score - a.score; });
      hits = found.slice(0, 8).map(function (x) { return x.item; });
      render(q);
    }).catch(function () {
      box.innerHTML = '<p class="search-empty">搜索索引未加载，可直接使用左侧导航</p>';
      box.hidden = false;
    });
  }
  if (input && box) {
    input.addEventListener('input', runSearch);
    input.addEventListener('focus', function () { if (String(input.value).trim()) runSearch(); });
    input.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Escape') {
        if (!box.hidden) { hideResults(); input.blur(); } else { input.value = ''; }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); return; }
      if (k === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); return; }
      if (k === 'Enter' && activeIndex >= 0) {
        var link = box.querySelector('#sr-' + activeIndex);
        if (link) { e.preventDefault(); window.location.href = link.getAttribute('href'); }
      }
    });
    doc.addEventListener('click', function (e) {
      if (!box.hidden && e.target !== input && !box.contains(e.target)) hideResults();
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      var tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      e.preventDefault();
      input.focus();
    });
  }

  /* ---------- 代码复制（渐进增强） ---------- */
  function copyText(text, done) {
    if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
      window.navigator.clipboard.writeText(text).then(function () { done(true); }, function () { legacyCopy(text, done); });
      return;
    }
    legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    var ok = false;
    try { ta.select(); ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    done(ok);
  }
  var blocks = doc.querySelectorAll('.code-block');
  for (var b = 0; b < blocks.length; b++) {
    (function (block) {
      var btn = block.querySelector('[data-copy]');
      var code = block.querySelector('pre code');
      if (!btn || !code) return;
      btn.hidden = false;
      btn.addEventListener('click', function () {
        copyText(code.textContent || '', function (ok) {
          btn.textContent = ok ? '已复制' : '复制失败';
          btn.classList.toggle('is-done', ok);
          window.setTimeout(function () { btn.textContent = '复制'; btn.classList.remove('is-done'); }, 1600);
        });
      });
    })(blocks[b]);
  }

  /* ---------- 本页目录滚动高亮 ---------- */
  var tocLinks = doc.querySelectorAll('.toc-nav a');
  if (tocLinks.length) {
    var targets = [];
    var seen = {};
    for (var t = 0; t < tocLinks.length; t++) {
      var href = tocLinks[t].getAttribute('href') || '';
      if (href.charAt(0) !== '#') continue;
      var id = href.slice(1);
      if (seen[id]) continue;
      seen[id] = true;
      var el = doc.getElementById(id);
      if (el) targets.push(el);
    }
    var current = '';
    function markActive(id) {
      if (id === current) return;
      current = id;
      for (var i = 0; i < tocLinks.length; i++) {
        var h = tocLinks[i].getAttribute('href') || '';
        var on = h === '#' + id;
        tocLinks[i].classList.toggle('is-active', on);
        if (on) tocLinks[i].setAttribute('aria-current', 'location');
        else tocLinks[i].removeAttribute('aria-current');
      }
    }
    function update() {
      var top = null;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top <= 96) top = targets[i];
      }
      if (top) markActive(top.id);
    }
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      var raf = window.requestAnimationFrame || function (fn) { return window.setTimeout(fn, 16); };
      raf(function () { ticking = false; update(); });
    }, { passive: true });
    update();
  }
})();
