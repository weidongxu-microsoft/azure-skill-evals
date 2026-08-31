import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  javaCheckNames,
  loadJavaWorkspace,
} from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/storage-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);

function workspace(source, build = golden.build) {
  return {
    sourceFiles: ["Main.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
  };
}

const baseline33374429826 = {
  sourceFiles: ["src/main/java/com/example/blob/AzureBlobConfiguration.java", "src/main/java/com/example/blob/BlobStorageAsyncService.java", "src/main/java/com/example/blob/BlobStorageService.java", "src/main/java/com/example/blob/Main.java"],
  buildFiles: ["pom.xml"],
  source: [
  [
    "package com.example.blob;",
    "",
    "import com.azure.core.http.policy.HttpLogDetailLevel;",
    "import com.azure.core.http.policy.HttpLogOptions;",
    "import com.azure.core.http.policy.TimeoutPolicy;",
    "import com.azure.identity.DefaultAzureCredential;",
    "import com.azure.identity.DefaultAzureCredentialBuilder;",
    "import com.azure.storage.blob.BlobServiceAsyncClient;",
    "import com.azure.storage.blob.BlobServiceClient;",
    "import com.azure.storage.blob.BlobServiceClientBuilder;",
    "import com.azure.storage.common.policy.RequestRetryOptions;",
    "import com.azure.storage.common.policy.RetryPolicyType;",
    "",
    "import java.time.Duration;",
    "import java.util.Locale;",
    "import java.util.Map;",
    "import java.util.Objects;",
    "",
    "public final class AzureBlobConfiguration {",
    "    public static final String ENDPOINT_ENV = \"AZURE_STORAGE_ACCOUNT_ENDPOINT\";",
    "",
    "    private final String endpoint;",
    "    private final int maxRetries;",
    "    private final Duration retryDelay;",
    "    private final Duration maxRetryDelay;",
    "    private final Duration requestTimeout;",
    "    private final HttpLogDetailLevel logLevel;",
    "",
    "    public AzureBlobConfiguration(",
    "            String endpoint,",
    "            int maxRetries,",
    "            Duration retryDelay,",
    "            Duration maxRetryDelay,",
    "            Duration requestTimeout,",
    "            HttpLogDetailLevel logLevel) {",
    "        this.endpoint = requireEndpoint(endpoint);",
    "        this.maxRetries = requireNonNegative(maxRetries, \"maxRetries\");",
    "        this.retryDelay = requirePositive(retryDelay, \"retryDelay\");",
    "        this.maxRetryDelay = requirePositive(maxRetryDelay, \"maxRetryDelay\");",
    "        this.requestTimeout = requirePositive(requestTimeout, \"requestTimeout\");",
    "        this.logLevel = Objects.requireNonNull(logLevel, \"logLevel\");",
    "    }",
    "",
    "    public static AzureBlobConfiguration fromEnvironment() {",
    "        Map<String, String> environment = System.getenv();",
    "        return new AzureBlobConfiguration(",
    "                environment.get(ENDPOINT_ENV),",
    "                readInt(environment, \"AZURE_STORAGE_MAX_RETRIES\", 5),",
    "                Duration.ofMillis(readLong(environment, \"AZURE_STORAGE_RETRY_DELAY_MS\", 1_000)),",
    "                Duration.ofMillis(readLong(environment, \"AZURE_STORAGE_MAX_RETRY_DELAY_MS\", 30_000)),",
    "                Duration.ofSeconds(readLong(environment, \"AZURE_STORAGE_REQUEST_TIMEOUT_SECONDS\", 120)),",
    "                readLogLevel(environment.getOrDefault(\"AZURE_HTTP_LOG_LEVEL\", \"BASIC\")));",
    "    }",
    "",
    "    public BlobServiceClient createSyncClient() {",
    "        return clientBuilder().buildClient();",
    "    }",
    "",
    "    public BlobServiceAsyncClient createAsyncClient() {",
    "        return clientBuilder().buildAsyncClient();",
    "    }",
    "",
    "    private BlobServiceClientBuilder clientBuilder() {",
    "        DefaultAzureCredential credential = new DefaultAzureCredentialBuilder().build();",
    "        RequestRetryOptions retryOptions = new RequestRetryOptions(",
    "                RetryPolicyType.EXPONENTIAL,",
    "                maxRetries,",
    "                null,",
    "                retryDelay,",
    "                maxRetryDelay,",
    "                null);",
    "",
    "        return new BlobServiceClientBuilder()",
    "                .endpoint(endpoint)",
    "                .credential(credential)",
    "                .retryOptions(retryOptions)",
    "                .addPolicy(new TimeoutPolicy(requestTimeout))",
    "                .httpLogOptions(new HttpLogOptions().setLogLevel(logLevel));",
    "    }",
    "",
    "    private static String requireEndpoint(String value) {",
    "        if (value == null || value.isBlank()) {",
    "            throw new IllegalArgumentException(",
    "                    ENDPOINT_ENV + \" must contain a storage endpoint such as https://account.blob.core.windows.net\");",
    "        }",
    "        String endpoint = value.strip();",
    "        if (!endpoint.startsWith(\"https://\")) {",
    "            throw new IllegalArgumentException(ENDPOINT_ENV + \" must use HTTPS\");",
    "        }",
    "        return endpoint;",
    "    }",
    "",
    "    private static int readInt(Map<String, String> environment, String name, int defaultValue) {",
    "        return Math.toIntExact(readLong(environment, name, defaultValue));",
    "    }",
    "",
    "    private static long readLong(Map<String, String> environment, String name, long defaultValue) {",
    "        String value = environment.get(name);",
    "        if (value == null || value.isBlank()) {",
    "            return defaultValue;",
    "        }",
    "        try {",
    "            return Long.parseLong(value);",
    "        } catch (NumberFormatException exception) {",
    "            throw new IllegalArgumentException(name + \" must be an integer\", exception);",
    "        }",
    "    }",
    "",
    "    private static HttpLogDetailLevel readLogLevel(String value) {",
    "        try {",
    "            return HttpLogDetailLevel.valueOf(value.strip().toUpperCase(Locale.ROOT));",
    "        } catch (IllegalArgumentException exception) {",
    "            throw new IllegalArgumentException(",
    "                    \"AZURE_HTTP_LOG_LEVEL must be one of NONE, BASIC, HEADERS, BODY, or BODY_AND_HEADERS\",",
    "                    exception);",
    "        }",
    "    }",
    "",
    "    private static int requireNonNegative(int value, String name) {",
    "        if (value < 0) {",
    "            throw new IllegalArgumentException(name + \" must not be negative\");",
    "        }",
    "        return value;",
    "    }",
    "",
    "    private static Duration requirePositive(Duration value, String name) {",
    "        Objects.requireNonNull(value, name);",
    "        if (value.isZero() || value.isNegative()) {",
    "            throw new IllegalArgumentException(name + \" must be positive\");",
    "        }",
    "        return value;",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.blob;",
    "",
    "import com.azure.storage.blob.BlobAsyncClient;",
    "import com.azure.storage.blob.BlobContainerAsyncClient;",
    "import com.azure.storage.blob.BlobServiceAsyncClient;",
    "import com.azure.storage.blob.models.AccessTier;",
    "import com.azure.storage.blob.models.BlobHttpHeaders;",
    "import com.azure.storage.blob.models.BlobItem;",
    "import com.azure.storage.blob.models.BlobRequestConditions;",
    "import com.azure.storage.blob.models.ParallelTransferOptions;",
    "import com.azure.storage.blob.options.BlobUploadFromFileOptions;",
    "import com.azure.storage.blob.specialized.BlobLeaseAsyncClient;",
    "import com.azure.storage.blob.specialized.BlobLeaseClientBuilder;",
    "import reactor.core.publisher.Flux;",
    "import reactor.core.publisher.Mono;",
    "",
    "import java.nio.file.Path;",
    "import java.util.Map;",
    "import java.util.Objects;",
    "",
    "public final class BlobStorageAsyncService {",
    "    private static final int BLOCK_SIZE = 8 * 1024 * 1024;",
    "    private static final int MAX_CONCURRENCY = 4;",
    "",
    "    private final BlobContainerAsyncClient container;",
    "",
    "    public BlobStorageAsyncService(BlobServiceAsyncClient serviceClient, String containerName) {",
    "        Objects.requireNonNull(serviceClient, \"serviceClient\");",
    "        if (containerName == null || containerName.isBlank()) {",
    "            throw new IllegalArgumentException(\"containerName must not be blank\");",
    "        }",
    "        this.container = serviceClient.getBlobContainerAsyncClient(containerName);",
    "    }",
    "",
    "    public Mono<Void> upload(",
    "            String blobName,",
    "            Path source,",
    "            Map<String, String> metadata,",
    "            Map<String, String> tags) {",
    "        BlobRequestConditions createOnly = new BlobRequestConditions().setIfNoneMatch(\"*\");",
    "        return upload(blobName, source, metadata, tags, createOnly);",
    "    }",
    "",
    "    public Mono<Void> overwriteLeased(",
    "            String blobName,",
    "            Path source,",
    "            Map<String, String> metadata,",
    "            Map<String, String> tags,",
    "            String expectedETag,",
    "            String leaseId) {",
    "        if (expectedETag == null || expectedETag.isBlank()) {",
    "            return Mono.error(new IllegalArgumentException(\"expectedETag is required for a safe update\"));",
    "        }",
    "        if (leaseId == null || leaseId.isBlank()) {",
    "            return Mono.error(new IllegalArgumentException(\"leaseId is required for a leased update\"));",
    "        }",
    "        BlobRequestConditions conditions = new BlobRequestConditions()",
    "                .setIfMatch(expectedETag)",
    "                .setLeaseId(leaseId);",
    "        return upload(blobName, source, metadata, tags, conditions);",
    "    }",
    "",
    "    public Mono<Void> download(String blobName, Path destination) {",
    "        return blob(blobName).downloadToFile(destination.toString(), true).then();",
    "    }",
    "",
    "    public Flux<BlobItem> list() {",
    "        return container.listBlobs();",
    "    }",
    "",
    "    public Mono<Boolean> delete(String blobName) {",
    "        return blob(blobName).deleteIfExists();",
    "    }",
    "",
    "    public BlobLeaseAsyncClient leaseClient(String blobName) {",
    "        return new BlobLeaseClientBuilder().blobAsyncClient(blob(blobName)).buildAsyncClient();",
    "    }",
    "",
    "    public Mono<String> eTag(String blobName) {",
    "        return blob(blobName).getProperties().map(properties -> properties.getETag());",
    "    }",
    "",
    "    private Mono<Void> upload(",
    "            String blobName,",
    "            Path source,",
    "            Map<String, String> metadata,",
    "            Map<String, String> tags,",
    "            BlobRequestConditions conditions) {",
    "        Objects.requireNonNull(source, \"source\");",
    "        ParallelTransferOptions transferOptions = new ParallelTransferOptions()",
    "                .setBlockSizeLong((long) BLOCK_SIZE)",
    "                .setMaxConcurrency(MAX_CONCURRENCY);",
    "",
    "        BlobUploadFromFileOptions options = new BlobUploadFromFileOptions(source.toString())",
    "                .setParallelTransferOptions(transferOptions)",
    "                .setHeaders(new BlobHttpHeaders())",
    "                .setMetadata(metadata == null ? Map.of() : Map.copyOf(metadata))",
    "                .setTags(tags == null ? Map.of() : Map.copyOf(tags))",
    "                .setTier(AccessTier.HOT)",
    "                .setRequestConditions(conditions);",
    "        return blob(blobName).uploadFromFileWithResponse(options)",
    "                .then();",
    "    }",
    "",
    "    private BlobAsyncClient blob(String blobName) {",
    "        if (blobName == null || blobName.isBlank()) {",
    "            throw new IllegalArgumentException(\"blobName must not be blank\");",
    "        }",
    "        return container.getBlobAsyncClient(blobName);",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.blob;",
    "",
    "import com.azure.storage.blob.BlobClient;",
    "import com.azure.storage.blob.BlobContainerClient;",
    "import com.azure.storage.blob.BlobServiceClient;",
    "import com.azure.storage.blob.models.AccessTier;",
    "import com.azure.storage.blob.models.BlobHttpHeaders;",
    "import com.azure.storage.blob.models.BlobItem;",
    "import com.azure.storage.blob.models.BlobRequestConditions;",
    "import com.azure.storage.blob.models.ParallelTransferOptions;",
    "import com.azure.storage.blob.options.BlobUploadFromFileOptions;",
    "import com.azure.storage.blob.specialized.BlobLeaseClient;",
    "import com.azure.storage.blob.specialized.BlobLeaseClientBuilder;",
    "",
    "import java.nio.file.Path;",
    "import java.util.List;",
    "import java.util.Map;",
    "import java.util.Objects;",
    "",
    "public final class BlobStorageService {",
    "    private static final int BLOCK_SIZE = 8 * 1024 * 1024;",
    "    private static final int MAX_CONCURRENCY = 4;",
    "",
    "    private final BlobContainerClient container;",
    "",
    "    public BlobStorageService(BlobServiceClient serviceClient, String containerName) {",
    "        Objects.requireNonNull(serviceClient, \"serviceClient\");",
    "        if (containerName == null || containerName.isBlank()) {",
    "            throw new IllegalArgumentException(\"containerName must not be blank\");",
    "        }",
    "        this.container = serviceClient.getBlobContainerClient(containerName);",
    "    }",
    "",
    "    public void upload(String blobName, Path source, Map<String, String> metadata, Map<String, String> tags) {",
    "        BlobRequestConditions createOnly = new BlobRequestConditions().setIfNoneMatch(\"*\");",
    "        upload(blobName, source, metadata, tags, createOnly);",
    "    }",
    "",
    "    public void overwriteLeased(",
    "            String blobName,",
    "            Path source,",
    "            Map<String, String> metadata,",
    "            Map<String, String> tags,",
    "            String expectedETag,",
    "            String leaseId) {",
    "        if (expectedETag == null || expectedETag.isBlank()) {",
    "            throw new IllegalArgumentException(\"expectedETag is required for a safe update\");",
    "        }",
    "        if (leaseId == null || leaseId.isBlank()) {",
    "            throw new IllegalArgumentException(\"leaseId is required for a leased update\");",
    "        }",
    "        BlobRequestConditions conditions = new BlobRequestConditions()",
    "                .setIfMatch(expectedETag)",
    "                .setLeaseId(leaseId);",
    "        upload(blobName, source, metadata, tags, conditions);",
    "    }",
    "",
    "    public void download(String blobName, Path destination) {",
    "        blob(blobName).downloadToFile(destination.toString(), true);",
    "    }",
    "",
    "    public List<BlobItem> list() {",
    "        return container.listBlobs().stream().toList();",
    "    }",
    "",
    "    public boolean delete(String blobName) {",
    "        return blob(blobName).deleteIfExists();",
    "    }",
    "",
    "    public BlobLeaseClient leaseClient(String blobName) {",
    "        return new BlobLeaseClientBuilder().blobClient(blob(blobName)).buildClient();",
    "    }",
    "",
    "    public String eTag(String blobName) {",
    "        return blob(blobName).getProperties().getETag();",
    "    }",
    "",
    "    private void upload(",
    "            String blobName,",
    "            Path source,",
    "            Map<String, String> metadata,",
    "            Map<String, String> tags,",
    "            BlobRequestConditions conditions) {",
    "        Objects.requireNonNull(source, \"source\");",
    "        ParallelTransferOptions transferOptions = new ParallelTransferOptions()",
    "                .setBlockSizeLong((long) BLOCK_SIZE)",
    "                .setMaxConcurrency(MAX_CONCURRENCY);",
    "",
    "        BlobUploadFromFileOptions options = new BlobUploadFromFileOptions(source.toString())",
    "                .setParallelTransferOptions(transferOptions)",
    "                .setHeaders(new BlobHttpHeaders())",
    "                .setMetadata(metadata == null ? Map.of() : Map.copyOf(metadata))",
    "                .setTags(tags == null ? Map.of() : Map.copyOf(tags))",
    "                .setTier(AccessTier.HOT)",
    "                .setRequestConditions(conditions);",
    "        blob(blobName).uploadFromFileWithResponse(options, null, null);",
    "    }",
    "",
    "    private BlobClient blob(String blobName) {",
    "        if (blobName == null || blobName.isBlank()) {",
    "            throw new IllegalArgumentException(\"blobName must not be blank\");",
    "        }",
    "        return container.getBlobClient(blobName);",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.blob;",
    "",
    "import com.azure.storage.blob.models.BlobItem;",
    "import com.azure.storage.blob.specialized.BlobLeaseAsyncClient;",
    "import com.azure.storage.blob.specialized.BlobLeaseClient;",
    "import reactor.core.publisher.Mono;",
    "import reactor.core.scheduler.Schedulers;",
    "",
    "import java.nio.file.Files;",
    "import java.nio.file.Path;",
    "import java.util.Map;",
    "",
    "public final class Main {",
    "    private static final String CONTAINER_ENV = \"AZURE_STORAGE_CONTAINER\";",
    "",
    "    private Main() {",
    "    }",
    "",
    "    public static void main(String[] args) throws Exception {",
    "        AzureBlobConfiguration configuration = AzureBlobConfiguration.fromEnvironment();",
    "        String containerName = System.getenv().getOrDefault(CONTAINER_ENV, \"blob-manager-demo\");",
    "        Path workDirectory = Files.createTempDirectory(\"azure-blob-demo-\");",
    "",
    "        runSyncDemo(configuration, containerName, workDirectory);",
    "        runAsyncDemo(configuration, containerName, workDirectory).block();",
    "",
    "        System.out.println(\"All demonstrations completed. Local files: \" + workDirectory);",
    "    }",
    "",
    "    private static void runSyncDemo(",
    "            AzureBlobConfiguration configuration,",
    "            String containerName,",
    "            Path workDirectory) throws Exception {",
    "        System.out.println(\"--- Synchronous operations ---\");",
    "        BlobStorageService service = new BlobStorageService(configuration.createSyncClient(), containerName);",
    "        String blobName = \"sync-sample.txt\";",
    "        Path source = workDirectory.resolve(\"sync-source.txt\");",
    "        Path download = workDirectory.resolve(\"sync-download.txt\");",
    "        Map<String, String> metadata = Map.of(\"demo\", \"sync\");",
    "        Map<String, String> tags = Map.of(\"project\", \"blob-manager\", \"mode\", \"sync\");",
    "",
    "        Files.writeString(source, \"Initial synchronous content\\n\");",
    "        System.out.println(\"Uploading \" + blobName + \" with index tags\");",
    "        service.upload(blobName, source, metadata, tags);",
    "",
    "        System.out.println(\"Listing blobs\");",
    "        service.list().stream().map(BlobItem::getName).forEach(name -> System.out.println(\"  \" + name));",
    "",
    "        System.out.println(\"Downloading \" + blobName);",
    "        service.download(blobName, download);",
    "",
    "        BlobLeaseClient lease = service.leaseClient(blobName);",
    "        System.out.println(\"Acquiring lease and overwriting \" + blobName);",
    "        String leaseId = lease.acquireLease(60);",
    "        try {",
    "            String eTag = service.eTag(blobName);",
    "            Files.writeString(source, \"Updated synchronous content\\n\");",
    "            service.overwriteLeased(blobName, source, metadata, tags, eTag, leaseId);",
    "        } finally {",
    "            lease.releaseLease();",
    "        }",
    "",
    "        System.out.println(\"Deleting \" + blobName);",
    "        service.delete(blobName);",
    "    }",
    "",
    "    private static Mono<Void> runAsyncDemo(",
    "            AzureBlobConfiguration configuration,",
    "            String containerName,",
    "            Path workDirectory) throws Exception {",
    "        System.out.println(\"--- Asynchronous operations ---\");",
    "        BlobStorageAsyncService service =",
    "                new BlobStorageAsyncService(configuration.createAsyncClient(), containerName);",
    "        String blobName = \"async-sample.txt\";",
    "        Path source = workDirectory.resolve(\"async-source.txt\");",
    "        Path download = workDirectory.resolve(\"async-download.txt\");",
    "        Map<String, String> metadata = Map.of(\"demo\", \"async\");",
    "        Map<String, String> tags = Map.of(\"project\", \"blob-manager\", \"mode\", \"async\");",
    "        Files.writeString(source, \"Initial asynchronous content\\n\");",
    "",
    "        Mono<Void> overwrite = Mono.defer(() -> {",
    "            BlobLeaseAsyncClient lease = service.leaseClient(blobName);",
    "            System.out.println(\"Acquiring lease and overwriting \" + blobName);",
    "            return Mono.usingWhen(",
    "                    lease.acquireLease(60).thenReturn(lease),",
    "                    ignored -> service.eTag(blobName)",
    "                            .flatMap(eTag -> Mono.fromCallable(() -> {",
    "                                        Files.writeString(source, \"Updated asynchronous content\\n\");",
    "                                        return eTag;",
    "                                    })",
    "                                    .subscribeOn(Schedulers.boundedElastic())",
    "                                    .flatMap(value -> service.overwriteLeased(",
    "                                            blobName, source, metadata, tags, value, lease.getLeaseId()))),",
    "                    BlobLeaseAsyncClient::releaseLease);",
    "        });",
    "",
    "        System.out.println(\"Uploading \" + blobName + \" with index tags\");",
    "        return service.upload(blobName, source, metadata, tags)",
    "                .then(Mono.defer(() -> {",
    "                    System.out.println(\"Listing blobs\");",
    "                    return service.list()",
    "                            .doOnNext(item -> System.out.println(\"  \" + item.getName()))",
    "                            .then();",
    "                }))",
    "                .then(Mono.defer(() -> {",
    "                    System.out.println(\"Downloading \" + blobName);",
    "                    return service.download(blobName, download);",
    "                }))",
    "                .then(overwrite)",
    "                .then(Mono.defer(() -> {",
    "                    System.out.println(\"Deleting \" + blobName);",
    "                    return service.delete(blobName).then();",
    "                }));",
    "    }",
    "}",
    ""
].join("\n")
].join("\n"),
  build: [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<project xmlns=\"http://maven.apache.org/POM/4.0.0\"",
    "         xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"",
    "         xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">",
    "    <modelVersion>4.0.0</modelVersion>",
    "",
    "    <groupId>com.example</groupId>",
    "    <artifactId>azure-blob-manager</artifactId>",
    "    <version>1.0.0</version>",
    "",
    "    <properties>",
    "        <maven.compiler.release>17</maven.compiler.release>",
    "        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>",
    "        <azure.storage.blob.version>12.31.2</azure.storage.blob.version>",
    "        <azure.identity.version>1.16.2</azure.identity.version>",
    "        <slf4j.version>2.0.17</slf4j.version>",
    "    </properties>",
    "",
    "    <dependencies>",
    "        <dependency>",
    "            <groupId>com.azure</groupId>",
    "            <artifactId>azure-storage-blob</artifactId>",
    "            <version>${azure.storage.blob.version}</version>",
    "        </dependency>",
    "        <dependency>",
    "            <groupId>com.azure</groupId>",
    "            <artifactId>azure-identity</artifactId>",
    "            <version>${azure.identity.version}</version>",
    "        </dependency>",
    "        <dependency>",
    "            <groupId>org.slf4j</groupId>",
    "            <artifactId>slf4j-simple</artifactId>",
    "            <version>${slf4j.version}</version>",
    "            <scope>runtime</scope>",
    "        </dependency>",
    "    </dependencies>",
    "",
    "    <build>",
    "        <plugins>",
    "            <plugin>",
    "                <groupId>org.apache.maven.plugins</groupId>",
    "                <artifactId>maven-compiler-plugin</artifactId>",
    "                <version>3.14.0</version>",
    "            </plugin>",
    "            <plugin>",
    "                <groupId>org.codehaus.mojo</groupId>",
    "                <artifactId>exec-maven-plugin</artifactId>",
    "                <version>3.5.0</version>",
    "                <configuration>",
    "                    <mainClass>com.example.blob.Main</mainClass>",
    "                </configuration>",
    "            </plugin>",
    "        </plugins>",
    "    </build>",
    "</project>",
    ""
].join("\n"),
};

test("the golden application passes prompt and shared Java checks", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-dependencies",
    "prompt/secure-configuration",
    "prompt/retry-timeout-logging",
    "prompt/sync-service-operations",
    "prompt/async-service-operations",
    "prompt/parallel-upload-and-tags",
    "prompt/lease-overwrite",
    "prompt/reactive-demo-flow",
  ]);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test("the golden Maven app declares concrete Java SDK versions", () => {
  assert.match(
    golden.build,
    /<artifactId>azure-identity<\/artifactId>\s*<version>1\.18\.5<\/version>/,
  );
  assert.match(
    golden.build,
    /<artifactId>azure-storage-blob<\/artifactId>\s*<version>12\.35\.1<\/version>/,
  );
});

