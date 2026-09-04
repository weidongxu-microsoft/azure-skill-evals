package com.contoso.support;

import static com.contoso.support.Models.EvaluationCase;
import static com.contoso.support.Models.EvaluationMetric;
import static com.contoso.support.Models.SupportAnswer;

import com.azure.core.exception.ClientAuthenticationException;
import com.azure.core.exception.HttpRequestException;
import com.azure.core.exception.HttpResponseException;
import com.azure.core.exception.ServiceResponseException;
import com.azure.storage.blob.models.BlobStorageException;
import com.contoso.support.FoundryRestGateway.CleanupException;
import com.contoso.support.FoundryRestGateway.FoundryHttpException;
import com.contoso.support.SupportAssistantService.SupportAssistantException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

public final class SupportHttpServer implements AutoCloseable {
    private static final Pattern MESSAGE_PATH = Pattern.compile(
        "^/conversations/([^/]+)/messages$");
    private static final Pattern FEEDBACK_PATH = Pattern.compile(
        "^/conversations/([^/]+)/feedback$");
    private static final Pattern OPERATION_PATH = Pattern.compile(
        "^/admin/operations/([^/]+)$");
    private static final int MAX_BODY_BYTES = 1024 * 1024;

    private final HttpServer server;
    private final SupportAssistantService assistant;
    private final Options options;
    private final ObjectMapper mapper;
    private final ExecutorService requestExecutor =
        Executors.newFixedThreadPool(8);
    private final ExecutorService operationExecutor =
        Executors.newFixedThreadPool(2);
    private final Map<String, OperationRecord> operations =
        new ConcurrentHashMap<>();

    public SupportHttpServer(
        InetSocketAddress address,
        SupportAssistantService assistant,
        Options options,
        ObjectMapper mapper) throws IOException {
        server = HttpServer.create(address, 0);
        this.assistant = assistant;
        this.options = options;
        this.mapper = mapper;
        server.createContext("/", this::handle);
        server.setExecutor(requestExecutor);
    }

    public void start() {
        server.start();
    }

    public int port() {
        return server.getAddress().getPort();
    }

