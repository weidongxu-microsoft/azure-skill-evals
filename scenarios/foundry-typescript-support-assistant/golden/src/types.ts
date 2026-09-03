export interface Citation {
  fileId: string;
  filename: string;
}

export interface SupportAnswer {
  conversationId: string;
  responseId: string;
  text: string;
  citations: Citation[];
  supported: boolean;
}

export interface GatewayAnswer extends SupportAnswer {
  turnItemIds: string[];
  retrievedContext: string[];
}

export interface FoundryResources {
  vectorStoreId: string;
  fileIds: string[];
  agentName: string;
  agentVersion: string;
}

export interface StoredAnswer extends SupportAnswer {
  localConversationId: string;
  question: string;
  createdAt: string;
}

export interface UnresolvedQuestion {
  localConversationId: string;
  question: string;
  responseId: string;
  createdAt: string;
}

export interface FeedbackRecord {
  localConversationId: string;
  responseId: string;
  rating: "positive" | "negative";
  comment?: string;
  createdAt: string;
}

export interface AssistantState {
  version: 1;
  resources?: FoundryResources;
  conversations: Record<string, string>;
  answers: StoredAnswer[];
  unresolvedQuestions: UnresolvedQuestion[];
  feedback: FeedbackRecord[];
}

export interface EvaluationCase {
  id: string;
  query: string;
  groundTruth: string;
}

export interface EvaluationRow {
  [key: string]: unknown;
  query: string;
  response: string;
  context: string;
  ground_truth: string;
}

export interface EvaluationMetric {
  itemId: string;
  itemStatus: string;
  name: string;
  score: number | null;
  passed: boolean | null;
}

export interface SupportGateway {
  ingest(manualPaths: string[]): Promise<FoundryResources>;
  ask(
    resources: FoundryResources,
    conversationId: string | undefined,
    question: string,
  ): Promise<GatewayAnswer>;
  deleteConversation(conversationId: string): Promise<void>;
  rollbackTurn(conversationId: string, itemIds: string[]): Promise<void>;
  runEvaluation(rows: EvaluationRow[]): Promise<EvaluationMetric[]>;
  cleanup(
    resources: FoundryResources,
    conversationIds: string[],
  ): Promise<void>;
}
