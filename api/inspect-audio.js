import { timingSafeEqual } from "node:crypto";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

function safeUrlDetails(value) {
  try {
    const parsedUrl = new URL(value);

    return {
      origin: parsedUrl.origin,
      pathname: parsedUrl.pathname,
    };
  } catch {
    return {
      valueType: "string",
      length: String(value).length,
    };
  }
}

function inspectPayload(value, path = "body", depth = 0, findings = []) {
  if (depth > 10 || findings.length >= 100) {
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      inspectPayload(
        item,
        `${path}[${index}]`,
        depth + 1,
        findings,
      );
    });

    return findings;
  }

  if (!value || typeof value !== "object") {
    return findings;
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (findings.length >= 100) break;

    const childPath = `${path}.${key}`;
    const normalizedKey = key.toLowerCase();

    const isRelevantKey =
      normalizedKey.includes("attachment") ||
      normalizedKey.includes("audio") ||
      normalizedKey.includes("media") ||
      normalizedKey.includes("mime") ||
      normalizedKey === "accountid" ||
      normalizedKey === "messageid";

    if (isRelevantKey) {
      if (Array.isArray(childValue)) {
        findings.push({
          path: childPath,
          valueType: "array",
          itemCount: childValue.length,
        });
      } else if (childValue && typeof childValue === "object") {
        findings.push({
          path: childPath,
          valueType: "object",
          keys: Object.keys(childValue).slice(0, 30),
        });
      } else if (typeof childValue === "string") {
        findings.push({
          path: childPath,
          valueType: "string",
          value: childValue.slice(0, 300),
        });
      } else {
        findings.push({
          path: childPath,
          valueType: typeof childValue,
        });
      }
    }

    const pathSuggestsMedia =
      childPath.toLowerCase().includes("attachment") ||
      childPath.toLowerCase().includes("audio") ||
      childPath.toLowerCase().includes("media");

    if (
      pathSuggestsMedia &&
      ["id", "type", "mimetype", "filename"].includes(normalizedKey) &&
      typeof childValue === "string"
    ) {
      findings.push({
        path: childPath,
        valueType: "string",
        value: childValue.slice(0, 300),
      });
    }

    if (
      pathSuggestsMedia &&
      normalizedKey === "url" &&
      typeof childValue === "string"
    ) {
      findings.push({
        path: childPath,
        valueType: "url",
        ...safeUrlDetails(childValue),
      });
    }

    if (childValue && typeof childValue === "object") {
      inspectPayload(
        childValue,
        childPath,
        depth + 1,
        findings,
      );
    }
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
    request.body && typeof request.body === "object"
      ? request.body
      : {};

  const findings = inspectPayload(body);

    const prioritizedFindings = findings.sort((a, b) => {
    const score = (item) => {
      const path = String(item.path ?? "").toLowerCase();

      if (path.includes("attachment")) return 1;
      if (path.includes("audio")) return 2;
      if (path.includes("media")) return 3;
      if (path.includes("accountid")) return 4;

      return 5;
    };

    return score(a) - score(b);
  });

  const compactResult = prioritizedFindings
    .slice(0, 15)
    .map((item) => {
      const detail =
        item.value ??
        item.pathname ??
        item.keys?.join(",") ??
        item.itemCount ??
        item.valueType ??
        "found";

      return `${item.path}=${detail}`;
    })
    .join(" | ");

  return response
    .status(200)
    .setHeader("Content-Type", "text/plain")
    .send(compactResult || "NO_AUDIO_OR_MEDIA_FIELDS_FOUND");
