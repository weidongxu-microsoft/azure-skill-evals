package com.contoso.support;

import static com.contoso.support.Models.Citation;
import static com.contoso.support.Models.EvaluationCase;
import static com.contoso.support.Models.EvaluationMetric;
import static com.contoso.support.Models.FoundryResources;
import static com.contoso.support.Models.GatewayAnswer;
import static com.contoso.support.Models.SupportAnswer;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.azure.core.credential.AccessToken;
import com.azure.core.credential.TokenCredential;
import com.azure.core.exception.ClientAuthenticationException;
import com.contoso.support.FoundryRestGateway.CleanupException;
import com.contoso.support.StateStore.MemoryStateStore;
import com.contoso.support.SupportAssistantService.SupportAssistantException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

final class SupportAssistantTest {
    private static final FoundryResources RESOURCES =
        new FoundryResources(
            "vector-store-1",
            List.of("file-1"),
            "contoso-product-support-test",
            "1");
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void createsInvokesAndDeletesManagedPromptAgent() throws Exception {
        AtomicBoolean responseCreated = new AtomicBoolean();
        AtomicReference<JsonNode> responseBody = new AtomicReference<>();
        List<String> cleanupOrder = new ArrayList<>();
        FakePromptAgentOperations promptAgents =
            new FakePromptAgentOperations(cleanupOrder);
        com.sun.net.httpserver.HttpServer backend =
            com.sun.net.httpserver.HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        backend.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if ("POST".equals(method)
                    && path.endsWith("/vector_stores")) {
                sendBackend(exchange, 200, "{\"id\":\"vector-store-1\"}");
            } else if ("POST".equals(method)
                    && path.endsWith(
                        "/vector_stores/vector-store-1/files")) {
                sendBackend(exchange, 200, "{\"id\":\"attached-1\"}");
            } else if ("POST".equals(method)
                    && path.endsWith("/files")) {
                sendBackend(exchange, 200, "{\"id\":\"file-1\"}");
            } else if ("GET".equals(method)
                    && path.endsWith(
                        "/vector_stores/vector-store-1/files/attached-1")) {
                sendBackend(exchange, 200, "{\"status\":\"completed\"}");
            } else if ("POST".equals(method)
                    && path.endsWith("/conversations")) {
                sendBackend(exchange, 200, "{\"id\":\"conversation-1\"}");
            } else if ("GET".equals(method)
                    && path.endsWith(
                        "/conversations/conversation-1/items")) {
                sendBackend(
                    exchange,
                    200,
                    responseCreated.get()
                        ? "{\"data\":[{\"id\":\"assistant-1\"}],"
                            + "\"has_more\":false}"
                        : "{\"data\":[],\"has_more\":false}");
            } else if ("POST".equals(method)
                    && path.endsWith("/responses")) {
                responseBody.set(mapper.readTree(
                    exchange.getRequestBody().readAllBytes()));
                responseCreated.set(true);
                sendBackend(
                    exchange,
                    200,
                    "{\"id\":\"response-1\",\"status\":\"completed\","
                        + "\"output\":["
                        + "{\"type\":\"file_search_call\",\"results\":["
                        + "{\"text\":\"Retrieved reset instructions.\"}]},"
                        + "{\"type\":\"message\",\"content\":["
                        + "{\"type\":\"output_text\","
                        + "\"text\":\"Hold reset for ten seconds.\","
                        + "\"annotations\":[{\"type\":\"file_citation\","
                        + "\"file_id\":\"file-1\","
                        + "\"filename\":\"manual.md\"}]}]}]}");
            } else if ("DELETE".equals(method)
                    && path.endsWith("/vector_stores/vector-store-1")) {
                cleanupOrder.add("vector-store");
                sendBackend(exchange, 204, "");
            } else if ("DELETE".equals(method)
                    && path.endsWith("/files/file-1")) {
                cleanupOrder.add("file");
                sendBackend(exchange, 204, "");
            } else {
                sendBackend(exchange, 500, "unexpected");
            }
        });
        backend.start();
        Path document = Files.createTempFile("contoso-support", ".md");
        Files.writeString(document, "Product documentation.");
        TokenCredential credential = requestContext -> Mono.just(
            new AccessToken(
                "test-token", OffsetDateTime.now().plusHours(1)));
        try (FoundryRestGateway gateway = new FoundryRestGateway(
                URI.create(
                    "http://127.0.0.1:" + backend.getAddress().getPort()
                        + "/api/projects/support"),
                credential,
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                mapper,
                HttpClient.newHttpClient(),
                Duration.ofMillis(1),
                Duration.ofSeconds(1),
                promptAgents)) {
            FoundryResources resources =
                gateway.ingest(List.of(document));
            assertEquals("answer-model", promptAgents.modelDeployment);
            assertEquals(
                "vector-store-1", promptAgents.vectorStoreId);
            assertEquals(
                "contoso-product-support-test",
                resources.agentName());
            assertEquals("7", resources.agentVersion());

            gateway.ask(resources, null, "How do I reset it?");

            JsonNode agentReference =
                responseBody.get().path("agent_reference");
            assertEquals(
                resources.agentName(),
                agentReference.path("name").asText());
            assertEquals(
                resources.agentVersion(),
                agentReference.path("version").asText());
            assertEquals(false, responseBody.get().has("model"));
            assertEquals(false, responseBody.get().has("instructions"));
            assertEquals(false, responseBody.get().has("tools"));

            cleanupOrder.clear();
            gateway.cleanup(resources, List.of());
            assertEquals(
                List.of("agent", "vector-store", "file"),
                cleanupOrder);
        } finally {
            Files.deleteIfExists(document);
            backend.stop(0);
        }
    }

    @Test
    void compensatesAmbiguousPromptAgentCreationFailure()
        throws Exception {
        List<String> cleanupOrder = new ArrayList<>();
        FakePromptAgentOperations promptAgents =
            new FakePromptAgentOperations(cleanupOrder);
        promptAgents.createFailure =
            new com.azure.core.exception.HttpRequestException(
                "Create response was lost.",
                new com.azure.core.http.HttpRequest(
                    com.azure.core.http.HttpMethod.POST,
                    "https://example.test/agents"));
        com.sun.net.httpserver.HttpServer backend =
            com.sun.net.httpserver.HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        backend.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if ("POST".equals(method)
                    && path.endsWith("/vector_stores")) {
                sendBackend(exchange, 200, "{\"id\":\"vector-store-1\"}");
            } else if ("POST".equals(method)
                    && path.endsWith(
                        "/vector_stores/vector-store-1/files")) {
                sendBackend(exchange, 200, "{\"id\":\"attached-1\"}");
            } else if ("POST".equals(method)
                    && path.endsWith("/files")) {
                sendBackend(exchange, 200, "{\"id\":\"file-1\"}");
            } else if ("GET".equals(method)
                    && path.endsWith(
                        "/vector_stores/vector-store-1/files/attached-1")) {
                sendBackend(exchange, 200, "{\"status\":\"completed\"}");
            } else if ("DELETE".equals(method)
                    && path.endsWith("/vector_stores/vector-store-1")) {
                cleanupOrder.add("vector-store");
                sendBackend(exchange, 204, "");
            } else if ("DELETE".equals(method)
                    && path.endsWith("/files/file-1")) {
                cleanupOrder.add("file");
                sendBackend(exchange, 204, "");
            } else {
                sendBackend(exchange, 500, "unexpected");
            }
        });
        backend.start();
        Path document = Files.createTempFile("contoso-support", ".md");
        Files.writeString(document, "Product documentation.");
        TokenCredential credential = requestContext -> Mono.just(
            new AccessToken(
                "test-token", OffsetDateTime.now().plusHours(1)));
        try (FoundryRestGateway gateway = new FoundryRestGateway(
                URI.create(
                    "http://127.0.0.1:" + backend.getAddress().getPort()
                        + "/api/projects/support"),
                credential,
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                mapper,
                HttpClient.newHttpClient(),
                Duration.ofMillis(1),
                Duration.ofSeconds(1),
                promptAgents)) {
            assertThrows(
                com.azure.core.exception.HttpRequestException.class,
                () -> gateway.ingest(List.of(document)));
            assertEquals(
                List.of("agent", "vector-store", "file"),
                cleanupOrder);
        } finally {
            Files.deleteIfExists(document);
            backend.stop(0);
        }
    }

    @Test
    void isolatesEmployeesAndReusesFollowUpConversation()
        throws IOException {
        FakeGateway gateway = new FakeGateway();
        SupportAssistantService assistant = assistant(gateway);
        assistant.ingest(List.of(Path.of("manual.md")));

        assistant.ask("employee-a", "shared", "First");
        assistant.ask("employee-b", "shared", "Second");
        assistant.ask("employee-a", "shared", "Follow-up");

        assertEquals(
            Arrays.asList(null, null, "conversation-1"),
            gateway.seenConversationIds);
    }

    @Test
    void rejectsUnknownAndMismatchedFeedback() throws IOException {
        FakeGateway gateway = new FakeGateway();
        SupportAssistantService assistant = assistant(gateway);
        assistant.ingest(List.of(Path.of("manual.md")));
        SupportAnswer answer =
            assistant.ask("employee-a", "chat-1", "Reset?");

        assertThrows(
            SupportAssistantException.class,
            () -> assistant.recordFeedback(
                "employee-a",
                "chat-1",
                "missing",
                "negative",
                null));
        assertThrows(
            SupportAssistantException.class,
            () -> assistant.recordFeedback(
                "employee-b",
                "chat-1",
                answer.responseId(),
                "negative",
                null));
    }

    @Test
    void evaluationUsesRetrievedServiceContext() throws IOException {
        FakeGateway gateway = new FakeGateway();
        SupportAssistantService assistant = assistant(gateway);
        assistant.ingest(List.of(Path.of("manual.md")));

        List<EvaluationMetric> metrics = assistant.evaluate(List.of(
            new EvaluationCase("reset", "How?", "Hold reset.")));

        assertEquals("groundedness", metrics.get(0).name());
        assertEquals(
            "Retrieved reset instructions.",
            gateway.evaluationRows.get(0).get("context").asText());
        assertEquals(
            List.of("conversation-1"),
            gateway.deletedConversations);
    }

    @Test
    void compensatesWhenAtomicDurableWriteFails() throws IOException {
        FakeGateway gateway = new FakeGateway();
        MemoryStateStore store = new MemoryStateStore(mapper);
        SupportAssistantService assistant =
            new SupportAssistantService(gateway, store, mapper);
        assistant.ingest(List.of(Path.of("manual.md")));
        store.failOnSave(2);

        assertThrows(
            IOException.class,
            () -> assistant.ask(
                "employee-a", "chat-1", "Reset?"));

        assertEquals(
            List.of("conversation-1"),
            gateway.deletedConversations);
    }

    @Test
    void httpRoutesEnforceIdentityAndAdministratorRole()
        throws Exception {
        FakeGateway gateway = new FakeGateway();
        SupportAssistantService assistant = assistant(gateway);
        try (SupportHttpServer server = new SupportHttpServer(
                new InetSocketAddress("127.0.0.1", 0),
                assistant,
                new SupportHttpServer.Options(
                    true,
                    Set.of("admin"),
                    new Path[] {Path.of("manual.md")},
                    Path.of("evaluation/support-cases.jsonl")),
                mapper)) {
            server.start();
            URI base = URI.create(
                "http://127.0.0.1:" + server.port());
            HttpClient client = HttpClient.newHttpClient();

            assertEquals(
                201,
                request(client, base.resolve("/admin/ingest"),
                    "POST", "{}", "admin").statusCode());
            assertEquals(
                200,
                request(
                    client,
                    base.resolve("/conversations/shared/messages"),
                    "POST",
                    "{\"question\":\"First\"}",
                    "employee-a").statusCode());
            request(
                client,
                base.resolve("/conversations/shared/messages"),
                "POST",
                "{\"question\":\"Second\"}",
                "employee-b");
            request(
                client,
                base.resolve("/conversations/shared/messages"),
                "POST",
                "{\"question\":\"Follow-up\"}",
                "employee-a");

            assertEquals(
                Arrays.asList(null, null, "conversation-1"),
                gateway.seenConversationIds);
            assertEquals(
                403,
                request(
                    client,
                    base.resolve("/admin/unresolved"),
                    "GET",
                    null,
                    "employee-a").statusCode());
        }
    }

    @Test
    void preservesEvaluationAndTemporaryCleanupFailures()
        throws IOException {
        FakeGateway gateway = new FakeGateway();
        gateway.evaluationFailure = new IllegalStateException(
            "evaluation failed");
        gateway.deleteFailure = new CleanupException(
            "conversation cleanup failed",
            List.of(new IllegalStateException("delete failed")));
        SupportAssistantService assistant = assistant(gateway);
        assistant.ingest(List.of(Path.of("manual.md")));

        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> assistant.evaluate(List.of(
                new EvaluationCase("reset", "How?", "Hold reset."))));

        assertEquals(1, error.getSuppressed().length);
        assertEquals(
            "conversation cleanup failed",
            error.getSuppressed()[0].getMessage());
    }

    @Test
    void backgroundCleanupFailureReachesFailedState()
        throws Exception {
        FakeGateway gateway = new FakeGateway();
        gateway.evaluationFailure = new CleanupException(
            "evaluation cleanup failed",
            List.of(new IllegalStateException("delete failed")));
        SupportAssistantService assistant = assistant(gateway);
        assistant.ingest(List.of(Path.of("manual.md")));
        try (SupportHttpServer server = new SupportHttpServer(
                new InetSocketAddress("127.0.0.1", 0),
                assistant,
                new SupportHttpServer.Options(
                    true,
                    Set.of("admin"),
                    new Path[] {Path.of("manual.md")},
                    Path.of("evaluation/support-cases.jsonl")),
                mapper)) {
            server.start();
            URI base = URI.create(
                "http://127.0.0.1:" + server.port());
            HttpClient client = HttpClient.newHttpClient();
            HttpResponse<String> accepted = request(
                client,
                base.resolve("/admin/evaluations"),
                "POST",
                "{}",
                "admin");
            String operationId = mapper.readTree(accepted.body())
                .get("operationId").asText();
            String status = "running";
            for (int attempt = 0;
                    attempt < 100 && "running".equals(status);
                    attempt++) {
                TimeUnit.MILLISECONDS.sleep(10);
                HttpResponse<String> operation = request(
                    client,
                    base.resolve("/admin/operations/" + operationId),
                    "GET",
                    null,
                    "admin");
                status = mapper.readTree(operation.body())
                    .get("status").asText();
            }
            assertEquals("failed", status);
        }
    }

    @Test
    void deletesNewConversationWhenBaselineReadFails()
        throws Exception {
        AtomicBoolean deleted = new AtomicBoolean();
        com.sun.net.httpserver.HttpServer backend =
            com.sun.net.httpserver.HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        backend.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if ("POST".equals(method)
                    && path.endsWith("/conversations")) {
                sendBackend(exchange, 200, "{\"id\":\"conversation-1\"}");
            } else if ("GET".equals(method)
                    && path.endsWith(
                        "/conversations/conversation-1/items")) {
                sendBackend(exchange, 200, "not-json");
            } else if ("DELETE".equals(method)
                    && path.endsWith(
                        "/conversations/conversation-1")) {
                deleted.set(true);
                sendBackend(exchange, 204, "");
            } else {
                sendBackend(exchange, 500, "unexpected");
            }
        });
        backend.start();
        TokenCredential credential = requestContext -> Mono.just(
            new AccessToken(
                "test-token", OffsetDateTime.now().plusHours(1)));
        try (FoundryRestGateway gateway = new FoundryRestGateway(
                URI.create(
                    "http://127.0.0.1:" + backend.getAddress().getPort()
                        + "/api/projects/support"),
                credential,
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                mapper,
                HttpClient.newHttpClient(),
                Duration.ofMillis(1),
                Duration.ofSeconds(1))) {
            assertThrows(
                IOException.class,
                () -> gateway.ask(RESOURCES, null, "Reset?"));
            assertEquals(true, deleted.get());
        } finally {
            backend.stop(0);
        }
    }

    @Test
    void preIngestionEvaluationReachesFailedState()
        throws Exception {
        SupportAssistantService assistant = assistant(new FakeGateway());
        try (SupportHttpServer server = new SupportHttpServer(
                new InetSocketAddress("127.0.0.1", 0),
                assistant,
                new SupportHttpServer.Options(
                    true,
                    Set.of("admin"),
                    new Path[] {Path.of("manual.md")},
                    Path.of("evaluation/support-cases.jsonl")),
                mapper)) {
            server.start();
            URI base = URI.create(
                "http://127.0.0.1:" + server.port());
            HttpClient client = HttpClient.newHttpClient();
            HttpResponse<String> accepted = request(
                client,
                base.resolve("/admin/evaluations"),
                "POST",
                "{}",
                "admin");
            String operationId = mapper.readTree(accepted.body())
                .get("operationId").asText();
            JsonNode operation = null;
            for (int attempt = 0; attempt < 100; attempt++) {
                TimeUnit.MILLISECONDS.sleep(10);
                operation = mapper.readTree(request(
                    client,
                    base.resolve("/admin/operations/" + operationId),
                    "GET",
                    null,
                    "admin").body());
                if (!"running".equals(
                        operation.get("status").asText())) {
                    break;
                }
            }
            assertEquals("failed", operation.get("status").asText());
            assertEquals(
                true,
                operation.get("error").asText()
                    .contains("must be ingested"));
        }
    }

    @Test
    void preservesBlobRequestFailureAndCleanupAuthenticationFailure()
        throws IOException {
        FakeGateway gateway = new FakeGateway();
        gateway.cleanupFailure = new ClientAuthenticationException(
            "cleanup authentication failed", null);
        RuntimeException primary =
            new com.azure.core.exception.HttpRequestException(
                "state upload failed",
                new com.azure.core.http.HttpRequest(
                    com.azure.core.http.HttpMethod.PUT,
                    "https://example.test/state"));
        SupportAssistantService assistant = new SupportAssistantService(
            gateway,
            new TypedFailingStateStore(mapper, 1, primary),
            mapper);

        com.azure.core.exception.HttpRequestException error =
            assertThrows(
                com.azure.core.exception.HttpRequestException.class,
                () -> assistant.ingest(List.of(Path.of("manual.md"))));

        assertEquals(1, gateway.cleanupCalls);
        assertEquals(1, error.getSuppressed().length);
        assertEquals(
            ClientAuthenticationException.class,
            error.getSuppressed()[0].getClass());
    }

    @Test
    void compensatesBlobAuthenticationFailureAfterAnswer()
        throws IOException {
        FakeGateway gateway = new FakeGateway();
        RuntimeException primary = new ClientAuthenticationException(
            "state authentication failed", null);
        SupportAssistantService assistant = new SupportAssistantService(
            gateway,
            new TypedFailingStateStore(mapper, 2, primary),
            mapper);
        assistant.ingest(List.of(Path.of("manual.md")));

        assertThrows(
            ClientAuthenticationException.class,
            () -> assistant.ask("employee-a", "chat-1", "Reset?"));

        assertEquals(
            List.of("conversation-1"),
            gateway.deletedConversations);
    }

    @Test
    void ingestionCommitThenThrowDoesNotDeleteResources()
        throws IOException {
        FakeGateway gateway = new FakeGateway();
        CommitThenThrowStateStore store =
            new CommitThenThrowStateStore(mapper, 1);
        SupportAssistantService assistant =
            new SupportAssistantService(gateway, store, mapper);

        assistant.ingest(List.of(Path.of("manual.md")));

        assertEquals(RESOURCES, store.load().resources);
        assertEquals(0, gateway.cleanupCalls);
    }

    @Test
    void newAnswerCommitThenThrowDoesNotDeleteConversation()
        throws IOException {
        FakeGateway gateway = new FakeGateway();
        CommitThenThrowStateStore store =
            new CommitThenThrowStateStore(mapper, 2);
        SupportAssistantService assistant =
            new SupportAssistantService(gateway, store, mapper);
        assistant.ingest(List.of(Path.of("manual.md")));

        SupportAnswer answer =
            assistant.ask("employee-a", "chat-1", "Reset?");

        assertEquals(
            answer.responseId(),
            store.load().answers.get(0).responseId());
        assertEquals(List.of(), gateway.deletedConversations);
    }

    @Test
    void followUpCommitThenThrowDoesNotRollbackTurn()
        throws IOException {
        FakeGateway gateway = new FakeGateway();
        CommitThenThrowStateStore store =
            new CommitThenThrowStateStore(mapper, 3);
        SupportAssistantService assistant =
            new SupportAssistantService(gateway, store, mapper);
        assistant.ingest(List.of(Path.of("manual.md")));
        assistant.ask("employee-a", "chat-1", "Reset?");

        assistant.ask(
            "employee-a", "chat-1", "What happens next?");

        assertEquals(2, store.load().answers.size());
        assertEquals(0, gateway.rollbackCalls);
    }

    private SupportAssistantService assistant(FakeGateway gateway) {
        return new SupportAssistantService(
            gateway, new MemoryStateStore(mapper), mapper);
    }

    private static HttpResponse<String> request(
        HttpClient client,
        URI uri,
        String method,
        String body,
        String principalId) throws IOException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder(uri)
            .header("Content-Type", "application/json")
            .header("X-MS-CLIENT-PRINCIPAL-ID", principalId);
        request.method(
            method,
            body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(
                    body, StandardCharsets.UTF_8));
        return client.send(
            request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static void sendBackend(
        com.sun.net.httpserver.HttpExchange exchange,
        int status,
        String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(
            status, status == 204 ? -1 : content.length);
        if (content.length > 0) {
            exchange.getResponseBody().write(content);
        }
        exchange.close();
    }

    private static final class TypedFailingStateStore
        implements StateStore {
        private final MemoryStateStore delegate;
        private final int failOnSave;
        private final RuntimeException failure;
        private int saveCount;

        TypedFailingStateStore(
            ObjectMapper mapper,
            int failOnSave,
            RuntimeException failure) {
            delegate = new MemoryStateStore(mapper);
            this.failOnSave = failOnSave;
            this.failure = failure;
        }

        @Override
        public Models.AssistantState load() throws IOException {
            return delegate.load();
        }

        @Override
        public void save(Models.AssistantState state) throws IOException {
            saveCount++;
            if (saveCount == failOnSave) {
                throw failure;
            }
            delegate.save(state);
        }
    }

    private static final class CommitThenThrowStateStore
        implements StateStore {
        private final MemoryStateStore delegate;
        private final int failOnSave;
        private int saveCount;

        CommitThenThrowStateStore(
            ObjectMapper mapper,
            int failOnSave) {
            delegate = new MemoryStateStore(mapper);
            this.failOnSave = failOnSave;
        }

        @Override
        public Models.AssistantState load() throws IOException {
            return delegate.load();
        }

        @Override
        public void save(Models.AssistantState state) throws IOException {
            delegate.save(state);
            saveCount++;
            if (saveCount == failOnSave) {
                throw new com.azure.core.exception.HttpRequestException(
                    "Blob committed before response failure.",
                    new com.azure.core.http.HttpRequest(
                        com.azure.core.http.HttpMethod.PUT,
                        "https://example.test/state"));
            }
        }
    }

    private static final class FakePromptAgentOperations
        implements PromptAgentOperations {
        private final List<String> cleanupOrder;
        private String modelDeployment;
        private String vectorStoreId;
        private String ownedAgentName;
        private RuntimeException createFailure;

        FakePromptAgentOperations(List<String> cleanupOrder) {
            this.cleanupOrder = cleanupOrder;
        }

        @Override
        public AgentIdentity create(
            String agentName,
            String modelDeployment,
            String instructions,
            String vectorStoreId) {
            this.modelDeployment = modelDeployment;
            this.vectorStoreId = vectorStoreId;
            this.ownedAgentName = agentName;
            assertEquals(true, agentName.startsWith(
                "contoso-product-support-"));
            assertEquals(true, instructions.contains(
                "internal product-support assistant"));
            if (createFailure != null) {
                throw createFailure;
            }
            ownedAgentName = "contoso-product-support-test";
            return new AgentIdentity(
                ownedAgentName, "7");
        }

        @Override
        public void deleteAgent(String agentName) {
            assertEquals(ownedAgentName, agentName);
            cleanupOrder.add("agent");
        }
    }

    private static final class FakeGateway implements FoundryGateway {
        private final List<String> seenConversationIds =
            new ArrayList<>();
        private final List<String> deletedConversations =
            new ArrayList<>();
        private List<ObjectNode> evaluationRows = List.of();
        private RuntimeException evaluationFailure;
        private RuntimeException deleteFailure;
        private RuntimeException cleanupFailure;
        private int cleanupCalls;
        private int rollbackCalls;
        private int answerNumber;

        @Override
        public FoundryResources ingest(List<Path> documentPaths) {
            return RESOURCES;
        }

        @Override
        public GatewayAnswer ask(
            FoundryResources resources,
            String conversationId,
            String question) {
            seenConversationIds.add(conversationId);
            answerNumber++;
            return new GatewayAnswer(
                conversationId == null
                    ? "conversation-" + answerNumber
                    : conversationId,
                "response-" + answerNumber,
                "Hold reset for ten seconds.",
                List.of(new Citation("file-1", "manual.md")),
                true,
                List.of(
                    "user-" + answerNumber,
                    "assistant-" + answerNumber),
                List.of("Retrieved reset instructions."));
        }

        @Override
        public void deleteConversation(String conversationId) {
            deletedConversations.add(conversationId);
            if (deleteFailure != null) {
                throw deleteFailure;
            }
        }

        @Override
        public void rollbackTurn(
            String conversationId,
            List<String> itemIds) {
            rollbackCalls++;
        }

        @Override
        public List<EvaluationMetric> runEvaluation(
            List<ObjectNode> rows) {
            evaluationRows = List.copyOf(rows);
            if (evaluationFailure != null) {
                throw evaluationFailure;
            }
            return List.of(new EvaluationMetric(
                "item-1", "completed", "groundedness", 5.0, true));
        }

        @Override
        public void cleanup(
            FoundryResources resources,
            List<String> conversationIds) {
            cleanupCalls++;
            if (cleanupFailure != null) {
                throw cleanupFailure;
            }
        }
    }
}
