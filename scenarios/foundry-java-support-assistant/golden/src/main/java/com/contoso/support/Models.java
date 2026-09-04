package com.contoso.support;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class Models {
    private Models() {
    }

    public record Citation(String fileId, String filename) {
    }

    public record FoundryResources(String vectorStoreId, List<String> fileIds) {
        public FoundryResources {
            fileIds = List.copyOf(fileIds);
        }
    }

    public record SupportAnswer(
        String conversationId,
        String responseId,
        String text,
        List<Citation> citations,
        boolean supported) {
        public SupportAnswer {
            citations = List.copyOf(citations);
        }
    }

    public record GatewayAnswer(
        String conversationId,
        String responseId,
        String text,
        List<Citation> citations,
        boolean supported,
        List<String> turnItemIds,
        List<String> retrievedContext) {
        public GatewayAnswer {
            citations = List.copyOf(citations);
            turnItemIds = List.copyOf(turnItemIds);
            retrievedContext = List.copyOf(retrievedContext);
        }
    }

    public record StoredAnswer(
        String employeeId,
        String localConversationId,
        String question,
        String createdAt,
        String conversationId,
        String responseId,
        String text,
        List<Citation> citations,
        boolean supported) {
        public StoredAnswer {
            citations = List.copyOf(citations);
        }
    }

    public record UnresolvedQuestion(
        String employeeId,
        String localConversationId,
        String question,
        String responseId,
        String createdAt) {
    }

    public record FeedbackRecord(
        String employeeId,
        String localConversationId,
        String responseId,
        String rating,
        String comment,
        String createdAt) {
    }

    public record EvaluationCase(
        String id,
        String query,
        String groundTruth) {
    }

    public record EvaluationMetric(
        String itemId,
        String itemStatus,
        String name,
        Double score,
        Boolean passed) {
    }

    public static final class AssistantState {
        public int version = 1;
        public FoundryResources resources;
        public Map<String, String> conversations = new HashMap<>();
        public List<StoredAnswer> answers = new ArrayList<>();
        public List<UnresolvedQuestion> unresolvedQuestions = new ArrayList<>();
        public List<FeedbackRecord> feedback = new ArrayList<>();

        @JsonIgnore
        public String etag;

        @JsonIgnore
        public boolean loaded;
    }
}
