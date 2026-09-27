export type CategoryKey = 'ai_low_effort' | 'clickbait' | 'misinformation';

export type MarkingStatus = 'confirmed' | 'pending';

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
}

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  ai_low_effort: 'AI低创',
  clickbait: '标题党',
  misinformation: '造谣',
};

export function categoryLabel(key: CategoryKey): string {
  return CATEGORY_LABELS[key] ?? key;
}
