// Message decoration for hosted search steps and citations. The provider
// catalog, key/OAuth login and model binding were removed: a Bot runs on a
// local Agent chosen in agents.js and keeps that Agent's own configuration.
(() => {
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ""; if (text != null) n.textContent = text; return n; };
  function safeURL(value) { try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; } }
  function step(part) {
    const h = part.hosted;
    const running = !["completed", "failed"].includes(h.status);
    const n = node("div", "hs-step" + (running ? " running" : ""));
    n.dataset.hostedId = h.id;
    n.setAttribute("role", "status");
    const verb = running ? "正在搜索" : h.status === "failed" ? "搜索失败" : "已搜索";
    const query = String(h.query || "");
    const label = node("span", "", verb + (query ? "「" + query + "」" : ""));
    label.title = query;
    n.append(node("span", "hs-dot"), label, node("small", "", "厂商搜索 · 不进任务"));
    return n;
  }
  function progress(host, part) {
    if (!host || !part.hosted || part.hosted.name === "image_generation") return;
    const old = [...host.querySelectorAll(".hs-step")].find(n => n.dataset.hostedId === part.hosted.id);
    if (old) { if (!part.hosted.query) part = { ...part, hosted: { ...part.hosted, query: old._query || "" } }; const n = step(part); n._query = part.hosted.query; old.replaceWith(n); }
    else { const n = step(part); n._query = part.hosted.query; host.prepend(n); }
  }
  function citations(parts) { return (parts || []).filter(p => p.citation && safeURL(p.citation.url)); }
  function citedText(text, parts) {
    const cs = citations(parts), chars = Array.from(text);
    const marks = cs.map((p, i) => ({ at: Math.min(chars.length, Math.max(0, p.citation.end)), text: ` [${i + 1}](${safeURL(p.citation.url).replace(/\(/g, "%28").replace(/\)/g, "%29")})` }));
    marks.sort((a,b) => b.at - a.at);
    for (const m of marks) chars.splice(m.at, 0, m.text);
    return chars.join("");
  }
  function decorate(host, parts) {
    const hs = (parts || []).filter(p => p.hosted && p.hosted.name !== "image_generation");
    for (const p of hs.slice().reverse()) host.prepend(step(p));
    const cs = citations(parts); if (!cs.length) return;
    for (let i=0;i<cs.length;i++) {
      const url=safeURL(cs[i].citation.url);
      const a=[...host.querySelectorAll("a")].find(a=>a.href===url && a.textContent===String(i+1));
      if (a) {a.textContent=`[${i+1}]`;a.classList.add("hs-cite-mark");a.setAttribute("aria-label",`来源 ${i+1}`);}
    }
    const list = node("ol", "hs-cites");
    for (const p of cs) { const c = p.citation, url = safeURL(c.url), li = node("li"), a = node("a", "", c.title || url); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.append(node("small", "", new URL(url).hostname)); li.append(window.XBotLinkIcon(a)); list.append(li); }
    host.append(list);
  }
  window.XBotProviders = { decorate, citedText, progress };
})();
