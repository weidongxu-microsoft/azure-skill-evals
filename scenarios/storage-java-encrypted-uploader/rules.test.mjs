import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  javaCheckNames,
  loadJavaWorkspace,
} from "../../languages/java/checks.mjs";
import { evaluateRule, ruleNames } from "./tools/storage-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);

function workspace(source, build = golden.build) {
  return {
    sourceFiles: ["Application.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
  };
}

function rejectsEveryScenarioRule(source, build = golden.build, label = "") {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, workspace(source, build)),
      false,
      label ? `${label}: ${rule}` : rule,
    );
  }
}

function withTransparentPassThrough(source) {
  return source
    .replace(
      "public final class SyncEncryptedBlobUploader {",
      `public final class SyncEncryptedBlobUploader {
    private static <T> T passThrough(T value) {
        T alias = value;
        return alias;
    }`,
    )
    .replace(
      "public final class AsyncEncryptedBlobUploader {",
      `public final class AsyncEncryptedBlobUploader {
    private static <T> T passThrough(T value) {
        T alias = value;
        return alias;
    }`,
    )
    .replace(
      "public final class Main {",
      `public final class Main {
    private static <T> T passThrough(T value) {
        T alias = value;
        return alias;
    }`,
    );
}

test("the real golden application passes scenario and shared Java checks", () => {
  assert.equal(ruleNames().length, 7);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test("each exact active Azure SDK pin is required", () => {
  for (const [artifact, version] of [
    ["azure-identity", "1.18.5"],
    ["azure-storage-blob", "12.35.1"],
    ["azure-security-keyvault-keys", "4.11.2"],
  ]) {
    assert.equal(evaluateRule("prompt/sdk-dependencies", {
      ...golden,
      build: golden.build.replace(
        `<artifactId>${artifact}</artifactId><version>${version}</version>`,
        `<artifactId>${artifact}</artifactId><version>0.0.1</version>`,
      ),
    }), false, artifact);
  }
});

test("configuration requires official builders, both endpoints, and one credential", () => {
  const withoutVault = golden.source.replace('"AZURE_KEY_VAULT_URL"', '"NOT_THE_VAULT"');
  assert.equal(evaluateRule("prompt/client-configuration", workspace(withoutVault)), false);
  const duplicatedCredential = golden.source.replace(
    "new DefaultAzureCredentialBuilder().build();",
    "new DefaultAzureCredentialBuilder().build(); new DefaultAzureCredentialBuilder().build();",
  );
  assert.equal(evaluateRule("prompt/client-configuration", workspace(duplicatedCredential)), false);
  const fake = `class KeyClientBuilder { KeyClientBuilder credential(Object value) { return this; } }
class Application { public static void main(String[] args) {} }`;
  assert.equal(evaluateRule("prompt/client-configuration", workspace(fake)), false);
});

test("sync and async flows require local AES-GCM DEKs and Key Vault wrapping", () => {
  const noGcm = golden.source.replaceAll("AES/GCM/NoPadding", "AES/CBC/PKCS5Padding");
  assert.equal(evaluateRule("prompt/sync-envelope-encryption", workspace(noGcm)), false);
  assert.equal(evaluateRule("prompt/async-envelope-encryption", workspace(noGcm)), false);
  const noWrap = golden.source.replaceAll("wrapKey(", "notWrapKey(");
  assert.equal(evaluateRule("prompt/sync-envelope-encryption", workspace(noWrap)), false);
  assert.equal(evaluateRule("prompt/async-envelope-encryption", workspace(noWrap)), false);
  const falseBranch = `import com.azure.security.keyvault.keys.KeyClient;
import com.azure.security.keyvault.keys.CryptographyClient;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.models.BlobStorageException;
class Application { public static void main(String[] args) { if (false) {
  new java.security.SecureRandom().nextBytes(new byte[32]);
  javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
} } }`;
  assert.equal(evaluateRule("prompt/sync-envelope-encryption", workspace(falseBranch)), false);
});

test("sync flow rejects plaintext, raw keys, local recovery, and disconnected evidence", () => {
  const earlyPlaintextReturn = golden.source.replace(
    "            String keyId = keyClient.getKey(keyName).getId();",
    `            return new String(plaintext, java.nio.charset.StandardCharsets.UTF_8);
            String keyId = keyClient.getKey(keyName).getId();`,
  );
  const constantReturn = golden.source.replace(
    "return new String(decryptor.doFinal(blob.downloadContent().toBytes()),",
    'return "constant"; //',
  );
  const rawDekMetadata = golden.source.replaceAll(
    'metadata.put("iv", Base64.getEncoder().encodeToString(iv));',
    `metadata.put("iv", Base64.getEncoder().encodeToString(iv));
            byte[] rawDek = dek;
            metadata.put("copy", Base64.getEncoder().encodeToString(rawDek));`,
  );
  const disconnected = golden.source.replace(
    ".roundTrip(container, blobName, keyName, message)",
    ".unused(container, blobName, keyName, message)",
  );
  const fakeBlobClient = golden.source.replace(
    "public final class SyncEncryptedBlobUploader {",
    "final class BlobClient {}\n\npublic final class SyncEncryptedBlobUploader {",
  );

  for (const [name, source] of [
    ["plaintext upload", golden.source.replaceAll(
      "BinaryData.fromBytes(ciphertext)",
      "BinaryData.fromBytes(plaintext)",
    )],
    ["local metadata", golden.source.replaceAll("stored.get(", "metadata.get(")],
    ["local ciphertext", golden.source.replace(
      "decryptor.doFinal(blob.downloadContent().toBytes())",
      "decryptor.doFinal(ciphertext)",
    )],
    ["early plaintext return", earlyPlaintextReturn],
    ["constant round-trip return", constantReturn],
    ["raw DEK metadata", rawDekMetadata],
    ["disconnected helper", disconnected],
    ["fake blob client", fakeBlobClient],
  ]) {
    assert.equal(
      evaluateRule("prompt/sync-envelope-encryption", workspace(source)),
      false,
      name,
    );
  }
});

test("ChaCha and other non-GCM transformations never satisfy envelope workflows", () => {
  const chacha = golden.source.replaceAll("AES/GCM/NoPadding", "ChaCha20-Poly1305");
  assert.equal(evaluateRule("prompt/sync-envelope-encryption", workspace(chacha)), false);
  assert.equal(evaluateRule("prompt/async-envelope-encryption", workspace(chacha)), false);
});

test("async flow encrypts before upload and decrypts downloaded ciphertext after unwrap", () => {
  const earlyPlaintextReturn = golden.source.replace(
    "        CryptographyAsyncClient crypto = clients.cryptographyAsyncClient(keyId);",
    `        return Mono.just(new String(plaintext, StandardCharsets.UTF_8));
        CryptographyAsyncClient crypto = clients.cryptographyAsyncClient(keyId);`,
  );
  const inactiveWorkflow = golden.source
    .replace(
      '            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");',
      '            if (false) { Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");',
    )
    .replace(
      "        } catch (Exception exception) {",
      "            }\n        } catch (Exception exception) {",
    );
  const stringDecoy = golden.source.replace(
    '            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");',
    `            String decoy = "Cipher encryptor = Cipher.getInstance(\\"AES/GCM/NoPadding\\");";
            Cipher encryptor = null;`,
  );
  const commentedDecoy = golden.source.replace(
    '            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");',
    `            /* Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding"); */
            Cipher encryptor = null;`,
  );
  const fakeCipher = golden.source
    .replace("import javax.crypto.Cipher;\n", "")
    .replace(
      "public final class AsyncEncryptedBlobUploader {",
      `final class Cipher {
    static Cipher getInstance(String transformation) { return new Cipher(); }
    void init(int mode, Object key, Object parameters) {}
    byte[] doFinal(byte[] value) { return value; }
}

public final class AsyncEncryptedBlobUploader {`,
    );

  for (const [name, source] of [
    ["non-GCM encryption", golden.source.replace(
      'Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");',
      'Cipher encryptor = Cipher.getInstance("AES/CBC/PKCS5Padding");',
    )],
    ["plaintext upload", golden.source.replace(
      "BinaryData.fromBytes(ciphertext)",
      "BinaryData.fromBytes(plaintext)",
    )],
    ["disconnected wrap chain", golden.source.replace(
      ".flatMap(wrapped -> {",
      ".map(wrapped -> {",
    )],
    ["unwraps a local result instead of downloaded metadata", golden.source.replace(
      'Base64.getDecoder().decode(properties.getMetadata().get("wrapped-dek"))',
      "wrapped.getEncryptedKey()",
    )],
    ["decrypts local ciphertext instead of downloaded content", golden.source.replace(
      "content.toBytes(), unwrapped.getKey()",
      "ciphertext, unwrapped.getKey()",
    )],
    ["decrypts with the original DEK", golden.source.replace(
      "content.toBytes(), unwrapped.getKey()",
      "content.toBytes(), dek",
    )],
    ["removes AES-GCM decryption", golden.source.replace(
      "cipher.init(Cipher.DECRYPT_MODE",
      "cipher.init(Cipher.ENCRYPT_MODE",
    )],
    ["early plaintext return", earlyPlaintextReturn],
    ["inactive workflow decoy", inactiveWorkflow],
    ["comment token decoy", commentedDecoy],
    ["string token decoy", stringDecoy],
    ["fake cipher type", fakeCipher],
  ]) {
    assert.equal(
      evaluateRule("prompt/async-envelope-encryption", workspace(source)),
      false,
      name,
    );
  }
});

test("async flow accepts aliases, constants, and helpers for AES-GCM and RSA-OAEP", () => {
  let alternate = golden.source.replace(
    "public final class AsyncEncryptedBlobUploader {",
    `public final class AsyncEncryptedBlobUploader {
    private static final int DEK_SIZE = 32;
    private static final int IV_SIZE = 12;
    private static final String AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final KeyWrapAlgorithm WRAP_ALGORITHM = rsaOaep();

    private static KeyWrapAlgorithm rsaOaep() {
        return KeyWrapAlgorithm.RSA_OAEP;
    }

    private static String gcmTransformation() {
        return AES_GCM_TRANSFORMATION;
    }`,
  );
  alternate = alternate
    .replace("new byte[32]", "new byte[DEK_SIZE]")
    .replace("new byte[12]", "new byte[IV_SIZE]")
    .replace(
      "        SecureRandom random = new SecureRandom();",
      `        KeyWrapAlgorithm algorithm = WRAP_ALGORITHM;
        String transformation = gcmTransformation();
        SecureRandom random = new SecureRandom();`,
    )
    .replace(
      'Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");',
      "Cipher encryptor = Cipher.getInstance(transformation);",
    )
    .replace(
      'Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");',
      "Cipher cipher = Cipher.getInstance(gcmTransformation());",
    )
    .replace(
      "crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)",
      "crypto.wrapKey(algorithm, dek)",
    )
    .replace(
      "crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,",
      "crypto.unwrapKey(rsaOaep(),",
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(alternate)), true, rule);
  }
});

