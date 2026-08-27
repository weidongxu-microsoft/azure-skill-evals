package com.example;

import com.azure.core.util.IterableStream;
import com.azure.messaging.servicebus.ServiceBusClientBuilder;
import com.azure.messaging.servicebus.ServiceBusErrorContext;
import com.azure.messaging.servicebus.ServiceBusMessage;
import com.azure.messaging.servicebus.ServiceBusMessageBatch;
import com.azure.messaging.servicebus.ServiceBusProcessorClient;
import com.azure.messaging.servicebus.ServiceBusReceivedMessage;
import com.azure.messaging.servicebus.ServiceBusReceiverClient;
import com.azure.messaging.servicebus.ServiceBusSenderClient;
import com.azure.messaging.servicebus.models.ServiceBusReceiveMode;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class ServiceBusMessages {
    private ServiceBusMessages() {
    }

    public static void main(String[] args) throws InterruptedException {
        String connectionString =
                requireEnvironment("SERVICE_BUS_CONNECTION_STRING");
        String queueName = requireEnvironment("SERVICE_BUS_QUEUE_NAME");
        String topicName = requireEnvironment("SERVICE_BUS_TOPIC_NAME");
        String subscriptionName =
                requireEnvironment("SERVICE_BUS_SUBSCRIPTION_NAME");

        ServiceBusClientBuilder clientBuilder = new ServiceBusClientBuilder()
                .connectionString(connectionString);

        try (ServiceBusSenderClient queueSender = clientBuilder.sender()
                .queueName(queueName)
                .buildClient();
             ServiceBusReceiverClient queueReceiver = clientBuilder.receiver()
                     .queueName(queueName)
                     .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                     .buildClient();) {
            ServiceBusMessage singleMessage =
                    new ServiceBusMessage("Single queue message");
            queueSender.sendMessage(singleMessage);

            ServiceBusMessageBatch batch = queueSender.createMessageBatch();
            for (int index = 0; index < 5; index++) {
                ServiceBusMessage batchMessage =
                        new ServiceBusMessage("Batch message " + index);
                if (!batch.tryAddMessage(batchMessage)) {
                    throw new IllegalStateException(
                            "The five messages exceeded the batch size.");
                }
            }
            queueSender.sendMessages(batch);

            IterableStream<ServiceBusReceivedMessage> receivedMessages =
                    queueReceiver.receiveMessages(1, Duration.ofSeconds(10));
            for (ServiceBusReceivedMessage receivedMessage : receivedMessages) {
                System.out.println(receivedMessage.getBody().toString());
                queueReceiver.complete(receivedMessage);
            }

            CountDownLatch processorSignal = new CountDownLatch(1);
            ServiceBusProcessorClient processor = clientBuilder.processor()
                    .queueName(queueName)
                    .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                    .disableAutoComplete()
                    .processMessage(context -> {
                        System.out.println(
                                context.getMessage().getBody().toString());
                        context.complete();
                        processorSignal.countDown();
                    })
                    .processError(ServiceBusMessages::processError)
                    .buildProcessorClient();

            try {
                processor.start();
                if (!processorSignal.await(30, TimeUnit.SECONDS)) {
                    System.err.println("No processor message arrived in time.");
                }
            } finally {
                try {
                    processor.stop();
                } finally {
                    processor.close();
                }
            }
        }

        try (ServiceBusSenderClient topicSender = clientBuilder.sender()
                .topicName(topicName)
                .buildClient();
             ServiceBusReceiverClient subscriptionReceiver =
                     clientBuilder.receiver()
                             .topicName(topicName)
                             .subscriptionName(subscriptionName)
                             .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                             .buildClient();) {
            ServiceBusMessage topicMessage =
                    new ServiceBusMessage("Topic subscription message");
            topicSender.sendMessage(topicMessage);

            IterableStream<ServiceBusReceivedMessage> subscriptionMessages =
                    subscriptionReceiver.receiveMessages(
                            1, Duration.ofSeconds(10));
            for (ServiceBusReceivedMessage subscriptionMessage
                    : subscriptionMessages) {
                System.out.println(subscriptionMessage.getBody().toString());
                subscriptionReceiver.complete(subscriptionMessage);
            }
        }
    }

    private static void processError(ServiceBusErrorContext context) {
        System.err.println(context.getException());
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
