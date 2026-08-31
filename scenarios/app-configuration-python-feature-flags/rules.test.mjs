import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  loadFeatureFlagsWorkspace,
  ruleNames,
} from "./tools/feature-flags-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const goldenWorkspace = loadFeatureFlagsWorkspace(goldenPath);
const languageWorkspace = loadPythonWorkspace(goldenPath);
const evalSpec = readFileSync(
  fileURLToPath(new URL("./eval.yaml", import.meta.url)),
  "utf8",
);
const dependencies = goldenWorkspace.dependencies.replaceAll("\r\n", "\n");
const languageChecks = [
  "language/correct-imports",
  "language/default-azure-credential",
  "language/client-lifecycle",
  "language/async-client",
  "language/exception-handling",
];

function replaceDocument(path, from, to) {
  return {
    ...goldenWorkspace,
    documents: goldenWorkspace.documents.map((document) => ({
      ...document,
      source:
        document.path === path
          ? document.source.replaceAll("\r\n", "\n").replace(from, to)
          : document.source.replaceAll("\r\n", "\n"),
    })),
  };
}

function addDocument(path, source) {
  return {
    ...goldenWorkspace,
    documents: [...goldenWorkspace.documents, { path, source }],
  };
}

function replaceAllDocument(path, from, to, workspace = goldenWorkspace) {
  return {
    ...workspace,
    documents: workspace.documents.map((document) => ({
      ...document,
      source:
        document.path === path
          ? document.source.replaceAll("\r\n", "\n").replaceAll(from, to)
          : document.source.replaceAll("\r\n", "\n"),
    })),
  };
}

function sourceWorkspace(source, manifest = dependencies) {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename: "requirements.txt" }],
    documents: [{ path: "main.py", source }],
    applicationRoots: ["main.py"],
  };
}

function manifestsWorkspace(manifests) {
  return {
    ...sourceWorkspace("print('application')\n", ""),
    dependencyManifests: manifests,
  };
}

test("golden passes every prompt rule and shared Python check", () => {
  assert.equal(
    dependencies,
    "azure-appconfiguration==1.9.0\nazure-identity==1.25.3\n",
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
  for (const check of languageChecks) {
    assert.equal(evaluatePythonCheck(check, languageWorkspace), true, check);
  }
});

test("pins are exact and comments cannot provide them", () => {
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "print('application')\n",
        "azure-appconfiguration==1.9.1\nazure-identity==1.25.3\n",
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "print('application')\n",
        `azure-appconfiguration==1.9.0; python_version is python_version
azure-identity==1.25.3
`,
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "print('application')\n",
        "# azure-appconfiguration==1.9.0\n# azure-identity==1.25.3\n",
      ),
    ),
    false,
  );
});

test("pins must be coherent and conflict-free within one active manifest", () => {
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      manifestsWorkspace([
        {
          filename: "requirements.txt",
          content: `${dependencies}azure-identity==1.25.2\n`,
        },
      ]),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      manifestsWorkspace([
        {
          filename: "requirements.txt",
          content: "azure-appconfiguration==1.9.0\n",
        },
        {
          filename: "requirements-prod.txt",
          content: "azure-identity==1.25.3\n",
        },
      ]),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      manifestsWorkspace([
        { filename: "requirements.txt", content: dependencies },
        {
          filename: "pyproject.toml",
          content: `[project]
dependencies = ["azure-identity==1.25.2"]
`,
        },
      ]),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      manifestsWorkspace([
        {
          filename: "pyproject.toml",
          content: `[project]
dependencies = [
  "azure-appconfiguration==1.9.0",
  "azure-identity==1.25.3",
]
`,
        },
      ]),
    ),
    true,
  );
});

test("inactive and ambiguous dependency markers cannot provide pins", () => {
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "print('application')\n",
        `azure-appconfiguration==1.9.0; python_version < "0"
azure-identity==1.25.3
`,
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "print('application')\n",
        `azure-appconfiguration==1.9.0; deployment_target == "production"
azure-identity==1.25.3
`,
      ),
    ),
    false,
  );
});

test("active and unmarked dependency pins remain valid", () => {
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "print('application')\n",
        `azure-appconfiguration==1.9.0; python_version >= "3.0"
azure-identity==1.25.3
`,
      ),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "print('application')\n",
        `${dependencies}azure-identity==1.25.2; python_version < "0"
`,
      ),
    ),
    true,
  );
});