test("both workflows accept shared aliases and an encryption helper", () => {
  let aliases = golden.source
    .replaceAll(
      'Cipher.getInstance("AES/GCM/NoPadding")',
      "Cipher.getInstance(AzureClients.gcmTransformation())",
    )
    .replaceAll(
      "KeyWrapAlgorithm.RSA_OAEP",
      "AzureClients.rsaOaepAlgorithm()",
    );
  aliases = aliases.replace(
    "public final class AzureClients {",
    `public final class AzureClients {
    private static final String AES_GCM = "AES/GCM/NoPadding";

    public static String gcmTransformation() {
        return AES_GCM;
    }

    public static KeyWrapAlgorithm rsaOaepAlgorithm() {
        return KeyWrapAlgorithm.RSA_OAEP;
    }`,
  ).replace(
    "import com.azure.security.keyvault.keys.cryptography.CryptographyAsyncClient;",
    `import com.azure.security.keyvault.keys.cryptography.CryptographyAsyncClient;
import com.azure.security.keyvault.keys.cryptography.models.KeyWrapAlgorithm;`,
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(aliases)), true, rule);
  }

  let helper = golden.source.replace(
    `        try {
            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");
            encryptor.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dek, "AES"), new GCMParameterSpec(128, iv));
            byte[] ciphertext = encryptor.doFinal(plaintext);`,
    `        try {
            byte[] ciphertext = encrypt(plaintext, dek, iv);`,
  );
  helper = helper.replace(
    "    private String decrypt(byte[] ciphertext, byte[] dek, byte[] iv) {",
    `    private byte[] encrypt(byte[] plaintext, byte[] dek, byte[] iv) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dek, "AES"), new GCMParameterSpec(128, iv));
            return cipher.doFinal(plaintext);
        } catch (Exception exception) {
            throw new IllegalStateException("Unable to encrypt blob content", exception);
        }
    }

    private String decrypt(byte[] ciphertext, byte[] dek, byte[] iv) {`,
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(helper)), true, rule);
  }
});

