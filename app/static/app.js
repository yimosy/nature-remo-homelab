/* Remo Homelab フロントエンド */

const view = document.getElementById("view");
const nav = document.getElementById("nav");
const badge = document.getElementById("header-badge");

let me = null;          // { admin, device }
let tab = "control";
let pollTimer = null;
let learnState = null;  // 学習フロー中の状態

// ---------------------------------------------------------------- API

async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function toast(message, ms = 2500) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- 起動・状態遷移

async function boot() {
  clearTimeout(pollTimer);
  try {
    me = await api("/api/me");
  } catch (e) {
    view.innerHTML = `<div class="center"><div class="big">📡</div><p>サーバーに接続できません<br>${esc(e.message)}</p></div>`;
    pollTimer = setTimeout(boot, 5000);
    return;
  }

  const status = me.device?.status;
  if (me.admin || status === "approved") {
    badge.textContent = me.admin ? "👑 管理者" : `📱 ${me.device.name}`;
    nav.hidden = false;
    render();
  } else if (!me.device) {
    nav.hidden = true;
    badge.textContent = "";
    renderRegister();
  } else if (status === "pending") {
    nav.hidden = true;
    badge.textContent = `📱 ${me.device.name}`;
    renderPending();
    pollTimer = setTimeout(boot, 5000);
  } else { // blocked
    nav.hidden = true;
    view.innerHTML = `<div class="center"><div class="big">🚫</div><p>この端末はブロックされています。<br>管理者に問い合わせてください。</p></div>`;
  }
}

function renderRegister() {
  view.innerHTML = `
    <div class="center">
      <div class="big">👋</div>
      <p>この端末をリモコンとして使うには登録が必要です。<br>登録後、管理者の承認をお待ちください。</p>
    </div>
    <div class="card">
      <h2>端末を登録</h2>
      <input id="reg-name" placeholder="端末名(例: 父のiPhone)" maxlength="40">
      <button class="btn wide" id="reg-btn">登録する</button>
    </div>
    ${adminLoginCard()}`;
  document.getElementById("reg-btn").onclick = async () => {
    const name = document.getElementById("reg-name").value.trim();
    if (!name) { toast("端末名を入力してください"); return; }
    try {
      await api("/api/register", { body: { name } });
      boot();
    } catch (e) { toast(e.message); }
  };
  bindAdminLoginCard();
}

function renderPending() {
  view.innerHTML = `
    <div class="center">
      <div class="big">⏳</div>
      <p><b>${esc(me.device.name)}</b> は承認待ちです。<br>管理者が承認すると自動的に使えるようになります。</p>
    </div>
    ${adminLoginCard()}`;
  bindAdminLoginCard();
}

// 未承認画面からも管理者だけはログインできるようにする(初回セットアップ用)
function adminLoginCard() {
  return `
    <div class="card">
      <details>
        <summary class="muted" style="cursor:pointer">管理者の方はこちら</summary>
        <input id="pre-admin-token" type="password" placeholder="管理者トークン" style="margin-top:8px">
        <button class="btn wide" id="pre-admin-login">管理者ログイン</button>
      </details>
    </div>`;
}

function bindAdminLoginCard() {
  document.getElementById("pre-admin-login").onclick = async () => {
    try {
      await api("/api/admin/login", { body: { token: document.getElementById("pre-admin-token").value } });
      clearTimeout(pollTimer);
      await boot();
      toast("管理者としてログインしました");
    } catch (e) { toast(e.message); }
  };
}

// ---------------------------------------------------------------- タブ

nav.querySelectorAll("button").forEach(btn => {
  btn.onclick = () => {
    tab = btn.dataset.tab;
    nav.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
    learnState = null;
    render();
  };
});

function render() {
  if (tab === "control") renderControl();
  else renderSettings();
}

// ---------------------------------------------------------------- リモコン画面

