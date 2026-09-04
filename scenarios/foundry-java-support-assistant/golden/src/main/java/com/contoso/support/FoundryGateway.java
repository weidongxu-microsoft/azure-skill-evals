package com.contoso.support;

import static com.contoso.support.Models.EvaluationMetric;
import static com.contoso.support.Models.FoundryResources;
import static com.contoso.support.Models.GatewayAnswer;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

public interface FoundryGateway {
    FoundryResources ingest(List<Path> documentPaths) throws IOException;

    GatewayAnswer ask(
        FoundryResources resources,
        String conversationId,
        String question) throws IOException;

    void deleteConversation(String conversationId) throws IOException;

    void rollbackTurn(
        String conversationId,
        List<String> itemIds) throws IOException;

    List<EvaluationMetric> runEvaluation(List<ObjectNode> rows)
        throws IOException;

    void cleanup(
        FoundryResources resources,
        List<String> conversationIds) throws IOException;
}
