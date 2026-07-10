import {
  DEFAULT_ENGINEERING_PROMPTS,
  ENGINEERING_PROMPT_IDS,
  getEngineeringPrompt,
} from '../constants/engineeringPrompts';

export type ExternalEngineeringCommand = {
  sequence: number;
  id: string;
  label: string;
  prompt: string;
};

const commandDefinitions = [
  {
    sequence: 1,
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.competitorContentComparison,
    label: 'New or conflicting competitor ideas',
  },
  {
    sequence: 2,
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.competitorGapAnalysis,
    label: 'Compare content with competitors',
  },
  {
    sequence: 3,
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.combinedCommands,
    label: 'Commands bundle',
  },
  {
    sequence: 4,
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.repetitionAndFillerAudit,
    label: 'Repetition and filler audit',
  },
  {
    sequence: 5,
    id: ENGINEERING_PROMPT_IDS.smartAnalysis.fullArticleAudit,
    label: 'Full article audit',
  },
] as const;

export const EXTERNAL_ENGINEERING_COMMANDS: ExternalEngineeringCommand[] = commandDefinitions.map(
  command => ({
    ...command,
    prompt: getEngineeringPrompt(DEFAULT_ENGINEERING_PROMPTS, command.id),
  }),
);

export const getExternalEngineeringCommand = (
  commandId: string | null,
): ExternalEngineeringCommand | null => (
  EXTERNAL_ENGINEERING_COMMANDS.find(command => command.id === commandId) ?? null
);
