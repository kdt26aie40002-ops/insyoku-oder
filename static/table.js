// テーブル端末（お客様用タブレット）
import { api, yen, el, toast, subscribe, storage, serialized, STATUS_LABEL, formatTime } from './common.js';

const $ = (selector) => document.querySelector(selector);
const MAX_QTY = 20;
const GUEST_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];
const THANKS_SECONDS = 8;
const SCREENS = ['setup', 'welcome', 'main', 'checkout', 'thanks'];

const parseTableId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const state = {
  tableId: parseTableId(new URLSearchParams(location.search).get('table')) ?? parseTableId(storage.get('tableId')),
  menu: null,
  table: null,
  cart: [], // [{menu_item_id, quantity}]
  categoryId: null,
  lastStatus: null,
  thanksTimer: null,
  dialogItem: null,
  dialogQty: 1,
  busy: false,
};

// ---------------------------------------------------------------- カート

const cartKey = () => `cart:${state.tableId}`;

function loadCart() {
  try {
    const saved = JSON.parse(storage.get(cartKey()) || '[]');
    state.cart = Array.isArray(saved)
      ? saved.filter((l) => Number.isInteger(l?.menu_item_id) && Number.isInteger(l?.quantity) && l.quantity > 0)
      : [];
  } catch {
    state.cart = [];
  }
}

function saveCart() {
  storage.set(cartKey(), JSON.stringify(state.cart));
}

function findMenuItem(id) {
  for (const category of state.menu?.categories ?? []) {
    const item = category.items.find((i) => i.id === id);
    if (item) return item;
  }
  return null;
}

function cartLines() {
  return state.cart
    .map((line) => ({ ...line, item: findMenuItem(line.menu_item_id) }))
    .filter((line) => line.item);
}

const cartCount = () => cartLines().reduce((sum, l) => sum + l.quantity, 0);
const cartTotal = () => cartLines().reduce((sum, l) => sum + l.item.price * l.quantity, 0);

function addToCart(id, qty) {
  const line = state.cart.find((l) => l.menu_item_id === id);
  if (line) line.quantity = Math.min(MAX_QTY, line.quantity + qty);
  else state.cart.push({ menu_item_id: id, quantity: Math.min(MAX_QTY, qty) });
  cartChanged();
}

function setQty(id, qty) {
  state.cart = qty <= 0
    ? state.cart.filter((l) => l.menu_item_id !== id)
    : state.cart.map((l) => (l.menu_item_id === id ? { ...l, quantity: Math.min(qty, MAX_QTY) } : l));
  cartChanged();
}

function clearCart() {
  state.cart = [];
  saveCart();
}

function cartChanged() {
  saveCart();
  renderCart();
  renderMenu();
  if ($('#review-dialog').open) renderReview();
}

// ---------------------------------------------------------------- 通信

const refresh = serialized(async () => {
  if (!state.tableId) return;
  try {
    const [menu, table] = await Promise.all([api('/api/menu'), api(`/api/tables/${state.tableId}`)]);
    state.menu = menu;
    state.table = table;
    render();
  } catch (err) {
    if (err.status === 404) forgetTable();
    else toast(err.message, 'error');
  }
});

async function startSession(guests) {
  if (state.busy) return;
  state.busy = true;
  try {
    state.table = await api(`/api/tables/${state.tableId}/session`, { method: 'POST', body: { guests } });
    render();
  } catch (err) {
    toast(err.message, 'error');
    refresh();
  } finally {
    state.busy = false;
  }
}

async function placeOrder() {
  const lines = cartLines();
  if (!lines.length || state.busy) return;
  state.busy = true;
  $('#btn-place-order').disabled = true;
  try {
    const res = await api(`/api/tables/${state.tableId}/orders`, {
      method: 'POST',
      body: { items: lines.map((l) => ({ menu_item_id: l.menu_item_id, quantity: l.quantity })) },
    });
    clearCart();
    $('#review-dialog').close();
    toast('ご注文を承りました。できあがりまで少々お待ちください。', 'success');
    state.table = res.table;
    render();
  } catch (err) {
    toast(err.message, 'error');
    refresh();
  } finally {
    state.busy = false;
    $('#btn-place-order').disabled = false;
  }
}

