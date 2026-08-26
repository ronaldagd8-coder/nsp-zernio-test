import { timingSafeEqual } from "node:crypto";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(String(receivedSecret));
  const expected = Buffer.from(String(expectedSecret));

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isRelevantKey(key) {
  return /^(message|messageText|text|body|content|contact|contactId|conversation|conversationId|transcript|voice|voiceTranscript|audio|phone|identifier|platformIdentifier|displayIdentifier)$/i.test(
    key,
  );
}

function isSensitiveKey(key) {
  return /(secret|token|authorization|password|api.?key)/i.test(key);
}

function safeValue(value) {
  if (typeof value === "string") {
    return value.slice(0, 200);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return null;
}

function findRelevantValues(
  value,
  currentPath = "body",
  depth = 0,
  findings = [],
) {
  if (depth > 7 || findings.length >= 15) {
    return findings;
  }

  if (!isObject(value)) {
    return findings;
  }

  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => {
      findRelevantValues(
        item,
        `${currentPath}[${index}]`,
        depth + 1,
        findings,
      );
    });

    return findings;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;

    const nextPath = `${currentPath}.${key}`;

    if (!isObject(nestedValue) && isRelevantKey(key)) {
      const cleanedValue = safeValue(nestedValue);

      if (cleanedValue !== null && cleanedValue !== "") {
        findings.push({
          path: nextPath,
          value: cleanedValue,
        });
      }
    }

    if (isObject(nestedValue)) {
      findRelevantValues(
        nestedValue,
        nextPath,
        depth + 1,
        findings,
      );
    }

    if (findings.length >= 15) break;
  }

  return findings;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");

    return response.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const receivedSecret =
    request.headers["x-webhook-secret"] ??
    request.body?.webhookSecret ??
    request.query?.secret;

  if (
    !secretsMatch(
      receivedSecret,
      process.env.INTERNAL_WEBHOOK_SECRET,
    )
  ) {
    return response.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  const body =
    isObject(request.body) && !Array.isArray(request.body)
      ? request.body
      : {};

  return response.status(200).json({
    ok: true,
    findings: findRelevantValues(body),
    variableKeys:
      body.variables && isObject(body.variables)
        ? Object.keys(body.variables).slice(0, 20)
        : [],
    contactKeys:
      body.contact && isObject(body.contact)
        ? Object.keys(body.contact).slice(0, 20)
        : [],
  });
}
