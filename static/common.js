// 各画面で共通に使う小さなユーティリティ

export const STATUS_LABEL = { pending: '受付済', cooking: '調理中', served: '提供済', cancelled: '取消' };
export const CALL_LABEL = { staff: '店員呼び出し', water: 'お水', checkout: 'お会計' };
export const TABLE_STATUS_LABEL = { vacant: '空席', occupied: 'ご利用中', checkout: '会計待ち' };

export async function api(path, { method = 'GET', body } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw Object.assign(new Error('サーバーに接続できません'), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `通信エラー（${res.status}）`), { status: res.status });
  }
  return data;
}

export const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;

export function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function elapsedMinutes(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

// DOM 要素を組み立てる。文字列の子要素はテキストノードになる（innerHTML は使わない）
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function toast(message, kind = 'info') {
  let area = document.getElementById('toast-area');
  if (!area) {
    area = el('div', { id: 'toast-area', class: 'toast-area', 'aria-live': 'polite' });
    document.body.append(area);
  }
  const node = el('div', { class: `toast ${kind}` }, message);
  area.append(node);
  setTimeout(() => node.remove(), 3500);
}

// サーバーからのイベントを購読する。接続（再接続を含む）のたびに {type: 'connected'} を通知するので、
// 受け取った側は全件を再取得すれば取りこぼしが起きない。
export function subscribe(onEvent) {
  const source = new EventSource('/api/events');
  source.onopen = () => onEvent({ type: 'connected' });
  source.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* 不正なイベントは無視 */ }
  };
  return source;
}

// 非同期関数を直列化する。実行中に呼ばれたら、終了後にもう 1 回だけ実行する。
export function serialized(fn) {
  let running = null;
  let again = false;
  return function run() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* 保存できなくても動作は続ける */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* 同上 */ } },
};

let audioCtx = null;
export function beep() {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  } catch { /* ブラウザが音声を許可していない */ }
}

// <button data-close> で親の <dialog> を閉じる
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-close]');
  if (button) button.closest('dialog')?.close();
});

// おすすめ診断の選択肢（キーは api.py の AGE_GROUPS / GENDERS と一致させる）
export const AGE_OPTIONS = [
  ['child', '12歳以下'], ['teen', '13〜19歳'], ['20s', '20代'], ['30s', '30代'],
  ['40s', '40代'], ['50s', '50代'], ['60plus', '60歳以上'],
];
export const GENDER_OPTIONS = [['male', '男性'], ['female', '女性'], ['unspecified', '回答しない']];