test("envelope values reject transformed bytes and decorated plaintext", () => {
  const augmentedWrappedDek = golden.source.replace(
    'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrappedDek));',
    'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(java.util.Arrays.copyOf(wrappedDek, wrappedDek.length + 1)));',
  );
  const augmentedAsyncWrappedDek = golden.source.replace(
    "Base64.getEncoder().encodeToString(wrapped.getEncryptedKey())",
    "Base64.getEncoder().encodeToString(java.util.Arrays.copyOf(wrapped.getEncryptedKey(), wrapped.getEncryptedKey().length + 1))",
  );
  const augmentedSyncUnwrapInput = golden.source.replace(
    'Base64.getDecoder().decode(stored.get("wrapped-dek"))',
    'java.util.Arrays.copyOf(Base64.getDecoder().decode(stored.get("wrapped-dek")), 1)',
  );
  const augmentedAsyncUnwrapInput = golden.source.replace(
    'Base64.getDecoder().decode(properties.getMetadata().get("wrapped-dek"))',
    'java.util.Arrays.copyOf(Base64.getDecoder().decode(properties.getMetadata().get("wrapped-dek")), 1)',
  );
  const augmentedSyncRecoveredKey = golden.source.replace(
    'SecretKeySpec(recoveredDek, "AES")',
    'SecretKeySpec(java.util.Arrays.copyOf(recoveredDek, recoveredDek.length + 1), "AES")',
  );
  const augmentedAsyncRecoveredKey = golden.source.replaceAll(
    "unwrapped.getKey()",
    "java.util.Arrays.copyOf(unwrapped.getKey(), unwrapped.getKey().length + 1)",
  );
  const augmentedSyncRecoveredIv = golden.source.replace(
    'Base64.getDecoder().decode(stored.get("iv"))',
    'java.util.Arrays.copyOf(Base64.getDecoder().decode(stored.get("iv")), 1)',
  );
  const augmentedAsyncRecoveredIv = golden.source.replace(
    'Base64.getDecoder().decode(properties.getMetadata().get("iv"))',
    'java.util.Arrays.copyOf(Base64.getDecoder().decode(properties.getMetadata().get("iv")), 1)',
  );
  const augmentedSyncCiphertext = golden.source.replace(
    "blob.downloadContent().toBytes()",
    "java.util.Arrays.copyOf(blob.downloadContent().toBytes(), 1)",
  );
  const augmentedAsyncCiphertext = golden.source.replace(
    "content.toBytes(), unwrapped.getKey()",
    "java.util.Arrays.copyOf(content.toBytes(), 1), unwrapped.getKey()",
  );
  const mutatingAsyncUnwrapHelper = golden.source
    .replace(
      "public final class AsyncEncryptedBlobUploader {",
      `public final class AsyncEncryptedBlobUploader {
    private static byte[] mutate(byte[] value) {
        value[0] ^= 1;
        return value;
    }`,
    )
    .replaceAll("unwrapped.getKey()", "mutate(unwrapped.getKey())");
  const delegatedAsyncMutationHelper = golden.source
    .replace(
      "public final class AsyncEncryptedBlobUploader {",
      `public final class AsyncEncryptedBlobUploader {
    private static void alter(byte[] value) {
        value[0] ^= 1;
    }

    private static byte[] passThrough(byte[] value) {
        alter(value);
        return value;
    }`,
    )
    .replaceAll("unwrapped.getKey()", "passThrough(unwrapped.getKey())");
  const decoratedAsyncReactiveResult = golden.source.replace(
    /(\.onErrorMap\(HttpResponseException\.class,\s*exception\s*->\s*\{[\s\S]*?return exception;\s*\})\);/,
    '$1).map(value -> value + " fabricated");',
  );

  for (const [name, source] of [
    ["wraps an augmented DEK", golden.source.replaceAll(
      "wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)",
      "wrapKey(KeyWrapAlgorithm.RSA_OAEP, java.util.Arrays.copyOf(dek, dek.length + 1))",
    )],
    ["wraps an encoded DEK", golden.source.replaceAll(
      "wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)",
      "wrapKey(KeyWrapAlgorithm.RSA_OAEP, Base64.getEncoder().encode(dek))",
    )],
    ["stores an augmented sync wrapped DEK", augmentedWrappedDek],
    ["stores an augmented async wrapped DEK", augmentedAsyncWrappedDek],
    ["wraps the sync result in a copying helper", golden.source.replace(
      "byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek).getEncryptedKey();",
      "byte[] wrappedDek = java.util.Arrays.copyOf(crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek).getEncryptedKey(), 1);",
    )],
    ["double-encodes a wrapped DEK", golden.source.replace(
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrappedDek));',
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(Base64.getEncoder().encode(wrappedDek)));',
    )],
    ["mutates a sync wrapped DEK before metadata", golden.source.replace(
      'System.out.println("Wrapped DEK: " + Base64.getEncoder().encodeToString(wrappedDek));',
      `System.out.println("Wrapped DEK: " + Base64.getEncoder().encodeToString(wrappedDek));
            wrappedDek[0] ^= 1;`,
    )],
    ["mutates an async wrapped DEK before metadata", golden.source.replace(
      ".flatMap(wrapped -> {",
      ` .flatMap(wrapped -> {
                        wrapped.getEncryptedKey()[0] ^= 1;`,
    )],
    ["stores an augmented IV", golden.source.replaceAll(
      "Base64.getEncoder().encodeToString(iv)",
      "Base64.getEncoder().encodeToString(java.util.Arrays.copyOf(iv, iv.length + 1))",
    )],
    ["stores a sliced IV", golden.source.replaceAll(
      "Base64.getEncoder().encodeToString(iv)",
      "Base64.getEncoder().encodeToString(java.util.Arrays.copyOfRange(iv, 0, iv.length - 1))",
    )],
    ["uploads augmented ciphertext", golden.source.replaceAll(
      "BinaryData.fromBytes(ciphertext)",
      "BinaryData.fromBytes(java.util.Arrays.copyOf(ciphertext, ciphertext.length + 1))",
    )],
    ["uploads concatenated ciphertext", golden.source.replaceAll(
      "BinaryData.fromBytes(ciphertext)",
      "BinaryData.fromBytes(java.nio.ByteBuffer.allocate(ciphertext.length + 1).put(ciphertext).put((byte) 0).array())",
    )],
    ["mutates ciphertext before upload", golden.source.replaceAll(
      "byte[] ciphertext = encryptor.doFinal(plaintext);",
      "byte[] ciphertext = encryptor.doFinal(plaintext);\n            ciphertext[0] ^= 1;",
    )],
    ["wraps ciphertext at its source", golden.source.replaceAll(
      "byte[] ciphertext = encryptor.doFinal(plaintext);",
      "byte[] ciphertext = java.util.Arrays.copyOf(encryptor.doFinal(plaintext), 1);",
    )],
    ["unwraps augmented sync metadata", augmentedSyncUnwrapInput],
    ["unwraps augmented async metadata", augmentedAsyncUnwrapInput],
    ["wraps the sync unwrap result at its source", golden.source
      .replace(
        "byte[] recoveredDek = crypto.unwrapKey(",
        "byte[] recoveredDek = java.util.Arrays.copyOf(crypto.unwrapKey(",
      )
      .replace(
        'Base64.getDecoder().decode(stored.get("wrapped-dek"))).getKey();',
        'Base64.getDecoder().decode(stored.get("wrapped-dek"))).getKey(), 1);',
      )],
    ["decrypts with an augmented sync unwrapped DEK", augmentedSyncRecoveredKey],
    ["decrypts with an augmented async unwrapped DEK", augmentedAsyncRecoveredKey],
    ["decrypts with an augmented sync IV", augmentedSyncRecoveredIv],
    ["decrypts with an augmented async IV", augmentedAsyncRecoveredIv],
    ["decrypts augmented sync ciphertext", augmentedSyncCiphertext],
    ["wraps downloaded ciphertext at its source", golden.source.replace(
      "return new String(decryptor.doFinal(blob.downloadContent().toBytes()),",
      `byte[] downloaded = java.util.Arrays.copyOf(blob.downloadContent().toBytes(), 1);
            return new String(decryptor.doFinal(downloaded),`,
    )],
    ["decrypts another blob's ciphertext", golden.source.replace(
      "blob.downloadContent().toBytes()",
      "otherBlob.downloadContent().toBytes()",
    )],
    ["decrypts augmented async ciphertext", augmentedAsyncCiphertext],
    ["mutates the generated DEK", golden.source.replaceAll(
      "random.nextBytes(dek);",
      "random.nextBytes(dek);\n            dek[0] ^= 1;",
    )],
    ["mutates the generated IV", golden.source.replaceAll(
      "random.nextBytes(iv);",
      "random.nextBytes(iv);\n            iv[0] ^= 1;",
    )],
    ["mutates an unwrapped DEK in a helper", mutatingAsyncUnwrapHelper],
    ["delegates unwrapped DEK mutation through a wrapper", delegatedAsyncMutationHelper],
    ["decorates the sync decrypted return", golden.source.replace(
      "return new String(decryptor.doFinal(blob.downloadContent().toBytes()),",
      "return \"fabricated \" + new String(decryptor.doFinal(blob.downloadContent().toBytes()),",
    )],
    ["decorates the async decrypted return", golden.source.replace(
      "return new String(cipher.doFinal(ciphertext),",
      "return \"fabricated \" + new String(cipher.doFinal(ciphertext),",
    )],
    ["decorates the async reactive result", decoratedAsyncReactiveResult],
    ["decorates sync plaintext while printing", golden.source.replace(
      '"Sync decrypted output: " + syncPlaintext',
      '"Sync decrypted output: " + syncPlaintext + " fabricated"',
    )],
    ["mutates a plaintext alias before printing", golden.source.replace(
      'System.out.println("Sync decrypted output: " + syncPlaintext);',
      `syncPlaintext += " fabricated";
        System.out.println("Sync decrypted output: " + syncPlaintext);`,
    )],
    ["decorates async plaintext while printing", golden.source.replace(
      '"Async decrypted output: " + asyncPlaintext',
      '"Async decrypted output: " + asyncPlaintext + " fabricated"',
    )],
  ]) {
    rejectsEveryScenarioRule(source, golden.build, name);
  }
});

