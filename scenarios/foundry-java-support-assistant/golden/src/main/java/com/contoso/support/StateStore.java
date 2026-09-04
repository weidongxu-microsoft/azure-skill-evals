package com.contoso.support;

import static com.contoso.support.Models.AssistantState;

import com.azure.core.http.rest.Response;
import com.azure.core.util.BinaryData;
import com.azure.core.util.Context;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobContainerClient;
import com.azure.storage.blob.models.BlobProperties;
import com.azure.storage.blob.models.BlobRequestConditions;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.storage.blob.models.BlockBlobItem;
import com.azure.storage.blob.options.BlobParallelUploadOptions;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.time.Duration;

public interface StateStore {
    AssistantState load() throws IOException;

    void save(AssistantState state) throws IOException;

    final class BlobStateStore implements StateStore {
        private final BlobContainerClient container;
        private final BlobClient blob;
        private final ObjectMapper mapper;

        public BlobStateStore(
            BlobContainerClient container,
            String blobName,
            ObjectMapper mapper) {
            this.container = container;
            this.blob = container.getBlobClient(blobName);
            this.mapper = mapper;
        }

        public void initialize() {
            container.getProperties();
        }

        @Override
        public AssistantState load() throws IOException {
            try {
            BlobProperties properties = blob.getProperties();
            BinaryData content = blob.downloadContent();
                AssistantState state = mapper.readValue(
                    content.toBytes(), AssistantState.class);
                if (state.version != 1) {
                    throw new IOException(
                        "The durable state version is not supported.");
                }
                state.etag = properties.getETag();
                state.loaded = true;
                return state;
            } catch (BlobStorageException error) {
                if (error.getStatusCode() == 404) {
                    AssistantState state = new AssistantState();
                    state.loaded = true;
                    return state;
                }
                throw error;
            }
        }

        @Override
        public void save(AssistantState state) throws IOException {
            if (!state.loaded) {
                throw new IllegalStateException(
                    "State must be loaded before it can be saved.");
            }
            BlobRequestConditions conditions = new BlobRequestConditions();
            if (state.etag == null) {
                conditions.setIfNoneMatch("*");
            } else {
                conditions.setIfMatch(state.etag);
            }
            BinaryData content = BinaryData.fromBytes(
                mapper.writeValueAsBytes(state));
            BlobParallelUploadOptions options =
                new BlobParallelUploadOptions(content)
                    .setRequestConditions(conditions);
            Response<BlockBlobItem> response = blob.uploadWithResponse(
                options, Duration.ofMinutes(1), Context.NONE);
            state.etag = response.getValue().getETag();
        }
    }

    final class MemoryStateStore implements StateStore {
        private final ObjectMapper mapper;
        private AssistantState state;
        private int saveCount;
        private int failOnSave;

        public MemoryStateStore(ObjectMapper mapper) {
            this.mapper = mapper;
            state = new AssistantState();
            state.loaded = true;
        }

        public void failOnSave(int number) {
            failOnSave = number;
        }

        @Override
        public synchronized AssistantState load() throws IOException {
            return cloneState(state);
        }

        @Override
        public synchronized void save(AssistantState value) throws IOException {
            saveCount++;
            if (saveCount == failOnSave) {
                throw new IOException("simulated durable save failure");
            }
            state = cloneState(value);
        }

        private AssistantState cloneState(AssistantState source)
            throws IOException {
            AssistantState clone = mapper.readValue(
                mapper.writeValueAsBytes(source), AssistantState.class);
            clone.loaded = true;
            return clone;
        }
    }
}