async function callStaff(kind) {
  try {
    state.table = await api(`/api/tables/${state.tableId}/calls`, { method: 'POST', body: { kind } });
    $('#call-dialog').close();
    toast(kind === 'water' ? 'お水をお持ちします。少々お待ちください。' : 'スタッフをお呼びしました。', 'success');
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function requestCheckout() {
  if (state.busy) return;
  state.busy = true;
  try {
    state.table = await api(`/api/tables/${state.tableId}/checkout-request`, { method: 'POST' });
    $('#checkout-dialog').close();
    render();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------- 画面

function showScreen(name) {
  for (const screen of SCREENS) $(`#${screen}-screen`).hidden = screen !== name;
  $('#topbar-actions').hidden = name !== 'main';
}

function closeDialogs(except = null) {
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (dialog.id !== except) dialog.close();
  }
}

function clearThanks() {
  clearTimeout(state.thanksTimer);
  state.thanksTimer = null;
}

function showThanks() {
  clearThanks();
  showScreen('thanks');
  state.thanksTimer = setTimeout(() => {
    state.thanksTimer = null;
    if (state.table?.status === 'vacant') showScreen('welcome');
  }, THANKS_SECONDS * 1000);
}

function render() {
  const table = state.table;
  $('#table-name').textContent = table.name;
  const previous = state.lastStatus;
  state.lastStatus = table.status;

  if (table.status === 'vacant') {
    if (previous === 'occupied' || previous === 'checkout') {
      // 会計が完了した：次のお客様のために表示をリセット
      clearCart();
      closeDialogs();
      showThanks();
    } else if (!state.thanksTimer) {
      showScreen('welcome');
    }
    return;
  }

  clearThanks();
  if (table.status === 'checkout') {
    $('#checkout-total').textContent = yen(table.total);
    closeDialogs('history-dialog');
    showScreen('checkout');
  } else {
    showScreen('main');
    renderMenu();
    renderCart();
    renderCallButton();
  }
  if ($('#history-dialog').open) renderHistory();
}

function renderMenu() {
  if (!state.menu) return;
  const categories = state.menu.categories;
  if (!categories.some((c) => c.id === state.categoryId)) state.categoryId = categories[0]?.id ?? null;

  $('#category-nav').replaceChildren(...categories.map((c) => el('button', {
    type: 'button',
    class: c.id === state.categoryId ? 'active' : '',
    onclick: () => {
      state.categoryId = c.id;
      renderMenu();
      $('.menu-area').scrollTop = 0;
    },
  }, c.name)));

  const category = categories.find((c) => c.id === state.categoryId);
  $('#category-title').textContent = category?.name ?? '';
  $('#menu-grid').replaceChildren(...(category?.items ?? []).map(menuCard));
}

function menuCard(item) {
  const inCart = state.cart.find((l) => l.menu_item_id === item.id)?.quantity ?? 0;
  return el('button', {
    type: 'button',
    class: `menu-card${item.sold_out ? ' sold-out' : ''}`,
    disabled: item.sold_out,
    onclick: () => openItemDialog(item),
  },
  el('span', { class: 'item-icon', 'aria-hidden': 'true' }, item.icon),
  el('span', { class: 'menu-name' }, item.name),
  el('span', { class: 'price' }, yen(item.price)),
  item.sold_out ? el('span', { class: 'sold-out-label' }, '売り切れ') : null,
  inCart ? el('span', { class: 'in-cart', 'aria-label': `カートに${inCart}点` }, `×${inCart}`) : null);
}

function stepper(line) {
  return el('div', { class: 'stepper small' },
    el('button', { type: 'button', 'aria-label': '減らす', onclick: () => setQty(line.menu_item_id, line.quantity - 1) }, '−'),
    el('output', {}, String(line.quantity)),
    el('button', {
      type: 'button',
      'aria-label': '増やす',
      disabled: line.quantity >= MAX_QTY,
      onclick: () => setQty(line.menu_item_id, line.quantity + 1),
    }, '＋'));
}

function cartLineElement(line) {
  return el('li', { class: line.item.sold_out ? 'sold-out' : '' },
    el('div', { class: 'line-main' },
      el('span', { class: 'line-name' }, `${line.item.icon} ${line.item.name}`),
      el('span', {}, yen(line.item.price * line.quantity))),
    line.item.sold_out ? el('span', { class: 'warning' }, '売り切れのため注文できません') : null,
    stepper(line));
}

function renderCart() {
  const lines = cartLines();
  $('#cart-list').replaceChildren(...lines.map(cartLineElement));
  $('#cart-empty').hidden = lines.length > 0;
  $('#cart-total').textContent = yen(cartTotal());
  const review = $('#btn-review');
  review.disabled = lines.length === 0;
  review.textContent = lines.length ? `注文内容の確認（${cartCount()}点）` : '注文内容の確認';
}

function renderReview() {
  const lines = cartLines();
  if (!lines.length) {
    $('#review-dialog').close();
    return;
  }
  $('#review-list').replaceChildren(...lines.map(cartLineElement));
  $('#review-total').textContent = yen(cartTotal());
  $('#btn-place-order').disabled = state.busy || lines.some((l) => l.item.sold_out);
}

function renderHistory() {
  const orders = state.table?.orders ?? [];
  $('#history-list').replaceChildren(...(orders.length
    ? [...orders].reverse().map((order) => el('section', { class: 'history-order' },
      el('h3', {}, `${formatTime(order.created_at)} のご注文`),
      el('ul', {}, ...order.items.map((item) => el('li', { class: item.status },
        el('span', { class: 'line-name' }, `${item.name} × ${item.quantity}`),
        el('span', { class: `badge status-${item.status}` }, STATUS_LABEL[item.status]),
        el('span', { class: 'line-price' }, item.status === 'cancelled' ? '—' : yen(item.subtotal)))))))
    : [el('p', { class: 'muted' }, 'まだご注文はありません')]));
  $('#history-total').textContent = yen(state.table?.total ?? 0);
}

function renderCallButton() {
  const calling = (state.table?.calls ?? []).some((c) => c.kind === 'staff' || c.kind === 'water');
  const button = $('#btn-call');
  button.classList.toggle('calling', calling);
  button.textContent = calling ? '🔔 呼び出し中…' : '🔔 店員呼び出し';
}

function openItemDialog(item) {
  state.dialogItem = item;
  state.dialogQty = 1;
  $('#item-icon').textContent = item.icon;
  $('#item-name').textContent = item.name;
  $('#item-desc').textContent = item.description;
  $('#item-price').textContent = yen(item.price);
  renderItemQty();
  $('#item-dialog').showModal();
}

function renderItemQty() {
  $('#item-qty').textContent = String(state.dialogQty);
  $('#item-minus').disabled = state.dialogQty <= 1;
  $('#item-plus').disabled = state.dialogQty >= MAX_QTY;
  $('#item-add').textContent = `カートに入れる（${yen(state.dialogItem.price * state.dialogQty)}）`;
}

// ---------------------------------------------------------------- テーブル設定

async function showSetup() {
  showScreen('setup');
  $('#table-name').textContent = 'テーブルオーダー';
  try {
    const { tables } = await api('/api/tables');
    $('#setup-tables').replaceChildren(...tables.map((t) => el('button', {
      type: 'button',
      onclick: () => selectTable(t.id),
    }, t.name)));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function selectTable(id) {
  state.tableId = id;
  state.lastStatus = null;
  storage.set('tableId', id);
  history.replaceState(null, '', `?table=${id}`);
  loadCart();
  refresh();
}

function forgetTable() {
  state.tableId = null;
  state.table = null;
  storage.remove('tableId');
  history.replaceState(null, '', location.pathname);
  showSetup();
}

// ---------------------------------------------------------------- 初期化

function init() {
  $('#guest-buttons').replaceChildren(...GUEST_CHOICES.map((n) => el('button', {
    type: 'button',
    onclick: () => startSession(n),
  }, `${n}名`)));

  $('#btn-change-table').addEventListener('click', forgetTable);
  $('#item-minus').addEventListener('click', () => { state.dialogQty -= 1; renderItemQty(); });
  $('#item-plus').addEventListener('click', () => { state.dialogQty += 1; renderItemQty(); });
  $('#item-add').addEventListener('click', () => {
    addToCart(state.dialogItem.id, state.dialogQty);
    $('#item-dialog').close();
  });
  $('#btn-review').addEventListener('click', () => {
    renderReview();
    $('#review-dialog').showModal();
  });
  $('#btn-place-order').addEventListener('click', placeOrder);

  const openHistory = () => {
    renderHistory();
    $('#history-dialog').showModal();
  };
  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-checkout-history').addEventListener('click', openHistory);

  $('#btn-call').addEventListener('click', () => $('#call-dialog').showModal());
  for (const button of document.querySelectorAll('[data-call]')) {
    button.addEventListener('click', () => callStaff(button.dataset.call));
  }

  $('#btn-checkout').addEventListener('click', () => {
    $('#confirm-checkout-total').textContent = yen(state.table?.total ?? 0);
    $('#checkout-cart-warning').hidden = cartLines().length === 0;
    $('#btn-request-checkout').disabled = (state.table?.orders ?? []).length === 0;
    $('#checkout-dialog').showModal();
  });
  $('#btn-request-checkout').addEventListener('click', requestCheckout);

  subscribe((event) => {
    if (!state.tableId) return;
    if (event.type === 'connected' || event.type === 'menu'
        || (event.type === 'table' && event.table_id === state.tableId)) {
      refresh();
    }
  });

  if (state.tableId) {
    storage.set('tableId', state.tableId);
    loadCart();
    refresh();
  } else {
    showSetup();
  }
}

init();