test("transparent assignments and pass-through helpers preserve envelope identity", () => {
  let alternate = golden.source
    .replace(
      "public final class SyncEncryptedBlobUploader {",
      `public final class SyncEncryptedBlobUploader {
    private static <T> T passThrough(T value) {
        T alias = value;
        return alias;
    }`,
    )
    .replace(
      "public final class AsyncEncryptedBlobUploader {",
      `public final class AsyncEncryptedBlobUploader {
    private static <T> T passThrough(T value) {
        T alias = value;
        return alias;
    }`,
    )
    .replace(
      "public final class Main {",
      `public final class Main {
    private static <T> T passThrough(T value) {
        T alias = value;
        return alias;
    }`,
    )
    .replaceAll(
      "wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)",
      "wrapKey(KeyWrapAlgorithm.RSA_OAEP, passThrough(dek))",
    )
    .replace(
      "byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, passThrough(dek)).getEncryptedKey();",
      "byte[] wrappedDek = passThrough(crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, passThrough(dek)).getEncryptedKey());",
    )
    .replaceAll(
      "Base64.getEncoder().encodeToString(iv)",
      "Base64.getEncoder().encodeToString(passThrough(iv))",
    )
    .replace(
      "Base64.getEncoder().encodeToString(wrappedDek)",
      "Base64.getEncoder().encodeToString(passThrough(wrappedDek))",
    )
    .replace(
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrappedDek));',
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(passThrough(wrappedDek)));',
    )
    .replace(
      "Base64.getEncoder().encodeToString(wrapped.getEncryptedKey())",
      "Base64.getEncoder().encodeToString(passThrough(wrapped.getEncryptedKey()))",
    )
    .replaceAll(
      "BinaryData.fromBytes(ciphertext)",
      "BinaryData.fromBytes(passThrough(ciphertext))",
    )
    .replaceAll(
      "byte[] ciphertext = encryptor.doFinal(plaintext);",
      "byte[] ciphertext = passThrough(encryptor.doFinal(plaintext));",
    )
    .replace(
      'Base64.getDecoder().decode(stored.get("wrapped-dek"))',
      'passThrough(Base64.getDecoder().decode(stored.get("wrapped-dek")))',
    )
    .replace(
      'Base64.getDecoder().decode(properties.getMetadata().get("wrapped-dek"))',
      'passThrough(Base64.getDecoder().decode(properties.getMetadata().get("wrapped-dek")))',
    )
    .replaceAll("unwrapped.getKey()", "passThrough(unwrapped.getKey())")
    .replaceAll('recoveredDek, "AES"', 'passThrough(recoveredDek), "AES"')
    .replace(
      'Base64.getDecoder().decode(stored.get("iv"))',
      'passThrough(Base64.getDecoder().decode(stored.get("iv")))',
    )
    .replace(
      'Base64.getDecoder().decode(properties.getMetadata().get("iv"))',
      'passThrough(Base64.getDecoder().decode(properties.getMetadata().get("iv")))',
    )
    .replace(
      "blob.downloadContent().toBytes()",
      "passThrough(blob.downloadContent().toBytes())",
    )
    .replace("content.toBytes()", "passThrough(content.toBytes())");
  alternate = alternate
    .replace(
      "decryptor.doFinal(passThrough(blob.downloadContent().toBytes()))",
      "passThrough(decryptor.doFinal(passThrough(blob.downloadContent().toBytes())))",
    )
    .replace(
      "cipher.doFinal(ciphertext)",
      "passThrough(cipher.doFinal(ciphertext))",
    )
    .replace(
      '"Sync decrypted output: " + syncPlaintext',
      '"Sync decrypted output: " + passThrough(syncPlaintext)',
    )
    .replace(
      '"Async decrypted output: " + asyncPlaintext',
      '"Async decrypted output: " + passThrough(asyncPlaintext)',
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(alternate)), true, rule);
  }
});

