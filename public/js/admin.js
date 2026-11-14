/* 书架 · 后台逻辑 */
(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

  // ---------- 工具 ----------
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function showToast(msg, type) {
    const t = el("toast");
    t.textContent = msg;
    t.className = "toast show" + (type ? " " + type : "");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => (t.className = "toast"), 3000);
  }

  /** fetch 封装：失败抛错，401 时退回登录态 */
  async function api(url, options) {
    const res = await fetch(url, options);
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON */ }
    if (res.status === 401) {
      showLogin(true);
      throw new Error(data.error || "未登录或登录已过期");
    }
    if (!res.ok) throw new Error(data.error || ("请求失败 " + res.status));
    return data;
  }

  function coverSrc(book) {
    if (!book.cover_url) return "";
    return String(book.cover_url).startsWith("/uploads/")
      ? book.cover_url
      : "/covers?u=" + encodeURIComponent(book.cover_url);
  }

  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || "")) ? String(u) : "";
  }

  function starsHTML(rating) {
    if (rating == null || rating < 1) return '<span class="stars"><span class="dim">☆☆☆☆☆</span></span>';
    const filled = "★".repeat(Math.min(5, Math.max(1, rating)));
    const dim = "★".repeat(5 - Math.min(5, Math.max(1, rating)));
    return '<span class="stars"><span class="filled">' + filled + '</span><span class="dim">' + dim + "</span></span>";
  }

  // ---------- 登录 ----------
  const loginView = el("login-view");
  const dashView = el("dash-view");
  const btnLogout = el("btn-logout");
  const whoami = el("whoami");

  function showLogin(show) {
    loginView.hidden = !show;
    dashView.hidden = show;
  }

  el("btn-login").addEventListener("click", async () => {
    const username = el("login-username").value.trim();
    const password = el("login-password").value;
    const msg = el("login-msg");
    if (!username || !password) return (msg.textContent = "请填写用户名和密码");
    msg.textContent = "";
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      msg.className = "form-msg ok";
      msg.textContent = "登录成功 ✓";
      enterDash();
    } catch (e) {
      msg.className = "form-msg error";
      msg.textContent = e.message;
    }
  });

  el("login-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") el("btn-login").click();
  });

  btnLogout.addEventListener("click", async () => {
    try { await api("/api/admin/logout", { method: "POST" }); } catch { /* ignore */ }
    showLogin(true);
  });

  async function enterDash() {
    showLogin(false);
    buildNav();
    switchTab("shelf");
    await loadBooks();
  }

  // ---------- 导航 ----------
  const NAVS = [
    { key: "shelf", label: "书架管理" },
    { key: "import", label: "批量导入" },
    { key: "settings", label: "设置" },
  ];
  let currentTab = "shelf";

  function buildNav() {
    const nav = el("admin-nav");
    nav.innerHTML = "";
    NAVS.forEach((n) => {
      const b = document.createElement("button");
      b.className = "nav-btn" + (n.key === currentTab ? " active" : "");
      b.textContent = n.label;
      b.dataset.nav = n.key;
      b.addEventListener("click", () => switchTab(n.key));
      nav.appendChild(b);
    });
  }

  function switchTab(key) {
    currentTab = key;
    el("view-shelf").hidden = key !== "shelf";
    el("view-import").hidden = key !== "import";
    el("view-settings").hidden = key !== "settings";
    document.querySelectorAll(".nav-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.nav === key)
    );
    if (key === "shelf") loadBooks();
    if (key === "settings") loadSettings();
    if (key === "import") {
      // 预填默认电子书目录
      api("/api/admin/settings")
        .then((s) => { if (s.pdfDir && !el("imp-pdf-dir").value) el("imp-pdf-dir").value = s.pdfDir; })
        .catch(() => {});
    }
  }

  // ---------- 书籍列表 ----------
  const bookList = el("book-list");
  const bookEmpty = el("book-empty");

  function badgeOf(b) {
    const list = [];
    if (b.physical) list.push('<span class="badge badge-physical">实体</span>');
    if (b.ebook) list.push('<span class="badge badge-ebook">电子</span>');
    if (b.read) list.push('<span class="badge badge-read">已读</span>');
    return list.join("");
  }

  function renderBooks(books) {
    bookList.innerHTML = "";
    bookEmpty.hidden = books.length > 0;
    books.forEach((b) => {
      const item = document.createElement("div");
      item.className = "book-item";
      const src = coverSrc(b);
      const dbUrl = safeUrl(b.douban_url);
      // 有豆瓣链接时，封面和书名可点击跳豆瓣
      const coverHtml = src
        ? (dbUrl
            ? '<a class="thumb-link" href="' + esc(dbUrl) + '" target="_blank" rel="noopener" title="打开豆瓣"><img class="thumb" src="' + src + '" alt=""></a>'
            : '<img class="thumb" src="' + src + '" alt="">')
        : '<div class="thumb-ph">📖</div>';
      const titleHtml = dbUrl
        ? '<a class="t" href="' + esc(dbUrl) + '" target="_blank" rel="noopener" title="打开豆瓣">' + esc(b.title) + ' ↗</a>'
        : '<span class="t">' + esc(b.title) + "</span>";
      item.innerHTML =
        coverHtml +
        '<div class="body">' +
          '<div class="title-row">' + titleHtml + badgeOf(b) + "</div>" +
          '<div class="meta">' +
            [b.author, b.isbn ? "ISBN " + b.isbn : ""].filter(Boolean).join(" · ") +
            (b.rating ? " · " + b.rating + " 星" : "") +
          "</div>" +
        "</div>" +
        '<div class="ops">' +
          '<button class="btn btn-ghost btn-sm" data-edit="' + b.id + '">编辑</button>' +
          '<button class="btn btn-ghost btn-sm btn-danger" data-del="' + b.id + '">删除</button>' +
        "</div>";
      item.querySelector("[data-edit]").addEventListener("click", () => openBookModal(b));
      item.querySelector("[data-del]").addEventListener("click", () => delBook(b));
      bookList.appendChild(item);
    });
  }

  async function loadBooks() {
    try {
      const params = new URLSearchParams();
      const q = el("admin-search").value.trim();
      if (q) params.set("q", q);
      const read = el("filt-read").value;
      const own = el("filt-own").value;
      const rated = el("filt-rated").value;
      const douban = el("filt-douban").value;
      const sort = el("filt-sort").value;
      if (read) params.set("read", read);
      if (own) params.set("own", own);
      if (rated) params.set("rated", rated);
      if (douban) params.set("douban", douban);
      if (sort) params.set("sort", sort);
      const qs = params.toString();
      const data = await api("/api/admin/books" + (qs ? "?" + qs : ""));
      renderBooks(data.books);
      const total = data.total || data.books.length;
      el("book-total").textContent =
        "共 " + total + " 本" +
        (data.books.length < total ? "（筛选出 " + data.books.length + " 本）" : "");
    } catch (e) { showToast(e.message, "error"); }
  }

  let searchTimer = null;
  el("admin-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadBooks, 250);
  });
  ["filt-read", "filt-own", "filt-rated", "filt-douban", "filt-sort"].forEach((id) =>
    el(id).addEventListener("change", loadBooks)
  );
  // 重置筛选
  el("btn-reset-filters").addEventListener("click", () => {
    el("admin-search").value = "";
    ["filt-read", "filt-own", "filt-rated", "filt-douban"].forEach((id) => (el(id).value = ""));
    el("filt-sort").value = "rating"; // 排序保持默认评分
    loadBooks();
  });

  async function delBook(b) {
    if (!confirm("确定删除《" + b.title + "》吗？")) return;
    try {
      await api("/api/admin/books/" + b.id, { method: "DELETE" });
      showToast("已删除 ✓", "ok");
      loadBooks();
    } catch (e) { showToast(e.message, "error"); }
  }

  // ---------- 添加 / 编辑书籍 ----------
  const bookModal = el("book-modal");
  let editingId = null;
  let selectedBook = null;
  let pickedRating = null;
  let bookOpSeq = 0; // 弹窗操作版本号：重置/关闭时自增，过期异步回调丢弃

  const BOOK_FIELDS = ["title", "author", "isbn", "douban-url", "cover", "physical", "ebook", "read"];

  function resetBookForm() {
    bookOpSeq += 1; // 使尚未返回的异步回调失效
    selectedBook = null;
    pickedRating = null;
    editingId = null;
    BOOK_FIELDS.forEach((f) => {
      const e = el("f-" + f);
      if (e && e.type === "checkbox") e.checked = false;
      else if (e) e.value = "";
    });
    el("book-summary").hidden = true;
    el("book-summary-title").textContent = "";
    el("book-summary-meta").textContent = "";
    el("cover-preview-img").src = "";
    el("cover-preview-img").hidden = true;
    el("douban-results").hidden = true;
    el("douban-results").innerHTML = "";
    updateRatingPicker();
    el("book-msg").textContent = "";
  }

  function fillBookForm(b) {
    el("f-title").value = b.title || "";
    el("f-author").value = b.author || "";
    el("f-isbn").value = b.isbn || "";
    el("f-douban-url").value = b.douban_url || "";
    el("f-cover").value = b.cover_url || "";
    el("f-physical").checked = !!b.physical;
    el("f-ebook").checked = !!b.ebook;
    el("f-read").checked = !!b.read;
    pickedRating = b.rating || null;
    updateRatingPicker();
  }

  function openBookModal(b) {
    resetBookForm();
    el("book-modal-title").textContent = b ? "编辑书籍" : "添加书籍";
    if (b) { editingId = b.id; fillBookForm(b); }
    bookModal.classList.add("open");
    document.body.style.overflow = "hidden";
    setTimeout(() => el("f-title").focus(), 100);
  }

  function closeBookModal() {
    bookOpSeq += 1; // 关闭弹窗也使尚未返回的异步回调失效
    bookModal.classList.remove("open");
    document.body.style.overflow = "";
  }

  el("btn-new-book").addEventListener("click", () => openBookModal(null));

  // 补全缺失 ISBN（后台任务 + 进度）
  el("btn-fill-isbn").addEventListener("click", async () => {
    const btn = el("btn-fill-isbn");
    const prog = el("fill-isbn-progress");
    const bar = el("fill-isbn-bar");
    const progText = el("fill-isbn-progress-text");
    btn.disabled = true;
    prog.hidden = false;
    bar.style.width = "0%";
    progText.textContent = "正在统计缺 ISBN 的书…";
    try {
      const start = await api("/api/admin/books/fill-isbn", { method: "POST" });
      const j = await waitImportJob(start.jobId, (st) => {
        const pct = st.total ? Math.min(100, Math.round((st.processed / st.total) * 100)) : 0;
        bar.style.width = pct + "%";
        progText.textContent =
          "已处理 " + st.processed + " / " + (st.total || "?") + " 本，补全 " + st.matched + " 本" +
          (st.current ? "：正在《" + st.current + "》" : "");
      });
      prog.hidden = true;
      showToast(j.message || "补全完成", j.matched > 0 ? "ok" : "error");
      loadBooks();
    } catch (e) {
      prog.hidden = true;
      showToast(e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => closeBookModal())
  );
  // 只通过 ✕ / 「取消」关闭，点击弹窗外部不关闭（防误触）

  // 评分点选
  function updateRatingPicker() {
    el("rating-picker").querySelectorAll("[data-star]").forEach((b) => {
      const s = Number(b.dataset.star);
      b.classList.toggle("on", pickedRating != null && s <= pickedRating);
    });
  }
  el("rating-picker").addEventListener("click", (e) => {
    const b = e.target.closest("[data-star]");
    if (b) {
      pickedRating = Number(b.dataset.star);
    } else if (e.target.classList.contains("rating-clear")) {
      pickedRating = null;
    }
    updateRatingPicker();
  });

  // 封面上传
  el("f-cover-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await api("/api/admin/upload", { method: "POST", body: fd });
      el("f-cover").value = data.url;
      showToast("封面上传成功 ✓", "ok");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      e.target.value = "";
    }
  });

  // 豆瓣搜索（添加/编辑弹窗内）
  async function selectBook(book) {
    const results = el("douban-results");
    const seq = bookOpSeq; // 记住本次操作版本号
    results.innerHTML = '<div class="db-loading">获取书籍详情…</div>';
    try {
      let full = book;
      if (book.url) {
        const res = await fetch("/api/douban/info?url=" + encodeURIComponent(book.url));
        if (res.ok) full = { ...book, ...(await res.json()) };
      }
      // 弹窗在此期间被重置/关闭/打开过 → 丢弃本次结果，避免残留上一本书的信息
      if (seq !== bookOpSeq) return;
      applyDoubanBook(full);
      results.hidden = true;
      el("book-msg").textContent = "已获取书籍信息 ✓";
      el("book-msg").className = "form-msg ok";
    } catch (e) {
      if (seq !== bookOpSeq) return;
      el("book-msg").textContent = e.message;
      el("book-msg").className = "form-msg error";
      results.hidden = true;
    }
  }

  /** 用豆瓣书籍信息覆盖当前表单（搜索选中 / 按链接补全共用） */
  function applyDoubanBook(full) {
    selectedBook = {
      title: full.title || "",
      author: full.author || "",
      isbn: full.isbn || "",
      douban_url: full.url || full.douban_url || "",
      cover_url: full.cover_url || "",
      douban_rating: full.douban_rating != null ? full.douban_rating : null,
    };
    // 总是用豆瓣结果覆盖当前表单（编辑/添加都一样）
    el("f-title").value = selectedBook.title;
    el("f-author").value = selectedBook.author;
    el("f-isbn").value = selectedBook.isbn;
    el("f-douban-url").value = selectedBook.douban_url;
    el("f-cover").value = selectedBook.cover_url;
    el("book-summary").hidden = false;
    const img = el("cover-preview-img");
    const src = selectedBook.cover_url
      ? "/covers?u=" + encodeURIComponent(selectedBook.cover_url)
      : "";
    if (src) { img.src = src; img.hidden = false; } else img.hidden = true;
    el("book-summary-title").textContent = selectedBook.title;
    el("book-summary-meta").textContent =
      [selectedBook.author, selectedBook.isbn ? "ISBN " + selectedBook.isbn : ""]
        .filter(Boolean).join(" · ");
  }

  // 按豆瓣链接补全信息
  el("btn-fill-url").addEventListener("click", async () => {
    const url = el("f-douban-url").value.trim();
    const msg = el("book-msg");
    if (!url) return (msg.textContent = "请先粘贴豆瓣读书链接", msg.className = "form-msg error");
    if (!/book\.douban\.com/.test(url)) return (msg.textContent = "这不是豆瓣读书链接", msg.className = "form-msg error");
    const btn = el("btn-fill-url");
    const seq = bookOpSeq; // 记住本次操作版本号
    btn.disabled = true;
    btn.textContent = "补全中…";
    try {
      const info = await api("/api/douban/info?url=" + encodeURIComponent(url));
      if (seq !== bookOpSeq) return; // 弹窗已重置/关闭 → 丢弃
      applyDoubanBook(info);
      msg.textContent = "已根据豆瓣链接补全 ✓";
      msg.className = "form-msg ok";
    } catch (e) {
      if (seq !== bookOpSeq) return;
      msg.textContent = e.message;
      msg.className = "form-msg error";
    } finally {
      if (seq === bookOpSeq) {
        btn.disabled = false;
        btn.textContent = "补全";
      }
    }
  });

  el("btn-douban").addEventListener("click", async () => {
    const q = el("f-title").value.trim();
    const msg = el("book-msg");
    const results = el("douban-results");
    if (!q) return (msg.textContent = "请先填写书名", msg.className = "form-msg error");
    const seq = bookOpSeq; // 记住本次操作版本号
    const btn = el("btn-douban");
    btn.disabled = true;
    btn.textContent = "搜索中…";
    try {
      const data = await api("/api/douban/search?q=" + encodeURIComponent(q));
      if (seq !== bookOpSeq) return; // 弹窗已重置/关闭 → 丢弃
      const list = data.results || [];
      results.innerHTML = "";
      if (!list.length) {
        results.innerHTML = '<div class="db-empty">没有找到相关书籍，可手动填写</div>';
        results.hidden = false;
        msg.textContent = "";
        return;
      }
      list.forEach((book) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "db-result";
        item.innerHTML =
          (book.cover_url
            ? '<img class="db-cover" src="/covers?u=' + encodeURIComponent(book.cover_url) + '" alt="">'
            : '<div class="db-cover db-cover-ph">📖</div>') +
          '<span class="db-info">' +
            '<span class="db-title">' + esc(book.title) + "</span>" +
            '<span class="db-meta">' + [book.author, book.year].filter(Boolean).join(" · ") + "</span>" +
          "</span>";
        item.addEventListener("click", () => selectBook(book));
        results.appendChild(item);
      });
      results.hidden = false;
      msg.textContent = "";
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "form-msg error";
      results.hidden = true;
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 豆瓣搜索";
    }
  });

  el("btn-save-book").addEventListener("click", async () => {
    const body = {
      title: el("f-title").value.trim(),
      author: el("f-author").value.trim() || (selectedBook ? selectedBook.author : ""),
      isbn: el("f-isbn").value.trim(),
      douban_url: el("f-douban-url").value.trim(),
      cover_url: el("f-cover").value.trim(),
      douban_rating: selectedBook && selectedBook.douban_rating != null ? selectedBook.douban_rating : undefined,
      physical: el("f-physical").checked ? 1 : 0,
      ebook: el("f-ebook").checked ? 1 : 0,
      read: el("f-read").checked ? 1 : 0,
      rating: pickedRating,
      source: "manual",
    };
    const msg = el("book-msg");
    if (!body.title) return (msg.textContent = "请填写书名", msg.className = "form-msg error");
    const btn = el("btn-save-book");
    btn.disabled = true;
    try {
      if (editingId) {
        await api("/api/admin/books/" + editingId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        showToast("已保存 ✓", "ok");
      } else {
        const data = await api("/api/admin/books", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        showToast(data.updated ? "书架已有这本书，已更新 ✓" : "已添加 ✓", "ok");
      }
      closeBookModal();
      loadBooks();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "form-msg error";
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 导入 ----------
  // 渲染候选列表：source 决定默认勾选
  function renderCandidates(containerId, books, opts) {
    const box = el(containerId);
    box.innerHTML = "";
    if (!books || !books.length) {
      box.innerHTML = '<div class="db-empty">没有读到可导入的书</div>';
      return;
    }
    const list = document.createElement("div");
    list.className = "cand-list";
    const frag = document.createDocumentFragment();
    books.forEach((b, idx) => {
      const row = document.createElement("div");
      row.className = "cand-item";
      const src = b.cover_url ? "/covers?u=" + encodeURIComponent(b.cover_url) : "";
      const readDefault = b.defaultRead !== undefined ? b.defaultRead : (opts.read !== false ? 1 : 0);
      const matchBadge = b.matched !== undefined
        ? (b.matched
            ? (b.matchedFromShelf
                ? '<span class="match-badge match-high" title="书架已有这本（豆瓣）">书架匹配</span>'
                : '<span class="match-badge match-high">豆瓣匹配</span>')
            : '<span class="match-badge match-low">未匹配</span>')
        : "";
      const metaBits = [];
      if (b.author) metaBits.push(b.author);
      if (b.read_at) metaBits.push(b.read_at);
      if (b.my_rating) metaBits.push("豆瓣我评 " + b.my_rating + " 星");
      if (b.douban_rating) metaBits.push("豆瓣 " + b.douban_rating);
      if (b.file) metaBits.push(b.file);
      row.innerHTML =
        '<input type="checkbox" class="cand-check" checked data-idx="' + idx + '">' +
        (src
          ? '<img class="cand-cover" src="' + src + '" alt="">'
          : '<div class="cand-ph">📖</div>') +
        '<span class="cand-info">' +
          '<span class="cand-title">' + esc(b.title) + "</span> " + matchBadge +
          '<div class="cand-meta">' + metaBits.filter(Boolean).join(" · ") + "</div>" +
        "</span>" +
        '<span class="cand-ops">' +
          (opts.ebook !== undefined
            ? '<label><input type="checkbox" class="cand-ebook" data-idx="' + idx + '"' + (opts.ebook ? " checked" : "") + "> 电子</label>"
            : "") +
          '<label><input type="checkbox" class="cand-read" data-idx="' + idx + '"' + (readDefault ? " checked" : "") + "> 已读</label>" +
        "</span>";
      frag.appendChild(row);
    });
    list.appendChild(frag);
    box.appendChild(list);
    box._books = books;
  }

  function collectSelected(containerId, defaults) {
    const box = el(containerId);
    const rows = box.querySelectorAll(".cand-item");
    const out = [];
    rows.forEach((row) => {
      const idx = Number(row.querySelector(".cand-check").dataset.idx);
      const check = row.querySelector(".cand-check");
      if (!check.checked) return;
      const b = box._books[idx];
      if (!b) return;
      const ebookEl = row.querySelector(".cand-ebook");
      const readEl = row.querySelector(".cand-read");
      const ebook = ebookEl ? ebookEl.checked : defaults.ebook;
      const read = readEl ? readEl.checked : defaults.read;
      out.push({
        title: b.title,
        author: b.author || "",
        isbn: b.isbn || "",
        douban_url: b.douban_url || "",
        cover_url: b.cover_url || "",
        douban_rating: b.douban_rating != null ? b.douban_rating : undefined,
        physical: 0,
        ebook: ebook ? 1 : 0,
        read: read ? 1 : 0,
        rating: b.rating != null ? b.rating : (b.useRating ? b.my_rating || null : null),
        read_at: b.read_at || "",
        note: b.note || "",
        source: b.source || "manual",
      });
    });
    return out;
  }

  async function confirmImport(containerId, defaults) {
    const books = collectSelected(containerId, defaults);
    if (!books.length) { showToast("请至少选择一本书", "error"); return; }
    try {
      const data = await api("/api/admin/import/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ books }),
      });
      const msg =
        "导入完成：新增 " + data.added + " 本" +
        (data.skipped && data.skipped.length ? "，跳过重复 " + data.skipped.length + " 本" : "");
      showToast(msg, data.added ? "ok" : "error");
      el(containerId).innerHTML =
        '<div class="import-summary ' + (data.added ? "ok" : "warn") + '">' + msg +
        (data.skipped && data.skipped.length
          ? "<div>重复：" + esc(data.skipped.slice(0, 10).join("、")) + (data.skipped.length > 10 ? "…" : "") + "</div>"
          : "") +
        "</div>";
      loadBooks();
    } catch (e) { showToast(e.message, "error"); }
  }

  /** 轮询后台导入任务直到完成，onProgress(job) 每个周期回调 */
  function waitImportJob(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const st = await api("/api/admin/import/status?job=" + encodeURIComponent(jobId));
          const j = st.job;
          if (onProgress) onProgress(j);
          if (j.status === "done") { clearInterval(timer); resolve(j); }
          else if (j.status === "error") { clearInterval(timer); reject(new Error(j.error || "导入失败")); }
        } catch (e) { clearInterval(timer); reject(e); }
      }, 700);
    });
  }

  // ① 豆瓣（后台任务 + 进度）
  el("btn-imp-douban").addEventListener("click", async () => {
    const id = el("imp-douban-id").value.trim();
    const msg = el("imp-douban-msg");
    if (!id) return (msg.textContent = "请填写豆瓣 ID", msg.className = "form-msg error");
    const btn = el("btn-imp-douban");
    btn.disabled = true;
    const prog = el("imp-douban-progress");
    const bar = el("imp-douban-bar");
    const progText = el("imp-douban-progress-text");
    prog.hidden = false;
    bar.style.width = "0%";
    msg.textContent = "";
    try {
      const start = await api("/api/admin/import/douban", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      const j = await waitImportJob(start.jobId, (st) => {
        progText.textContent = "已拉取 " + st.processed + " 本" + (st.current ? "：《" + st.current + "》" : "");
      });
      prog.hidden = true;
      msg.textContent = (j.message || "拉到 " + (j.books || []).length + " 本") + " 勾选后点下方按钮导入：";
      msg.className = "form-msg " + (j.books && j.books.length ? "ok" : "warn");
      renderCandidates("imp-douban-list", j.books || [], { read: true }); // 豆瓣读书记录只标已读，不标电子
      const box = el("imp-douban-list");
      // 确认按钮
      const bar2 = document.createElement("div");
      bar2.className = "toolbar-row";
      bar2.innerHTML =
        '<label style="font-size:13px;color:var(--ink-soft);display:inline-flex;align-items:center;gap:4px;cursor:pointer;">' +
          '<input type="checkbox" id="imp-douban-use-rating"> 把我的豆瓣评分一起导入</label>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-sm" id="btn-confirm-douban">导入所选</button>';
      box.appendChild(bar2);
      el("btn-confirm-douban").addEventListener("click", () => {
        const useRating = el("imp-douban-use-rating").checked;
        if (useRating) {
          box._books.forEach((b) => { b.useRating = true; });
        }
        confirmImport("imp-douban-list", { read: true });
      });
    } catch (e) {
      prog.hidden = true;
      msg.textContent = e.message;
      msg.className = "form-msg error";
    } finally {
      btn.disabled = false;
    }
  });

  // ② 本地电子书（后台任务 + 进度）
  el("btn-imp-pdf").addEventListener("click", async () => {
    let dir = el("imp-pdf-dir").value.trim();
    if (!dir) dir = "";
    const msg = el("imp-pdf-msg");
    const btn = el("btn-imp-pdf");
    if (!dir) return (msg.textContent = "请填写电子书目录", msg.className = "form-msg error");
    btn.disabled = true;
    const prog = el("imp-pdf-progress");
    const bar = el("imp-pdf-bar");
    const progText = el("imp-pdf-progress-text");
    prog.hidden = false;
    bar.style.width = "0%";
    msg.textContent = "";
    try {
      const start = await api("/api/admin/import/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir, fetchDetail: el("imp-pdf-detail").checked, max: 1000 }),
      });
      const j = await waitImportJob(start.jobId, (st) => {
        const pct = st.total ? Math.min(100, Math.round((st.processed / st.total) * 100)) : 0;
        bar.style.width = pct + "%";
        progText.textContent =
          "已处理 " + st.processed + " / " + (st.total || "?") + " 本，匹配 " + st.matched + " 本" +
          (st.current ? "：正在《" + st.current + "》" : "");
      });
      prog.hidden = true;
      const books = j.books || [];
      const matched = books.filter((b) => b.matched).length;
      msg.textContent =
        "目录内共 " + (j.total || books.length) + " 个电子书文件，扫描到 " + books.length +
        " 个（匹配豆瓣 " + matched + " 个），勾选后导入：";
      msg.className = "form-msg ok";
      renderCandidates("imp-pdf-list", books, { ebook: true, read: true });
      const box = el("imp-pdf-list");
      const bar2 = document.createElement("div");
      bar2.className = "toolbar-row";
      bar2.innerHTML = '<span class="spacer"></span><button class="btn btn-sm" id="btn-confirm-pdf">导入所选</button>';
      box.appendChild(bar2);
      el("btn-confirm-pdf").addEventListener("click", () =>
        confirmImport("imp-pdf-list", { ebook: true, read: true })
      );
    } catch (e) {
      prog.hidden = true;
      msg.textContent = e.message;
      msg.className = "form-msg error";
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 设置 ----------
  async function loadSettings() {
    try {
      const s = await api("/api/admin/settings");
      // 回填已保存的值，刷新后依然可见
      el("set-douban-cookie").value = s.doubanCookie || "";
      el("set-douban-status").className = "setting-status " + (s.doubanCookieSet ? "yes" : "no");
      el("set-douban-status").textContent = s.doubanCookieSet
        ? "已配置 ✓（可直接修改覆盖）"
        : "未配置。豆瓣抓取可能不稳定，建议填写。";
      el("set-pdf-dir").value = s.pdfDir || "";
    } catch (e) { showToast(e.message, "error"); }
  }

  el("btn-save-settings").addEventListener("click", async () => {
    const msg = el("settings-msg");
    msg.textContent = "";
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doubanCookie: el("set-douban-cookie").value.trim(),
          pdfDir: el("set-pdf-dir").value.trim(),
        }),
      });
      msg.className = "form-msg ok";
      msg.textContent = "设置已保存 ✓";
      loadSettings();
    } catch (e) {
      msg.className = "form-msg error";
      msg.textContent = e.message;
    }
  });

  // ---------- 初始化 ----------
  async function init() {
    try {
      await api("/api/admin/me");
      enterDash();
    } catch {
      showLogin(true);
    }
  }
  init();
})();
