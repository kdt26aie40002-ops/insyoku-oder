// ホール / レジ画面：テーブル状況・呼び出し対応・会計・品切れ設定
import {
  api, yen, el, toast, subscribe, serialized, beep,
  STATUS_LABEL, CALL_LABEL, TABLE_STATUS_LABEL, formatTime, elapsedMinutes,
} from './common.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  tab: 'floor',
  tables: [],
  calls: [],
  menu: null,
  selectedTableId: null,
  guestInput: 2,
  knownCallIds: null,
};

// ---------------------------------------------------------------- 通信

const refreshFloor = serialized(async () => {
  try {
    const [{ tables }, { calls }] = await Promise.all([api('/api/tables'), api('/api/calls')]);
    const newCalls = state.knownCallIds ? calls.filter((c) => !state.knownCallIds.has(c.id)) : [];
    state.knownCallIds = new Set(calls.map((c) => c.id));
    state.tables = tables;
    state.calls = calls;
    if (newCalls.length) {
      beep();
      for (const call of newCalls) toast(`${call.table_name}：${CALL_LABEL[call.kind]}`);
    }
    renderFloor();
  } catch (err) {
    toast(err.message, 'error');
  }
});

const refreshMenu = serialized(async () => {
  try {
    state.menu = await api('/api/menu');
    renderMenuAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function run(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(result) : successMessage, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshFloor();
}

const resolveCall = (call) => run(() => api(`/api/calls/${call.id}/resolve`, { method: 'POST' }));

const seatGuests = (table) => run(
  () => api(`/api/tables/${table.id}/session`, { method: 'POST', body: { guests: Number(state.guestInput) } }),
  `${table.name} に ${state.guestInput}名様をご案内しました`,
);

const cancelItem = (item) => {
  if (!confirm(`「${item.name}」を取り消しますか？`)) return;
  run(() => api(`/api/order-items/${item.id}`, { method: 'PATCH', body: { status: 'cancelled' } }), '取り消しました');
};

const closeTable = (table) => {
  if (!confirm(`${table.name} の会計 ${yen(table.total)} を完了しますか？`)) return;
  run(
    () => api(`/api/tables/${table.id}/close`, { method: 'POST' }),
    (res) => `${table.name} の会計が完了しました（${yen(res.closed_session.total)}）`,
  );
};

async function toggleSoldOut(item) {
  try {
    await api(`/api/menu/${item.id}`, { method: 'PATCH', body: { sold_out: !item.sold_out } });
    toast(`「${item.name}」を${item.sold_out ? '販売中' : '売り切れ'}にしました`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshMenu();
}

// ---------------------------------------------------------------- 描画

function renderFloor() {
  renderCalls();
  $('#table-grid').replaceChildren(...state.tables.map(tableCard));
  renderDetail();
}

function renderCalls() {
  const count = $('#calls-count');
  count.hidden = state.calls.length === 0;
  count.textContent = state.calls.length;
  $('#calls-empty').hidden = state.calls.length > 0;
  $('#calls-list').replaceChildren(...state.calls.map((call) => el('li', { class: call.kind },
    el('span', { class: 'call-text' }, `${call.table_name}：${CALL_LABEL[call.kind]}`),
    el('span', { class: 'call-time' }, `${formatTime(call.created_at)}（${elapsedMinutes(call.created_at)}分前）`),
    call.kind === 'checkout'
      ? el('button', { type: 'button', class: 'primary', onclick: () => selectTable(call.table_id) }, '会計へ')
      : el('button', { type: 'button', class: 'success', onclick: () => resolveCall(call) }, '対応済'))));
}

function tableCard(table) {
  const pendingCount = table.orders
    .flatMap((o) => o.items)
    .filter((i) => i.status === 'pending' || i.status === 'cooking').length;
  return el('button', {
    type: 'button',
    class: `table-card ${table.status}${table.id === state.selectedTableId ? ' selected' : ''}`,
    onclick: () => selectTable(table.id),
  },
  el('span', { class: 'table-title' }, table.name),
  el('span', {}, TABLE_STATUS_LABEL[table.status]),
  table.session ? el('span', { class: 'muted' }, `${table.session.guests}名・${formatTime(table.session.started_at)}〜`) : null,
  table.session ? el('span', { class: 'table-total' }, yen(table.total)) : null,
  pendingCount ? el('span', { class: 'muted' }, `未提供 ${pendingCount}品`) : null,
  table.calls.length ? el('span', { class: 'call-flag', title: table.calls.map((c) => CALL_LABEL[c.kind]).join('・') }, '🔔') : null);
}

function selectTable(id) {
  state.selectedTableId = id;
  renderFloor();
  $('#table-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderDetail() {
  const box = $('#table-detail');
  const table = state.tables.find((t) => t.id === state.selectedTableId);
  if (!table) {
    box.replaceChildren(el('p', { class: 'muted' }, 'テーブルを選択すると詳細が表示されます'));
    return;
  }

  if (table.status === 'vacant') {
    const input = el('input', { type: 'number', min: 1, max: 20, value: state.guestInput, 'aria-label': '人数' });
    input.addEventListener('input', () => { state.guestInput = input.value; });
    box.replaceChildren(
      el('h2', {}, table.name),
      el('p', { class: 'detail-meta' }, '空席'),
      el('div', { class: 'seat-form' },
        el('label', {}, input, ' 名様'),
        el('button', { type: 'button', class: 'primary', onclick: () => seatGuests(table) }, '着席登録')),
      el('p', { class: 'muted' }, 'お客様がテーブル端末で人数を選んで開始することもできます。'),
    );
    return;
  }

  const orders = table.orders.length
    ? table.orders.map((order) => el('section', { class: 'detail-order' },
      el('h3', {}, `${formatTime(order.created_at)} 注文 #${order.id}`),
      el('ul', {}, ...order.items.map((item) => el('li', { class: item.status },
        el('span', { class: 'line-name' }, `${item.name} ×${item.quantity}　${item.status === 'cancelled' ? '' : yen(item.subtotal)}`),
        el('span', { class: `badge status-${item.status}` }, STATUS_LABEL[item.status]),
        item.status === 'pending' || item.status === 'cooking'
          ? el('button', { type: 'button', class: 'ghost', onclick: () => cancelItem(item) }, '取消')
          : el('span'))))))
    : [el('p', { class: 'muted' }, 'まだ注文はありません')];

  box.replaceChildren(
    el('h2', {}, table.name),
    el('p', { class: 'detail-meta' },
      `${TABLE_STATUS_LABEL[table.status]}・${table.session.guests}名・${formatTime(table.session.started_at)} 着席`),
    ...orders,
    el('div', { class: 'detail-total' }, el('span', {}, '合計（税込）'), el('strong', {}, yen(table.total))),
    el('div', { class: 'detail-actions' },
      el('button', { type: 'button', class: 'primary big', onclick: () => closeTable(table) }, '会計完了')),
  );
}

function renderMenuAdmin() {
  if (!state.menu) return;
  $('#menu-admin-list').replaceChildren(...state.menu.categories.map((category) => el('section', {},
    el('h2', {}, category.name),
    el('ul', {}, ...category.items.map((item) => el('li', { class: item.sold_out ? 'sold-out' : '' },
      el('span', { 'aria-hidden': 'true' }, item.icon),
      el('span', { class: 'menu-name' }, item.name),
      el('span', { class: 'muted' }, yen(item.price)),
      el('button', {
        type: 'button',
        class: item.sold_out ? 'sold-out' : 'on-sale',
        onclick: () => toggleSoldOut(item),
      }, item.sold_out ? '売り切れ' : '販売中')))))));
}

function showTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  $('#floor-view').hidden = tab !== 'floor';
  $('#menu-view').hidden = tab !== 'menu';
  if (tab === 'menu') refreshMenu();
}

// ---------------------------------------------------------------- 初期化

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

subscribe((event) => {
  if (event.type === 'connected' || event.type === 'table' || event.type === 'calls') refreshFloor();
  if ((event.type === 'connected' || event.type === 'menu') && state.tab === 'menu') refreshMenu();
});
setInterval(renderCalls, 30_000); // 経過時間の表示を更新
refreshFloor();
