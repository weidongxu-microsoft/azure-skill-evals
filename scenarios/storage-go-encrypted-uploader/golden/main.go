package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azkeys"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
)

const (
	metadataWrappedKey = "wrappeddek"
	metadataNonce      = "nonce"
	metadataKeyID      = "keyid"
)

type envelopeStore struct {
	blobs      *azblob.Client
	keys       *azkeys.Client
	container  string
	vaultURL   string
	keyName    string
	keyVersion string
}

func encrypt(plaintext []byte) (ciphertext, dataKey, nonce []byte, err error) {
	dataKey = make([]byte, 32)
	if _, err = rand.Read(dataKey); err != nil {
		return nil, nil, nil, fmt.Errorf("generate DEK: %w", err)
	}
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return nil, nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, nil, fmt.Errorf("generate nonce: %w", err)
	}
	return gcm.Seal(nil, nonce, plaintext, nil), dataKey, nonce, nil
}

func decrypt(ciphertext, dataKey, nonce []byte) ([]byte, error) {
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("authenticate and decrypt: %w", err)
	}
	return plaintext, nil
}

func (store *envelopeStore) keyID() string {
	return strings.TrimSuffix(store.vaultURL, "/") + "/keys/" + store.keyName + "/" + store.keyVersion
}

func (store *envelopeStore) upload(ctx context.Context, blobName string, plaintext []byte) (string, error) {
	ciphertext, dataKey, nonce, err := encrypt(plaintext)
	if err != nil {
		return "", err
	}
	algorithm := azkeys.EncryptionAlgorithmRSAOAEP256
	wrapped, err := store.keys.WrapKey(ctx, store.keyName, store.keyVersion, azkeys.KeyOperationParameters{Algorithm: &algorithm, Value: dataKey}, nil)
	for index := range dataKey {
		dataKey[index] = 0
	}
	if err != nil {
		return "", fmt.Errorf("wrap DEK with Key Vault: %w", err)
	}
	wrappedText := base64.StdEncoding.EncodeToString(wrapped.Result)
	nonceText := base64.StdEncoding.EncodeToString(nonce)
	keyID := store.keyID()
	metadata := map[string]*string{metadataWrappedKey: &wrappedText, metadataNonce: &nonceText, metadataKeyID: &keyID}
	if _, err := store.blobs.UploadBuffer(ctx, store.container, blobName, ciphertext, &azblob.UploadBufferOptions{Metadata: metadata}); err != nil {
		return "", fmt.Errorf("upload encrypted blob: %w", err)
	}
	return wrappedText, nil
}

func (store *envelopeStore) download(ctx context.Context, blobName string) ([]byte, error) {
	response, err := store.blobs.DownloadStream(ctx, store.container, blobName, nil)
	if err != nil {
		return nil, fmt.Errorf("download encrypted blob: %w", err)
	}
	defer response.Body.Close()
	ciphertext, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read encrypted blob: %w", err)
	}
	wrappedText, nonceText, keyID := metadataValue(response.Metadata, metadataWrappedKey), metadataValue(response.Metadata, metadataNonce), metadataValue(response.Metadata, metadataKeyID)
	if wrappedText == "" || nonceText == "" || keyID != store.keyID() {
		return nil, errors.New("encrypted blob metadata is missing or references a different key version")
	}
	wrapped, err := base64.StdEncoding.DecodeString(wrappedText)
	if err != nil {
		return nil, fmt.Errorf("decode wrapped DEK: %w", err)
	}
	nonce, err := base64.StdEncoding.DecodeString(nonceText)
	if err != nil {
		return nil, fmt.Errorf("decode nonce: %w", err)
	}
	algorithm := azkeys.EncryptionAlgorithmRSAOAEP256
	unwrapped, err := store.keys.UnwrapKey(ctx, store.keyName, store.keyVersion, azkeys.KeyOperationParameters{Algorithm: &algorithm, Value: wrapped}, nil)
	if err != nil {
		return nil, fmt.Errorf("unwrap DEK with Key Vault: %w", err)
	}
	decrypted, err := decrypt(ciphertext, unwrapped.Result, nonce)
	for index := range unwrapped.Result {
		unwrapped.Result[index] = 0
	}
	return decrypted, err
}

func metadataValue(metadata map[string]*string, name string) string {
	for key, value := range metadata {
		if strings.EqualFold(key, name) && value != nil {
			return *value
		}
	}
	return ""
}

func buildStore() (*envelopeStore, error) {
	serviceURL, containerName := os.Getenv("AZURE_STORAGE_BLOB_URL"), os.Getenv("AZURE_STORAGE_CONTAINER")
	vaultURL, keyName, keyVersion := os.Getenv("AZURE_KEY_VAULT_URL"), os.Getenv("AZURE_KEY_NAME"), os.Getenv("AZURE_KEY_VERSION")
	if serviceURL == "" || containerName == "" || vaultURL == "" || keyName == "" || keyVersion == "" {
		return nil, errors.New("Blob and versioned Key Vault key environment variables are required")
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("create credential: %w", err)
	}
	blobs, err := azblob.NewClient(serviceURL, credential, nil)
	if err != nil {
		return nil, fmt.Errorf("create Blob client: %w", err)
	}
	keys, err := azkeys.NewClient(vaultURL, credential, nil)
	if err != nil {
		return nil, fmt.Errorf("create Key Vault Keys client: %w", err)
	}
	return &envelopeStore{blobs: blobs, keys: keys, container: containerName, vaultURL: vaultURL, keyName: keyName, keyVersion: keyVersion}, nil
}

func run(ctx context.Context) error {
	store, err := buildStore()
	if err != nil {
		return err
	}
	wrapped, err := store.upload(ctx, "encrypted-demo.bin", []byte("confidential payload"))
	if err != nil {
		return err
	}
	plaintext, err := store.download(ctx, "encrypted-demo.bin")
	if err != nil {
		return err
	}
	fmt.Println("key ID:", store.keyID())
	fmt.Println("wrapped DEK:", wrapped)
	fmt.Println("decrypted:", string(plaintext))
	return nil
}

func main() {
	if err := run(context.Background()); err != nil {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) {
			switch {
			case responseError.StatusCode == 404:
				fmt.Fprintf(os.Stderr, "blob or key not found: code=%s\n", responseError.ErrorCode)
			default:
				fmt.Fprintf(os.Stderr, "Azure request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
			}
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
