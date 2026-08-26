import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

function safeUrlPath(value) {
  if (typeof value !== "string") return null;

  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
}

function extractMessages(data) {
  const candidates = [
    data?.messages,
    data?.data?.messages,
    data?.data,
    data?.items,
  ];

  return (
    candidates.find((candidate) =>
      Array.isArray(candidate),
    ) ?? []
  );
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

  if (
    !process.env.ZERNIO_API_KEY ||
    !process.env.ZERNIO_WHATSAPP_ACCOUNT_ID
  ) {
    return response.status(500).json({
      ok: false,
      error: "Server configuration error",
    });
  }

  const conversationId =
    request.body?.conversationId ??
    request.body?.event?.conversationId ??
    request.body?.variables?.conversationId ??
    request.body?.vars?.conversationId;

  if (
    typeof conversationId !== "string" ||
    !conversationId.trim()
  ) {
    return response.status(400).json({
      ok: false,
      error: "A valid conversationId is required",
      topLevelKeys:
        request.body && typeof request.body === "object"
          ? Object.keys(request.body).slice(0, 20)
          : [],
    });
  }

  try {
    const accountId =
      process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;

    const messagesResponse = await fetch(
      `${ZERNIO_API_BASE_URL}/inbox/conversations/${encodeURIComponent(
        conversationId.trim(),
      )}/messages?accountId=${encodeURIComponent(
        accountId,
      )}&sortOrder=desc&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
          Accept: "application/json",
        },
      },
    );

    const responseText = await messagesResponse.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }

        if (!messagesResponse.ok) {
      console.error("Zernio latest-message lookup failed", {
        status: messagesResponse.status,
        code: data?.code ?? null,
      });

      return response.status(502).json({
        ok: false,
        error: "Latest-message lookup failed",
        upstreamStatus: messagesResponse.status,
        upstreamError:
          typeof data?.error === "string"
            ? data.error.slice(0, 300)
            : null,
        upstreamCode:
          typeof data?.code === "string"
            ? data.code.slice(0, 100)
            : null,
        upstreamParam:
          typeof data?.param === "string"
            ? data.param.slice(0, 100)
            : null,
        upstreamPlatform:
          typeof data?.platform === "string"
            ? data.platform.slice(0, 100)
            : null,
      });
    }

    const messages = extractMessages(data);
    const latestMessage = messages[0] ?? null;

    if (!latestMessage) {
      return response.status(404).json({
        ok: false,
        error: "No message was returned",
        responseKeys:
          data && typeof data === "object"
            ? Object.keys(data).slice(0, 20)
            : [],
        dataKeys:
          data?.data && typeof data.data === "object"
            ? Object.keys(data.data).slice(0, 20)
            : [],
      });
    }

    const attachments = Array.isArray(
      latestMessage?.attachments,
    )
      ? latestMessage.attachments
      : [];

    return response.status(200).json({
      ok: true,
      messageId:
        latestMessage?.id ??
        latestMessage?.messageId ??
        latestMessage?.platformMessageId ??
        null,
      direction: latestMessage?.direction ?? null,
      type:
        latestMessage?.type ??
        latestMessage?.messageType ??
        null,
      attachmentCount: attachments.length,
      attachments: attachments.slice(0, 5).map(
        (attachment) => ({
          type: attachment?.type ?? null,
          mimeType:
            attachment?.mimeType ??
            attachment?.mimetype ??
            null,
          mediaId:
            attachment?.payload?.id ??
            attachment?.mediaId ??
            attachment?.id ??
            null,
          payloadKeys:
            attachment?.payload &&
            typeof attachment.payload === "object"
              ? Object.keys(attachment.payload).slice(0, 20)
              : [],
          urlPath: safeUrlPath(attachment?.url),
        }),
      ),
    });
  } catch (error) {
    console.error("Unexpected latest-message lookup error", {
      message:
        error instanceof Error
          ? error.message
          : "Unknown error",
    });

    return response.status(502).json({
      ok: false,
      error: "Latest-message lookup failed",
    });
  }
}
