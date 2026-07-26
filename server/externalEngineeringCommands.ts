import {
  DEFAULT_SMART_ANALYSIS_OPTIONS,
  DEFAULT_ENGINEERING_PROMPTS,
  ENGINEERING_PROMPT_DEFINITIONS,
  sanitizeEngineeringPrompt,
} from '../constants/engineeringPrompts';
import { getPromptTemplate } from '../constants/promptRegistry';
import type { AiAnalysisOptions } from '../types';
import {
  EXTERNAL_AUTOMATIC_COMMAND_IDS,
  EXTERNAL_READY_COMMAND_DEFINITIONS,
  getExternalReadyCommandLabel,
} from '../constants/externalAnalysisCommands';

export type ExternalEngineeringCommand = {
  sequence: number;
  id: string;
  label: string;
  prompt: string;
  options: AiAnalysisOptions;
};

export const EXTERNAL_ENGINEERING_COMMANDS: ExternalEngineeringCommand[] = EXTERNAL_READY_COMMAND_DEFINITIONS
  .map((definition, index) => {
    const promptDefinition = ENGINEERING_PROMPT_DEFINITIONS.find(item => item.id === definition.id);
    return {
      sequence: index + 1,
      id: definition.id,
      label: getExternalReadyCommandLabel(definition.id, 'ar'),
      prompt: getPromptTemplate(DEFAULT_ENGINEERING_PROMPTS, definition.id),
      options: {
        ...DEFAULT_SMART_ANALYSIS_OPTIONS,
        ...(promptDefinition?.options || {}),
      },
    };
  });

export const EXTERNAL_AUTOMATIC_ENGINEERING_COMMANDS = EXTERNAL_AUTOMATIC_COMMAND_IDS
  .map(commandId => EXTERNAL_ENGINEERING_COMMANDS.find(command => command.id === commandId))
  .filter((command): command is ExternalEngineeringCommand => Boolean(command));

export const getExternalEngineeringCommand = (
  commandId: string | null,
  templates: Record<string, string> = DEFAULT_ENGINEERING_PROMPTS,
): ExternalEngineeringCommand | null => {
  const command = EXTERNAL_ENGINEERING_COMMANDS.find(item => item.id === commandId);
  return command
    ? {
        ...command,
        prompt: sanitizeEngineeringPrompt(
          command.id,
          getPromptTemplate(templates, command.id),
        ),
      }
    : null;
};