    @Override
    public void close() {
        server.stop(0);
        requestExecutor.shutdown();
        operationExecutor.shutdown();
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            RouteResult result = route(exchange);
            sendJson(exchange, result.status(), result.body());
        } catch (HttpProblem error) {
            sendJson(
                exchange,
                error.status(),
                Map.of("error", error.getMessage()));
        } catch (SupportAssistantException error) {
            int status = "response_not_found".equals(error.code())
                ? 404 : 409;
            sendJson(
                exchange,
                status,
                Map.of(
                    "error", error.getMessage(),
                    "code", error.code()));
        } catch (FoundryHttpException error) {
            sendJson(
                exchange,
                502,
                Map.of(
                    "error", error.getMessage(),
                    "azureStatus", error.statusCode(),
                    "azureCode", error.errorCode()));
        } catch (ClientAuthenticationException error) {
            sendJson(
                exchange,
                502,
                Map.of(
                    "error", error.getMessage(),
                    "azureCode", "authentication_failed"));
        } catch (CleanupException error) {
            sendJson(
                exchange,
                500,
                Map.of("error", error.getMessage()));
        } catch (BlobStorageException error) {
            sendJson(
                exchange,
                502,
                Map.of(
                    "error", error.getMessage(),
                    "azureStatus", error.getStatusCode(),
                    "azureCode", String.valueOf(error.getErrorCode())));
        } catch (HttpRequestException | HttpResponseException
                 | ServiceResponseException error) {
            sendJson(
                exchange,
                502,
                Map.of(
                    "error", error.getMessage(),
                    "azureCode", "agent_operation_failed"));
        } catch (JsonProcessingException error) {
            sendJson(exchange, 400, Map.of("error", "Invalid JSON."));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, Map.of("error", error.getMessage()));
        } catch (IOException | IllegalStateException error) {
            System.err.println("Request failed: " + error.getMessage());
            sendJson(exchange, 500, Map.of("error", error.getMessage()));
        } finally {
            exchange.close();
        }
    }

    private RouteResult route(HttpExchange exchange) throws IOException {
        String method = exchange.getRequestMethod();
        String path = exchange.getRequestURI().getPath();
        if ("GET".equals(method) && "/health".equals(path)) {
            return new RouteResult(200, Map.of("status", "ok"));
        }
        String principalId = principalId(exchange);
        if (path.startsWith("/admin/")) {
            requireAdministrator(principalId);
        }
        if ("POST".equals(method) && "/admin/ingest".equals(path)) {
            assistant.ingest(List.of(options.materials()));
            return new RouteResult(201, Map.of("status", "ingested"));
        }
        Matcher messageMatch = MESSAGE_PATH.matcher(path);
        if (messageMatch.matches()) {
            requireMethod(method, "POST");
            ObjectNode body = readJson(exchange);
            SupportAnswer answer = assistant.ask(
                principalId,
                decode(messageMatch.group(1)),
                requiredText(body, "question"));
            return new RouteResult(200, answer);
        }
        Matcher feedbackMatch = FEEDBACK_PATH.matcher(path);
        if (feedbackMatch.matches()) {
            requireMethod(method, "POST");
            ObjectNode body = readJson(exchange);
            assistant.recordFeedback(
                principalId,
                decode(feedbackMatch.group(1)),
                requiredText(body, "responseId"),
                requiredText(body, "rating"),
                optionalText(body, "comment"));
            return new RouteResult(201, Map.of("status", "recorded"));
        }
        if ("GET".equals(method) && "/admin/unresolved".equals(path)) {
            return new RouteResult(
                200, Map.of("items", assistant.listUnresolved()));
        }
        if ("POST".equals(method) && "/admin/evaluations".equals(path)) {
            String operationId = startEvaluation();
            return new RouteResult(
                202, Map.of("operationId", operationId));
        }
        Matcher operationMatch = OPERATION_PATH.matcher(path);
        if (operationMatch.matches()) {
            requireMethod(method, "GET");
            OperationRecord record = operations.get(
                decode(operationMatch.group(1)));
            if (record == null) {
                throw new HttpProblem(404, "Operation not found.");
            }
            return new RouteResult(200, record);
        }
        if ("DELETE".equals(method)
                && "/admin/resources".equals(path)) {
            if (operations.values().stream()
                    .anyMatch(item -> "running".equals(item.status()))) {
                throw new HttpProblem(
                    409, "Wait for active evaluations before cleanup.");
            }
            assistant.cleanup();
            return new RouteResult(200, Map.of("status", "deleted"));
        }
        throw new HttpProblem(404, "Route not found.");
    }

    private String startEvaluation() {
        String operationId = UUID.randomUUID().toString();
        operations.put(
            operationId, new OperationRecord("running", null, null));
        operationExecutor.submit(() -> {
            try {
                List<EvaluationMetric> result = assistant.evaluate(
                    loadEvaluationCases(options.evaluationDataset()));
                operations.put(
                    operationId,
                    new OperationRecord("completed", result, null));
            } catch (ClientAuthenticationException | CleanupException
                     | FoundryHttpException | BlobStorageException
                     | IOException | IllegalStateException
                     | SupportAssistantException error) {
                System.err.println(
                    "Evaluation " + operationId + " failed: "
                        + error.getMessage());
                operations.put(
                    operationId,
                    new OperationRecord(
                        "failed", null, error.getMessage()));
            }
        });
        return operationId;
    }

    private List<EvaluationCase> loadEvaluationCases(Path path)
        throws IOException {
        List<EvaluationCase> cases = new ArrayList<>();
        try (Stream<String> lines = Files.lines(path)) {
            int[] lineNumber = {0};
            lines.forEach(line -> {
                lineNumber[0]++;
                if (line.isBlank()) {
                    return;
                }
                try {
                    JsonNode value = mapper.readTree(line);
                    cases.add(new EvaluationCase(
                        requiredText(value, "id"),
                        requiredText(value, "query"),
                        requiredText(value, "groundTruth")));
                } catch (JsonProcessingException | HttpProblem error) {
                    throw new EvaluationDataException(
                        "Invalid evaluation case at " + path + ":"
                            + lineNumber[0] + ".",
                        error);
                }
            });
        } catch (EvaluationDataException error) {
            throw new IOException(error.getMessage(), error.getCause());
        }
        if (cases.isEmpty()) {
            throw new IOException(
                "Evaluation dataset is empty: " + path);
        }
        return cases;
    }

    private ObjectNode readJson(HttpExchange exchange)
        throws IOException {
        String lengthHeader = exchange.getRequestHeaders()
            .getFirst("Content-Length");
        int length = lengthHeader == null
            ? 0 : Integer.parseInt(lengthHeader);
        if (length > MAX_BODY_BYTES) {
            throw new HttpProblem(
                413, "Request body exceeds 1 MiB.");
        }
        try (InputStream input = exchange.getRequestBody()) {
            byte[] content = input.readNBytes(MAX_BODY_BYTES + 1);
            if (content.length > MAX_BODY_BYTES) {
                throw new HttpProblem(
                    413, "Request body exceeds 1 MiB.");
            }
            JsonNode value = mapper.readTree(
                content.length == 0 ? "{}" : new String(
                    content, StandardCharsets.UTF_8));
            if (!(value instanceof ObjectNode object)) {
                throw new HttpProblem(
                    400, "Request body must be a JSON object.");
            }
            return object;
        }
    }

    private String principalId(HttpExchange exchange) {
        String principalId = exchange.getRequestHeaders()
            .getFirst("X-MS-CLIENT-PRINCIPAL-ID");
        if (!options.requireAuthentication()) {
            return principalId == null || principalId.isBlank()
                ? "test-user" : principalId.trim();
        }
        if (principalId == null || principalId.isBlank()) {
            throw new HttpProblem(
                401, "Microsoft Entra authentication is required.");
        }
        return principalId.trim();
    }

    private void requireAdministrator(String principalId) {
        if (!options.adminPrincipalIds().contains(principalId)) {
            throw new HttpProblem(
                403, "Administrator access is required.");
        }
    }

    private static void requireMethod(
        String actual,
        String expected) {
        if (!expected.equals(actual)) {
            throw new HttpProblem(405, "Method not allowed.");
        }
    }

    private void sendJson(
        HttpExchange exchange,
        int status,
        Object body) throws IOException {
        byte[] content = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set(
            "Content-Type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
    }

    private static String requiredText(JsonNode value, String property) {
        JsonNode item = value.get(property);
        if (item == null || !item.isTextual()
                || item.asText().isBlank()) {
            throw new HttpProblem(
                400, property + " is required.");
        }
        return item.asText().trim();
    }

    private static String optionalText(JsonNode value, String property) {
        JsonNode item = value.get(property);
        if (item == null || item.isNull()) {
            return null;
        }
        if (!item.isTextual() || item.asText().isBlank()) {
            throw new HttpProblem(
                400, property + " must be a non-empty string.");
        }
        return item.asText().trim();
    }

    private static String decode(String value) {
        return URI.create("http://localhost/" + value)
            .getPath().substring(1);
    }

    public record Options(
        boolean requireAuthentication,
        Set<String> adminPrincipalIds,
        Path[] materials,
        Path evaluationDataset) {
        public Options {
            adminPrincipalIds = Set.copyOf(adminPrincipalIds);
            materials = materials.clone();
        }
    }

    private record RouteResult(int status, Object body) {
    }

    private record OperationRecord(
        String status,
        Object result,
        String error) {
    }

    private static final class HttpProblem
        extends RuntimeException {
        private final int status;

        HttpProblem(int status, String message) {
            super(message);
            this.status = status;
        }

        int status() {
            return status;
        }
    }

    private static final class EvaluationDataException
        extends RuntimeException {
        EvaluationDataException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
