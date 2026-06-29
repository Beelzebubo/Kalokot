// Legacy compatibility file for the original AI agent system
// This was the original API implementation before the refactor

export interface CounselRequest {
  tender_context?: string;
  question: string;
  jurisdiction?: string;
  risk_report?: unknown;
}

export interface CounselResponse {
  answer: string;
  citations?: { source: string; description: string }[];
  suggested_actions?: string[];
  disclaimer?: string;
}

export async function counselQuestion(
  req: CounselRequest,
  provider?: string,
  chat_history?: { role: string; text: string }[],
) {
  console.warn("Using legacy counselQuestion - this is deprecated");
  // Legacy implementation - in a real scenario this would make API calls
  return {
    answer:
      "This is a legacy implementation of the counselQuestion function. The new implementation is in api.ts.",
    citations: [],
    suggested_actions: [],
  };
}
