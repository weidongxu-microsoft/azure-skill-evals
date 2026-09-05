package com.example;

import com.azure.ai.agents.persistent.MessagesClient;
import com.azure.ai.agents.persistent.PersistentAgentsAdministrationClient;
import com.azure.ai.agents.persistent.PersistentAgentsClient;
import com.azure.ai.agents.persistent.PersistentAgentsClientBuilder;
import com.azure.ai.agents.persistent.RunsClient;
import com.azure.ai.agents.persistent.ThreadsClient;
import com.azure.ai.agents.persistent.models.CreateAgentOptions;
import com.azure.ai.agents.persistent.models.CreateRunOptions;
import com.azure.ai.agents.persistent.models.ListSortOrder;
import com.azure.ai.agents.persistent.models.MessageContent;
import com.azure.ai.agents.persistent.models.MessageRole;
import com.azure.ai.agents.persistent.models.MessageTextContent;
import com.azure.ai.agents.persistent.models.PersistentAgent;
import com.azure.ai.agents.persistent.models.PersistentAgentThread;
import com.azure.ai.agents.persistent.models.RunStatus;
import com.azure.ai.agents.persistent.models.ThreadMessage;
import com.azure.ai.agents.persistent.models.ThreadRun;
import com.azure.identity.DefaultAzureCredentialBuilder;
import java.util.concurrent.TimeUnit;

public final class BasicAgentLifecycle {
    private static final String AGENT_NAME = "hyoka-basic-agent";
    private static final String AGENT_INSTRUCTIONS = "Answer the user's question clearly and concisely.";
    private static final String USER_MESSAGE = "What is the capital of France?";
    private static final long RUN_TIMEOUT_NANOS = TimeUnit.MINUTES.toNanos(2);

    private BasicAgentLifecycle() {
    }

    public static void main(String[] args) throws InterruptedException {
        String endpoint = requireEnvironmentVariable("PROJECT_ENDPOINT");
        String modelDeployment = requireEnvironmentVariable("MODEL_DEPLOYMENT_NAME");

        PersistentAgentsClient client = new PersistentAgentsClientBuilder()
            .endpoint(endpoint)
            .credential(new DefaultAzureCredentialBuilder().build())
            .buildClient();
        PersistentAgentsAdministrationClient administrationClient
            = client.getPersistentAgentsAdministrationClient();
        ThreadsClient threadsClient = client.getThreadsClient();
        MessagesClient messagesClient = client.getMessagesClient();
        RunsClient runsClient = client.getRunsClient();

        PersistentAgent agent = null;
        PersistentAgentThread thread = null;
        try {
            CreateAgentOptions agentOptions = new CreateAgentOptions(modelDeployment)
                .setName(AGENT_NAME)
                .setInstructions(AGENT_INSTRUCTIONS);
            agent = administrationClient.createAgent(agentOptions);

            thread = threadsClient.createThread();
            messagesClient.createMessage(thread.getId(), MessageRole.USER, USER_MESSAGE);

            ThreadRun run = waitForSuccessfulRun(
                runsClient,
                runsClient.createRun(new CreateRunOptions(thread.getId(), agent.getId())));

            if (!RunStatus.COMPLETED.equals(run.getStatus())) {
                throw new IllegalStateException("Agent run ended with status " + run.getStatus());
            }

            for (ThreadMessage message : messagesClient.listMessages(
                thread.getId(), null, null, ListSortOrder.ASCENDING, null, null)) {
                if (!MessageRole.AGENT.equals(message.getRole())) {
                    continue;
                }

                for (MessageContent content : message.getContent()) {
                    if (content instanceof MessageTextContent text) {
                        System.out.println(text.getText().getValue());
                    }
                }
            }
        } finally {
            if (thread != null) {
                threadsClient.deleteThread(thread.getId());
            }
            if (agent != null) {
                administrationClient.deleteAgent(agent.getId());
            }
        }
    }

    private static ThreadRun waitForSuccessfulRun(
        RunsClient runsClient,
        ThreadRun run) throws InterruptedException {
        long deadline = System.nanoTime() + RUN_TIMEOUT_NANOS;
        while (RunStatus.QUEUED.equals(run.getStatus())
            || RunStatus.IN_PROGRESS.equals(run.getStatus())) {
            if (System.nanoTime() >= deadline) {
                throw new IllegalStateException(
                    "Agent run timed out after two minutes: " + run.getId());
            }
            Thread.sleep(500);
            run = runsClient.getRun(run.getThreadId(), run.getId());
        }
        return run;
    }

    private static String requireEnvironmentVariable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required.");
        }
        return value;
    }
}