test("the Python stimulus states every exact package pin required by grading", () => {
  assert.match(evalSpec, /`azure-appconfiguration` to `1\.9\.0`/);
  assert.match(evalSpec, /`azure-identity` to `1\.25\.3`/);
});

test("comments, strings, and lookalike SDK classes cannot satisfy behavior", () => {
  const fake = sourceWorkspace(`
import json
notes = """
AzureAppConfigurationClient(base_url=endpoint, credential=credential)
client.get_configuration_setting(key=".appconfig.featureflag/demo")
"""

class AzureAppConfigurationClient:
    def get_configuration_setting(self, **kwargs):
        return None

class DefaultAzureCredential:
    pass

client = AzureAppConfigurationClient()
`);
  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-pins")) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});

test("exact SDK names cannot be shadowed locally", () => {
  const shadowedBinding = replaceDocument(
    "main.py",
    "def run_sync_demo(endpoint: str) -> None:",
    `class AzureAppConfigurationClient:
    def __init__(self, *args, **kwargs):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def get_configuration_setting(self, **kwargs):
        return None
    def list_configuration_settings(self, **kwargs):
        return []

def run_sync_demo(endpoint: str) -> None:`,
  );
  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-pins")) {
    assert.equal(evaluateRule(rule, shadowedBinding), false, rule);
  }

  const shadowedPackage = addDocument(
    "azure/appconfiguration.py",
    "class AzureAppConfigurationClient:\n    pass\n",
  );
  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-pins")) {
    assert.equal(evaluateRule(rule, shadowedPackage), false, rule);
  }
});

test("unreachable and disconnected operations do not score", () => {
  const unreachable = sourceWorkspace(`
from azure.appconfiguration import AzureAppConfigurationClient
from azure.identity import DefaultAzureCredential

def decoy():
    credential = DefaultAzureCredential()
    client = AzureAppConfigurationClient(base_url=endpoint, credential=credential)
    client.get_configuration_setting(key="app:key")

if False:
    decoy()
`);
  assert.equal(
    evaluateRule("prompt/secure-sync-async-clients", unreachable),
    false,
  );
  assert.equal(evaluateRule("prompt/configuration-reads", unreachable), false);

  const disconnectedRollout = replaceDocument(
    "feature_flags.py",
    "else deterministic_percentage(flag_id, user_id, percentage)",
    "else True",
  );
  disconnectedRollout.documents = disconnectedRollout.documents.map((document) =>
    document.path === "main.py"
      ? {
          ...document,
          source: `${document.source}
from feature_flags import deterministic_percentage
deterministic_percentage("decoy", "decoy-user", 50)
`,
        }
      : document,
  );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-percentage-rollout",
      disconnectedRollout,
    ),
    false,
  );

  const deadRefresh = replaceDocument(
    "watcher.py",
    "                    self._service.refresh_all()",
    `                    if False:
                        self._service.refresh_all()`,
  );
  assert.equal(evaluateRule("prompt/sentinel-refresh", deadRefresh), false);
});

test("conditional cache preserves 304 and replaces changed values", () => {
  const swallowedFailure = replaceDocument(
    "configuration.py",
    `            if error.status_code == 304:
                return cached
            raise`,
    `            if error.status_code == 304:
                return cached`,
  );
  assert.equal(
    evaluateRule("prompt/etag-conditional-cache", swallowedFailure),
    false,
  );

  const reversed304 = replaceDocument(
    "configuration.py",
    `            if error.status_code == 304:
                return cached
            raise`,
    `            if error.status_code != 304:
                return cached
            raise`,
  );
  assert.equal(
    evaluateRule("prompt/etag-conditional-cache", reversed304),
    false,
  );

  const noReplacement = replaceDocument(
    "configuration.py",
    `        self._cache[(key, label)] = updated
        return updated`,
    "        return updated",
  );
  assert.equal(
    evaluateRule("prompt/etag-conditional-cache", noReplacement),
    false,
  );
});

