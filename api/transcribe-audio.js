import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";
const OPENAI_TRANSCRIPTION_URL =
  "https://api.openai.com/v1/audio/transcriptions";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export const config = {
  maxDuration: 60,
};

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

function normalizeMessageCandidate(value, depth = 0) {
  if (typeof value === "string") {
    return value.trim().slice(0, 1500);
  }

  if (!value || typeof value !== "object" || depth > 7) {
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) {
      const normalized = normalizeMessageCandidate(item, depth + 1);
      if (normalized) return normalized;
    }
    return "";
  }

  const candidateKeys = [
    "body",
    "text",
    "content",
    "caption",
    "messageText",
    "message",
    "payload",
    "data",
  ];

  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const normalized = normalizeMessageCandidate(value[key], depth + 1);
    if (normalized) return normalized;
  }

  return "";
}

function getMessageText(message) {
  const candidates = [
    message?.body,
    message?.text,
    message?.content,
    message?.caption,
    message?.message?.body,
    message?.message?.text,
    message?.message?.content,
    message?.payload?.body,
    message?.payload?.text,
    message?.data?.body,
    message?.data?.text,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeMessageCandidate(candidate);
    if (normalized) return normalized;
  }

  return normalizeMessageCandidate(message);
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

async function zernioFetch(path, options = {}) {
  return fetch(`${ZERNIO_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization:
        `Bearer ${process.env.ZERNIO_API_KEY}`,
      Accept: "application/json",
      ...options.headers,
    },
  });
}

async function resolveWhatsAppAccountId() {
  const accountsResponse = await zernioFetch(
    "/accounts?platform=whatsapp",
  );

  if (!accountsResponse.ok) {
    return null;
  }

  const accountsData =
    await accountsResponse.json();

  const accounts =
    extractAccounts(accountsData);

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

function getAudioAttachment(message) {
  const attachments = Array.isArray(
    message?.attachments,
  )
    ? message.attachments
    : [];

  return (
    attachments.find((attachment) => {
      const type = String(
        attachment?.type ?? "",
      ).toLowerCase();

      const mimeType = String(
        attachment?.mimeType ??
          attachment?.mimetype ??
          "",
      ).toLowerCase();

      return (
        type === "audio" ||
        mimeType.startsWith("audio/")
      );
    }) ?? null
  );
}

function getMediaId(attachment) {
  return (
    attachment?.payload?.id ??
    attachment?.mediaId ??
    attachment?.id ??
    null
  );
}

function getAudioFilename(contentType) {
  const normalizedType =
    String(contentType ?? "").toLowerCase();

  if (normalizedType.includes("mpeg")) {
    return "voice-note.mp3";
  }

  if (normalizedType.includes("mp4")) {
    return "voice-note.m4a";
  }

  if (normalizedType.includes("wav")) {
    return "voice-note.wav";
  }

  if (normalizedType.includes("webm")) {
    return "voice-note.webm";
  }

  return "voice-note.ogg";
}

export default async function handler(
  request,
  response,
) {
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
    !process.env.OPENAI_API_KEY
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
    });
  }

  try {
    const accountId =
      await resolveWhatsAppAccountId();

    if (!accountId) {
      return response.status(502).json({
        ok: false,
        error:
          "No connected WhatsApp account was found",
      });
    }

    const messagesPath =
      `/inbox/conversations/` +
      `${encodeURIComponent(
        conversationId.trim(),
      )}/messages` +
      `?accountId=${encodeURIComponent(
        accountId,
      )}&sortOrder=desc&limit=1`;

    const messagesResponse =
      await zernioFetch(messagesPath);

    if (!messagesResponse.ok) {
      return response.status(502).json({
        ok: false,
        error: "Could not retrieve latest message",
      });
    }

    const messagesData =
      await messagesResponse.json();

    const messages =
      extractMessages(messagesData);

    const latestMessage =
      messages[0] ?? null;

    if (!latestMessage) {
      return response.status(404).json({
        ok: false,
        error: "No message was returned",
      });
    }

    const audioAttachment =
      getAudioAttachment(latestMessage);

    if (!audioAttachment) {
      return response.status(200).json({
        ok: true,
        isAudio: false,
        transcript: null,
        messageText: getMessageText(latestMessage) || null,
      });
    }

    const mediaId =
      getMediaId(audioAttachment);

    if (!mediaId) {
      return response.status(422).json({
        ok: false,
        error: "Audio media ID is missing",
      });
    }

    const mediaResponse = await zernioFetch(
      `/whatsapp/media/${encodeURIComponent(
        mediaId,
      )}?accountId=${encodeURIComponent(accountId)}`,
      {
        headers: {
          Accept:
            "audio/ogg,audio/*,application/octet-stream",
        },
      },
    );

    if (!mediaResponse.ok) {
      return response.status(502).json({
        ok: false,
        error: "Could not download voice note",
      });
    }

    const audioBuffer =
      await mediaResponse.arrayBuffer();

    if (audioBuffer.byteLength < 1) {
      return response.status(422).json({
        ok: false,
        error: "Voice note was empty",
      });
    }

    if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
      return response.status(413).json({
        ok: false,
        error: "Voice note is too large",
      });
    }

    const contentType =
      mediaResponse.headers.get("content-type") ??
      audioAttachment?.mimeType ??
      audioAttachment?.mimetype ??
      "audio/ogg";

    const formData = new FormData();

    formData.append(
      "file",
      new Blob([audioBuffer], {
        type: contentType,
      }),
      getAudioFilename(contentType),
    );

    formData.append(
      "model",
      "gpt-4o-mini-transcribe",
    );

    formData.append(
      "response_format",
      "json",
    );

    const transcriptionResponse = await fetch(
      OPENAI_TRANSCRIPTION_URL,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
      },
    );

    const transcriptionData =
      await transcriptionResponse.json();

    if (!transcriptionResponse.ok) {
      console.error(
        "OpenAI transcription failed",
        {
          status: transcriptionResponse.status,
          code:
            transcriptionData?.error?.code ??
            null,
        },
      );

      return response.status(502).json({
        ok: false,
        error: "Voice transcription failed",
      });
    }

    const transcript =
      typeof transcriptionData?.text === "string"
        ? transcriptionData.text.trim()
        : "";

    if (!transcript) {
      return response.status(422).json({
        ok: false,
        error:
          "No speech was detected in the voice note",
      });
    }

    return response.status(200).json({
      ok: true,
      isAudio: true,
      transcript,
    });
  } catch (error) {
    console.error(
      "Unexpected voice transcription error",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );

    return response.status(502).json({
      ok: false,
      error: "Voice transcription failed",
    });
  }
}
