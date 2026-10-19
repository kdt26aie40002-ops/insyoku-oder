// テーブル端末（お客様用タブレット）
import {
  api, yen, el, toast, subscribe, storage, serialized, STATUS_LABEL, formatTime, AGE_OPTIONS, GENDER_OPTIONS,
} from './common.js';

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
  personal: { profile: null, items: [] }, // 年代・性別に合わせたおすすめ（/recommendations の結果）
  profileDraft: { age_group: null, gender: null },
  allergyDraft: new Set(),
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

// ---------------------------------------------------------------- アレルギー

const avoidedAllergens = () => new Set(state.table?.session?.allergens ?? []);

function allergenLabel(key) {
  return state.menu?.allergens.find((a) => a.key === key)?.label ?? key;
}

// 指定アレルゲンのうち、その商品に含まれるもの
function avoidedIn(item) {
  const avoid = avoidedAllergens();
  return item.allergens.filter((a) => avoid.has(a));
}

const isSafe = (item) => avoidedIn(item).length === 0;

function allergenSummary(item) {
  return item.allergens.length ? item.allergens.map(allergenLabel).join('・') : '表示対象のアレルギー物質なし';
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
    const [menu, table, personal] = await Promise.all([
      api('/api/menu'),
      api(`/api/tables/${state.tableId}`),
      // おすすめが取れなくても注文はできるようにする（ここの 404 をテーブル不明と誤解しない）
      api(`/api/tables/${state.tableId}/recommendations`).catch(() => ({ profile: null, items: [] })),
    ]);
    state.menu = menu;
    state.table = table;
    state.personal = personal;
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
    state.personal = { profile: null, items: [] };
    state.categoryId = null;
    render();
    openProfileDialog();
  } catch (err) {
    toast(err.message, 'error');
    refresh();
  } finally {
    state.busy = false;
  }
}

async function saveProfile() {
  const { age_group, gender } = state.profileDraft;
  if (!age_group || !gender || state.busy) return;
  state.busy = true;
  $('#btn-save-profile').disabled = true;
  try {
    state.table = await api(`/api/tables/${state.tableId}/profile`, { method: 'POST', body: { age_group, gender } });
    state.personal = await api(`/api/tables/${state.tableId}/recommendations`);
    state.categoryId = FOR_YOU;
    $('#profile-dialog').close();
    render();
    $('.menu-area').scrollTop = 0;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy = false;
    renderProfileOptions();
  }
}

function openAllergyDialog() {
  state.allergyDraft = avoidedAllergens();
  renderAllergyOptions();
  $('#allergy-dialog').showModal();
}

function renderAllergyOptions() {
  $('#allergy-options').replaceChildren(...(state.menu?.allergens ?? []).map(({ key, label }) => el('button', {
    type: 'button',
    class: state.allergyDraft.has(key) ? 'selected' : '',
    'aria-pressed': String(state.allergyDraft.has(key)),
    onclick: () => {
      if (state.allergyDraft.has(key)) state.allergyDraft.delete(key);
      else state.allergyDraft.add(key);
      renderAllergyOptions();
    },
  }, label)));
}

