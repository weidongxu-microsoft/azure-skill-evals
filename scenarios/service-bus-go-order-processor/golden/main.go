package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

const highValueThreshold = 1000.0

type order struct {
	OrderID    string  `json:"orderId"`
	Customer   string  `json:"customer"`
	Product    string  `json:"product"`
	Quantity   int     `json:"quantity"`
	TotalPrice float64 `json:"totalPrice"`
	Status     string  `json:"status"`
}

func orderMessage(value order) (*azservicebus.Message, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	contentType := "application/json"
	return &azservicebus.Message{Body: body, ContentType: &contentType, CorrelationID: &value.OrderID, MessageID: &value.OrderID, SessionID: &value.Customer}, nil
}

func sendBatch(ctx context.Context, sender *azservicebus.Sender, orders []order) error {
	batch, err := sender.NewMessageBatch(ctx, nil)
	if err != nil {
		return fmt.Errorf("create batch: %w", err)
	}
	for _, value := range orders {
		message, err := orderMessage(value)
		if err != nil {
			return err
		}
		if err := batch.AddMessage(message, nil); err != nil {
			if batch.NumMessages() == 0 {
				return fmt.Errorf("order exceeds batch capacity: %w", err)
			}
			if err := sender.SendMessageBatch(ctx, batch, nil); err != nil {
				return fmt.Errorf("send full batch: %w", err)
			}
			batch, err = sender.NewMessageBatch(ctx, nil)
			if err != nil {
				return err
			}
			if err := batch.AddMessage(message, nil); err != nil {
				return fmt.Errorf("order exceeds empty batch: %w", err)
			}
		}
	}
	if batch.NumMessages() > 0 {
		if err := sender.SendMessageBatch(ctx, batch, nil); err != nil {
			return fmt.Errorf("send batch: %w", err)
		}
	}
	return nil
}

func sendOrder(ctx context.Context, sender *azservicebus.Sender, value order) error {
	message, err := orderMessage(value)
	if err != nil {
		return err
	}
	if value.TotalPrice > highValueThreshold {
		sequenceNumbers, err := sender.ScheduleMessages(ctx, []*azservicebus.Message{message}, time.Now().UTC().Add(30*time.Second), nil)
		if err != nil {
			return fmt.Errorf("schedule high-value order: %w", err)
		}
		fmt.Printf("scheduled order=%s sequence=%d\n", value.OrderID, sequenceNumbers[0])
		return nil
	}
	return sender.SendMessage(ctx, message, nil)
}

func demonstrateCancellation(ctx context.Context, sender *azservicebus.Sender) error {
	value := order{OrderID: "cancel-me", Customer: "demo", Product: "review", Quantity: 1, TotalPrice: 2000, Status: "pending"}
	message, err := orderMessage(value)
	if err != nil {
		return err
	}
	sequenceNumbers, err := sender.ScheduleMessages(ctx, []*azservicebus.Message{message}, time.Now().UTC().Add(30*time.Second), nil)
	if err != nil {
		return fmt.Errorf("schedule cancellation demo: %w", err)
	}
	if err := sender.CancelScheduledMessages(ctx, sequenceNumbers, nil); err != nil {
		return fmt.Errorf("cancel scheduled order: %w", err)
	}
	return nil
}

func processSession(ctx context.Context, receiver *azservicebus.SessionReceiver) error {
	defer receiver.Close(ctx)
	messages, err := receiver.ReceiveMessages(ctx, 20, nil)
	if err != nil {
		return fmt.Errorf("receive session %s: %w", receiver.SessionID(), err)
	}
	for _, message := range messages {
		var value order
		if err := json.Unmarshal(message.Body, &value); err != nil {
			reason, description := "InvalidOrder", err.Error()
			if settleErr := receiver.DeadLetterMessage(ctx, message, &azservicebus.DeadLetterOptions{Reason: &reason, ErrorDescription: &description}); settleErr != nil {
				return fmt.Errorf("dead-letter invalid order: %w", settleErr)
			}
			continue
		}
		value.Status = "completed"
		fmt.Printf("processed session=%s order=%s status=%s\n", receiver.SessionID(), value.OrderID, value.Status)
		if err := receiver.CompleteMessage(ctx, message, nil); err != nil {
			return fmt.Errorf("complete order %s: %w", value.OrderID, err)
		}
	}
	return nil
}

func processNextSession(ctx context.Context, client *azservicebus.Client, queue string) error {
	receiver, err := client.AcceptNextSessionForQueue(ctx, queue, &azservicebus.SessionReceiverOptions{ReceiveMode: azservicebus.ReceiveModePeekLock})
	if err != nil {
		return fmt.Errorf("accept next session: %w", err)
	}
	return processSession(ctx, receiver)
}

func inspectDeadLetters(ctx context.Context, client *azservicebus.Client, queue string) error {
	receiver, err := client.NewReceiverForQueue(queue, &azservicebus.ReceiverOptions{ReceiveMode: azservicebus.ReceiveModePeekLock, SubQueue: azservicebus.SubQueueDeadLetter})
	if err != nil {
		return fmt.Errorf("create dead-letter receiver: %w", err)
	}
	defer receiver.Close(ctx)
	messages, err := receiver.ReceiveMessages(ctx, 10, nil)
	if err != nil {
		return fmt.Errorf("receive dead letters: %w", err)
	}
	for _, message := range messages {
		fmt.Printf("dead-letter id=%s reason=%s description=%s\n", message.MessageID, stringValue(message.DeadLetterReason), stringValue(message.DeadLetterErrorDescription))
		if err := receiver.CompleteMessage(ctx, message, nil); err != nil {
			return fmt.Errorf("settle dead letter: %w", err)
		}
	}
	return nil
}

func run(ctx context.Context) error {
	namespace, queue := os.Getenv("SERVICEBUS_FULLY_QUALIFIED_NAMESPACE"), os.Getenv("SERVICEBUS_QUEUE_NAME")
	if namespace == "" || queue == "" {
		return errors.New("SERVICEBUS_FULLY_QUALIFIED_NAMESPACE and SERVICEBUS_QUEUE_NAME are required")
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	client, err := azservicebus.NewClient(namespace, credential, nil)
	if err != nil {
		return fmt.Errorf("create Service Bus client: %w", err)
	}
	defer client.Close(ctx)
	sender, err := client.NewSender(queue, nil)
	if err != nil {
		return fmt.Errorf("create sender: %w", err)
	}
	defer sender.Close(ctx)
	orders := []order{{"order-1", "Ada", "keyboard", 1, 99, "pending"}, {"order-2", "Ada", "monitor", 2, 700, "pending"}}
	if err := sendBatch(ctx, sender, orders); err != nil {
		return err
	}
	if err := sendOrder(ctx, sender, order{"order-3", "Grace", "server", 1, 5000, "pending"}); err != nil {
		return err
	}
	if err := demonstrateCancellation(ctx, sender); err != nil {
		return err
	}
	if err := processNextSession(ctx, client, queue); err != nil {
		return err
	}
	return inspectDeadLetters(ctx, client, queue)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func main() {
	if err := run(context.Background()); err != nil {
		var serviceBusError *azservicebus.Error
		var responseError *azcore.ResponseError
		switch {
		case errors.As(err, &serviceBusError):
			fmt.Fprintf(os.Stderr, "Service Bus error code=%s: %v\n", serviceBusError.Code, serviceBusError)
		case errors.As(err, &responseError):
			fmt.Fprintf(os.Stderr, "Azure response error status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
		default:
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
