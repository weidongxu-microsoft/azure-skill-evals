package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.messaging.servicebus.ServiceBusClientBuilder;
import com.azure.messaging.servicebus.ServiceBusErrorContext;
import com.azure.messaging.servicebus.ServiceBusException;
import com.azure.messaging.servicebus.ServiceBusMessage;
import com.azure.messaging.servicebus.ServiceBusMessageBatch;
import com.azure.messaging.servicebus.ServiceBusProcessorClient;
import com.azure.messaging.servicebus.ServiceBusReceivedMessage;
import com.azure.messaging.servicebus.ServiceBusReceiverAsyncClient;
import com.azure.messaging.servicebus.ServiceBusReceiverClient;
import com.azure.messaging.servicebus.ServiceBusSenderAsyncClient;
import com.azure.messaging.servicebus.ServiceBusSenderClient;
import com.azure.messaging.servicebus.ServiceBusSessionReceiverAsyncClient;
import com.azure.messaging.servicebus.ServiceBusSessionReceiverClient;
import com.azure.messaging.servicebus.models.DeadLetterOptions;
import com.azure.messaging.servicebus.models.ServiceBusReceiveMode;
import com.azure.messaging.servicebus.models.SubQueue;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import reactor.core.publisher.Mono;

public final class OrderProcessorApplication {
    private static final double HIGH_VALUE_THRESHOLD = 1_000.0;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private OrderProcessorApplication() {
    }

    public static final class Order {
        public String orderId;
        public String customerName;
        public String product;
        public int quantity;
        public double totalPrice;
        public String status;

        public Order() {
        }

        public Order(
                String orderId,
                String customerName,
                String product,
                int quantity,
                double totalPrice,
                String status) {
            this.orderId = orderId;
            this.customerName = customerName;
            this.product = product;
            this.quantity = quantity;
            this.totalPrice = totalPrice;
            this.status = status;
        }

        public String getOrderId() {
            return orderId;
        }

        public String getCustomerName() {
            return customerName;
        }

        public double getTotalPrice() {
            return totalPrice;
        }

        public String toJson() {
            try {
                return MAPPER.writeValueAsString(this);
            } catch (JsonProcessingException exception) {
                throw new IllegalArgumentException("Cannot serialize order", exception);
            }
        }

        public static Order fromJson(String value) {
            try {
                Order order = MAPPER.readValue(value, Order.class);
                if (!List.of("pending", "processing", "completed", "failed")
                        .contains(order.status)) {
                    throw new IllegalArgumentException("Invalid order status");
                }
                return order;
            } catch (JsonProcessingException exception) {
                throw new IllegalArgumentException("Cannot deserialize order", exception);
            }
        }
    }

    private static ServiceBusMessage messageFor(Order order) {
        ServiceBusMessage message = new ServiceBusMessage(order.toJson())
                .setCorrelationId(order.getOrderId())
                .setSessionId(order.getCustomerName());
        message.getApplicationProperties().put("priority", "normal");
        if (order.getTotalPrice() > HIGH_VALUE_THRESHOLD) {
            message.getApplicationProperties().put("priority", "high");
            message.setScheduledEnqueueTime(OffsetDateTime.now().plusSeconds(30));
        }
        return message;
    }

    private static void processOrder(Order order) {
        order.status = "processing";
        System.out.printf(
                "Processing order %s for %s: %s x%d%n",
                order.orderId,
                order.customerName,
                order.product,
                order.quantity);
        order.status = "completed";
    }

    private static void logServiceBusError(
            String entityPath,
            String errorSource,
            Throwable error) {
        String category = error instanceof ServiceBusException serviceBusException
                && serviceBusException.isTransient()
                ? "transient"
                : "non-transient";
        System.err.printf(
                "Service Bus %s error on entity %s from %s: %s%n",
                category,
                entityPath,
                errorSource,
                error.getMessage());
    }

    private static ServiceBusClientBuilder builder(
            String namespace,
            TokenCredential credential) {
        return new ServiceBusClientBuilder().credential(namespace, credential);
    }

    private static final class SyncOrderSender implements AutoCloseable {
        private final ServiceBusSenderClient sender;

        SyncOrderSender(String namespace, String queueName, TokenCredential credential) {
            sender = builder(namespace, credential)
                    .sender()
                    .queueName(queueName)
                    .buildClient();
        }

        void sendOrder(Order order) {
            sender.sendMessage(messageFor(order));
        }

        void sendOrders(List<Order> orders) {
            ServiceBusMessageBatch batch = sender.createMessageBatch();
            for (Order order : orders) {
                ServiceBusMessage message = messageFor(order);
                if (!batch.tryAddMessage(message)) {
                    if (batch.getCount() == 0) {
                        throw new IllegalArgumentException("Order is too large for an empty batch");
                    }
                    sender.sendMessages(batch);
                    batch = sender.createMessageBatch();
                    if (!batch.tryAddMessage(message)) {
                        throw new IllegalArgumentException("Order is too large for an empty batch");
                    }
                }
            }
            if (batch.getCount() > 0) {
                sender.sendMessages(batch);
            }
        }

