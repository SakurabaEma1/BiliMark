export type CategoryKey =
  | 'low_effort' // 低创（v0.5 由 AI低创 改名扩义：画面/信息量配比极低，不要求 AI 参与）
  | 'clickbait'
  | 'misinformation'
  | 'stolen'
  | 'staged' // 摆拍（v0.5 新增）：未声明"演绎"冒充真实，证据选填
  | 'engagement_bait'
  | 'comment_toxicity'; // 评论区慎入（v0.5 新增）：观点类；UP主警示聚合排除

export type MarkingStatus = 'confirmed' | 'pending';

/** 观点类分类（判定主观性强）：确认门槛更高，对冲串子与误伤（v0.4/v0.5 分类扩展） */
export const OPINION_CATEGORIES: ReadonlySet<CategoryKey> = new Set(['engagement_bait', 'comment_toxicity']);

export interface MarkingEntry {
  category: CategoryKey;
  status: MarkingStatus;
  /** 净赞成数（展示用原始数字，非分数） */
  confirmCount: number;
  againstCount: number;
  reason: string;
  evidence: string[];
  /** 该条聚合所属 UP（提交时随标记记录的元数据；旧数据可能缺失） */
  upMid?: number;
  upName?: string;
  /** 提交时检测到的 B 站官方 AI 生成声明（中性信息标注，非低质判定） */
  aiDeclared?: boolean;
}

/** UP主警示（CONTEXT.md）：同 UP 同分类「已确认」视频数达门槛的派生提示，仅原始计数 */
export interface UpWarning {
  name?: string;
  categories: Array<{ category: CategoryKey; count: number }>;
}

export interface VideoMarkings {
  bvid: string;
  entries: MarkingEntry[];
  /** 该视频所属 UP 触发警示时由 ApiProvider 挂上（Mock/本地数据无此字段） */
  upWarning?: UpWarning;
  /** 任一聚合条目检测到官方 AI 生成声明（中性信息标注，非低质判定） */
  aiDeclared?: boolean;
}

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  low_effort: '低创',
  clickbait: '标题党',
  misinformation: '造谣',
  stolen: '盗视频',
  staged: '摆拍',
  engagement_bait: '黑流量',
  comment_toxicity: '评论区慎入',
};

export function categoryLabel(key: CategoryKey): string {
  return CATEGORY_LABELS[key] ?? key;
}
