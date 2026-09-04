package com.contoso.support;

import static com.contoso.support.Models.AssistantState;
import static com.contoso.support.Models.EvaluationCase;
import static com.contoso.support.Models.EvaluationMetric;
import static com.contoso.support.Models.FeedbackRecord;
import static com.contoso.support.Models.FoundryResources;
import static com.contoso.support.Models.GatewayAnswer;
import static com.contoso.support.Models.StoredAnswer;
import static com.contoso.support.Models.SupportAnswer;
import static com.contoso.support.Models.UnresolvedQuestion;

import com.azure.core.exception.HttpRequestException;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.core.exception.ClientAuthenticationException;
import com.contoso.support.FoundryRestGateway.CleanupException;
import com.contoso.support.FoundryRestGateway.FoundryHttpException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;

public final class SupportAssistantService {
    private final FoundryGateway gateway;
    private final StateStore store;
    private final ObjectMapper mapper;
    private final ReentrantLock lock = new ReentrantLock();

    public SupportAssistantService(
        FoundryGateway gateway,
        StateStore store,
        ObjectMapper mapper) {
        this.gateway = gateway;
        this.store = store;
        this.mapper = mapper;
    }

    public void ingest(List<java.nio.file.Path> documentPaths)
        throws IOException {
        lock.lock();
        try {
            AssistantState state = store.load();
            if (state.resources != null) {
                throw new SupportAssistantException(
                    "already_ingested",
                    "Product documentation is already ingested.");
            }
            FoundryResources resources = gateway.ingest(documentPaths);
            state.resources = resources;
            try {
                store.save(state);
            } catch (ClientAuthenticationException | HttpRequestException
                     | IOException | BlobStorageException error) {
                AssistantState reloaded = reloadAfterFailedSave(
                    "Could not verify ingestion state for vectorStoreId="
                        + resources.vectorStoreId() + " fileIds="
                        + String.join(",", resources.fileIds()) + ".",
                    error);
                if (resourcesMatch(reloaded.resources, resources)) {
                    return;
                }
                if (reloaded.resources != null) {
                    throw new CommitVerificationException(
                        "Ingestion state is ambiguous for vectorStoreId="
                            + resources.vectorStoreId()
                            + "; no Foundry resources were deleted.",
                        error,
                        new IllegalStateException(
                            "Durable state contains different resource "
                                + "ownership: vectorStoreId="
                                + reloaded.resources.vectorStoreId() + "."));
                }
                try {
                    gateway.cleanup(resources, List.of());
                } catch (ClientAuthenticationException | FoundryHttpException
                         | CleanupException | HttpRequestException
                         | IOException cleanupError) {
                    error.addSuppressed(cleanupError);
                }
                throw error;
            }
        } finally {
            lock.unlock();
        }
    }

    public SupportAnswer ask(
        String employeeId,
        String localConversationId,
        String question) throws IOException {
        lock.lock();
        try {
            AssistantState state = store.load();
            if (state.resources == null) {
                throw new SupportAssistantException(
                    "not_ingested",
                    "Product documentation must be ingested before questions.");
            }
            String key = conversationKey(
                employeeId, localConversationId);
            String existingConversationId =
                state.conversations.get(key);
            GatewayAnswer gatewayAnswer = gateway.ask(
                state.resources, existingConversationId, question);
            SupportAnswer answer = new SupportAnswer(
                gatewayAnswer.conversationId(),
                gatewayAnswer.responseId(),
                gatewayAnswer.text(),
                gatewayAnswer.citations(),
                gatewayAnswer.supported());
            String createdAt = Instant.now().toString();
            state.conversations.put(key, answer.conversationId());
            StoredAnswer storedAnswer = new StoredAnswer(
                employeeId,
                localConversationId,
                question,
                createdAt,
                answer.conversationId(),
                answer.responseId(),
                answer.text(),
                answer.citations(),
                answer.supported());
            state.answers.add(storedAnswer);
            UnresolvedQuestion unresolved = null;
            if (!answer.supported()) {
                unresolved = new UnresolvedQuestion(
                    employeeId,
                    localConversationId,
                    question,
                    answer.responseId(),
                    createdAt);
                state.unresolvedQuestions.add(unresolved);
            }
            try {
                store.save(state);
            } catch (ClientAuthenticationException | HttpRequestException
                     | IOException | BlobStorageException error) {
                AssistantState reloaded = reloadAfterFailedSave(
                    "Could not verify answer state for conversationId="
                        + answer.conversationId() + " responseId="
                        + answer.responseId() + ".",
                    error);
                if (answerCommitted(
                        reloaded, key, storedAnswer, unresolved)) {
                    return answer;
                }
                if (!answerAbsent(
                        reloaded,
                        key,
                        existingConversationId,
                        answer.responseId())) {
                    throw new CommitVerificationException(
                        "Answer state is ambiguous for conversationId="
                            + answer.conversationId() + " responseId="
                            + answer.responseId()
                            + "; the Foundry conversation was not deleted "
                            + "or rolled back.",
                        error,
                        new IllegalStateException(
                            "Durable state contains only part of the "
                                + "intended answer/conversation mutation."));
                }
                try {
                    if (existingConversationId == null) {
                        gateway.deleteConversation(
                            answer.conversationId());
                    } else {
                        gateway.rollbackTurn(
                            answer.conversationId(),
                            gatewayAnswer.turnItemIds());
                    }
                } catch (ClientAuthenticationException | FoundryHttpException
                         | CleanupException | HttpRequestException
                         | IOException cleanupError) {
                    error.addSuppressed(cleanupError);
                }
                throw error;
            }
            return answer;
        } finally {
            lock.unlock();
        }
    }

