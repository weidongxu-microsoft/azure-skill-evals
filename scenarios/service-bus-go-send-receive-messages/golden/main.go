package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

type messageHandler func(context.Context, *azservicebus.ReceivedMessage) error
type errorHandler func(error)

func sendQueueMessages(ctx context.Context, sender *azservicebus.Sender) error {
	if err := sender.SendMessage(ctx, &azservicebus.Message{Body: []byte("single message")}, nil); err != nil {
		return fmt.Errorf("send single message: %w", err)
	}
	batch, err := sender.NewMessageBatch(ctx, nil)
	if err != nil {
		return fmt.Errorf("create message batch: %w", err)
	}
	for index := 1; index <= 5; index++ {
		message := &azservicebus.Message{Body: []byte(fmt.Sprintf("batch message %d", index))}
		if err := batch.AddMessage(message, nil); err != nil {
			return fmt.Errorf("add message %d to batch: %w", index, err)
		}
	}
	if err := sender.SendMessageBatch(ctx, batch, nil); err != nil {
		return fmt.Errorf("send message batch: %w", err)
	}
	return nil
}

func demonstrateSettlement(ctx context.Context, receiver *azservicebus.Receiver) error {
	messages, err := receiver.ReceiveMessages(ctx, 3, nil)
	if err != nil {
		return fmt.Errorf("receive settlement examples: %w", err)
	}
	for index, message := range messages {
		switch index {
		case 0:
			err = receiver.CompleteMessage(ctx, message, nil)
		case 1:
			err = receiver.AbandonMessage(ctx, message, nil)
		case 2:
			reason, description := "DemoDeadLetter", "dead-letter settlement example"
			err = receiver.DeadLetterMessage(ctx, message, &azservicebus.DeadLetterOptions{Reason: &reason, ErrorDescription: &description})
		}
		if err != nil {
			return fmt.Errorf("settle message %d: %w", index, err)
		}
	}
	return nil
}

func processMessages(ctx context.Context, receiver *azservicebus.Receiver, onMessage messageHandler, onError errorHandler) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		messages, err := receiver.ReceiveMessages(ctx, 10, nil)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			onError(err)
			continue
		}
		for _, message := range messages {
			if err := onMessage(ctx, message); err != nil {
				onError(err)
				if abandonErr := receiver.AbandonMessage(ctx, message, nil); abandonErr != nil {
					onError(abandonErr)
				}
				continue
			}
			if err := receiver.CompleteMessage(ctx, message, nil); err != nil {
				onError(err)
			}
		}
	}
}

func run(ctx context.Context) error {
	connectionString := os.Getenv("AZURE_SERVICEBUS_CONNECTION_STRING")
	queueName, topicName := os.Getenv("AZURE_SERVICEBUS_QUEUE_NAME"), os.Getenv("AZURE_SERVICEBUS_TOPIC_NAME")
	subscriptionName := os.Getenv("AZURE_SERVICEBUS_SUBSCRIPTION_NAME")
	if connectionString == "" || queueName == "" || topicName == "" || subscriptionName == "" {
		return errors.New("AZURE_SERVICEBUS_CONNECTION_STRING, AZURE_SERVICEBUS_QUEUE_NAME, AZURE_SERVICEBUS_TOPIC_NAME, and AZURE_SERVICEBUS_SUBSCRIPTION_NAME are required")
	}
	client, err := azservicebus.NewClientFromConnectionString(connectionString, nil)
	if err != nil {
		return fmt.Errorf("create Service Bus client: %w", err)
	}
	defer client.Close(ctx)

	queueSender, err := client.NewSender(queueName, nil)
	if err != nil {
		return fmt.Errorf("create queue sender: %w", err)
	}
	defer queueSender.Close(ctx)
	if err := sendQueueMessages(ctx, queueSender); err != nil {
		return err
	}

	queueReceiver, err := client.NewReceiverForQueue(queueName, &azservicebus.ReceiverOptions{ReceiveMode: azservicebus.ReceiveModePeekLock})
	if err != nil {
		return fmt.Errorf("create queue receiver: %w", err)
	}
	defer queueReceiver.Close(ctx)
	if err := demonstrateSettlement(ctx, queueReceiver); err != nil {
		return err
	}

	processingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	err = processMessages(processingCtx, queueReceiver, func(_ context.Context, message *azservicebus.ReceivedMessage) error {
		fmt.Printf("processed: %s\n", message.Body)
		return nil
	}, func(err error) {
		fmt.Fprintf(os.Stderr, "processor error: %v\n", err)
	})
	cancel()
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("continuous processing: %w", err)
	}

	topicSender, err := client.NewSender(topicName, nil)
	if err != nil {
		return fmt.Errorf("create topic sender: %w", err)
	}
	defer topicSender.Close(ctx)
	if err := topicSender.SendMessage(ctx, &azservicebus.Message{Body: []byte("topic message")}, nil); err != nil {
		return fmt.Errorf("send topic message: %w", err)
	}
	subscriptionReceiver, err := client.NewReceiverForSubscription(topicName, subscriptionName, nil)
	if err != nil {
		return fmt.Errorf("create subscription receiver: %w", err)
	}
	defer subscriptionReceiver.Close(ctx)
	messages, err := subscriptionReceiver.ReceiveMessages(ctx, 1, nil)
	if err != nil {
		return fmt.Errorf("receive subscription message: %w", err)
	}
	for _, message := range messages {
		fmt.Printf("subscription received: %s\n", message.Body)
		if err := subscriptionReceiver.CompleteMessage(ctx, message, nil); err != nil {
			return fmt.Errorf("complete subscription message: %w", err)
		}
	}
	return nil
}

func main() {
	if err := run(context.Background()); err != nil {
		var serviceBusError *azservicebus.Error
		var responseError *azcore.ResponseError
		switch {
		case errors.As(err, &serviceBusError):
			fmt.Fprintf(os.Stderr, "Service Bus error code=%s: %v\n", serviceBusError.Code, serviceBusError)
		case errors.As(err, &responseError):
			fmt.Fprintf(os.Stderr, "Azure error status=%d code=%s: %v\n", responseError.StatusCode, responseError.ErrorCode, responseError)
		default:
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