async function renderControl() {
  let appliances;
  try {
    appliances = await api("/api/appliances");
  } catch (e) {
    view.innerHTML = `<div class="center"><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (!appliances.length) {
    view.innerHTML = `<div class="center"><div class="big">🛋️</div><p>まだ家電が登録されていません。<br>${me.admin ? "設定タブから Remo と家電を登録してください。" : "管理者が登録するまでお待ちください。"}</p></div>`;
    return;
  }
  // 部屋(Remo)ごとにグループ化して表示
  const rooms = [];
  for (const a of appliances) {
    let room = rooms.find(r => r.remoId === a.remo_id);
    if (!room) { room = { remoId: a.remo_id, name: a.remo_name, apps: [] }; rooms.push(room); }
    room.apps.push(a);
  }
  view.innerHTML = rooms.map(room => `
    <div class="room-header">📍 ${esc(room.name)}</div>
    ${room.apps.map(a => `
      <div class="card">
        <h2>${esc(a.icon)} ${esc(a.name)}</h2>
        ${a.signals.length
          ? `<div class="signal-grid">${a.signals.map(s =>
              `<button class="signal-btn" data-sid="${s.id}">${esc(s.name)}</button>`).join("")}</div>`
          : `<p class="muted">信号が未登録です</p>`}
      </div>`).join("")}`).join("");

  view.querySelectorAll(".signal-btn").forEach(btn => {
    btn.onclick = async () => {
      btn.classList.add("sending");
      btn.disabled = true;
      try {
        await api(`/api/signals/${btn.dataset.sid}/send`, { method: "POST" });
        if (navigator.vibrate) navigator.vibrate(30);
        btn.classList.add("sent");
      } catch (e) {
        btn.classList.add("error");
        toast(e.message);
      }
      setTimeout(() => {
        btn.classList.remove("sending", "sent", "error");
        btn.disabled = false;
      }, 600);
    };
  });
}

// ---------------------------------------------------------------- 設定画面

async function renderSettings() {
  if (!me.admin) {
    view.innerHTML = `
      ${deviceInfoCard()}
      <div class="card">
        <h2>🔑 管理者ログイン</h2>
        <input id="admin-token" type="password" placeholder="管理者トークン">
        <button class="btn wide" id="admin-login">ログイン</button>
      </div>`;
    document.getElementById("admin-login").onclick = async () => {
      try {
        await api("/api/admin/login", { body: { token: document.getElementById("admin-token").value } });
        await boot();
        toast("管理者としてログインしました");
      } catch (e) { toast(e.message); }
    };
    return;
  }

  let devices = [], remos = [], appliances = [];
  try {
    [devices, remos, appliances] = await Promise.all([
      api("/api/admin/devices"), api("/api/remos"), api("/api/appliances"),
    ]);
  } catch (e) { toast(e.message); }

  view.innerHTML = `
    ${deviceInfoCard()}
    <div class="card">
      <h2>📱 端末の管理</h2>
      ${devices.length ? devices.map(d => `
        <div class="list-item">
          <div class="info">
            <div class="name">${esc(d.name)}</div>
            <div class="meta">登録: ${esc(d.created_at || "-")} / 最終: ${esc(d.last_seen || "-")}</div>
          </div>
          <span class="badge ${d.status}">${{ pending: "承認待ち", approved: "承認済み", blocked: "ブロック" }[d.status]}</span>
          ${d.status !== "approved" ? `<button class="btn small" data-dev="${d.id}" data-st="approved">承認</button>` : ""}
          ${d.status !== "blocked" ? `<button class="btn small danger" data-dev="${d.id}" data-st="blocked">拒否</button>` : ""}
          ${d.status === "blocked" ? `<button class="btn small danger" data-dev-del="${d.id}">削除</button>` : ""}
        </div>`).join("") : `<p class="muted">登録された端末はありません</p>`}
    </div>

    <div class="card">
      <h2>🛰️ Nature Remo</h2>
      ${remos.map(r => `
        <div class="list-item">
          <div class="info">
            <div class="name">${esc(r.name)}</div>
            <div class="meta">${esc(r.ip)}</div>
          </div>
          <button class="btn small secondary" data-test="${r.id}">接続確認</button>
          <button class="btn small danger" data-remo-del="${r.id}">削除</button>
        </div>`).join("")}
      <h3>Remo を追加</h3>
      <input id="remo-name" placeholder="名前(例: リビングのRemo)">
      <input id="remo-ip" placeholder="IPアドレス(例: 192.168.1.30)" inputmode="decimal">
      <button class="btn wide" id="remo-add">追加</button>
      <p class="muted">IP は Nature Remo アプリの「設定 → 端末情報」や、ルーターの DHCP 一覧で確認できます。固定 IP の割り当てを推奨します。</p>
    </div>

    <div class="card">
      <h2>🎛️ 家電と信号</h2>
      ${appliances.map(a => `
        <div class="list-item" style="flex-wrap:wrap">
          <div class="info">
            <div class="name">${esc(a.icon)} ${esc(a.name)}</div>
            <div class="meta">${esc(a.remo_name)} / 信号 ${a.signals.length} 件</div>
          </div>
          <button class="btn small" data-learn="${a.id}" data-learn-remo="${a.remo_id}">信号を学習</button>
          <button class="btn small danger" data-app-del="${a.id}">削除</button>
          ${a.signals.length ? `<div style="width:100%">${a.signals.map(s =>
            `<div class="list-item"><div class="info"><div class="name" style="font-weight:normal">・${esc(s.name)}</div></div>
             <button class="btn small danger" data-sig-del="${s.id}">削除</button></div>`).join("")}</div>` : ""}
        </div>`).join("")}
      ${remos.length ? `
        <h3>家電を追加</h3>
        <div class="row">
          <input id="app-icon" placeholder="絵文字" value="💡" maxlength="4" style="max-width:72px">
          <input id="app-name" placeholder="家電名(例: リビング照明)">
        </div>
        <select id="app-remo">${remos.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select>
        <button class="btn wide" id="app-add">追加</button>`
        : `<p class="muted">先に Remo を追加してください</p>`}
      <div id="learn-area"></div>
    </div>

    <div class="card">
      <button class="btn wide secondary" id="admin-logout">管理者ログアウト</button>
    </div>`;

  bindSettingsHandlers();
}

function deviceInfoCard() {
  const d = me.device;
  return `
    <div class="card">
      <h2>ℹ️ この端末</h2>
      <p class="muted">${d ? `「${esc(d.name)}」として登録済み` : "この端末は未登録です(管理者権限のみで操作中)"}</p>
    </div>`;
}

function bindSettingsHandlers() {
  const on = (sel, fn) => view.querySelectorAll(sel).forEach(el => { el.onclick = () => fn(el); });
  const guard = fn => async el => {
    try { await fn(el); } catch (e) { toast(e.message); }
  };

  on("[data-dev]", guard(async el => {
    await api(`/api/admin/devices/${el.dataset.dev}/status`, { body: { status: el.dataset.st } });
    renderSettings();
  }));
  on("[data-dev-del]", guard(async el => {
    if (!confirm("この端末を削除しますか?")) return;
    await api(`/api/admin/devices/${el.dataset.devDel}`, { method: "DELETE" });
    renderSettings();
  }));

  on("#remo-add", guard(async () => {
    const name = document.getElementById("remo-name").value.trim();
    const ip = document.getElementById("remo-ip").value.trim();
    if (!name || !ip) { toast("名前と IP を入力してください"); return; }
    await api("/api/remos", { body: { name, ip } });
    renderSettings();
  }));
  on("[data-test]", guard(async el => {
    el.disabled = true;
    try {
      await api(`/api/remos/${el.dataset.test}/test`, { method: "POST" });
      toast("✅ 接続できました");
    } finally { el.disabled = false; }
  }));
  on("[data-remo-del]", guard(async el => {
    if (!confirm("この Remo を削除しますか?(紐づく家電・信号も消えます)")) return;
    await api(`/api/remos/${el.dataset.remoDel}`, { method: "DELETE" });
    renderSettings();
  }));

  on("#app-add", guard(async () => {
    const name = document.getElementById("app-name").value.trim();
    if (!name) { toast("家電名を入力してください"); return; }
    await api("/api/appliances", { body: {
      name,
      icon: document.getElementById("app-icon").value.trim() || "🔘",
      remo_id: Number(document.getElementById("app-remo").value),
    }});
    renderSettings();
  }));
  on("[data-app-del]", guard(async el => {
    if (!confirm("この家電を削除しますか?(信号も消えます)")) return;
    await api(`/api/appliances/${el.dataset.appDel}`, { method: "DELETE" });
    renderSettings();
  }));
  on("[data-sig-del]", guard(async el => {
    if (!confirm("この信号を削除しますか?")) return;
    await api(`/api/signals/${el.dataset.sigDel}`, { method: "DELETE" });
    renderSettings();
  }));

  on("#admin-logout", guard(async () => {
    await api("/api/admin/logout", { method: "POST" });
    await boot();
    toast("ログアウトしました");
  }));

  on("[data-learn]", guard(el => startLearn(el.dataset.learn, el.dataset.learnRemo)));
}

async function startLearn(applianceId, remoId) {
  // 学習開始: 現在の最終受信信号をベースラインとして記録し、変化を自動監視する
  let baseline = null;
  try {
    baseline = (await api(`/api/remos/${remoId}/learn`, { method: "POST" })).payload;
  } catch (e) { toast(e.message); return; }
  learnState = { applianceId, remoId, baseline, polling: true, secondsLeft: 20 };
  renderLearnBox();
  pollLearn(learnState);
}

async function pollLearn(st) {
  while (learnState === st && st.polling && st.secondsLeft > 0) {
    await new Promise(r => setTimeout(r, 1000));
    if (learnState !== st || !st.polling) return;
    st.secondsLeft--;
    try {
      const { payload } = await api(`/api/remos/${st.remoId}/learn`, { method: "POST" });
      if (payload && JSON.stringify(payload) !== JSON.stringify(st.baseline)) {
        st.polling = false;
        renderLearnBox(payload);
        return;
      }
    } catch { /* 一時的な通信エラーは無視して監視を続ける */ }
    const counter = document.getElementById("learn-count");
    if (counter) counter.textContent = st.secondsLeft;
  }
  if (learnState === st && st.polling) {
    st.polling = false;
    st.timedOut = true;
    renderLearnBox();
  }
}

function renderLearnBox(captured) {
  const area = document.getElementById("learn-area");
  if (!learnState) { area.innerHTML = ""; return; }

  if (!captured && learnState.timedOut) {
    area.innerHTML = `
      <div class="learn-box">
        <p>⏱️ 信号を受信できませんでした</p>
        <p class="muted">リモコンを Remo 本体の正面 <b>10〜30cm</b> に近づけて、<br>もう一度試してください。<br>何度やってもダメな場合、そのリモコンは<br>赤外線ではなく電波(RF)式かもしれません。</p>
        <button class="btn wide" id="learn-retry2">もう一度試す</button>
        <button class="btn wide secondary" id="learn-cancel">キャンセル</button>
      </div>`;
    document.getElementById("learn-retry2").onclick = () => {
      const { applianceId, remoId } = learnState;
      startLearn(applianceId, remoId);
    };
  } else if (!captured) {
    area.innerHTML = `
      <div class="learn-box">
        <p>📡 <b>受信待機中… <span id="learn-count">${learnState.secondsLeft}</span> 秒</b></p>
        <p class="muted">実際のリモコンを Remo 本体の正面 <b>10〜30cm</b> に向けて、<br>学習したいボタンを <b>1回だけ</b> 押してください。<br>受信すると自動で次に進みます。</p>
        <button class="btn wide secondary" id="learn-cancel">キャンセル</button>
      </div>`;
  } else {
    area.innerHTML = `
      <div class="learn-box">
        <p>✅ 信号を受信しました(データ長: ${captured.data.length})</p>
        <input id="learn-name" placeholder="信号名(例: 電源, 温度+)">
        <button class="btn wide" id="learn-save">この信号を保存</button>
        <button class="btn wide secondary" id="learn-retry">もう一度受信する</button>
        <button class="btn wide secondary" id="learn-cancel">キャンセル</button>
      </div>`;
    document.getElementById("learn-save").onclick = async () => {
      const name = document.getElementById("learn-name").value.trim();
      if (!name) { toast("信号名を入力してください"); return; }
      try {
        await api(`/api/appliances/${learnState.applianceId}/signals`, { body: { name, payload: captured } });
        learnState = null;
        toast("💾 保存しました");
        renderSettings();
      } catch (e) { toast(e.message); }
    };
    document.getElementById("learn-retry").onclick = () => {
      const { applianceId, remoId } = learnState;
      startLearn(applianceId, remoId);
    };
  }

  area.querySelector("#learn-cancel").onclick = () => { learnState = null; renderLearnBox(); };
  area.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

boot();
