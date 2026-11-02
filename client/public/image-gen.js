// Image generation belongs to each Bot's local Agent: clowder-bot keeps no
// drawing provider, account, key or switch. The pane only explains that and
// shows the server's note.
(() => {
  let teardown = () => {};
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ""; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, action) => { const b = node("button", cls, text); b.type = "button"; b.onclick = action; return b; };
  async function mount({api, host, isCurrent, manage = () => {}}) {
    teardown();
    let alive = true;
    const current = () => alive && isCurrent();
    teardown = () => { alive = false; host.replaceChildren(); };
    host.className = "web-search-settings image-gen-settings";
    const error = node("p", "ws-error"); error.setAttribute("role", "alert"); error.hidden = true;
    const rows = node("div", "setrows"), row = node("div", "setrow"), tx = node("div", "tx");
    tx.append(node("b", "", "由本地 Agent 管理"), node("div", "hint", "clowder-bot 不单独保存画图账号、密钥或模型。Bot 能不能画图，取决于它所用 Agent 本身的能力和本机配置。"));
    row.append(tx, button("btn sec", "查看本地 Agent", () => manage())); rows.append(row);
    const note = node("p", "setfoot", "正在读取说明…"); note.setAttribute("role", "status");
    host.replaceChildren(node("h2", "", "图片生成"), node("p", "setlead", "能不能画图、用哪个模型画，由执行 Bot 的本地 Agent 决定。"), error, rows, note);
    let data;
    try { data = await api("/xbot-api/image-gen"); }
    catch { if (current()) { note.hidden = true; error.textContent = "没能读取图片生成说明，请重新打开试试。"; error.hidden = false; } return; }
    if (!current()) return;
    note.textContent = (data && data.reason) || "";
    note.hidden = !note.textContent;
  }
  window.XBotImageGen = {mount, unmount:() => teardown()};
})();
