// Compatibility export for code that previously looked for generic API helpers.
// All Gemini requests must use the shared background analysis engine.
export { runGeminiAnalysisEngine } from './geminiAnalysisEngine';
export type {
    GeminiEngineProvider,
    GeminiEngineRequest,
    GeminiEngineResult,
    GeminiProgressCallback,
    GeminiProgressSnapshot,
} from './geminiAnalysisEngine';
