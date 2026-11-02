// Web search belongs to each Bot's local Agent: clowder-bot keeps no search
// provider, key or mode. The pane only explains that and shows the server's note.
(() => {
  let teardown = () => {};
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ""; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, action) => { const b = node("button", cls, text); b.type = "button"; b.onclick = action; return b; };
  async function mount({api, host, isCurrent, manage = () => {}}) {
    teardown();
    let alive = true;
    const current = () => alive && isCurrent();
    teardown = () => { alive = false; host.replaceChildren(); };
    host.className = "web-search-settings";
    const error = node("p", "ws-error"); error.setAttribute("role", "alert"); error.hidden = true;
    const rows = node("div", "setrows"), row = node("div", "setrow"), tx = node("div", "tx");
    tx.append(node("b", "", "由本地 Agent 管理"), node("div", "hint", "clowder-bot 不单独保存搜索密钥，也不切换厂商搜索。Bot 能不能联网查资料，以它所用 Agent 的能力、本机配置和权限为准。"));
    row.append(tx, button("btn sec", "查看本地 Agent", () => manage())); rows.append(row);
    const note = node("p", "setfoot", "正在读取说明…"); note.setAttribute("role", "status");
    host.replaceChildren(node("h2", "", "网页搜索"), node("p", "setlead", "要不要查网页、用什么来源查，由执行 Bot 的本地 Agent 决定。"), error, rows, note);
    let data;
    try { data = await api("/xbot-api/web-search"); }
    catch { if (current()) { note.hidden = true; error.textContent = "没能读取网页搜索说明，请重新打开试试。"; error.hidden = false; } return; }
    if (!current()) return;
    note.textContent = (data && data.reason) || "";
    note.hidden = !note.textContent;
  }
  window.XBotWebSearch = {mount, unmount:() => teardown()};
})();
