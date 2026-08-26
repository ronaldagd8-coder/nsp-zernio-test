import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) {
    return false;
  }

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
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

function extractAccounts(data) {
  const candidates = [
    data?.accounts,
    data?.data?.accounts,
    data?.data,
    data?.items,
  ];

  return (
    candidates.find((candidate) =>
      Array.isArray(candidate),
    ) ?? []
  );
}

async function resolveWhatsAppAccountId() {
  const accountsResponse = await fetch(
    `${ZERNIO_API_BASE_URL}/accounts?platform=whatsapp`,
    {
      headers: {
        Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
        Accept: "application/json",
      },
    },
  );

  if (!accountsResponse.ok) {
    return null;
  }

  const accountsData = await accountsResponse.json();
  const accounts = extractAccounts(accountsData);

  const whatsappAccounts = accounts.filter(
    (account) =>
      String(account?.platform ?? "").toLowerCase() ===
      "whatsapp",
  );

  const preferredAccount =
    whatsappAccounts.find((account) =>
      ["active", "live", "connected"].includes(
        String(account?.status ?? "").toLowerCase(),
      ),
    ) ??
    whatsappAccounts[0] ??
    null;

  return (
    preferredAccount?.id ??
    preferredAccount?._id ??
    preferredAccount?.accountId ??
    null
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

  if (!process.env.ZERNIO_API_KEY) {
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
    });
  }

  try {
    const accountId =
      await resolveWhatsAppAccountId();

    if (!accountId) {
      return response.status(502).json({
        zernioError:
          "No connected WhatsApp account was found",
      });
    }

    const messagesUrl =
      `${ZERNIO_API_BASE_URL}/inbox/conversations/` +
      `${encodeURIComponent(conversationId.trim())}/messages` +
      `?accountId=${encodeURIComponent(accountId)}` +
      `&sortOrder=desc&limit=1`;

    const messagesResponse = await fetch(
      messagesUrl,
      {
        headers: {
          Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
          Accept: "application/json",
        },
      },
    );

    const responseText =
      await messagesResponse.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }

    if (!messagesResponse.ok) {
      return response.status(502).json({
        zernioError:
          typeof data?.error === "string"
            ? data.error.slice(0, 300)
            : "Latest-message lookup failed",
        code:
          typeof data?.code === "string"
            ? data.code.slice(0, 100)
            : null,
        param:
          typeof data?.param === "string"
            ? data.param.slice(0, 100)
            : null,
      });
    }

    const messages = extractMessages(data);
    const latestMessage = messages[0] ?? null;

    if (!latestMessage) {
      return response.status(404).json({
        ok: false,
        error: "No message was returned",
      });
    }

    const attachments = Array.isArray(
      latestMessage?.attachments,
    )
      ? latestMessage.attachments
      : [];

    const firstAttachment =
      attachments[0] ?? null;

    return response.status(200).json({
      ok: true,
      attachmentCount: attachments.length,
      attachmentType:
        firstAttachment?.type ?? null,
      mimeType:
        firstAttachment?.mimeType ??
        firstAttachment?.mimetype ??
        null,
      hasMediaId: Boolean(
        firstAttachment?.payload?.id ??
        firstAttachment?.mediaId ??
        firstAttachment?.id,
      ),
      mediaId:
        firstAttachment?.payload?.id ??
        firstAttachment?.mediaId ??
        firstAttachment?.id ??
        null,
    });
  } catch (error) {
    console.error(
      "Unexpected latest-message lookup error",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );

    return response.status(502).json({
      ok: false,
      error: "Latest-message lookup failed",
    });
  }
}
