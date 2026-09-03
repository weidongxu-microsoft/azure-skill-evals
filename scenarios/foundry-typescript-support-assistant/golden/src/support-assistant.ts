import type { AssistantStateStore } from "./state-store.js";
import type {
  EvaluationCase,
  EvaluationMetric,
  FeedbackRecord,
  StoredAnswer,
  SupportAnswer,
  SupportGateway,
} from "./types.js";

export type SupportAssistantErrorCode =
  | "already_ingested"
  | "not_ingested"
  | "response_not_found";

export class SupportAssistantError extends Error {
  public constructor(
    public readonly code: SupportAssistantErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class SupportAssistant {
  public constructor(
    private readonly gateway: SupportGateway,
    private readonly store: AssistantStateStore,
  ) {}

  public async ingest(manualPaths: string[]): Promise<void> {
    const state = await this.store.load();
    if (state.resources !== undefined) {
      throw new SupportAssistantError(
        "already_ingested",
        "Manuals are already ingested. Run cleanup before ingesting again.",
      );
    }
    const resources = await this.gateway.ingest(manualPaths);
    state.resources = resources;
    try {
      await this.store.save(state);
    } catch (error) {
      try {
        await this.gateway.cleanup(resources, []);
      } catch (cleanupError) {
        throw new AggregateError(
          [toError(error), toError(cleanupError)],
          "State persistence failed and the new Foundry resources could not be fully deleted.",
        );
      }
      throw error;
    }
  }

  public async ask(
    localConversationId: string,
    question: string,
  ): Promise<SupportAnswer> {
    const state = await this.store.load();
    if (state.resources === undefined) {
      throw new SupportAssistantError(
        "not_ingested",
        "Manuals must be ingested before asking questions.",
      );
    }
    const existingConversationId = state.conversations[localConversationId];
    const gatewayAnswer = await this.gateway.ask(
      state.resources,
      existingConversationId,
      question,
    );
    const { turnItemIds } = gatewayAnswer;
    const answer: SupportAnswer = {
      conversationId: gatewayAnswer.conversationId,
      responseId: gatewayAnswer.responseId,
      text: gatewayAnswer.text,
      citations: gatewayAnswer.citations,
      supported: gatewayAnswer.supported,
    };
    const createdAt = new Date().toISOString();
    state.conversations[localConversationId] = answer.conversationId;
    const storedAnswer: StoredAnswer = {
      ...answer,
      localConversationId,
      question,
      createdAt,
    };
    state.answers.push(storedAnswer);
    if (!answer.supported) {
      state.unresolvedQuestions.push({
        localConversationId,
        question,
        responseId: answer.responseId,
        createdAt,
      });
    }
    try {
      await this.store.save(state);
    } catch (error) {
      if (existingConversationId === undefined) {
        try {
          await this.gateway.deleteConversation(answer.conversationId);
        } catch (cleanupError) {
          throw new AggregateError(
            [toError(error), toError(cleanupError)],
            "State persistence failed and the new conversation could not be deleted.",
          );
        }
      } else {
        try {
          await this.gateway.rollbackTurn(
            answer.conversationId,
            turnItemIds,
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [toError(error), toError(cleanupError)],
            "State persistence failed and the completed conversation turn could not be rolled back.",
          );
        }
      }
      throw error;
    }
    return answer;
  }

  public async recordFeedback(
    localConversationId: string,
    responseId: string,
    rating: FeedbackRecord["rating"],
    comment?: string,
  ): Promise<void> {
    const state = await this.store.load();
    const answer = state.answers.find(
      (candidate) =>
        candidate.localConversationId === localConversationId &&
        candidate.responseId === responseId,
    );
    if (answer === undefined) {
      throw new SupportAssistantError(
        "response_not_found",
        `Response ${responseId} does not belong to conversation ${localConversationId}.`,
      );
    }
    state.feedback.push({
      localConversationId,
      responseId,
      rating,
      ...(comment === undefined ? {} : { comment }),
      createdAt: new Date().toISOString(),
    });
    await this.store.save(state);
  }

  public async evaluate(
    cases: EvaluationCase[],
  ): Promise<EvaluationMetric[]> {
    const state = await this.store.load();
    if (state.resources === undefined) {
      throw new SupportAssistantError(
        "not_ingested",
        "Manuals must be ingested before running evaluations.",
      );
    }

    const evaluationConversationIds: string[] = [];
    let metrics: EvaluationMetric[] | undefined;
    let evaluationError: Error | undefined;
    try {
      const rows = [];
      for (const evaluationCase of cases) {
        const answer = await this.gateway.ask(
          state.resources,
          undefined,
          evaluationCase.query,
        );
        evaluationConversationIds.push(answer.conversationId);
        if (answer.retrievedContext.length === 0) {
          throw new Error(
            `Evaluation case ${evaluationCase.id} returned no retrieved context.`,
          );
        }
        rows.push({
          query: evaluationCase.query,
          response: answer.text,
          context: answer.retrievedContext.join("\n\n"),
          ground_truth: evaluationCase.groundTruth,
        });
      }
      metrics = await this.gateway.runEvaluation(rows);
    } catch (error) {
      evaluationError = toError(error);
    }

    const cleanupErrors: Error[] = [];
    for (const conversationId of evaluationConversationIds) {
      try {
        await this.gateway.deleteConversation(conversationId);
      } catch (error) {
        cleanupErrors.push(toError(error));
      }
    }
    if (evaluationError !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError(
        [evaluationError, ...cleanupErrors],
        "Evaluation failed and some temporary conversations were not deleted.",
      );
    }
    if (evaluationError !== undefined) {
      throw evaluationError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Some evaluation conversations were not deleted.",
      );
    }
    return metrics ?? [];
  }

  public async cleanup(): Promise<void> {
    const state = await this.store.load();
    if (state.resources === undefined) {
      return;
    }
    await this.gateway.cleanup(
      state.resources,
      Object.values(state.conversations),
    );
    delete state.resources;
    state.conversations = {};
    await this.store.save(state);
  }

  public async listUnresolvedQuestions() {
    return (await this.store.load()).unresolvedQuestions;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
