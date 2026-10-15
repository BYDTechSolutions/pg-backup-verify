/** A duration in words: "less than a minute", "12 min", "3 h 5 min", "4 days". */
export function formatAge(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'less than a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days`;
}