    public void recordFeedback(
        String employeeId,
        String localConversationId,
        String responseId,
        String rating,
        String comment) throws IOException {
        if (!"positive".equals(rating) && !"negative".equals(rating)) {
            throw new IllegalArgumentException(
                "rating must be positive or negative.");
        }
        lock.lock();
        try {
            AssistantState state = store.load();
            boolean ownsResponse = state.answers.stream().anyMatch(
                item -> item.responseId().equals(responseId)
                    && item.employeeId().equals(employeeId)
                    && item.localConversationId().equals(
                        localConversationId));
            if (!ownsResponse) {
                throw new SupportAssistantException(
                    "response_not_found",
                    "The response is unknown or belongs to another employee "
                        + "or conversation.");
            }
            state.feedback.add(new FeedbackRecord(
                employeeId,
                localConversationId,
                responseId,
                rating,
                comment,
                Instant.now().toString()));
            store.save(state);
        } finally {
            lock.unlock();
        }
    }

    public List<EvaluationMetric> evaluate(List<EvaluationCase> cases)
        throws IOException {
        lock.lock();
        try {
            AssistantState state = store.load();
            if (state.resources == null) {
                throw new SupportAssistantException(
                    "not_ingested",
                    "Product documentation must be ingested before evaluation.");
            }
            List<ObjectNode> rows = new ArrayList<>();
            List<String> conversations = new ArrayList<>();
            Exception evaluationError = null;
            List<EvaluationMetric> metrics = List.of();
            try {
                for (EvaluationCase evaluationCase : cases) {
                    GatewayAnswer answer = gateway.ask(
                        state.resources, null, evaluationCase.query());
                    conversations.add(answer.conversationId());
                    if (answer.retrievedContext().isEmpty()) {
                        throw new IllegalStateException(
                            "Evaluation case " + evaluationCase.id()
                                + " returned no retrieved context.");
                    }
                    rows.add(mapper.createObjectNode()
                        .put("query", evaluationCase.query())
                        .put("response", answer.text())
                        .put(
                            "context",
                            String.join(
                                "\n\n", answer.retrievedContext()))
                        .put(
                            "ground_truth",
                            evaluationCase.groundTruth()));
                }
                metrics = gateway.runEvaluation(rows);
            } catch (ClientAuthenticationException | FoundryHttpException
                     | CleanupException
                     | IllegalStateException | IOException error) {
                evaluationError = error;
            }

            List<Exception> cleanupErrors = new ArrayList<>();
            for (String conversationId : conversations) {
                try {
                    gateway.deleteConversation(conversationId);
                } catch (ClientAuthenticationException | FoundryHttpException
                         | CleanupException
                         | IOException error) {
                    cleanupErrors.add(error);
                }
            }
            if (evaluationError != null) {
                cleanupErrors.forEach(evaluationError::addSuppressed);
                if (evaluationError instanceof IOException ioError) {
                    throw ioError;
                }
                throw (RuntimeException) evaluationError;
            }
            if (!cleanupErrors.isEmpty()) {
                throw new FoundryRestGateway.CleanupException(
                    "Temporary evaluation conversations were not deleted.",
                    cleanupErrors);
            }
            return metrics;
        } finally {
            lock.unlock();
        }
    }

    public void cleanup() throws IOException {
        lock.lock();
        try {
            AssistantState state = store.load();
            if (state.resources == null) {
                return;
            }
            gateway.cleanup(
                state.resources,
                new ArrayList<>(state.conversations.values()));
            state.resources = null;
            state.conversations.clear();
            store.save(state);
        } finally {
            lock.unlock();
        }
    }

    public List<UnresolvedQuestion> listUnresolved() throws IOException {
        lock.lock();
        try {
            return List.copyOf(store.load().unresolvedQuestions);
        } finally {
            lock.unlock();
        }
    }

    private static String conversationKey(
        String employeeId,
        String conversationId) {
        return employeeId + ":" + conversationId;
    }

    private AssistantState reloadAfterFailedSave(
        String message,
        Exception error) {
        try {
            return store.load();
        } catch (ClientAuthenticationException | HttpRequestException
                 | IOException | BlobStorageException reloadError) {
            throw new CommitVerificationException(
                message + " No destructive compensation was attempted.",
                error,
                reloadError);
        }
    }

    private static boolean resourcesMatch(
        FoundryResources actual,
        FoundryResources expected) {
        return actual != null
            && actual.vectorStoreId().equals(expected.vectorStoreId())
            && actual.fileIds().equals(expected.fileIds());
    }

    private static boolean answerCommitted(
        AssistantState state,
        String key,
        StoredAnswer expected,
        UnresolvedQuestion unresolved) {
        return expected.conversationId().equals(
                state.conversations.get(key))
            && state.answers.contains(expected)
            && (unresolved == null
                || state.unresolvedQuestions.contains(unresolved));
    }

    private static boolean answerAbsent(
        AssistantState state,
        String key,
        String existingConversationId,
        String responseId) {
        boolean mappingUnchanged = existingConversationId == null
            ? !state.conversations.containsKey(key)
            : existingConversationId.equals(
                state.conversations.get(key));
        return mappingUnchanged
            && state.answers.stream().noneMatch(
                item -> item.responseId().equals(responseId))
            && state.unresolvedQuestions.stream().noneMatch(
                item -> item.responseId().equals(responseId));
    }

    public static final class SupportAssistantException
        extends RuntimeException {
        private final String code;

        SupportAssistantException(String code, String message) {
            super(message);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    private static final class CommitVerificationException
        extends IllegalStateException {
        CommitVerificationException(
            String message,
            Throwable primary,
            Throwable verification) {
            super(message, primary);
            addSuppressed(verification);
        }
    }
}
