export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>预约邮件收件箱</title>
  <link rel="stylesheet" href="/assets/style.css">
  <script src="/assets/client.js" defer></script>
</head>
<body>
  <main class="shell">
    <header class="topbar"><strong>预约邮件收件箱</strong><span id="account"></span></header>
    <section id="login-view" class="card login">
      <h1>登录收件箱</h1>
      <p>查看发送到您专属邮箱的预约确认邮件。</p>
      <form id="login-form">
        <label>邮箱地址<input id="address" name="address" type="email" autocomplete="username" required></label>
        <label>密码<input id="password" name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">登录</button>
      </form>
      <p id="login-error" class="error" role="alert"></p>
    </section>
    <section id="inbox-view" hidden>
      <div class="toolbar"><h1>收件箱</h1><div class="toolbar-actions"><button id="refresh" class="secondary" type="button">刷新</button><button id="logout" class="secondary" type="button">退出登录</button></div></div>
      <p class="hint">这里展示的是该地址实际收到的邮件。邮件到期后将无法再登录查看。</p>
      <div class="layout">
        <div class="card list-panel"><h2>邮件</h2><div id="message-list" role="list"></div></div>
        <article class="card message-panel" aria-live="polite">
          <h2 id="message-subject">选择一封邮件</h2>
          <dl id="message-meta" hidden>
            <dt>发件人</dt><dd id="message-from"></dd>
            <dt>收件人</dt><dd id="message-to"></dd>
            <dt>时间</dt><dd id="message-date"></dd>
          </dl>
          <pre id="message-body"></pre>
          <a id="download" hidden>下载原始邮件（.eml）</a>
        </article>
      </div>
      <p id="inbox-error" class="error" role="alert"></p>
    </section>
  </main>
</body>
</html>`;

export const STYLE = `:root{color-scheme:light;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7fb;color:#172033}*{box-sizing:border-box}body{margin:0}.shell{max-width:1100px;margin:0 auto;padding:20px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px;color:#315db0}.card{background:white;border:1px solid #e1e7f0;border-radius:14px;box-shadow:0 6px 24px #1c2b4410}.login{max-width:420px;margin:9vh auto;padding:30px}.login h1{margin:0 0 8px;font-size:25px}.login p{color:#59677c}.login form{display:grid;gap:16px;margin-top:22px}label{display:grid;gap:7px;font-weight:600}input{width:100%;padding:12px 14px;border:1px solid #bcc9d9;border-radius:9px;font:inherit}input:focus{outline:2px solid #79a6f7}button{border:0;border-radius:9px;background:#2459b8;color:white;padding:11px 17px;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#16469e}.secondary{background:#e8eef8;color:#24406c}.secondary:hover{background:#dce6f6}.toolbar,.toolbar-actions{display:flex;align-items:center;gap:10px}.toolbar{justify-content:space-between}.toolbar h1{font-size:25px}.hint{color:#59677c;margin:0 0 18px}.layout{display:grid;grid-template-columns:minmax(240px,340px) 1fr;gap:16px}.list-panel,.message-panel{padding:20px;min-height:420px}.list-panel h2,.message-panel h2{font-size:19px;margin:0 0 16px;overflow-wrap:anywhere}.mail-item{display:block;width:100%;text-align:left;background:white;color:#172033;border-radius:8px;border:1px solid #e1e7f0;margin:8px 0;padding:12px}.mail-item:hover,.mail-item.active{background:#eef4ff;border-color:#9db8ed}.mail-item span{display:block;color:#64738a;font-size:13px;margin-top:5px}dl{display:grid;grid-template-columns:70px 1fr;gap:8px;margin:0 0 24px;color:#59677c}dd{margin:0;color:#172033;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif}a{color:#2459b8}.error{color:#b52634;min-height:1.4em}@media(max-width:700px){.shell{padding:12px}.topbar{font-size:14px}.layout{grid-template-columns:1fr}.list-panel,.message-panel{min-height:0}.login{margin:7vh auto;padding:22px}}`;

export const CLIENT = `const $ = (id) => document.getElementById(id);
let selectedId = null;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function showLogin() {
  $('login-view').hidden = false;
  $('inbox-view').hidden = true;
  $('account').textContent = '';
}

async function showInbox() {
  try {
    const me = await api('/api/me');
    $('account').textContent = me.address;
    $('login-view').hidden = true;
    $('inbox-view').hidden = false;
    await loadMessages();
  } catch {
    showLogin();
  }
}

async function loadMessages() {
  $('inbox-error').textContent = '';
  try {
    const data = await api('/api/messages');
    const list = $('message-list');
    list.replaceChildren();
    if (!data.messages.length) {
      const empty = document.createElement('p');
      empty.textContent = '尚未收到邮件，请稍后刷新页面。';
      list.append(empty);
      return;
    }
    for (const message of data.messages) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mail-item';
      button.textContent = message.subject || '(无主题)';
      const detail = document.createElement('span');
      detail.textContent = message.from + ' · ' + new Date(message.receivedAt).toLocaleString();
      button.append(detail);
      button.addEventListener('click', () => openMessage(message.id));
      list.append(button);
    }
    if (!selectedId) await openMessage(data.messages[0].id);
  } catch (error) {
    $('inbox-error').textContent = error.message;
  }
}

async function openMessage(id) {
  try {
    const message = await api('/api/messages/' + encodeURIComponent(id));
    selectedId = id;
    $('message-subject').textContent = message.subject;
    $('message-from').textContent = message.from;
    $('message-to').textContent = message.to;
    $('message-date').textContent = message.date || new Date(message.receivedAt).toLocaleString();
    $('message-body').textContent = message.text || '此邮件没有可显示的文本内容。可下载原始邮件查看。';
    $('message-meta').hidden = false;
    $('download').href = '/api/messages/' + encodeURIComponent(id) + '/raw';
    $('download').hidden = false;
  } catch (error) {
    $('inbox-error').textContent = error.message;
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: $('address').value, password: $('password').value }),
    });
    $('password').value = '';
    await showInbox();
  } catch (error) {
    $('login-error').textContent = error.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  selectedId = null;
  showLogin();
});

$('refresh').addEventListener('click', loadMessages);

showInbox();`;