test("named pass-through aliases preserve exact sync and async envelope values", () => {
  let alternate = withTransparentPassThrough(golden.source)
    .replace(
      "            byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek).getEncryptedKey();",
      `            byte[] dekForWrap = passThrough(dek);
            byte[] ciphertextForUpload = passThrough(ciphertext);
            byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dekForWrap).getEncryptedKey();
            byte[] wrappedForMetadata = passThrough(wrappedDek);
            byte[] ivForMetadata = passThrough(iv);`,
    )
    .replace(
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrappedDek));',
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrappedForMetadata));',
    )
    .replace(
      '            metadata.put("iv", Base64.getEncoder().encodeToString(iv));',
      '            metadata.put("iv", Base64.getEncoder().encodeToString(ivForMetadata));',
    )
    .replace(
      "blob.uploadWithResponse(new BlobParallelUploadOptions(BinaryData.fromBytes(ciphertext)).setMetadata(metadata),",
      "blob.uploadWithResponse(new BlobParallelUploadOptions(BinaryData.fromBytes(ciphertextForUpload)).setMetadata(metadata),",
    )
    .replace(
      "            byte[] recoveredDek = crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,",
      `            byte[] wrappedFromMetadata = passThrough(Base64.getDecoder().decode(stored.get("wrapped-dek")));
            byte[] recoveredDek = crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,`,
    )
    .replace(
      '                    Base64.getDecoder().decode(stored.get("wrapped-dek"))).getKey();',
      "                    wrappedFromMetadata).getKey();",
    )
    .replace(
      '            Cipher decryptor = Cipher.getInstance("AES/GCM/NoPadding");',
      `            byte[] recoveredForDecrypt = passThrough(recoveredDek);
            byte[] ivFromMetadata = passThrough(Base64.getDecoder().decode(stored.get("iv")));
            byte[] downloaded = passThrough(blob.downloadContent().toBytes());
            Cipher decryptor = Cipher.getInstance("AES/GCM/NoPadding");`,
    )
    .replace(
      'new javax.crypto.spec.SecretKeySpec(recoveredDek, "AES")',
      'new javax.crypto.spec.SecretKeySpec(recoveredForDecrypt, "AES")',
    )
    .replace(
      'new GCMParameterSpec(128, Base64.getDecoder().decode(stored.get("iv")))',
      "new GCMParameterSpec(128, ivFromMetadata)",
    )
    .replace(
      "decryptor.doFinal(blob.downloadContent().toBytes())",
      "decryptor.doFinal(downloaded)",
    )
    .replace(
      "            return crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)",
      `            byte[] dekForWrap = passThrough(dek);
            byte[] ciphertextForUpload = passThrough(ciphertext);
            byte[] ivForMetadata = passThrough(iv);
            return crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dekForWrap)`,
    )
    .replace(
      "                        Map<String, String> metadata = new HashMap<>();",
      `                        byte[] wrappedForMetadata = passThrough(wrapped.getEncryptedKey());
                        Map<String, String> metadata = new HashMap<>();`,
    )
    .replace(
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrapped.getEncryptedKey()));',
      'metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrappedForMetadata));',
    )
    .replace(
      '                        metadata.put("iv", Base64.getEncoder().encodeToString(iv));',
      '                        metadata.put("iv", Base64.getEncoder().encodeToString(ivForMetadata));',
    )
    .replace(
      "return blob.uploadWithResponse(new BlobParallelUploadOptions(BinaryData.fromBytes(ciphertext))",
      "return blob.uploadWithResponse(new BlobParallelUploadOptions(BinaryData.fromBytes(ciphertextForUpload))",
    )
    .replace(
      'System.out.println("Sync decrypted output: " + syncPlaintext);',
      `String syncOutput = passThrough(syncPlaintext);
        System.out.println("Sync decrypted output: " + syncOutput);`,
    )
    .replace(
      'System.out.println("Async decrypted output: " + asyncPlaintext);',
      `String asyncOutput = passThrough(asyncPlaintext);
        System.out.println("Async decrypted output: " + asyncOutput);`,
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(alternate)), true, rule);
  }
});

