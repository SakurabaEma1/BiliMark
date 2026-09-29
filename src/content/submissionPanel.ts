import { parseBvidFromUrl } from './bilibili/urls';
import { readAiDeclaredFromDom, readVideoMeta } from './bilibili/videoMeta';
import { getOwnLevel } from '../core/bilibiliAccount';
import { getOrCreatePrivateId } from '../core/privateId';
import { postMarking, deleteMarking } from '../core/api';
import {
  addSubmission,
  getSubmissionsForBvid,
  hasAnySubmission,
  retractSubmission,
  type StoredSubmission,
} from '../core/submissions';
import { CATEGORY_LABELS, type CategoryKey } from '../core/types';

// 分类按钮顺序即 types 的 CategoryKey 定义顺序，文案单一来源
const CATS: Array<{ key: CategoryKey; label: string }> = (
  Object.keys(CATEGORY_LABELS) as CategoryKey[]
).map((key) => ({ key, label: CATEGORY_LABELS[key] }));

/** 常用理由预选项：选分类后给出，点击填入理由栏（可再编辑），降低提交成本 */
const REASON_PRESETS: Record<CategoryKey, string[]> = {
  low_effort: [
    '一张图配音乐/文字轮播，信息量为零',
    '一张图配 AI 配音念稿，信息量为零',
    '无关素材拼凑时长，无实义内容',
  ],
  clickbait: [
    '标题承诺的内容正片完全没有',
    '封面与标题夸大误导，实际内容名不副实',
    '标题断章取义，与正片内容不符',
  ],
  misinformation: ['传播可证伪的不实信息，详见证据链接', '关键事实与权威来源矛盾（见证据）'],
  stolen: ['搬运自其他平台，未获授权且未注明出处', '盗用他人视频冒充原创（原视频见链接）'],
  staged: ['摆拍冒充真实记录（未声明演绎），有剧本痕迹', '剧情摆拍当成真事讲述，误导观众'],
  engagement_bait: ['刻意引战制造对立骗取互动', '靠争议话题骗评论骗流量，内容本身无价值'],
  comment_toxicity: ['评论区对骂/引战刷屏，正常讨论被淹没', '评论区已成战场，正常讨论被劝退'],
};

let panel: HTMLElement | null = null;
let currentBvid: string | null = null;
let onChanged: () => void = () => {};
let outsideClickHandler: ((e: MouseEvent) => void) | null = null;

/** 页面右侧的提交/管理面板（body 顶层 portal）：点击「＋标记」后开/关，贴着按钮弹出 */
export function toggleSubmissionPanel(
  anchorPill: HTMLElement,
  onChangedCb: () => void,
): void {
  onChanged = onChangedCb;
  if (panel && !panel.hidden) {
    closePanel();
    return;
  }
  currentBvid = parseBvidFromUrl(location.href);
  if (!panel) {
    panel = buildPanelShell();
    document.body.appendChild(panel);
  }

  // 贴着点击位置弹出（文档流坐标，随页面滚动）
  const r = anchorPill.getBoundingClientRect();
  const maxLeft = window.scrollX + document.documentElement.clientWidth - 312;
  panel.style.top = `${Math.max(12, r.bottom + window.scrollY + 6)}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, maxLeft))}px`;

  panel.hidden = false;
  void renderContent();
  void getOwnLevel(); // 预热：提交时要带自声明的等级豁免标志（GOVERNANCE.md「等级豁免」）
  window.setTimeout(() => {
    outsideClickHandler = (e) => {
      const t = e.target as Node;
      if (panel!.contains(t) || anchorPill.contains(t)) return;
      closePanel();
    };
    document.addEventListener('click', outsideClickHandler, true);
  }, 0);
}

function closePanel(): void {
  if (!panel) return;
  panel.hidden = true;
  if (outsideClickHandler) {
    document.removeEventListener('click', outsideClickHandler, true);
    outsideClickHandler = null;
  }
}

function buildPanelShell(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'bmk-panel';
  root.hidden = true;

  const head = document.createElement('div');
  head.className = 'bmk-panel__head';
  const title = document.createElement('span');
  title.append('标记此视频 ');
  const bvid = document.createElement('span');
  bvid.className = 'bmk-panel__bvid';
  title.append(bvid);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'bmk-panel__close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closePanel);
  head.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'bmk-panel__body';

  root.append(head, body);
  return root;
}

/** 按状态渲染：已有提交 → 管理视图（可撤回）；无 → 提交表单 */
async function renderContent(): Promise<void> {
  if (!panel || !currentBvid) return;
  const body = panel.querySelector<HTMLElement>('.bmk-panel__body')!;
  body.replaceChildren();
  (panel.querySelector('.bmk-panel__bvid') as HTMLElement).textContent = currentBvid;

  const subs = await getSubmissionsForBvid(currentBvid);
  if (subs.length > 0) renderManage(body, subs);
  else renderForm(body);
}

