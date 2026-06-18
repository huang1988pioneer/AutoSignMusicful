import crypto from "node:crypto";

const maxAccounts = Number.parseInt(process.env.MUSICFUL_MAX_ACCOUNTS || "33", 10);
const secretPrefix = process.env.MUSICFUL_SECRET_PREFIX || "MUSICFUL_STORAGE_STATE_BASE64";
const includeFirstAlias = process.env.MUSICFUL_INCLUDE_FIRST_ALIAS !== "false";
const minimumTokenLength = Number.parseInt(process.env.MUSICFUL_MIN_TOKEN_LENGTH || "24", 10);

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shortHash(value) {
  return hashValue(value).slice(0, 12);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function secretName(index) {
  return `${secretPrefix}_${index}`;
}

function configuredSecrets() {
  const byName = new Map();

  if (includeFirstAlias && process.env[secretPrefix]) {
    byName.set(secretName(1), process.env[secretPrefix]);
  }

  for (let index = 1; index <= maxAccounts; index += 1) {
    const name = secretName(index);
    const value = process.env[name];
    if (value) {
      byName.set(name, value);
    }
  }

  return [...byName.entries()].map(([name, value]) => ({ name, value }));
}

function remember(grouped, key, entry) {
  if (!key) return;
  if (!grouped.has(key)) {
    grouped.set(key, []);
  }
  grouped.get(key).push(entry);
}

function findDuplicates(grouped) {
  return [...grouped.values()].filter((entries) => new Set(entries.map((entry) => entry.name)).size > 1);
}

function decodeStorageState(secret) {
  try {
    const decoded = Buffer.from(secret.value, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error(`${secret.name} is not valid base64 JSON storage state: ${error.message}`);
  }
}

function isLikelyAuthKey(key) {
  return /(access|auth|bearer|credential|jwt|login|refresh|session|sid|token)/i.test(key)
    && !/(_ga|_gcl|_uet|analytics|amplitude|clarity|facebook|fbp|fingerprint|intercom|mixpanel|tracking)/i.test(key);
}

function isLikelyTokenValue(value) {
  return typeof value === "string"
    && value.length >= minimumTokenLength
    && /[A-Za-z0-9]/.test(value);
}

function collectAuthLikeValues(value, owner, path = [], output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAuthLikeValues(item, owner, [...path, String(index)], output));
    return output;
  }

  if (!value || typeof value !== "object") {
    return output;
  }

  if (isLikelyAuthKey(value.name || "") && isLikelyTokenValue(value.value)) {
    output.push({
      name: owner,
      path: [...path, value.name].join("."),
      value: value.value
    });
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isLikelyAuthKey(key) && isLikelyTokenValue(child)) {
      output.push({
        name: owner,
        path: nextPath.join("."),
        value: child
      });
    }
    collectAuthLikeValues(child, owner, nextPath, output);
  }

  return output;
}

function printDuplicateGroup(title, groups, describeEntry) {
  if (groups.length === 0) return;

  console.error(`\n${title}`);
  for (const entries of groups) {
    console.error(`- ${describeEntry(entries[0])}`);
    for (const entry of entries) {
      console.error(`  - ${entry.name}${entry.path ? ` (${entry.path})` : ""}`);
    }
  }
}

function main() {
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1) {
    throw new Error(`Invalid MUSICFUL_MAX_ACCOUNTS: ${process.env.MUSICFUL_MAX_ACCOUNTS}`);
  }

  const secrets = configuredSecrets();
  console.log(`Checking ${secrets.length} configured ${secretPrefix}_* secret(s).`);

  const rawSecretHashes = new Map();
  const storageStateHashes = new Map();
  const authLikeHashes = new Map();

  for (const secret of secrets) {
    remember(rawSecretHashes, hashValue(secret.value), {
      name: secret.name,
      hash: shortHash(secret.value)
    });

    const storageState = decodeStorageState(secret);
    const canonicalStorageState = stableStringify(storageState);
    remember(storageStateHashes, hashValue(canonicalStorageState), {
      name: secret.name,
      hash: shortHash(canonicalStorageState)
    });

    for (const authValue of collectAuthLikeValues(storageState, secret.name)) {
      remember(authLikeHashes, hashValue(authValue.value), {
        name: authValue.name,
        path: authValue.path,
        hash: shortHash(authValue.value)
      });
    }
  }

  const rawDuplicates = findDuplicates(rawSecretHashes);
  const stateDuplicates = findDuplicates(storageStateHashes);
  const authDuplicates = findDuplicates(authLikeHashes);

  printDuplicateGroup("Duplicate exact secret values:", rawDuplicates, (entry) => `secret hash ${entry.hash}`);
  printDuplicateGroup("Duplicate decoded storage states:", stateDuplicates, (entry) => `state hash ${entry.hash}`);
  printDuplicateGroup("Duplicate auth/session/token-like values:", authDuplicates, (entry) => `token hash ${entry.hash}`);

  const duplicateCount = rawDuplicates.length + stateDuplicates.length + authDuplicates.length;
  if (duplicateCount > 0) {
    throw new Error(`Found ${duplicateCount} duplicate secret/token group(s).`);
  }

  console.log("No duplicate Musicful secrets or token-like values found.");
}

try {
  main();
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