test("pass-through aliases cannot conceal envelope-byte mutations", () => {
  const passThrough = withTransparentPassThrough(golden.source);
  const syncDekAlias = passThrough.replace(
    "            random.nextBytes(iv);",
    `            byte[] dekAlias = passThrough(dek);
            dekAlias[0] ^= 1;
            random.nextBytes(iv);`,
  );
  const syncSlicedDekAlias = passThrough.replace(
    "            random.nextBytes(iv);",
    `            byte[] dekAlias = dek;
            java.nio.ByteBuffer.wrap(dekAlias).slice().put(0, (byte) 1);
            random.nextBytes(iv);`,
  );
  const syncCopiedDekMutation = passThrough
    .replace(
      "public final class SyncEncryptedBlobUploader {",
      `public final class SyncEncryptedBlobUploader {
    private static void rewrite(byte[] value) {
        byte[] copy = java.util.Arrays.copyOf(value, value.length);
        copy[0] ^= 1;
        System.arraycopy(copy, 0, value, 0, value.length);
    }`,
    )
    .replace(
      "            byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek).getEncryptedKey();",
      `            rewrite(dek);
            byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek).getEncryptedKey();`,
    );
  const asyncWrappedAlias = passThrough.replace(
    "                        Map<String, String> metadata = new HashMap<>();",
    `                        byte[] wrappedAlias = passThrough(wrapped.getEncryptedKey());
                        wrappedAlias[0] ^= 1;
                        Map<String, String> metadata = new HashMap<>();`,
  );
  const syncIvAlias = passThrough.replace(
    '            encryptor.init(Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(dek, "AES"),',
    `            byte[] ivAlias = passThrough(iv);
            ivAlias[0] ^= 1;
            encryptor.init(Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(dek, "AES"),`,
  );
  const asyncCiphertextAlias = passThrough.replace(
    "            return crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)",
    `            byte[] ciphertextAlias = passThrough(ciphertext);
            ciphertextAlias[0] ^= 1;
            return crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)`,
  );
  const syncMetadataAlias = passThrough.replace(
    "            byte[] recoveredDek = crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,",
    `            byte[] wrappedFromMetadata = Base64.getDecoder().decode(stored.get("wrapped-dek"));
            byte[] metadataAlias = passThrough(wrappedFromMetadata);
            metadataAlias[0] ^= 1;
            byte[] recoveredDek = crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,`,
  ).replace(
    '                    Base64.getDecoder().decode(stored.get("wrapped-dek"))).getKey();',
    "                    wrappedFromMetadata).getKey();",
  );
  const syncRecoveredDekAlias = passThrough.replace(
    `            Cipher decryptor = Cipher.getInstance("AES/GCM/NoPadding");`,
    `            byte[] recoveredDekAlias = passThrough(recoveredDek);
            recoveredDekAlias[0] ^= 1;
            Cipher decryptor = Cipher.getInstance("AES/GCM/NoPadding");`,
  );
  const syncDownloadedAlias = passThrough.replace(
    "            return new String(decryptor.doFinal(blob.downloadContent().toBytes()),",
    `            byte[] downloaded = blob.downloadContent().toBytes();
            byte[] downloadedAlias = passThrough(downloaded);
            downloadedAlias[0] ^= 1;
            return new String(decryptor.doFinal(downloaded),`,
  );
  const asyncDecryptInputAlias = passThrough.replace(
    "    private String decrypt(byte[] ciphertext, byte[] dek, byte[] iv) {",
    `    private String decrypt(byte[] ciphertext, byte[] dek, byte[] iv) {
        byte[] ciphertextAlias = passThrough(ciphertext);
        ciphertextAlias[0] ^= 1;
        try {`,
  );

  for (const [name, rule, source] of [
    ["sync generated DEK", "prompt/sync-envelope-encryption", syncDekAlias],
    ["sync sliced DEK buffer", "prompt/sync-envelope-encryption", syncSlicedDekAlias],
    ["sync copied DEK", "prompt/sync-envelope-encryption", syncCopiedDekMutation],
    ["async wrapped DEK", "prompt/async-envelope-encryption", asyncWrappedAlias],
    ["sync IV", "prompt/sync-envelope-encryption", syncIvAlias],
    ["async ciphertext", "prompt/async-envelope-encryption", asyncCiphertextAlias],
    ["sync wrapped metadata", "prompt/sync-envelope-encryption", syncMetadataAlias],
    ["sync unwrapped DEK", "prompt/sync-envelope-encryption", syncRecoveredDekAlias],
    ["sync downloaded ciphertext", "prompt/sync-envelope-encryption", syncDownloadedAlias],
    ["async downloaded ciphertext", "prompt/async-envelope-encryption", asyncDecryptInputAlias],
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), false, name);
    assert.equal(evaluateRule("prompt/connected-demo", workspace(source)), false, `${name}: demo`);
  }
});