test("feature flags require the reserved key, JSON, and enabled state", () => {
  const wrongPrefix = replaceDocument(
    "feature_flags.py",
    'FEATURE_FLAG_PREFIX = ".appconfig.featureflag/"',
    'FEATURE_FLAG_PREFIX = "feature/"',
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-evaluation", wrongPrefix),
    false,
  );

  const ignoredEnabled = replaceDocument(
    "feature_flags.py",
    `        if not payload.get("enabled", False):
            return False
        percentage = percentage_from_payload(payload)`,
    `        enabled = payload.get("enabled", False)
        if enabled:
            pass
        percentage = percentage_from_payload(payload)`,
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-evaluation", ignoredEnabled),
    false,
  );

  const textualEnabled = replaceDocument(
    "feature_flags.py",
    `        if not payload.get("enabled", False):
            return False
        percentage = percentage_from_payload(payload)`,
    `        instructions = "if not payload.get('enabled'): return False"
        print(instructions)
        percentage = percentage_from_payload(payload)`,
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-evaluation", textualEnabled),
    false,
  );

  let fixedRegardlessOfEnabled = replaceAllDocument(
    "feature_flags.py",
    `        if not payload.get("enabled", False):
            return False`,
    `        enabled = payload.get("enabled", False)`,
  );
  fixedRegardlessOfEnabled = replaceAllDocument(
    "feature_flags.py",
    `        return (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )`,
    `        return (
            deterministic_percentage(flag_id, user_id, 50)
            if enabled
            else deterministic_percentage(flag_id, user_id, 50)
        )`,
    fixedRegardlessOfEnabled,
  );
  assert.equal(
    evaluateRule(
      "prompt/feature-flag-evaluation",
      fixedRegardlessOfEnabled,
    ),
    false,
  );

  let meaningfulConditional = replaceAllDocument(
    "feature_flags.py",
    `        if not payload.get("enabled", False):
            return False`,
    `        enabled = payload.get("enabled", False)`,
  );
  meaningfulConditional = replaceAllDocument(
    "feature_flags.py",
    `        return (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )`,
    `        return enabled and (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )`,
    meaningfulConditional,
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-evaluation", meaningfulConditional),
    true,
  );
});

test("enabled tautologies do not satisfy feature evaluation", () => {
  let tautology = replaceAllDocument(
    "feature_flags.py",
    `        if not payload.get("enabled", False):
            return False`,
    `        enabled = payload.get("enabled", False)`,
  );
  tautology = replaceAllDocument(
    "feature_flags.py",
    `        return (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )`,
    `        return (enabled or not enabled) and (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )`,
    tautology,
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-evaluation", tautology),
    false,
  );

  let enabledOrRollout = replaceAllDocument(
    "feature_flags.py",
    `        if not payload.get("enabled", False):
            return False`,
    `        enabled = payload.get("enabled", False)`,
  );
  enabledOrRollout = replaceAllDocument(
    "feature_flags.py",
    `        return (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )`,
    `        rollout_check = (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )
        return enabled or rollout_check`,
    enabledOrRollout,
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-evaluation", enabledOrRollout),
    false,
  );
});

test("enabled helper guards remain valid", () => {
  let helperGuard = replaceDocument(
    "feature_flags.py",
    'FEATURE_FLAG_PREFIX = ".appconfig.featureflag/"',
    `FEATURE_FLAG_PREFIX = ".appconfig.featureflag/"


def flag_is_active(payload):
    return bool(payload.get("enabled", False))`,
  );
  helperGuard = replaceAllDocument(
    "feature_flags.py",
    `        if not payload.get("enabled", False):
            return False`,
    `        if not flag_is_active(payload):
            return False`,
    helperGuard,
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-evaluation", helperGuard),
    true,
  );
});

