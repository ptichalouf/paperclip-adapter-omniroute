/**
 * Fil interne de l'adaptateur : la forme que partagent `agent-loop`, `tools`
 * et le client HTTP.
 *
 * Ces blocs ressemblent au content Anthropic parce que la boucle d'outils a
 * été écrite ainsi et qu'elle est réutilisée telle quelle (capitalisation,
 * décision ACC-2112). La conversion vers/depuis OpenAI Chat Completions vit
 * dans `chat-completions.ts` — jamais ailleurs.
 */
export interface WireMessage {
  role: 'user' | 'assistant';
  content: WireContentBlock[];
}

export type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface WireToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