test("metadata must preserve only protected key material and permit decrypt recovery", () => {
  assert.equal(evaluateRule("prompt/encrypted-blob-metadata", workspace(
    golden.source.replaceAll('"wrapped-dek"', '"raw-dek"'),
  )), false);
  const rawDek = golden.source.replace(
    "metadata.put(\"iv\", Base64.getEncoder().encodeToString(iv));",
    "metadata.put(\"dek\", Base64.getEncoder().encodeToString(dek));",
  );
  assert.equal(evaluateRule("prompt/encrypted-blob-metadata", workspace(rawDek)), false);
  const secrets = golden.source.replace(
    "import com.azure.identity.DefaultAzureCredential;",
    "import com.azure.identity.DefaultAzureCredential;\nimport com.azure.security.keyvault.secrets.SecretClient;",
  );
  assert.equal(evaluateRule("prompt/encrypted-blob-metadata", workspace(secrets)), false);
});

test("both workflows inspect and preserve service failures", () => {
  assert.equal(evaluateRule("prompt/error-handling", workspace(
    golden.source.replaceAll("throw exception;", "return \"\";"),
  )), false);
  assert.equal(evaluateRule("prompt/error-handling", workspace(
    golden.source.replaceAll("exception.getStatusCode()", "exception.toString()"),
  )), false);
  assert.equal(evaluateRule("prompt/error-handling", workspace(
    golden.source.replaceAll("onErrorMap(", "notOnErrorMap("),
  )), false);
});

test("the demo runs sync before blocked async work and prints round-trip values", () => {
  assert.equal(evaluateRule("prompt/connected-demo", workspace(
    golden.source.replace(".block();", ";"),
  )), false);
  assert.equal(evaluateRule("prompt/connected-demo", workspace(
    golden.source.replaceAll("decrypted", "result"),
  )), false);
  assert.equal(evaluateRule("prompt/connected-demo", workspace(
    golden.source.replace(
      '        AzureClients clients = new AzureClients',
      '        if (true) { return; }\n        AzureClients clients = new AzureClients',
    ),
  )), false);
});