test("configuration prefix reads must return dictionaries", () => {
  const listResults = {
    ...goldenWorkspace,
    documents: goldenWorkspace.documents.map((document) => ({
      ...document,
      source:
        document.path === "configuration.py"
          ? document.source
              .replace(
                `        return {
            setting.key: setting.value
            for setting in self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        }`,
                `        return list(
            self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        )`,
              )
              .replace(
                "        return {setting.key: setting.value async for setting in settings}",
                "        return [setting async for setting in settings]",
              )
              .replaceAll(
                "        return {setting.key: setting.value for setting in settings}",
                "        return list(settings)",
              )
          : document.source,
    })),
  };
  assert.equal(
    evaluateRule("prompt/configuration-reads", listResults),
    false,
  );

  const iteratorResults = {
    ...goldenWorkspace,
    documents: goldenWorkspace.documents.map((document) => ({
      ...document,
      source:
        document.path === "configuration.py"
          ? document.source
              .replace(
                `        return {
            setting.key: setting.value
            for setting in self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        }`,
                `        return iter(
            self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        )`,
              )
              .replace(
                "        return {setting.key: setting.value async for setting in settings}",
                "        return settings",
              )
              .replaceAll(
                "        return {setting.key: setting.value for setting in settings}",
                "        return iter(settings)",
              )
          : document.source,
    })),
  };
  assert.equal(
    evaluateRule("prompt/configuration-reads", iteratorResults),
    false,
  );

  const constructorResults = {
    ...goldenWorkspace,
    documents: goldenWorkspace.documents.map((document) => ({
      ...document,
      source:
        document.path === "configuration.py"
          ? document.source
              .replace(
                `        return {
            setting.key: setting.value
            for setting in self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        }`,
                `        return dict(
            (setting.key, setting.value)
            for setting in self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        )`,
              )
              .replace(
                "        return {setting.key: setting.value async for setting in settings}",
                "        return dict([(setting.key, setting.value) async for setting in settings])",
              )
              .replaceAll(
                "        return {setting.key: setting.value for setting in settings}",
                "        return dict((setting.key, setting.value) for setting in settings)",
              )
          : document.source,
    })),
  };
  assert.equal(
    evaluateRule("prompt/configuration-reads", constructorResults),
    true,
  );
});

test("discarded helper dictionaries do not satisfy prefix result contract", () => {
  let discarded = replaceDocument(
    "configuration.py",
    "class SyncConfigurationService:",
    `def discard_prefix_dictionary(settings):
    return {setting.key: setting.value for setting in settings}


async def discard_async_prefix_dictionary(settings):
    return {setting.key: setting.value async for setting in settings}


class SyncConfigurationService:`,
  );
  discarded = replaceAllDocument(
    "configuration.py",
    `        return {
            setting.key: setting.value
            for setting in self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        }`,
    `        settings = self._client.list_configuration_settings(
            key_filter=f"{prefix}*"
        )
        discard_prefix_dictionary(settings)
        return list(settings)`,
    discarded,
  );
  discarded = replaceAllDocument(
    "configuration.py",
    `        settings = self._client.list_configuration_settings(
            key_filter=f"{prefix}*"
        )
        return {setting.key: setting.value async for setting in settings}`,
    `        settings = self._client.list_configuration_settings(
            key_filter=f"{prefix}*"
        )
        await discard_async_prefix_dictionary(settings)
        return settings`,
    discarded,
  );
  assert.equal(
    evaluateRule("prompt/configuration-reads", discarded),
    false,
  );
});

test("returned helper dictionaries remain valid prefix results", () => {
  let helperResult = replaceDocument(
    "configuration.py",
    "class SyncConfigurationService:",
    `def prefix_dictionary(settings):
    return {setting.key: setting.value for setting in settings}


async def async_prefix_dictionary(settings):
    return {setting.key: setting.value async for setting in settings}


class SyncConfigurationService:`,
  );
  helperResult = replaceAllDocument(
    "configuration.py",
    `        return {
            setting.key: setting.value
            for setting in self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        }`,
    `        return prefix_dictionary(
            self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        )`,
    helperResult,
  );
  helperResult = replaceAllDocument(
    "configuration.py",
    `        settings = self._client.list_configuration_settings(
            key_filter=f"{prefix}*"
        )
        return {setting.key: setting.value async for setting in settings}`,
    `        settings = self._client.list_configuration_settings(
            key_filter=f"{prefix}*"
        )
        return await async_prefix_dictionary(settings)`,
    helperResult,
  );
  assert.equal(
    evaluateRule("prompt/configuration-reads", helperResult),
    true,
  );
});

