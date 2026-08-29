export type PromptTemplateVariables = Record<string, unknown>;

const promptVariableTokens = (key: string): [string, string] => [
  `{{${key}}}`,
  `\${${key}}`,
];

/**
 * Recognizes both the current {{name}} placeholders and the legacy ${name}
 * placeholders. Saved administrator templates can therefore be migrated
 * gradually without changing their meaning at read time.
 */
export const hasPromptTemplateVariable = (template: string, key: string): boolean => (
  Array.from(template.matchAll(/\{\{([^{}]+)\}\}|\$\{([^{}]+)\}/g)).some(match => (
    String(match[1] ?? match[2] ?? '').trim() === key
  ))
);

/** Canonical renderer for every administrator-editable prompt template. */
export const renderPromptTemplateVariables = (
  template: string,
  variables: PromptTemplateVariables,
): string => template.replace(
  /\{\{([^{}]+)\}\}|\$\{([^{}]+)\}/g,
  (token, currentKey: string | undefined, legacyKey: string | undefined) => {
    const key = String(currentKey ?? legacyKey ?? '').trim();
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key] ?? '')
      : token;
  },
);