test("both compatible active Azure dependencies are required", () => {
  for (const [artifact, version] of [
    ["azure-identity", "1.18.5"],
    ["azure-storage-blob", "12.35.1"],
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", {
        ...golden,
        build: golden.build.replace(
          `<version>${version}</version>`,
          "<version>0.0.1</version>",
        ),
      }),
      false,
      artifact,
    );
  }
});

test("compatible stable Azure SDK versions are accepted", () => {
  const build = golden.build
    .replace(
      "<version>1.18.5</version>",
      "<version>1.16.2</version>",
    )
    .replace(
      "<version>12.35.1</version>",
      "<version>12.31.2</version>",
    );

  assert.equal(
    evaluateRule("prompt/sdk-dependencies", { ...golden, build }),
    true,
  );
});

test("test-only and development Azure dependencies do not count", () => {
  const testOnly = golden.build.replaceAll(
    "</dependency>",
    "<scope>test</scope></dependency>",
  );
  const development = golden.build.replace(
    "<version>1.18.5</version>",
    "<version>1.18.5-dev</version>",
  );

  assert.equal(
    evaluateRule("prompt/sdk-dependencies", { ...golden, build: testOnly }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/sdk-dependencies", {
      ...golden,
      build: development,
    }),
    false,
  );
});

test("secure configuration ignores comments, strings, unreachable branches, and fake SDK types", () => {
  const fakeSource = `
class DefaultAzureCredentialBuilder {
  DefaultAzureCredentialBuilder build() { return this; }
}
class BlobServiceClientBuilder {
  BlobServiceClientBuilder endpoint(String value) { return this; }
  BlobServiceClientBuilder credential(Object value) { return this; }
  BlobServiceClientBuilder retryOptions(Object value) { return this; }
  BlobServiceClientBuilder httpLogOptions(Object value) { return this; }
  Object buildClient() { return this; }
  Object buildAsyncClient() { return this; }
}
class Main {
  public static void main(String[] args) {
    String prose = "new BlobServiceClientBuilder().endpoint(System.getenv(\\\"AZURE_STORAGE_ACCOUNT_URL\\\"))";
    // new BlobServiceClientBuilder().endpoint(System.getenv("AZURE_STORAGE_ACCOUNT_URL"));
    if (false) {
      new BlobServiceClientBuilder()
          .endpoint(System.getenv("AZURE_STORAGE_ACCOUNT_URL"))
          .credential(new DefaultAzureCredentialBuilder().build())
          .buildClient();
    }
  }
}`;
  assert.equal(
    evaluateRule("prompt/secure-configuration", workspace(fakeSource)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/retry-timeout-logging", workspace(fakeSource)),
    false,
  );
});

test("connection strings and account-key forms fail secure configuration", () => {
  const connectionStringSource = golden.source
    .replaceAll(".endpoint(endpoint)", ".connectionString(endpoint)")
    .replaceAll(".endpoint(accountUrl)", ".connectionString(accountUrl)");
  assert.equal(
    evaluateRule(
      "prompt/secure-configuration",
      workspace(connectionStringSource),
    ),
    false,
  );

  const sharedKeySource = golden.source.replace(
    "new DefaultAzureCredentialBuilder().build()",
    "new StorageSharedKeyCredential(\"account\", \"key\")",
  );
  assert.equal(
    evaluateRule("prompt/secure-configuration", workspace(sharedKeySource)),
    false,
  );
});

test("stepwise builder configuration remains accepted", () => {
  const stepwise = golden.source.replace(
    /return new BlobServiceClientBuilder\(\)[\s\S]*?\.httpLogOptions\(logOptions\);/,
    `BlobServiceClientBuilder builder = new BlobServiceClientBuilder();
        builder.endpoint(endpoint);
        builder.credential(new DefaultAzureCredentialBuilder().build());
        builder.retryOptions(retryOptions);
        builder.httpLogOptions(logOptions);
        return builder;`,
  );

  assert.equal(
    evaluateRule("prompt/secure-configuration", workspace(stepwise)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/retry-timeout-logging", workspace(stepwise)),
    true,
  );
});

test("retry, timeout, and HttpLogOptions are all required", () => {
  for (const source of [
    golden.source.replace("RetryPolicyType.EXPONENTIAL", "RetryPolicyType.FIXED"),
    golden.source.replace("Duration.ofSeconds(30)", "null"),
    golden.source.replace(
      "new HttpLogOptions().setLogLevel(logLevel)",
      "new HttpLogOptions()",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/retry-timeout-logging", workspace(source)),
      false,
    );
  }
});

test("sync and async lifecycle rules require one connected blob lifecycle each", () => {
  const wrongSyncBlob = golden.source.replace(
    "syncManager.downloadBlob(containerName, blobName, syncDownloadPath);",
    'syncManager.downloadBlob(containerName, "other-blob.txt", syncDownloadPath);',
  );
  assert.equal(
    evaluateRule("prompt/sync-service-operations", workspace(wrongSyncBlob)),
    false,
  );

  const wrongAsyncBlobDelete = golden.source.replace(
    "Mono<Void> deleteBlobStep = asyncManager.deleteBlobAsync(containerName, blobName);",
    'Mono<Void> deleteBlobStep = asyncManager.deleteBlobAsync(containerName, "other-blob.txt");',
  );
  assert.equal(
    evaluateRule("prompt/async-service-operations", workspace(wrongAsyncBlobDelete)),
    false,
  );
});

test("blob lifecycle rules accept valid implementations without optional container helpers", () => {
  const blobOnlyLifecycle = golden.source
    .replace('        syncManager.ensureContainer(containerName);\n', "")
    .replace('        syncManager.deleteContainer(containerName);\n', "")
    .replace('        Mono<Void> createStep = asyncManager.ensureContainerAsync(containerName);\n', "")
    .replace('        Mono<Void> deleteContainerStep = asyncManager.deleteContainerAsync(containerName);\n', "")
    .replace('        createStep\n', "        uploadStep\n")
    .replace('                .then(deleteBlobStep)\n                .then(deleteContainerStep)\n', "                .then(deleteBlobStep)\n");

  assert.equal(
    evaluateRule("prompt/sync-service-operations", workspace(blobOnlyLifecycle)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/async-service-operations", workspace(blobOnlyLifecycle)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/reactive-demo-flow", workspace(blobOnlyLifecycle)),
    true,
  );
});

test("blob lifecycle rules still require each prompt-mandated blob operation", () => {
  for (const [rule, source] of [
    [
      "prompt/sync-service-operations",
      golden.source.replace(
        "syncManager.listBlobs(containerName);",
        '// syncManager.listBlobs(containerName);',
      ),
    ],
    [
      "prompt/async-service-operations",
      golden.source.replace(
        /Mono<Void> overwriteStep = asyncManager\.overwriteWithLeaseAsync\([\s\S]*?"async-demo-lease"\);/,
        "Mono<Void> overwriteStep = Mono.empty();",
      ),
    ],
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test("parallel upload grading requires tags instead of metadata-only uploads", () => {
  const missingTags = golden.source.replaceAll(
    ".setTags(indexTags)",
    ".setMetadata(indexTags)",
  ).replaceAll(
    ".setTags(overwriteTags)",
    ".setMetadata(overwriteTags)",
  );
  assert.equal(
    evaluateRule("prompt/parallel-upload-and-tags", workspace(missingTags)),
    false,
  );
});

test("lease overwrite requires both acquisition and matching request conditions", () => {
  const missingAcquire = golden.source.replaceAll("leaseClient.acquireLease(30)", "leaseClient.releaseLease()");
  assert.equal(
    evaluateRule("prompt/lease-overwrite", workspace(missingAcquire)),
    false,
  );

  const wrongLeaseId = golden.source.replaceAll(
    ".setLeaseId(leaseId)",
    '.setLeaseId("different-lease")',
  );
  assert.equal(
    evaluateRule("prompt/lease-overwrite", workspace(wrongLeaseId)),
    false,
  );
});

test("the async demo must use a blocked reactive chain after the sync demo", () => {
  const asyncFirst = golden.source.replace(
    "syncManager.deleteBlob(containerName, blobName);",
    `Mono<Void> eagerAsync = asyncManager.uploadBlobAsync(
                containerName,
                blobName,
                uploadPath,
                metadata,
                indexTags);
        syncManager.deleteBlob(containerName, blobName);`,
  );
  assert.equal(
    evaluateRule("prompt/reactive-demo-flow", workspace(asyncFirst)),
    false,
  );

  const unblocked = golden.source.replace(".block();", ";");
  assert.equal(
    evaluateRule("prompt/reactive-demo-flow", workspace(unblocked)),
    false,
  );
});

test("all prompt graders reject a workspace without generated Java source", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, {
        sourceFiles: [],
        buildFiles: ["pom.xml"],
        source: "",
        build: golden.build,
      }),
      false,
      rule,
    );
  }
});

test("baseline run 33374429826 exact Blob Storage manager output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, baseline33374429826), true, check);
  }
});