test("rollout hashing depends on both the flag and user", () => {
  const constantDigest = replaceDocument(
    "feature_flags.py",
    'digest = hashlib.sha256(f"{flag_id}:{user_id}".encode()).digest()',
    'digest = hashlib.sha256(b"constant").digest()',
  );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-percentage-rollout",
      constantDigest,
    ),
    false,
  );

  const userIndependent = replaceDocument(
    "feature_flags.py",
    'digest = hashlib.sha256(f"{flag_id}:{user_id}".encode()).digest()',
    "digest = hashlib.sha256(flag_id.encode()).digest()",
  );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-percentage-rollout",
      userIndependent,
    ),
    false,
  );

  const flagIndependent = replaceDocument(
    "feature_flags.py",
    'digest = hashlib.sha256(f"{flag_id}:{user_id}".encode()).digest()',
    "digest = hashlib.sha256(user_id.encode()).digest()",
  );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-percentage-rollout",
      flagIndependent,
    ),
    false,
  );

  const builtinHash = replaceDocument(
    "feature_flags.py",
    `    digest = hashlib.sha256(f"{flag_id}:{user_id}".encode()).digest()
    bucket = int.from_bytes(digest[:8], "big") % 100`,
    '    bucket = hash(f"{flag_id}:{user_id}") % 100',
  );
  assert.equal(
    evaluateRule("prompt/deterministic-percentage-rollout", builtinHash),
    false,
  );

  const randomRollout = replaceDocument(
    "feature_flags.py",
    `import hashlib
import json`,
    `import hashlib
import json
import random`,
  );
  const randomBucket = {
    ...randomRollout,
    documents: randomRollout.documents.map((document) => ({
      ...document,
      source:
        document.path === "feature_flags.py"
          ? document.source.replace(
              `    digest = hashlib.sha256(f"{flag_id}:{user_id}".encode()).digest()
    bucket = int.from_bytes(digest[:8], "big") % 100`,
              "    bucket = int(random.random() * 100)",
            )
          : document.source,
    })),
  };
  assert.equal(
    evaluateRule(
      "prompt/deterministic-percentage-rollout",
      randomBucket,
    ),
    false,
  );
});

test("sentinel polling needs interval sleeping and connected full refresh", () => {
  const noRefresh = replaceDocument(
    "watcher.py",
    "                    self._service.refresh_all()",
    "                    print('changed')",
  );
  assert.equal(evaluateRule("prompt/sentinel-refresh", noRefresh), false);

  const noInterval = replaceDocument(
    "watcher.py",
    "            time.sleep(interval)",
    "            pass",
  );
  assert.equal(evaluateRule("prompt/sentinel-refresh", noInterval), false);

  const clearsWithoutRepopulation = replaceDocument(
    "configuration.py",
    `        self._cache = {
            (setting.key, setting.label): setting for setting in settings
        }`,
    "        self._cache.clear()",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", clearsWithoutRepopulation),
    false,
  );

  const partialRefresh = replaceDocument(
    "configuration.py",
    'self._client.list_configuration_settings(key_filter=f"{prefix}*")',
    'self._client.list_configuration_settings(key_filter="app:*")',
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", partialRefresh),
    false,
  );
});

test("sync and async demos cannot be assembled from incompatible paths", () => {
  const incompatible = replaceDocument(
    "main.py",
    `    run_sync_demo(endpoint)
    asyncio.run(run_async_demo(endpoint))`,
    `    if os.getenv("USE_SYNC"):
        run_sync_demo(endpoint)
    else:
        asyncio.run(run_async_demo(endpoint))`,
  );
  assert.equal(
    evaluateRule("prompt/connected-sync-then-async-demo", incompatible),
    false,
  );
});

