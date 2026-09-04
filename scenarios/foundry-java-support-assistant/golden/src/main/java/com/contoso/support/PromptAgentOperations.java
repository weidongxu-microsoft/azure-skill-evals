package com.contoso.support;

import com.azure.ai.agents.AgentsClient;
import com.azure.ai.agents.AgentsClientBuilder;
import com.azure.ai.agents.models.AgentVersionDetails;
import com.azure.ai.agents.models.FileSearchTool;
import com.azure.ai.agents.models.PromptAgentDefinition;
import com.azure.core.credential.TokenCredential;
import java.net.URI;
import java.util.List;

interface PromptAgentOperations {
    AgentIdentity create(
        String agentName,
        String modelDeployment,
        String instructions,
        String vectorStoreId);

    void deleteAgent(String agentName);

    record AgentIdentity(String name, String version) {
    }
}

final class AzurePromptAgentOperations implements PromptAgentOperations {
    private final AgentsClient client;

    AzurePromptAgentOperations(
        URI projectEndpoint,
        TokenCredential credential) {
        client = new AgentsClientBuilder()
            .endpoint(projectEndpoint.toString())
            .credential(credential)
            .buildAgentsClient();
    }

    @Override
    public AgentIdentity create(
        String agentName,
        String modelDeployment,
        String instructions,
        String vectorStoreId) {
        try {
            PromptAgentDefinition definition =
                new PromptAgentDefinition(modelDeployment)
                    .setInstructions(instructions)
                    .setTools(List.of(
                        new FileSearchTool(List.of(vectorStoreId))))
                    .setToolChoice("required");
            AgentVersionDetails created =
                client.createAgentVersion(agentName, definition);
            return new AgentIdentity(
                created.getName(), created.getVersion());
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException(
                "The managed prompt-agent definition was rejected.",
                error);
        }
    }

    @Override
    public void deleteAgent(String agentName) {
        client.deleteAgent(agentName);
    }
}