function renderManage(body: HTMLElement, subs: StoredSubmission[]): void {
  const info = document.createElement('div');
  info.className = 'bmk-panel__label';
  info.textContent = '我的标记（待确认，仅自己可见）：';
  body.append(info);

  for (const s of subs) {
    const card = document.createElement('div');
    card.className = 'bmk-manage__card';

    const head = document.createElement('div');
    head.className = 'bmk-details__head';
    head.textContent = `⚠ ${CATEGORY_LABELS[s.category]} · 待确认`;
    card.append(head);

    const reason = document.createElement('div');
    reason.className = 'bmk-details__reason';
    reason.textContent = s.reason;
    card.append(reason);

    if (s.evidence.length > 0) {
      const ev = document.createElement('div');
      ev.className = 'bmk-details__evidence';
      ev.append(s.category === 'stolen' ? '原视频：' : '证据：');
      s.evidence.forEach((href, i) => {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        a.textContent = `[${i + 1}]`;
        ev.append(a, ' ');
      });
      card.append(ev);
    }

    const retractBtn = document.createElement('button');
    retractBtn.className = 'bmk-manage__retract';
    retractBtn.textContent = '撤回';
    retractBtn.addEventListener('click', () => {
      void (async () => {
        if (!currentBvid) return;
        const privateId = await getOrCreatePrivateId();
        const deleted = await deleteMarking({
          bvid: currentBvid,
          category: s.category,
          privateId,
        });
        if (!deleted) {
          // 服务器不可达时不删本地：否则「本地已撤回、服务器仍计数」，且重提会 409
          retractBtn.textContent = '撤回失败，点击重试';
          return;
        }
        await retractSubmission(currentBvid, s.category);
        closePanel();
        onChanged();
      })();
    });
    card.append(retractBtn);
    body.append(card);
  }

  const foot = document.createElement('div');
  foot.className = 'bmk-panel__hint';
  foot.textContent = '撤回后可重新提交。';
  body.append(foot);
}

function renderForm(body: HTMLElement): void {
  let selectedCat: CategoryKey | null = null;

  const catRow = document.createElement('div');
  catRow.className = 'bmk-panel__cats';
  const catButtons: HTMLButtonElement[] = [];
  const presetsRow = document.createElement('div');
  presetsRow.className = 'bmk-panel__presets';

  const reasonLabel = smallLabel('理由（必填，≥5 字）');
  const reason = document.createElement('textarea');
  reason.className = 'bmk-panel__reason';
  reason.rows = 3;
  reason.placeholder = '为什么低质？可从下方常用理由中选一条再修改';

  for (const cat of CATS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bmk-panel__cat';
    btn.dataset.cat = cat.key;
    btn.textContent = cat.label;
    btn.addEventListener('click', () => {
      selectedCat = cat.key;
      catButtons.forEach((b) => b.classList.toggle('active', b === btn));
      setEvidenceState(body, cat.key);
      fillPresets(presetsRow, cat.key, reason);
    });
    catButtons.push(btn);
    catRow.append(btn);
  }

  const evidenceLabel = smallLabel('证据链接（必填，多个用空格分隔）');
  evidenceLabel.classList.add('bmk-panel__evidence');
  evidenceLabel.hidden = true;
  const evidence = document.createElement('input');
  evidence.className = 'bmk-panel__evidence';
  evidence.placeholder = 'https://…';
  evidence.hidden = true;

  const hint = document.createElement('div');
  hint.className = 'bmk-panel__hint';
  hint.textContent = '选择分类后填写理由；「造谣」「盗视频」需附链接，「摆拍」证据选填。';

  const submit = document.createElement('button');
  submit.className = 'bmk-panel__submit';
  submit.textContent = '提交标记';
  submit.addEventListener('click', () => {
    void handleSubmit(selectedCat, reason, evidence, hint, body);
  });

  body.append(catRow, reasonLabel, presetsRow, reason, evidenceLabel, evidence, hint, submit);
}

/** 按分类填充常用理由 chips，点击填入理由栏 */
function fillPresets(row: HTMLElement, cat: CategoryKey, reason: HTMLTextAreaElement): void {
  row.replaceChildren();
  for (const text of REASON_PRESETS[cat]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bmk-panel__preset';
    chip.textContent = text;
    chip.title = '点击填入，可再编辑';
    chip.addEventListener('click', () => {
      reason.value = text;
      reason.focus();
    });
    row.append(chip);
  }
}