async function saveAllergies() {
  if (state.busy) return;
  state.busy = true;
  $('#btn-save-allergy').disabled = true;
  try {
    state.table = await api(`/api/tables/${state.tableId}/allergens`, {
      method: 'POST',
      body: { allergens: [...state.allergyDraft] },
    });
    state.personal = await api(`/api/tables/${state.tableId}/recommendations`).catch(() => state.personal);
    $('#allergy-dialog').close();
    toast(state.allergyDraft.size ? 'アレルギーを含む商品を非表示にしました' : 'アレルギーの設定を解除しました', 'success');
    render();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy = false;
    $('#btn-save-allergy').disabled = false;
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

const RECOMMENDED = 'recommended';
const FOR_YOU = 'for-you';

// 表示する区分：先頭から「あなたへのおすすめ」「本日のおすすめ」、続いて通常のカテゴリ
function menuSections() {
  const categories = state.menu.categories;
  const sections = categories.map((c) => ({ id: c.id, name: c.name, eyebrow: 'Menu', items: c.items.filter(isSafe) }));
  const recommended = categories.flatMap((c) => c.items).filter((i) => i.recommended && isSafe(i));
  if (recommended.length) {
    sections.unshift({
      id: RECOMMENDED,
      name: '本日のおすすめ',
      eyebrow: 'Recommended',
      lead: '料理長が自信をもってお届けする、当店自慢の逸品です。',
      items: recommended,
      featured: true,
    });
  }
  const { profile, items } = state.personal;
  const personalItems = items
    .map((r) => ({ item: findMenuItem(r.menu_item_id), reason: r.reason }))
    .filter((r) => r.item && isSafe(r.item));
  sections.unshift({
    id: FOR_YOU,
    name: 'あなたへのおすすめ',
    eyebrow: 'For You',
    lead: profile ? `${profile.label}のお客様におすすめのお料理を選びました。` : '',
    items: personalItems.map((r) => r.item),
    reasons: new Map(personalItems.map((r) => [r.item.id, r.reason])),
    featured: true,
    personal: true,
  });
  return sections;
}

function defaultSectionId(sections) {
  if (state.personal.profile) return FOR_YOU;
  return sections.find((s) => !s.personal)?.id ?? null;
}

function renderMenu() {
  if (!state.menu) return;
  const sections = menuSections();
  if (!sections.some((s) => s.id === state.categoryId)) state.categoryId = defaultSectionId(sections);

  $('#category-nav').replaceChildren(...sections.map((s) => el('button', {
    type: 'button',
    class: [s.featured ? 'featured' : '', s.personal ? 'personal' : '', s.id === state.categoryId ? 'active' : '']
      .join(' ').trim(),
    onclick: () => {
      state.categoryId = s.id;
      renderMenu();
      $('.menu-area').scrollTop = 0;
    },
  }, s.name)));

  const section = sections.find((s) => s.id === state.categoryId);
  const needsProfile = Boolean(section?.personal && !state.personal.profile);
  $('#category-eyebrow').textContent = section?.eyebrow ?? '';
  $('#category-title').textContent = section?.name ?? '';
  $('#category-lead').textContent = section?.lead ?? '';
  $('#category-lead').hidden = !section?.lead;
  $('#btn-edit-profile').hidden = !(section?.personal && state.personal.profile);
  $('#profile-cta').hidden = !needsProfile;
  $('#menu-grid').hidden = needsProfile;
  $('#menu-empty').hidden = needsProfile || Boolean(section?.items.length) || avoidedAllergens().size === 0;
  renderAllergyNotice();
  $('#menu-grid').classList.toggle('featured', Boolean(section?.featured));
  $('#menu-grid').replaceChildren(...(section?.items ?? [])
    .map((item) => menuCard(item, section.featured, section.reasons?.get(item.id))));
}

function menuCard(item, featured = false, reason = null) {
  const inCart = state.cart.find((l) => l.menu_item_id === item.id)?.quantity ?? 0;
  return el('button', {
    type: 'button',
    class: `menu-card${featured ? ' featured' : ''}${item.sold_out ? ' sold-out' : ''}`,
    disabled: item.sold_out,
    onclick: () => openItemDialog(item),
  },
  el('span', { class: 'item-icon', 'aria-hidden': 'true' }, item.icon),
  el('span', { class: 'menu-body' },
    reason ? el('span', { class: 'rec-badge' }, reason) : null,
    !reason && item.recommended ? el('span', { class: 'rec-badge' }, 'おすすめ') : null,
    el('span', { class: 'menu-name' }, item.name),
    el('span', { class: 'menu-desc' }, item.description),
    el('span', { class: 'price' }, yen(item.price)),
    el('span', { class: 'menu-allergens' }, `アレルギー：${allergenSummary(item)}`)),
  item.sold_out ? el('span', { class: 'sold-out-label' }, '売り切れ') : null,
  inCart ? el('span', { class: 'in-cart', 'aria-label': `カートに${inCart}点` }, `×${inCart}`) : null);
}

function renderAllergyNotice() {
  const avoid = [...avoidedAllergens()];
  const button = $('#btn-allergy');
  button.textContent = avoid.length ? `アレルギー（${avoid.length}）` : 'アレルギー';
  button.classList.toggle('active', avoid.length > 0);
  const hidden = state.menu.categories.flatMap((c) => c.items).filter((i) => !isSafe(i)).length;
  $('#allergy-notice').hidden = avoid.length === 0;
  $('#allergy-notice-text').textContent =
    `アレルギー設定（${avoid.map(allergenLabel).join('・')}）により、${hidden}品を非表示にしています。`;
}

// ---------------------------------------------------------------- 年代・性別の入力

function openProfileDialog() {
  const session = state.table?.session;
  state.profileDraft = { age_group: session?.age_group ?? null, gender: session?.gender ?? null };
  renderProfileOptions();
  $('#profile-dialog').showModal();
}

function renderProfileOptions() {
  const optionButtons = (options, field) => options.map(([value, label]) => el('button', {
    type: 'button',
    class: state.profileDraft[field] === value ? 'selected' : '',
    'aria-pressed': String(state.profileDraft[field] === value),
    onclick: () => {
      state.profileDraft[field] = value;
      renderProfileOptions();
    },
  }, label));
  $('#age-options').replaceChildren(...optionButtons(AGE_OPTIONS, 'age_group'));
  $('#gender-options').replaceChildren(...optionButtons(GENDER_OPTIONS, 'gender'));
  $('#btn-save-profile').disabled = state.busy || !state.profileDraft.age_group || !state.profileDraft.gender;
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
      el('span', { class: 'line-name' }, line.item.name),
      el('span', {}, yen(line.item.price * line.quantity))),
    line.item.sold_out ? el('span', { class: 'warning' }, '売り切れのため注文できません') : null,
    isSafe(line.item) ? null
      : el('span', { class: 'warning' }, `ご指定のアレルギー（${avoidedIn(line.item).map(allergenLabel).join('・')}）を含みます`),
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
  $('#btn-place-order').disabled = state.busy || lines.some((l) => l.item.sold_out || !isSafe(l.item));
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
  button.textContent = calling ? '呼び出し中…' : '店員呼び出し';
}

function openItemDialog(item) {
  state.dialogItem = item;
  state.dialogQty = 1;
  $('#item-icon').textContent = item.icon;
  $('#item-badge').hidden = !item.recommended;
  $('#item-name').textContent = item.name;
  $('#item-desc').textContent = item.description;
  $('#item-price').textContent = yen(item.price);
  const avoid = avoidedAllergens();
  $('#item-allergen-list').replaceChildren(...(item.allergens.length
    ? item.allergens.map((a) => el('span', { class: `allergen-chip${avoid.has(a) ? ' avoided' : ''}` }, allergenLabel(a)))
    : [el('span', { class: 'muted' }, '表示対象のアレルギー物質は含まれていません')]));
  const hit = avoidedIn(item);
  $('#item-allergen-warning').hidden = hit.length === 0;
  $('#item-allergen-warning').textContent = `ご指定のアレルギー（${hit.map(allergenLabel).join('・')}）を含みます`;
  $('#item-add').disabled = hit.length > 0;
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
  $('#table-name').textContent = 'テーブル設定';
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
  $('#btn-open-profile').addEventListener('click', openProfileDialog);
  $('#btn-edit-profile').addEventListener('click', openProfileDialog);
  $('#btn-save-profile').addEventListener('click', saveProfile);
  $('#btn-allergy').addEventListener('click', openAllergyDialog);
  $('#btn-allergy-notice').addEventListener('click', openAllergyDialog);
  $('#btn-profile-allergy').addEventListener('click', () => {
    $('#profile-dialog').close();
    openAllergyDialog();
  });
  $('#btn-clear-allergy').addEventListener('click', () => {
    state.allergyDraft.clear();
    renderAllergyOptions();
  });
  $('#btn-save-allergy').addEventListener('click', saveAllergies);
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
