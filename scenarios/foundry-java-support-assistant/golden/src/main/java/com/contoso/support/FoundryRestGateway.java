package com.contoso.support;

import static com.contoso.support.Models.Citation;
import static com.contoso.support.Models.EvaluationMetric;
import static com.contoso.support.Models.FoundryResources;
import static com.contoso.support.Models.GatewayAnswer;

import com.azure.core.credential.AccessToken;
import com.azure.core.credential.TokenCredential;
import com.azure.core.credential.TokenRequestContext;
import com.azure.core.exception.ClientAuthenticationException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

public final class FoundryRestGateway
    implements FoundryGateway, AutoCloseable {

    private static final Set<String> FILE_TERMINAL_STATUSES =
        Set.of("completed", "failed", "cancelled");
    private static final Set<String> EVALUATION_TERMINAL_STATUSES =
        Set.of("completed", "failed", "cancelled", "canceled");

    private final URI baseUri;
    private final TokenCredential credential;
    private final String modelDeployment;
    private final String evaluationModelDeployment;
    private final String tokenScope;
    private final ObjectMapper mapper;
    private final HttpClient httpClient;
    private final ScheduledExecutorService scheduler;
    private final Duration pollInterval;
    private final Duration operationTimeout;

    public FoundryRestGateway(
        URI projectEndpoint,
        TokenCredential credential,
        String modelDeployment,
        String evaluationModelDeployment,
        String tokenScope,
        ObjectMapper mapper) {
        this(
            projectEndpoint,
            credential,
            modelDeployment,
            evaluationModelDeployment,
            tokenScope,
            mapper,
            HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(30))
                .build(),
            Duration.ofSeconds(2),
            Duration.ofMinutes(10));
    }

    FoundryRestGateway(
        URI projectEndpoint,
        TokenCredential credential,
        String modelDeployment,
        String evaluationModelDeployment,
        String tokenScope,
        ObjectMapper mapper,
        HttpClient httpClient,
        Duration pollInterval,
        Duration operationTimeout) {
        baseUri = URI.create(
            projectEndpoint.toString().replaceAll("/+$", "")
                + "/openai/v1/");
        this.credential = credential;
        this.modelDeployment = modelDeployment;
        this.evaluationModelDeployment = evaluationModelDeployment;
        this.tokenScope = tokenScope;
        this.mapper = mapper;
        this.httpClient = httpClient;
        this.pollInterval = pollInterval;
        this.operationTimeout = operationTimeout;
        scheduler = Executors.newSingleThreadScheduledExecutor();
    }

    @Override
    public FoundryResources ingest(List<Path> documentPaths)
        throws IOException {
        if (documentPaths.isEmpty()) {
            throw new IllegalArgumentException(
                "At least one product document is required.");
        }
        ObjectNode vectorStore = sendJson(
            "POST",
            "vector_stores",
            mapper.createObjectNode().put(
                "name", "contoso-support-" + Instant.now().getEpochSecond()));
        String vectorStoreId = requiredText(vectorStore, "id");
        List<String> fileIds = new ArrayList<>();
        try {
            for (Path documentPath : documentPaths) {
                String fileId = uploadFile(documentPath);
                fileIds.add(fileId);
                ObjectNode attachBody = mapper.createObjectNode()
                    .put("file_id", fileId);
                ObjectNode attached = sendJson(
                    "POST",
                    "vector_stores/" + escape(vectorStoreId) + "/files",
                    attachBody);
                String attachedId = requiredText(attached, "id");
                String status = pollVectorStoreFile(
                    vectorStoreId, attachedId);
                if (!"completed".equals(status)) {
                    throw new IllegalStateException(
                        "Indexing " + documentPath.getFileName()
                            + " ended with status " + status + ".");
                }
            }
            return new FoundryResources(vectorStoreId, fileIds);
        } catch (ClientAuthenticationException | FoundryHttpException | IOException
                 | IllegalStateException error) {
            try {
                cleanup(
                    new FoundryResources(vectorStoreId, fileIds), List.of());
            } catch (CleanupException cleanupError) {
                error.addSuppressed(cleanupError);
            }
            throw error;
        }
    }

    @Override
    public GatewayAnswer ask(
        FoundryResources resources,
        String conversationId,
        String question) throws IOException {
        String activeConversationId = conversationId;
        boolean createdConversation = false;
        if (activeConversationId == null) {
            activeConversationId = requiredText(
                sendJson(
                    "POST", "conversations", mapper.createObjectNode()),
                "id");
            createdConversation = true;
        }
        Set<String> beforeIds;
        try {
            beforeIds = conversationItemIds(activeConversationId);
        } catch (ClientAuthenticationException | FoundryHttpException
                 | IOException | IllegalStateException error) {
            if (!createdConversation) {
                throw error;
            }
            try {
                deleteConversationRecord(activeConversationId);
            } catch (ClientAuthenticationException | FoundryHttpException
                     | IOException | IllegalStateException cleanupError) {
                error.addSuppressed(cleanupError);
            }
            throw error;
        }
        try {
            ObjectNode body = mapper.createObjectNode();
            body.put("model", modelDeployment);
            body.put("conversation", activeConversationId);
            body.put("input", question);
            body.put(
                "instructions",
                "You are Contoso's internal product-support assistant. "
                    + "Search the indexed product documentation before answering. "
                    + "Answer only from retrieved documentation. If it does not "
                    + "support an answer, begin with 'UNSUPPORTED:'. Preserve "
                    + "file citations for supported answers.");
            ObjectNode tool = mapper.createObjectNode()
                .put("type", "file_search")
                .put("max_num_results", 10);
            tool.putArray("vector_store_ids")
                .add(resources.vectorStoreId());
            body.putArray("tools").add(tool);
            body.put("tool_choice", "required");
            body.putArray("include").add("file_search_call.results");

            ObjectNode response = sendJson("POST", "responses", body);
            String status = requiredText(response, "status");
            if (!"completed".equals(status)) {
                throw new IllegalStateException(
                    "Foundry response ended with status " + status + ".");
            }
            Set<String> afterIds =
                conversationItemIds(activeConversationId);
            afterIds.removeAll(beforeIds);
            ParsedResponse parsed = parseResponse(response);
            return new GatewayAnswer(
                activeConversationId,
                requiredText(response, "id"),
                parsed.text(),
                parsed.citations(),
                !parsed.citations().isEmpty()
                    && !parsed.text().toUpperCase()
                        .startsWith("UNSUPPORTED:"),
                new ArrayList<>(afterIds),
                parsed.context());
        } catch (ClientAuthenticationException | FoundryHttpException | IOException
                 | IllegalStateException error) {
            try {
                if (createdConversation) {
                    deleteConversationRecord(activeConversationId);
                } else {
                    Set<String> current =
                        conversationItemIds(activeConversationId);
                    current.removeAll(beforeIds);
                    rollbackTurn(
                        activeConversationId, new ArrayList<>(current));
                }
            } catch (ClientAuthenticationException | FoundryHttpException | IOException
                     | CleanupException cleanupError) {
                error.addSuppressed(cleanupError);
            }
            throw error;
        }
    }

    @Override
    public void deleteConversation(String conversationId)
        throws IOException {
        rollbackTurn(
            conversationId,
            new ArrayList<>(conversationItemIds(conversationId)));
        sendJson(
            "DELETE", "conversations/" + escape(conversationId), null);
    }

    @Override
    public void rollbackTurn(
        String conversationId,
        List<String> itemIds) throws IOException {
        List<RuntimeException> failures = new ArrayList<>();
        for (String itemId : itemIds) {
            try {
                sendJson(
                    "DELETE",
                    "conversations/" + escape(conversationId)
                        + "/items/" + escape(itemId),
                    null);
            } catch (FoundryHttpException error) {
                if (error.statusCode() != 404) {
                    failures.add(error);
                }
            } catch (ClientAuthenticationException error) {
                failures.add(error);
            } catch (IllegalStateException error) {
                failures.add(error);
            } catch (IOException error) {
                failures.add(new IllegalStateException(error));
            }
        }
        if (!failures.isEmpty()) {
            throw new CleanupException(
                "The conversation turn was not rolled back.", failures);
        }
    }

    @Override
    public List<EvaluationMetric> runEvaluation(List<ObjectNode> rows)
        throws IOException {
        if (rows.isEmpty()) {
            throw new IllegalArgumentException(
                "At least one evaluation row is required.");
        }
        ArrayNode criteria = mapper.createArrayNode();
        criteria.add(evaluator(
            "groundedness",
            "builtin.groundedness",
            Map.of(
                "query", "{{item.query}}",
                "response", "{{item.response}}",
                "context", "{{item.context}}")));
        criteria.add(evaluator(
            "relevance",
            "builtin.relevance",
            Map.of(
                "query", "{{item.query}}",
                "response", "{{item.response}}")));

        ObjectNode schema = mapper.createObjectNode().put("type", "object");
        ObjectNode properties = schema.putObject("properties");
        for (String property :
                List.of("query", "response", "context", "ground_truth")) {
            properties.putObject(property).put("type", "string");
        }
        schema.putArray("required")
            .add("query")
            .add("response")
            .add("context")
            .add("ground_truth");
        ObjectNode evaluationBody = mapper.createObjectNode()
            .put(
                "name",
                "contoso-support-" + Instant.now().getEpochSecond());
        evaluationBody.putObject("data_source_config")
            .put("type", "custom")
            .set("item_schema", schema);
        ((ObjectNode) evaluationBody.get("data_source_config"))
            .put("include_sample_schema", true);
        evaluationBody.set("testing_criteria", criteria);
        ObjectNode evaluation = sendJson(
            "POST", "evals", evaluationBody);
        String evaluationId = requiredText(evaluation, "id");

        Exception evaluationError = null;
        List<EvaluationMetric> metrics = List.of();
        try {
            ArrayNode content = mapper.createArrayNode();
            for (ObjectNode row : rows) {
                content.add(mapper.createObjectNode().set("item", row));
            }
            ObjectNode source = mapper.createObjectNode()
                .put("type", "file_content")
                .set("content", content);
            ObjectNode dataSource = mapper.createObjectNode()
                .put("type", "jsonl")
                .set("source", source);
            ObjectNode runBody = mapper.createObjectNode()
                .put(
                    "name",
                    "contoso-support-run-"
                        + Instant.now().getEpochSecond())
                .set("data_source", dataSource);
            ObjectNode run = sendJson(
                "POST",
                "evals/" + escape(evaluationId) + "/runs",
                runBody);
            String runId = requiredText(run, "id");
            Instant deadline = Instant.now().plus(operationTimeout);
            String status = requiredText(run, "status");
            while (!EVALUATION_TERMINAL_STATUSES.contains(status)) {
                delayUntil(deadline, "Evaluation run " + runId);
                run = sendJson(
                    "GET",
                    "evals/" + escape(evaluationId)
                        + "/runs/" + escape(runId),
                    null);
                status = requiredText(run, "status");
            }
            if (!"completed".equals(status)) {
                throw new IllegalStateException(
                    "Evaluation run " + runId
                        + " ended with status " + status + ".");
            }

            List<EvaluationMetric> collectedMetrics = new ArrayList<>();
            forEachPageItem(
                "evals/" + escape(evaluationId)
                    + "/runs/" + escape(runId)
                    + "/output_items?limit=100",
                item -> {
                    String itemId = requiredText(item, "id");
                    String itemStatus = requiredText(item, "status");
                    JsonNode results = item.get("results");
                    if (results == null || !results.isArray()) {
                        throw new IllegalStateException(
                            "Evaluation results must be an array.");
                    }
                    for (JsonNode result : results) {
                        collectedMetrics.add(new EvaluationMetric(
                            itemId,
                            itemStatus,
                            requiredText(result, "name"),
                            result.get("score") == null
                                || result.get("score").isNull()
                                ? null : result.get("score").asDouble(),
                            result.get("passed") == null
                                || result.get("passed").isNull()
                                ? null : result.get("passed").asBoolean()));
                    }
                });
            metrics = collectedMetrics;
        } catch (ClientAuthenticationException | FoundryHttpException
                 | IOException | IllegalStateException error) {
            evaluationError = error;
        }

        Exception cleanupError = null;
        try {
            sendJson(
                "DELETE", "evals/" + escape(evaluationId), null);
        } catch (ClientAuthenticationException | FoundryHttpException
                 | IOException | IllegalStateException error) {
            cleanupError = error;
        }
        if (evaluationError != null) {
            if (cleanupError != null) {
                evaluationError.addSuppressed(cleanupError);
            }
            rethrow(evaluationError);
        }
        if (cleanupError != null) {
            rethrow(cleanupError);
        }
        return metrics;
    }

    @Override
    public void cleanup(
        FoundryResources resources,
        List<String> conversationIds) throws IOException {
        List<RuntimeException> failures = new ArrayList<>();
        for (String conversationId :
                new LinkedHashSet<>(conversationIds)) {
            deleteForCleanup(
                () -> deleteConversation(conversationId), failures);
        }
        throwCleanupFailures(failures);
        deleteForCleanup(
            () -> sendJson(
                "DELETE",
                "vector_stores/" + escape(resources.vectorStoreId()),
                null),
            failures);
        throwCleanupFailures(failures);
        for (String fileId : resources.fileIds()) {
            deleteForCleanup(
                () -> sendJson(
                    "DELETE", "files/" + escape(fileId), null),
                failures);
        }
        throwCleanupFailures(failures);
    }

    @Override
    public void close() {
        scheduler.shutdown();
    }

    private ObjectNode evaluator(
        String name,
        String evaluatorName,
        Map<String, String> dataMapping) {
        ObjectNode evaluator = mapper.createObjectNode()
            .put("type", "azure_ai_evaluator")
            .put("name", name)
            .put("evaluator_name", evaluatorName);
        evaluator.putObject("initialization_parameters")
            .put("deployment_name", evaluationModelDeployment);
        ObjectNode mapping = evaluator.putObject("data_mapping");
        dataMapping.forEach(mapping::put);
        return evaluator;
    }

    private String uploadFile(Path documentPath) throws IOException {
        String boundary = "contoso-" + UUID.randomUUID();
        byte[] body = multipartBody(boundary, documentPath);
        HttpRequest request = requestBuilder("files")
            .header(
                "Content-Type",
                "multipart/form-data; boundary=" + boundary)
            .POST(HttpRequest.BodyPublishers.ofByteArray(body))
            .build();
        return requiredText(send(request), "id");
    }

    private byte[] multipartBody(String boundary, Path documentPath)
        throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        writePart(
            output,
            "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"purpose\"\r\n\r\n"
                + "assistants\r\n");
        writePart(
            output,
            "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\""
                + documentPath.getFileName() + "\"\r\n"
                + "Content-Type: text/markdown\r\n\r\n");
        output.write(Files.readAllBytes(documentPath));
        writePart(output, "\r\n--" + boundary + "--\r\n");
        return output.toByteArray();
    }

    private static void writePart(
        ByteArrayOutputStream output,
        String value) throws IOException {
        output.write(value.getBytes(StandardCharsets.UTF_8));
    }

    private String pollVectorStoreFile(
        String vectorStoreId,
        String fileId) throws IOException {
        Instant deadline = Instant.now().plus(operationTimeout);
        while (true) {
            ObjectNode file = sendJson(
                "GET",
                "vector_stores/" + escape(vectorStoreId)
                    + "/files/" + escape(fileId),
                null);
            String status = requiredText(file, "status");
            if (FILE_TERMINAL_STATUSES.contains(status)) {
                return status;
            }
            delayUntil(deadline, "Vector-store file " + fileId);
        }
    }

    private Set<String> conversationItemIds(String conversationId)
        throws IOException {
        Set<String> itemIds = new HashSet<>();
        forEachPageItem(
            "conversations/" + escape(conversationId) + "/items?limit=100",
            item -> itemIds.add(requiredText(item, "id")));
        return itemIds;
    }

    private void forEachPageItem(
        String initialPath,
        Consumer<ObjectNode> consumer) throws IOException {
        String nextPath = initialPath;
        while (nextPath != null) {
            ObjectNode page = sendJson("GET", nextPath, null);
            JsonNode data = page.get("data");
            if (data == null || !data.isArray()) {
                throw new IllegalStateException(
                    "Paged response data must be an array.");
            }
            for (JsonNode item : data) {
                if (!(item instanceof ObjectNode object)) {
                    throw new IllegalStateException(
                        "Paged response item must be an object.");
                }
                consumer.accept(object);
            }
            if (page.path("has_more").asBoolean(false)) {
                String separator = initialPath.contains("?") ? "&" : "?";
                nextPath = initialPath + separator + "after="
                    + escape(requiredText(page, "last_id"));
            } else {
                nextPath = null;
            }
        }
    }

    private ObjectNode sendJson(
        String method,
        String path,
        ObjectNode body) throws IOException {
        HttpRequest.Builder builder = requestBuilder(path);
        if (body != null) {
            builder.header("Content-Type", "application/json")
                .method(
                    method,
                    HttpRequest.BodyPublishers.ofString(
                        mapper.writeValueAsString(body)));
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        }
        return send(builder.build());
    }

    private HttpRequest.Builder requestBuilder(String path) {
        AccessToken token = credential.getToken(
                new TokenRequestContext().addScopes(tokenScope))
            .block(Duration.ofSeconds(30));
        if (token == null) {
            throw new IllegalStateException(
                "Microsoft Entra credential returned no access token.");
        }
        return HttpRequest.newBuilder(baseUri.resolve(path))
            .timeout(Duration.ofSeconds(60))
            .header("Authorization", "Bearer " + token.getToken());
    }

    private ObjectNode send(HttpRequest request) throws IOException {
        HttpResponse<String> response;
        try {
            response = httpClient.send(
                request,
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Foundry request was interrupted.", error);
        }
        if (response.statusCode() >= 400) {
            ServiceError serviceError = serviceError(response.body());
            throw new FoundryHttpException(
                response.statusCode(),
                serviceError.code(),
                "Foundry request failed: status=" + response.statusCode()
                    + " code=" + serviceError.code()
                    + " message=" + serviceError.message());
        }
        if (response.statusCode() == 204 || response.body().isBlank()) {
            return mapper.createObjectNode();
        }
        JsonNode value = mapper.readTree(response.body());
        if (!(value instanceof ObjectNode object)) {
            throw new IOException(
                "Foundry response must be a JSON object.");
        }
        return object;
    }

    private void deleteForCleanup(
        IoOperation operation,
        List<RuntimeException> failures) {
        try {
            operation.run();
        } catch (FoundryHttpException error) {
            if (error.statusCode() != 404) {
                failures.add(error);
            }
        } catch (CleanupException error) {
            failures.add(error);
        } catch (ClientAuthenticationException error) {
            failures.add(error);
        } catch (IOException error) {
            failures.add(new IllegalStateException(error));
        }
    }

    private static void throwCleanupFailures(
        List<RuntimeException> failures) {
        if (!failures.isEmpty()) {
            throw new CleanupException(
                "Some Foundry resources were not deleted.", failures);
        }
    }

    private void deleteConversationRecord(String conversationId)
        throws IOException {
        try {
            sendJson(
                "DELETE", "conversations/" + escape(conversationId), null);
        } catch (FoundryHttpException error) {
            if (error.statusCode() != 404) {
                throw error;
            }
        }
    }

    private static void rethrow(Exception error) throws IOException {
        if (error instanceof IOException ioError) {
            throw ioError;
        }
        throw (RuntimeException) error;
    }

    private void delayUntil(Instant deadline, String operation) {
        if (!Instant.now().isBefore(deadline)) {
            throw new IllegalStateException(
                operation + " did not finish within "
                    + operationTimeout + ".");
        }
        try {
            scheduler.schedule(
                () -> { }, pollInterval.toMillis(), TimeUnit.MILLISECONDS)
                .get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(
                operation + " polling was interrupted.", error);
        } catch (ExecutionException error) {
            throw new IllegalStateException(
                operation + " polling failed.", error.getCause());
        }
    }

    private ParsedResponse parseResponse(ObjectNode response) {
        JsonNode output = response.get("output");
        if (output == null || !output.isArray()) {
            throw new IllegalStateException(
                "Foundry response output must be an array.");
        }
        StringBuilder text = new StringBuilder();
        Map<String, Citation> citations = new HashMap<>();
        List<String> context = new ArrayList<>();
        for (JsonNode item : output) {
            if ("file_search_call".equals(item.path("type").asText())) {
                JsonNode results = item.get("results");
                if (results != null && results.isArray()) {
                    for (JsonNode result : results) {
                        String chunk = result.path("text").asText().trim();
                        if (!chunk.isEmpty()) {
                            context.add(chunk);
                        }
                    }
                }
            }
            if (!"message".equals(item.path("type").asText())) {
                continue;
            }
            JsonNode content = item.get("content");
            if (content == null || !content.isArray()) {
                continue;
            }
            for (JsonNode part : content) {
                if (!"output_text".equals(part.path("type").asText())) {
                    continue;
                }
                text.append(part.path("text").asText());
                JsonNode annotations = part.get("annotations");
                if (annotations == null || !annotations.isArray()) {
                    continue;
                }
                for (JsonNode annotation : annotations) {
                    if ("file_citation".equals(
                            annotation.path("type").asText())) {
                        String fileId = requiredText(
                            annotation, "file_id");
                        citations.put(
                            fileId,
                            new Citation(
                                fileId,
                                requiredText(annotation, "filename")));
                    }
                }
            }
        }
        String answer = text.toString().trim();
        if (answer.isEmpty()) {
            throw new IllegalStateException(
                "Foundry response contained no output text.");
        }
        return new ParsedResponse(
            answer, new ArrayList<>(citations.values()), context);
    }

    private ServiceError serviceError(String content) {
        try {
            JsonNode root = mapper.readTree(content);
            JsonNode error = root.has("error") ? root.get("error") : root;
            return new ServiceError(
                error.path("code").asText("unknown"),
                error.path("message").asText(content));
        } catch (JsonProcessingException error) {
            return new ServiceError("unknown", content);
        }
    }

    private static String requiredText(JsonNode value, String property) {
        JsonNode item = value.get(property);
        if (item == null || !item.isTextual()) {
            throw new IllegalStateException(
                "Foundry property " + property + " must be a string.");
        }
        return item.asText();
    }

    private static String escape(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
            .replace("+", "%20");
    }

    private record ParsedResponse(
        String text,
        List<Citation> citations,
        List<String> context) {
    }

    private record ServiceError(String code, String message) {
    }

    @FunctionalInterface
    private interface IoOperation {
        void run() throws IOException;
    }

    public static final class FoundryHttpException
        extends RuntimeException {
        private final int statusCode;
        private final String errorCode;

        FoundryHttpException(
            int statusCode,
            String errorCode,
            String message) {
            super(message);
            this.statusCode = statusCode;
            this.errorCode = errorCode;
        }

        public int statusCode() {
            return statusCode;
        }

        public String errorCode() {
            return errorCode;
        }
    }

    public static final class CleanupException
        extends RuntimeException {
        CleanupException(String message, List<? extends Throwable> failures) {
            super(message);
            failures.forEach(this::addSuppressed);
        }
    }
}
