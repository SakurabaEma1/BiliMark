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
}

export interface VideoMarkings {
  bvid: string;
  entries: MarkingEntry[];
}

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  ai_low_effort: 'AI低创',
  clickbait: '标题党',
  misinformation: '造谣',
};

export function categoryLabel(key: CategoryKey): string {
  return CATEGORY_LABELS[key] ?? key;
}
