// FatismAuth — 命運閣共用登入元件（palm / face / pricing / admin 共用）
// 依賴 Worker 的 /auth/* 端點；token 存 localStorage.fatism_token，帳號快取存 fatism_acct。
// 用法：
//   FatismAuth.token()                    → JWT or null
//   FatismAuth.account()                  → {email, role, credits} or null（快取）
//   await FatismAuth.me()                 → 向伺服器刷新帳號資料（token 失效回 null 並清除）
//   FatismAuth.openModal({lang, onSuccess}) → 開登入/註冊視窗
//   FatismAuth.logout()
//   FatismAuth.api(path, opts)            → fetch 包裝，自動帶 Authorization
window.FatismAuth = (function () {
  const WORKER_URL = 'https://fatism-credits.tonychuangtw.workers.dev';

  const I18N = {
    tw: {
      loginTitle: '登入命運閣', regTitle: '註冊新帳號',
      emailPh: '信箱', pwPh: '密碼（至少 8 碼）',
      loginBtn: '登入', regBtn: '註冊',
      toReg: '還沒有帳號？註冊送 3 點', toLogin: '已有帳號？直接登入',
      regNote: '新帳號免費送 3 點，手相／面相各體驗一次還有剩。點數在網頁版與 App 通用。',
      errEmail: '信箱格式不對', errPw: '密碼至少 8 碼',
      errExists: '這個信箱已註冊過，請直接登入', errWrong: '信箱或密碼錯誤',
      errNetwork: '連線失敗，請稍後再試', close: '關閉',
    },
    cn: {
      loginTitle: '登入命运阁', regTitle: '注册新帐号',
      emailPh: '信箱', pwPh: '密码（至少 8 码）',
      loginBtn: '登入', regBtn: '注册',
      toReg: '还没有帐号？注册送 3 点', toLogin: '已有帐号？直接登入',
      regNote: '新帐号免费送 3 点，手相／面相各体验一次还有剩。点数在网页版与 App 通用。',
      errEmail: '信箱格式不对', errPw: '密码至少 8 码',
      errExists: '这个信箱已注册过，请直接登入', errWrong: '信箱或密码错误',
      errNetwork: '连接失败，请稍后再试', close: '关闭',
    },
    en: {
      loginTitle: 'Sign in to Fatism', regTitle: 'Create account',
      emailPh: 'Email', pwPh: 'Password (min 8 chars)',
      loginBtn: 'Sign in', regBtn: 'Sign up',
      toReg: 'No account? Sign up for 3 free credits', toLogin: 'Have an account? Sign in',
      regNote: 'New accounts get 3 free credits — enough to try both palm and face reading. Credits are shared between web and app.',
      errEmail: 'Invalid email address', errPw: 'Password must be at least 8 characters',
      errExists: 'This email is already registered — please sign in', errWrong: 'Wrong email or password',
      errNetwork: 'Connection failed. Please try again.', close: 'Close',
    },
  };

  function token() {
    try { return localStorage.getItem('fatism_token') || null; } catch (e) { return null; }
  }
  function account() {
    try { return JSON.parse(localStorage.getItem('fatism_acct') || 'null'); } catch (e) { return null; }
  }
  function saveSession(data) {
    try {
      if (data.token) localStorage.setItem('fatism_token', data.token);
      localStorage.setItem('fatism_acct', JSON.stringify({
        email: data.email, role: data.role, credits: data.credits,
      }));
    } catch (e) {}
  }
  function logout() {
    try {
      localStorage.removeItem('fatism_token');
      localStorage.removeItem('fatism_acct');
    } catch (e) {}
  }

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers);
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    const t = token();
    if (t) opts.headers['Authorization'] = 'Bearer ' + t;
    return fetch(WORKER_URL + path, opts);
  }

  // 向伺服器刷新帳號資料；401 → 清 session 回 null
  async function me() {
    if (!token()) return null;
    try {
      const r = await api('/auth/me');
      if (r.status === 401) { logout(); return null; }
      if (!r.ok) return account();
      const d = await r.json();
      saveSession(d);
      return d;
    } catch (e) { return account(); }
  }

  // ---------- modal ----------

  let modalEl = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    const style = document.createElement('style');
    style.textContent = `
      .fa-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.78);
        display: none; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
      .fa-overlay.open { display: flex; }
      .fa-modal { background: linear-gradient(160deg, #2d1b5e 0%, #1a1340 100%);
        border: 1px solid #d4af37; border-radius: 16px; padding: 28px 26px 22px;
        max-width: 400px; width: 100%; color: #ece4d3; position: relative;
        box-shadow: 0 16px 48px rgba(0,0,0,0.6); font-family: inherit; }
      .fa-modal h2 { color: #d4af37; font-size: 21px; margin: 0 0 14px; letter-spacing: 0.05em; }
      .fa-modal input { width: 100%; padding: 11px 12px; margin: 6px 0;
        background: rgba(0,0,0,0.35); border: 1px solid #8a7028; border-radius: 8px;
        color: #ece4d3; font-family: inherit; font-size: 15px; box-sizing: border-box; }
      .fa-modal input:focus { outline: none; border-color: #d4af37; }
      .fa-note { color: #b3a98c; font-size: 12px; line-height: 1.6; margin: 8px 0 2px; }
      .fa-err { color: #eec9c9; background: rgba(180,60,60,0.15); border: 1px solid rgba(220,120,120,0.4);
        border-radius: 8px; padding: 8px 12px; font-size: 13px; margin: 8px 0 0; display: none; }
      .fa-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
      .fa-btn { font-family: inherit; font-size: 14px; font-weight: 600; letter-spacing: 0.06em;
        padding: 10px 22px; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
      .fa-btn-gold { background: linear-gradient(180deg, #d4af37 0%, #8a7028 100%);
        color: #1a1340; border: none; }
      .fa-btn-gold:disabled { opacity: 0.5; cursor: wait; }
      .fa-btn-ghost { background: transparent; color: #b3a98c; border: 1px solid #8a7028; }
      .fa-btn-ghost:hover { color: #d4af37; border-color: #d4af37; }
      .fa-switch { color: #b3a98c; font-size: 13px; margin-top: 14px; text-align: center;
        cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
      .fa-switch:hover { color: #d4af37; }
      .fa-x { position: absolute; top: 10px; right: 14px; background: none; border: none;
        color: #b3a98c; font-size: 22px; cursor: pointer; line-height: 1; padding: 4px; }
      .fa-x:hover { color: #d4af37; }
    `;
    document.head.appendChild(style);
    modalEl = document.createElement('div');
    modalEl.className = 'fa-overlay';
    modalEl.innerHTML = '<div class="fa-modal"></div>';
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
    document.body.appendChild(modalEl);
    return modalEl;
  }

  function closeModal() {
    if (modalEl) modalEl.classList.remove('open');
  }

  // opts: {lang: 'tw'|'cn'|'en', mode: 'login'|'register', onSuccess: fn(account)}
  function openModal(opts) {
    opts = opts || {};
    const lang = I18N[opts.lang] ? opts.lang : 'tw';
    const t = (k) => I18N[lang][k];
    let mode = opts.mode === 'register' ? 'register' : 'login';
    const overlay = ensureModal();
    const box = overlay.querySelector('.fa-modal');

    function render() {
      const isReg = mode === 'register';
      box.innerHTML = `
        <button class="fa-x" type="button">×</button>
        <h2>${isReg ? t('regTitle') : t('loginTitle')}</h2>
        <input type="email" class="fa-email" placeholder="${t('emailPh')}" autocomplete="email">
        <input type="password" class="fa-pw" placeholder="${t('pwPh')}"
          autocomplete="${isReg ? 'new-password' : 'current-password'}">
        ${isReg ? `<p class="fa-note">${t('regNote')}</p>` : ''}
        <div class="fa-err"></div>
        <div class="fa-actions">
          <button class="fa-btn fa-btn-ghost fa-cancel" type="button">${t('close')}</button>
          <button class="fa-btn fa-btn-gold fa-submit" type="button">${isReg ? t('regBtn') : t('loginBtn')}</button>
        </div>
        <div class="fa-switch">${isReg ? t('toLogin') : t('toReg')}</div>
      `;
      box.querySelector('.fa-x').onclick = closeModal;
      box.querySelector('.fa-cancel').onclick = closeModal;
      box.querySelector('.fa-switch').onclick = () => { mode = isReg ? 'login' : 'register'; render(); };
      const emailIn = box.querySelector('.fa-email');
      const pwIn = box.querySelector('.fa-pw');
      const errEl = box.querySelector('.fa-err');
      const submit = box.querySelector('.fa-submit');

      function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

      async function go() {
        const email = emailIn.value.trim().toLowerCase();
        const pw = pwIn.value;
        if (!email.includes('@')) return showErr(t('errEmail'));
        if (pw.length < 8) return showErr(t('errPw'));
        errEl.style.display = 'none';
        submit.disabled = true;
        try {
          const r = await api(isReg ? '/auth/register' : '/auth/login', {
            method: 'POST', body: { email, password: pw },
          });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.token) {
            saveSession(d);
            closeModal();
            if (opts.onSuccess) opts.onSuccess(account());
            return;
          }
          if (r.status === 409) showErr(t('errExists'));
          else if (r.status === 401) showErr(t('errWrong'));
          else if (d.error && d.error.startsWith('password')) showErr(t('errPw'));
          else if (d.error === 'invalid email') showErr(t('errEmail'));
          else showErr(t('errNetwork'));
        } catch (e) {
          showErr(t('errNetwork'));
        } finally {
          submit.disabled = false;
        }
      }
      submit.onclick = go;
      pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      setTimeout(() => emailIn.focus(), 50);
    }

    render();
    overlay.classList.add('open');
  }

  return { WORKER_URL, token, account, me, api, openModal, closeModal, logout, saveSession };
})();