async function handleSubmit(
  selectedCat: CategoryKey | null,
  reasonInput: HTMLTextAreaElement,
  evidenceInput: HTMLInputElement,
  hint: HTMLElement,
  body: HTMLElement,
): Promise<void> {
  if (!currentBvid) {
    setHint('未识别到 BVID，无法提交。', hint);
    return;
  }
  if (await hasAnySubmission(currentBvid)) {
    setHint('此视频已提交过标记（每人每视频一次），可撤回后重新提交。', hint);
    return;
  }
  if (!selectedCat) {
    setHint('请先选择一个分类。', hint);
    return;
  }
  const reason = reasonInput.value.trim();
  if (reason.length < 5) {
    setHint('理由至少 5 个字——这是将来投票者判断的依据。', hint);
    return;
  }
  const urls = evidenceInput.value
    .split(/[\s,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = urls.find((u) => !/^https?:\/\//i.test(u));
  if (invalid) {
    setHint(`证据链接格式不对：${invalid}（需要 http/https 开头）`, hint);
    return;
  }
  // 造谣/盗视频：证据（或原视频）链接必填——客户端友好校验，服务器同样拦截
  if (selectedCat === 'misinformation' && urls.length === 0) {
    setHint('「造谣」必须附证据链接（可证伪的对照出处）。', hint);
    return;
  }
  if (selectedCat === 'stolen' && urls.length === 0) {
    setHint('「盗视频」必须附原视频链接（对照出处，不限平台）。', hint);
    return;
  }

  // 等级豁免（GOVERNANCE.md）：Lv6+ 自声明豁免新手期，服务器抽查制
  const level = await getOwnLevel();
  const claimedLv6 = level !== null && level >= 6;
  const privateId = await getOrCreatePrivateId(); // 匿名凭证仅存本机，服务器只见其哈希
  // 提交时快照分区/UP 元数据（入口仅在非高敏分区存在；readVideoMeta 按 bvid 缓存）
  const meta = await readVideoMeta(currentBvid);
  const { ok, status } = await postMarking({
    bvid: currentBvid,
    category: selectedCat,
    reason,
    evidence: urls,
    privateId,
    claimedLv6,
    region: meta?.tid ?? null,
    regionV2: meta?.tidV2 ?? null,
    upMid: meta?.upMid ?? null,
    upName: meta?.upName ?? '',
    duration: meta?.duration ?? null,
    aiDeclared: readAiDeclaredFromDom(),
  });
  const synced = ok || status === 409; // 409 = 该标记已在社区，视为同步完成
  const submission: StoredSubmission = {
    bvid: currentBvid,
    category: selectedCat,
    reason,
    evidence: urls,
    createdAt: Date.now(),
    claimedLv6,
    region: meta?.tid ?? null,
    regionV2: meta?.tidV2 ?? null,
    upMid: meta?.upMid ?? null,
    upName: meta?.upName ?? '',
    duration: meta?.duration ?? null,
    aiDeclared: readAiDeclaredFromDom(),
    synced, // 已同步的不进待同步队列，避免 background 一小时后无谓重发
  };
  await addSubmission(submission); // 本地自见记录；未同步时由 background 定时重试

  reasonInput.value = '';
  evidenceInput.value = '';
  onChanged();
  if (synced) {
    setHint(status === 409 ? '该标记已在社区存在。' : '✓ 已提交（已同步到社区）。', hint);
    window.setTimeout(closePanel, 900);
  } else {
    // ADR-0005 优雅降级：服务器不可达不影响本地闭环，待同步队列每小时重试
    setHint('⚠ 服务器暂不可达，已保存本地（每小时自动重试）。', hint);
  }
}

/** 证据栏状态：造谣/盗视频必填、摆拍选填，其余隐藏；label 与占位随分类切换 */
function setEvidenceState(body: HTMLElement, cat: CategoryKey): void {
  const required = cat === 'misinformation' || cat === 'stolen';
  const optional = cat === 'staged';
  const label = body.querySelector<HTMLElement>('.bmk-panel__label.bmk-panel__evidence');
  if (label) {
    label.textContent =
      cat === 'stolen'
        ? '原视频链接（必填，对照出处，不限平台）'
        : optional
          ? '证据链接（选填：演绎声明出处、原素材对照等）'
          : '证据链接（必填，多个用空格分隔）';
  }
  const input = body.querySelector<HTMLInputElement>('input.bmk-panel__evidence');
  if (input) input.placeholder = cat === 'stolen' ? '原视频链接 https://…（B站/抖音/YouTube 等）' : 'https://…';
  body.querySelectorAll<HTMLElement>('.bmk-panel__evidence').forEach((el) => (el.hidden = !(required || optional)));
}

function setHint(text: string, hintEl: HTMLElement): void {
  hintEl.textContent = text;
}

function smallLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'bmk-panel__label';
  el.textContent = text;
  return el;
}