        @Override
        public void close() {
            sender.close();
        }
    }

    private static final class AsyncOrderSender implements AutoCloseable {
        private final ServiceBusSenderAsyncClient sender;

        AsyncOrderSender(String namespace, String queueName, TokenCredential credential) {
            sender = builder(namespace, credential)
                    .sender()
                    .queueName(queueName)
                    .buildAsyncClient();
        }

        Mono<Void> sendOrder(Order order) {
            return sender.sendMessage(messageFor(order));
        }

        Mono<Void> sendOrders(List<Order> orders) {
            return sender.createMessageBatch()
                    .flatMap(batch -> fillBatch(batch, orders, 0));
        }

        private Mono<Void> fillBatch(
                ServiceBusMessageBatch batch,
                List<Order> orders,
                int index) {
            if (index == orders.size()) {
                return batch.getCount() == 0 ? Mono.empty() : sender.sendMessages(batch);
            }
            ServiceBusMessage message = messageFor(orders.get(index));
            if (batch.tryAddMessage(message)) {
                return fillBatch(batch, orders, index + 1);
            }
            if (batch.getCount() == 0) {
                return Mono.error(
                        new IllegalArgumentException("Order is too large for an empty batch"));
            }
            return sender.sendMessages(batch)
                    .then(sender.createMessageBatch())
                    .flatMap(nextBatch -> {
                        if (!nextBatch.tryAddMessage(message)) {
                            return Mono.error(
                                    new IllegalArgumentException(
                                            "Order is too large for an empty batch"));
                        }
                        return fillBatch(nextBatch, orders, index + 1);
                    });
        }

        @Override
        public void close() {
            sender.close();
        }
    }

    private static final class SyncOrderProcessor implements AutoCloseable {
        private final String queueName;
        private final ServiceBusProcessorClient processor;
        private final ServiceBusSessionReceiverClient deadLetterSessions;

        SyncOrderProcessor(String namespace, String queueName, TokenCredential credential) {
            this.queueName = queueName;
            processor = builder(namespace, credential)
                    .sessionProcessor()
                    .queueName(queueName)
                    .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                    .disableAutoComplete()
                    .processMessage(this::processMessage)
                    .processError(this::processError)
                    .buildProcessorClient();
            deadLetterSessions = builder(namespace, credential)
                    .sessionReceiver()
                    .queueName(queueName)
                    .subQueue(SubQueue.DEAD_LETTER_QUEUE)
                    .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                    .buildClient();
        }

        private void processMessage(
                com.azure.messaging.servicebus.ServiceBusReceivedMessageContext context) {
            ServiceBusReceivedMessage message = context.getMessage();
            try {
                Order order = Order.fromJson(message.getBody().toString());
                processOrder(order);
                context.complete();
            } catch (ServiceBusException exception) {
                logServiceBusError(queueName, "PROCESS_MESSAGE", exception);
                if (exception.isTransient()) {
                    context.abandon();
                } else {
                    context.deadLetter(
                            new DeadLetterOptions()
                                    .setDeadLetterReason(
                                            "Non-transient order processing failure")
                                    .setDeadLetterErrorDescription(exception.getMessage()));
                }
            } catch (RuntimeException exception) {
                context.deadLetter(
                        new DeadLetterOptions()
                                .setDeadLetterReason("Order deserialization failed")
                                .setDeadLetterErrorDescription(exception.getMessage()));
            }
        }

        private void processError(ServiceBusErrorContext context) {
            logServiceBusError(
                    context.getEntityPath(),
                    context.getErrorSource().toString(),
                    context.getException());
        }

        void processOrders(Duration duration) {
            processor.start();
            try {
                Thread.sleep(duration.toMillis());
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            } finally {
                processor.stop();
            }
        }

        void reprocessDeadLetters(SyncOrderSender sender) {
            try (ServiceBusReceiverClient receiver = deadLetterSessions.acceptNextSession()) {
                for (ServiceBusReceivedMessage message
                        : receiver.receiveMessages(10, Duration.ofSeconds(5))) {
                    try {
                        Order order = Order.fromJson(message.getBody().toString());
                        System.out.println("Reprocessing dead-lettered order " + order.orderId);
                        sender.sendOrder(order);
                        receiver.complete(message);
                    } catch (ServiceBusException exception) {
                        logServiceBusError(queueName, "DEAD_LETTER_REPROCESS", exception);
                        receiver.abandon(message);
                    } catch (RuntimeException exception) {
                        System.err.println(
                                "Cannot reprocess dead-letter message: "
                                        + exception.getMessage());
                        receiver.abandon(message);
                    }
                }
            }
        }