test("aliases, positional clients, getenv, helpers, and SHA-1 are accepted", () => {
  const alternate = sourceWorkspace(`
import asyncio
import hashlib
import json
import os
import time
from azure.appconfiguration import AzureAppConfigurationClient as SyncClient
from azure.appconfiguration.aio import AzureAppConfigurationClient as AsyncClient
from azure.core import MatchConditions as Conditions
from azure.core.exceptions import HttpResponseError as ResponseError
from azure.identity import DefaultAzureCredential as SyncCredential
from azure.identity.aio import DefaultAzureCredential as AsyncCredential

def stable(flag_id, user_id, percentage):
    digest = hashlib.sha1((flag_id + ":" + user_id).encode()).digest()
    return int.from_bytes(digest, "big") % 100 < percentage

def decode(setting):
    return json.loads(setting.value)

def rollout_percentage(payload):
    filters = payload.get("conditions", {}).get("client_filters", [])
    for candidate in filters:
        if candidate.get("name") == "Microsoft.Percentage":
            return float(candidate.get("parameters", {}).get("Value", 0))
    return None

def different(before, after):
    return before.etag != after.etag or before.value != after.value

def pause(seconds):
    time.sleep(seconds)

async def pause_async(seconds):
    await asyncio.sleep(seconds)

def unchanged(error):
    return error.status_code == 304

class SyncService:
    def __init__(self, client):
        self.client = client
        self.cache = {}
    def get(self, key):
        setting = self.client.get_configuration_setting(key)
        self.cache[(key, None)] = setting
        return setting
    def labeled(self, key, label):
        setting = self.client.get_configuration_setting(key, label)
        self.cache[(key, label)] = setting
        return setting
    def prefix(self, prefix):
        return {
            setting.key: setting.value
            for setting in self.client.list_configuration_settings(
                key_filter=prefix + "*"
            )
        }
    def remember(self, key, setting):
        self.cache[(key, None)] = setting
    def scan(self):
        return list(self.client.list_configuration_settings(key_filter="*"))
    def changed(self, key):
        cached = self.cache.get((key, None))
        try:
            updated = self.client.get_configuration_setting(
                key, etag=cached.etag, match_condition=Conditions.IfModified
            )
        except ResponseError as error:
            if unchanged(error):
                return cached
            raise
        self.remember(key, updated)
        return updated
    def refresh_all(self):
        settings = self.scan()
        self.cache = {(setting.key, setting.label): setting for setting in settings}
        return settings

class AsyncService:
    def __init__(self, client):
        self.client = client
        self.cache = {}
    async def get(self, key):
        setting = await self.client.get_configuration_setting(key)
        self.cache[(key, None)] = setting
        return setting
    async def labeled(self, key, label):
        setting = await self.client.get_configuration_setting(key, label)
        self.cache[(key, label)] = setting
        return setting
    async def prefix(self, prefix):
        results = self.client.list_configuration_settings(
            key_filter=prefix + "*"
        )
        return {setting.key: setting.value async for setting in results}
    def remember(self, key, setting):
        self.cache[(key, None)] = setting
    async def scan(self):
        results = self.client.list_configuration_settings(key_filter="*")
        return [setting async for setting in results]
    async def changed(self, key):
        cached = self.cache.get((key, None))
        try:
            updated = await self.client.get_configuration_setting(
                key, etag=cached.etag, match_condition=Conditions.IfModified
            )
        except ResponseError as error:
            if not unchanged(error):
                raise
            return cached
        self.remember(key, updated)
        return updated
    async def refresh_all(self):
        settings = await self.scan()
        self.cache = {(setting.key, setting.label): setting for setting in settings}
        return settings

class SyncWatch:
    def __init__(self, service):
        self.service = service
    def watch(self, sentinels, interval):
        for sentinel in sentinels:
            before = self.service.get(sentinel)
            after = self.service.changed(sentinel)
            if different(before, after):
                self.service.refresh_all()
        pause(interval)

class AsyncWatch:
    def __init__(self, service):
        self.service = service
    async def watch(self, sentinels, interval):
        for sentinel in sentinels:
            before = await self.service.get(sentinel)
            after = await self.service.changed(sentinel)
            if different(before, after):
                await self.service.refresh_all()
        await pause_async(interval)

def sync_flag(client, flag_id, user_id):
    setting = client.get_configuration_setting(
        key=".appconfig.featureflag/" + flag_id
    )
    payload = decode(setting)
    if not payload.get("enabled"):
        return False
    percentage = rollout_percentage(payload)
    return True if percentage is None else stable(flag_id, user_id, percentage)

async def async_flag(client, flag_id, user_id):
    setting = await client.get_configuration_setting(
        key=".appconfig.featureflag/" + flag_id
    )
    payload = decode(setting)
    if not payload.get("enabled"):
        return False
    percentage = rollout_percentage(payload)
    return True if percentage is None else stable(flag_id, user_id, percentage)

def sync_demo(endpoint):
    credential = SyncCredential()
    with SyncClient(endpoint, credential) as client:
        service = SyncService(client)
        service.get("app:key")
        service.labeled("app:key", "production")
        service.prefix("app:")
        sync_flag(client, "beta", "user")
        SyncWatch(service).watch(["sentinel"], 1)

async def async_demo(endpoint):
    credential = AsyncCredential()
    async with AsyncClient(endpoint, credential) as client:
        service = AsyncService(client)
        await service.get("app:key")
        await service.labeled("app:key", "production")
        await service.prefix("app:")
        await async_flag(client, "beta", "user")
        await AsyncWatch(service).watch(["sentinel"], 1)

def main():
    endpoint = os.getenv("AZURE_APPCONFIGURATION_ENDPOINT")
    sync_demo(endpoint)
    asyncio.run(async_demo(endpoint))

main()
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});
