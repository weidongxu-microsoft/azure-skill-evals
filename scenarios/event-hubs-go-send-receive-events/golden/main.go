package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/checkpoints"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
)

type config struct {
	namespace     string
	eventHub      string
	consumerGroup string
	checkpointURL string
}

func loadConfig() (config, error) {
	configuration := config{
		namespace:     os.Getenv("EVENTHUB_FULLY_QUALIFIED_NAMESPACE"),
		eventHub:      os.Getenv("EVENTHUB_NAME"),
		consumerGroup: os.Getenv("EVENTHUB_CONSUMER_GROUP"),
		checkpointURL: os.Getenv("EVENTHUB_CHECKPOINT_CONTAINER_URL"),
	}
	if configuration.namespace == "" || configuration.eventHub == "" || configuration.consumerGroup == "" || configuration.checkpointURL == "" {
		return config{}, errors.New("Event Hubs namespace, hub, consumer group, and checkpoint container environment variables are required")
	}
	return configuration, nil
}

func send(ctx context.Context, producer *azeventhubs.ProducerClient) error {
	batch, err := producer.NewEventDataBatch(ctx, nil)
	if err != nil {
		return fmt.Errorf("create event batch: %w", err)
	}
	for _, body := range []string{"first event", "second event", "third event"} {
		if err := batch.AddEventData(&azeventhubs.EventData{Body: []byte(body)}, nil); err != nil {
			if batch.NumEvents() == 0 {
				return fmt.Errorf("event exceeds empty batch capacity: %w", err)
			}
			if err := producer.SendEventDataBatch(ctx, batch, nil); err != nil {
				return fmt.Errorf("send full event batch: %w", err)
			}
			batch, err = producer.NewEventDataBatch(ctx, nil)
			if err != nil {
				return err
			}
			if err := batch.AddEventData(&azeventhubs.EventData{Body: []byte(body)}, nil); err != nil {
				return fmt.Errorf("event exceeds empty batch capacity: %w", err)
			}
		}
	}
	if batch.NumEvents() > 0 {
		if err := producer.SendEventDataBatch(ctx, batch, nil); err != nil {
			return fmt.Errorf("send event batch: %w", err)
		}
	}
	return nil
}

func handlePartition(ctx context.Context, partition *azeventhubs.ProcessorPartitionClient) error {
	defer closePartition(partition)
	for {
		events, err := partition.ReceiveEvents(ctx, 100, nil)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return fmt.Errorf("receive partition %s: %w", partition.PartitionID(), err)
		}
		for _, event := range events {
			fmt.Printf("partition=%s body=%s\n", partition.PartitionID(), event.Body)
			if err := partition.UpdateCheckpoint(ctx, event, nil); err != nil {
				return fmt.Errorf("checkpoint partition %s: %w", partition.PartitionID(), err)
			}
		}
	}
}

func receive(ctx context.Context, processor *azeventhubs.Processor) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	processorErrors := make(chan error, 1)
	go func() { processorErrors <- processor.Run(ctx) }()

	partitions := make(chan *azeventhubs.ProcessorPartitionClient)
	go func() {
		defer close(partitions)
		for {
			partition := processor.NextPartitionClient(ctx)
			if partition == nil {
				return
			}
			select {
			case partitions <- partition:
			case <-ctx.Done():
				closePartition(partition)
				return
			}
		}
	}()

	partitionErrors := make(chan error, 1)
	var workers sync.WaitGroup
	stop := func() {
		cancel()
		workers.Wait()
	}
	for {
		select {
		case <-ctx.Done():
			stop()
			return nil
		case err := <-processorErrors:
			stop()
			if err != nil && !errors.Is(err, context.Canceled) {
				return fmt.Errorf("run processor: %w", err)
			}
			return nil
		case err := <-partitionErrors:
			stop()
			return err
		case partition, ok := <-partitions:
			if !ok {
				partitions = nil
				continue
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				if err := handlePartition(ctx, partition); err != nil {
					select {
					case partitionErrors <- err:
					case <-ctx.Done():
					}
				}
			}()
		}
	}
}

func closePartition(partition *azeventhubs.ProcessorPartitionClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := partition.Close(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "close partition %s: %v\n", partition.PartitionID(), err)
	}
}

func run(ctx context.Context) error {
	configuration, err := loadConfig()
	if err != nil {
		return err
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	producer, err := azeventhubs.NewProducerClient(configuration.namespace, configuration.eventHub, credential, nil)
	if err != nil {
		return fmt.Errorf("create producer: %w", err)
	}
	defer closeProducer(producer)
	if err := send(ctx, producer); err != nil {
		return err
	}
	consumer, err := azeventhubs.NewConsumerClient(configuration.namespace, configuration.eventHub, configuration.consumerGroup, credential, nil)
	if err != nil {
		return fmt.Errorf("create consumer: %w", err)
	}
	defer closeConsumer(consumer)
	checkpointContainer, err := container.NewClient(configuration.checkpointURL, credential, nil)
	if err != nil {
		return fmt.Errorf("create checkpoint container client: %w", err)
	}
	store, err := checkpoints.NewBlobStore(checkpointContainer, nil)
	if err != nil {
		return fmt.Errorf("create checkpoint store: %w", err)
	}
	processor, err := azeventhubs.NewProcessor(consumer, store, nil)
	if err != nil {
		return fmt.Errorf("create processor: %w", err)
	}
	return receive(ctx, processor)
}

func closeProducer(producer *azeventhubs.ProducerClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := producer.Close(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "close producer:", err)
	}
}

func closeConsumer(consumer *azeventhubs.ConsumerClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := consumer.Close(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "close consumer:", err)
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
