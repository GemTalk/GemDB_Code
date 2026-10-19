/**
 * What the Inspector draws inside a column (see src/inspector.ts).
 *
 * Read at run time and injected as a <script> tag, after evaluatePane.js and
 * millerColumns.js, which are Jasper's own files, copied unchanged. The split
 * is Jasper's: millerColumns.js owns the column STRIP (order, drilling to the
 * right, closing one column, focus and the panel title, widths); this file
 * owns a column's insides — the tab bar, the tables and their paging, the
 * Class tab, the Evaluate tab, the inline editor, the context menu — and the
 * per-column history that Back and Forward walk. It is Jasper's
 * basicInspectorView.js reshaped for Python objects: a column holds a registry
 * handle rather than an OOP, its tabs follow the object's kind as the
 * Variables view reads it, and its rows are the Variables view's rows.
 *
 * Exposed as the global `InspectorView`, so the webview and the jsdom tests
 * (src/__tests__/inspectorView.test.ts) reach it the same way.
 */
(function () {
  var strip, ctxMenu, headerCtxMenu, vscode, PAGE_SIZE, Columns;
  var ctxTarget = null; // { columnId, row, containerRef, inGroup, tab }
  var headerCtxTarget = null; // { text, what }

  // ── Small helpers ─────────────────────────

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  /** `1,234`: sizes in this panel run to the millions. */
  function count(n) {
    return Number(n).toLocaleString('en-US');
  }

  /**
   * Which tabs an object gets, from its header alone, so a tab never appears
   * for structure the object does not have.
   *
   * The kind is the Variables view's (`childrenOf` in pauseVariables.ts): an
   * object's attributes (`obj`, or a Grail runtime object's `ivars`), a list's
   * or a set's items (`seq`, `coll`), a dict's entries (`dict`). A number or a
   * str has none of them. Repr, Class and Evaluate are always there: every
   * object has a repr and a class, and can be `self`.
   */
  function tabsFor(header) {
    var tabs = [];
    var kind = header && header.row ? header.row.kind : '';
    if (kind === 'obj' || kind === 'ivars') tabs.push({ id: 'attributes', label: 'Attributes' });
    if (kind === 'seq' || kind === 'coll') tabs.push({ id: 'items', label: 'Items' });
    if (kind === 'dict') tabs.push({ id: 'entries', label: 'Entries' });
    tabs.push({ id: 'repr', label: 'Repr' });
    tabs.push({ id: 'class', label: 'Class' });
    tabs.push({ id: 'eval', label: 'Evaluate' });
    return tabs;
  }

  /** How many items or entries a paged tab has in all. */
  function totalFor(col) {
    return col.header && col.header.row && col.header.row.size > 0 ? col.header.row.size : 0;
  }

  /** The type as a row's badge reads in the Variables view: `{list: 3}`, `{Point}`. */
  function typeText(row) {
    if (!row.type) return '';
    return row.size >= 0 ? row.type + ': ' + count(row.size) : row.type;
  }

  /** A group heading (`special variables`, `class variables`, …): it opens, it is not an object. */
  function isGroup(row) {
    return !row.handle && row.ref > 0;
  }

  /** The `... N more not shown` line, which has neither an object nor a group. */
  function isNote(row) {
    return !row.handle && !row.ref;
  }

  /** A Python identifier, which can follow a dot. */
  var IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /**
   * The expression that reaches a row's object from the column's own: `.name`
   * for an attribute, `[2]` for an item, `['key']` for an entry, so a child
   * column's label reads as Python (`gemdb.root["orders"][2].customer`) and
   * Copy as Expression copies it. An attribute that is not a Python name goes
   * through getattr.
   */
  function childExpression(base, tab, name) {
    if (tab === 'items') return base + name;
    if (tab === 'entries') return base + '[' + name + ']';
    if (IDENTIFIER.test(name)) return base + '.' + name;
    return 'getattr(' + base + ', ' + JSON.stringify(name) + ')';
  }

  // ── Column DOM ────────────────────────────

  function createColumnDom(col) {
    var root = document.createElement('div');
    root.className = 'column';
    root.dataset.colId = col.id;
    root.innerHTML =
      '<div class="col-inner">' +
      '<div class="header">' +
      '<button class="nav-btn nav-back" title="Back to the previously inspected object">&#8249;</button>' +
      '<button class="nav-btn nav-fwd" title="Forward">&#8250;</button>' +
      '<span class="obj-class"></span>' +
      '<span class="obj-sep" style="display:none">&#8250;</span>' +
      '<span class="obj-label"></span>' +
      '<span class="header-oop"></span>' +
      '<span class="header-badge"></span>' +
      '<button class="nav-btn nav-refresh" title="Read this object again">&#8635;</button>' +
      '<span class="col-close" title="Close">&#215;</span>' +
      '</div>' +
      '<div class="tab-bar"></div>' +
      '<div class="column-error" style="display:none"></div>' +
      '<div class="content-pane"><div class="placeholder">Loading&#8230;</div></div>' +
      '</div>' +
      '<div class="col-resize-edge"></div>';
    col.el = {
      root: root,
      navBack: root.querySelector('.nav-back'),
      navFwd: root.querySelector('.nav-fwd'),
      objClass: root.querySelector('.obj-class'),
      objSep: root.querySelector('.obj-sep'),
      objLabel: root.querySelector('.obj-label'),
      headerOop: root.querySelector('.header-oop'),
      badge: root.querySelector('.header-badge'),
      tabBar: root.querySelector('.tab-bar'),
      error: root.querySelector('.column-error'),
      contentPane: root.querySelector('.content-pane'),
    };
    return root;
  }

  /** The fields a column's drawing keeps, fresh for each object it shows. */
  function freshState() {
    return {
      header: null,
      editable: false,
      activeTab: null,
      tabData: Object.create(null),
      pageStart: Object.create(null),
      groups: Object.create(null),
      found: null,
      gotoError: null,
      evalText: '',
      evalOut: null,
      classSubTab: 'methods',
      openMember: null,
      memberSource: Object.create(null),
      chordArmed: false,
      evalVarsRequested: false,
      editing: null,
      editError: null,
    };
  }

  /**
   * Point a column at an object and place it in the column's history: a dive
   * cuts off anything ahead of the cursor and appends, as a browser's history
   * does; a Back or Forward step arrives with `remember` false because
   * `navigate` has already moved the cursor.
   */
  function populateColumn(col, msg) {
    if (msg.remember) {
      col.history = col.history.slice(0, col.historyIndex + 1);
      col.history.push({ handle: msg.handle, label: msg.label || '' });
      col.historyIndex = col.history.length - 1;
    } else if (col.history.length === 0) {
      col.history = [{ handle: msg.handle, label: msg.label || '' }];
      col.historyIndex = 0;
    } else if (col.history[col.historyIndex]) {
      // A refresh, or a step back: the object was registered again, at a new handle.
      col.history[col.historyIndex].handle = msg.handle;
    }
    var keepTab = msg.keepTab ? col.activeTab : null;
    var state = freshState();
    for (var k in state) col[k] = state[k];
    col.handle = msg.handle;
    col.header = msg.header || null;
    col.editable = !!msg.editable;
    col.label = msg.label || '';
    col.className = col.header ? col.header.row.type : '';
    col.title = col.className;

    var e = col.el;
    e.objClass.textContent = col.className;
    e.objSep.style.display = col.label ? '' : 'none';
    e.objLabel.textContent = col.label;
    e.objLabel.title = col.header ? col.header.row.value : '';
    e.headerOop.textContent = col.header ? 'oop ' + col.header.oop : '';
    e.badge.textContent = col.header && col.header.committed ? 'committed' : 'not committed';
    e.badge.classList.toggle('committed', !!(col.header && col.header.committed));
    e.badge.title =
      col.header && col.header.committed
        ? 'Saved in the database: readable by its OOP from any session.'
        : 'Not committed: it exists only in the session that made it.';
    showError(col, null);
    renderNav(col);

    var tabs = tabsFor(col.header);
    e.tabBar.innerHTML = tabs
      .map(function (t) {
        return '<div class="tab" data-tab="' + t.id + '">' + esc(t.label) + '</div>';
      })
      .join('');
    var first = tabs[0].id;
    if (keepTab) {
      for (var i = 0; i < tabs.length; i++) if (tabs[i].id === keepTab) first = keepTab;
    }
    activateTab(col, first);
  }

  function renderNav(col) {
    col.el.navBack.disabled = col.historyIndex <= 0;
    col.el.navFwd.disabled = col.historyIndex >= col.history.length - 1;
  }

  function navigate(col, delta) {
    var target = col.historyIndex + delta;
    if (target < 0 || target >= col.history.length) return;
    col.historyIndex = target;
    var entry = col.history[target];
    post({
      command: 'diveHere',
      columnId: col.id,
      handle: entry.handle,
      label: entry.label,
      remember: false,
    });
  }

  function dive(col, handle, label) {
    post({ command: 'diveHere', columnId: col.id, handle: handle, label: label, remember: true });
  }

  /** Why the column could not be read, above its content; null clears it. */
  function showError(col, message) {
    col.el.error.style.display = message ? '' : 'none';
    col.el.error.textContent = message || '';
  }

  // ── Tabs ──────────────────────────────────

  function activateTab(col, tab) {
    col.activeTab = tab;
    var tabEls = col.el.tabBar.querySelectorAll('.tab');
    for (var i = 0; i < tabEls.length; i++) {
      tabEls[i].classList.toggle('active', tabEls[i].dataset.tab === tab);
    }
    if (tab === 'eval') {
      renderEval(col);
      return;
    }
    if (col.tabData[tab] !== undefined) {
      renderTab(col);
      return;
    }
    fetchTab(col, tab, col.pageStart[tab] || 0);
  }

  function fetchTab(col, tab, start) {
    col.el.contentPane.innerHTML = '<div class="placeholder">Loading&#8230;</div>';
    post({ command: 'fetchTab', columnId: col.id, handle: col.handle, tab: tab, start: start });
  }

  function renderTab(col) {
    var tab = col.activeTab;
    var pane = col.el.contentPane;
    var data = col.tabData[tab];
    if (data === undefined || data === null) {
      pane.innerHTML = '<div class="placeholder">Nothing to show.</div>';
      return;
    }
    if (tab === 'repr') renderRepr(pane, data);
    else if (tab === 'class') renderClass(col, pane, data);
    else if (tab === 'eval') renderEval(col);
    else renderRows(col, pane, data);
  }

  // ── Repr ──────────────────────────────────

  function renderRepr(pane, data) {
    var html = '';
    if (data.str) html += '<div class="repr-label">repr()</div>';
    html += '<div class="detail-value repr-text"></div>';
    if (data.str)
      html += '<div class="repr-label">str()</div><div class="detail-value str-text"></div>';
    if (data.cut)
      html += '<div class="repr-note">Cut short: it is longer than this panel shows.</div>';
    pane.innerHTML = html;
    pane.querySelector('.repr-text').textContent = data.repr;
    if (data.str) pane.querySelector('.str-text').textContent = data.str;
  }

  // ── Rows (Attributes / Items / Entries) ───

  /**
   * The table, with the Items and Entries tabs paged one page at a time: a
   * pager above says which rows these are, steps a page either way, and takes
   * a typed position or key, so a row far into a big container is one jump
   * away rather than at the end of a list that keeps growing.
   */
  function renderRows(col, pane, rows) {
    var tab = col.activeTab;
    var labelHead = tab === 'entries' ? 'Key' : tab === 'items' ? 'Index' : 'Name';
    var html = '';
    if (tab === 'items' || tab === 'entries') html += pagerHtml(col, rows.length);
    html += '<div class="table-wrap"><table class="rows"><thead><tr>';
    html +=
      '<th class="cell-label">' +
      labelHead +
      '</th><th>Value</th><th class="cell-class">Type</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      html += rowHtml(col, rows[i], String(i), false);
      var g = isGroup(rows[i]) ? col.groups[rows[i].ref] : null;
      if (g && g.open) {
        if (!g.rows) {
          html += '<tr class="note-row in-group"><td colspan="3">Loading&#8230;</td></tr>';
        } else {
          for (var j = 0; j < g.rows.length; j++) {
            html += rowHtml(col, g.rows[j], i + '.' + j, true);
          }
        }
      }
    }
    html += '</tbody></table></div>';
    if (col.editError) html += '<div class="edit-error">' + esc(col.editError) + '</div>';
    pane.innerHTML = html;
    var found = pane.querySelector('tr.found');
    if (found && found.scrollIntoView) found.scrollIntoView({ block: 'center' });
  }

  function rowHtml(col, r, key, inGroup) {
    if (isGroup(r)) {
      var open = col.groups[r.ref] && col.groups[r.ref].open;
      return (
        '<tr class="group-row' +
        (open ? ' open' : '') +
        '" data-group="' +
        r.ref +
        '"><td class="cell-label">' +
        esc(r.name) +
        '</td><td colspan="2">' +
        count(r.named + r.indexed) +
        '</td></tr>'
      );
    }
    if (isNote(r)) {
      return (
        '<tr class="note-row' +
        (inGroup ? ' in-group' : '') +
        '"><td colspan="3">' +
        esc(r.name + ' ' + r.value) +
        '</td></tr>'
      );
    }
    var found =
      !inGroup &&
      col.found !== null &&
      (col.activeTab === 'items' || col.activeTab === 'entries') &&
      (col.pageStart[col.activeTab] || 0) + Number(key) === col.found;
    return (
      '<tr data-row="' +
      key +
      '" class="' +
      (inGroup ? 'in-group' : '') +
      (found ? ' found selected' : '') +
      '">' +
      '<td class="cell-label" title="' +
      esc(r.name) +
      '">' +
      esc(r.name) +
      '</td>' +
      '<td class="cell-value' +
      (r.revertible ? ' cell-edited' : '') +
      '" title="' +
      esc(r.value) +
      '">' +
      (r.revertible
        ? '<button class="revert-btn" data-revert="' +
          key +
          '" title="Put back the value it had before you edited it">&#8634;</button> '
        : '') +
      esc(r.value) +
      '</td>' +
      '<td class="cell-class">' +
      esc(typeText(r)) +
      '</td>' +
      '</tr>'
    );
  }

  function pagerHtml(col, shown) {
    var tab = col.activeTab;
    var total = totalFor(col);
    var start = col.pageStart[tab] || 0;
    var first = shown ? start + 1 : start;
    return (
      '<div class="toolbar pager">' +
      '<span class="toolbar-label">' +
      count(first) +
      '&#8211;' +
      count(start + shown) +
      ' of ' +
      count(total) +
      '</span>' +
      '<button class="btn" data-page="-1" title="Previous ' +
      PAGE_SIZE +
      '"' +
      (start <= 0 ? ' disabled' : '') +
      '>&#8249;</button>' +
      '<button class="btn" data-page="1" title="Next ' +
      PAGE_SIZE +
      '"' +
      (start + shown >= total ? ' disabled' : '') +
      '>&#8250;</button>' +
      '<span class="toolbar-gap"></span>' +
      '<input class="goto-input" type="text" spellcheck="false" placeholder="' +
      (tab === 'entries' ? 'Go to key' : 'Go to index') +
      '" title="' +
      (tab === 'entries'
        ? "A key, as you would write it: 'SKU0042', 42. A bare word is tried as a str too."
        : 'A position from 0, or from the end: -1') +
      '">' +
      (col.gotoError ? '<span class="goto-error">' + esc(col.gotoError) + '</span>' : '') +
      '</div>'
    );
  }

  /** Show the page holding item `index` (from 0; negative counts from the end), marked. */
  function goToIndex(col, tab, index) {
    var total = totalFor(col);
    if (index < 0) index = total + index;
    if (index < 0 || index >= total) {
      col.gotoError = 'There is no item ' + index + ' of ' + count(total) + '.';
      renderTab(col);
      return;
    }
    col.gotoError = null;
    col.found = index;
    var start = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
    if (start === (col.pageStart[tab] || 0) && col.tabData[tab]) {
      renderTab(col);
      return;
    }
    col.pageStart[tab] = start;
    col.tabData[tab] = undefined;
    fetchTab(col, tab, start);
  }

  /** The row a `data-row` key names: `3`, or `3.1` for the second row of row 3's group. */
  function rowAt(col, key) {
    var rows = col.tabData[col.activeTab];
    if (!rows) return null;
    var parts = String(key).split('.');
    var top = rows[Number(parts[0])];
    if (!top || parts.length === 1) {
      return top ? { row: top, containerRef: col.handle, inGroup: false } : null;
    }
    var g = col.groups[top.ref];
    var row = g && g.rows ? g.rows[Number(parts[1])] : null;
    return row ? { row: row, containerRef: top.ref, inGroup: true } : null;
  }

  // ── Editing ───────────────────────────────

  /**
   * Open the inline editor on a row. What is typed is a Python expression, run
   * as Set Value in the Variables view runs one, and stored where the row is:
   * an attribute by setattr, an item or entry by assignment.
   */
  function beginEdit(col, key) {
    var at = rowAt(col, key);
    if (!at || !col.editable || at.row.readOnly) return;
    var cell = col.el.contentPane.querySelector('tr[data-row="' + key + '"] .cell-value');
    if (!cell) return;
    col.editing = {
      key: key,
      containerRef: at.containerRef,
      name: at.row.name,
      handle: at.row.handle,
    };
    cell.innerHTML = '<input class="row-editor" type="text" spellcheck="false">';
    var input = cell.querySelector('.row-editor');
    input.value = at.row.value;
    input.select();
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        // Stopped here, or the strip's own Enter would dive into the row as well.
        ev.preventDefault();
        ev.stopPropagation();
        commitEdit(col, input.value);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cancelEdit(col);
      }
    });
    input.addEventListener('blur', function () {
      if (col.editing) cancelEdit(col);
    });
  }

  function commitEdit(col, expression) {
    var edit = col.editing;
    if (!edit) return;
    col.editing = null;
    col.editError = null;
    post({
      command: 'setSlot',
      columnId: col.id,
      containerRef: edit.containerRef,
      name: edit.name,
      valueHandle: edit.handle,
      expression: expression,
    });
  }

  function cancelEdit(col) {
    col.editing = null;
    renderTab(col);
  }

  /** A write landed: every value on the tab may be stale, so read the page and open groups again. */
  function refetchActiveTab(col) {
    var tab = col.activeTab;
    var openGroups = [];
    for (var ref in col.groups) if (col.groups[ref].open) openGroups.push(ref);
    col.reopenGroups = openGroups;
    col.groups = Object.create(null);
    col.tabData[tab] = undefined;
    fetchTab(col, tab, col.pageStart[tab] || 0);
  }

  // ── Class ─────────────────────────────────

  var MEMBER_GROUPS = {
    methods: ['method', 'classmethod', 'staticmethod'],
    attributes: ['attribute', 'property', 'class'],
  };

  function isDunder(name) {
    return name.length > 4 && name.slice(0, 2) === '__' && name.slice(-2) === '__';
  }

  /**
   * The Class tab: the class's name, a line of facts (module, OOP), and
   * sub-tabs for its methods, its other names, its MRO and its docstring.
   * Methods and names are grouped by the class in the MRO that defines them,
   * nearest first, with each group's dunders after its other names (see
   * memberListHtml for when a group gets a heading). A method
   * opens its source in place.
   */
  function renderClass(col, pane, info) {
    var methods = membersOf(info, 'methods');
    var names = membersOf(info, 'attributes');
    var html =
      '<div class="meta">' +
      '<div class="meta-head"><div class="meta-head-label">' +
      (info.isClass ? 'This class' : 'Class') +
      '</div><div class="meta-class-name">' +
      esc(info.qualname || info.name) +
      '</div></div>' +
      '<div class="meta-info-bar">' +
      fact('Module', info.module) +
      fact('Bases', info.mro.slice(1, 2).join('') || '—') +
      fact('OOP', col.header ? col.header.oop : '') +
      '</div><div class="meta-sub-bar">';
    var subs = [
      { id: 'methods', label: 'Methods (' + methods.length + ')' },
      { id: 'attributes', label: 'Attributes (' + names.length + ')' },
      { id: 'mro', label: 'MRO' },
      { id: 'doc', label: 'Docstring' },
    ];
    for (var i = 0; i < subs.length; i++) {
      html +=
        '<div class="tab' +
        (col.classSubTab === subs[i].id ? ' active' : '') +
        '" data-classtab="' +
        subs[i].id +
        '">' +
        esc(subs[i].label) +
        '</div>';
    }
    html += '</div><div class="meta-sub-content">';
    if (col.classSubTab === 'mro') {
      html += '<pre class="meta-pre">' + esc(info.mro.join('\n')) + '</pre>';
    } else if (col.classSubTab === 'doc') {
      html += info.doc
        ? '<pre class="meta-pre meta-comment">' + esc(info.doc) + '</pre>'
        : '<div class="placeholder">No docstring.</div>';
    } else {
      html += memberListHtml(col, col.classSubTab === 'methods' ? methods : names);
    }
    html += '</div></div>';
    var prev = pane.querySelector('.meta-sub-content');
    var keepTop = prev && col.classRendered === col.classSubTab ? prev.scrollTop : 0;
    pane.innerHTML = html;
    col.classRendered = col.classSubTab;
    var next = pane.querySelector('.meta-sub-content');
    if (next && keepTop) next.scrollTop = keepTop;
  }

  function fact(label, value) {
    return '<span>' + esc(label) + ': <strong>' + esc(value || '—') + '</strong></span>';
  }

  /** The members of one sub-tab, in MRO order, each class's dunders after its other names. */
  function membersOf(info, which) {
    var kinds = MEMBER_GROUPS[which];
    var out = [];
    var owners = [];
    info.members.forEach(function (m) {
      if (owners.indexOf(m.owner) < 0) owners.push(m.owner);
    });
    owners.forEach(function (owner) {
      var mine = info.members.filter(function (m) {
        return m.owner === owner && kinds.indexOf(m.kind) >= 0;
      });
      var plain = mine.filter(function (m) {
        return !isDunder(m.name);
      });
      var dunders = mine.filter(function (m) {
        return isDunder(m.name);
      });
      out = out.concat(plain, dunders);
    });
    return out;
  }

  /**
   * The members, under a "defined in" heading per class — only when more than
   * one class defines some: a lone heading would just repeat the class name.
   */
  function memberListHtml(col, members) {
    if (!members.length) return '<div class="placeholder">None.</div>';
    var html = '<div class="method-list">';
    var owner = null;
    var headed = members.some(function (m) {
      return m.owner !== members[0].owner;
    });
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (headed && m.owner !== owner) {
        owner = m.owner;
        html += '<div class="class-owner">defined in ' + esc(owner) + '</div>';
      }
      var key = m.owner + '.' + m.name;
      var open = col.openMember === key;
      html +=
        '<div class="method-item' +
        (open ? ' open' : '') +
        '" data-owner="' +
        esc(m.owner) +
        '" data-member="' +
        esc(m.name) +
        '">' +
        esc(m.name) +
        (m.kind !== 'method' && m.kind !== 'attribute'
          ? '<span class="class-member-kind">' + esc(m.kind) + '</span>'
          : '') +
        '</div>';
      if (open) {
        var src = col.memberSource[key];
        html +=
          '<div class="method-source-box">' +
          (src && src.caption ? '<div class="source-caption">' + esc(src.caption) + '</div>' : '') +
          esc(src === undefined ? 'Loading…' : src.source) +
          '</div>';
      }
    }
    return html + '</div>';
  }

  function toggleMember(col, owner, name) {
    var key = owner + '.' + name;
    if (col.openMember === key) {
      col.openMember = null;
      renderTab(col);
      return;
    }
    col.openMember = key;
    renderTab(col);
    if (col.memberSource[key] === undefined) {
      post({
        command: 'fetchSource',
        columnId: col.id,
        handle: col.handle,
        owner: owner,
        name: name,
      });
    }
  }

  // ── Evaluate ──────────────────────────────

  /**
   * The pane's keys and expression history are Jasper's evaluatePane.js, so
   * they behave as they do there: Shift+Enter (or Ctrl+K D) displays, Ctrl+K E
   * executes, Ctrl+K I inspects, Ctrl+Up and Ctrl+Down walk the expressions run
   * before. One pane per column, kept across redraws.
   */
  function evalPaneFor(col) {
    if (col.evalPane) return col.evalPane;
    col.evalPane = EvaluatePane.create({
      input: function () {
        return col.el.contentPane.querySelector('.eval-input');
      },
      send: function (expr, mode) {
        post({
          command: 'evaluate',
          columnId: col.id,
          handle: col.handle,
          expression: expr,
          mode: mode,
        });
      },
      syncText: function (text) {
        col.evalText = text;
        showClearWhenTyped(col);
      },
      showStatus: function (text) {
        var hint = col.el.contentPane.querySelector('.eval-hint');
        if (!hint) return;
        hint.textContent = text;
        hint.classList.add('flash');
      },
      restStatus: function () {
        var hint = col.el.contentPane.querySelector('.eval-hint');
        if (!hint) return;
        hint.classList.remove('flash');
        setChordHint(col, chordLegend());
      },
      setChordArmed: function (armed) {
        col.chordArmed = armed;
        setChordHint(col, armed ? EvaluatePane.chordLabel() + '&#8230;' : chordLegend());
      },
      clearPane: function () {
        col.evalText = '';
        col.evalOut = null;
        renderEval(col);
        var input = col.el.contentPane.querySelector('.eval-input');
        if (input) input.focus();
      },
    });
    return col.evalPane;
  }

  function chordLegend() {
    return EvaluatePane.chordLabel() + ' D &#183; E &#183; I';
  }

  /**
   * The names the pane offers to type: `self`, then the object's own data
   * attributes (the Attributes tab's rows outside the groups), each with its
   * type.
   */
  function evalNames(col) {
    var names = [{ name: 'self', type: col.className }];
    var rows = col.tabData.attributes || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.handle && IDENTIFIER.test(r.name)) names.push({ name: 'self.' + r.name, type: r.type });
    }
    return names;
  }

  function ensureEvalNames(col) {
    if (col.tabData.attributes !== undefined || col.evalVarsRequested) return;
    var kind = col.header && col.header.row ? col.header.row.kind : '';
    if (kind !== 'obj' && kind !== 'ivars') return;
    col.evalVarsRequested = true;
    post({
      command: 'fetchTab',
      columnId: col.id,
      handle: col.handle,
      tab: 'attributes',
      start: 0,
    });
  }

  function renderEvalNames(col) {
    var names = evalNames(col);
    var html = '<div class="eval-vars"><div class="eval-vars-list">';
    for (var i = 0; i < names.length; i++) {
      var item = names[i];
      html +=
        '<div class="eval-var" data-var="' +
        esc(item.name) +
        '" title="' +
        esc(item.name + (item.type ? ' — ' + item.type : '')) +
        '. Click to put it in the expression.">' +
        '<span class="eval-var-name">' +
        esc(item.name) +
        '</span><span class="eval-var-class">' +
        esc(item.type) +
        '</span></div>';
    }
    return html + '</div></div>';
  }

  function renderEval(col) {
    var pane = col.el.contentPane;
    evalPaneFor(col).disarm();
    pane.innerHTML =
      '<div class="eval">' +
      '<div class="toolbar">' +
      '<button class="btn" data-eval="display">Display It</button>' +
      '<button class="btn" data-eval="execute">Execute It</button>' +
      '<button class="btn" data-eval="inspect">Inspect It</button>' +
      '<span class="eval-hint">' +
      chordLegend() +
      '</span>' +
      '</div>' +
      '<div class="eval-body">' +
      '<div class="eval-editor">' +
      '<div class="eval-input-wrap">' +
      '<textarea class="eval-input" spellcheck="false"></textarea>' +
      '<button class="clear-btn" data-eval-clear="1" tabindex="-1" title="Clear">&#10005;</button>' +
      '</div>' +
      '<div class="eval-out' +
      (col.evalOut && !col.evalOut.ok ? ' error' : '') +
      '"></div>' +
      '</div>' +
      renderEvalNames(col) +
      '</div>' +
      '</div>';
    pane.querySelector('.eval-out').textContent = col.evalOut ? col.evalOut.text : '';
    EvaluatePane.applyLabels(pane);
    ensureEvalNames(col);
    var input = pane.querySelector('.eval-input');
    input.placeholder = 'Python, with self bound to this ' + (col.className || 'object');
    input.value = col.evalText;
    showClearWhenTyped(col);
    input.addEventListener('input', function () {
      col.evalText = input.value;
      showClearWhenTyped(col);
    });
    pane.querySelector('.eval').addEventListener('keydown', function (ev) {
      evalPaneFor(col).keydown(ev);
    });
    input.addEventListener('blur', function () {
      evalPaneFor(col).disarm();
    });
  }

  /** Draw the answer in place, leaving the box, its caret and its focus alone. */
  function renderEvalOut(col) {
    var out = col.el.contentPane.querySelector('.eval-out');
    if (!out) return;
    out.textContent = col.evalOut ? col.evalOut.text : '';
    out.classList.toggle('error', !!(col.evalOut && !col.evalOut.ok));
  }

  function setChordHint(col, html) {
    var hint = col.el.contentPane.querySelector('.eval-hint');
    if (!hint) return;
    hint.innerHTML = html;
    hint.classList.toggle('armed', !!col.chordArmed);
  }

  function insertName(col, name) {
    var input = col.el.contentPane.querySelector('.eval-input');
    if (!input) return;
    var at = input.selectionStart === null ? input.value.length : input.selectionStart;
    var to = input.selectionEnd === null ? at : input.selectionEnd;
    input.value = input.value.slice(0, at) + name + input.value.slice(to);
    col.evalText = input.value;
    var caret = at + name.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    showClearWhenTyped(col);
  }

  function refreshEvalNames(col) {
    var vars = col.el.contentPane.querySelector('.eval-vars');
    if (vars) vars.outerHTML = renderEvalNames(col);
  }

  function showClearWhenTyped(col) {
    var wrap = col.el.contentPane.querySelector('.eval-input-wrap');
    if (wrap) wrap.classList.toggle('has-text', col.evalText.length > 0);
  }

  // ── Context menus ─────────────────────────

  function rowContext(col, key) {
    var at = rowAt(col, key);
    if (!at || !at.row.handle) return null;
    return {
      columnId: col.id,
      key: key,
      row: at.row,
      containerRef: at.containerRef,
      tab: at.inGroup ? 'attributes' : col.activeTab,
      editable: col.editable && !at.row.readOnly,
    };
  }

  function placeMenu(menu, x, y) {
    menu.style.display = 'block';
    var w = menu.offsetWidth || 120;
    var h = menu.offsetHeight || 30;
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - w - 4)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, window.innerHeight - h - 4)) + 'px';
  }

  function showCtxMenu(x, y, target) {
    ctxTarget = target;
    var edit = ctxMenu.querySelector('[data-action="edit"]');
    if (edit) edit.style.display = target.editable ? '' : 'none';
    placeMenu(ctxMenu, x, y);
  }

  function hideCtxMenu() {
    ctxMenu.style.display = 'none';
    ctxTarget = null;
  }

  function showHeaderCtxMenu(x, y, target) {
    headerCtxTarget = target;
    placeMenu(headerCtxMenu, x, y);
  }

  function hideHeaderCtxMenu() {
    if (!headerCtxMenu) return;
    headerCtxMenu.style.display = 'none';
    headerCtxTarget = null;
  }

  /** What Copy takes from a right-click in a column's header, or null outside one. */
  function headerCopyTarget(col, el) {
    var region = el.closest('.header, .meta-head, .meta-info-bar');
    if (!region) return null;
    if (el.closest('.header-oop')) {
      return { text: col.header ? String(col.header.oop) : '', what: 'OOP' };
    }
    if (el.closest('.obj-label')) return { text: col.label, what: 'Expression' };
    var fact = region.classList.contains('meta-info-bar') ? el.closest('span') : null;
    var strong = fact && fact.querySelector('strong');
    if (strong) {
      return {
        text: strong.textContent,
        what: fact.textContent.slice(0, fact.textContent.indexOf(':')),
      };
    }
    var name = region.querySelector('.meta-class-name') || col.el.objClass;
    return { text: name.textContent, what: 'Type name' };
  }

  function labelFor(col, t) {
    return childExpression(col.label, t.tab, t.row.name);
  }

  function runCtxAction(action) {
    var t = ctxTarget;
    hideCtxMenu();
    if (!t) return;
    var col = Columns.get(t.columnId);
    if (!col) return;
    if (action === 'inspect') {
      post({
        command: 'inspectRow',
        sourceColumnId: col.id,
        handle: t.row.handle,
        label: labelFor(col, t),
      });
    } else if (action === 'dive') {
      dive(col, t.row.handle, labelFor(col, t));
    } else if (action === 'edit') {
      beginEdit(col, t.key);
    } else if (action === 'copyValue') {
      post({ command: 'copyText', text: t.row.value, what: 'Value' });
    } else if (action === 'copyExpression') {
      post({ command: 'copyText', text: labelFor(col, t), what: 'Expression' });
    }
  }

  // ── Events ────────────────────────────────

  function wireEvents() {
    strip.addEventListener('click', function (ev) {
      var col = Columns.columnOf(ev.target);
      if (!col) return;
      Columns.focus(col);
      var t = ev.target;
      if (t.closest('.col-close')) return Columns.close(col);
      if (t.closest('.nav-back')) return navigate(col, -1);
      if (t.closest('.nav-fwd')) return navigate(col, 1);
      if (t.closest('.nav-refresh')) {
        var here = col.history[col.historyIndex] || { handle: col.handle, label: col.label };
        post({
          command: 'diveHere',
          columnId: col.id,
          handle: here.handle,
          label: here.label,
          remember: false,
          keepTab: true,
        });
        return;
      }
      var tab = t.closest('.tab');
      if (tab && tab.parentElement === col.el.tabBar) return activateTab(col, tab.dataset.tab);
      var group = t.closest('tr[data-group]');
      if (group) return toggleGroup(col, Number(group.dataset.group));
      var revert = t.closest('[data-revert]');
      if (revert) {
        var at = rowAt(col, revert.dataset.revert);
        if (at) {
          post({
            command: 'revertSlot',
            columnId: col.id,
            containerRef: at.containerRef,
            name: at.row.name,
          });
        }
        return;
      }
      var page = t.closest('[data-page]');
      if (page && !page.disabled) {
        var tabName = col.activeTab;
        var start = Math.max(
          0,
          (col.pageStart[tabName] || 0) + Number(page.dataset.page) * PAGE_SIZE,
        );
        col.pageStart[tabName] = start;
        col.found = null;
        col.gotoError = null;
        col.tabData[tabName] = undefined;
        fetchTab(col, tabName, start);
        return;
      }
      var classTab = t.closest('[data-classtab]');
      if (classTab) {
        col.classSubTab = classTab.dataset.classtab;
        col.openMember = null;
        return renderTab(col);
      }
      var member = t.closest('.method-item');
      if (member) return toggleMember(col, member.dataset.owner, member.dataset.member);
      var useVar = t.closest('[data-var]');
      if (useVar) return insertName(col, useVar.dataset.var);
      if (t.closest('[data-eval-clear]')) return evalPaneFor(col).clear();
      var evalBtn = t.closest('[data-eval]');
      if (evalBtn) return evalPaneFor(col).run(evalBtn.dataset.eval);
    });

    // Enter in the Go to box jumps; it is a field, so the strip's own Enter leaves it alone.
    strip.addEventListener('keydown', function (ev) {
      if (
        ev.key !== 'Enter' ||
        !ev.target.classList ||
        !ev.target.classList.contains('goto-input')
      ) {
        return;
      }
      var col = Columns.columnOf(ev.target);
      var text = ev.target.value.trim();
      if (!col || !text) return;
      ev.preventDefault();
      post({
        command: 'goTo',
        columnId: col.id,
        handle: col.handle,
        tab: col.activeTab,
        text: text,
      });
    });

    // Double-click a row: open its object in a new column to the right.
    strip.addEventListener('dblclick', function (ev) {
      var col = Columns.columnOf(ev.target);
      var tr = ev.target.closest ? ev.target.closest('tr[data-row]') : null;
      if (!col || !tr) return;
      var target = rowContext(col, tr.dataset.row);
      if (target) {
        post({
          command: 'inspectRow',
          sourceColumnId: col.id,
          handle: target.row.handle,
          label: labelFor(col, target),
        });
      }
    });

    strip.addEventListener('contextmenu', function (ev) {
      var col = Columns.columnOf(ev.target);
      if (!col) return;
      var header = headerCtxMenu && ev.target.closest ? headerCopyTarget(col, ev.target) : null;
      if (header) {
        ev.preventDefault();
        Columns.focus(col);
        hideCtxMenu();
        showHeaderCtxMenu(ev.clientX, ev.clientY, header);
        return;
      }
      var tr = ev.target.closest ? ev.target.closest('tr[data-row]') : null;
      if (!tr) return;
      var target = rowContext(col, tr.dataset.row);
      if (!target) return;
      ev.preventDefault();
      Columns.focus(col);
      hideHeaderCtxMenu();
      showCtxMenu(ev.clientX, ev.clientY, target);
    });

    ctxMenu.addEventListener('click', function (ev) {
      var item = ev.target.closest('[data-action]');
      if (item) runCtxAction(item.dataset.action);
    });

    if (headerCtxMenu) {
      headerCtxMenu.addEventListener('click', function (ev) {
        var item = ev.target.closest('[data-action]');
        var t = headerCtxTarget;
        hideHeaderCtxMenu();
        if (item && t && item.dataset.action === 'copy') {
          post({ command: 'copyText', text: t.text, what: t.what });
        }
      });
    }

    document.addEventListener('click', function (ev) {
      if (!ctxMenu.contains(ev.target)) hideCtxMenu();
      if (headerCtxMenu && !headerCtxMenu.contains(ev.target)) hideHeaderCtxMenu();
    });

    // Enter dives in place (Jadeite's idiom), apart from the double-click that opens a new column.
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        hideCtxMenu();
        hideHeaderCtxMenu();
        return;
      }
      if (ev.key !== 'Enter') return;
      var tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'A') return;
      var col = Columns.get(Columns.focusedId());
      if (!col || col.editing) return;
      var tr = col.el.contentPane.querySelector('tr.selected[data-row]');
      if (!tr) return;
      var target = rowContext(col, tr.dataset.row);
      if (target) dive(col, target.row.handle, labelFor(col, target));
    });

    strip.addEventListener('mousedown', function (ev) {
      var tr = ev.target.closest ? ev.target.closest('tr[data-row]') : null;
      if (!tr) return;
      var rows = tr.parentElement.querySelectorAll('tr.selected');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('selected');
      tr.classList.add('selected');
    });
  }

  function toggleGroup(col, ref) {
    var g = col.groups[ref] || (col.groups[ref] = { open: false, rows: null });
    g.open = !g.open;
    renderTab(col);
    if (g.open && !g.rows) post({ command: 'fetchGroup', columnId: col.id, groupRef: ref });
  }

  // ── Host messages ─────────────────────────

  function handleHostMessage(msg) {
    var col;
    switch (msg.command) {
      case 'addRoot':
        Columns.addRoot(msg);
        return;
      case 'addChild':
        Columns.addChild(msg);
        return;
      case 'replaceColumn':
        col = Columns.get(msg.columnId);
        if (!col) return;
        populateColumn(col, msg);
        Columns.focus(col, true);
        return;
      case 'rootError':
        strip.innerHTML = '<div class="root-error"></div>';
        strip.firstChild.textContent = 'Could not open it: ' + msg.message;
        return;
      case 'columnError':
        col = Columns.get(msg.columnId);
        if (!col) return;
        showError(col, msg.message);
        if (col.el.contentPane.querySelector('.placeholder')) {
          col.el.contentPane.innerHTML = '<div class="placeholder">Not read.</div>';
        }
        return;
      case 'tabData':
        col = Columns.get(msg.columnId);
        if (!col) return;
        applyTabData(col, msg);
        return;
      case 'groupData':
        col = Columns.get(msg.columnId);
        if (!col) return;
        if (col.groups[msg.groupRef]) col.groups[msg.groupRef].rows = msg.rows;
        if (col.activeTab === 'attributes') renderTab(col);
        return;
      case 'goToResult':
        col = Columns.get(msg.columnId);
        if (!col || col.activeTab !== msg.tab) return;
        if (msg.error) {
          col.gotoError = msg.error;
          renderTab(col);
        } else {
          goToIndex(col, msg.tab, msg.index);
        }
        return;
      case 'evalResult':
        col = Columns.get(msg.columnId);
        if (!col) return;
        col.evalOut = { ok: msg.ok, text: msg.text };
        if (col.activeTab === 'eval') renderEvalOut(col);
        return;
      case 'setSlotResult':
        col = Columns.get(msg.columnId);
        if (!col) return;
        col.editError = msg.ok ? null : msg.error;
        if (msg.ok) refetchActiveTab(col);
        else renderTab(col);
        return;
      case 'source':
        col = Columns.get(msg.columnId);
        if (!col) return;
        // The caption (which Smalltalk class implements a built-in) is drawn apart from the code.
        col.memberSource[msg.owner + '.' + msg.name] = { source: msg.source, caption: msg.caption };
        if (col.activeTab === 'class') renderTab(col);
        return;
    }
  }

  function applyTabData(col, msg) {
    showError(col, null);
    if (msg.tab === 'repr') col.tabData.repr = msg.repr;
    else if (msg.tab === 'class') col.tabData['class'] = msg.info;
    else {
      col.tabData[msg.tab] = msg.rows;
      if (msg.tab !== 'attributes') col.pageStart[msg.tab] = msg.start || 0;
      // Groups that were open before a write are opened again, with their rows read afresh.
      if (col.reopenGroups && msg.tab === 'attributes') {
        var reopen = col.reopenGroups;
        col.reopenGroups = null;
        msg.rows.forEach(function (r) {
          if (isGroup(r) && reopen.indexOf(String(r.ref)) >= 0) {
            col.groups[r.ref] = { open: true, rows: null };
            post({ command: 'fetchGroup', columnId: col.id, groupRef: r.ref });
          }
        });
      }
    }
    if (col.activeTab === msg.tab) renderTab(col);
    else if (col.activeTab === 'eval' && msg.tab === 'attributes') refreshEvalNames(col);
  }

  // ── Init ──────────────────────────────────

  function init(opts) {
    strip = opts.strip;
    ctxMenu = opts.ctxMenu;
    headerCtxMenu = opts.headerCtxMenu || null;
    vscode = opts.vscode;
    PAGE_SIZE = opts.pageSize;

    Columns = (opts.millerColumns || MillerColumns).createColumnStrip({
      strip: strip,
      postMessage: post,
      defaultWidth: opts.defaultColumnWidth,
      minWidth: opts.minColumnWidth,
      buildColumnDom: createColumnDom,
      populate: populateColumn,
      makeState: function () {
        var state = freshState();
        state.handle = 0;
        state.history = [];
        state.historyIndex = -1;
        return state;
      },
    });

    wireEvents();
    window.addEventListener('message', function (ev) {
      handleHostMessage(ev.data);
    });
    post({ command: 'ready' });
    return {
      columns: Columns,
      tabsFor: tabsFor,
      childExpression: childExpression,
      handleHostMessage: handleHostMessage,
    };
  }

  var root = typeof globalThis !== 'undefined' ? globalThis : window;
  root.InspectorView = { init: init, tabsFor: tabsFor, childExpression: childExpression };
})();
