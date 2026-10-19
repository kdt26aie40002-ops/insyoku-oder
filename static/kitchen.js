// キッチン画面：未提供の注文をチケット形式で表示する
import { api, el, toast, subscribe, serialized, STATUS_LABEL, formatTime, elapsedMinutes, beep } from './common.js';

const $ = (selector) => document.querySelector(selector);
const WARN_MINUTES = 10;
const LATE_MINUTES = 15;

const state = { orders: [], knownOrderIds: null, freshOrderIds: new Set() };

const refresh = serialized(async () => {
  try {
    const { orders } = await api('/api/kitchen');
    const ids = new Set(orders.map((o) => o.order_id));
    // 初回読み込み時は「新着」扱いしない
    const fresh = state.knownOrderIds ? orders.filter((o) => !state.knownOrderIds.has(o.order_id)) : [];
    state.knownOrderIds = ids;
    state.orders = orders;
    if (fresh.length) {
      state.freshOrderIds = new Set(fresh.map((o) => o.order_id));
      beep();
      setTimeout(() => { state.freshOrderIds.clear(); }, 4000);
    }
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function setStatus(item, status) {
  try {
    await api(`/api/order-items/${item.id}`, { method: 'PATCH', body: { status } });
    refresh();
  } catch (err) {
    toast(err.message, 'error');
    refresh();
  }
}

function render() {
  const items = state.orders.flatMap((o) => o.items);
  $('#count-pending').textContent = items.filter((i) => i.status === 'pending').length;
  $('#count-cooking').textContent = items.filter((i) => i.status === 'cooking').length;
  $('#empty').hidden = state.orders.length > 0;
  $('#tickets').replaceChildren(...state.orders.map(ticket));
  renderClock();
}

function ticket(order) {
  const minutes = elapsedMinutes(order.created_at);
  const classes = ['ticket'];
  if (minutes >= LATE_MINUTES) classes.push('late');
  else if (minutes >= WARN_MINUTES) classes.push('warn');
  if (state.freshOrderIds.has(order.order_id)) classes.push('fresh');
  return el('article', { class: classes.join(' ') },
    el('header', {},
      el('span', { class: 'ticket-table' }, order.table_name),
      el('span', { class: 'ticket-meta' }, `#${order.order_id}・${formatTime(order.created_at)}・${minutes}分経過`)),
    order.allergen_labels.length
      ? el('p', { class: 'ticket-allergy' }, `⚠ アレルギー：${order.allergen_labels.join('・')}`)
      : null,
    el('ul', {}, ...order.items.map(itemRow)));
}

function itemRow(item) {
  const actions = item.status === 'pending'
    ? [
      el('button', { type: 'button', class: 'primary', onclick: () => setStatus(item, 'cooking') }, '調理開始'),
      el('button', {
        type: 'button',
        class: 'ghost',
        onclick: () => { if (confirm(`「${item.name}」を取り消しますか？`)) setStatus(item, 'cancelled'); },
      }, '取消'),
    ]
    : [
      el('button', { type: 'button', class: 'success', onclick: () => setStatus(item, 'served') }, '提供済'),
      el('button', { type: 'button', class: 'ghost', onclick: () => setStatus(item, 'pending') }, '戻す'),
    ];
  return el('li', { class: `kitchen-item ${item.status}` },
    el('span', {}, el('span', { class: 'name' }, item.name), el('span', { class: 'qty' }, `×${item.quantity}`)),
    el('span', { class: `badge status-${item.status}` }, STATUS_LABEL[item.status]),
    el('div', { class: 'item-actions' }, ...actions));
}

function renderClock() {
  $('#clock').textContent = formatTime(new Date().toISOString());
}

subscribe((event) => {
  if (event.type === 'connected' || event.type === 'kitchen') refresh();
});
setInterval(render, 30_000); // 経過時間の表示を更新
refresh();
