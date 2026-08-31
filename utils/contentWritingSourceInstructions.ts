export type ContentWritingSourceInstructionInput = {
  sourceId: unknown;
  sourceRole?: unknown;
  instructions?: unknown;
};

const toText = (value: unknown, maximum: number): string => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const escapePromptJson = (value: unknown): string => JSON.stringify(value, null, 2)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026');

export const buildContentWritingSourceInstructionsBlock = (
  sources: readonly ContentWritingSourceInstructionInput[],
): string => {
  const instructions = sources.map(source => ({
    sourceId: toText(source.sourceId, 120),
    sourceRole: source.sourceRole === 'supporting' ? 'supporting' : 'primary',
    instructions: toText(source.instructions, 2_000),
  })).filter(source => source.sourceId && source.instructions);

  if (instructions.length === 0) return '';

  return `تعليمات المستخدم الخاصة بمصادر الكتابة. اربط كل تعليمة بمصدرها وراعها في كل مرحلة ذات صلة:
<user_writing_source_instructions_json>
${escapePromptJson(instructions)}
</user_writing_source_instructions_json>`;
};
