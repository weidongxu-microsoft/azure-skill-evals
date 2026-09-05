package com.example;

import com.azure.ai.agents.persistent.*;
import com.azure.ai.agents.persistent.models.*;
import com.azure.core.util.BinaryData;
import com.azure.identity.DefaultAzureCredentialBuilder;
import java.util.List;
import java.util.concurrent.TimeUnit;

public final class AgentFileSearch {
    private static final String GUIDE
        = "The Contoso Trail Guide says the Cascade Loop is 42 kilometers long "
        + "and hikers should bring a rain jacket.";
    private static final String QUESTION
        = "According to the uploaded guide, how long is the Cascade Loop "
        + "and what should hikers bring?";
    private static final long POLL_TIMEOUT_NANOS = TimeUnit.MINUTES.toNanos(2);

    private AgentFileSearch() {
    }

    public static void main(String[] args) throws InterruptedException {
        String endpoint = requireEnvironmentVariable("PROJECT_ENDPOINT");
        String model = requireEnvironmentVariable("MODEL_DEPLOYMENT_NAME");
        PersistentAgentsClient client = new PersistentAgentsClientBuilder()
            .endpoint(endpoint)
            .credential(new DefaultAzureCredentialBuilder().build())
            .buildClient();
        PersistentAgentsAdministrationClient administration
            = client.getPersistentAgentsAdministrationClient();
        ThreadsClient threads = client.getThreadsClient();
        MessagesClient messages = client.getMessagesClient();
        RunsClient runs = client.getRunsClient();
        FilesClient files = client.getFilesClient();
        VectorStoresClient vectorStores = client.getVectorStoresClient();

        FileInfo uploadedFile = null;
        VectorStore vectorStore = null;
        PersistentAgent agent = null;
        PersistentAgentThread thread = null;
        Throwable primaryFailure = null;
        try {
            uploadedFile = files.uploadFile(new UploadFileRequest(
                new FileDetails(BinaryData.fromString(GUIDE)).setFilename("trail-guide.txt"),
                FilePurpose.AGENTS));
            vectorStore = vectorStores.createVectorStore(
                List.of(uploadedFile.getId()),
                "hyoka-trail-guide",
                null,
                null,
                null,
                null);

            vectorStore = waitForVectorStore(vectorStores, vectorStore);

            FileSearchToolResource searchResource = new FileSearchToolResource()
                .setVectorStoreIds(List.of(vectorStore.getId()));
            agent = administration.createAgent(new CreateAgentOptions(model)
                .setName("hyoka-trail-guide-agent")
                .setInstructions("Use file search to answer questions about the uploaded guide.")
                .setTools(List.of(new FileSearchToolDefinition()))
                .setToolResources(new ToolResources().setFileSearch(searchResource)));

            thread = threads.createThread();
            messages.createMessage(thread.getId(), MessageRole.USER, QUESTION);
            ThreadRun completedRun = waitForSuccessfulRun(
                runs,
                thread.getId(),
                runs.createRun(new CreateRunOptions(thread.getId(), agent.getId())));
            printReturnedAgentText(messages, thread.getId(), completedRun);
        } catch (InterruptedException | RuntimeException | Error failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            RuntimeException cleanupFailure = null;
            if (thread != null) {
                String threadId = thread.getId();
                cleanupFailure = cleanup(
                    cleanupFailure,
                    () -> threads.deleteThread(threadId));
            }
            if (agent != null) {
                String agentId = agent.getId();
                cleanupFailure = cleanup(
                    cleanupFailure,
                    () -> administration.deleteAgent(agentId));
            }
            if (vectorStore != null) {
                String vectorStoreId = vectorStore.getId();
                cleanupFailure = cleanup(
                    cleanupFailure,
                    () -> vectorStores.deleteVectorStore(vectorStoreId));
            }
            if (uploadedFile != null) {
                String fileId = uploadedFile.getId();
                cleanupFailure = cleanup(
                    cleanupFailure,
                    () -> files.deleteFile(fileId));
            }
            if (cleanupFailure != null) {
                if (primaryFailure != null) {
                    primaryFailure.addSuppressed(cleanupFailure);
                } else {
                    throw cleanupFailure;
                }
            }
        }
    }

    private static RuntimeException cleanup(
        RuntimeException previousFailure,
        Runnable operation) {
        try {
            operation.run();
        } catch (RuntimeException failure) {
            if (previousFailure == null) {
                return failure;
            }
            previousFailure.addSuppressed(failure);
        }
        return previousFailure;
    }

    private static VectorStore waitForVectorStore(
        VectorStoresClient vectorStores,
        VectorStore vectorStore) throws InterruptedException {
        long deadline = System.nanoTime() + POLL_TIMEOUT_NANOS;
        while (!VectorStoreStatus.COMPLETED.equals(vectorStore.getStatus())) {
            String status = String.valueOf(vectorStore.getStatus()).toLowerCase();
            if (status.contains("failed")
                || status.contains("expired")
                || status.contains("cancel")) {
                throw new IllegalStateException(
                    "Vector store indexing failed with status " + vectorStore.getStatus());
            }
            requireBeforeDeadline(deadline, "Vector store indexing");
            Thread.sleep(500);
            vectorStore = vectorStores.getVectorStore(vectorStore.getId());
        }
        return vectorStore;
    }

    private static ThreadRun waitForSuccessfulRun(
        RunsClient runs,
        String threadId,
        ThreadRun run) throws InterruptedException {
        long deadline = System.nanoTime() + POLL_TIMEOUT_NANOS;
        while (!isTerminal(run.getStatus())) {
            requireBeforeDeadline(deadline, "Agent run");
            Thread.sleep(500);
            run = runs.getRun(threadId, run.getId());
        }
        if (!RunStatus.COMPLETED.equals(run.getStatus())) {
            throw new IllegalStateException(
                "Agent run did not complete successfully; terminal status was "
                    + run.getStatus());
        }
        return run;
    }

    private static boolean isTerminal(RunStatus status) {
        return RunStatus.COMPLETED.equals(status)
            || RunStatus.FAILED.equals(status)
            || RunStatus.CANCELLED.equals(status)
            || RunStatus.EXPIRED.equals(status);
    }

    private static void printReturnedAgentText(
        MessagesClient messages,
        String threadId,
        ThreadRun completedRun) {
        if (!RunStatus.COMPLETED.equals(completedRun.getStatus())) {
            throw new IllegalArgumentException("Messages require a completed run.");
        }
        for (ThreadMessage returnedMessage : messages.listMessages(
            threadId, null, null, ListSortOrder.ASCENDING, null, null)) {
            if (!MessageRole.AGENT.equals(returnedMessage.getRole())) {
                continue;
            }
            for (MessageContent returnedContent : returnedMessage.getContent()) {
                if (returnedContent instanceof MessageTextContent returnedText) {
                    String serviceReturnedAgentText =
                        returnedText.getText().getValue();
                    System.out.println(serviceReturnedAgentText);
                }
            }
        }
    }

    private static void requireBeforeDeadline(long deadline, String operation) {
        if (System.nanoTime() >= deadline) {
            throw new IllegalStateException(operation + " timed out after two minutes.");
        }
    }

    private static String requireEnvironmentVariable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required.");
        }
        return value;
    }
}