        @Override
        public void close() {
            processor.close();
            deadLetterSessions.close();
        }
    }

    private static final class AsyncOrderProcessor implements AutoCloseable {
        private final String queueName;
        private final ServiceBusSessionReceiverAsyncClient sessions;
        private final ServiceBusSessionReceiverAsyncClient deadLetterSessions;

        AsyncOrderProcessor(String namespace, String queueName, TokenCredential credential) {
            this.queueName = queueName;
            sessions = builder(namespace, credential)
                    .sessionReceiver()
                    .queueName(queueName)
                    .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                    .buildAsyncClient();
            deadLetterSessions = builder(namespace, credential)
                    .sessionReceiver()
                    .queueName(queueName)
                    .subQueue(SubQueue.DEAD_LETTER_QUEUE)
                    .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                    .buildAsyncClient();
        }

        Mono<Void> processOrders() {
            return sessions.acceptNextSession()
                    .flatMapMany(receiver -> receiver.receiveMessages()
                            .take(10)
                            .concatMap(message -> settle(receiver, message))
                            .doFinally(signal -> receiver.close()))
                    .then();
        }

        private Mono<Void> settle(
                ServiceBusReceiverAsyncClient receiver,
                ServiceBusReceivedMessage message) {
            try {
                Order order = Order.fromJson(message.getBody().toString());
                processOrder(order);
                return receiver.complete(message);
            } catch (ServiceBusException exception) {
                logServiceBusError(queueName, "ASYNC_PROCESS_MESSAGE", exception);
                if (exception.isTransient()) {
                    return receiver.abandon(message);
                }
                return receiver.deadLetter(
                        message,
                        new DeadLetterOptions()
                                .setDeadLetterReason(
                                        "Non-transient order processing failure")
                                .setDeadLetterErrorDescription(exception.getMessage()));
            } catch (RuntimeException exception) {
                return receiver.deadLetter(
                        message,
                        new DeadLetterOptions()
                                .setDeadLetterReason("Order deserialization failed")
                                .setDeadLetterErrorDescription(exception.getMessage()));
            }
        }

        Mono<Void> reprocessDeadLetters(AsyncOrderSender sender) {
            return deadLetterSessions.acceptNextSession()
                    .flatMapMany(receiver -> receiver.receiveMessages()
                            .take(10)
                            .concatMap(message -> {
                                try {
                                    Order order = Order.fromJson(
                                            message.getBody().toString());
                                    System.out.println(
                                            "Reprocessing dead-lettered order "
                                                    + order.orderId);
                                    return sender.sendOrder(order)
                                            .then(receiver.complete(message));
                                } catch (ServiceBusException exception) {
                                    logServiceBusError(
                                            queueName,
                                            "ASYNC_DEAD_LETTER_REPROCESS",
                                            exception);
                                    return receiver.abandon(message);
                                } catch (RuntimeException exception) {
                                    System.err.println(
                                            "Cannot reprocess dead-letter message: "
                                                    + exception.getMessage());
                                    return receiver.abandon(message);
                                }
                            })
                            .doFinally(signal -> receiver.close()))
                    .then();
        }

        @Override
        public void close() {
            sessions.close();
            deadLetterSessions.close();
        }
    }

    private static List<Order> sampleOrders() {
        return List.of(
                new Order("order-100", "Contoso", "keyboard", 2, 180.0, "pending"),
                new Order("order-101", "Fabrikam", "server", 1, 4_500.0, "pending"));
    }

    public static void main(String[] args) {
        String namespace = System.getenv("SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE");
        String queueName = System.getenv("SERVICE_BUS_QUEUE_NAME");
        TokenCredential credential = new ManagedIdentityCredentialBuilder().build();
        List<Order> orders = sampleOrders();

        try (SyncOrderSender sender = new SyncOrderSender(namespace, queueName, credential);
                SyncOrderProcessor processor =
                        new SyncOrderProcessor(namespace, queueName, credential)) {
            sender.sendOrder(orders.get(0));
            sender.sendOrders(orders.subList(1, orders.size()));
            processor.processOrders(Duration.ofSeconds(5));
            processor.reprocessDeadLetters(sender);
        }

        try (AsyncOrderSender sender = new AsyncOrderSender(namespace, queueName, credential);
                AsyncOrderProcessor processor =
                        new AsyncOrderProcessor(namespace, queueName, credential)) {
            sender.sendOrder(orders.get(0)).block();
            sender.sendOrders(orders.subList(1, orders.size())).block();
            processor.processOrders().block();
            processor.reprocessDeadLetters(sender).block();
        }
    }
}