test("every rule rejects reachable bypasses, disconnected paths, and fabricated metadata", () => {
  const alwaysReturning = golden.source.replace(
    "        AzureClients clients = new AzureClients",
    "        if (Boolean.TRUE) { return; }\n        AzureClients clients = new AzureClients",
  );
  const mutuallyExclusive = golden.source
    .replace(
      "        String syncPlaintext = new SyncEncryptedBlobUploader",
      "        if (args.length > 0) {\n            String syncPlaintext = new SyncEncryptedBlobUploader",
    )
    .replace(
      '        System.out.println("Sync decrypted output: " + syncPlaintext);',
      '            System.out.println("Sync decrypted output: " + syncPlaintext);\n        } else {',
    )
    .replace(
      '        System.out.println("Async decrypted output: " + asyncPlaintext);',
      '            System.out.println("Async decrypted output: " + asyncPlaintext);\n        }',
    );
  const fabricatedMetadata = golden.source.replaceAll(
    'metadata.put("vault-key-id", keyId);',
    'metadata.put("vault-key-id", "fabricated-key-id");',
  );
  const overwrittenKeyIdMetadata = golden.source.replace(
    'metadata.put("vault-key-id", keyId);',
    `metadata.put("vault-key-id", keyId);
            metadata.put("vault-key-id", "fabricated-key-id");`,
  );
  const disconnectedStringDecoy = golden.source
    .replace(
      ".roundTrip(container, blobName, keyName, message)",
      ".unused(container, blobName, keyName, message)",
    )
    .replace(
      '        String container = "encrypted-demo";',
      `        String container = "encrypted-demo";
        String decoy = "new SyncEncryptedBlobUploader(clients.keyClient(), clients)"
                + ".roundTrip(container, blobName, keyName, message)";`,
    );
  const fakeCryptoClient = golden.source.replace(
    "CryptographyClient crypto = clients.cryptographyClient(keyId);",
    "FakeCryptographyClient crypto = new FakeCryptographyClient();",
  );
  const plaintextUpload = golden.source.replaceAll(
    "BinaryData.fromBytes(ciphertext)",
    "BinaryData.fromBytes(plaintext)",
  );
  const overwrittenCiphertext = golden.source.replaceAll(
    "byte[] ciphertext = encryptor.doFinal(plaintext);",
    `byte[] ciphertext = encryptor.doFinal(plaintext);
            ciphertext = plaintext;`,
  );
  const nonLiteralDeadEncryption = golden.source
    .replace(
      '            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");',
      `            if (Boolean.FALSE) {
                Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");`,
    )
    .replace(
      "            byte[] ciphertext = encryptor.doFinal(plaintext);",
      `                byte[] ciphertext = encryptor.doFinal(plaintext);
            }`,
    );
  const disconnectedActualKeyId = golden.source
    .replace(
      "        String keyId = clients.keyClient().getKey(keyName).getId();",
      `        String keyId = clients.keyClient().getKey(keyName).getId();
        String asyncKeyId = "fabricated-key-id";`,
    )
    .replace(
      '.roundTrip(container, blobName + "-async", keyId, message)',
      '.roundTrip(container, blobName + "-async", asyncKeyId, message)',
    )
    .replace(
      "    private static String require(String name) {",
      `    private static void disconnected(AzureClients clients, byte[] message) {
        String actualKeyId = clients.keyClient().getKey("unused-key").getId();
        new AsyncEncryptedBlobUploader(clients)
                .roundTrip("unused-container", "unused-blob", actualKeyId, message)
                .block();
    }

    private static String require(String name) {`,
    );
  const fabricatedOutputs = golden.source
    .replace(
      'System.out.println("Vault key ID: " + keyId);',
      'System.out.println("Vault key ID: fabricated-key-id");',
    )
    .replace(
      'System.out.println("Wrapped DEK: " + Base64.getEncoder().encodeToString(wrappedDek));',
      'System.out.println("Wrapped DEK: fabricated");',
    )
    .replace(
      'System.out.println("Sync decrypted output: " + syncPlaintext);',
      'System.out.println("Sync decrypted output: fabricated");',
    );
  const overwrittenOutput = golden.source.replace(
    'System.out.println("Sync decrypted output: " + syncPlaintext);',
    `syncPlaintext = "fabricated";
        System.out.println("Sync decrypted output: " + syncPlaintext);`,
  );

  for (const [name, source] of [
    ["always-returning main", alwaysReturning],
    ["mutually exclusive sync and async branches", mutuallyExclusive],
    ["fabricated vault key ID metadata", fabricatedMetadata],
    ["fabricated vault key ID metadata overwrite", overwrittenKeyIdMetadata],
    ["disconnected string decoy", disconnectedStringDecoy],
    ["fake cryptography client", fakeCryptoClient],
    ["plaintext upload", plaintextUpload],
    ["ciphertext overwritten with plaintext after encryption", overwrittenCiphertext],
    ["AES-GCM work in a nonliteral dead branch", nonLiteralDeadEncryption],
    ["actual key ID only in a disconnected async call", disconnectedActualKeyId],
    ["fabricated key, wrapped DEK, and plaintext output", fabricatedOutputs],
    ["decrypted output variable overwritten before printing", overwrittenOutput],
  ]) {
    rejectsEveryScenarioRule(source);
  }
});

test("RSA-OAEP-256 and a derived key ID alias preserve the complete application", () => {
  const alternate = golden.source
    .replaceAll("KeyWrapAlgorithm.RSA_OAEP", "KeyWrapAlgorithm.RSA_OAEP_256")
    .replace(
      "            CryptographyClient crypto = clients.cryptographyClient(keyId);",
      `            String vaultKeyId = keyId;
            CryptographyClient crypto = clients.cryptographyClient(keyId);`,
    )
    .replace(
      "        CryptographyAsyncClient crypto = clients.cryptographyAsyncClient(keyId);",
      `        String vaultKeyId = keyId;
        CryptographyAsyncClient crypto = clients.cryptographyAsyncClient(keyId);`,
    )
    .replaceAll(
      'metadata.put("vault-key-id", keyId);',
      'metadata.put("vault-key-id", vaultKeyId);',
    )
    .replace(
      "        String keyId = clients.keyClient().getKey(keyName).getId();",
      `        String keyId = clients.keyClient().getKey(keyName).getId();
        String vaultKeyId = keyId;`,
    )
    .replace(
      '.roundTrip(container, blobName + "-async", keyId, message)',
      '.roundTrip(container, blobName + "-async", vaultKeyId, message)',
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(alternate)), true, rule);
  }
});

test("connected Main helpers preserve both ordered round trips", () => {
  const alternate = golden.source
    .replace(
      "import java.nio.charset.StandardCharsets;",
      "import java.nio.charset.StandardCharsets;\nimport reactor.core.publisher.Mono;",
    )
    .replace(
      `new SyncEncryptedBlobUploader(clients.keyClient(), clients)
                .roundTrip(container, blobName, keyName, message)`,
      "runSync(clients, container, blobName, keyName, message)",
    )
    .replace(
      `new AsyncEncryptedBlobUploader(clients)
                .roundTrip(container, blobName + "-async", keyId, message)
                .block()`,
      'runAsync(clients, container, blobName + "-async", keyId, message).block()',
    )
    .replace(
      "    private static String require(String name) {",
      `    private static String runSync(AzureClients clients, String container,
            String blobName, String keyName, byte[] message) {
        return new SyncEncryptedBlobUploader(clients.keyClient(), clients)
                .roundTrip(container, blobName, keyName, message);
    }

    private static Mono<String> runAsync(AzureClients clients, String container,
            String blobName, String keyId, byte[] message) {
        return new AsyncEncryptedBlobUploader(clients)
                .roundTrip(container, blobName, keyId, message);
    }

    private static String require(String name) {`,
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(alternate)), true, rule);
  }
});

test("all scenario graders reject a workspace without generated Java source", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, {
      sourceFiles: [],
      buildFiles: ["pom.xml"],
      source: "",
      build: golden.build,
    }), false, rule);
  }
});

test("all scenario graders reject Java source from generated or staged paths", () => {
  for (const sourceFile of [
    "target/generated-sources/Decoy.java",
    ".vally/staged/Decoy.java",
  ]) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, {
        ...golden,
        sourceFiles: [sourceFile],
      }), false, `${rule}: ${sourceFile}`);
    }
  }
});
