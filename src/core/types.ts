export type CategoryKey = 'ai_low_effort' | 'clickbait' | 'misinformation' | 'stolen' | 'engagement_bait';

export type MarkingStatus = 'confirmed' | 'pending';

/** 观点类分类（判定主观性强）：确认门槛更高，对冲串子与误伤（v0.4 分类扩展） */
export const OPINION_CATEGORIES: ReadonlySet<CategoryKey> = new Set(['engagement_bait']);

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
  ai_low_effort: 'AI低创',
  clickbait: '标题党',
  misinformation: '造谣',
  stolen: '盗视频',
  engagement_bait: '黑流量',
};

export function categoryLabel(key: CategoryKey): string {
  return CATEGORY_LABELS[key] ?? key;
}
