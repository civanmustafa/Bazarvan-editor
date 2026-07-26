export const truncatePromptTextDistributed = (
  value: string,
  maxLength: number,
  labels: {
    middle: string;
    tail: string;
  } = {
    middle: '[تم اختصار جزء من النص؛ المقطع التالي عينة من الوسط.]',
    tail: '[تم اختصار جزء آخر؛ المقطع التالي من نهاية النص.]',
  },
): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  if (maxLength <= 0) return '';

  const middleSeparator = `\n\n${labels.middle}\n\n`;
  const tailSeparator = `\n\n${labels.tail}\n\n`;
  const contentBudget = Math.max(
    0,
    maxLength - middleSeparator.length - tailSeparator.length,
  );
  const headLength = Math.floor(contentBudget * 0.4);
  const middleLength = Math.floor(contentBudget * 0.3);
  const tailLength = contentBudget - headLength - middleLength;
  const latestMiddleStart = Math.max(headLength, trimmed.length - tailLength - middleLength);
  const centeredMiddleStart = Math.floor((trimmed.length - middleLength) / 2);
  const middleStart = Math.max(
    headLength,
    Math.min(centeredMiddleStart, latestMiddleStart),
  );

  return [
    trimmed.slice(0, headLength).trim(),
    middleSeparator.trim(),
    trimmed.slice(middleStart, middleStart + middleLength).trim(),
    tailSeparator.trim(),
    trimmed.slice(-tailLength).trim(),
  ].join('\n\n').slice(0, maxLength);
};
