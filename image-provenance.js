const IMAGE_SOURCE = Object.freeze({
  USER: "user",
  GENERATED: "generated",
  RENDER: "render",
});

const OUTBOUND_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

const outboundImageProvenance = new Map();

function rememberOutboundImage(messageId, source) {
  if (
    messageId === null ||
    messageId === undefined ||
    !source
  ) {
    return;
  }

  outboundImageProvenance.set(String(messageId), {
    source,
    savedAt: Date.now(),
  });
}

function getOutboundImageSource(messageId) {
  if (messageId === null || messageId === undefined) {
    return null;
  }

  const key = String(messageId);
  const item = outboundImageProvenance.get(key);

  if (!item) {
    return null;
  }

  if (Date.now() - item.savedAt > OUTBOUND_IMAGE_TTL_MS) {
    outboundImageProvenance.delete(key);
    return null;
  }

  return item.source;
}

function cleanupOutboundImageProvenance() {
  const now = Date.now();

  for (const [key, item] of outboundImageProvenance) {
    if (!item || now - item.savedAt > OUTBOUND_IMAGE_TTL_MS) {
      outboundImageProvenance.delete(key);
    }
  }
}

setInterval(cleanupOutboundImageProvenance, 60_000);

function isHistoricalImageSource(source) {
  return (
    source === IMAGE_SOURCE.USER ||
    source === IMAGE_SOURCE.GENERATED
  );
}

export {
  IMAGE_SOURCE,
  rememberOutboundImage,
  getOutboundImageSource,
  isHistoricalImageSource,
};