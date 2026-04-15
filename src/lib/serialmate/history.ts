/** 各类型历史记录的数量限制 */
export const HISTORY_LIMITS = {
  network: 10,
} as const;

/**
 * 插入或更新最近使用的条目
 * - 如果已存在相同 key 的条目，将其移到最前
 * - 如果不存在，插入到最前
 * - 超出限制的条目被移除
 */
export function upsertRecentItem<T>(
  history: T[],
  item: T,
  keyFn: (item: T) => string,
  maxItems: number,
): T[] {
  const key = keyFn(item);
  return [item, ...history.filter((i) => keyFn(i) !== key)].slice(0, maxItems);
}
