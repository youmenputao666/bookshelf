/* 书架 · 前台逻辑（只读） */
(function () {
  "use strict";

  const state = {
    view: "physical", // physical / ebook / read
    sub: "",          // physical/ebook: "0"|"1"|""；read: ""|"ebook"|"physical"|"none"
    q: "",
    sort: "rating",   // 默认按我的评分排序
  };

  const el = (id) => document.getElementById(id);
  const grid = el("book-grid");
  const emptyState = el("empty-state");
  const summary = el("shelf-summary");
  const tabs = el("shelf-tabs");
  const subFilter = el("sub-filter");

  // 每个书架子筛选配置
  const SUB_FILTERS = {
    physical: [
      { val: "", label: "全部" },
      { val: "1", label: "已读" },
      { val: "0", label: "未读" },
    ],
    ebook: [
      { val: "", label: "全部" },
      { val: "1", label: "已读" },
      { val: "0", label: "未读" },
    ],
    read: [
      { val: "", label: "全部" },
      { val: "ebook", label: "电子" },
      { val: "physical", label: "实体" },
      { val: "none", label: "未拥有" },
    ],
  };

  // ---------- 工具 ----------
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || "")) ? String(u) : "";
  }

  function showToast(msg, type) {
    const t = el("toast");
    t.textContent = msg;
    t.className = "toast show" + (type ? " " + type : "");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => (t.className = "toast"), 2400);
  }

  // ---------- 渲染 ----------
  function coverSrc(book) {
    if (!book.cover_url) return "";
    return String(book.cover_url).startsWith("/uploads/")
      ? book.cover_url
      : "/covers?u=" + encodeURIComponent(book.cover_url);
  }

  function coverHTML(book, cls) {
    const src = coverSrc(book);
    if (!src) return '<div class="cover-ph ' + (cls || "") + '">📖<span>暂无封面</span></div>';
    return '<img class="' + (cls || "") + '" src="' + src + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
  }

  function starsHTML(rating) {
    if (rating == null || rating < 1) return '<span class="stars"><span class="dim">☆☆☆☆☆</span></span>';
    const filled = "★".repeat(Math.min(5, Math.max(1, rating)));
    const dim = "★".repeat(5 - Math.min(5, Math.max(1, rating)));
    return '<span class="stars"><span class="filled">' + filled + '</span><span class="dim">' + dim + "</span></span>";
  }

  function badgesHTML(book) {
    const list = [];
    if (book.physical) list.push('<span class="badge badge-physical">实体</span>');
    if (book.ebook) list.push('<span class="badge badge-ebook">电子</span>');
    if (book.read) list.push('<span class="badge badge-read">已读</span>');
    return list.length ? '<div class="card-badges">' + list.join("") + "</div>" : "";
  }

  function cardHTML(book) {
    const card = document.createElement("div");
    card.className = "book-card";
    const dbUrl = safeUrl(book.douban_url);
    card.innerHTML =
      '<div class="card-cover">' + coverHTML(book, "cover-img") + "</div>" +
      '<div class="card-body">' +
        '<div class="card-title" title="' + esc(book.title) + '">' + esc(book.title) + "</div>" +
        '<div class="card-author">' + esc(book.author || "佚名") + "</div>" +
        '<div class="card-rating">' + starsHTML(book.rating) + "</div>" +
        badgesHTML(book) +
      "</div>";
    card.addEventListener("click", () => {
      if (dbUrl) window.open(dbUrl, "_blank", "noopener");
      else showToast("这本书没有豆瓣链接", "error");
    });
    return card;
  }

  function renderBooks(data) {
    grid.innerHTML = "";
    emptyState.hidden = data.books.length > 0;
    summary.textContent = data.books.length > 0 ? "共 " + data.books.length + " 本" : "";
    data.books.forEach((b) => grid.appendChild(cardHTML(b)));
  }

  async function loadBooks() {
    const params = new URLSearchParams();
    params.set("view", state.view);
    if (state.view === "read") {
      if (state.sub) params.set("own", state.sub);
    } else {
      if (state.sub) params.set("read", state.sub);
    }
    if (state.q) params.set("q", state.q);
    if (state.sort) params.set("sort", state.sort);
    try {
      const res = await fetch("/api/books?" + params.toString());
      if (!res.ok) throw new Error("加载失败");
      renderBooks(await res.json());
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function loadStats() {
    try {
      const res = await fetch("/api/books/stats");
      if (!res.ok) return;
      const s = await res.json();
      const labels = {
        physical: "📕 实体书架",
        ebook: "📱 电子书架",
        read: "✅ 已读书架",
      };
      const counts = { physical: s.physical, ebook: s.ebook, read: s.read };
      tabs.querySelectorAll(".shelf-tab").forEach((btn) => {
        const view = btn.dataset.view;
        btn.innerHTML = labels[view] + '<span class="tab-count"> ' + counts[view] + "</span>";
      });
    } catch { /* 忽略 */ }
  }

  // ---------- 子筛选 ----------
  function renderSubFilter() {
    subFilter.innerHTML = "";
    const list = SUB_FILTERS[state.view] || [];
    list.forEach((f) => {
      const b = document.createElement("button");
      b.className = "chip" + (f.val === state.sub ? " active" : "");
      b.textContent = f.label;
      b.dataset.val = f.val;
      b.addEventListener("click", () => {
        state.sub = f.val;
        subFilter.querySelectorAll(".chip").forEach((c) =>
          c.classList.toggle("active", c.dataset.val === state.sub)
        );
        loadBooks();
      });
      subFilter.appendChild(b);
    });
  }

  // ---------- 事件 ----------
  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".shelf-tab");
    if (!btn) return;
    state.view = btn.dataset.view;
    state.sub = "";
    tabs.querySelectorAll(".shelf-tab").forEach((b) => b.classList.toggle("active", b === btn));
    renderSubFilter();
    loadBooks();
  });

  let searchTimer = null;
  el("search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      loadBooks();
    }, 250);
  });

  el("sort-select").addEventListener("change", (e) => {
    state.sort = e.target.value;
    loadBooks();
  });

  // ---------- 初始化 ----------
  renderSubFilter();
  loadStats();
  loadBooks();
})();
